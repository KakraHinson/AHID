-- Hold the complete Instant Data storefront while the remaining Hubtel package
-- mappings are being reviewed. The Edge Function also has a server-side gate,
-- so this is both a truthful catalog state and a database safety net.
update public.bundles
set is_available = false,
    unavailable_reason = 'Instant Data is temporarily out of stock while provider mappings are being completed.',
    updated_at = now()
where catalog_source = 'instant_data';
