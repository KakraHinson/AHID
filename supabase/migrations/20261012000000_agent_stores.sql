-- ============================================================================
-- Migration: Multi-agent stores (Milestone 1 — schema, RLS, security fixes)
-- Created: 2026-10-12
--
-- Adds the storefront domain model on top of the existing agent/agent_pricing
-- system. Model: a store is a projection of an existing verified agent. Orders
-- are wallet-funded: a customer order debits the OWNER agent's prepaid wallet
-- (see Milestone 2 edge functions) and the store is gated on that balance.
--
-- This migration is additive. It does NOT touch any payment or provider
-- function, and reuses the existing wallets / wallet_transactions ledger.
-- Keeping store sales accounting separate from prepaid credit is done at the
-- edge-function level; the ledger already distinguishes each entry by reference.
--
-- It also closes three pre-existing RLS gaps found during the audit:
--   1. results_orders had RLS disabled entirely (customer PII + PINs exposed).
--   2. airtime_orders allowed world SELECT and unrestricted INSERT.
--   3. agents.role could be self-escalated from 'agent' to 'admin'.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Shared helper: is the caller an administrator?
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the check does not recurse through the agents RLS
-- policies when it is evaluated inside another table's policy.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.agents
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. agent_stores — one storefront per agent
-- ---------------------------------------------------------------------------
create table if not exists public.agent_stores (
  id uuid primary key default gen_random_uuid(),
  -- One store per agent; the agent row is the owner identity.
  agent_id uuid not null unique references public.agents(id) on delete cascade,
  -- Immutable-ish public handle used in the shareable link (?ref=<slug>).
  slug text not null unique
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  display_name text not null check (char_length(display_name) between 1 and 80),
  description text check (description is null or char_length(description) <= 500),
  logo_url text,
  brand_color text not null default '#2563eb',
  tagline text,
  whatsapp text,
  contact_phone text,
  -- Owner may pause their own store; admin suspension also clears this and
  -- records a reason, which the checkout function re-checks.
  is_active boolean not null default true,
  suspended_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_stores_active_idx
  on public.agent_stores (is_active)
  where is_active;

alter table public.agent_stores enable row level security;

-- Public storefront renders before anyone signs in, so active stores are
-- world-readable. Inactive/suspended stores are excluded from the API entirely.
drop policy if exists "Public can read active stores" on public.agent_stores;
create policy "Public can read active stores"
  on public.agent_stores for select
  to anon, authenticated
  using (is_active);

drop policy if exists "Agents can read their own store" on public.agent_stores;
create policy "Agents can read their own store"
  on public.agent_stores for select
  to authenticated
  using (auth.uid() = agent_id);

drop policy if exists "Admins can read all stores" on public.agent_stores;
create policy "Admins can read all stores"
  on public.agent_stores for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Agents can create their own store" on public.agent_stores;
create policy "Agents can create their own store"
  on public.agent_stores for insert
  to authenticated
  with check (auth.uid() = agent_id);

drop policy if exists "Agents can update their own store" on public.agent_stores;
create policy "Agents can update their own store"
  on public.agent_stores for update
  to authenticated
  using (auth.uid() = agent_id)
  with check (auth.uid() = agent_id);

drop policy if exists "Admins can update stores" on public.agent_stores;
create policy "Admins can update stores"
  on public.agent_stores for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 3. store_products — which products a store offers, at what price
-- ---------------------------------------------------------------------------
-- product_type/product_ref point at the existing catalogs (bundle_catalog,
-- bundles, service_pricing, utility bill types) rather than duplicating them.
create table if not exists public.store_products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.agent_stores(id) on delete cascade,
  product_type text not null
    check (product_type in ('data_bundle', 'instant_data', 'airtime', 'utility', 'results', 'afa')),
  -- bundle_id / bill_type / network / service key, depending on product_type.
  product_ref text not null,
  price numeric(12,2) not null check (price > 0),
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, product_type, product_ref)
);

create index if not exists store_products_store_idx
  on public.store_products (store_id, product_type);

alter table public.store_products enable row level security;

drop policy if exists "Public can read enabled products of active stores" on public.store_products;
create policy "Public can read enabled products of active stores"
  on public.store_products for select
  to anon, authenticated
  using (
    is_enabled
    and exists (
      select 1 from public.agent_stores s
      where s.id = store_id and s.is_active
    )
  );

