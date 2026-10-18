# Hubtel instant data — setup

Everything needed to turn `data.html` from "renders, but delivers nothing" into a
live product. Read the blocker section first: as of the last check, step 1 cannot
be completed because the credentials we hold do not authenticate.

---

## 1. Credentials (BLOCKED)

Set the secrets. Do not put these in a repo file, and do not paste them into chat.

```bash
supabase secrets set \
  HUBTEL_CLIENT_ID=... \
  HUBTEL_CLIENT_SECRET=... \
  HUBTEL_MERCHANT_ACCOUNT=... \
  HUBTEL_MERCHANT_ACCOUNT_NUMBER=... \
  HUBTEL_DATA_PURCHASE_URL=... \
  HUBTEL_DATA_BUNDLES_URL=... \
  HUBTEL_DATA_STATUS_URL=... \
  HUBTEL_DATA_CALLBACK_URL=... \
  HUBTEL_DATA_SERVICE_ID_MTN=... \
  HUBTEL_DATA_SERVICE_ID_TELECEL=... \
  HUBTEL_DATA_SERVICE_ID_AIRTELTIGO=...
```

| Secret | Required | Purpose |
| --- | --- | --- |
| `HUBTEL_CLIENT_ID` | yes | Account client id |
| `HUBTEL_CLIENT_SECRET` | yes | Account client secret |
| `HUBTEL_MERCHANT_ACCOUNT` | no | Merchant account number, sent on data calls |
| `HUBTEL_DATA_PURCHASE_URL` | yes | Data purchase endpoint. Without it every purchase is refused before the wallet is touched |
| `HUBTEL_DATA_BUNDLES_URL` | no | Provider bundle catalog, used to map package ids |
| `HUBTEL_DATA_STATUS_URL` | no | Delivery status poll. Without it an order that cannot be confirmed stays `pending` |
| `HUBTEL_DATA_CALLBACK_URL` | recommended | Callback URL included in commission-services requests for final transaction state |
| `HUBTEL_DATA_SERVICE_ID_MTN` | yes | Hubtel commission-service id used for MTN Instant Data |
| `HUBTEL_DATA_SERVICE_ID_TELECEL` | yes | Hubtel commission-service id used for Telecel Instant Data |
| `HUBTEL_DATA_SERVICE_ID_AIRTELTIGO` | yes | Hubtel commission-service id used for AirtelTigo Instant Data |
| `HUBTEL_TOKEN_URL` | no | OAuth2 token endpoint. When set, `client_credentials` is used; when not, credentials go straight on the request |
| `HUBTEL_AUTH_SCHEME` | no | `basic` (default) or `bearer`, used when there is no token endpoint |
| `HUBTEL_SCOPE` | no | Scope parameter for the token request |
| `HUBTEL_TIMEOUT_MS` | no | Request timeout, default 25000 |

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

No endpoint URL is hardcoded in `supabase/functions/_shared/hubtelDataProvider.ts`.
Hubtel's developer portal is a login-gated SPA, the public docs disagree with each
other about hosts and auth, and a probe against `payproxyapi.hubtel.com` returned
HTTP 401 for every auth shape tried — including with no `Authorization` header at
all, so those 401s do not even distinguish a wrong key from a wrong auth style. A
URL guessed into the source would be a guess against a live merchant account.

**What we still need from Hubtel:** the data-vending account credentials, the
purchase endpoint, and a status endpoint that answers. Until then the page shows a
"delivery not switched on yet" notice and every purchase is refused with HTTP 503
before any wallet movement.

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

## 6. Known gap

An order whose provider call never returned stays `pending` with the wallet still
debited, because we cannot tell whether Hubtel received it. Refunding there risks
giving the bundle away; holding the money risks holding it if nothing was ever
delivered. It is logged loudly and reported to the agent as "delivery being
confirmed".

Closing this needs `HUBTEL_DATA_STATUS_URL` plus a reconcile job that polls pending
rows and settles them through `refund_agent_wallet`. That is the next piece of
work on this feature, not a bug to route around.
