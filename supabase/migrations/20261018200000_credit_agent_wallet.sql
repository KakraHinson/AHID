-- ============================================================================
-- Migration: Add credit_agent_wallet RPC for agent profit commissions
-- ============================================================================

create or replace function public.credit_agent_wallet(
  p_agent_id uuid,
  p_reference text,
  p_amount numeric,
  p_description text default null,
  p_meta jsonb default null
)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
begin
  if p_amount <= 0 then
    select coalesce(balance, 0) into v_balance from public.wallets where id = p_agent_id;
    return coalesce(v_balance, 0);
  end if;

  insert into public.wallets (id, balance) values (p_agent_id, p_amount)
  on conflict (id) do update
    set balance = public.wallets.balance + excluded.balance, updated_at = now()
  returning balance into v_balance;

  insert into public.wallet_transactions (agent_id, reference, type, description, amount, balance_after, status, meta)
  values (
    p_agent_id,
    p_reference,
    'credit',
    coalesce(p_description, 'Store sales profit'),
    p_amount,
    v_balance,
    'settled',
    coalesce(p_meta, '{}'::jsonb)
  )
  on conflict (reference) do nothing;

  return v_balance;
end;
$$;

revoke all on function public.credit_agent_wallet(uuid, text, numeric, text, jsonb) from public, anon, authenticated;
grant execute on function public.credit_agent_wallet(uuid, text, numeric, text, jsonb) to service_role;
