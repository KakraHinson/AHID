-- The Hubtel MTN response is now the source of truth for the MTN tab. Keep
-- older application rows for audit/history, but remove them from the public
-- Instant Data catalog instead of showing disabled packages that Hubtel does
-- not currently offer.
update public.bundles
set catalog_source = 'hubtel_stale',
    updated_at = now()
where network_id = 'mtn'
  and catalog_source = 'instant_data'
  and is_available = false
  and unavailable_reason = 'This bundle was not returned by the current Hubtel MTN catalogue.';
