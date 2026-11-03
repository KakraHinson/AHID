-- Replace the placeholder Instant Data catalogue with the current Hubtel
-- commission-service catalogue supplied on 2026-11-03.
--
-- `instant_data_bundles` is the customer-facing catalogue.  The provider
-- `Value` and `Amount` must live beside the selling price so checkout does not
-- have to guess a mapping by display text or volume.

alter table public.instant_data_bundles
  add column if not exists provider_value text,
  add column if not exists provider_cost numeric(10, 2);

create index if not exists instant_data_bundles_provider_value_idx
  on public.instant_data_bundles(network, provider_value)
  where is_active = true and provider_value is not null;

-- The previous 94-row catalogue was not mapped to the current Hubtel Values.
-- Keep it for historical/admin reference, but remove it from the storefront.
update public.instant_data_bundles
set is_active = false;

insert into public.instant_data_bundles
  (network, category, name, volume, price, validity, is_active, provider_value, provider_cost)
values
  -- MTN (22)
  ('MTN', 'Standard', '17.79MB', '17.79MB', 0.50, null, true, 'data_bundle_1', 0.50),
  ('MTN', 'Kokrokoo', 'Kokrokoo 400MB, 5am to 8am', '400MB', 1.24, '5am to 8am', true, 'kokrokoo_bundle_1', 1.24),
  ('MTN', 'Standard', '35.57MB', '35.57MB', 1.00, null, true, 'data_bundle_2', 1.00),
  ('MTN', 'Standard', '349.24MB', '349.24MB', 3.00, null, true, 'data_bundle_3', 3.00),
  ('MTN', 'Standard', '718.91MB', '718.91MB', 10.00, null, true, 'data_bundle_4', 10.00),
  ('MTN', 'Standard', '1.19GB', '1.19GB', 20.00, null, true, 'flexi_data_bundle', 20.00),
  ('MTN', 'Standard', '2.38GB', '2.38GB', 40.00, null, true, 'flexi_data_bundle', 40.00),
  ('MTN', 'Standard', '3.58GB', '3.58GB', 60.00, null, true, 'flexi_data_bundle', 60.00),
  ('MTN', 'Standard', '4.77GB', '4.77GB', 80.00, null, true, 'flexi_data_bundle', 80.00),
  ('MTN', 'Standard', '7.87GB', '7.87GB', 100.00, null, true, 'flexi_data_bundle', 100.00),
  ('MTN', 'Standard', '9.44GB', '9.44GB', 120.00, null, true, 'flexi_data_bundle', 120.00),
  ('MTN', 'Standard', '11.80GB', '11.80GB', 150.00, null, true, 'flexi_data_bundle', 150.00),
  ('MTN', 'Standard', '26.50GB', '26.50GB', 200.00, null, true, 'flexi_data_bundle', 200.00),
  ('MTN', 'Standard', '33.13GB', '33.13GB', 250.00, null, true, 'flexi_data_bundle', 250.00),
  ('MTN', 'Standard', '39.62GB', '39.62GB', 299.00, null, true, 'flexi_data_bundle', 299.00),
  ('MTN', 'Standard', '92.88GB', '92.88GB', 350.00, null, true, 'flexi_data_bundle', 350.00),
  ('MTN', 'Video', 'Video 135.69MB', '135.69MB', 1.00, null, true, 'video_bundle_1', 1.00),
  ('MTN', 'Video', 'Video 678.43MB', '678.43MB', 5.00, null, true, 'video_bundle_2', 5.00),
  ('MTN', 'Video', 'Video 1.33GB', '1.33GB', 10.00, null, true, 'video_bundle_3', 10.00),
  ('MTN', 'Social Media', 'Social Media 70.87MB', '70.87MB', 1.00, null, true, 'social_media_bundle_1', 1.00),
  ('MTN', 'Social Media', 'Social Media 354.36MB', '354.36MB', 5.00, null, true, 'social_media_bundle_2', 5.00),
  ('MTN', 'Social Media', 'Social Media 708.72MB', '708.72MB', 10.00, null, true, 'social_media_bundle_3', 10.00),

  -- Telecel (6)
  ('Telecel', 'Standard', 'Starter Daily', '25 MB', 0.50, null, true, '25 MB', 0.50),
  ('Telecel', 'Standard', 'Browser Daily', '61 MB', 1.00, null, true, '61 MB', 1.00),
  ('Telecel', 'Standard', 'Streamer Weekly', '460 MB', 5.00, null, true, '460 MB', 5.00),
  ('Telecel', 'Standard', 'Starter Monthly', '560 MB', 10.00, null, true, '560 MB', 10.00),
  ('Telecel', 'Standard', 'Chat Monthly', '2 GB', 20.00, null, true, '2 GB', 20.00),
  ('Telecel', 'Standard', 'Dual Recharge', '5.7 GB', 50.00, null, true, '5.7 GB', 50.00),

  -- AirtelTigo (6)
  ('AT', 'Standard', '80MB Bundle (GHS 1)', '80MB', 1.00, null, true, 'DATA1', 1.00),
  ('AT', 'Standard', '200MB Bundle (GHS 2)', '200MB', 2.00, null, true, 'DATA2', 2.00),
  ('AT', 'Standard', '650MB Bundle (GHS 5)', '650MB', 5.00, null, true, 'DATA5', 5.00),
  ('AT', 'Standard', '2GB Bundle (GHS 10)', '2GB', 10.00, null, true, 'DATA10', 10.00),
  ('AT', 'Standard', '5GB Bundle (GHS 20)', '5GB', 20.00, null, true, 'DATA20', 20.00),
  ('AT', 'Standard', '11GB Bundle (GHS 50)', '11GB', 50.00, null, true, 'DATA50', 50.00)
on conflict (network, category, name, volume, price, validity) do update
set is_active = excluded.is_active,
    provider_value = excluded.provider_value,
    provider_cost = excluded.provider_cost;

comment on column public.instant_data_bundles.provider_value is
  'Hubtel commission-service bundle Value sent as Extradata.bundle.';
comment on column public.instant_data_bundles.provider_cost is
  'Hubtel commission-service Amount in GHS; distinct from the admin selling price.';

-- Store a readable plan title with each transaction.  The existing bundle_id
-- remains nullable because these plans are no longer required to mirror the
-- older public.bundles mapping table.
alter table public.data_transactions
  add column if not exists bundle_title text;
