-- Replace the retired agent_wallets dependency with the canonical wallets
-- table. The RPC remains available for older clients while sharing the same
-- row lock and balance checks as the current wallet flows.

drop view if exists public.agent_wallets;

create or replace function public.process_agent_order_deduction(
  p_agent_id text,
  p_order_amount numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent_id uuid;
  v_current_balance numeric;
  v_new_balance numeric;
begin
  if p_order_amount is null or p_order_amount <= 0 then
    raise exception 'Invalid order amount: %', p_order_amount;
  end if;

  begin
    v_agent_id := p_agent_id::uuid;
  exception when invalid_text_representation then
    raise exception 'Invalid agent ID';
  end;

  select balance into v_current_balance
  from public.wallets
  where id = v_agent_id
  for update;

  if v_current_balance is null then
    raise exception 'Agent wallet not found';
  elsif v_current_balance < p_order_amount then
    raise exception 'Insufficient balance. Current balance: %, Order amount: %', v_current_balance, p_order_amount;
  end if;

  v_new_balance := v_current_balance - p_order_amount;

  update public.wallets
  set balance = v_new_balance,
      updated_at = now()
  where id = v_agent_id;

  return v_new_balance;
end;
$$;
