import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { WalletError, chargeWallet, refundWallet } from '../_shared/wallet.ts';
import { buyHubtelBundle, fetchHubtelBundles, hubtelConfigured } from '../_shared/hubtelDataProvider.ts';
import { friendlyProviderMessage } from '../_shared/providerMessages.ts';
import {
  instantDataSalesEnabled,
  INSTANT_DATA_OUT_OF_STOCK_MESSAGE,
} from '../_shared/instantDataAvailability.ts';

/**
 * Purchases one data bundle for an agent and delivers it through Hubtel.
 *
 * ---------------------------------------------------------------------------
 * The order of operations differs from the original brief on purpose
 * ---------------------------------------------------------------------------
 * The brief asked for: check balance -> call the provider -> deduct only if the
 * provider succeeded. This charges the wallet first and refunds on failure.
 * Both leave a customer who did not get data with their money, but only one is
 * safe:
 *
 *   - "Check then call then deduct" is a time-of-check/time-of-use gap. The
 *     balance check and the deduction are two separate round trips, so two
 *     requests fired at the same moment both pass the check and both deduct.
 *     The second one drives the balance negative. wallet_balance has a
 *     non-negative CHECK constraint, so the second deduction fails - but it
 *     fails *after* the provider was already called, so the customer has data
 *     the platform cannot account for.
 *   - charge_agent_wallet takes a row lock (`select ... for update`), validates
 *     the balance and writes both the balance and the ledger row in one
 *     transaction. Concurrent purchases serialise on that lock instead of
 *     overdrawing. refund_agent_wallet is idempotent on the debit reference, so
 *     a failure refunds exactly once even if it is retried.
 *
 * This is the wallet-first pattern the rest of the project already uses.
 *
 * ---------------------------------------------------------------------------
 * The one state that is not settled here
 * ---------------------------------------------------------------------------
 * A transport failure - we could not reach Hubtel at all - leaves the row
 * `pending` with the wallet still debited, because we do not know whether the
 * order was received. Refunding there risks giving the bundle away for free;
 * holding the money risks holding it if nothing was ever delivered. It is
 * reported to the caller as pending, logged loudly, and settled later by the
 * scheduled `reconcile-hubtel-orders` sweep, which polls the status endpoint
 * for anything still pending after five minutes.
 */

const GHANA_PHONE = /^0[0-9]{9}$/;

