-- ---------------------------------------------------------------------------
-- Credit agent storefront profit into the commission wallet
-- ---------------------------------------------------------------------------

alter table public.store_orders
  add column if not exists commission_credited boolean not null default false;

create index if not exists store_orders_profit_pending_idx
  on public.store_orders(agent_id, created_at desc)
  where product_type = 'data_bundle'
    and fulfilment_status = 'successful'
    and payment_status = 'paid'
    and commission_credited = false;

create or replace function public.credit_store_order_profit(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.store_orders%rowtype;
  v_wallet public.wallets%rowtype;
  v_amount numeric(12,2);
  v_agent_code text;
  v_reference text;
begin
  select * into v_order
    from public.store_orders
   where id = p_order_id
   for update;

  if not found then
    return jsonb_build_object('success', false, 'reason', 'order_not_found');
  end if;

  if v_order.commission_credited then
    return jsonb_build_object(
      'success', true,
      'credited', false,
      'duplicate', true,
      'amount', coalesce(v_order.agent_earning, 0)
    );
  end if;

  if v_order.product_type <> 'data_bundle'
     or (coalesce(v_order.meta ->> 'source', '') <> 'public_storefront'
         and v_order.reference not like 'STR-%')
     or v_order.fulfilment_status <> 'successful'
     or v_order.payment_status <> 'paid' then
    return jsonb_build_object('success', false, 'reason', 'order_not_eligible');
  end if;

  v_amount := round(coalesce(v_order.agent_earning, 0), 2);
  select agent_code into v_agent_code from public.agents where id = v_order.agent_id;

  select * into v_wallet
    from public.wallets
   where id = v_order.agent_id
   for update;

  if not found then
    insert into public.wallets(id) values (v_order.agent_id);
    select * into v_wallet from public.wallets where id = v_order.agent_id for update;
  end if;

  if v_amount > 0 then
    update public.wallets
       set commission_balance = commission_balance + v_amount,
           total_commission_earned = total_commission_earned + v_amount,
           updated_at = now()
     where id = v_order.agent_id
     returning * into v_wallet;

    v_reference := 'STORE-PROFIT-' || v_order.reference;

    insert into public.transactions
      (agent_id, agent_code, reference, amount, type, description,
       balance_before, balance_after, status, metadata, created_at, updated_at)
    values
      (v_order.agent_id, v_agent_code, v_reference, v_amount, 'Store Profit',
       'Profit from shared store order ' || v_order.reference,
       v_wallet.balance, v_wallet.balance, 'success',
       jsonb_build_object('store_order_id', v_order.id,
                          'order_reference', v_order.reference,
                          'source', 'public_storefront'), now(), now());

    insert into public.wallet_transactions
      (agent_id, reference, type, description, amount, balance_after, meta)
    values
      (v_order.agent_id, v_reference, 'credit',
       'Store profit from ' || coalesce(v_order.product_label, 'Data bundle'),
       v_amount, v_wallet.balance,
       jsonb_build_object('store_order_id', v_order.id,
                          'source', 'public_storefront'));
  end if;

  update public.store_orders
     set commission_credited = true,
         updated_at = now()
   where id = v_order.id;

  return jsonb_build_object(
    'success', true,
    'credited', v_amount > 0,
    'amount', v_amount,
    'commission_balance', coalesce(v_wallet.commission_balance, 0)
  );
end;
$$;
revoke all on function public.credit_store_order_profit(uuid) from public, anon, authenticated;
grant execute on function public.credit_store_order_profit(uuid) to service_role;

-- Reconcile successful public storefront orders created before this function
-- existed. The function is idempotent and locks each order/wallet row.
do $$
declare
  v_order record;
begin
  for v_order in
    select id
      from public.store_orders
     where product_type = 'data_bundle'
       and fulfilment_status = 'successful'
       and payment_status = 'paid'
       and commission_credited = false
       and (coalesce(meta ->> 'source', '') = 'public_storefront'
            or reference like 'STR-%')
  loop
    perform public.credit_store_order_profit(v_order.id);
  end loop;
end;
$$;
