-- Map the MTN Instant Data catalogue supplied by Hubtel.
--
-- The application bundle keys are retained for the rows that already exist in
-- the storefront. `hubtel_package_id` is the provider Value, while
-- `provider_cost` and `price` use the Amount returned by Hubtel. The two small
-- rows that were not present in the original app catalogue are inserted below.
-- Rows Hubtel did not return remain visible as unavailable and cannot be
-- purchased.

update public.bundles
set title = 'Kokrokoo 400MB, 5am to 8am',
    data_amount = 'Kokrokoo 400MB, 5am to 8am',
    volume_mb = 400,
    price = 1.24,
    category = 'Kokrokoo',
    validity = '5am-8am',
    provider = 'hubtel',
    hubtel_package_id = 'kokrokoo_bundle_1',
    provider_cost = 1.24,
    is_available = true,
    unavailable_reason = null,
    catalog_source = 'instant_data',
    updated_at = now()
where bundle_key = 'mtn_std_1';

update public.bundles
set title = '349.24MB', data_amount = '349.24MB', volume_mb = 349,
    price = 3.00, provider = 'hubtel', hubtel_package_id = 'data_bundle_3',
    provider_cost = 3.00, is_available = true, unavailable_reason = null,
    catalog_source = 'instant_data', updated_at = now()
where bundle_key = 'mtn_std_2';

update public.bundles
set title = '718.91MB', data_amount = '718.91MB', volume_mb = 719,
    price = 10.00, provider = 'hubtel', hubtel_package_id = 'data_bundle_4',
    provider_cost = 10.00, is_available = true, unavailable_reason = null,
    catalog_source = 'instant_data', updated_at = now()
where bundle_key = 'mtn_std_3';

with flexi(bundle_key, title, volume_mb, price, sort_order) as (values
  ('mtn_std_4',  '1.19GB',  1219,  20.00, 103),
  ('mtn_std_5',  '2.38GB',  2437,  40.00, 104),
  ('mtn_std_6',  '3.58GB',  3666,  60.00, 105),
  ('mtn_std_7',  '4.77GB',  4884,  80.00, 106),
  ('mtn_std_8',  '7.87GB',  8059, 100.00, 107),
  ('mtn_std_9',  '9.44GB',  9667, 120.00, 108),
  ('mtn_std_10', '11.80GB', 12083, 150.00, 109),
  ('mtn_std_11', '26.50GB', 27136, 200.00, 110),
  ('mtn_std_12', '33.13GB', 33925, 250.00, 111),
  ('mtn_std_13', '39.62GB', 40571, 299.00, 112),
  ('mtn_std_14', '92.88GB', 95007, 350.00, 113)
)
update public.bundles as b
set title = flexi.title,
    data_amount = flexi.title,
    volume_mb = flexi.volume_mb,
    price = flexi.price,
    category = case when flexi.volume_mb >= 20480 then 'XXL' else 'Standard' end,
    provider = 'hubtel',
    hubtel_package_id = 'flexi_data_bundle',
    provider_cost = flexi.price,
    is_available = true,
    unavailable_reason = null,
    sort_order = flexi.sort_order,
    catalog_source = 'instant_data',
    updated_at = now()
from flexi
where b.bundle_key = flexi.bundle_key;

insert into public.bundles
  (bundle_key, network_id, title, data_amount, volume_mb, price, category,
   provider, hubtel_package_id, provider_cost, is_available, unavailable_reason,
   sort_order, catalog_source)
values
  ('mtn_hubtel_data_0_5', 'mtn', '17.79MB', '17.79MB', 18, 0.50, 'Standard',
   'hubtel', 'data_bundle_1', 0.50, true, null, 98, 'instant_data'),
  ('mtn_hubtel_data_1', 'mtn', '35.57MB', '35.57MB', 36, 1.00, 'Standard',
   'hubtel', 'data_bundle_2', 1.00, true, null, 99, 'instant_data')
on conflict (bundle_key) do update
set title = excluded.title,
    data_amount = excluded.data_amount,
    volume_mb = excluded.volume_mb,
    price = excluded.price,
    category = excluded.category,
    provider = excluded.provider,
    hubtel_package_id = excluded.hubtel_package_id,
    provider_cost = excluded.provider_cost,
    is_available = excluded.is_available,
    unavailable_reason = excluded.unavailable_reason,
    sort_order = excluded.sort_order,
    catalog_source = excluded.catalog_source,
    updated_at = now();

with provider_rows(bundle_key, title, volume_mb, package_id, amount, category, sort_order) as (values
  ('mtn_vid_1', 'Video 135.69MB', 136, 'video_bundle_1', 1.00, 'Video', 120),
  ('mtn_vid_2', 'Video 678.43MB', 694, 'video_bundle_2', 5.00, 'Video', 121),
  ('mtn_vid_3', 'Video 1.33GB', 1362, 'video_bundle_3', 10.00, 'Video', 122),
  ('mtn_soc_1', 'Social Media 70.87MB', 71, 'social_media_bundle_1', 1.00, 'Social Media', 140),
  ('mtn_soc_2', 'Social Media 354.36MB', 363, 'social_media_bundle_2', 5.00, 'Social Media', 141),
  ('mtn_soc_3', 'Social Media 708.72MB', 726, 'social_media_bundle_3', 10.00, 'Social Media', 142)
)
update public.bundles as b
set title = provider_rows.title,
    data_amount = provider_rows.title,
    volume_mb = provider_rows.volume_mb,
    price = provider_rows.amount,
    category = provider_rows.category,
    provider = 'hubtel',
    hubtel_package_id = provider_rows.package_id,
    provider_cost = provider_rows.amount,
    is_available = true,
    unavailable_reason = null,
    sort_order = provider_rows.sort_order,
    catalog_source = 'instant_data',
    updated_at = now()
from provider_rows
where b.bundle_key = provider_rows.bundle_key;

update public.bundles
set is_available = false,
    hubtel_package_id = null,
    provider_cost = null,
    unavailable_reason = 'This bundle was not returned by the current Hubtel MTN catalogue.',
    updated_at = now()
where network_id = 'mtn'
  and catalog_source = 'instant_data'
  and bundle_key not in (
    'mtn_std_1', 'mtn_std_2', 'mtn_std_3', 'mtn_std_4', 'mtn_std_5',
    'mtn_std_6', 'mtn_std_7', 'mtn_std_8', 'mtn_std_9', 'mtn_std_10',
    'mtn_std_11', 'mtn_std_12', 'mtn_std_13', 'mtn_std_14',
    'mtn_vid_1', 'mtn_vid_2', 'mtn_vid_3', 'mtn_soc_1', 'mtn_soc_2', 'mtn_soc_3',
    'mtn_hubtel_data_0_5', 'mtn_hubtel_data_1'
  );