function referenceFrom(idempotencyKey: unknown): string {
  const key = String(idempotencyKey ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return key ? `DATA-${key}` : `DATA-${crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let walletReference = '';

  try {
    const { admin, user } = await requireAgent(request);

    let body: {
      bundleKey?: unknown;
      bundle_id?: unknown;
      phone?: unknown;
      recipient_phone?: unknown;
      idempotencyKey?: unknown;
      network?: unknown;
      amount?: unknown;
    };
    try {
      body = await request.json();
    } catch {
      return json({ error: 'A JSON request body is required.' }, 400);
    }

    // Accept both the current Edge Function names and the public API shape
    // used by the Instant Data client. Network and amount are intentionally
    // ignored: the server resolves both from the bundle row.
    const bundleKey = String(body.bundleKey ?? body.bundle_id ?? '').trim();
    const phone = String(body.phone ?? body.recipient_phone ?? '').replace(/[\s()-]/g, '').trim();

    if (!bundleKey) return json({ error: 'Select a data bundle before continuing.' }, 400);
    if (!GHANA_PHONE.test(phone)) {
      return json({ error: 'Enter a valid 10-digit Ghanaian recipient number (e.g. 024XXXXXXX).' }, 400);
    }

    if (!instantDataSalesEnabled()) {
      return json({
        error: INSTANT_DATA_OUT_OF_STOCK_MESSAGE,
        outOfStock: true,
        walletCharged: false,
      }, 503);
    }

    // Refuses the order before any money moves if the provider is not wired up,
    // rather than debiting an agent for something we cannot deliver.
    if (!hubtelConfigured()) {
      console.error('purchase-data-bundle refused: Hubtel is not configured.');
      return json({
        error: 'Data delivery is not available yet. No charge was made to your wallet.',
      }, 503);
    }

    // Profiles carry the foreign key that data_transactions.user_id needs, and
    // an account that signed up before this migration has no row yet.
    const { error: profileError } = await admin.rpc('ensure_profile', { p_user_id: user.id });
    if (profileError) throw new Error(`Could not provision the buyer profile: ${profileError.message}`);

    // Price, volume and network come from the database, never from the request
    // body, so a crafted call cannot buy a GHS 200 bundle for GHS 1.
    const { data: bundle, error: bundleError } = await admin
      .from('bundles')
      .select('id, bundle_key, network_id, title, volume_mb, price, provider_cost, category, validity, hubtel_package_id, networks(name, hubtel_network, phone_prefixes)')
      .eq('bundle_key', bundleKey)
      .eq('is_available', true)
      .single();

    if (bundleError || !bundle) {
      return json({ error: 'That data bundle is not available.' }, 404);
    }

    const providerCost = Number(bundle.provider_cost);
    if (!bundle.hubtel_package_id || !Number.isFinite(providerCost) || providerCost <= 0) {
      // Availability must include both the provider's Bundle value and the
      // provider amount. Hubtel validates those two fields as a pair, including
      // named products such as Kokrokoo and Midnight.
      console.error('purchase-data-bundle: available bundle has no complete Hubtel mapping.', { bundleKey });
      return json({ error: 'That data bundle cannot be delivered right now.' }, 409);
    }

    // networks() is embedded through bundles.network_id -> networks.id, a
    // to-one relationship, so PostgREST returns a single object; the generic
    // client types it as an array, so accept both shapes.
    const networkRow = Array.isArray(bundle.networks) ? bundle.networks[0] : bundle.networks;

    // A recipient number on a different operator's range is refused, because the
    // order would be placed and then declined by the provider - the agent's
    // money and the customer's time both spent. An unrecognised prefix is not
    // treated as a mismatch: the prefix list is data, not an authority, and the
    // provider decides what it can actually deliver.
    const prefixes = Array.isArray(networkRow?.phone_prefixes)
      ? (networkRow.phone_prefixes as unknown[]).map(String)
      : [];
    if (prefixes.length && !prefixes.includes(phone.slice(0, 3))) {
      const { data: owningNetwork } = await admin
        .from('networks')
        .select('name')
        .contains('phone_prefixes', [phone.slice(0, 3)])
        .limit(1)
        .maybeSingle();

      return json({
        error: owningNetwork?.name
          ? `${phone} is a ${owningNetwork.name} number. Choose that network to send to it.`
          : `${phone} does not match ${networkRow?.name ?? 'this network'}. Check the number and network.`,
      }, 400);
    }

    walletReference = referenceFrom(body.idempotencyKey);

    // Double-submit guard. The client sends a stable idempotency key per
    // checkout, so a double-tap or a retry returns the original order instead
    // of charging the wallet twice.
    const { data: existing } = await admin
      .from('data_transactions')
      .select('id, reference, short_code, status, amount, recipient_phone, failure_reason')
      .eq('reference', walletReference)
      .maybeSingle();

    if (existing) {
      const { data: balanceRow } = await admin.from('wallets').select('balance').eq('id', user.id).maybeSingle();
      return json({
        success: existing.status === 'success',
        pending: existing.status === 'pending',
        duplicate: true,
        reference: existing.reference,
        shortCode: existing.short_code,
        status: existing.status,
        amount: Number(existing.amount),
        recipientPhone: existing.recipient_phone,
        message: existing.status === 'success'
          ? 'This order was already placed successfully.'
          : existing.failure_reason || 'This order was already submitted.',
        walletBalance: Number(balanceRow?.balance ?? 0),
      });
    }

    const price = Number(bundle.price);
    const description = `${networkRow?.name ?? bundle.network_id} data - ${bundle.title}`;

    // Query the provider's catalog for this recipient BEFORE the top-up.
    //
    // The stored `hubtel_package_id` and `provider_cost` are a snapshot taken
    // when the bundle was mapped. Telcos run intermittent promos, which change
    // which bundles a number is eligible for and what they cost, so a stored
    // pair can go stale without anyone editing the catalog. Hubtel validates the
    // bundle Value against the amount as a pair - "if the Bundle and the amount
    // do not correspond to what is taken from the Data Bundle Query endpoint,
    // the transaction will fail" - so this confirms the pair we are about to
    // send is one the provider is still offering at that price.
    //
    // The match is on Value AND amount, never Value alone. MTN publishes a single
    // Value ("flexi_data_bundle") for eleven different amounts, so matching on
    // the Value would return whichever amount happens to be listed first and
    // deliver a smaller bundle than the agent paid for.
    //
    // This runs before the wallet is charged, so a bundle that a promo has
    // withdrawn, or moved to a different price, costs the agent nothing.
    const operator = networkRow?.hubtel_network ?? networkRow?.name;
    const expectedPackageId = String(bundle.hubtel_package_id);
    try {
      const catalog = await fetchHubtelBundles(operator, phone);
      const offer = catalog.find((row) =>
        row.packageId === expectedPackageId && Math.abs(row.costGhs - providerCost) < 0.005
      );
      if (!offer) {
        return json({
          error: 'That bundle is not available for this number at that price right now. Pick another bundle - your wallet was not charged.',
          outOfStock: true,
          walletCharged: false,
        }, 409);
      }
    } catch (err) {
      // Fail closed. Without the catalog we cannot confirm the bundle is still
      // sold at this amount, and sending a stale pair is how a paid order ends
      // up declined by the telco. Nothing has been charged at this point, so the
      // agent simply retries.
      console.error('purchase-data-bundle: could not read the Hubtel catalog before topping up.', {
        reference: walletReference,
        reason: describeError(err),
      });
      return json({
        error: 'We could not confirm current bundle prices with the provider. Please try again - your wallet was not charged.',
        walletCharged: false,
      }, 503);
    }

    // 1. Debit. Throws WalletError('insufficient') when the balance is short.
    let walletBalance: number;
    try {
      walletBalance = await chargeWallet(user.id, walletReference, price, description, {
        service: 'instant_data',
        bundle_key: bundle.bundle_key,
        network_id: bundle.network_id,
        volume_mb: bundle.volume_mb,
        recipient_phone: phone,
      });
    } catch (err) {
      if (err instanceof WalletError && err.code === 'insufficient') {
        return json({ error: err.message }, 402);
      }
      throw err;
    }

    // 2. Record the intent before calling the provider, so a process that dies
    //    mid-request still leaves an auditable pending row rather than a debit
    //    with no order attached to it.
    const { data: inserted, error: insertError } = await admin
      .from('data_transactions')
      .insert({
        reference: walletReference,
        user_id: user.id,
        network_id: bundle.network_id,
        bundle_id: bundle.id,
        bundle_key: bundle.bundle_key,
        recipient_phone: phone,
        amount: price,
        status: 'pending',
      })
      .select('id, short_code')
      .single();

    if (insertError || !inserted) {
      await refundWallet(user.id, walletReference, price, 'Refund: could not record the data order');
      return json({ error: 'Could not start the data order. Your wallet has been refunded.' }, 500);
    }

    // 3. Deliver.
    let result: Awaited<ReturnType<typeof buyHubtelBundle>>;
    try {
      result = await buyHubtelBundle({
        reference: walletReference,
        phone,
        packageId: expectedPackageId,
        hubtelNetwork: networkRow?.hubtel_network ?? undefined,
        amountGhs: providerCost,
      });
    } catch (err) {
      // Unknown outcome: the wallet stays debited and the row stays pending.
      const reason = describeError(err);
      console.error('purchase-data-bundle: provider outcome unknown, order left pending.', {
        reference: walletReference,
        reason,
      });
      await admin
        .from('data_transactions')
        .update({ failure_reason: `Delivery unconfirmed: ${reason}` })
        .eq('id', inserted.id);

      return json({
        success: false,
        pending: true,
        reference: walletReference,
        shortCode: inserted.short_code,
        status: 'pending',
        message: 'We could not confirm delivery. Your wallet is on hold until we settle this order - do not resend.',
        walletBalance,
      }, 202);
    }

    // Hubtel commission services answer 0001 when the order was accepted but
    // delivery is still being processed. Keep the debit and the transaction
    // pending; refunding here would allow a later callback-confirmed bundle to
    // be delivered for free. The final 0000 callback/status settles it.
    if (result.pending || result.state === 'pending') {
      await admin
        .from('data_transactions')
        .update({
          hubtel_response: result.payload,
          failure_reason: 'Hubtel accepted the order; delivery is pending confirmation.',
        })
        .eq('id', inserted.id);

      return json({
        success: false,
        pending: true,
        reference: walletReference,
        shortCode: inserted.short_code,
        providerOrderId: result.orderId ?? null,
        status: 'pending',
        message: 'Hubtel accepted the order. Delivery is being confirmed; do not resend.',
        walletBalance,
      }, 202);
    }

    if (!result.success) {
      const reason = result.failureReason
        ? friendlyProviderMessage(result.failureReason, bundle.network_id)
        : 'The provider declined the data order.';
      const balance = await refundWallet(user.id, walletReference, price, `Refund: ${reason}`);
      await admin
        .from('data_transactions')
        .update({ status: 'failed', failure_reason: reason, hubtel_response: result.payload })
        .eq('id', inserted.id);

      // Best-effort trail. A failure to log must not fail the request. Wrapped in
      // try/catch rather than .catch() because a Supabase query builder is
      // PromiseLike, not a Promise, and has no .catch.
      try {
        await admin.rpc('log_activity', {
          p_summary: `Data bundle failed: ${bundle.bundle_key} to ${phone}`,
          p_meta: { reference: walletReference, reason, provider: 'hubtel' },
          p_actor_user_id: user.id,
        });
      } catch (logError) {
        console.warn('Could not record the failed data order in activity_log:', logError);
      }

      return json({
        success: false,
        reference: walletReference,
        shortCode: inserted.short_code,
        status: 'failed',
        message: `${reason} Your wallet has been refunded.`,
        walletBalance: balance,
      }, 502);
    }

    // 4. Settle as delivered.
    await admin
      .from('data_transactions')
      .update({
        status: 'success',
        hubtel_response: result.payload,
        failure_reason: null,
      })
      .eq('id', inserted.id);

    const { data: finalBalance } = await admin.from('wallets').select('balance').eq('id', user.id).maybeSingle();

    return json({
      success: true,
      reference: walletReference,
      shortCode: inserted.short_code,
      status: 'success',
      providerOrderId: result.orderId ?? null,
      amount: price,
      recipientPhone: phone,
      message: `${bundle.title} delivered to ${phone}.`,
      walletBalance: Number(finalBalance?.balance ?? walletBalance),
    });
  } catch (error) {
    // Anything that escapes the steps above is unexpected. Refund if a debit was
    // taken, so a bug never costs an agent real money.
    const message = describeError(error);
    console.error('purchase-data-bundle failed:', message);

    let refunded = false;
    let walletBalance: number | undefined;
    if (walletReference) {
      try {
        const { user } = await requireAgent(request);
        const { data: order } = await adminClient()
          .from('data_transactions')
          .select('amount, status')
          .eq('reference', walletReference)
          .maybeSingle();

        if (order && order.status !== 'failed') {
          walletBalance = await refundWallet(user.id, walletReference, Number(order.amount), 'Refund: unexpected purchase failure');
          await adminClient().from('data_transactions').update({ status: 'failed', failure_reason: message }).eq('reference', walletReference);
          refunded = true;
        }
      } catch (refundError) {
        // Logged rather than swallowed: a failed refund is a real money problem.
        console.error('purchase-data-bundle: emergency refund failed, manual reconciliation required.', {
          reference: walletReference,
          reason: describeError(refundError),
        });
      }
    }

    const status = /authentication is required|session is invalid/i.test(message)
      ? 401
      : /agent account required/i.test(message)
        ? 403
        : 500;

    return json({
      error: message,
      refunded,
      walletBalance,
    }, status);
  }
});
