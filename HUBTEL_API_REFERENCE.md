# Hubtel API reference (payloads supplied by Hubtel)

These are the exact request/response bodies Hubtel handed over. They document the
**wire format only** — a payload shape is not access. Credentials, the base URLs and
the per-service enablement are still required before any of this runs live. See
"What is still needed" at the bottom.

General response envelope used by the newer Hubtel services:

```json
{
  "message": "Transaction pending. Expect callback request for final state.",
  "responseCode": "0001",
  "data": { "orderId": "b230733cd56b4a0fad820e39f66bc27c" }
}
```

- `responseCode` `"0000"` = success, `"0001"` = accepted / pending (final state
  arrives on a callback), anything else = declined.
- The transaction id can be top-level **or** nested under `data.orderId`.
- `supabase/functions/_shared/hubtelDataProvider.ts` `classify()` understands these
  codes and `pickOrderId()` reads the nested `data.orderId`.

---

## 0. Paystack and Hubtel are the same payment

Paystack and Hubtel are used **together, as one flow** — either gateway may settle a
payment and the rest of the system behaves identically. Their dialects are reduced
to a single shape by `supabase/functions/_shared/paymentGateway.ts`
(`normalizePaystack` / `normalizeHubtel` → `NormalizedPayment`).

| Meaning | Paystack | Hubtel | Shared state |
| --- | --- | --- | --- |
| Settled | `data.status: "success"` (or event `charge.success`) | `responseCode: "0000"` | `success` |
| Accepted, awaiting callback | `data.status: "pending"`/`"ongoing"` | `responseCode: "0001"` | `pending` |
| Declined / failed | `data.status: "failed"`/`"reversed"`/`"abandoned"` | any other `responseCode` | `failed` |
| Our reference | `data.reference` | `reference` / `clientReference` | `reference` |
| Gateway order id | `data.id` | `data.orderId` | `orderId` |
| Amount | `data.amount` (kobo → ÷100) | `amount`/`Amount` | `amountGhs` |
| Message | `message` / `data.gateway_response` | `message` | `message` |

An unrecognised status is never guessed into `success` — it maps to `pending`, so an
unclear event can hold a wallet but never release goods.

**Wallet funding.** `create-agent-wallet-payment` accepts `provider` (`"paystack"`
default, or `"hubtel"`); the agent chooses on `deposit.html`. Paystack charges the
amount grossed up for its 1.5% fee, Hubtel charges the exact amount. Either way the
webhook (`paystack-webhook` / `hubtel-webhook`) re-reads the transaction server-side
and credits the wallet through the one idempotent `fulfil_wallet_topup`. Hubtel
cannot start a top-up until `HUBTEL_CHECKOUT_URL` is set, and will not credit until
`HUBTEL_CHECKOUT_STATUS_URL` is set (a callback is never trusted on its own).

---

## 1. Transaction status / collection

Pending response (expects a callback for the final state):

```json
{
  "message": "Transaction pending. Expect callback request for final state.",
  "responseCode": "0001",
  "data": { "orderId": "b230733cd56b4a0fad820e39f66bc27c" }
}
```

Success response envelope:

```json
{
  "message": "Success",
  "responseCode": "0000",
  "data": {
    "isRegistered": true,
    "name": "JOSEPH ANNOH",
    "status": "active",
    "profile": "Subscriber"
  }
}
```

Used by: the Hubtel data-purchase path (`buyHubtelBundle` / `fetchHubtelStatus`).
Status reconciliation (polling `pending` rows) is still to be built.

---

## 2. Ghana Card verification

Request:

```json
{
  "ghanaCardNumber": "GHA-000000000-0",
  "surname": "Doe",
  "firstnames": "John",
  "gender": "male",
  "dateOfBirth": "dd/mm/yyyy"
}
```

Response: the `responseCode` `"0000"` / `data` envelope above
(`isRegistered`, `name`, `status`, `profile`).

Date format in the request is **`dd/mm/yyyy`**.

---

## 3. Voter ID verification

Request:

