-- Map the Vodafone/Telecel Instant Data catalogue supplied by Hubtel.
-- The provider values are the strings returned by Hubtel (for example
-- "2 GB"), so they are stored exactly after trimming whitespace.

insert into public.bundles
  (bundle_key, network_id, title, data_amount, volume_mb, price, category,
   validity, provider, hubtel_package_id, provider_cost, is_available,
   unavailable_reason, sort_order, catalog_source)
values
  ('tel_hubtel_dual_recharge_50', 'telecel', 'Dual Recharge 5.7GB', '5.7GB', 5837, 50.00, 'Standard', '30 days',
   'hubtel', '5.7 GB', 50.00, true, null, 200, 'instant_data'),
  ('tel_hubtel_chat_monthly_20', 'telecel', 'Chat Monthly 2GB', '2GB', 2048, 20.00, 'Standard', '30 days',
   'hubtel', '2 GB', 20.00, true, null, 201, 'instant_data'),
  ('tel_hubtel_starter_monthly_10', 'telecel', 'Starter Monthly 560MB', '560MB', 560, 10.00, 'Standard', '30 days',
   'hubtel', '560 MB', 10.00, true, null, 202, 'instant_data'),
  ('tel_hubtel_streamer_weekly_5', 'telecel', 'Streamer Weekly 460MB', '460MB', 460, 5.00, 'Standard', '7 days',
   'hubtel', '460 MB', 5.00, true, null, 203, 'instant_data'),
  ('tel_hubtel_browser_daily_1', 'telecel', 'Browser Daily 61MB', '61MB', 61, 1.00, 'Standard', '1 day',
   'hubtel', '61 MB', 1.00, true, null, 204, 'instant_data'),
  ('tel_hubtel_starter_daily_0_5', 'telecel', 'Starter Daily 25MB', '25MB', 25, 0.50, 'Standard', '1 day',
   'hubtel', '25 MB', 0.50, true, null, 205, 'instant_data')
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

-- Do not show the old app-only Telecel rows beside the confirmed Hubtel list.
-- They remain in the table for history and can be reactivated if Hubtel returns
-- them in a later catalogue response.
update public.bundles
set catalog_source = 'hubtel_stale',
    updated_at = now()
where network_id = 'telecel'
  and catalog_source = 'instant_data'
  and bundle_key not in (
    'tel_hubtel_dual_recharge_50', 'tel_hubtel_chat_monthly_20',
    'tel_hubtel_starter_monthly_10', 'tel_hubtel_streamer_weekly_5',
    'tel_hubtel_browser_daily_1', 'tel_hubtel_starter_daily_0_5'
  );
