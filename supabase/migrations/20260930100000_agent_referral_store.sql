-- Referral store accounting. Commission rates intentionally remain NULL until
-- the business rates are approved; referred checkout is fail-closed meanwhile.
create table if not exists public.service_commission_rates (
  service text primary key,
  label text not null,
  commission_percent numeric(7,3),
  hubtel_share_percent numeric(7,3),
  merchant_share_percent numeric(7,3),
  updated_at timestamptz not null default now(),
  constraint service_commission_rates_percent_check
    check (commission_percent is null or commission_percent between 0 and 100)
);

alter table public.service_commission_rates enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'service_commission_rates'
      and policyname = 'Signed in agents can view service commission rates'
  ) then
    create policy "Signed in agents can view service commission rates"
      on public.service_commission_rates for select to authenticated using (true);
  end if;
end $$;

insert into public.service_commission_rates (service, label, commission_percent) values
  ('gotv', 'GOtv', null),
  ('dstv', 'DStv', null),
  ('ecg_postpaid', 'ECG Postpaid', null),
  ('ecg_prepaid', 'ECG Prepaid', null),
  ('at_airtime', 'AT Airtime', null),
  ('mtn_airtime', 'MTN Airtime', null),
  ('vodafone_airtime', 'Vodafone Airtime', null),
  ('waec_results', 'WAEC Results', null),
  ('mtn_data', 'MTN Data', null),
  ('at_data', 'AT Data', null),
  ('vodafone_data', 'Vodafone Data', null),
  ('mtn_fiber_data', 'MTN Fiber Data', null),
  ('shs_placement', 'SHS Placement', null)
on conflict (service) do nothing;

alter table public.public_data_orders
  add column if not exists referral_agent_code text,
  add column if not exists commission_service text,
  add column if not exists commission_rate numeric(7,3),
  add column if not exists commission_before_deduction numeric(12,2),
  add column if not exists actual_commission numeric(12,2),
  add column if not exists hubtel_commission numeric(12,2),
  add column if not exists merchant_commission numeric(12,2),
  add column if not exists service_cost numeric(12,2),
  add column if not exists paystack_fee_amount numeric(12,2) not null default 0,
  add column if not exists paystack_gross_amount numeric(12,2),
  add column if not exists paystack_refund_status text not null default 'not_started',
  add column if not exists paystack_refund_id text,
  add column if not exists wallet_accounting_applied_at timestamptz,
  add column if not exists wallet_accounting_reversed_at timestamptz,
  add column if not exists provider_name text,
  add column if not exists provider_package_id text;

alter table public.public_data_orders
  drop constraint if exists public_data_orders_paystack_refund_status_check;
alter table public.public_data_orders
  add constraint public_data_orders_paystack_refund_status_check
  check (paystack_refund_status in ('not_started', 'processing', 'initiated', 'failed'));

create or replace function public.apply_referral_data_wallet_accounting(
  p_order_id uuid,
  p_service_cost numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.public_data_orders%rowtype;
  v_rate numeric;
  v_hubtel_share numeric;
  v_merchant_share numeric;
  v_multiplier numeric;
  v_before numeric;
  v_actual numeric;
  v_hubtel numeric;
  v_merchant numeric;
  v_balance numeric;
  v_after_cost numeric;
  v_after numeric;
  v_cost_reference text;
  v_commission_reference text;
begin
  if p_service_cost is null or p_service_cost <= 0 then
    raise exception 'Service cost must be greater than zero.';
  end if;

  select * into v_order from public.public_data_orders where id = p_order_id for update;
  if not found then raise exception 'Public data order not found.'; end if;
  if v_order.agent_id is null then
    return jsonb_build_object('applied', false, 'reason', 'no_referral');
  end if;
  if v_order.wallet_accounting_applied_at is not null then
    select coalesce(balance, 0) into v_balance from public.wallets where id = v_order.agent_id;
    return jsonb_build_object('applied', true, 'idempotent', true, 'walletBalance', v_balance);
  end if;
  if v_order.status <> 'processing' then
    raise exception 'Public data order is not ready for wallet settlement.';
  end if;

  select commission_percent, hubtel_share_percent, merchant_share_percent
  into v_rate, v_hubtel_share, v_merchant_share
  from public.service_commission_rates
  where service = v_order.commission_service;
  if v_rate is null then
    raise exception 'Commission rate is not configured for service %.', v_order.commission_service;
  end if;
  if v_hubtel_share is null or v_merchant_share is null then
    raise exception 'Commission split is not configured for service %.', v_order.commission_service;
  end if;

  v_multiplier := 1 + (v_rate / 100);
  v_before := round(v_order.sale_amount / v_multiplier, 2);
  v_actual := round(v_order.sale_amount - v_before, 2);
  v_hubtel := round(v_actual * v_hubtel_share / 100, 2);
  v_merchant := round(v_actual * v_merchant_share / 100, 2);

  select coalesce(balance, 0) into v_balance
  from public.wallets where id = v_order.agent_id for update;
  if not found then raise exception 'Referral agent wallet not found.'; end if;
  if v_balance - p_service_cost + v_merchant < 0 then
    raise exception 'Insufficient wallet balance for the service cost.';
  end if;

  v_after_cost := v_balance - p_service_cost;
  v_after := v_after_cost + v_merchant;
  update public.wallets set balance = v_after, updated_at = now() where id = v_order.agent_id;

  v_cost_reference := v_order.payment_reference || '-SERVICE-COST';
  v_commission_reference := v_order.payment_reference || '-COMMISSION';
  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, meta)
  values
    (v_order.agent_id, v_cost_reference, 'debit', 'Referral store service cost', p_service_cost,
     v_after_cost, jsonb_build_object('order_id', v_order.id, 'payment_reference', v_order.payment_reference,
       'customer_purchase', true, 'service', v_order.commission_service));

  if v_merchant > 0 then
    insert into public.wallet_transactions
      (agent_id, reference, type, description, amount, balance_after, meta)
    values
      (v_order.agent_id, v_commission_reference, 'credit', 'Referral store commission', v_merchant,
       v_after, jsonb_build_object('order_id', v_order.id, 'payment_reference', v_order.payment_reference,
         'sale_amount', v_order.sale_amount, 'commission_rate', v_rate,
         'commission_before_deduction', v_before, 'actual_commission', v_actual,
         'hubtel_commission', v_hubtel, 'merchant_commission', v_merchant));
  end if;

  update public.public_data_orders set
    commission_rate = v_rate,
    commission_before_deduction = v_before,
    actual_commission = v_actual,
    hubtel_commission = v_hubtel,
    merchant_commission = v_merchant,
    service_cost = p_service_cost,
    wallet_accounting_applied_at = now()
  where id = p_order_id;

  return jsonb_build_object('applied', true, 'walletBalance', v_after,
    'commissionRate', v_rate, 'commissionBeforeDeduction', v_before,
    'actualCommission', v_actual, 'hubtelCommission', v_hubtel,
    'merchantCommission', v_merchant, 'serviceCost', p_service_cost);