```json
{
  "voterIdCardNumber": "0000000000",
  "surname": "Doe",
  "othernames": "John",
  "sex": "male",
  "dateOfBirth": "yyyy/mm/dd"
}
```

Response: the `responseCode` `"0000"` / `data` envelope above.

Date format in the request is **`yyyy/mm/dd`** (note: differs from Ghana Card).

---

## 4. USSD "Send Money" session flow

Hubtel drives these callbacks; `SessionId` correlates the whole session.

**Initiation**

```json
{
  "Type": "Initiation",
  "Mobile": "233200585542",
  "SessionId": "3c796dac28174f739de4262d0840",
  "ServiceCode": "713",
  "Message": "*713#",
  "Operator": "vodafone",
  "Sequence": 1,
  "ClientState": "",
  "Platform": "USSD"
}
```

**AddToCart**

```json
{
  "SessionId": "3c796dac28174f739de4262d0840",
  "Type": "AddToCart",
  "Message": "The request has been submitted",
  "Item": { "ItemName": "Send Money", "Qty": 1, "Price": 150.5 },
  "Label": "The request has been submitted.",
  "DataType": "display",
  "FieldType": "text"
}
```

**Checkout / OrderInfo** (payment settled)

```json
{
  "SessionId": "3c796dac28174f739de4262d0840",
  "OrderId": "ac3307bcca7445618071e6b0e41b50b5",
  "ExtraData": {},
  "OrderInfo": {
    "CustomerMobileNumber": "233200585542",
    "CustomerName": "John Doe",
    "Status": "Paid",
    "Subtotal": 151.50,
    "Payment": {
      "PaymentType": "mobilemoney",
      "AmountPaid": 151.50,
      "AmountAfterCharges": 150.5,
      "IsSuccessful": true
    }
  }
}
```

**ServiceStatus**

```json
{
  "SessionId": "3c796dac28174f739de4262d0840",
  "OrderId": "ac3307bcca7445618071e6b0e41b50b5",
  "ServiceStatus": "success",
  "MetaData": null
}
```

`Operator` `vodafone` = Telecel. `Subtotal` 151.50 = `AmountPaid`;
`AmountAfterCharges` 150.5 is the amount after Hubtel's charges.

Used by: **not wired**. This is a money-transfer / disbursement flow and is the
closest fit for agent payouts (`agent_payouts`, currently captured but not
executed). Needs a product decision before it is built.

---

## 5. What is still needed

| Item | Why |
| --- | --- |
| `HUBTEL_CLIENT_ID` / `HUBTEL_CLIENT_SECRET` | Auth. The probe of `payproxyapi.hubtel.com` returned 401 for every auth shape, so the account/keys we hold do not authenticate |
| Base URL + auth scheme | Which host each service lives on, and whether it is `basic`, `bearer`, or an OAuth2 `token_url` |
| Data service: purchase / bundles / status URLs | To enable the existing data-purchase path (see `HUBTEL_DATA_SETUP.md`) |
| `HUBTEL_CHECKOUT_URL` | Initiate endpoint for Hubtel Online Checkout. Required to switch on Hubtel wallet top-up; until then `create-agent-wallet-payment` returns 503 for a Hubtel top-up and the agent uses Paystack |
| `HUBTEL_CHECKOUT_STATUS_URL` | Re-read a checkout by order id. Required before the wallet will be credited from a Hubtel callback (`{orderId}` placeholder or an `orderId` query param) |
| `HUBTEL_MERCHANT_ACCOUNT` (+ `_NUMBER`) | Sent on data calls and on the checkout `merchantAccountNumber` |
| Per-bundle `hubtel_package_id`s | A bundle is only sellable once its id is mapped |
| KYC (Ghana Card / Voter ID) endpoint + enablement | Payloads 2–3 are a **new** service; nothing in the codebase calls them yet |
| USSD / Send Money endpoint + merchant config | Payload 4 is a **new** service; only relevant if we build payout disbursement |
| Confirmation of mapping | Which payload powers which Skaitech feature (data? AFA KYC? payouts?) |

The data path fails closed until its URLs are set: every purchase is refused with
HTTP 503 **before** any wallet is touched.
