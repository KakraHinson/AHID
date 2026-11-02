-- Wallet/order integrity hardening.
--
-- The wallet is authoritative. Browser-provided amounts and agent ids must
-- never be able to credit another wallet, and a successful order must be
-- represented by a durable database row rather than only localStorage.

create index if not exists idx_orders_agent_reference
  on public.orders(agent_id, reference);

-- Durable audit tables for provider reconciliation and manual agent refunds.
-- The existing JSON columns keep the latest provider response; these tables
-- retain every poll/callback and every manual refund as a separate event.
create table if not exists public.provider_order_status_events (
  id uuid primary key default gen_random_uuid(),
  order_type text not null,
  order_id uuid not null,
  agent_id uuid references auth.users(id) on delete set null,
  provider text not null,
  provider_status text not null,
  internal_status text not null,
  source text not null default 'provider_sync',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists provider_order_status_events_order_idx
  on public.provider_order_status_events(order_type, order_id, created_at desc);
create index if not exists provider_order_status_events_agent_idx
  on public.provider_order_status_events(agent_id, created_at desc);

alter table public.provider_order_status_events enable row level security;
drop policy if exists "Agents and admins can view provider status events" on public.provider_order_status_events;
create policy "Agents and admins can view provider status events"
  on public.provider_order_status_events for select
  to authenticated
  using (auth.uid() = agent_id or public.is_admin());
grant select on public.provider_order_status_events to authenticated, service_role;

create table if not exists public.agent_wallet_refunds (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references auth.users(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  reference text not null unique,
  reason text not null,
  admin_id uuid references auth.users(id) on delete set null,
  source text not null default 'admin_manual_refund',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_wallet_refunds_agent_created_idx
  on public.agent_wallet_refunds(agent_id, created_at desc);

alter table public.agent_wallet_refunds enable row level security;
drop policy if exists "Agents and admins can view wallet refunds" on public.agent_wallet_refunds;
create policy "Agents and admins can view wallet refunds"
  on public.agent_wallet_refunds for select
  to authenticated
  using (auth.uid() = agent_id or public.is_admin());
grant select on public.agent_wallet_refunds to authenticated, service_role;

-- Service-role calls are made only after the Edge Function has authenticated
-- and authorized the caller. Allow those internal calls through the admin
-- helpers, while keeping browser calls tied to the signed-in user.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or exists (
        select 1
          from public.agents a
          left join auth.users u on u.id = a.id
         where a.id = auth.uid()
           and (a.role in ('admin', 'super_admin')
                or lower(coalesce(u.email, '')) = 'seidumobiriahidu@gmail.com')
      );
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or exists (
        select 1
          from public.agents a
          left join auth.users u on u.id = a.id
         where a.id = auth.uid()
           and (a.role = 'super_admin'
                or lower(coalesce(u.email, '')) = 'seidumobiriahidu@gmail.com')
      );
$$;

-- Strict positive amounts: a negative value is a programming error, never a
-- request to reverse the direction of a wallet movement.
create or replace function public.charge_agent_wallet(
  p_agent_id uuid,
  p_reference text,
  p_amount numeric,
  p_description text default null,
  p_meta jsonb default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
  v_debit numeric;
  v_after numeric;
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Payment amount must be a positive amount with at most two decimals.';
  end if;
  if nullif(trim(p_reference), '') is null then
    raise exception 'A wallet payment reference is required.';
  end if;

  v_debit := round(p_amount, 2);
  select balance into v_balance
    from public.wallets
   where id = p_agent_id
     for update;
  if not found then raise exception 'Agent wallet not found.'; end if;
  if coalesce(v_balance, 0) < v_debit then
    raise exception 'Insufficient wallet balance. Available GHS %, required GHS %', v_balance, v_debit;
  end if;

  v_after := v_balance - v_debit;
  update public.wallets
     set balance = v_after, updated_at = now()
   where id = p_agent_id;

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, meta)
  values
    (p_agent_id, p_reference, 'debit', coalesce(p_description, 'Service purchase'), v_debit, v_after,
     coalesce(p_meta, '{}'::jsonb));
  return v_after;
end;
$$;

create or replace function public.admin_refund_agent_wallet(
  p_agent_id uuid,
  p_amount numeric,
  p_reason text,
  p_admin_id uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_agent_code text;
  v_amount numeric(12,2);
  v_reference text;
  v_reason text;
begin
  if not public.is_admin() then raise exception 'Unauthorized. Administrator privilege required.'; end if;
  if p_agent_id is null then raise exception 'Agent ID is required.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Refund amount must be a positive amount with at most two decimals.';
  end if;
  v_reason := nullif(trim(coalesce(p_reason, '')), '');
  if v_reason is null then raise exception 'A refund reason is required.'; end if;
  v_amount := round(p_amount, 2);

  select * into v_wallet from public.wallets where id = p_agent_id for update;
  if not found then raise exception 'Agent wallet not found.'; end if;
  select agent_code into v_agent_code from public.agents where id = p_agent_id;
  v_reference := 'REF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

  update public.wallets
     set balance = balance + v_amount,
         updated_at = now()
   where id = p_agent_id
   returning * into v_wallet;

  insert into public.agent_wallet_refunds
    (agent_id, amount, reference, reason, admin_id, metadata)
  values
    (p_agent_id, v_amount, v_reference, v_reason, p_admin_id,
     jsonb_build_object('source', 'admin_manual_refund'));

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, status, meta)
  values
    (p_agent_id, v_reference, 'credit', 'Agent refund: ' || v_reason,
     v_amount, v_wallet.balance, 'settled',
     jsonb_build_object('source', 'admin_manual_refund', 'admin_id', p_admin_id));

  insert into public.transactions
    (agent_id, agent_code, reference, amount, type, balance_before, balance_after, description, status, metadata, created_at)
  values
    (p_agent_id, v_agent_code, v_reference, v_amount, 'Wallet Refund',
     v_wallet.balance - v_amount, v_wallet.balance, v_reason, 'success',
     jsonb_build_object('source', 'admin_manual_refund', 'admin_id', p_admin_id), now());

  perform public.log_activity(
    'Admin refunded GHS ' || v_amount || ' to ' || coalesce(v_agent_code, p_agent_id::text),
    jsonb_build_object('agent_id', p_agent_id, 'amount', v_amount,
      'reason', v_reason, 'reference', v_reference, 'admin_id', p_admin_id),
    p_admin_id
  );

  return jsonb_build_object(
    'success', true,
    'reference', v_reference,
    'agentId', p_agent_id,
    'amount', v_amount,
    'newBalance', v_wallet.balance
  );
end;
$$;

revoke all on function public.admin_refund_agent_wallet(uuid, numeric, text, uuid) from public, anon;
grant execute on function public.admin_refund_agent_wallet(uuid, numeric, text, uuid) to authenticated, service_role;

create or replace function public.record_provider_order_status(
  p_order_type text,
  p_order_id uuid,
  p_agent_id uuid,
  p_provider text,
  p_provider_status text,
  p_internal_status text,
  p_source text default 'provider_sync',
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    raise exception 'Unauthorized. Provider status events are server-only.';
  end if;
  if nullif(trim(coalesce(p_order_type, '')), '') is null
     or p_order_id is null
     or nullif(trim(coalesce(p_provider, '')), '') is null
     or nullif(trim(coalesce(p_provider_status, '')), '') is null
     or nullif(trim(coalesce(p_internal_status, '')), '') is null then
    raise exception 'Provider status event is incomplete.';
  end if;

  insert into public.provider_order_status_events
    (order_type, order_id, agent_id, provider, provider_status, internal_status, source, payload)
  values
    (trim(p_order_type), p_order_id, p_agent_id, trim(p_provider), trim(p_provider_status),
     trim(p_internal_status), coalesce(nullif(trim(p_source), ''), 'provider_sync'),
     coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_provider_order_status(text, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_provider_order_status(text, uuid, uuid, text, text, text, text, jsonb) to service_role;

create or replace function public.admin_cancel_public_data_order(
  p_order_id text,
  p_reason text default 'Cancelled by Administrator',
  p_admin_id uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.public_data_orders%rowtype;
  v_refund numeric(12,2) := 0;
  v_refunded boolean := false;
begin
  if not public.is_admin() then raise exception 'Unauthorized: Administrator access required.'; end if;

  select * into v_order
    from public.public_data_orders
   where id::text = p_order_id or payment_reference = p_order_id or short_code = p_order_id
   limit 1
   for update;
  if not found then raise exception 'Public data order not found: %', p_order_id; end if;
  if v_order.status in ('successful', 'completed', 'delivered') then
    raise exception 'Cannot cancel a completed public data order.';
  end if;
  if v_order.status in ('failed', 'cancelled') then
    return jsonb_build_object('success', true, 'idempotent', true, 'refunded', false,
      'order_id', v_order.id, 'message', 'Public data order was already settled.');
  end if;

  v_refund := coalesce(v_order.sale_amount, 0);
  if v_order.agent_id is not null and v_refund > 0 then
    perform public.refund_agent_wallet(
      v_order.agent_id,
      v_order.payment_reference,
      v_refund,
      'Refund: Public data order cancelled by administrator'
    );
    v_refunded := true;
  end if;

  update public.public_data_orders
     set status = 'cancelled',
         provider_response = coalesce(provider_response, '{}'::jsonb) || jsonb_build_object(
           'adminCancelled', true, 'adminReason', coalesce(p_reason, 'Cancelled by Administrator'),
           'adminId', p_admin_id, 'cancelledAt', now()
         ),
         completed_at = now()
   where id = v_order.id;

  return jsonb_build_object(
    'success', true, 'order_id', v_order.id, 'refunded', v_refunded,
    'refund_amount', v_refund, 'message', 'Public data order cancelled successfully'
  );
end;
$$;

revoke all on function public.admin_cancel_public_data_order(text, text, uuid) from public, anon;
grant execute on function public.admin_cancel_public_data_order(text, text, uuid) to authenticated, service_role;

create or replace function public.refund_agent_wallet(
  p_agent_id uuid,
  p_debit_reference text,
  p_amount numeric,
  p_reason text default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
  v_after numeric;
  v_refund numeric;
  v_debit public.wallet_transactions%rowtype;
  v_credit_reference text;
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Refund amount must be a positive amount with at most two decimals.';
  end if;
  v_refund := round(p_amount, 2);

  select * into v_debit
    from public.wallet_transactions
   where agent_id = p_agent_id
     and reference = p_debit_reference
     and type = 'debit'
   order by created_at
   limit 1
     for update;
  if not found then raise exception 'No payable wallet debit found for reference %.', p_debit_reference; end if;
  if v_debit.status = 'refunded' then
    select coalesce(balance, 0) into v_balance from public.wallets where id = p_agent_id;
    return v_balance;
  end if;
  if v_debit.amount <> v_refund then
    raise exception 'Refund amount must match the original wallet debit of GHS %.', v_debit.amount;
  end if;

  select coalesce(balance, 0) into v_balance
    from public.wallets where id = p_agent_id for update;
  if not found then raise exception 'Agent wallet not found.'; end if;
  v_after := v_balance + v_refund;
  v_credit_reference := v_debit.reference || '-REF-' || substr(md5(random()::text), 1, 6);

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, status, reversed_transaction_id, meta)
  values
    (p_agent_id, v_credit_reference, 'credit', coalesce(p_reason, 'Refund for ' || v_debit.reference),
     v_refund, v_after, 'settled', v_debit.id, jsonb_build_object('debit_reference', v_debit.reference));

  update public.wallets set balance = v_after, updated_at = now() where id = p_agent_id;
  update public.wallet_transactions set status = 'refunded', updated_at = now() where id = v_debit.id;
  return v_after;
exception
  when unique_violation then
    select coalesce(balance, 0) into v_balance from public.wallets where id = p_agent_id;
    return v_balance;
end;
$$;

-- The legacy wallet page still uses this RPC. Keep it atomic, make the server
-- own the commission rate, and require the caller to be the same agent.
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
  v_debit numeric;
  v_rate numeric := 0.05;
  v_commission numeric(12,2);
  v_order_id uuid;
  v_existing public.orders%rowtype;
begin
  if p_agent_id is null then raise exception 'Agent ID is required'; end if;
  if auth.uid() is distinct from p_agent_id
     and not public.is_admin()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'You may only place orders for your own wallet.';
  end if;
  if p_order_total is null or p_order_total <= 0 or p_order_total <> round(p_order_total, 2) then
    raise exception 'Order total must be a positive amount with at most two decimals.';
  end if;

  v_debit := round(p_order_total, 2);
  v_ref := coalesce(nullif(trim(p_reference), ''), 'ORD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)));

  select * into v_wallet from public.wallets where id = p_agent_id for update;
  if not found then raise exception 'Agent wallet not found.'; end if;

  -- Check after taking the wallet lock so concurrent retries are serialized.
  select * into v_existing
    from public.orders
   where agent_id = p_agent_id and reference = v_ref
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'duplicate', true, 'reference', v_existing.reference,
      'order_id', v_existing.id, 'amount_deducted', v_existing.amount,
      'commission_earned', v_existing.commission_amount,
      'new_balance', coalesce(v_wallet.balance, 0),
      'commission_balance', coalesce(v_wallet.commission_balance, 0),
      'sales', coalesce(v_wallet.sales, 0), 'store_sales', coalesce(v_wallet.store_sales, 0)
    );
  end if;

  if coalesce(v_wallet.balance, 0) < v_debit then
    raise exception 'Insufficient wallet balance. Please top up your wallet via Paystack.';
  end if;

  select agent_code into v_agent_code from public.agents where id = p_agent_id;
  v_commission := round(v_debit * v_rate, 2);
  update public.wallets
     set balance = balance - v_debit,
         sales = sales + v_debit,
         store_sales = store_sales + v_debit,
         commission_balance = commission_balance + v_commission,
         total_commission_earned = total_commission_earned + v_commission,
         updated_at = now()
   where id = p_agent_id
   returning * into v_wallet;

  insert into public.orders
    (agent_id, agent_code, network, bundle_size, recipient_phone, amount, commission_amount, reference, status, created_at)
  values
    (p_agent_id, v_agent_code, coalesce(p_network, 'MTN'), coalesce(p_bundle_size, '1GB'),
     coalesce(p_recipient_phone, ''), v_debit, v_commission, v_ref, 'completed', now())
  returning id into v_order_id;

  insert into public.transactions
    (agent_id, agent_code, reference, amount, type, status, metadata, created_at)
  values
    (p_agent_id, v_agent_code, v_ref, v_debit, 'Order Purchase', 'success',
     jsonb_build_object('network', p_network, 'bundle_size', p_bundle_size,
                        'recipient_phone', p_recipient_phone, 'commission_earned', v_commission,
                        'order_id', v_order_id), now());

  if v_commission > 0 then
    insert into public.commissions
      (agent_id, order_id, reference, amount, rate, source, status, metadata, created_at)
    values
      (p_agent_id, v_order_id, 'COMM-' || v_ref, v_commission, v_rate, 'Store Sales', 'earned',
       jsonb_build_object('order_reference', v_ref), now());
  end if;

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, meta)
  values
    (p_agent_id, v_ref, 'debit', 'Order Purchase: ' || coalesce(p_network, '') || ' ' || coalesce(p_bundle_size, ''),
     v_debit, v_wallet.balance, jsonb_build_object('order_id', v_order_id, 'commission', v_commission));

  return jsonb_build_object(
    'success', true, 'reference', v_ref, 'order_id', v_order_id,
    'amount_deducted', v_debit, 'commission_earned', v_commission,
    'new_balance', v_wallet.balance, 'commission_balance', v_wallet.commission_balance,
    'sales', v_wallet.sales, 'store_sales', v_wallet.store_sales
  );
end;
$$;

-- Keep commission movement intentional and authenticated. Commission transfer
-- is the only normal operation that adds money to spendable balance.
create or replace function public.transfer_commission(p_agent_id uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_agent_code text;
  v_ref text;
  v_amount numeric;
begin
  if auth.uid() is distinct from p_agent_id and not public.is_admin() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'You may only transfer your own commission.';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Transfer amount must be a positive amount with at most two decimals';
  end if;
  v_amount := round(p_amount, 2);
  select * into v_wallet from public.wallets where id = p_agent_id for update;
  if not found then raise exception 'Wallet not found.'; end if;
  if v_wallet.commission_balance < v_amount then
    raise exception 'Insufficient commission balance. Current available: GHS %', v_wallet.commission_balance;
  end if;
  select agent_code into v_agent_code from public.agents where id = p_agent_id;
  update public.wallets
     set commission_balance = commission_balance - v_amount,
         balance = balance + v_amount,
         transferred_commission = transferred_commission + v_amount,
         updated_at = now()
   where id = p_agent_id returning * into v_wallet;
  v_ref := 'TRF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.transactions (agent_id, agent_code, reference, amount, type, status, metadata, created_at)
  values (p_agent_id, v_agent_code, v_ref, v_amount, 'Commission Transfer', 'success',
          jsonb_build_object('source', 'commission_balance', 'destination', 'wallet_balance'), now());
  insert into public.wallet_transactions (agent_id, reference, type, description, amount, balance_after, meta)
  values (p_agent_id, v_ref, 'credit', 'Commission Transfer to wallet balance', v_amount, v_wallet.balance,
          jsonb_build_object('source', 'commission_balance'));
  return jsonb_build_object('success', true, 'reference', v_ref, 'transferred_amount', v_amount,
                            'new_balance', v_wallet.balance, 'commission_balance', v_wallet.commission_balance,
                            'transferred_commission', v_wallet.transferred_commission);
end;
$$;

-- Fix the old admin ledger column names and make service-role Edge Function
-- calls work without allowing browser callers to impersonate an admin.
create or replace function public.admin_adjust_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_type text,
  p_reason text,
  p_admin_id uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before numeric;
  v_after numeric;
  v_delta numeric;
  v_ref text;
  v_agent_code text;
begin
  if not public.is_admin() then raise exception 'Unauthorized. Administrator privilege required.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Adjustment amount must be a positive amount with at most two decimals.';
  end if;
  if p_type not in ('credit', 'debit') then raise exception 'Invalid adjustment type.'; end if;

  select balance into v_before from public.wallets where id = p_user_id for update;
  if not found then raise exception 'Wallet not found for user %', p_user_id; end if;
  v_delta := case when p_type = 'credit' then p_amount else -p_amount end;
  v_after := v_before + v_delta;
  if v_after < 0 then raise exception 'Cannot debit beyond available balance. Current balance is GHS %', v_before; end if;
  update public.wallets set balance = v_after, updated_at = now() where id = p_user_id;
  select agent_code into v_agent_code from public.agents where id = p_user_id;
  v_ref := 'ADM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  insert into public.transactions
    (agent_id, agent_code, type, amount, balance_before, balance_after, description, status, metadata)
  values
    (p_user_id, v_agent_code, case when p_type = 'credit' then 'Admin Credit' else 'Admin Debit' end,
     p_amount, v_before, v_after, coalesce(p_reason, 'Manual admin balance adjustment'), 'completed',
     jsonb_build_object('admin_id', p_admin_id, 'reference', v_ref, 'reason', p_reason));

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, meta)
  values
    (p_user_id, v_ref, case when p_type = 'credit' then 'credit' else 'debit' end,
     coalesce(p_reason, 'Admin adjustment'), p_amount, v_after,
     jsonb_build_object('admin_id', p_admin_id, 'manual_adjustment', true, 'signed_delta', v_delta));

  perform public.log_activity('Admin ' || p_type || ' of GHS ' || p_amount || ' for user ' || coalesce(v_agent_code, p_user_id::text),
    jsonb_build_object('user_id', p_user_id, 'amount', p_amount, 'type', p_type,
                       'old_balance', v_before, 'new_balance', v_after, 'reason', p_reason, 'reference', v_ref), p_admin_id);
  return jsonb_build_object('success', true, 'userId', p_user_id, 'oldBalance', v_before,
                            'newBalance', v_after, 'reference', v_ref);
end;
$$;

-- Client-side deposit completion was unsafe: it could create a pending top-up
-- with an arbitrary amount and immediately fulfil it. Only verified webhooks or
-- the server-side verification Edge Function may fulfil top-ups.
revoke all on function public.record_paystack_deposit(uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.record_paystack_deposit(uuid, numeric, text) to service_role;
revoke all on function public.fulfil_wallet_topup(uuid) from public, anon, authenticated;
grant execute on function public.fulfil_wallet_topup(uuid) to service_role;

-- These functions are service-side order fulfillment paths. Browser clients use
-- the authenticated Edge Functions, never these SECURITY DEFINER RPCs directly.
revoke all on function public.reserve_agent_data_order(uuid, text, text, text, integer, numeric) from public, anon, authenticated;
grant execute on function public.reserve_agent_data_order(uuid, text, text, text, integer, numeric) to service_role;
revoke all on function public.complete_agent_data_order(uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.complete_agent_data_order(uuid, boolean, jsonb) to service_role;
revoke all on function public.purchase_agent_airtime(uuid, text, text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.purchase_agent_airtime(uuid, text, text, text, numeric, text, text) to service_role;

revoke all on function public.process_agent_order(uuid, numeric, text, text, text, numeric, text) from public, anon;
grant execute on function public.process_agent_order(uuid, numeric, text, text, text, numeric, text) to authenticated, service_role;
revoke all on function public.transfer_commission(uuid, numeric) from public, anon;
grant execute on function public.transfer_commission(uuid, numeric) to authenticated, service_role;
revoke all on function public.withdraw_commission(uuid, numeric, text, text, text, text, text) from public, anon;
grant execute on function public.withdraw_commission(uuid, numeric, text, text, text, text, text) to authenticated, service_role;
revoke all on function public.get_wallet_dashboard_stats(uuid) from public, anon;
grant execute on function public.get_wallet_dashboard_stats(uuid) to authenticated, service_role;

-- Replace the remaining legacy ABS()-based service RPCs. A negative amount is
-- invalid input; it must never be silently turned into a debit or refund.
create or replace function public.reserve_agent_data_order(
  p_agent_id uuid,
  p_reference text,
  p_network_type text,
  p_phone text,
  p_volume_mb integer,
  p_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
  v_debit numeric;
  v_after numeric;
  v_order_id uuid;
begin
  if nullif(trim(p_reference), '') is null then raise exception 'Order reference is required.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Order amount must be a positive amount with at most two decimals.';
  end if;
  v_debit := round(p_amount, 2);

  select balance into v_balance from public.wallets where id = p_agent_id for update;
  if not found then raise exception 'Agent wallet not found.'; end if;
  if coalesce(v_balance, 0) < v_debit then raise exception 'Insufficient wallet balance'; end if;
  v_after := v_balance - v_debit;

  update public.wallets set balance = v_after, updated_at = now() where id = p_agent_id;
  insert into public.agent_data_orders
    (agent_id, provider_reference, network_type, phone, volume_mb, amount)
  values
    (p_agent_id, p_reference, p_network_type, p_phone, p_volume_mb, v_debit)
  returning id into v_order_id;

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after)
  values
    (p_agent_id, p_reference, 'debit', 'Data bundle purchase', v_debit, v_after);
  return v_order_id;
end;
$$;

create or replace function public.complete_agent_data_order(
  p_order_id uuid,
  p_success boolean,
  p_provider_response jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.agent_data_orders%rowtype;
begin
  select * into v_order from public.agent_data_orders where id = p_order_id for update;
  if not found or v_order.status <> 'processing' then return; end if;

  if p_success then
    update public.agent_data_orders
       set status = 'successful', provider_response = p_provider_response, completed_at = now()
     where id = p_order_id;
  else
    if v_order.amount is null or v_order.amount <= 0 then
      raise exception 'Cannot refund an invalid data order amount.';
    end if;
    perform public.refund_agent_wallet(
      v_order.agent_id,
      v_order.provider_reference,
      round(v_order.amount, 2),
      'Refund for failed data order ' || v_order.provider_reference
    );
    update public.agent_data_orders
       set status = 'failed', provider_response = p_provider_response, completed_at = now()
     where id = p_order_id;
  end if;
end;
$$;

create or replace function public.purchase_agent_airtime(
  p_agent_id uuid,
  p_reference text,
  p_phone text,
  p_network text,
  p_amount numeric,
  p_customer_name text default null,
  p_customer_email text default null
)
returns public.airtime_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet_balance numeric;
  v_debit numeric;
  v_order public.airtime_orders;
begin
  if nullif(trim(p_reference), '') is null then raise exception 'Airtime reference is required.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Airtime amount must be a positive amount with at most two decimals.';
  end if;
  v_debit := round(p_amount, 2);

  select balance into v_wallet_balance from public.wallets where id = p_agent_id for update;
  if not found then raise exception 'Agent wallet not found.'; end if;
  if coalesce(v_wallet_balance, 0) < v_debit then
    raise exception 'Insufficient wallet balance. Balance: GHS %, Required: GHS %', v_wallet_balance, v_debit;
  end if;

  update public.wallets set balance = balance - v_debit, updated_at = now() where id = p_agent_id;
  insert into public.airtime_orders (
    user_id, agent_id, payment_reference, recipient_phone, network,
    amount, fee_amount, gross_amount, payment_method, payment_status,
    airtime_status, customer_name, customer_email
  ) values (
    p_agent_id, p_agent_id, p_reference, p_phone, p_network,
    v_debit, 0.00, v_debit, 'wallet', 'paid', 'pending', p_customer_name, p_customer_email
  ) returning * into v_order;

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after)
  values
    (p_agent_id, p_reference, 'debit', 'Airtime purchase', v_debit, v_wallet_balance - v_debit);
  return v_order;
end;
$$;

-- The dashboard and payout RPCs also accept an agent id. Keep them usable by
-- the wallet page, but never let an authenticated caller read or mutate a
-- different agent's wallet by changing that id in the request.
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
  if p_agent_id is null then raise exception 'Agent ID is required'; end if;
  if auth.uid() is distinct from p_agent_id
     and not public.is_admin()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'You may only view your own wallet.';
  end if;

  perform public.ensure_agent_profile(p_agent_id);
  select agent_code into v_agent_code from public.agents where id = p_agent_id;
  select * into v_wallet from public.wallets where id = p_agent_id;

  select coalesce(sum(amount), 0) into v_deposits
    from public.wallet_topups where agent_id = p_agent_id and status = 'paid';
  if v_deposits > coalesce(v_wallet.deposits, 0) then v_wallet.deposits := v_deposits; end if;

  select coalesce(sum(amount), 0) into v_sales
    from public.orders
   where (agent_id = p_agent_id or agent_code = v_agent_code)
     and status in ('completed', 'success', 'paid');
  if v_sales > coalesce(v_wallet.sales, 0) then v_wallet.sales := v_sales; end if;

  select coalesce(sum(sale_amount), 0) into v_store_sales
    from public.store_orders
   where agent_id = p_agent_id and payment_status = 'paid';
  if v_store_sales > coalesce(v_wallet.store_sales, 0) then v_wallet.store_sales := v_store_sales; end if;

  update public.wallets
     set deposits = v_wallet.deposits,
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
  v_amount numeric(12,2);
begin
  if p_agent_id is null then raise exception 'Agent ID is required'; end if;
  if auth.uid() is distinct from p_agent_id
     and not public.is_admin()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'You may only withdraw your own commission.';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Withdrawal amount must be a positive amount with at most two decimals';
  end if;
  v_amount := round(p_amount, 2);

  select * into v_wallet from public.wallets where id = p_agent_id for update;
  if not found then raise exception 'Wallet not found.'; end if;
  if coalesce(v_wallet.commission_balance, 0) < v_amount then
    raise exception 'Insufficient commission balance. Current available: GHS %', v_wallet.commission_balance;
  end if;
  select agent_code into v_agent_code from public.agents where id = p_agent_id;

  update public.wallets
     set commission_balance = commission_balance - v_amount,
         withdrawn_commission = withdrawn_commission + v_amount,
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

  insert into public.agent_payouts
    (agent_id, amount, status, method, account_snapshot, reference, requested_at)
  values
    (p_agent_id, v_amount, 'pending', coalesce(p_payout_method, 'momo'), v_snapshot, v_ref, now());

  insert into public.transactions
    (agent_id, agent_code, reference, amount, type, status, metadata, created_at)
  values
    (p_agent_id, v_agent_code, v_ref, v_amount, 'Commission Withdrawal', 'pending', v_snapshot, now());

  return jsonb_build_object(
    'success', true,
    'reference', v_ref,
    'withdrawn_amount', v_amount,
    'commission_balance', v_wallet.commission_balance,
    'withdrawn_commission', v_wallet.withdrawn_commission
  );
end;
$$;
