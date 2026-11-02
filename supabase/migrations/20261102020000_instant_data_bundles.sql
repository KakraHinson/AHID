-- Instant Data plans supplied by the business catalogue.
--
-- These rows are the display/pricing source for the Instant Data storefront.
-- Delivery still requires a provider package mapping at checkout; the purchase
-- function refuses an unmapped plan before charging the agent wallet.

create table if not exists public.instant_data_bundles (
  id uuid primary key default gen_random_uuid(),
  network text not null check (network in ('MTN', 'Telecel', 'AT')),
  category text not null,
  name text not null,
  volume text not null,
  price numeric(10, 2) not null check (price > 0),
  validity text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint instant_data_bundles_catalog_unique
    unique (network, category, name, volume, price, validity)
);

create index if not exists instant_data_bundles_active_network_idx
  on public.instant_data_bundles(network, category, price)
  where is_active = true;

alter table public.instant_data_bundles enable row level security;
drop policy if exists "Public can view active instant data bundles" on public.instant_data_bundles;
create policy "Public can view active instant data bundles"
  on public.instant_data_bundles for select
  to anon, authenticated
  using (is_active = true);

grant select on public.instant_data_bundles to anon, authenticated, service_role;
revoke insert, update, delete on public.instant_data_bundles from anon, authenticated;

insert into public.instant_data_bundles
  (network, category, name, volume, price, validity, is_active)
