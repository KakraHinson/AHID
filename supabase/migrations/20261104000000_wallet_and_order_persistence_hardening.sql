-- Additive persistence hardening for wallet, Standard Data, and store orders.
-- Historical Instant Data tables are intentionally left untouched; they are no
-- longer part of the product surface, but old records must remain recoverable.

create table if not exists public.wallets (
  id uuid primary key references auth.users(id) on delete cascade,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wallets
  add column if not exists sales numeric(12,2) not null default 0,
  add column if not exists deposits numeric(12,2) not null default 0,
  add column if not exists overdraft numeric(12,2) not null default 0,
  add column if not exists commission_balance numeric(12,2) not null default 0,
  add column if not exists withdrawn_commission numeric(12,2) not null default 0,
  add column if not exists transferred_commission numeric(12,2) not null default 0,
  add column if not exists total_commission_earned numeric(12,2) not null default 0,
  add column if not exists store_sales numeric(12,2) not null default 0;

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references auth.users(id) on delete cascade,
  reference text not null unique,
  type text not null check (type in ('debit', 'credit')),
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  balance_after numeric(12,2) not null,
  status text not null default 'settled' check (status in ('settled', 'refunded', 'reversed')),
  reversed_transaction_id uuid references public.wallet_transactions(id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.wallet_transactions
  add column if not exists status text not null default 'settled',
  add column if not exists reversed_transaction_id uuid references public.wallet_transactions(id) on delete set null,
  add column if not exists meta jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

create index if not exists wallet_transactions_agent_created_idx
  on public.wallet_transactions(agent_id, created_at desc);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references auth.users(id) on delete cascade,
  agent_code text,
  reference text,
  type text not null default 'transaction',
  description text,
  amount numeric(12,2) not null default 0,
  balance_before numeric(12,2) default 0,
  balance_after numeric(12,2) default 0,
  status text not null default 'success',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.transactions
  add column if not exists agent_id uuid references auth.users(id) on delete cascade,
  add column if not exists agent_code text,
  add column if not exists reference text,
  add column if not exists type text not null default 'transaction',
  add column if not exists description text,
  add column if not exists amount numeric(12,2) not null default 0,
  add column if not exists balance_before numeric(12,2) default 0,
  add column if not exists balance_after numeric(12,2) default 0,
  add column if not exists status text not null default 'success',
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists transactions_agent_created_idx
  on public.transactions(agent_id, created_at desc);
create index if not exists transactions_reference_idx
  on public.transactions(reference);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references auth.users(id) on delete cascade,
  agent_code text,
  network text,
  bundle_size text,
  recipient_phone text,
  amount numeric(12,2) not null default 0,
  commission_amount numeric(12,2) not null default 0,
  reference text,
  status text not null default 'completed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders
  add column if not exists agent_id uuid references auth.users(id) on delete cascade,
  add column if not exists agent_code text,
  add column if not exists network text,
  add column if not exists bundle_size text,
  add column if not exists recipient_phone text,
  add column if not exists amount numeric(12,2) not null default 0,
  add column if not exists commission_amount numeric(12,2) not null default 0,
  add column if not exists reference text,
  add column if not exists status text not null default 'completed',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists orders_agent_created_idx on public.orders(agent_id, created_at desc);
create index if not exists orders_reference_idx on public.orders(reference);

create table if not exists public.commissions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid,
  reference text not null unique,
  amount numeric(12,2) not null default 0 check (amount >= 0),
  rate numeric(7,4),
  source text not null default 'Store Sales',
  status text not null default 'earned',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists commissions_agent_created_idx on public.commissions(agent_id, created_at desc);

create table if not exists public.agent_data_orders (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references auth.users(id) on delete cascade,
  provider_reference text not null unique,
  short_code text,
  network_type text not null,
  phone text not null,
  volume_mb integer not null check (volume_mb > 0),
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'processing',
  provider_name text,
  provider_order_id text,
  provider_response jsonb,
  failure_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.agent_data_orders
  add column if not exists short_code text,
  add column if not exists provider_name text,
  add column if not exists provider_order_id text,
  add column if not exists failure_reason text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists agent_data_orders_agent_created_idx
  on public.agent_data_orders(agent_id, created_at desc);
create index if not exists agent_data_orders_status_idx
  on public.agent_data_orders(status, created_at desc);

create table if not exists public.public_data_orders (
  id uuid primary key default gen_random_uuid(),
  payment_reference text not null unique,
  short_code text,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  agent_id uuid references auth.users(id) on delete set null,
  network_type text not null,
  volume_mb integer not null check (volume_mb > 0),
  sale_amount numeric(12,2) not null check (sale_amount > 0),
  provider_amount numeric(12,2),
  status text not null default 'pending_payment',
  provider_name text,
  provider_package_id text,
  provider_reference text unique,
  provider_response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.public_data_orders
  add column if not exists short_code text,
  add column if not exists agent_id uuid references auth.users(id) on delete set null,
  add column if not exists provider_name text,
  add column if not exists provider_package_id text,
  add column if not exists provider_reference text,
  add column if not exists provider_response jsonb,
  add column if not exists completed_at timestamptz;

create index if not exists public_data_orders_agent_created_idx
  on public.public_data_orders(agent_id, created_at desc);
create index if not exists public_data_orders_status_idx
  on public.public_data_orders(status, created_at desc);

alter table public.wallet_topups
  add column if not exists fee_amount numeric(12,2) not null default 0,
  add column if not exists gross_amount numeric(12,2);

alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.transactions enable row level security;
alter table public.orders enable row level security;
alter table public.commissions enable row level security;
alter table public.agent_data_orders enable row level security;
alter table public.public_data_orders enable row level security;

drop policy if exists "Agents can view own wallet transactions" on public.wallet_transactions;
create policy "Agents can view own wallet transactions"
  on public.wallet_transactions for select to authenticated
  using (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can view own transactions" on public.transactions;
create policy "Agents can view own transactions"
  on public.transactions for select to authenticated
  using (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can insert own transactions" on public.transactions;
create policy "Agents can insert own transactions"
  on public.transactions for insert to authenticated
  with check (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can view own orders" on public.orders;
create policy "Agents can view own orders"
  on public.orders for select to authenticated
  using (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can view own commissions" on public.commissions;
create policy "Agents can view own commissions"
  on public.commissions for select to authenticated
  using (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can view their own data orders" on public.agent_data_orders;
create policy "Agents can view their own data orders"
  on public.agent_data_orders for select to authenticated
  using (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can view their own public data orders" on public.public_data_orders;
create policy "Agents can view their own public data orders"
  on public.public_data_orders for select to authenticated
  using (auth.uid() = agent_id or public.is_admin());

create or replace function public.get_wallet_dashboard_stats(p_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_deposits numeric(12,2) := 0;
  v_ledger_sales numeric(12,2) := 0;
  v_legacy_sales numeric(12,2) := 0;
  v_sales numeric(12,2) := 0;
  v_store_sales numeric(12,2) := 0;
begin
  if p_agent_id is null then raise exception 'Agent ID is required'; end if;
  if auth.uid() is not null and auth.uid() <> p_agent_id and not public.is_admin() then
    raise exception 'Not authorized to view this wallet';
  end if;

  insert into public.wallets (id) values (p_agent_id) on conflict (id) do nothing;
  select * into v_wallet from public.wallets where id = p_agent_id for update;

  select coalesce(sum(amount), 0) into v_deposits
  from public.wallet_topups where agent_id = p_agent_id and status = 'paid';

  select coalesce(sum(amount), 0) into v_ledger_sales
  from public.wallet_transactions
  where agent_id = p_agent_id and type = 'debit' and status = 'settled';

  select coalesce(sum(amount), 0) into v_legacy_sales
  from public.orders
  where agent_id = p_agent_id and status in ('completed', 'success', 'paid');

  v_sales := greatest(v_ledger_sales, v_legacy_sales);

  select coalesce(sum(sale_amount), 0) into v_store_sales
  from public.store_orders
  where agent_id = p_agent_id
    and payment_status = 'paid'
    and fulfilment_status <> 'failed';

  update public.wallets set
    deposits = greatest(coalesce(deposits, 0), v_deposits),
    sales = greatest(coalesce(sales, 0), v_sales),
    store_sales = greatest(coalesce(store_sales, 0), v_store_sales),
    updated_at = now()
  where id = p_agent_id
  returning * into v_wallet;

  return jsonb_build_object(
    'balance', coalesce(v_wallet.balance, 0),
    'sales', coalesce(v_wallet.sales, 0),
    'deposits', coalesce(v_wallet.deposits, 0),
    'overdraft', coalesce(v_wallet.overdraft, 0),
    'commission_balance', coalesce(v_wallet.commission_balance, 0),
    'withdrawn_commission', coalesce(v_wallet.withdrawn_commission, 0),
    'transferred_commission', coalesce(v_wallet.transferred_commission, 0),
    'total_commission_earned', coalesce(v_wallet.total_commission_earned, 0),
    'store_sales', coalesce(v_wallet.store_sales, 0)
  );
end;
$$;

grant execute on function public.get_wallet_dashboard_stats(uuid) to authenticated, service_role;

comment on table public.agent_data_orders is
  'Durable Standard Data Bundle orders from the agent dashboard; Instant Data is not part of this table.';
