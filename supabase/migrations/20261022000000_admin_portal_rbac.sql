-- ============================================================================
-- Migration: Production Admin Portal RBAC & Security
-- Configured for primary Super Admin: seidumobiriahidu@gmail.com
-- ============================================================================

-- 1. EXTEND ROLE DOMAIN ON AGENTS
alter table public.agents drop constraint if exists agents_role_check;
alter table public.agents add constraint agents_role_check 
  check (role in ('agent', 'admin', 'super_admin'));

-- 2. SUPER ADMIN & ADMIN IDENTIFICATION FUNCTIONS
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 
    from public.agents a
    left join auth.users u on u.id = a.id
    where a.id = auth.uid() 
      and (a.role in ('admin', 'super_admin') or lower(coalesce(u.email, '')) = 'seidumobiriahidu@gmail.com')
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 
    from public.agents a
    left join auth.users u on u.id = a.id
    where a.id = auth.uid() 
      and (a.role = 'super_admin' or lower(coalesce(u.email, '')) = 'seidumobiriahidu@gmail.com')
  );
$$;

revoke all on function public.is_super_admin() from public, anon;
grant execute on function public.is_super_admin() to authenticated, service_role;

-- 3. AUTO-ASSIGN SUPER ADMIN FOR seidumobiriahidu@gmail.com ON SIGNUP/LOGIN
create or replace function public.prevent_agent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_email text;
begin
  if new.role is distinct from old.role then
    select lower(email) into v_user_email from auth.users where id = new.id;
    -- Always allow promoting primary super admin owner
    if v_user_email = 'seidumobiriahidu@gmail.com' and new.role = 'super_admin' then
      return new;
    end if;

    -- Allow if service_role or caller is super_admin
    if coalesce(auth.role(), '') = 'service_role' or public.is_super_admin() then
      return new;
    end if;

    raise exception using
      errcode = '42501',
      message = 'Agent role cannot be changed.';
  end if;
  return new;
end;
$$;

create or replace function public.handle_super_admin_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_email text;
begin
  select lower(email) into v_user_email from auth.users where id = new.id;

  if v_user_email = 'seidumobiriahidu@gmail.com' then
    new.role := 'super_admin';
  end if;

  return new;
end;
$$;

-- Trigger on public.agents table
drop trigger if exists trg_super_admin_assignment on public.agents;
create trigger trg_super_admin_assignment
  before insert or update on public.agents
  for each row execute function public.handle_super_admin_assignment();

-- Backfill / Upgrade seidumobiriahidu@gmail.com immediately if exists
do $$
declare
  v_super_admin_id uuid;
begin
  select id into v_super_admin_id from auth.users where lower(email) = 'seidumobiriahidu@gmail.com' limit 1;
  if v_super_admin_id is not null then
    insert into public.agents (id, full_name, role)
    values (v_super_admin_id, 'Primary Super Admin', 'super_admin')
    on conflict (id) do update set role = 'super_admin', updated_at = now();
    
    insert into public.wallets (id, balance)
    values (v_super_admin_id, 0)
    on conflict (id) do nothing;
  end if;
end;
$$;

-- 4. ROW LEVEL SECURITY UPDATES FOR ADMIN ACCESS

-- Agents table
drop policy if exists "Admins can view all agents" on public.agents;
create policy "Admins can view all agents"
  on public.agents for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Super admins can update agents" on public.agents;
create policy "Super admins can update agents"
  on public.agents for update
  to authenticated
  using (public.is_super_admin());

drop policy if exists "Super admins can delete agents" on public.agents;
create policy "Super admins can delete agents"
  on public.agents for delete
  to authenticated
  using (public.is_super_admin());

-- Profiles table
drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
  on public.profiles for select
  to authenticated
  using (public.is_admin());

-- Wallets
drop policy if exists "Admins can view all wallets" on public.wallets;
create policy "Admins can view all wallets"
  on public.wallets for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins can update wallets" on public.wallets;
create policy "Admins can update wallets"
  on public.wallets for update
  to authenticated
  using (public.is_admin());

-- Data Transactions (Instant Data)
drop policy if exists "Admins can view all data transactions" on public.data_transactions;
create policy "Admins can view all data transactions"
  on public.data_transactions for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins can update data transactions" on public.data_transactions;
create policy "Admins can update data transactions"
  on public.data_transactions for update
  to authenticated
  using (public.is_admin());

-- Agent Data Orders
drop policy if exists "Admins can view all agent data orders" on public.agent_data_orders;
create policy "Admins can view all agent data orders"
  on public.agent_data_orders for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins can update agent data orders" on public.agent_data_orders;
create policy "Admins can update agent data orders"
  on public.agent_data_orders for update
  to authenticated
  using (public.is_admin());

-- Public Data Orders
drop policy if exists "Admins can view all public data orders" on public.public_data_orders;
create policy "Admins can view all public data orders"
  on public.public_data_orders for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins can update public data orders" on public.public_data_orders;
create policy "Admins can update public data orders"
  on public.public_data_orders for update
  to authenticated
  using (public.is_admin());

