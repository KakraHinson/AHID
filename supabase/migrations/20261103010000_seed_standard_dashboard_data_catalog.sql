-- Standard Data Bundle catalogue used by the agent dashboard.
--
-- This is deliberately separate from instant_data_bundles. The dashboard sells
-- the whole-GB catalogue below through the existing Swift/GrandTech fulfilment
-- path; Instant Data is the Hubtel catalogue in its own table.

create table if not exists public.bundle_catalog (
  bundle_id text primary key,
  network text not null check (network in ('mtn', 'telecel', 'airteltigo')),
  title text not null,
  validity text,
  volume_mb integer not null check (volume_mb > 0),
  price numeric(12,2) not null check (price > 0),
  provider_package_id text,
  provider_cost numeric(12,2),
  active boolean not null default true,
  inactive_reason text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bundle_catalog_active_idx
  on public.bundle_catalog (network, sort_order)
  where active;

alter table public.bundle_catalog enable row level security;

drop policy if exists "Public can read active data bundles" on public.bundle_catalog;
create policy "Public can read active data bundles"
  on public.bundle_catalog for select
  to anon, authenticated
  using (active);

revoke insert, update, delete on public.bundle_catalog from anon, authenticated;
grant select on public.bundle_catalog to anon, authenticated, service_role;

-- These are the exact whole-GB packages rendered on the agent dashboard.
insert into public.bundle_catalog
  (bundle_id, network, title, validity, volume_mb, price, active, inactive_reason, sort_order)
values
  ('mtn-1gb',  'mtn',        '1 GB',          null,  1024,  4.30, true, null,   0),
  ('mtn-2gb',  'mtn',        '2 GB',          null,  2048,  8.80, true, null,   1),
  ('mtn-3gb',  'mtn',        '3 GB',          null,  3072, 13.20, true, null,   2),
  ('mtn-4gb',  'mtn',        '4 GB',          null,  4096, 17.60, true, null,   3),
  ('mtn-5gb',  'mtn',        '5 GB',          null,  5120, 22.00, true, null,   4),
  ('mtn-6gb',  'mtn',        '6 GB',          null,  6144, 26.10, true, null,   5),
  ('mtn-8gb',  'mtn',        '8 GB',          null,  8192, 34.80, true, null,   6),
  ('mtn-10gb', 'mtn',        '10 GB',         null, 10240, 42.00, true, null,   7),
  ('mtn-15gb', 'mtn',        '15 GB',         null, 15360, 63.00, true, null,   8),
  ('mtn-20gb', 'mtn',        '20 GB',         null, 20480, 84.00, true, null,   9),
  ('mtn-25gb', 'mtn',        '25 GB',         null, 25600,103.75, true, null,  10),
  ('mtn-30gb', 'mtn',        '30 GB',         null, 30720,121.50, true, null,  11),
  ('mtn-40gb', 'mtn',        '40 GB',         null, 40960,160.00, true, null,  12),
  ('mtn-50gb', 'mtn',        '50 GB',         null, 51200,200.00, true, null,  13),
  ('telecel-5gb',  'telecel', '5 GB',         null,  5120, 21.00, true, null, 100),
  ('telecel-10gb', 'telecel', '10 GB',        null, 10240, 40.00, true, null, 101),
  ('telecel-15gb', 'telecel', '15 GB',        null, 15360, 60.00, true, null, 102),
  ('telecel-20gb', 'telecel', '20 GB',        null, 20480, 78.00, true, null, 103),
  ('telecel-30gb', 'telecel', '30 GB',        null, 30720,114.00, true, null, 104),
  ('telecel-40gb', 'telecel', '40 GB',        null, 40960,151.00, true, null, 105),
  ('telecel-50gb', 'telecel', '50 GB',        null, 51200,185.00, true, null, 106),
  ('airteltigo-1gb',  'airteltigo', '1 GB',          null, 1024,  4.20, true, null, 200),
  ('airteltigo-2gb',  'airteltigo', '2 GB',          null, 2048,  8.39, true, null, 201),
  ('airteltigo-3gb',  'airteltigo', '3 GB',          null, 3072, 12.58, true, null, 202),
  ('airteltigo-4gb',  'airteltigo', '4 GB',          null, 4096, 16.78, true, null, 203),
  ('airteltigo-5gb',  'airteltigo', '5 GB',          null, 5120, 20.97, true, null, 204),
  ('airteltigo-6gb',  'airteltigo', '6 GB',          null, 6144, 25.17, true, null, 205),
  ('airteltigo-7gb',  'airteltigo', '7 GB',          null, 7168, 29.36, true, null, 206),
  ('airteltigo-8gb',  'airteltigo', '8 GB',          null, 8192, 33.56, true, null, 207),
  ('airteltigo-10gb', 'airteltigo', '10 GB',         null,10240, 40.84, true, null, 208),
  ('airteltigo-15gb', 'airteltigo', '15 GB BigTime', null,15360, 60.71, true, null, 209)
on conflict (bundle_id) do update set
  network = excluded.network,
  title = excluded.title,
  validity = excluded.validity,
  volume_mb = excluded.volume_mb,
  price = excluded.price,
  active = true,
  inactive_reason = null,
  sort_order = excluded.sort_order,
  updated_at = now();

-- Remove old small-MB/placeholder rows from the Standard Data storefront. They
-- must not be mistaken for the separate Hubtel Instant Data catalogue.
update public.bundle_catalog
set active = false,
    inactive_reason = 'Not part of the agent dashboard whole-GB catalogue.',
    updated_at = now()
where bundle_id not in (
  'mtn-1gb','mtn-2gb','mtn-3gb','mtn-4gb','mtn-5gb','mtn-6gb','mtn-8gb',
  'mtn-10gb','mtn-15gb','mtn-20gb','mtn-25gb','mtn-30gb','mtn-40gb','mtn-50gb',
  'telecel-5gb','telecel-10gb','telecel-15gb','telecel-20gb','telecel-30gb',
  'telecel-40gb','telecel-50gb','airteltigo-1gb','airteltigo-2gb',
  'airteltigo-3gb','airteltigo-4gb','airteltigo-5gb','airteltigo-6gb',
  'airteltigo-7gb','airteltigo-8gb','airteltigo-10gb','airteltigo-15gb'
)
and active;
