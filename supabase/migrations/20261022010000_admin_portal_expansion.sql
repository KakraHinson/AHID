-- Migration: 20261022010000_admin_portal_expansion.sql
-- Adds:
-- 1. Agent status & active columns for suspension/cancellation.
-- 2. Admin RLS policies on result_checker_pins, results_orders, afa_registrations, agent_payouts, agent_stores, store_orders.
-- 3. Stored procedures for Admin Order Cancellation with automatic wallet refunding.
-- 4. Stored procedure for Agent Cancellation / Suspension.
-- 5. Stored procedure for Commission Withdrawal decision (Approve & Mark Paid / Reject & Refund).

-- 1. Add status and is_active to public.agents
alter table public.agents add column if not exists is_active boolean not null default true;
alter table public.agents add column if not exists status text not null default 'active';
alter table public.agents drop constraint if exists agents_status_check;
alter table public.agents add constraint agents_status_check check (status in ('active', 'suspended', 'cancelled'));

-- 2. RLS Policies for Admins using public.is_admin()

-- result_checker_pins
alter table public.result_checker_pins enable row level security;
drop policy if exists "Admins have full access to result_checker_pins" on public.result_checker_pins;
create policy "Admins have full access to result_checker_pins"
  on public.result_checker_pins for all
  using (public.is_admin())
  with check (public.is_admin());

-- results_orders
alter table public.results_orders enable row level security;
drop policy if exists "Admins can view and manage results_orders" on public.results_orders;
create policy "Admins can view and manage results_orders"
  on public.results_orders for all
  using (public.is_admin() or auth.uid() = agent_id)
  with check (public.is_admin());

-- afa_registrations
alter table public.afa_registrations enable row level security;
drop policy if exists "Admins can manage all afa_registrations" on public.afa_registrations;
create policy "Admins can manage all afa_registrations"
  on public.afa_registrations for all
  using (public.is_admin() or auth.uid() = created_by)
  with check (public.is_admin() or auth.uid() = created_by);

-- agent_payouts
alter table public.agent_payouts enable row level security;
drop policy if exists "Admins manage all payouts via is_admin" on public.agent_payouts;
create policy "Admins manage all payouts via is_admin"
  on public.agent_payouts for all
  using (public.is_admin() or auth.uid() = agent_id)
  with check (public.is_admin());

-- agent_stores
alter table if exists public.agent_stores enable row level security;
drop policy if exists "Admins manage all agent_stores via is_admin" on public.agent_stores;
create policy "Admins manage all agent_stores via is_admin"
  on public.agent_stores for all
  using (public.is_admin() or auth.uid() = agent_id)
  with check (public.is_admin());

-- store_orders
alter table if exists public.store_orders enable row level security;
drop policy if exists "Admins manage all store_orders via is_admin" on public.store_orders;
create policy "Admins manage all store_orders via is_admin"
  on public.store_orders for all
  using (public.is_admin() or exists (
    select 1 from public.agent_stores s where s.id = store_orders.store_id and s.agent_id = auth.uid()
  ))
  with check (public.is_admin());

