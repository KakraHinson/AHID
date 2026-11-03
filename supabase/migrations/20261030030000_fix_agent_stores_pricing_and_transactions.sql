-- ============================================================================
-- Migration: Fix Agent Stores, Pricing, Transactions & Withdrawals Schema
-- Resolves: Missing transactions table, agent_pricing RLS, views for
--           withdrawals and stores, and full persistence integrity.
-- ============================================================================

-- 1. TRANSACTIONS TABLE
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references auth.users(id) on delete cascade,
  agent_code text,
  reference text unique,
  type text not null default 'transaction',
  description text,
  amount numeric(12,2) not null default 0.00,
  balance_before numeric(12,2) default 0.00,
  balance_after numeric(12,2) default 0.00,
  status text not null default 'success',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.transactions
  add column if not exists agent_id uuid references auth.users(id) on delete cascade,
  add column if not exists agent_code text,
  add column if not exists reference text unique,
  add column if not exists type text not null default 'transaction',
  add column if not exists description text,
  add column if not exists amount numeric(12,2) not null default 0.00,
  add column if not exists balance_before numeric(12,2) default 0.00,
  add column if not exists balance_after numeric(12,2) default 0.00,
  add column if not exists status text not null default 'success',
  add column if not exists metadata jsonb default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_transactions_agent_id on public.transactions(agent_id);
create index if not exists idx_transactions_agent_code on public.transactions(agent_code);
create index if not exists idx_transactions_reference on public.transactions(reference);
create index if not exists idx_transactions_created_at on public.transactions(created_at desc);

alter table public.transactions enable row level security;

drop policy if exists "Agents can view own transactions" on public.transactions;
create policy "Agents can view own transactions"
  on public.transactions for select
  to authenticated
  using (
    auth.uid() = agent_id 
    or agent_code in (select agent_code from public.agents where id = auth.uid())
    or public.is_admin()
  );

drop policy if exists "Agents can insert own transactions" on public.transactions;
create policy "Agents can insert own transactions"
  on public.transactions for insert
  to authenticated
  with check (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Admins can manage transactions" on public.transactions;
create policy "Admins can manage transactions"
  on public.transactions for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 2. AGENT PRICING TABLE & RLS
create table if not exists public.agent_pricing (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  pricing_key text not null,
  price numeric(12,2) not null check (price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, pricing_key)
);

create index if not exists agent_pricing_agent_idx on public.agent_pricing(agent_id);
create index if not exists agent_pricing_key_idx on public.agent_pricing(pricing_key);

alter table public.agent_pricing enable row level security;

drop policy if exists "Public can read agent pricing" on public.agent_pricing;
create policy "Public can read agent pricing"
  on public.agent_pricing for select
  to anon, authenticated
  using (true);

drop policy if exists "Agents can view their own custom pricing" on public.agent_pricing;
create policy "Agents can view their own custom pricing"
  on public.agent_pricing for select
  to authenticated
  using (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can insert their own custom pricing" on public.agent_pricing;
create policy "Agents can insert their own custom pricing"
  on public.agent_pricing for insert
  to authenticated
  with check (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can update their own custom pricing" on public.agent_pricing;
create policy "Agents can update their own custom pricing"
  on public.agent_pricing for update
  to authenticated
  using (auth.uid() = agent_id or public.is_admin())
  with check (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can delete their own custom pricing" on public.agent_pricing;
create policy "Agents can delete their own custom pricing"
  on public.agent_pricing for delete
  to authenticated
  using (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Admins can manage agent_pricing" on public.agent_pricing;
create policy "Admins can manage agent_pricing"
  on public.agent_pricing for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 3. AGENT STORES TABLE & STORES VIEW
create table if not exists public.agent_stores (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null unique references public.agents(id) on delete cascade,
  slug text not null unique,
  display_name text not null,
  tagline text,
  description text,
  whatsapp text,
  contact_phone text,
  logo_url text,
  brand_color text not null default '#2563eb',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agent_stores
  add column if not exists tagline text,
  add column if not exists description text,
  add column if not exists whatsapp text,
  add column if not exists contact_phone text,
  add column if not exists logo_url text,
  add column if not exists brand_color text not null default '#2563eb',
  add column if not exists is_active boolean not null default true;

create or replace view public.stores as
select
  id,
  agent_id,
  slug,
  display_name,
  tagline,
  description,
  whatsapp,
  contact_phone,
  logo_url,
  brand_color,
  is_active,
  created_at,
  updated_at
from public.agent_stores;

grant select on public.stores to anon, authenticated;

alter table public.agent_stores enable row level security;

drop policy if exists "Public can read active agent stores" on public.agent_stores;
create policy "Public can read active agent stores"
  on public.agent_stores for select
  to anon, authenticated
  using (is_active = true or auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can manage own store" on public.agent_stores;
create policy "Agents can manage own store"
  on public.agent_stores for all
  to authenticated
  using (auth.uid() = agent_id or public.is_admin())
  with check (auth.uid() = agent_id or public.is_admin());

-- 4. AGENT PAYOUTS & WITHDRAWALS VIEW
create table if not exists public.agent_payouts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'requested',
  method text default 'momo',
  account_snapshot jsonb,
  reference text unique,
  admin_note text,
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure columns exist if agent_payouts was created by an earlier migration without them
alter table public.agent_payouts
  add column if not exists status text not null default 'requested',
  add column if not exists method text default 'momo',
  add column if not exists account_snapshot jsonb,
  add column if not exists reference text,
  add column if not exists admin_note text,
  add column if not exists requested_at timestamptz not null default now(),
  add column if not exists reviewed_at timestamptz,
  add column if not exists paid_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create or replace view public.withdrawals as
select
  id,
  agent_id,
  amount,
  status,
  method,
  reference,
  admin_note,
  requested_at,
  paid_at,
  created_at,
  updated_at
from public.agent_payouts;

grant select on public.withdrawals to anon, authenticated;

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
  using (auth.uid() = agent_id or public.is_admin())
  with check (auth.uid() = agent_id or public.is_admin());

alter table public.agent_payouts enable row level security;

drop policy if exists "Agents can read their own payouts" on public.agent_payouts;
create policy "Agents can read their own payouts"
  on public.agent_payouts for select
  to authenticated
  using (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can insert own payouts" on public.agent_payouts;
create policy "Agents can insert own payouts"
  on public.agent_payouts for insert
  to authenticated
  with check (auth.uid() = agent_id or public.is_admin());

-- 5. STORE PRODUCTS & STORE ORDERS RLS
create table if not exists public.store_products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.agent_stores(id) on delete cascade,
  product_type text not null default 'data_bundle',
  product_ref text not null,
  price numeric(12,2) not null check (price >= 0),
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, product_type, product_ref)
);

alter table public.store_products enable row level security;

drop policy if exists "Public can read active store products" on public.store_products;
create policy "Public can read active store products"
  on public.store_products for select
  to anon, authenticated
  using (
    is_enabled
    and exists (
      select 1 from public.agent_stores s
      where s.id = store_id and (s.is_active or s.agent_id = auth.uid() or public.is_admin())
    )
  );

drop policy if exists "Agents manage their own store products" on public.store_products;
create policy "Agents manage their own store products"
  on public.store_products for all
  to authenticated
  using (
    exists (
      select 1 from public.agent_stores s
      where s.id = store_id and (s.agent_id = auth.uid() or public.is_admin())
    )
  )
  with check (
    exists (
      select 1 from public.agent_stores s
      where s.id = store_id and (s.agent_id = auth.uid() or public.is_admin())
    )
  );
