-- Import the complete Instant Data catalog supplied by the product owner.
--
-- The ids below are application bundle keys. They are deliberately not copied
-- into hubtel_package_id: Hubtel's provider Value/package identifiers and
-- provider costs must be confirmed separately before a row can be sold.

drop policy if exists "Public can read available bundles" on public.bundles;
drop policy if exists "Public can read instant data catalog" on public.bundles;
create policy "Public can read instant data catalog"
  on public.bundles
  for select
  to anon, authenticated
  using (true);

with seed(bundle_key, network_id, category, title, price, validity, sort_order) as (
  values
    -- MTN Standard
    ('mtn_std_1', 'mtn', 'Standard', 'Kokrokoo 460.11MB (5am-8am)', 1.22, '5am-8am', 100),
    ('mtn_std_2', 'mtn', 'Standard', '406.89MB', 3.00, null, 101),
    ('mtn_std_3', 'mtn', 'Standard', '837.55MB', 10.00, null, 102),
    ('mtn_std_4', 'mtn', 'Standard', '1.39GB', 20.00, null, 103),
    ('mtn_std_5', 'mtn', 'Standard', '2.78GB', 40.00, null, 104),
    ('mtn_std_6', 'mtn', 'Standard', '4.17GB', 60.00, null, 105),
    ('mtn_std_7', 'mtn', 'Standard', '5.56GB', 80.00, null, 106),
    ('mtn_std_8', 'mtn', 'Standard', '9.17GB', 100.00, null, 107),
    ('mtn_std_9', 'mtn', 'Standard', '11.00GB', 120.00, null, 108),
    ('mtn_std_10', 'mtn', 'Standard', '13.75GB', 150.00, null, 109),
    ('mtn_std_11', 'mtn', 'Standard', '30.87GB', 200.00, null, 110),
    ('mtn_std_12', 'mtn', 'Standard', '38.59GB', 250.00, null, 111),
    ('mtn_std_13', 'mtn', 'Standard', '92.75GB', 300.00, null, 112),
    ('mtn_std_14', 'mtn', 'Standard', '108.21GB', 350.00, null, 113),
    ('mtn_std_15', 'mtn', 'Standard', '217.34GB', 399.00, null, 114),
    -- MTN Video
    ('mtn_vid_1', 'mtn', 'Video', 'Video 158.05MB', 1.00, null, 120),
    ('mtn_vid_2', 'mtn', 'Video', 'Video 790.25MB', 5.00, null, 121),
    ('mtn_vid_3', 'mtn', 'Video', 'Video 1.54GB', 10.00, null, 122),
    ('mtn_vid_4', 'mtn', 'Video', 'Video 6.17GB', 40.00, null, 123),
    ('mtn_vid_5', 'mtn', 'Video', 'Video 9.26GB', 60.00, null, 124),
    ('mtn_vid_6', 'mtn', 'Video', 'Video 30.87GB', 200.00, null, 125),
    ('mtn_vid_7', 'mtn', 'Video', 'Video 38.59GB', 250.00, null, 126),
    ('mtn_vid_8', 'mtn', 'Video', 'Video 46.30GB', 300.00, null, 127),
    ('mtn_vid_9', 'mtn', 'Video', 'Video 54.02GB', 350.00, null, 128),
    ('mtn_vid_10', 'mtn', 'Video', 'Video 77.17GB', 500.00, null, 129),
    -- MTN Social Media
    ('mtn_soc_1', 'mtn', 'Social Media', 'Social Media 82.57MB', 1.00, null, 140),
    ('mtn_soc_2', 'mtn', 'Social Media', 'Social Media 412.85MB', 5.00, null, 141),
    ('mtn_soc_3', 'mtn', 'Social Media', 'Social Media 825.7MB', 10.00, null, 142),
    ('mtn_soc_4', 'mtn', 'Social Media', 'Social Media 1.61GB', 20.00, null, 143),
    ('mtn_soc_5', 'mtn', 'Social Media', 'Social Media 4.84GB', 60.00, null, 144),
    ('mtn_soc_6', 'mtn', 'Social Media', 'Social Media 8.06GB', 100.00, null, 145),
    ('mtn_soc_7', 'mtn', 'Social Media', 'Social Media 24.19GB', 300.00, null, 146),
    ('mtn_soc_8', 'mtn', 'Social Media', 'Social Media 32.17GB', 399.00, null, 147),
    -- MTN Midnight
    ('mtn_mid_1', 'mtn', 'Midnight', 'Midnight 2.01GB', 1.00, null, 160),
    ('mtn_mid_2', 'mtn', 'Midnight', 'Midnight 4.02GB', 2.00, null, 161),
    ('mtn_mid_3', 'mtn', 'Midnight', 'Midnight 5.03GB', 2.50, null, 162),
    -- Telecel No Expiry
    ('tel_nx_1', 'telecel', 'No Expiry', 'No Expiry - 22.29MB (GHs 0.5)', 0.50, 'No Expiry', 200),
    ('tel_nx_2', 'telecel', 'No Expiry', 'No Expiry - 50.14MB (GHs 1)', 1.00, 'No Expiry', 201),
    ('tel_nx_3', 'telecel', 'No Expiry', 'No Expiry - 111.43MB (GHs 2)', 2.00, 'No Expiry', 202),
    ('tel_nx_4', 'telecel', 'No Expiry', 'No Expiry - 557.15MB (GHs 5)', 5.00, 'No Expiry', 203),
    ('tel_nx_5', 'telecel', 'No Expiry', 'No Expiry - 891.44MB (GHs 10)', 10.00, 'No Expiry', 204),
    ('tel_nx_6', 'telecel', 'No Expiry', 'No Expiry - 1.71GB (GHs 20)', 20.00, 'No Expiry', 205),
    ('tel_nx_7', 'telecel', 'No Expiry', 'No Expiry - 4.56GB (GHs 50)', 50.00, 'No Expiry', 206),
    ('tel_nx_8', 'telecel', 'No Expiry', 'No Expiry - 10.27GB (GHs 100)', 100.00, 'No Expiry', 207),
    ('tel_nx_9', 'telecel', 'No Expiry', 'No Expiry - 34.2GB (GHs 200)', 200.00, 'No Expiry', 208),
    ('tel_nx_10', 'telecel', 'No Expiry', 'No Expiry - 102.7GB (GHs 300)', 300.00, 'No Expiry', 209),
    ('tel_nx_11', 'telecel', 'No Expiry', 'No Expiry - 259.3GB (GHs 400)', 400.00, 'No Expiry', 210),
    -- Telecel Night and Timed
    ('tel_nit_1', 'telecel', 'Night', 'No Expiry (12am-5am) - 3.85GB (GHs 2)', 2.00, '12am-5am', 220),
    ('tel_nit_2', 'telecel', 'Night', 'No Expiry (12am-5am) - 9.9GB (GHs 3)', 3.00, '12am-5am', 221),
    ('tel_time_1', 'telecel', 'Timed', '1 Hour - 440MB (GHs 1)', 1.00, '1 hour', 230),
    ('tel_time_2', 'telecel', 'Timed', '1 Hour - 1.1GB (GHs 2)', 2.00, '1 hour', 231),
    -- Telecel Validity
    ('tel_val_1', 'telecel', 'Validity', '1 day - 445.72MB (GHs 3)', 3.00, '1 day', 240),
    ('tel_val_2', 'telecel', 'Validity', '3 days - 780MB (GHs 5)', 5.00, '3 days', 241),
    ('tel_val_3', 'telecel', 'Validity', '5 days - 1.14GB (GHs 10)', 10.00, '5 days', 242),
    ('tel_val_4', 'telecel', 'Validity', '15 days - 1GB (GHs 10)', 10.00, '15 days', 243),
    ('tel_val_5', 'telecel', 'Validity', '30 days - 2.51GB (GHs 20)', 20.00, '30 days', 244),
    ('tel_val_6', 'telecel', 'Validity', '5 days - 2.62GB (GHs 20)', 20.00, '5 days', 245),
    ('tel_val_7', 'telecel', 'Validity', '15 days - 5.13GB (GHs 43.5)', 43.50, '15 days', 246),
    ('tel_val_8', 'telecel', 'Validity', '30 days - 6.27GB (GHs 50)', 50.00, '30 days', 247),
    ('tel_val_9', 'telecel', 'Validity', '30 days - 13.12GB (GHs 100)', 100.00, '30 days', 248),
    ('tel_val_10', 'telecel', 'Validity', '30 days - 39.93GB (GHs 200)', 200.00, '30 days', 249),
    ('tel_val_11', 'telecel', 'Validity', '30 days - 114.1GB (GHs 300)', 300.00, '30 days', 250),
    ('tel_val_12', 'telecel', 'Validity', '30 days - 269.7GB (GHs 400)', 400.00, '30 days', 251),
    -- AirtelTigo Standard
    ('at_std_1', 'at', 'Standard', '51MB', 1.00, null, 300),
    ('at_std_2', 'at', 'Standard', '111MB', 2.00, null, 301),
    ('at_std_3', 'at', 'Standard', '390MB', 3.00, null, 302),
    ('at_std_4', 'at', 'Standard', '557MB', 5.00, null, 303),
    ('at_std_5', 'at', 'Standard', '891MB', 10.00, null, 304),
    ('at_std_6', 'at', 'Standard', '1.7GB', 20.00, null, 305),
    ('at_std_7', 'at', 'Standard', '4.5GB', 50.00, null, 306),
    ('at_std_8', 'at', 'Standard', '10GB', 100.00, null, 307),
    ('at_std_9', 'at', 'Standard', '33.4GB', 200.00, null, 308),
    ('at_std_10', 'at', 'Standard', '100.3GB', 300.00, null, 309),
    ('at_std_11', 'at', 'Standard', '117GB', 350.00, null, 310),
    ('at_std_12', 'at', 'Standard', '253.3GB', 400.00, null, 311),
    -- AirtelTigo Kokoo
    ('at_kok_1', 'at', 'Kokoo', 'Kokoo 446MB (1 Day)', 3.00, '1 day', 320),
    ('at_kok_2', 'at', 'Kokoo', 'Kokoo 780MB (3 Days)', 5.00, '3 days', 321),
    ('at_kok_3', 'at', 'Kokoo', 'Kokoo 1GB (2 Days)', 6.00, '2 days', 322),
    ('at_kok_4', 'at', 'Kokoo', 'Kokoo 1.1GB (5 Days)', 10.00, '5 days', 323),
    ('at_kok_5', 'at', 'Kokoo', 'Kokoo 1.2GB (2 Days)', 11.00, '2 days', 324),
    ('at_kok_6', 'at', 'Kokoo', 'Kokoo 2GB (4 Days)', 15.00, '4 days', 325),
    ('at_kok_7', 'at', 'Kokoo', 'Kokoo 2.5GB (5 Days)', 20.00, '5 days', 326),
    ('at_kok_8', 'at', 'Kokoo', 'Kokoo 6.1GB (15 Days)', 50.00, '15 days', 327),
    -- AirtelTigo XXL
    ('at_xxl_1', 'at', 'XXL', 'XXL 12.8GB', 99.00, null, 340),
    ('at_xxl_2', 'at', 'XXL', 'XXL 39GB', 200.00, null, 341),
    ('at_xxl_3', 'at', 'XXL', 'XXL Pack 130.4GB', 350.00, null, 342),
    -- AirtelTigo Combo
    ('at_voc_1', 'at', 'Combo', '26mins 40MB', 2.00, null, 360),
    ('at_voc_2', 'at', 'Combo', '66mins 120MB', 5.00, null, 361),
    ('at_voc_3', 'at', 'Combo', '138mins 260MB', 10.00, null, 362),
    ('at_voc_4', 'at', 'Combo', '210mins 400MB', 15.00, null, 363),
    ('at_voc_5', 'at', 'Combo', '280mins 500MB', 20.00, null, 364),
    ('at_voc_6', 'at', 'Combo', '450mins 1GB', 30.00, null, 365),
    ('at_voc_7', 'at', 'Combo', '600mins 2.4GB', 50.00, null, 366)
), parsed as (
  select
    seed.*,
    greatest(1, case
      when lower(m[2]) = 'gb' then round(m[1]::numeric * 1024)
      else round(m[1]::numeric)
    end)::integer as volume_mb
  from seed
  cross join lateral regexp_match(seed.title, '([0-9]+(?:\.[0-9]+)?)\s*(GB|MB)', 'i') as m
)
insert into public.bundles
  (bundle_key, network_id, title, data_amount, volume_mb, price, category, validity,
   provider, is_available, unavailable_reason, sort_order)
select
  bundle_key,
  network_id,
  title,
  title,
  volume_mb,
  price,
  category,
  validity,
  'hubtel',
  false,
  'Awaiting the Hubtel provider package Value and provider cost mapping.',
  sort_order
from parsed
on conflict (bundle_key) do update
set network_id = excluded.network_id,
    title = excluded.title,
    data_amount = excluded.data_amount,
    volume_mb = excluded.volume_mb,
    price = excluded.price,
    category = excluded.category,
    validity = excluded.validity,
    sort_order = excluded.sort_order,
    updated_at = now();

comment on policy "Public can read instant data catalog" on public.bundles is
  'The public catalog includes mapped and unmapped product rows; only mapped rows are accepted by the purchase function.';
