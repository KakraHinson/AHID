-- Wallet administration, inactive-agent enforcement, and provider-gated order
-- cancellation. Refunds are ledger entries and are idempotent per order.

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or exists (
        select 1
          from public.agents a
          left join auth.users u on u.id = a.id
         where a.id = auth.uid()
           and coalesce(a.is_active, true)
           and coalesce(a.status, 'active') = 'active'
           and (a.role in ('admin', 'super_admin')
                or lower(coalesce(u.email, '')) = 'seidumobiriahidu@gmail.com')
      );
$$;

create or replace function public.is_super_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or exists (
        select 1
          from public.agents a
          left join auth.users u on u.id = a.id
         where a.id = auth.uid()
           and coalesce(a.is_active, true)
           and coalesce(a.status, 'active') = 'active'
           and (a.role = 'super_admin'
                or lower(coalesce(u.email, '')) = 'seidumobiriahidu@gmail.com')
      );
$$;

create table if not exists public.admin_order_cancellations (
  id uuid primary key default gen_random_uuid(),
  order_type text not null,
  order_key text not null,
  agent_id uuid references auth.users(id) on delete set null,
  provider text,
  provider_reference text,
  provider_response jsonb,
  reason text not null,
  admin_id uuid references auth.users(id) on delete set null,
  refund_amount numeric(12,2) not null default 0 check (refund_amount >= 0),
  status text not null default 'refunded' check (status in ('refunded', 'not_refunded', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_type, order_key)
);

create index if not exists admin_order_cancellations_agent_idx
  on public.admin_order_cancellations(agent_id, created_at desc);

alter table public.admin_order_cancellations enable row level security;
drop policy if exists "Admins can view order cancellation audit" on public.admin_order_cancellations;
create policy "Admins can view order cancellation audit"
  on public.admin_order_cancellations for select to authenticated
  using (public.is_admin() or auth.uid() = agent_id);
grant select on public.admin_order_cancellations to authenticated, service_role;

create or replace function public.admin_finalize_order_cancellation(
  p_order_type text,
  p_order_id text,
  p_reason text default 'Cancelled by Administrator',
  p_admin_id uuid default auth.uid(),
  p_provider text default null,
  p_provider_reference text default null,
  p_provider_response jsonb default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_type text := lower(trim(coalesce(p_order_type, '')));
  v_key text := trim(coalesce(p_order_id, ''));
  v_status text;
  v_order_uuid uuid;
  v_agent_id uuid;
  v_reference text;
  v_amount numeric(12,2) := 0;
  v_wallet_debited boolean := true;
  v_refunded boolean := false;
  v_existing public.admin_order_cancellations%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Unauthorized: Administrator access required.';
  end if;
  if v_type = '' or v_key = '' then
    raise exception 'Order type and order id are required.';
  end if;

  select * into v_existing
    from public.admin_order_cancellations
   where order_type = v_type and order_key = v_key
   for update;
  if found then
    return jsonb_build_object(
      'success', true, 'idempotent', true, 'order_type', v_type,
      'order_id', v_key, 'refunded', v_existing.status = 'refunded',
      'refund_amount', v_existing.refund_amount,
      'message', 'This order cancellation was already processed.'
    );
  end if;

  if v_type in ('data', 'agent_data_orders') then
    select id, status, agent_id, provider_reference, amount
      into v_order_uuid, v_status, v_agent_id, v_reference, v_amount
      from public.agent_data_orders
     where id::text = v_key or provider_reference = v_key or short_code = v_key
     limit 1 for update;
    if v_order_uuid is null then raise exception 'Data order not found: %', v_key; end if;
    if lower(v_status) in ('successful', 'completed', 'delivered') then
      raise exception 'Cannot cancel a delivered data order.';
    end if;
    update public.agent_data_orders
       set status = 'cancelled', failure_reason = coalesce(nullif(trim(p_reason), ''), 'Cancelled by Administrator'), completed_at = now(), updated_at = now()
     where id = v_order_uuid;

  elsif v_type in ('instant_data', 'data_transactions') then
    select id, status, user_id, reference, amount
      into v_order_uuid, v_status, v_agent_id, v_reference, v_amount
      from public.data_transactions
     where id::text = v_key or reference = v_key or short_code = v_key
     limit 1 for update;
    if v_order_uuid is null then raise exception 'Instant data transaction not found: %', v_key; end if;
    if lower(v_status) in ('completed', 'successful', 'delivered') then raise exception 'Cannot cancel a completed instant data transaction.'; end if;
    update public.data_transactions
       set status = 'cancelled', failure_reason = coalesce(nullif(trim(p_reason), ''), 'Cancelled by Administrator'), updated_at = now()
     where id = v_order_uuid;

  elsif v_type in ('airtime', 'airtime_orders') then
    select id, airtime_status, agent_id, payment_reference, coalesce(wallet_charge_amount, gross_amount, amount)
      into v_order_uuid, v_status, v_agent_id, v_reference, v_amount
      from public.airtime_orders
     where id::text = v_key or payment_reference = v_key or short_code = v_key
     limit 1 for update;
    if v_order_uuid is null then raise exception 'Airtime order not found: %', v_key; end if;
    if lower(v_status) in ('delivered', 'successful', 'completed') then raise exception 'Cannot cancel a delivered airtime order.'; end if;
    update public.airtime_orders
       set airtime_status = 'failed', failure_reason = coalesce(nullif(trim(p_reason), ''), 'Cancelled by Administrator'), updated_at = now()
     where id = v_order_uuid;
    update public.service_commission_ledger
       set status = 'reversed', updated_at = now()
     where order_table = 'airtime_orders' and order_id = v_order_uuid and status <> 'reversed';

  elsif v_type in ('utility', 'utility_orders') then
    select id, status, coalesce(agent_id, user_id), payment_reference, coalesce(wallet_charge_amount, gross_amount, amount)
      into v_order_uuid, v_status, v_agent_id, v_reference, v_amount
      from public.utility_orders
     where id::text = v_key or payment_reference = v_key or short_code = v_key
     limit 1 for update;
    if v_order_uuid is null then raise exception 'Utility order not found: %', v_key; end if;
    if lower(v_status) in ('completed', 'successful') then raise exception 'Cannot cancel a completed utility bill settlement.'; end if;
    update public.utility_orders
       set status = 'cancelled', failure_reason = coalesce(nullif(trim(p_reason), ''), 'Cancelled by Administrator'), updated_at = now()
     where id = v_order_uuid;
    update public.service_commission_ledger
       set status = 'reversed', updated_at = now()
     where order_table = 'utility_orders' and order_id = v_order_uuid and status <> 'reversed';

  elsif v_type in ('afa', 'afa_registrations') then
    select id, status, created_by, reference, amount
      into v_order_uuid, v_status, v_agent_id, v_reference, v_amount
      from public.afa_registrations
     where id::text = v_key or reference = v_key
     limit 1 for update;
    if v_order_uuid is null then raise exception 'AFA registration not found: %', v_key; end if;
    if lower(v_status) in ('completed', 'successful', 'approved') then raise exception 'Cannot cancel an approved AFA registration.'; end if;
    update public.afa_registrations
       set status = 'Cancelled', failure_reason = coalesce(nullif(trim(p_reason), ''), 'Cancelled by Administrator'), updated_at = now()
     where id = v_order_uuid;

  elsif v_type in ('results', 'results_orders') then
    select id, status, agent_id, payment_reference, amount
      into v_order_uuid, v_status, v_agent_id, v_reference, v_amount
      from public.results_orders
     where id::text = v_key or payment_reference = v_key or short_code = v_key
     limit 1 for update;
    if v_order_uuid is null then raise exception 'Results checker order not found: %', v_key; end if;
    -- Sold PINs are permanent inventory records and must never be put back in stock.
    if lower(v_status) in ('paid', 'successful', 'completed') then raise exception 'Cannot cancel an issued results checker order; its PINs have already been sold.'; end if;
    update public.results_orders set status = 'failed' where id = v_order_uuid;

  elsif v_type in ('store_order', 'store_orders') then
    select id, fulfilment_status, agent_id, reference, platform_price, wallet_debited
      into v_order_uuid, v_status, v_agent_id, v_reference, v_amount, v_wallet_debited
      from public.store_orders
     where id::text = v_key or reference = v_key or short_code = v_key
     limit 1 for update;
    if v_order_uuid is null then raise exception 'Store order not found: %', v_key; end if;
    if lower(v_status) in ('successful', 'completed', 'delivered') then raise exception 'Cannot cancel a delivered store order.'; end if;
    update public.store_orders
       set payment_status = case when v_wallet_debited then 'refunded' else payment_status end,
           fulfilment_status = 'cancelled', refund_amount = case when v_wallet_debited then round(v_amount, 2) else 0 end,
           failure_reason = coalesce(nullif(trim(p_reason), ''), 'Cancelled by Administrator'), completed_at = now(), updated_at = now()
     where id = v_order_uuid;

  elsif v_type in ('public_data', 'public_data_orders') then
    select id, status, agent_id, payment_reference, sale_amount
      into v_order_uuid, v_status, v_agent_id, v_reference, v_amount
      from public.public_data_orders
     where id::text = v_key or payment_reference = v_key or short_code = v_key
     limit 1 for update;
    if v_order_uuid is null then raise exception 'Public data order not found: %', v_key; end if;
    if lower(v_status) in ('successful', 'completed', 'delivered') then raise exception 'Cannot cancel a completed public data order.'; end if;
    update public.public_data_orders
       set status = 'cancelled', provider_response = coalesce(provider_response, '{}'::jsonb) || jsonb_build_object(
         'adminCancelled', true, 'adminReason', coalesce(nullif(trim(p_reason), ''), 'Cancelled by Administrator'),
         'adminId', p_admin_id, 'cancelledAt', now()
       ), completed_at = now()
     where id = v_order_uuid;
  else
    raise exception 'Unsupported order type: %', p_order_type;
  end if;

  if v_agent_id is not null and v_amount > 0 and v_wallet_debited then
    perform public.refund_agent_wallet(
      v_agent_id, v_reference, round(v_amount, 2),
      'Refund: ' || coalesce(nullif(trim(p_reason), ''), 'Order cancelled by Administrator')
    );
    v_refunded := true;
  end if;

  insert into public.admin_order_cancellations
    (order_type, order_key, agent_id, provider, provider_reference, provider_response, reason, admin_id, refund_amount, status)
  values
    (v_type, v_key, v_agent_id, p_provider, coalesce(p_provider_reference, v_reference), p_provider_response,
     coalesce(nullif(trim(p_reason), ''), 'Cancelled by Administrator'), p_admin_id,
     case when v_refunded then round(v_amount, 2) else 0 end,
     case when v_refunded then 'refunded' else 'not_refunded' end);

  return jsonb_build_object(
    'success', true, 'order_type', v_type, 'order_id', v_key, 'refunded', v_refunded,
    'refund_amount', case when v_refunded then round(v_amount, 2) else 0 end,
    'provider', p_provider, 'provider_reference', coalesce(p_provider_reference, v_reference),
    'message', 'Order cancelled successfully' || case when v_refunded then ' and wallet refunded GHS ' || round(v_amount, 2) else '' end
  );
end;
$$;

revoke all on function public.admin_finalize_order_cancellation(text, text, text, uuid, text, text, jsonb) from public, anon;
grant execute on function public.admin_finalize_order_cancellation(text, text, text, uuid, text, text, jsonb) to service_role;
