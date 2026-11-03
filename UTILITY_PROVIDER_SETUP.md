# Utility provider connection

The utility page calls a server-side provider adapter (`supabase/functions/_shared/utilityProvider.ts`). It communicates with Hubtel Commission Services for ECG and Ghana Water (GWCL).

### Ghana Water (GWCL) Configuration
- **Disbursement Account Number**: `2027124`
- **Service ID**: `6c1e8a8d2e84feeb8bfd6be2790d71d`
- **API Endpoint Template**:
  ```text
  https://cs.hubtel.com/commissionservices/${disbursementAccountNumber}/${serviceId}?destination=${meterNumber}&mobile=${phoneNumber}
  ```
  Evaluates to:
  ```text
  https://cs.hubtel.com/commissionservices/2027124/6c1e8a8d2e84feeb8bfd6be2790d71d?destination=${meterNumber}&mobile=${phoneNumber}
  ```
- **Optional Env Secret Override**:
  ```sh
  supabase secrets set UTILITY_PROVIDER_API_URL_GHANA_WATER="https://cs.hubtel.com/commissionservices/2027124/6c1e8a8d2e84feeb8bfd6be2790d71d"
  ```

### General Configuration
Configure the provider endpoint and API key as Supabase Edge Function secrets:

```sh
supabase secrets set UTILITY_PROVIDER_API_URL="https://provider.example/api/utility" UTILITY_PROVIDER_API_KEY="replace-with-provider-key"
```

The configured endpoint must accept authenticated `POST` requests with JSON. Requests contain `action` (`verify`, `purchase`, or `status`) plus service/account/order details. The adapter expects:

- `verify`: `{ "success": true, "verified": true, "customerName": "..." }`
- `purchase`: `{ "success": true, "token": "...", "providerReference": "..." }` (`token` is required for ECG Prepaid)
- `status`: `{ "success": true, "status": "completed" | "failed", "token": "..." }`

Every purchase request includes the unique Skaitech reference so the provider can make retries idempotent. The page requires verified agent access, verifies the account on the server before charging, records utility orders, and charges the wallet for the exact bill amount; Paystack's 1.95% fee applies only when funding the wallet. A declined purchase refunds the wallet; an ambiguous provider timeout stays in `processing` so it can be reconciled without risking a duplicate utility purchase.

Deploy the `verify-utility-account`, `create-utility-bill-payment`, and `get-utility-bill-order` Edge Functions, then apply the `20260930110000_ecg_postpaid.sql` migration before using ECG Postpaid. The Paystack webhook also uses the adapter for any existing gateway-paid utility orders.
