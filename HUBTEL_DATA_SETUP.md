# Hubtel instant data — setup

Everything needed to turn `data.html` from "renders, but delivers nothing" into a
live product. Read the blocker section first: as of the last check, step 1 cannot
be completed because the credentials we hold do not authenticate.

---

## 1. Credentials (BLOCKED)

Set the secrets. Do not put these in a repo file, and do not paste them into chat.

Four secrets are enough — the endpoints and service ids have documented defaults:

```bash
supabase secrets set \
  HUBTEL_CLIENT_ID=... \
  HUBTEL_CLIENT_SECRET=... \
  HUBTEL_DISBURSEMENT_ACCOUNT=... \
  HUBTEL_MERCHANT_ACCOUNT=...
```

Everything below the four is an override for a non-standard account.

| Secret | Required | Purpose |
| --- | --- | --- |
| `HUBTEL_CLIENT_ID` | yes | Account client id |
| `HUBTEL_CLIENT_SECRET` | yes | Account client secret |
| `HUBTEL_DISBURSEMENT_ACCOUNT` | yes | Disbursement / prepaid-deposit account. Occupies the Commission Services URL path, so it is not the merchant/collection account used to receive money |
| `HUBTEL_MERCHANT_ACCOUNT` | yes | Collection / merchant account. Only the Status Check API uses it, as its URL path segment |
| `HUBTEL_DATA_PURCHASE_URL` | no | Override only. Defaults to `{base}/{disbursement account}/{ServiceID}` |
| `HUBTEL_DATA_BUNDLES_URL` | no | Override only. The catalog is the *same* URL as the purchase, queried with `?destination={msisdn}` |
| `HUBTEL_DATA_STATUS_URL` | no | Override only. Defaults to the non-whitelisted rmsc host (see below) |
| `HUBTEL_DATA_CALLBACK_URL` | no | Override only. Defaults to this project's `hubtel-data-webhook` |
| `HUBTEL_DATA_SERVICE_ID_MTN` | no | Overrides the documented default `b230733cd56b4a0fad820e39f66bc27c` |
| `HUBTEL_DATA_SERVICE_ID_TELECEL` | no | Overrides the documented default `fa27127ba039455da04a2ac8a1613e00` |
| `HUBTEL_DATA_SERVICE_ID_AIRTELTIGO` | no | Overrides the documented default `06abd92da459428496967612463575ca` |
| `HUBTEL_TOKEN_URL` | no | OAuth2 token endpoint. When set, `client_credentials` is used; when not, credentials go straight on the request |
| ~~`HUBTEL_AUTH_SCHEME`~~ | removed | No longer read. Auth is Basic over the credentials unless `HUBTEL_TOKEN_URL` issues an OAuth2 token |
| `HUBTEL_SCOPE` | no | Scope parameter for the token request |
| `HUBTEL_TIMEOUT_MS` | no | Request timeout, default 25000 |
| `HUBTEL_RECONCILE_SECRET` | for the sweep | Shared secret the scheduled `reconcile-hubtel-orders` job must present. The same value is stored in Vault as `hubtel_reconcile_secret`; see section 6 |

Raw payloads Hubtel supplied (transaction/`responseCode` envelope, Ghana Card and
Voter ID verification, USSD Send Money flow) are catalogued in
`HUBTEL_API_REFERENCE.md`.

`HUBTEL_DATA_PURCHASE_URL` and `HUBTEL_DATA_BUNDLES_URL` may use the
`{ServiceID}` placeholder. The provider replaces it with the service id for the
selected network, so the three network ids must be configured together. A
service id identifies the network service; it is not the bundle `Value` returned
by Hubtel's bundle query. Each sellable bundle still needs its own
`hubtel_package_id` mapped from that response.

The commission-services purchase body is:

```json
{
  "Destination": "233246912184",
  "Amount": 0.5,
  "CallbackUrl": "https://<your-supabase-project>/functions/v1/hubtel-data-webhook",
  "ClientReference": "DATA-...",
  "Extradata": { "bundle": "data_bundle_1" }
}
```

The storefront accepts `024XXXXXXX`, but the provider boundary converts it to
international `233XXXXXXXXX`. `hubtel_package_id` stores the provider `Value`
(`data_bundle_1`, `kokrokoo_bundle_1`, `flexi_data_bundle`, and so on).

## The two endpoints (mapped in code)

Both are derived from the account numbers in `hubtelDataProvider.ts`, and both can
be overridden by the secrets above.

| Purpose | URL |
| --- | --- |
| Buy (POST) and query the catalog (GET `?destination={msisdn}`) | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/{ServiceID}` |
| Status Check (GET `?clientReference={ours}`) | `https://rmsc.hubtel.com/v1/merchantaccount/merchants/{Collection_Account_Number}/transactions/status` |

The status host is `rmsc.hubtel.com`, **not** the older
`api-txnstatus.hubtel.com`: the older host only answers requests from
whitelisted public IPs, which an Edge Function cannot supply. The rmsc host has
no whitelist requirement, so it can be called directly from the webhook.

A status response carries the lookup's own `responseCode` (`0000` means "the
lookup succeeded") **and** the transaction's outcome in `data.status`
(`Paid` / `Unpaid`) plus `data.isFulfilled`. The provider classifies on the
transaction fields, never on the lookup code — an `Unpaid` order also answers
`0000`.

**What we still need from Hubtel:** working credentials for the disbursement and
collection accounts. Until they authenticate, every purchase is refused with HTTP
503 before any wallet movement.

---

## 2. Deploy

```bash
supabase db push                                    # migration 20261006000000
supabase functions deploy data-catalog
supabase functions deploy purchase-data-bundle
```

