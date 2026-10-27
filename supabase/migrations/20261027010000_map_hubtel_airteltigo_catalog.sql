-- Map the AirtelTigo Instant Data catalogue published by Hubtel.
--
-- Source: the "AT Data Bundle Query" section of the Hubtel Commission Services
-- reference, which lists the packages as Display / Value / Amount:
--
--   Display                    Value     Amount
--   80MB Bundle (GHS 1)        DATA1       1.00
--   200MB Bundle (GHS 2        DATA2       2.00
--   650MB Bundle (GHS 5)       DATA5       5.00
--   2GB Bundle (GHS 10)        DATA10     10.00
--   5GB Bundle (GHS 20)        DATA20     20.00
--   11GB Bundle (GHS 50)       DATA50     50.00
--
-- `hubtel_package_id` holds the Value verbatim and `provider_cost` holds the
-- Amount, because Hubtel is sent exactly this pair in Extradata.bundle and
-- Amount. It validates them together: a Value and an Amount that did not come
-- from the same catalogue row make the transaction fail.
--
-- The doc gives no validity period for these packages, so validity is left null
-- rather than invented. Prices are the provider's own amounts, so the agent
-- price equals cost and the margin is the commission Hubtel returns.
--
-- AirtelTigo previously had 30 Instant Data rows carrying the app's own assumed
-- package list. None of them appears in the Hubtel catalogue and none was ever
-- mapped, so they are retired as `hubtel_stale` below instead of being shown
-- beside the confirmed list. They stay in the table for history and can be
-- reactivated if Hubtel returns them.

insert into public.bundles
  (bundle_key, network_id, title, data_amount, volume_mb, price, category,
   validity, provider, hubtel_package_id, provider_cost, is_available,
   unavailable_reason, sort_order, catalog_source)
values
  ('at_hubtel_data_1', 'at', '80MB', '80MB', 80, 1.00, 'Standard',
   null, 'hubtel', 'DATA1', 1.00, true, null, 300, 'instant_data'),
  ('at_hubtel_data_2', 'at', '200MB', '200MB', 200, 2.00, 'Standard',
   null, 'hubtel', 'DATA2', 2.00, true, null, 301, 'instant_data'),
  ('at_hubtel_data_5', 'at', '650MB', '650MB', 650, 5.00, 'Standard',
   null, 'hubtel', 'DATA5', 5.00, true, null, 302, 'instant_data'),
  ('at_hubtel_data_10', 'at', '2GB', '2GB', 2048, 10.00, 'Standard',
   null, 'hubtel', 'DATA10', 10.00, true, null, 303, 'instant_data'),
  ('at_hubtel_data_20', 'at', '5GB', '5GB', 5120, 20.00, 'Standard',
   null, 'hubtel', 'DATA20', 20.00, true, null, 304, 'instant_data'),
  ('at_hubtel_data_50', 'at', '11GB', '11GB', 11264, 50.00, 'Standard',
   null, 'hubtel', 'DATA50', 50.00, true, null, 305, 'instant_data')
on conflict (bundle_key) do update
set network_id = excluded.network_id,
    title = excluded.title,
    data_amount = excluded.data_amount,
    volume_mb = excluded.volume_mb,
    price = excluded.price,
    category = excluded.category,
    validity = excluded.validity,
    provider = excluded.provider,
    hubtel_package_id = excluded.hubtel_package_id,
    provider_cost = excluded.provider_cost,
    is_available = excluded.is_available,
    unavailable_reason = excluded.unavailable_reason,
    sort_order = excluded.sort_order,
    catalog_source = excluded.catalog_source,
    updated_at = now();

-- Do not show the unmapped app-only AirtelTigo rows beside the confirmed
-- Hubtel list.
update public.bundles
set catalog_source = 'hubtel_stale',
    updated_at = now()
where network_id = 'at'
  and catalog_source = 'instant_data'
  and bundle_key not in (
    'at_hubtel_data_1', 'at_hubtel_data_2', 'at_hubtel_data_5',
    'at_hubtel_data_10', 'at_hubtel_data_20', 'at_hubtel_data_50'
  );
