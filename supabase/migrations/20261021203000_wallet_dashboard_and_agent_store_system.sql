-- ============================================================================
-- Migration: Full Wallet Dashboard, Transactions & Agent Store Ordering System
-- Resolves: 9 Dashboard Cards, Atomic Order Placement, Commission Handlers,
--           Paystack Inline Funding, and Unified Ledger
-- ============================================================================

-- 1. UPDATE WALLETS SCHEMA
alter table public.wallets
  add column if not exists sales numeric(12,2) not null default 0.00,
  add column if not exists deposits numeric(12,2) not null default 0.00,
  add column if not exists overdraft numeric(12,2) not null default 0.00,
  add column if not exists commission_balance numeric(12,2) not null default 0.00 check (commission_balance >= 0),
  add column if not exists withdrawn_commission numeric(12,2) not null default 0.00,
  add column if not exists transferred_commission numeric(12,2) not null default 0.00,
  add column if not exists total_commission_earned numeric(12,2) not null default 0.00,
  add column if not exists store_sales numeric(12,2) not null default 0.00;

-- 2. UPDATE TRANSACTIONS SCHEMA
alter table public.transactions
  add column if not exists agent_id uuid references auth.users(id) on delete cascade,
  add column if not exists metadata jsonb default '{}'::jsonb;

-- Backfill agent_id on transactions if possible
update public.transactions t
set agent_id = a.id
from public.agents a
where t.agent_id is null and t.agent_code is not null and t.agent_code = a.agent_code;

create index if not exists idx_transactions_agent_id on public.transactions(agent_id);
create index if not exists idx_transactions_created_at on public.transactions(created_at desc);

-- 3. COMMISSIONS SCHEMA
create table if not exists public.commissions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid,
  reference text not null unique,
  amount numeric(12,2) not null check (amount >= 0),
  rate numeric(6,4) default 0.05,
  source text not null default 'Store Sales',
  status text not null default 'earned',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_commissions_agent_id on public.commissions(agent_id);
create index if not exists idx_commissions_created_at on public.commissions(created_at desc);

-- 4. UPDATE ORDERS SCHEMA
alter table public.orders
  add column if not exists agent_id uuid references auth.users(id) on delete cascade,
  add column if not exists commission_amount numeric(12,2) not null default 0.00,
  add column if not exists reference text;

create index if not exists idx_orders_agent_id on public.orders(agent_id);
create index if not exists idx_orders_created_at on public.orders(created_at desc);

-- 5. ROW LEVEL SECURITY POLICIES
alter table public.wallets enable row level security;
alter table public.transactions enable row level security;
alter table public.commissions enable row level security;
alter table public.orders enable row level security;
alter table public.agent_payouts enable row level security;

-- Wallets
drop policy if exists "Agents can view own wallet" on public.wallets;
create policy "Agents can view own wallet"
  on public.wallets for select
  to authenticated
  using (auth.uid() = id or public.is_admin());

-- Transactions
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

-- Commissions
drop policy if exists "Agents can view own commissions" on public.commissions;
create policy "Agents can view own commissions"
  on public.commissions for select
  to authenticated
  using (auth.uid() = agent_id or public.is_admin());

-- Orders
drop policy if exists "Agents can view own orders" on public.orders;
create policy "Agents can view own orders"
  on public.orders for select
  to authenticated
  using (
    auth.uid() = agent_id 
    or agent_code in (select agent_code from public.agents where id = auth.uid())
    or public.is_admin()
  );

drop policy if exists "Agents can insert own orders" on public.orders;
create policy "Agents can insert own orders"
  on public.orders for insert
  to authenticated
  with check (auth.uid() = agent_id or public.is_admin());

-- Payouts
drop policy if exists "Agents can view own payouts" on public.agent_payouts;
create policy "Agents can view own payouts"
  on public.agent_payouts for select
  to authenticated
  using (auth.uid() = agent_id or public.is_admin());

drop policy if exists "Agents can insert own payouts" on public.agent_payouts;
create policy "Agents can insert own payouts"
  on public.agent_payouts for insert
  to authenticated
  with check (auth.uid() = agent_id);

