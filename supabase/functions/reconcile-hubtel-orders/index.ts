import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { fetchHubtelStatus } from '../_shared/hubtelDataProvider.ts';
import {
  settleHubtelAirtimeOrder,
  settleHubtelDataOrder,
  settleHubtelUtilityOrder,
} from '../_shared/hubtelSettlement.ts';

/**
 * Sweeps the Hubtel orders whose callback never arrived.
 *
 * A Hubtel order is placed with a callback URL, and Hubtel calls it with the
 * final state. Hubtel does retry, but a callback can be lost for good - a
 * webhook that answers 5xx while it is being redeployed is the usual cause.
 * An order that is never settled is the worst outcome in the whole flow: the
 * customer has no airtime, data or bill and the agent's wallet is still
 * debited with nothing to show for it.
 *
 * This function is the answer to that. Anything still pending more than five
 * minutes after it was created is re-read from Hubtel's Status Check API - the
 * same endpoint the callbacks verify against, correlating on our client
 * reference - and settled if Hubtel has since closed it.
 *
 * Deliberately absent: a timeout that marks an old order failed. A status we
 * could not read is not a decline, and refunding one would give the product
 * away free if Hubtel later reports it delivered. Orders older than
 * MAX_POLL_AGE_HOURS therefore stop being polled and stay pending for an
 * operator to look at, rather than being resolved by guesswork.
 *
 * This is an internal job, so it is not gated on an agent session: it is
 * scheduled by pg_cron and authorised by a shared secret header. It refuses
 * every request when that secret is not configured, so a half-finished setup
 * fails closed instead of exposing an endpoint that can be made to hammer
 * Hubtel's API.
 */

/** Hubtel's final callbacks land within seconds; five minutes means it was lost. */
const CALLBACK_GRACE_MINUTES = 5;

/** Stop polling after this. The row is left pending for an operator, not failed. */
const MAX_POLL_AGE_HOURS = 24;

/** Hubtel's status endpoint answers one order per call, so the batch stays small. */
const MAX_ORDERS_PER_SWEEP = 25;

function sameSecret(provided: string, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < provided.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('HUBTEL_RECONCILE_SECRET')?.trim();
  if (!expectedSecret) {
    console.error('reconcile-hubtel-orders refused: HUBTEL_RECONCILE_SECRET is not set.');
    return json({ error: 'Reconciliation is not configured.' }, 503);
  }
  if (!sameSecret(request.headers.get('x-reconcile-secret')?.trim() ?? '', expectedSecret)) {
    return json({ error: 'Not authorized.' }, 401);
  }

  try {
    const admin = adminClient();
    const now = Date.now();
    const graceCutoff = new Date(now - CALLBACK_GRACE_MINUTES * 60_000).toISOString();
    const ageFloor = new Date(now - MAX_POLL_AGE_HOURS * 3_600_000).toISOString();

    const data = await sweepDataOrders(admin, graceCutoff, ageFloor);
    const airtime = await sweepAirtimeOrders(admin, graceCutoff, ageFloor);
    const utility = await sweepUtilityOrders(admin, graceCutoff, ageFloor);
    const changed = data.changed + airtime.changed + utility.changed;
    const unreadable = [data, airtime, utility].filter((result) => result.failed).length;

    // Reconciliation is not a row write of its own, so record it explicitly.
    // Auditing must never break the sweep, and a Supabase query builder is
    // PromiseLike rather than a Promise (so it has no .catch), hence try/catch.
    if (changed > 0) {
      try {
        await admin.rpc('log_activity', {
          p_summary: `Reconciled ${changed} Hubtel order${changed === 1 ? '' : 's'} that no callback settled`,
          p_meta: { data, airtime, utility },
          p_actor_user_id: null,
        });
      } catch (logError) {
        console.error('Hubtel reconcile activity log failed:', logError);
      }
    }

    // A run that could not read its own queue must not report success: `changed:
    // 0` every minute is exactly what a working sweep looks like, so a broken
    // one has to be visibly different from the outside, not only in the logs.
    if (unreadable > 0) {
      return json({ success: false, changed, unreadable, data, airtime, utility }, 500);
    }

    return json({ success: true, changed, data, airtime, utility });
  } catch (error) {
    console.error('reconcile-hubtel-orders failed:', error);
    return json({ error: 'Reconciliation failed.' }, 500);
  }
});

interface SweepResult {
  checked: number;
  changed: number;
  /** The queue itself could not be read, so this table was not swept at all. */
  failed: boolean;
}