drop policy if exists "Agents manage their own store products" on public.store_products;
create policy "Agents manage their own store products"
  on public.store_products for all
  to authenticated
  using (
    exists (
      select 1 from public.agent_stores s
      where s.id = store_id and s.agent_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.agent_stores s
      where s.id = store_id and s.agent_id = auth.uid()
    )
  );

drop policy if exists "Admins manage all store products" on public.store_products;
create policy "Admins manage all store products"
  on public.store_products for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke insert, update, delete on public.store_products from anon;

-- ---------------------------------------------------------------------------
-- 4. store_orders — one row per customer purchase through a store
-- ---------------------------------------------------------------------------
-- The financial breakdown is deliberately explicit so the backend can compute
-- (and later re-derive) every component without trusting the frontend:
--   sale_amount     = what the customer pays the agent (agent's selling price)
--   platform_price  = what Skaitech debits the agent wallet for this order
--   provider_cost   = what the upstream provider charges Skaitech
--   payment_fee     = any processing fee attached to the order
--   agent_earning   = sale_amount - platform_price
--   platform_revenue= platform_price - provider_cost - payment_fee
-- The exact formula is applied in the Milestone 2 checkout function; the
-- columns exist now so no follow-up migration is needed.
create table if not exists public.store_orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.agent_stores(id) on delete restrict,
  agent_id uuid not null references public.agents(id) on delete restrict,
  reference text not null unique,
  short_code text unique,
  idempotency_key text,
  product_type text not null
    check (product_type in ('data_bundle', 'instant_data', 'airtime', 'utility', 'results', 'afa')),
  product_ref text,
  product_label text,
  network text,
  -- Destination: phone / meter / account / smartcard number.
  recipient text,
  customer_name text,
  customer_phone text,
  customer_email text,
  quantity integer not null default 1 check (quantity > 0),
  sale_amount numeric(12,2) not null default 0 check (sale_amount >= 0),
  platform_price numeric(12,2) not null default 0,
  provider_cost numeric(12,2) not null default 0,
  payment_fee numeric(12,2) not null default 0,
  agent_earning numeric(12,2) not null default 0,
  platform_revenue numeric(12,2) not null default 0,
  refund_amount numeric(12,2) not null default 0,
  wallet_debited boolean not null default false,
  payment_status text not null default 'pending'
    check (payment_status in ('pending', 'paid', 'failed', 'refunded')),
  fulfilment_status text not null default 'pending'
    check (fulfilment_status in ('pending', 'processing', 'successful', 'failed', 'cancelled')),
  provider text,
  provider_reference text,
  provider_response jsonb,
  failure_reason text,
  meta jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists store_orders_agent_created_idx
  on public.store_orders (agent_id, created_at desc);
create index if not exists store_orders_store_created_idx
  on public.store_orders (store_id, created_at desc);
create index if not exists store_orders_provider_reference_idx
  on public.store_orders (provider_reference)
  where provider_reference is not null;
-- Idempotency: the same client submission can never create two orders.
create unique index if not exists store_orders_idempotency_uidx
  on public.store_orders (agent_id, idempotency_key)
  where idempotency_key is not null;

alter table public.store_orders enable row level security;

drop policy if exists "Agents can read their own store orders" on public.store_orders;
create policy "Agents can read their own store orders"
  on public.store_orders for select
  to authenticated
  using (auth.uid() = agent_id);

drop policy if exists "Admins can read all store orders" on public.store_orders;
create policy "Admins can read all store orders"
  on public.store_orders for select
  to authenticated
  using (public.is_admin());

-- Customers never read this table directly; they track an order through the
-- service-role edge function by its reference. All writes are service-role only.
revoke insert, update, delete on public.store_orders from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Payout accounts & payout requests (capture now, execute later)
-- ---------------------------------------------------------------------------
create table if not exists public.agent_payout_accounts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null unique references public.agents(id) on delete cascade,
  method text not null default 'momo' check (method in ('momo', 'bank')),
  account_name text not null,
  account_number text not null,
  bank_name text,
  momo_network text,
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agent_payout_accounts enable row level security;

drop policy if exists "Agents manage their own payout account" on public.agent_payout_accounts;
create policy "Agents manage their own payout account"
  on public.agent_payout_accounts for all
  to authenticated
  using (auth.uid() = agent_id)
  with check (auth.uid() = agent_id);

drop policy if exists "Admins read all payout accounts" on public.agent_payout_accounts;
create policy "Admins read all payout accounts"
  on public.agent_payout_accounts for select
  to authenticated
  using (public.is_admin());

revoke all on public.agent_payout_accounts from anon;

create table if not exists public.agent_payouts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'processing', 'paid', 'rejected', 'failed')),
  method text,
  -- Snapshot of the payout destination at request time, so later edits to the
  -- account do not rewrite history.
  account_snapshot jsonb,
  reference text unique,
  admin_note text,
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz
);

