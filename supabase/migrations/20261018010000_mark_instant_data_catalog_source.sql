-- Distinguish the supplied Instant Data catalog from the older GB placeholder
-- rows that belong to the dashboard Data Bundle product.
alter table public.bundles
  add column if not exists catalog_source text not null default 'legacy';

update public.bundles
set catalog_source = 'instant_data',
    updated_at = now()
where bundle_key ~ '^[a-z]+_[a-z]+_[0-9]+$';

create index if not exists bundles_catalog_source_idx
  on public.bundles (catalog_source, network_id, sort_order);