/** Instant data orders, settled against `data_transactions`. */
async function sweepDataOrders(
  admin: ReturnType<typeof adminClient>,
  graceCutoff: string,
  ageFloor: string,
): Promise<SweepResult> {
  const { data: orders, error } = await admin
    .from('data_transactions')
    .select('id, reference, user_id, amount')
    .eq('status', 'pending')
    .lt('created_at', graceCutoff)
    .gt('created_at', ageFloor)
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SWEEP);

  if (error) {
    console.error('Data order sweep read failed:', error);
    return { checked: 0, changed: 0, failed: true };
  }

  let changed = 0;
  for (const order of orders ?? []) {
    const reference = String(order.reference);

    const verified = await fetchHubtelStatus(reference).catch((statusError) => {
      console.error('Data order status check failed:', { reference, error: String(statusError) });
      return null;
    });
    if (!verified || verified.state === 'pending') continue;

    try {
      await settleHubtelDataOrder(admin, {
        id: String(order.id),
        reference,
        user_id: String(order.user_id),
        amount: Number(order.amount),
      }, verified);
      changed += 1;
    } catch (settleError) {
      console.error('Data order sweep settle failed:', { reference, error: String(settleError) });
    }
  }

  return { checked: (orders ?? []).length, changed, failed: false };
}

/** Airtime orders, settled against `airtime_orders`. */
async function sweepAirtimeOrders(
  admin: ReturnType<typeof adminClient>,
  graceCutoff: string,
  ageFloor: string,
): Promise<SweepResult> {
  const { data: orders, error } = await admin
    .from('airtime_orders')
    .select('id, agent_id, payment_reference, amount, provider_reference')
    .in('airtime_status', ['pending', 'pending_provider', 'processing'])
    .lt('created_at', graceCutoff)
    .gt('created_at', ageFloor)
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SWEEP);

  if (error) {
    console.error('Airtime order sweep read failed:', error);
    return { checked: 0, changed: 0, failed: true };
  }

  let changed = 0;
  for (const order of orders ?? []) {
    const reference = String(order.payment_reference);

    const verified = await fetchHubtelStatus(reference).catch((statusError) => {
      console.error('Airtime order status check failed:', { reference, error: String(statusError) });
      return null;
    });
    if (!verified || verified.state === 'pending') continue;

    try {
      await settleHubtelAirtimeOrder(admin, {
        id: String(order.id),
        agent_id: order.agent_id ? String(order.agent_id) : null,
        payment_reference: reference,
        amount: Number(order.amount),
        provider_reference: order.provider_reference ? String(order.provider_reference) : null,
      }, {
        state: verified.state,
        payload: verified.payload,
        providerReference: verified.orderId ?? null,
      });
      changed += 1;
    } catch (settleError) {
      console.error('Airtime order sweep settle failed:', { reference, error: String(settleError) });
    }
  }

  return { checked: (orders ?? []).length, changed, failed: false };
}

/**
 * Utility bill orders, settled against `utility_orders`.
 *
 * Electricity is the awkward one: it completes only when Hubtel hands back a
 * token, and the Status Check API reports the payment, not the token. A paid
 * electricity order therefore stays `processing` here instead of being closed,
 * exactly as the callback path does when a callback arrives without a token.
 */
async function sweepUtilityOrders(
  admin: ReturnType<typeof adminClient>,
  graceCutoff: string,
  ageFloor: string,
): Promise<SweepResult> {
  const { data: orders, error } = await admin
    .from('utility_orders')
    .select('id, agent_id, payment_reference, gross_amount, bill_category, provider_reference, status')
    .in('status', ['paid', 'processing'])
    .lt('created_at', graceCutoff)
    .gt('created_at', ageFloor)
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SWEEP);

  if (error) {
    console.error('Utility order sweep read failed:', error);
    return { checked: 0, changed: 0, failed: true };
  }

  let changed = 0;
  for (const order of orders ?? []) {
    const reference = String(order.payment_reference);

    const verified = await fetchHubtelStatus(reference).catch((statusError) => {
      console.error('Utility order status check failed:', { reference, error: String(statusError) });
      return null;
    });
    if (!verified || verified.state === 'pending') continue;

    try {
      const outcome = await settleHubtelUtilityOrder(admin, {
        id: String(order.id),
        agent_id: order.agent_id ? String(order.agent_id) : null,
        payment_reference: reference,
        gross_amount: Number(order.gross_amount),
        bill_category: String(order.bill_category),
        provider_reference: order.provider_reference ? String(order.provider_reference) : null,
      }, {
        state: verified.state,
        payload: verified.payload,
        providerReference: verified.orderId ?? null,
      });
      if (outcome !== 'processing') changed += 1;
    } catch (settleError) {
      console.error('Utility order sweep settle failed:', { reference, error: String(settleError) });
    }
  }

  return { checked: (orders ?? []).length, changed, failed: false };
}