create index if not exists agent_payouts_agent_idx
  on public.agent_payouts (agent_id, requested_at desc);
create index if not exists agent_payouts_status_idx
  on public.agent_payouts (status)
  where status in ('requested', 'approved', 'processing');

alter table public.agent_payouts enable row level security;

drop policy if exists "Agents can read their own payouts" on public.agent_payouts;
create policy "Agents can read their own payouts"
  on public.agent_payouts for select
  to authenticated
  using (auth.uid() = agent_id);

-- Agents may request a payout; amount is validated server-side in Milestone 2.
drop policy if exists "Agents can request their own payouts" on public.agent_payouts;
create policy "Agents can request their own payouts"
  on public.agent_payouts for insert
  to authenticated
  with check (auth.uid() = agent_id);

drop policy if exists "Admins manage all payouts" on public.agent_payouts;
create policy "Admins manage all payouts"
  on public.agent_payouts for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke update, delete on public.agent_payouts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Platform settings & per-product pricing rules (admin controlled)
-- ---------------------------------------------------------------------------
-- Single-row settings table (id pinned to 1).
create table if not exists public.platform_settings (
  id integer primary key default 1 check (id = 1),
  platform_fee_percent numeric(5,2) not null default 0
    check (platform_fee_percent between 0 and 100),
  allow_custom_pricing boolean not null default true,
  -- Store is blocked at checkout when the owner wallet cannot cover this.
  store_wallet_gate_enabled boolean not null default true,
  min_margin_percent numeric(5,2) not null default 0
    check (min_margin_percent between 0 and 100),
  max_markup_percent numeric(6,2) not null default 100 check (max_markup_percent >= 0),
  updated_at timestamptz not null default now()
);

insert into public.platform_settings (id) values (1) on conflict (id) do nothing;

alter table public.platform_settings enable row level security;

drop policy if exists "Public can read platform settings" on public.platform_settings;
create policy "Public can read platform settings"
  on public.platform_settings for select
  to anon, authenticated
  using (true);

revoke insert, update, delete on public.platform_settings from anon, authenticated;

-- Per-product rules: which products support custom pricing and the allowed
-- min/max selling price. product_ref '*' means "any product of this type".
create table if not exists public.product_pricing_rules (
  id uuid primary key default gen_random_uuid(),
  product_type text not null
    check (product_type in ('data_bundle', 'instant_data', 'airtime', 'utility', 'results', 'afa')),
  product_ref text not null default '*',
  custom_pricing_enabled boolean not null default true,
  min_price numeric(12,2) check (min_price is null or min_price >= 0),
  max_price numeric(12,2) check (max_price is null or max_price >= 0),
  updated_at timestamptz not null default now(),
  unique (product_type, product_ref),
  constraint product_pricing_rules_range_check
    check (min_price is null or max_price is null or min_price <= max_price)
);

alter table public.product_pricing_rules enable row level security;

drop policy if exists "Public can read pricing rules" on public.product_pricing_rules;
create policy "Public can read pricing rules"
  on public.product_pricing_rules for select
  to anon, authenticated
  using (true);

