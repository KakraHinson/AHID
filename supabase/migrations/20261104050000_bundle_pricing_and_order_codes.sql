-- ---------------------------------------------------------------------------
-- Standard Data pricing controls and durable five-character order codes
-- ---------------------------------------------------------------------------

-- bundle_catalog is the one source of truth for the selling price of the
-- whole-GB Standard Data packages shown in the agent dashboard. Keep an
-- append-only audit trail so every admin price change is recoverable.
create table if not exists public.bundle_price_history (
  id uuid primary key default gen_random_uuid(),
  bundle_id text not null references public.bundle_catalog(bundle_id) on delete cascade,
  previous_price numeric(12,2),
  new_price numeric(12,2) not null check (new_price > 0),
  changed_by uuid references auth.users(id) on delete set null,
  reason text not null default 'admin_price_update',
  changed_at timestamptz not null default now()
);

create index if not exists bundle_price_history_bundle_idx
  on public.bundle_price_history(bundle_id, changed_at desc);

alter table public.bundle_price_history enable row level security;

drop policy if exists "Admins can read bundle price history" on public.bundle_price_history;
create policy "Admins can read bundle price history"
  on public.bundle_price_history for select
  to authenticated
  using (public.is_admin());

revoke insert, update, delete on public.bundle_price_history from anon, authenticated;

drop policy if exists "Admins can read all data bundles" on public.bundle_catalog;
create policy "Admins can read all data bundles"
  on public.bundle_catalog for select
  to authenticated
  using (public.is_admin());

create or replace function public.record_bundle_price_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.price is distinct from new.price then
    insert into public.bundle_price_history (
      bundle_id, previous_price, new_price, changed_by, reason
    ) values (
      new.bundle_id, old.price, new.price, auth.uid(), 'admin_price_update'
    );
  end if;
  return new;
end;
$$;
revoke all on function public.record_bundle_price_change() from public, anon, authenticated;

drop trigger if exists bundle_catalog_price_history on public.bundle_catalog;
create trigger bundle_catalog_price_history
  after update of price on public.bundle_catalog
  for each row execute function public.record_bundle_price_change();

-- Existing store-wallet and legacy orders were created before the common
-- short-code defaults existed. Backfill them, then make future inserts use the
-- same five-character generator as the other order tables.
do $$
declare
  t text;
begin
  foreach t in array array['store_orders', 'orders'] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;

    execute format('alter table public.%I add column if not exists short_code text', t);
    execute format(
      'update public.%I
          set short_code = public.new_short_code(%L)
        where short_code is null or short_code !~ ''^[A-Z0-9]{5}$''',
      t, t
    );
    execute format(
      'alter table public.%I
         alter column short_code set default public.new_short_code(%L),
         alter column short_code set not null',
      t, t
    );
    execute format(
      'create unique index if not exists %I_short_code_idx on public.%I(short_code)',
      t, t
    );
  end loop;
end;
$$;