values
  -- MTN BUNDLES (37 items)
  ('MTN', 'Midnight', 'Midnight 2.01GB', '2.01GB', 1.00, 'Midnight', true),
  ('MTN', 'Midnight', 'Midnight 4.02GB', '4.02GB', 2.00, 'Midnight', true),
  ('MTN', 'Midnight', 'Midnight 5.03GB', '5.03GB', 2.50, 'Midnight', true),
  ('MTN', 'Midnight', 'Midnight 8.48GB', '8.48GB', 3.00, 'Midnight', true),
  ('MTN', 'Kokrokoo', 'Kokrokoo 460.11MB (5am to 8am)', '460.11MB', 1.22, '5am to 8am', true),
  ('MTN', 'Regular', '406.89MB', '406.89MB', 3.00, 'No Expiry', true),
  ('MTN', 'Regular', '837.55MB', '837.55MB', 10.00, 'No Expiry', true),
  ('MTN', 'Regular', '1.39GB', '1.39GB', 20.00, 'No Expiry', true),
  ('MTN', 'Regular', '2.78GB', '2.78GB', 40.00, 'No Expiry', true),
  ('MTN', 'Regular', '4.17GB', '4.17GB', 60.00, 'No Expiry', true),
  ('MTN', 'Regular', '5.56GB', '5.56GB', 80.00, 'No Expiry', true),
  ('MTN', 'Regular', '9.17GB', '9.17GB', 100.00, 'No Expiry', true),
  ('MTN', 'Regular', '11.00GB', '11.00GB', 120.00, 'No Expiry', true),
  ('MTN', 'Regular', '13.75GB', '13.75GB', 150.00, 'No Expiry', true),
  ('MTN', 'Regular', '30.87GB', '30.87GB', 200.00, 'No Expiry', true),
  ('MTN', 'Regular', '38.59GB', '38.59GB', 250.00, 'No Expiry', true),
  ('MTN', 'Regular', '92.75GB', '92.75GB', 300.00, 'No Expiry', true),
  ('MTN', 'Regular', '108.21GB', '108.21GB', 350.00, 'No Expiry', true),
  ('MTN', 'Regular', '217.34GB', '217.34GB', 399.00, 'No Expiry', true),
  ('MTN', 'Social Media', 'Social Media 82.57MB', '82.57MB', 1.00, 'No Expiry', true),
  ('MTN', 'Social Media', 'Social Media 412.85MB', '412.85MB', 5.00, 'No Expiry', true),
  ('MTN', 'Social Media', 'Social Media 825.7MB', '825.7MB', 10.00, 'No Expiry', true),
  ('MTN', 'Social Media', 'Social Media 1.61GB', '1.61GB', 20.00, 'No Expiry', true),
  ('MTN', 'Social Media', 'Social Media 4.84GB', '4.84GB', 60.00, 'No Expiry', true),
  ('MTN', 'Social Media', 'Social Media 8.06GB', '8.06GB', 100.00, 'No Expiry', true),
  ('MTN', 'Social Media', 'Social Media 24.19GB', '24.19GB', 300.00, 'No Expiry', true),
  ('MTN', 'Social Media', 'Social Media 32.17GB', '32.17GB', 399.00, 'No Expiry', true),
  ('MTN', 'Video', 'Video 158.05MB', '158.05MB', 1.00, 'No Expiry', true),
  ('MTN', 'Video', 'Video 790.25MB', '790.25MB', 5.00, 'No Expiry', true),
  ('MTN', 'Video', 'Video 1.54GB', '1.54GB', 10.00, 'No Expiry', true),
  ('MTN', 'Video', 'Video 6.17GB', '6.17GB', 40.00, 'No Expiry', true),
  ('MTN', 'Video', 'Video 9.26GB', '9.26GB', 60.00, 'No Expiry', true),
  ('MTN', 'Video', 'Video 30.87GB', '30.87GB', 200.00, 'No Expiry', true),
  ('MTN', 'Video', 'Video 38.59GB', '38.59GB', 250.00, 'No Expiry', true),
  ('MTN', 'Video', 'Video 46.30GB', '46.30GB', 300.00, 'No Expiry', true),
  ('MTN', 'Video', 'Video 54.02GB', '54.02GB', 350.00, 'No Expiry', true),
  ('MTN', 'Video', 'Video 77.17GB', '77.17GB', 500.00, 'No Expiry', true),

  -- TELECEL BUNDLES (27 items)
  ('Telecel', 'No Expiry', '22.29MB', '22.29MB', 0.50, 'No Expiry', true),
  ('Telecel', 'No Expiry', '50.14MB', '50.14MB', 1.00, 'No Expiry', true),
  ('Telecel', 'No Expiry', '111.43MB', '111.43MB', 2.00, 'No Expiry', true),
  ('Telecel', 'No Expiry', '557.15MB', '557.15MB', 5.00, 'No Expiry', true),
  ('Telecel', 'No Expiry', '891.44MB', '891.44MB', 10.00, 'No Expiry', true),
  ('Telecel', 'No Expiry', '1.71GB', '1.71GB', 20.00, 'No Expiry', true),
  ('Telecel', 'No Expiry', '4.56GB', '4.56GB', 50.00, 'No Expiry', true),
  ('Telecel', 'No Expiry', '10.27GB', '10.27GB', 100.00, 'No Expiry', true),
  ('Telecel', 'No Expiry', '34.2GB', '34.2GB', 200.00, 'No Expiry', true),
  ('Telecel', 'No Expiry', '102.7GB', '102.7GB', 300.00, 'No Expiry', true),
  ('Telecel', 'No Expiry', '259.3GB', '259.3GB', 400.00, 'No Expiry', true),
  ('Telecel', 'Night', '3.85GB (12am - 5am)', '3.85GB', 2.00, '12am - 5am', true),
  ('Telecel', 'Night', '9.9GB (12am - 5am)', '9.9GB', 3.00, '12am - 5am', true),
  ('Telecel', 'Time-Based', '440MB', '440MB', 1.00, '1 Hour', true),
  ('Telecel', 'Time-Based', '1.1GB', '1.1GB', 2.00, '1 Hour', true),
  ('Telecel', 'Validity', '445.72MB', '445.72MB', 3.00, '1 Day', true),
  ('Telecel', 'Validity', '780MB', '780MB', 5.00, '3 Days', true),
  ('Telecel', 'Validity', '1.14GB', '1.14GB', 10.00, '5 Days', true),
  ('Telecel', 'Validity', '1GB', '1GB', 10.00, '15 Days', true),
  ('Telecel', 'Validity', '2.62GB', '2.62GB', 20.00, '5 Days', true),
  ('Telecel', 'Validity', '2.51GB', '2.51GB', 20.00, '30 Days', true),
  ('Telecel', 'Validity', '5.13GB', '5.13GB', 43.50, '15 Days', true),
  ('Telecel', 'Validity', '6.27GB', '6.27GB', 50.00, '30 Days', true),
  ('Telecel', 'Validity', '13.12GB', '13.12GB', 100.00, '30 Days', true),
  ('Telecel', 'Validity', '39.93GB', '39.93GB', 200.00, '30 Days', true),
  ('Telecel', 'Validity', '114.1GB', '114.1GB', 300.00, '30 Days', true),
  ('Telecel', 'Validity', '269.7GB', '269.7GB', 400.00, '30 Days', true),

  -- AT BUNDLES (30 items)
  ('AT', 'Regular', '51MB', '51MB', 1.00, 'No Expiry', true),
  ('AT', 'Regular', '111MB', '111MB', 2.00, 'No Expiry', true),
  ('AT', 'Regular', '390MB', '390MB', 3.00, 'No Expiry', true),
  ('AT', 'Regular', '557MB', '557MB', 5.00, 'No Expiry', true),
  ('AT', 'Regular', '891MB', '891MB', 10.00, 'No Expiry', true),
  ('AT', 'Regular', '1.7GB', '1.7GB', 20.00, 'No Expiry', true),
  ('AT', 'Regular', '4.5GB', '4.5GB', 50.00, 'No Expiry', true),
  ('AT', 'Regular', '10GB', '10GB', 100.00, 'No Expiry', true),
  ('AT', 'Regular', '33.4GB', '33.4GB', 200.00, 'No Expiry', true),
  ('AT', 'Regular', '100.3GB', '100.3GB', 300.00, 'No Expiry', true),
  ('AT', 'Regular', '117GB', '117GB', 350.00, 'No Expiry', true),
  ('AT', 'Regular', '253.3GB', '253.3GB', 400.00, 'No Expiry', true),
  ('AT', 'Regular', 'XXL 12.8GB', '12.8GB', 99.00, 'No Expiry', true),
  ('AT', 'Regular', 'XXL 39GB', '39GB', 200.00, 'No Expiry', true),
  ('AT', 'Regular', 'XXL Pack 130.4GB', '130.4GB', 350.00, 'No Expiry', true),
  ('AT', 'Kokoo', 'Kokoo 446MB', '446MB', 3.00, '1 Day', true),
  ('AT', 'Kokoo', 'Kokoo 780MB', '780MB', 5.00, '3 Days', true),
  ('AT', 'Kokoo', 'Kokoo 1GB', '1GB', 6.00, '2 Days', true),
  ('AT', 'Kokoo', 'Kokoo 1.1GB', '1.1GB', 10.00, '5 Days', true),
  ('AT', 'Kokoo', 'Kokoo 1.2GB', '1.2GB', 11.00, '2 Days', true),
  ('AT', 'Kokoo', 'Kokoo 2GB', '2GB', 15.00, '4 Days', true),
  ('AT', 'Kokoo', 'Kokoo 2.5GB', '2.5GB', 20.00, '5 Days', true),
  ('AT', 'Kokoo', 'Kokoo 6.1GB', '6.1GB', 50.00, '15 Days', true),
  ('AT', 'Voice + Data', '26mins + 40MB', '40MB', 2.00, 'Flexible', true),
  ('AT', 'Voice + Data', '66mins + 120MB', '120MB', 5.00, 'Flexible', true),
  ('AT', 'Voice + Data', '138mins + 260MB', '260MB', 10.00, 'Flexible', true),
  ('AT', 'Voice + Data', '210mins + 400MB', '400MB', 15.00, 'Flexible', true),
  ('AT', 'Voice + Data', '280mins + 500MB', '500MB', 20.00, 'Flexible', true),
  ('AT', 'Voice + Data', '450mins + 1GB', '1GB', 30.00, 'Flexible', true),
  ('AT', 'Voice + Data', '600mins + 2.4GB', '2.4GB', 50.00, 'Flexible', true)
on conflict (network, category, name, volume, price, validity) do update
set is_active = excluded.is_active;