-- 3. Stored Procedure: Cancel Order across any service and refund wallet if applicable
create or replace function public.admin_cancel_order(
  p_order_type text,
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
  v_refunded boolean := false;
  v_refund_amount numeric := 0;
  v_target_user_id uuid := null;
  v_ref text;
  v_curr_status text;
begin
  if not public.is_admin() then
    raise exception 'Unauthorized: Administrator access required.';
  end if;

  if p_order_type = 'data' or p_order_type = 'agent_data_orders' then
    -- Check agent_data_orders
    select status, agent_id, amount, provider_reference into v_curr_status, v_target_user_id, v_refund_amount, v_ref
    from public.agent_data_orders
    where id::text = p_order_id or provider_reference = p_order_id or short_code = p_order_id
    limit 1;

    if v_curr_status is null then
      raise exception 'Data order not found: %', p_order_id;
    end if;

    if v_curr_status in ('successful', 'completed', 'delivered') then
      raise exception 'Cannot cancel a delivered data order.';
    end if;

    update public.agent_data_orders
    set status = 'cancelled',
        failure_reason = p_reason,
        completed_at = now()
    where id::text = p_order_id or provider_reference = p_order_id or short_code = p_order_id;

    -- Refund agent wallet if not already refunded
    if v_target_user_id is not null and v_refund_amount > 0 and v_curr_status != 'cancelled' and v_curr_status != 'failed' then
      update public.wallets
      set balance = balance + v_refund_amount,
          updated_at = now()
      where id = v_target_user_id;

      insert into public.wallet_transactions (
        agent_id, reference, type, description, amount, balance_after
      )
      select v_target_user_id, 'REF-' || coalesce(v_ref, p_order_id), 'credit',
             'Refund: Cancelled Data Order (' || coalesce(v_ref, p_order_id) || ')',
             v_refund_amount, w.balance
      from public.wallets w where w.id = v_target_user_id;

      v_refunded := true;
    end if;

  elsif p_order_type = 'instant_data' or p_order_type = 'data_transactions' then
    select status, user_id, amount, reference into v_curr_status, v_target_user_id, v_refund_amount, v_ref
    from public.data_transactions
    where id::text = p_order_id or reference = p_order_id or short_code = p_order_id
    limit 1;

    if v_curr_status is null then
      raise exception 'Instant data transaction not found: %', p_order_id;
    end if;

    if v_curr_status in ('completed', 'successful', 'delivered') then
      raise exception 'Cannot cancel a completed instant data transaction.';
    end if;

    update public.data_transactions
    set status = 'cancelled',
        failure_reason = p_reason,
        updated_at = now()
    where id::text = p_order_id or reference = p_order_id or short_code = p_order_id;

    if v_target_user_id is not null and v_refund_amount > 0 and v_curr_status != 'cancelled' and v_curr_status != 'failed' then
      update public.wallets
      set balance = balance + v_refund_amount,
          updated_at = now()
      where id = v_target_user_id;

      insert into public.wallet_transactions (
        agent_id, reference, type, description, amount, balance_after
      )
      select v_target_user_id, 'REF-' || coalesce(v_ref, p_order_id), 'credit',
             'Refund: Cancelled Instant Data (' || coalesce(v_ref, p_order_id) || ')',
             v_refund_amount, w.balance
      from public.wallets w where w.id = v_target_user_id;

      v_refunded := true;
    end if;

  elsif p_order_type = 'utility' or p_order_type = 'utility_orders' then
    select status, user_id, amount, payment_reference into v_curr_status, v_target_user_id, v_refund_amount, v_ref
    from public.utility_orders
    where id::text = p_order_id or payment_reference = p_order_id or short_code = p_order_id
    limit 1;

    if v_curr_status is null then
      raise exception 'Utility order not found: %', p_order_id;
    end if;

    if v_curr_status in ('completed', 'successful') then
      raise exception 'Cannot cancel a completed utility bill settlement.';
    end if;

    update public.utility_orders
    set status = 'cancelled',
        failure_reason = p_reason,
        updated_at = now()
    where id::text = p_order_id or payment_reference = p_order_id or short_code = p_order_id;

    if v_target_user_id is not null and v_refund_amount > 0 and v_curr_status != 'cancelled' and v_curr_status != 'failed' then
      update public.wallets
      set balance = balance + v_refund_amount,
          updated_at = now()
      where id = v_target_user_id;

      insert into public.wallet_transactions (
        agent_id, reference, type, description, amount, balance_after
      )
      select v_target_user_id, 'REF-' || coalesce(v_ref, p_order_id), 'credit',
             'Refund: Cancelled Utility Order (' || coalesce(v_ref, p_order_id) || ')',
             v_refund_amount, w.balance
      from public.wallets w where w.id = v_target_user_id;

      v_refunded := true;
    end if;

  elsif p_order_type = 'airtime' or p_order_type = 'airtime_orders' then
    select airtime_status, agent_id, amount, payment_reference into v_curr_status, v_target_user_id, v_refund_amount, v_ref
    from public.airtime_orders
    where id::text = p_order_id or payment_reference = p_order_id or short_code = p_order_id
    limit 1;

    if v_curr_status is null then
      raise exception 'Airtime order not found: %', p_order_id;
    end if;

    if v_curr_status in ('delivered', 'successful') then
      raise exception 'Cannot cancel a delivered airtime order.';
    end if;

    update public.airtime_orders
    set airtime_status = 'failed',
        failure_reason = p_reason,
        updated_at = now()
    where id::text = p_order_id or payment_reference = p_order_id or short_code = p_order_id;

    if v_target_user_id is not null and v_refund_amount > 0 and v_curr_status != 'failed' then
      update public.wallets
      set balance = balance + v_refund_amount,
          updated_at = now()
      where id = v_target_user_id;

      insert into public.wallet_transactions (
        agent_id, reference, type, description, amount, balance_after
      )
      select v_target_user_id, 'REF-' || coalesce(v_ref, p_order_id), 'credit',
             'Refund: Cancelled Airtime Order (' || coalesce(v_ref, p_order_id) || ')',
             v_refund_amount, w.balance
      from public.wallets w where w.id = v_target_user_id;

      v_refunded := true;
    end if;

  elsif p_order_type = 'afa' or p_order_type = 'afa_registrations' then
    select status, created_by, amount, reference into v_curr_status, v_target_user_id, v_refund_amount, v_ref
    from public.afa_registrations
    where id::text = p_order_id or reference = p_order_id
    limit 1;

    if v_curr_status is null then
      raise exception 'AFA registration not found: %', p_order_id;
    end if;

    if v_curr_status in ('Completed', 'successful') then
      raise exception 'Cannot cancel a completed AFA registration.';
    end if;

    update public.afa_registrations
    set status = 'Cancelled',
        failure_reason = p_reason,
        updated_at = now()
    where id::text = p_order_id or reference = p_order_id;

    if v_target_user_id is not null and v_refund_amount > 0 and v_curr_status != 'Cancelled' then
      update public.wallets
      set balance = balance + v_refund_amount,
          updated_at = now()
      where id = v_target_user_id;

      insert into public.wallet_transactions (
        agent_id, reference, type, description, amount, balance_after
      )
      select v_target_user_id, 'REF-' || coalesce(v_ref, p_order_id), 'credit',
             'Refund: Cancelled AFA Registration (' || coalesce(v_ref, p_order_id) || ')',
             v_refund_amount, w.balance
      from public.wallets w where w.id = v_target_user_id;

      v_refunded := true;
    end if;

  elsif p_order_type = 'results' or p_order_type = 'results_orders' then
    select status, agent_id, amount, payment_reference into v_curr_status, v_target_user_id, v_refund_amount, v_ref
    from public.results_orders
    where id::text = p_order_id or payment_reference = p_order_id
    limit 1;

    if v_curr_status is null then
      raise exception 'Results checker order not found: %', p_order_id;
    end if;

    update public.results_orders
    set status = 'failed'
    where id::text = p_order_id or payment_reference = p_order_id;

    -- Return any reserved pins back to available
    update public.result_checker_pins
    set status = 'available', result_order_id = null, sold_at = null
    where result_order_id::text = p_order_id;

    if v_target_user_id is not null and v_refund_amount > 0 and v_curr_status != 'failed' then
      update public.wallets
      set balance = balance + v_refund_amount,
          updated_at = now()
      where id = v_target_user_id;

      v_refunded := true;
    end if;

  else
    raise exception 'Unsupported order type: %', p_order_type;
  end if;

  return jsonb_build_object(
    'success', true,
    'order_type', p_order_type,
    'order_id', p_order_id,
    'refunded', v_refunded,
    'refund_amount', v_refund_amount,
    'message', 'Order cancelled successfully' || (case when v_refunded then ' and wallet refunded GHS ' || v_refund_amount else '' end)
  );
end;
$$;

revoke all on function public.admin_cancel_order(text, text, text, uuid) from public, anon;
grant execute on function public.admin_cancel_order(text, text, text, uuid) to authenticated, service_role;


-- 4. Stored Procedure: Admin Manage Agent (Cancel, Suspend, Reactivate)
create or replace function public.admin_manage_agent(
  p_agent_id uuid,
  p_status text, -- 'active', 'suspended', 'cancelled'
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_role text;
begin
  if not public.is_admin() then
    raise exception 'Unauthorized: Administrator access required.';
  end if;

  if p_status not in ('active', 'suspended', 'cancelled') then
    raise exception 'Invalid status. Must be active, suspended, or cancelled.';
  end if;

  select u.email, a.role into v_email, v_role
  from public.agents a
  left join auth.users u on u.id = a.id
  where a.id = p_agent_id;

  if lower(coalesce(v_email, '')) = 'seidumobiriahidu@gmail.com' then
    raise exception 'Cannot suspend or cancel the primary Super Admin owner.';
  end if;

  update public.agents
  set status = p_status,
      is_active = (p_status = 'active'),
      updated_at = now()
  where id = p_agent_id;

  -- Toggle corresponding agent store if exists
  if p_status != 'active' then
    update public.agent_stores
    set is_active = false,
        suspended_reason = coalesce(nullif(p_reason, ''), 'Agent account ' || p_status)
    where agent_id = p_agent_id;
  else
    update public.agent_stores
    set is_active = true,
        suspended_reason = null
    where agent_id = p_agent_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'agent_id', p_agent_id,
    'status', p_status,
    'is_active', (p_status = 'active'),
    'message', 'Agent ' || p_status || ' successfully.'
  );
end;
$$;

revoke all on function public.admin_manage_agent(uuid, text, text) from public, anon;
grant execute on function public.admin_manage_agent(uuid, text, text) to authenticated, service_role;


-- 5. Stored Procedure: Admin Decide Payout (Commission Withdrawal)
create or replace function public.admin_decide_payout(
  p_payout_id uuid,
  p_decision text, -- 'paid', 'processing', 'rejected'
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout public.agent_payouts%rowtype;
  v_new_status text;
begin
  if not public.is_admin() then
    raise exception 'Unauthorized: Administrator access required.';
  end if;

  select * into v_payout
  from public.agent_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception 'Payout request not found: %', p_payout_id;
  end if;

  if v_payout.status in ('paid', 'rejected') then
    raise exception 'This payout request has already been finalized as %', v_payout.status;
  end if;

  if p_decision = 'paid' then
    update public.agent_payouts
    set status = 'paid',
        paid_at = now(),
        admin_note = coalesce(nullif(p_note, ''), admin_note),
        reviewed_at = now(),
        reviewed_by = auth.uid()
    where id = p_payout_id;

    -- Update transaction record if matching reference
    update public.transactions
    set status = 'success',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('paid_at', now(), 'admin_note', p_note)
    where reference = v_payout.reference;

    v_new_status := 'paid';

  elsif p_decision = 'rejected' or p_decision = 'failed' then
    -- Refund the deducted commission back to the agent's wallet
    update public.wallets
    set commission_balance = commission_balance + v_payout.amount,
        withdrawn_commission = greatest(0, withdrawn_commission - v_payout.amount),
        updated_at = now()
    where id = v_payout.agent_id;

    update public.agent_payouts
    set status = 'rejected',
        admin_note = coalesce(nullif(p_note, ''), 'Rejected by admin: ' || p_note),
        reviewed_at = now(),
        reviewed_by = auth.uid()
    where id = p_payout_id;

    update public.transactions
    set status = 'failed',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('rejected_at', now(), 'rejection_reason', p_note)
    where reference = v_payout.reference;

    v_new_status := 'rejected';

  elsif p_decision = 'processing' then
    update public.agent_payouts
    set status = 'processing',
        admin_note = coalesce(nullif(p_note, ''), admin_note),
        reviewed_at = now(),
        reviewed_by = auth.uid()
    where id = p_payout_id;

    v_new_status := 'processing';

  else
    raise exception 'Invalid payout decision: %. Must be paid, processing, or rejected.', p_decision;
  end if;

  return jsonb_build_object(
    'success', true,
    'payout_id', p_payout_id,
    'status', v_new_status,
    'message', 'Payout updated to ' || v_new_status
  );
end;
$$;

revoke all on function public.admin_decide_payout(uuid, text, text) from public, anon;
grant execute on function public.admin_decide_payout(uuid, text, text) to authenticated, service_role;