revoke insert, update, delete on public.product_pricing_rules from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. updated_at maintenance (reuse the shared touch function)
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'agent_stores', 'store_products', 'store_orders',
    'agent_payout_accounts', 'agent_payouts',
    'platform_settings', 'product_pricing_rules'
  ] loop
    execute format('drop trigger if exists %I_touch_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_touch_updated_at
         before update on public.%I
         for each row execute function public.touch_data_row_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Slug + store provisioning
-- ---------------------------------------------------------------------------
-- Slug is derived from the immutable agent_code so links are stable, then
-- de-duplicated with a numeric suffix on the rare collision.
create or replace function public.generate_store_slug(p_agent_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text;
  v_slug text;
  v_suffix integer := 0;
begin
  select nullif(trim(both '-' from regexp_replace(lower(coalesce(agent_code, '')), '[^a-z0-9]+', '-', 'g')), '')
    into v_base
  from public.agents where id = p_agent_id;

  v_base := coalesce(v_base, 'store-' || substr(replace(p_agent_id::text, '-', ''), 1, 8));
  v_base := substr(v_base, 1, 30);

  v_slug := v_base;
  loop
    exit when not exists (select 1 from public.agent_stores where slug = v_slug);
    v_suffix := v_suffix + 1;
    v_slug := substr(v_base, 1, 28) || '-' || v_suffix;
  end loop;
  return v_slug;
end;
$$;

-- Idempotently provisions a store for an agent. Safe to call repeatedly.
create or replace function public.ensure_agent_store(p_agent_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_name text;
  v_slug text;
begin
  select id into v_store_id from public.agent_stores where agent_id = p_agent_id;
  if v_store_id is not null then
    return v_store_id;
  end if;

  select nullif(trim(full_name), '') into v_name from public.agents where id = p_agent_id;
  v_name := coalesce(v_name || '''s Store', 'Skaitech Store');
  v_slug := public.generate_store_slug(p_agent_id);

  insert into public.agent_stores (agent_id, slug, display_name)
  values (p_agent_id, v_slug, substr(v_name, 1, 80))
  on conflict (agent_id) do nothing
  returning id into v_store_id;

  if v_store_id is null then
    select id into v_store_id from public.agent_stores where agent_id = p_agent_id;
  end if;
  return v_store_id;
end;
$$;

revoke all on function public.generate_store_slug(uuid) from public, anon, authenticated;
revoke all on function public.ensure_agent_store(uuid) from public, anon, authenticated;
grant execute on function public.ensure_agent_store(uuid) to service_role;

-- Every new agent gets a store automatically.
create or replace function public.agents_create_store()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_agent_store(new.id);
  return new;
end;
$$;

drop trigger if exists agents_create_store on public.agents;
create trigger agents_create_store
  after insert on public.agents
  for each row execute function public.agents_create_store();

-- Backfill stores for agents that already exist.
do $$
declare
  r record;
begin
  for r in select id from public.agents loop
    perform public.ensure_agent_store(r.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Security fix: agents must not self-escalate their role
-- ---------------------------------------------------------------------------
-- Mirrors prevent_agent_code_change: only the service role (used by admin edge
-- functions) may change an assigned role.
create or replace function public.prevent_agent_role_escalation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Agent role cannot be changed.';
  end if;
  return new;
end;
$$;

drop trigger if exists agents_role_immutable on public.agents;
create trigger agents_role_immutable
  before update of role on public.agents
  for each row execute function public.prevent_agent_role_escalation();

-- ---------------------------------------------------------------------------
-- 10. Security fix: results_orders had RLS disabled
-- ---------------------------------------------------------------------------
alter table public.results_orders enable row level security;

drop policy if exists "Agents can read their own results orders" on public.results_orders;
create policy "Agents can read their own results orders"
  on public.results_orders for select
  to authenticated
  using (agent_id = auth.uid());

drop policy if exists "Admins can read all results orders" on public.results_orders;
create policy "Admins can read all results orders"
  on public.results_orders for select
  to authenticated
  using (public.is_admin());

-- PINs and customer PII must only be reached through the service-role functions.
revoke insert, update, delete on public.results_orders from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. Security fix: airtime_orders was world-readable and world-insertable
-- ---------------------------------------------------------------------------
drop policy if exists "Allow reference lookup for airtime orders" on public.airtime_orders;
drop policy if exists "Allow insert airtime orders" on public.airtime_orders;

drop policy if exists "Admins can read all airtime orders" on public.airtime_orders;
create policy "Admins can read all airtime orders"
  on public.airtime_orders for select
  to authenticated
  using (public.is_admin());

revoke insert, update, delete on public.airtime_orders from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 12. Activity-log coverage for the new tables
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'agent_stores', 'store_products', 'store_orders',
    'agent_payout_accounts', 'agent_payouts',
    'platform_settings', 'product_pricing_rules'
  ] loop
    execute format('drop trigger if exists trg_activity_log_%s on public.%I', t, t);
    execute format(
      'create trigger trg_activity_log_%s
         after insert or update or delete on public.%I
         for each row execute function public.log_row_activity()', t, t);
  end loop;
end;
$$;