`20261006000000_hubtel_data_platform.sql` is queued behind two migrations that
have never been applied to `mxovqblxizvjsmudjsjf`: `20260930100000_agent_referral_store`
and `20261002000000_bundle_catalog`. `supabase db push` applies them in order, so
push all of them or none.

---

## 3. Turn bundles on

Every seeded bundle ships with `is_available = false`. That is deliberate: a bundle
is sellable only once its `hubtel_package_id` is mapped, because an order for an
unmapped bundle cannot be delivered and the customer paid for nothing.

```bash
# 1. See what Hubtel actually offers.
supabase functions invoke list-hubtel-bundles --linked   # not implemented; see below
```

There is no catalog-mapping function yet. Until there is, map the ids by hand from
the Hubtel catalog:

```sql
update public.bundles
   set hubtel_package_id = '<id from hubtel>',
       provider_cost     = <our cost in GHS>,
       is_available      = true,
       unavailable_reason = null
 where bundle_key = 'mtn-1gb';
```

Check what you turned on:

```sql
select network_id, count(*) filter (where is_available) as on_sale, count(*) as total
  from public.bundles
 group by network_id
 order by network_id;
```

Switch one bundle on, buy it, and confirm delivery before switching on the rest.

---

## 4. Named bundles

`Kokrokoo`, `Midnight` and `Voice` bundles are named vendor products. They are
seeded by migration `20261011000000_special_data_packages.sql` but **gated off**:
`is_available = false` and a placeholder price, so neither the storefront nor a
purchase can touch them until Hubtel supplies the real package id.

Turning one on means confirming the id **and** the price against Hubtel's
catalogue first, then:

```sql
update public.bundles
   set hubtel_package_id = '<id from hubtel>',
       provider_cost     = <our cost in GHS>,
       price             = <sale price from hubtel>,
       volume_mb         = <real volume in MB>,
       validity          = '<duration only if hubtel states one>',
       is_available      = true,
       unavailable_reason = null
 where bundle_key = 'mtn-kokrokoo-1gb';
```

`volume_mb` is what the order path is denominated in — a display string is not
something to parse. Use `validity` for the duration the provider actually
states; leave it NULL rather than inventing one, because `data-catalog`
passes it straight through and the UI shows it verbatim.

Voice bundles have no data volume, so before the Voice rows can be enabled the
fulfilment model (minutes vs. an MB-equivalent) must be confirmed with Hubtel —
they currently carry a placeholder volume and a loud `unavailable_reason`.

---

## 5. Verify

```bash
# Catalog is world-readable, provider readiness is reported.
curl -s "$SUPABASE_URL/functions/v1/data-catalog" -H "apikey: $ANON" | jq

# An unconfigured provider must refuse without touching a wallet.
curl -s -X POST "$SUPABASE_URL/functions/v1/purchase-data-bundle" \
  -H "apikey: $ANON" -H "Authorization: Bearer <agent jwt>" \
  -H "Content-Type: application/json" \
  -d '{"bundleKey":"mtn-1gb","phone":"0244123456"}' | jq
# expect 503 and no debit
```

Then, end to end with an agent session: buy a small bundle, confirm
`data_transactions.status = 'success'`, confirm the `wallets.balance` fell by
exactly `bundles.price`, and confirm `wallet_transactions` has one debit row for
the same `reference`.

Force a decline to prove the refund path: point `HUBTEL_DATA_PURCHASE_URL` at a
nonexistent path, buy, and confirm the wallet is back to its original balance with
a matching `credit` row and `data_transactions.status = 'failed'`.

---

## 6. When the callback never arrives

An order settles when Hubtel calls `hubtel-data-webhook` back with the final
state. Hubtel retries a callback, but not forever, and a webhook that answers 5xx
during a redeploy loses that delivery for good. An order in that state is the
worst case in the flow: the customer has no data and the agent's wallet is still
debited.

`reconcile-hubtel-orders` covers it. Anything still pending **more than five
minutes** after it was created is re-read from the Status Check endpoint — the
same one the callback verifies against, correlating on our own
`ClientReference` — and settled if Hubtel has since closed it. The same sweep
covers airtime and utility orders, which have the identical gap.

```bash
supabase functions deploy reconcile-hubtel-orders
```

Then run the one-time setup, and apply
`20261024000000_hubtel_callback_reconcile_sweep.sql`, which needs `pg_cron` and
`pg_net`:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'hubtel_project_url');
select vault.create_secret('<a long random value>', 'hubtel_reconcile_secret');
select public.schedule_hubtel_reconcile_sweep();
```

```bash
supabase secrets set HUBTEL_RECONCILE_SECRET=<the same random value>
```

The two copies of the secret must match. The function refuses every request when
`HUBTEL_RECONCILE_SECRET` is unset, so a half-finished setup fails closed rather
than exposing an endpoint anyone could make hammer Hubtel. The job runs once a
minute; the five-minute rule is inside the function, so it can be tuned without
rescheduling. Each run is recorded in `cron.job_run_details`, and the HTTP
response in `net._http_response`.

Two things it deliberately does **not** do:

- **It never marks an order failed because it is old.** A status we could not
  read is not a decline, and refunding one would give the product away free if
  Hubtel reports it delivered later. Orders past 24 hours stop being polled and
  stay pending for an operator to look at.
- **It cannot complete a paid electricity order.** ECG needs a token from
  Hubtel and the status endpoint reports the payment, not the token, so those
  rows stay `processing` exactly as the callback path leaves them.

A status lookup for a reference Hubtel cannot find answers HTTP 400
(`ResponseCode 4720`), which the provider reads as "still unknown" — not as a
failed order. That is why a sweep can run indefinitely against an unsettled
order without ever moving money on its own.
