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

## 5. Everything required from Hubtel (complete list)

This is the whole set — nothing outside this list is read by the code. Set each as a
Supabase secret (`supabase secrets set NAME=value`). Values marked **blocker** mean
that feature stays switched off (fail-closed) until it is supplied.

### 5.1 Account / authentication (shared by every Hubtel service)

| Secret | Status | Needed for |
| --- | --- | --- |
| `HUBTEL_CLIENT_ID` | **blocker** | API client id. The value we hold returns HTTP 401 on every auth shape |
| `HUBTEL_CLIENT_SECRET` | **blocker** | API client secret |
| `HUBTEL_MERCHANT_ACCOUNT` | ✅ set | Merchant account / POS id **2040687** — sent on data calls and as the checkout `merchantAccountNumber` |
| `HUBTEL_MERCHANT_ACCOUNT_NUMBER` | ✅ set | Same POS id **2040687** for **airtime** (the airtime module reads this separate name) |
| `HUBTEL_AUTH_SCHEME` | ✅ set to `basic` | `basic` (default) or `bearer`, when there is no token endpoint |
| `HUBTEL_TOKEN_URL` | optional | OAuth2 `client_credentials` token endpoint |
| `HUBTEL_SCOPE` | optional | Scope for the token request |
| `HUBTEL_TIMEOUT_MS` | optional | Request timeout (default 25000) |

Also needed: **which auth scheme your account uses** (`basic` vs `bearer` vs OAuth2)
and the **base host** per service.

### 5.2 Wallet top-up — Hubtel Online Checkout (built)

| Secret | Status | Needed for |
| --- | --- | --- |
| `HUBTEL_CHECKOUT_URL` | **blocker** | Initiate endpoint. Until set, a Hubtel top-up returns 503 and the agent uses Paystack |
| `HUBTEL_CHECKOUT_STATUS_URL` | **blocker** | Transaction verify/status by order id. Until set, a callback is never credited (`{orderId}` placeholder or `?orderId=`) |

**Register this callback URL with Hubtel** (payment notifications):
```
https://mxovqblxizvjsmudjsjf.supabase.co/functions/v1/hubtel-webhook
```

### 5.3 Instant Data vending (built, off)

| Secret | Status | Needed for |
| --- | --- | --- |
| `HUBTEL_DATA_PURCHASE_URL` | **blocker** | Data purchase endpoint. Without it every data purchase is refused before the wallet is touched |
| `HUBTEL_DATA_BUNDLES_URL` | optional | Provider bundle catalogue, used to map package ids |
| `HUBTEL_DATA_STATUS_URL` | optional | Delivery status poll (a pending order cannot be settled without it) |

Plus: **one `hubtel_package_id` per bundle** (a bundle is not sellable until its id is
mapped — see `HUBTEL_DATA_SETUP.md` §3–4). Kokrokoo / Midnight / Voice also need their
real package id, price and volume.

### 5.4 Airtime (built, off)

| Item | Status | Needed for |
| --- | --- | --- |
| `HUBTEL_MERCHANT_ACCOUNT_NUMBER` | ✅ set (2040687) | Prepaid airtime top-up (endpoint `api.hubtel.com/.../prepaid/topup` is already hardcoded) |
| Confirmation the prepaid/airtime product is enabled on the account | **blocker** | Airtime dispatch |

### 5.5 KYC — Ghana Card / Voter ID (NOT built)

Request/response payloads are in §2–§3, but nothing in the codebase calls them.
To build it we need:
- The **verification endpoint URL(s)** (one per document type, if separate).
- The **auth** (same account, or a separate KYC account?).
- Confirmation these products are **enabled** for the account.

### 5.6 USSD "Send Money" / disbursement (NOT built)

Payloads are in §4. Only relevant if we build agent payouts (currently captured, not
executed). To build it we need:
- The **USSD short code** and **service code** already in the payloads (`713`).
- The **endpoint(s)** Hubtel calls for `Initiation` / `AddToCart` / `Checkout` and
  where we send the response.
- Confirmation of **who initiates** — customer dials `*713#` (push) vs our server
  requests a debit/credit (pull).

### 5.7 If you want us to stop asking

The only Hubtel things the code reads are the secret names in §5.1–5.4. If every
**blocker** row is supplied, wallet top-up, data and airtime all switch on with no
further code changes. KYC and USSD (§5.5–5.6) are new builds and need the endpoint
details on top.

Every feature fails closed until its URLs/creds are set: a purchase is refused with
HTTP 503 **before** any wallet is touched.

