-- ============================================================================
-- Migration: resume Instant Data sales
-- ============================================================================
--
-- 20261018060000 held the whole Instant Data storefront while the Hubtel
-- package mappings were being reviewed. This releases the rows that review
-- covered: the ones carrying a complete Hubtel mapping, i.e. both the provider
-- bundle Value (`hubtel_package_id`) and the amount Hubtel sells it for
-- (`provider_cost`). A row missing either cannot be ordered, because Hubtel
-- validates the two as a pair.
--
-- AirtelTigo has no mapped rows at all and is deliberately left dark. It is
-- marked with a truthful reason rather than the blanket out-of-stock message,
-- so the storefront says why.
--
-- Two separate gates still apply, and neither is changed here:
--
--   * `INSTANT_DATA_SALES_ENABLED` (Edge Function secret) is the master switch.
--     With it off, `data-catalog` reports every row unavailable and
--     `purchase-data-bundle` refuses before the wallet is touched.
--   * Availability is no longer taken on trust at purchase time: the purchase
--     path asks Hubtel for that number's current bundle list before charging
--     the wallet, and refuses a bundle the provider no longer offers. A stale
--     mapping therefore cannot become a paid, undelivered order.
-- ============================================================================

update public.bundles
set is_available = true,
    unavailable_reason = null,
    updated_at = now()
where catalog_source = 'instant_data'
  and hubtel_package_id is not null
  and provider_cost is not null
  and provider_cost > 0;

update public.bundles
set is_available = false,
    unavailable_reason = 'Awaiting a Hubtel package mapping for this network.',
    updated_at = now()
where catalog_source = 'instant_data'
  and (
    hubtel_package_id is null
    or provider_cost is null
    or provider_cost <= 0
  );