-- Airtime Orders
drop policy if exists "Admins can view all airtime orders" on public.airtime_orders;
create policy "Admins can view all airtime orders"
  on public.airtime_orders for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins can update airtime orders" on public.airtime_orders;
create policy "Admins can update airtime orders"
  on public.airtime_orders for update
  to authenticated
  using (public.is_admin());

-- Utility Orders
drop policy if exists "Admins can view all utility orders" on public.utility_orders;
create policy "Admins can view all utility orders"
  on public.utility_orders for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins can update utility orders" on public.utility_orders;
create policy "Admins can update utility orders"
  on public.utility_orders for update
  to authenticated
  using (public.is_admin());

-- Bundles & Catalog
drop policy if exists "Admins can manage bundles" on public.bundles;
create policy "Admins can manage bundles"
  on public.bundles for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins can manage bundle_catalog" on public.bundle_catalog;
create policy "Admins can manage bundle_catalog"
  on public.bundle_catalog for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Agent Stores & Store Orders
drop policy if exists "Admins can view all agent stores" on public.agent_stores;
create policy "Admins can view all agent stores"
  on public.agent_stores for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins can update agent stores" on public.agent_stores;
create policy "Admins can update agent stores"
  on public.agent_stores for update
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins can view all store orders" on public.store_orders;
create policy "Admins can view all store orders"
  on public.store_orders for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins can update store orders" on public.store_orders;
create policy "Admins can update store orders"
  on public.store_orders for update
  to authenticated
  using (public.is_admin());

-- Commission Rates and Pricing Rules
drop policy if exists "Admins can manage service_commission_rates" on public.service_commission_rates;
create policy "Admins can manage service_commission_rates"
  on public.service_commission_rates for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins can manage agent_pricing" on public.agent_pricing;
create policy "Admins can manage agent_pricing"
  on public.agent_pricing for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 5. ADMIN STORED PROCEDURES

-- Procedure: Admin manual credit / debit of wallet
create or replace function public.admin_adjust_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_type text, -- 'credit' or 'debit'
  p_reason text,
  p_admin_id uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_balance numeric;
  v_new_balance numeric;
  v_delta numeric;
  v_tx_ref text;
  v_agent_code text;
begin
  if not public.is_admin() then
    raise exception 'Unauthorized. Administrator privilege required.';
  end if;

  if p_amount <= 0 then
    raise exception 'Adjustment amount must be positive.';
  end if;

  if p_type not in ('credit', 'debit') then
    raise exception 'Invalid adjustment type: must be credit or debit.';
  end if;

  -- Lock wallet
  select balance into v_current_balance
  from public.wallets
  where id = p_user_id
  for update;

  if v_current_balance is null then
    raise exception 'Wallet not found for user %', p_user_id;
  end if;

  select agent_code into v_agent_code
  from public.agents
  where id = p_user_id;

  if p_type = 'credit' then
    v_delta := p_amount;
  else
    v_delta := -p_amount;
    if (v_current_balance + v_delta) < 0 then
      raise exception 'Cannot debit beyond available balance. Current balance is GHS %', v_current_balance;
    end if;
  end if;

  v_new_balance := v_current_balance + v_delta;

  update public.wallets
  set balance = v_new_balance,
      updated_at = now()
  where id = p_user_id;

  v_tx_ref := 'ADM-' || upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  -- Insert into transactions ledger if transactions table exists
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'transactions') then
    insert into public.transactions (
      agent_id,
      agent_code,
      type,
      amount,
      balance_before,
      balance_after,
      description,
      status,
      metadata
    ) values (
      p_user_id,
      v_agent_code,
      case when p_type = 'credit' then 'Admin Credit' else 'Admin Debit' end,
      p_amount,
      v_current_balance,
      v_new_balance,
      coalesce(p_reason, 'Manual admin balance adjustment'),
      'completed',
      jsonb_build_object(
        'admin_id', p_admin_id,
        'reference', v_tx_ref,
        'reason', p_reason
      )
    );
  end if;

  -- Insert into wallet_transactions if exists
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'wallet_transactions') then
    insert into public.wallet_transactions (
      wallet_id,
      amount,
      balance_after,
      entry_type,
      reference,
      description
    ) values (
      p_user_id,
      v_delta,
      v_new_balance,
      case when p_type = 'credit' then 'credit' else 'debit' end,
      v_tx_ref,
      coalesce(p_reason, 'Admin adjustment')
    );
  end if;

  -- Log into activity log
  perform public.log_activity(
    'Admin ' || p_type || ' of GHS ' || p_amount || ' for user ' || coalesce(v_agent_code, p_user_id::text),
    jsonb_build_object(
      'user_id', p_user_id,
      'amount', p_amount,
      'type', p_type,
      'old_balance', v_current_balance,
      'new_balance', v_new_balance,
      'reason', p_reason,
      'reference', v_tx_ref
    ),
    p_admin_id
  );

  return jsonb_build_object(
    'success', true,
    'userId', p_user_id,
    'oldBalance', v_current_balance,
    'newBalance', v_new_balance,
    'reference', v_tx_ref
  );
end;
$$;