-- 6. RPC: GET WALLET DASHBOARD STATS (Calculates all 9 cards)
create or replace function public.get_wallet_dashboard_stats(p_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_agent_code text;
  v_deposits numeric(12,2);
  v_sales numeric(12,2);
  v_store_sales numeric(12,2);
begin
  if p_agent_id is null then
    raise exception 'Agent ID is required';
  end if;

  -- Ensure parent profile and wallet records exist
  perform public.ensure_agent_profile(p_agent_id);

  select agent_code into v_agent_code from public.agents where id = p_agent_id;
  select * into v_wallet from public.wallets where id = p_agent_id;

  -- Calculate/reconcile cumulative deposits from wallet_topups and transactions
  select coalesce(sum(amount), 0) into v_deposits
  from public.wallet_topups
  where agent_id = p_agent_id and status = 'paid';

  if v_deposits > v_wallet.deposits then
    v_wallet.deposits := v_deposits;
  end if;

  -- Calculate/reconcile sales from orders
  select coalesce(sum(amount), 0) into v_sales
  from public.orders
  where (agent_id = p_agent_id or agent_code = v_agent_code) and status in ('completed', 'success', 'paid');

  if v_sales > v_wallet.sales then
    v_wallet.sales := v_sales;
  end if;

  -- Calculate/reconcile store sales
  select coalesce(sum(sale_amount), 0) into v_store_sales
  from public.store_orders
  where agent_id = p_agent_id and payment_status = 'paid';

  if v_store_sales > v_wallet.store_sales then
    v_wallet.store_sales := v_store_sales;
  end if;

  -- Update wallet with reconciled stats
  update public.wallets
  set
    deposits = v_wallet.deposits,
    sales = v_wallet.sales,
    store_sales = v_wallet.store_sales,
    updated_at = now()
  where id = p_agent_id;

  return jsonb_build_object(
    'balance', coalesce(v_wallet.balance, 0.00),
    'sales', coalesce(v_wallet.sales, 0.00),
    'deposits', coalesce(v_wallet.deposits, 0.00),
    'overdraft', coalesce(v_wallet.overdraft, 0.00),
    'commission_balance', coalesce(v_wallet.commission_balance, 0.00),
    'withdrawn_commission', coalesce(v_wallet.withdrawn_commission, 0.00),
    'transferred_commission', coalesce(v_wallet.transferred_commission, 0.00),
    'total_commission_earned', coalesce(v_wallet.total_commission_earned, 0.00),
    'store_sales', coalesce(v_wallet.store_sales, 0.00)
  );
end;
$$;

-- 7. RPC: ATOMIC AGENT ORDER PROCESSING & WALLET DEDUCTION
create or replace function public.process_agent_order(
  p_agent_id uuid,
  p_order_total numeric,
  p_network text default 'MTN',
  p_bundle_size text default '1GB',
  p_recipient_phone text default '',
  p_commission_rate numeric default 0.05,
  p_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_agent_code text;
  v_ref text;
  v_commission numeric(12,2);
  v_order_id uuid;
begin
  if p_agent_id is null then
    raise exception 'Agent ID is required';
  end if;

  if p_order_total is null or p_order_total <= 0 then
    raise exception 'Order total must be greater than zero';
  end if;

  perform public.ensure_agent_profile(p_agent_id);
  select agent_code into v_agent_code from public.agents where id = p_agent_id;

  -- 1. Pre-check: verify if balance >= order_total
  select * into v_wallet from public.wallets where id = p_agent_id for update;
  if not found then
    raise exception 'Agent wallet not found.';
  end if;

  if v_wallet.balance < p_order_total then
    raise exception 'Insufficient wallet balance. Please top up your wallet via Paystack.';
  end if;

  -- 2. Calculate store commission
  v_commission := round((p_order_total * coalesce(p_commission_rate, 0.05))::numeric, 2);

  -- 3. Atomic execution: deduct from balance, increment sales & store_sales, add to commission
  update public.wallets
  set
    balance = balance - p_order_total,
    sales = sales + p_order_total,
    store_sales = store_sales + p_order_total,
    commission_balance = commission_balance + v_commission,
    total_commission_earned = total_commission_earned + v_commission,
    updated_at = now()
  where id = p_agent_id
  returning * into v_wallet;

  -- 4. Generate unique reference
  v_ref := coalesce(nullif(trim(p_reference), ''), 'ORD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)));

  -- 5. Insert order
  insert into public.orders (
    agent_id, agent_code, network, bundle_size, recipient_phone, amount, commission_amount, reference, status, created_at
  ) values (
    p_agent_id, v_agent_code, coalesce(p_network, 'MTN'), coalesce(p_bundle_size, '1GB'), coalesce(p_recipient_phone, ''), p_order_total, v_commission, v_ref, 'completed', now()
  ) returning id into v_order_id;

  -- 6. Log record in transactions with type: "Order Purchase"
  insert into public.transactions (
    agent_id, agent_code, reference, amount, type, status, metadata, created_at
  ) values (
    p_agent_id,
    v_agent_code,
    v_ref,
    p_order_total,
    'Order Purchase',
    'success',
    jsonb_build_object(
      'network', p_network,
      'bundle_size', p_bundle_size,
      'recipient_phone', p_recipient_phone,
      'commission_earned', v_commission,
      'order_id', v_order_id
    ),
    now()
  );

  -- 7. Log in commissions
  if v_commission > 0 then
    insert into public.commissions (
      agent_id, order_id, reference, amount, rate, source, status, metadata, created_at
    ) values (
      p_agent_id,
      v_order_id,
      'COMM-' || v_ref,
      v_commission,
      coalesce(p_commission_rate, 0.05),
      'Store Sales',
      'earned',
      jsonb_build_object('order_reference', v_ref),
      now()
    );
  end if;

  -- 8. Log in wallet_transactions for audit trail
  insert into public.wallet_transactions (
    agent_id, reference, type, description, amount, balance_after, meta
  ) values (
    p_agent_id,
    v_ref,
    'debit',
    'Order Purchase: ' || coalesce(p_network, '') || ' ' || coalesce(p_bundle_size, ''),
    p_order_total,
    v_wallet.balance,
    jsonb_build_object('order_id', v_order_id, 'commission', v_commission)
  );

  return jsonb_build_object(
    'success', true,
    'reference', v_ref,
    'order_id', v_order_id,
    'amount_deducted', p_order_total,
    'commission_earned', v_commission,
    'new_balance', v_wallet.balance,
    'commission_balance', v_wallet.commission_balance,
    'sales', v_wallet.sales,
    'store_sales', v_wallet.store_sales
  );
end;
$$;

-- 8. RPC: TRANSFER COMMISSION (commission_balance -> balance)
create or replace function public.transfer_commission(
  p_agent_id uuid,
  p_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_agent_code text;
  v_ref text;
begin
  if p_agent_id is null then raise exception 'Agent ID is required'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Transfer amount must be greater than zero'; end if;

  select * into v_wallet from public.wallets where id = p_agent_id for update;
  if not found then raise exception 'Wallet not found.'; end if;

  if v_wallet.commission_balance < p_amount then
    raise exception 'Insufficient commission balance. Current available: GHS %', v_wallet.commission_balance;
  end if;

  select agent_code into v_agent_code from public.agents where id = p_agent_id;

  -- Deduct from commission_balance, add to balance, increment transferred_commission
  update public.wallets
  set
    commission_balance = commission_balance - p_amount,
    balance = balance + p_amount,
    transferred_commission = transferred_commission + p_amount,
    updated_at = now()
  where id = p_agent_id
  returning * into v_wallet;

  v_ref := 'TRF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  -- Log record in transactions with type: "Commission Transfer"
  insert into public.transactions (
    agent_id, agent_code, reference, amount, type, status, metadata, created_at
  ) values (
    p_agent_id,
    v_agent_code,
    v_ref,
    p_amount,
    'Commission Transfer',
    'success',
    jsonb_build_object('source', 'commission_balance', 'destination', 'wallet_balance'),
    now()
  );

  insert into public.wallet_transactions (
    agent_id, reference, type, description, amount, balance_after
  ) values (
    p_agent_id,
    v_ref,
    'credit',
    'Commission Transfer to wallet balance',
    p_amount,
    v_wallet.balance
  );

  return jsonb_build_object(
    'success', true,
    'reference', v_ref,
    'transferred_amount', p_amount,
    'new_balance', v_wallet.balance,
    'commission_balance', v_wallet.commission_balance,
    'transferred_commission', v_wallet.transferred_commission
  );
end;
$$;

-- 9. RPC: WITHDRAW COMMISSION (commission_balance -> external MoMo/Bank)
create or replace function public.withdraw_commission(
  p_agent_id uuid,
  p_amount numeric,
  p_payout_method text default 'momo',
  p_account_name text default '',
  p_account_number text default '',
  p_network text default null,
  p_bank_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_agent_code text;
  v_ref text;
  v_snapshot jsonb;
begin
  if p_agent_id is null then raise exception 'Agent ID is required'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Withdrawal amount must be greater than zero'; end if;

  select * into v_wallet from public.wallets where id = p_agent_id for update;
  if not found then raise exception 'Wallet not found.'; end if;

  if v_wallet.commission_balance < p_amount then
    raise exception 'Insufficient commission balance. Current available: GHS %', v_wallet.commission_balance;
  end if;

  select agent_code into v_agent_code from public.agents where id = p_agent_id;

  -- Deduct from commission_balance, increment withdrawn_commission
  update public.wallets
  set
    commission_balance = commission_balance - p_amount,
    withdrawn_commission = withdrawn_commission + p_amount,
    updated_at = now()
  where id = p_agent_id
  returning * into v_wallet;

  v_ref := 'WD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  v_snapshot := jsonb_build_object(
    'method', coalesce(p_payout_method, 'momo'),
    'account_name', coalesce(p_account_name, ''),
    'account_number', coalesce(p_account_number, ''),
    'network', p_network,
    'bank_name', p_bank_name
  );

  insert into public.agent_payouts (
    agent_id, amount, status, method, account_snapshot, reference, requested_at
  ) values (
    p_agent_id, p_amount, 'pending', coalesce(p_payout_method, 'momo'), v_snapshot, v_ref, now()
  );

  -- Log record in transactions with type: "Commission Withdrawal"
  insert into public.transactions (
    agent_id, agent_code, reference, amount, type, status, metadata, created_at
  ) values (
    p_agent_id,
    v_agent_code,
    v_ref,
    p_amount,
    'Commission Withdrawal',
    'pending',
    v_snapshot,
    now()
  );

  return jsonb_build_object(
    'success', true,
    'reference', v_ref,
    'withdrawn_amount', p_amount,
    'commission_balance', v_wallet.commission_balance,
    'withdrawn_commission', v_wallet.withdrawn_commission
  );
end;
$$;

-- 10. UPDATE FULFIL_WALLET_TOPUP (Increments balance & deposits, logs "Wallet Deposit")
create or replace function public.fulfil_wallet_topup(p_topup_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_topup public.wallet_topups%rowtype;
  v_balance numeric;
  v_provider text;
  v_agent_code text;
begin
  select * into v_topup from public.wallet_topups where id = p_topup_id for update;
  if not found then raise exception 'Wallet top-up not found'; end if;

  if v_topup.status = 'paid' then
    select coalesce(balance, 0) into v_balance from public.wallets where id = v_topup.agent_id;
    return v_balance;
  end if;

  select agent_code into v_agent_code from public.agents where id = v_topup.agent_id;
  v_provider := coalesce(nullif(v_topup.provider, ''), 'paystack');

  -- 1. Increment spendable balance and cumulative deposits
  insert into public.wallets (id, balance, deposits)
  values (v_topup.agent_id, v_topup.amount, v_topup.amount)
  on conflict (id) do update
  set
    balance = public.wallets.balance + excluded.balance,
    deposits = public.wallets.deposits + excluded.deposits,
    updated_at = now()
  returning balance into v_balance;

  -- 2. Log in wallet_transactions
  insert into public.wallet_transactions (agent_id, reference, type, description, amount, balance_after, meta)
  values (
    v_topup.agent_id,
    v_topup.payment_reference,
    'credit',
    'Wallet top-up via ' || initcap(v_provider),
    v_topup.amount,
    v_balance,
    jsonb_build_object('payment_type', 'wallet_topup', 'provider', v_provider, 'topup_id', v_topup.id)
  )
  on conflict (reference) do nothing;

  -- 3. Log in transactions with type: "Wallet Deposit"
  insert into public.transactions (
    agent_id, agent_code, reference, amount, type, status, metadata, created_at
  ) values (
    v_topup.agent_id,
    v_agent_code,
    v_topup.payment_reference,
    v_topup.amount,
    'Wallet Deposit',
    'success',
    jsonb_build_object('provider', v_provider, 'topup_id', v_topup.id),
    now()
  )
  on conflict (reference) do update
  set
    status = 'success',
    amount = excluded.amount;

  update public.wallet_topups set status = 'paid', paid_at = now() where id = v_topup.id;
  return v_balance;
end;
$$;

-- 11. RPC: RECORD PAYSTACK WALLET DEPOSIT DIRECTLY (used on verified callback or client completion)
create or replace function public.record_paystack_deposit(
  p_agent_id uuid,
  p_amount numeric,
  p_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_topup public.wallet_topups%rowtype;
  v_balance numeric;
begin
  if p_agent_id is null or p_amount is null or p_amount <= 0 or p_reference is null then
    raise exception 'Invalid deposit parameters';
  end if;

  -- Check existing topup
  select * into v_topup from public.wallet_topups where payment_reference = p_reference;
  if not found then
    insert into public.wallet_topups (
      agent_id, amount, payment_reference, provider, status
    ) values (
      p_agent_id, p_amount, p_reference, 'paystack', 'pending_payment'
    ) returning * into v_topup;
  end if;

  -- Fulfill topup
  v_balance := public.fulfil_wallet_topup(v_topup.id);

  return jsonb_build_object(
    'success', true,
    'reference', p_reference,
    'amount', p_amount,
    'new_balance', v_balance
  );
end;
$$;

-- 12. GRANTS & PERMISSIONS
grant execute on function public.get_wallet_dashboard_stats(uuid) to authenticated, anon, service_role;
grant execute on function public.process_agent_order(uuid, numeric, text, text, text, numeric, text) to authenticated, anon, service_role;
grant execute on function public.transfer_commission(uuid, numeric) to authenticated, anon, service_role;
grant execute on function public.withdraw_commission(uuid, numeric, text, text, text, text, text) to authenticated, anon, service_role;
grant execute on function public.fulfil_wallet_topup(uuid) to authenticated, anon, service_role;
grant execute on function public.record_paystack_deposit(uuid, numeric, text) to authenticated, anon, service_role;
