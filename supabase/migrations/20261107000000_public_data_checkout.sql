-- Anonymous Standard Data checkout and separate non-agent price controls.
-- The agent dashboard remains backed by bundle_catalog. A NULL override means
-- non-agent checkout follows that same live agent price automatically.

create table if not exists public.non_agent_data_prices (
  bundle_id text primary key references public.bundle_catalog(bundle_id) on delete cascade,
  price_override numeric(12,2),
  active boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint non_agent_data_prices_override_check
    check (price_override is null or price_override > 0)
);

create index if not exists non_agent_data_prices_active_idx
  on public.non_agent_data_prices(active);

alter table public.non_agent_data_prices enable row level security;

drop policy if exists "Admins can read non-agent data prices" on public.non_agent_data_prices;
create policy "Admins can read non-agent data prices"
  on public.non_agent_data_prices for select to authenticated
  using (public.is_admin());

-- Keep one control row for every current dashboard bundle. The override stays
-- NULL so new non-agent buyers initially see the exact dashboard price.
insert into public.non_agent_data_prices (bundle_id)
select bundle_id from public.bundle_catalog
on conflict (bundle_id) do nothing;

alter table public.public_data_orders
  add column if not exists public_access_token text,
  add column if not exists payment_provider text not null default 'paystack';

create unique index if not exists public_data_orders_access_token_idx
  on public.public_data_orders(public_access_token)
  where public_access_token is not null;

-- Claiming is atomic, so a Paystack webhook and the browser's verification call
-- cannot dispatch the same paid public order twice.
create or replace function public.claim_public_data_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
begin
  update public.public_data_orders
     set status = 'processing'
   where id = p_order_id
     and status = 'pending_payment'
   returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_public_data_order(uuid) from public, anon, authenticated;