end;
$$;

create or replace function public.reverse_referral_data_wallet_accounting(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.public_data_orders%rowtype;
  v_balance numeric;
  v_after_cost_refund numeric;
  v_after numeric;
  v_cost_tx public.wallet_transactions%rowtype;
  v_commission_tx public.wallet_transactions%rowtype;
begin
  select * into v_order from public.public_data_orders where id = p_order_id for update;
  if not found then raise exception 'Public data order not found.'; end if;
  if v_order.agent_id is null or v_order.wallet_accounting_applied_at is null then
    return jsonb_build_object('reversed', false, 'reason', 'not_applied');
  end if;
  if v_order.wallet_accounting_reversed_at is not null then
    select coalesce(balance, 0) into v_balance from public.wallets where id = v_order.agent_id;
    return jsonb_build_object('reversed', true, 'idempotent', true, 'walletBalance', v_balance);
  end if;

  select * into v_cost_tx from public.wallet_transactions
  where agent_id = v_order.agent_id and reference = v_order.payment_reference || '-SERVICE-COST'
  for update;
  if not found then raise exception 'Service cost ledger entry not found.'; end if;
  select * into v_commission_tx from public.wallet_transactions
  where agent_id = v_order.agent_id and reference = v_order.payment_reference || '-COMMISSION'
  for update;

  select coalesce(balance, 0) into v_balance from public.wallets where id = v_order.agent_id for update;
  v_after_cost_refund := v_balance + v_order.service_cost;
  v_after := v_after_cost_refund - coalesce(v_order.merchant_commission, 0);
  if v_after < 0 then raise exception 'Wallet balance is insufficient to reverse the commission.'; end if;
  update public.wallets set balance = v_after, updated_at = now() where id = v_order.agent_id;

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, reversed_transaction_id, meta)
  values
    (v_order.agent_id, v_order.payment_reference || '-SERVICE-COST-REVERSAL', 'credit',
     'Refund of referral store service cost', v_order.service_cost, v_after_cost_refund,
     v_cost_tx.id, jsonb_build_object('order_id', v_order.id));
  update public.wallet_transactions set status = 'reversed' where id = v_cost_tx.id;

  if v_order.merchant_commission > 0 then
    if v_commission_tx.id is null then raise exception 'Commission ledger entry not found.'; end if;
    insert into public.wallet_transactions
      (agent_id, reference, type, description, amount, balance_after, reversed_transaction_id, meta)
    values
      (v_order.agent_id, v_order.payment_reference || '-COMMISSION-REVERSAL', 'debit',
       'Reverse referral store commission', v_order.merchant_commission, v_after,
       v_commission_tx.id, jsonb_build_object('order_id', v_order.id));
    update public.wallet_transactions set status = 'reversed' where id = v_commission_tx.id;
  end if;

  update public.public_data_orders set wallet_accounting_reversed_at = now() where id = p_order_id;
  return jsonb_build_object('reversed', true, 'walletBalance', v_after);
end;
$$;

create or replace function public.claim_public_data_paystack_refund(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  update public.public_data_orders
  set paystack_refund_status = 'processing'
  where id = p_order_id and status = 'failed'
    and paystack_refund_status in ('not_started', 'failed');
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.apply_referral_data_wallet_accounting(uuid, numeric) from public, anon, authenticated;
revoke all on function public.reverse_referral_data_wallet_accounting(uuid) from public, anon, authenticated;
revoke all on function public.claim_public_data_paystack_refund(uuid) from public, anon, authenticated;