revoke all on function public.admin_adjust_wallet(uuid, numeric, text, text, uuid) from public, anon;
grant execute on function public.admin_adjust_wallet(uuid, numeric, text, text, uuid) to authenticated, service_role;

-- Procedure: Get Admin Overview & Analytics Dashboard Metrics
create or replace function public.get_admin_dashboard_metrics()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_revenue numeric := 0;
  v_store_sales numeric := 0;
  v_data_sales numeric := 0;
  v_instant_data_sales numeric := 0;
  v_airtime_sales numeric := 0;
  v_utility_sales numeric := 0;

  v_pending_count integer := 0;
  v_successful_count integer := 0;
  v_failed_count integer := 0;

  v_sub numeric;
  v_cnt integer;
begin
  if not public.is_admin() then
    raise exception 'Unauthorized: Administrator access required.';
  end if;

  -- 1. Instant Data (data_transactions)
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'data_transactions') then
    select coalesce(sum(amount), 0),
           count(*) filter (where status = 'success'),
           count(*) filter (where status = 'pending'),
           count(*) filter (where status = 'failed')
    into v_instant_data_sales, v_cnt, v_sub, v_sub
    from public.data_transactions;

    v_successful_count := v_successful_count + coalesce(v_cnt, 0);
    v_pending_count := v_pending_count + coalesce(v_sub::integer, 0);
  end if;

  -- 2. Standard Data Bundles (agent_data_orders & public_data_orders)
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'agent_data_orders') then
    select coalesce(sum(amount), 0),
           count(*) filter (where status = 'successful'),
           count(*) filter (where status = 'processing'),
           count(*) filter (where status = 'failed')
    into v_sub, v_cnt, v_sub, v_sub
    from public.agent_data_orders;

    v_data_sales := v_data_sales + coalesce(v_sub, 0);
    v_successful_count := v_successful_count + coalesce(v_cnt, 0);
    v_pending_count := v_pending_count + coalesce(v_sub::integer, 0);
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'public_data_orders') then
    select coalesce(sum(sale_amount), 0),
           count(*) filter (where status = 'successful'),
           count(*) filter (where status in ('processing', 'pending_payment')),
           count(*) filter (where status = 'failed')
    into v_sub, v_cnt, v_sub, v_sub
    from public.public_data_orders;

    v_data_sales := v_data_sales + coalesce(v_sub, 0);
    v_successful_count := v_successful_count + coalesce(v_cnt, 0);
    v_pending_count := v_pending_count + coalesce(v_sub::integer, 0);
  end if;

  -- 3. Airtime Orders (airtime_orders)
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'airtime_orders') then
    select coalesce(sum(gross_amount), 0),
           count(*) filter (where airtime_status = 'delivered'),
           count(*) filter (where airtime_status in ('pending', 'processing', 'pending_provider')),
           count(*) filter (where airtime_status = 'failed')
    into v_airtime_sales, v_cnt, v_sub, v_sub
    from public.airtime_orders;

    v_successful_count := v_successful_count + coalesce(v_cnt, 0);
    v_pending_count := v_pending_count + coalesce(v_sub::integer, 0);
  end if;

  -- 4. Utility Orders (utility_orders)
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'utility_orders') then
    select coalesce(sum(gross_amount), 0),
           count(*) filter (where status = 'completed'),
           count(*) filter (where status in ('pending_payment', 'paid', 'processing')),
           count(*) filter (where status = 'failed')
    into v_utility_sales, v_cnt, v_sub, v_sub
    from public.utility_orders;

    v_successful_count := v_successful_count + coalesce(v_cnt, 0);
    v_pending_count := v_pending_count + coalesce(v_sub::integer, 0);
  end if;

  -- 5. Agent Store Orders (store_orders)
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'store_orders') then
    select coalesce(sum(sale_amount), 0),
           count(*) filter (where payment_status = 'paid' and fulfilment_status = 'successful'),
           count(*) filter (where payment_status = 'paid' and fulfilment_status in ('pending', 'processing'))
    into v_store_sales, v_cnt, v_sub
    from public.store_orders;

    v_successful_count := v_successful_count + coalesce(v_cnt, 0);
    v_pending_count := v_pending_count + coalesce(v_sub::integer, 0);
  end if;

  v_total_revenue := v_instant_data_sales + v_data_sales + v_airtime_sales + v_utility_sales + v_store_sales;

  return jsonb_build_object(
    'total_revenue', round(v_total_revenue, 2),
    'agent_store_sales', round(v_store_sales, 2),
    'disbursement_account_id', '2027124',
    'pending_transactions', v_pending_count,
    'successful_transactions', v_successful_count,
    'breakdown', jsonb_build_object(
      'data_bundles', round(v_data_sales, 2),
      'instant_data', round(v_instant_data_sales, 2),
      'airtime', round(v_airtime_sales, 2),
      'utility_bills', round(v_utility_sales, 2),
      'agent_store', round(v_store_sales, 2)
    )
  );
end;
$$;

revoke all on function public.get_admin_dashboard_metrics() from public, anon;
grant execute on function public.get_admin_dashboard_metrics() to authenticated, service_role;
