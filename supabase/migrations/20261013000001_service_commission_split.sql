-- The commission split (share of the actual commission kept by the platform vs
-- paid to the merchant) is supplied by Hubtel when the business rates are
-- approved. Remove the placeholder 30/70 split and read the shares from the
-- service_commission_rates table instead; the referral path stays fail-closed
-- until both the commission percent and the split are configured.

alter table public.service_commission_rates
  add column if not exists hubtel_share_percent numeric(7,3),
  add column if not exists merchant_share_percent numeric(7,3);

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

revoke all on function public.apply_referral_data_wallet_accounting(uuid, numeric) from public, anon, authenticated;
