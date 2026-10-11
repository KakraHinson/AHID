-- ---------------------------------------------------------------------------
-- Multi-gateway wallet funding: Paystack and Hubtel credit the wallet the same.
--
-- 1. wallet_topups gains provider_order_id, so a Hubtel callback can be matched
--    by either our client reference or Hubtel's own order id.
-- 2. fulfil_wallet_topup now records the real provider in the ledger and the
--    human-readable description, instead of hardcoding 'paystack'. A Hubtel
--    top-up previously would have been logged as "via Paystack".
-- ---------------------------------------------------------------------------

alter table public.wallet_topups add column if not exists provider_order_id text;

create index if not exists wallet_topups_provider_order_idx
  on public.wallet_topups(provider_order_id) where provider_order_id is not null;

create or replace function public.fulfil_wallet_topup(p_topup_id uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_topup public.wallet_topups%rowtype;
  v_balance numeric;
  v_provider text;
begin
  select * into v_topup from public.wallet_topups where id = p_topup_id for update;
  if not found then raise exception 'Wallet top-up not found'; end if;

  if v_topup.status = 'paid' then
    select coalesce(balance, 0) into v_balance from public.wallets where id = v_topup.agent_id;
    return v_balance;
  end if;

  v_provider := coalesce(nullif(v_topup.provider, ''), 'paystack');

  insert into public.wallets (id, balance) values (v_topup.agent_id, v_topup.amount)
  on conflict (id) do update
    set balance = public.wallets.balance + excluded.balance, updated_at = now()
  returning balance into v_balance;

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

  update public.wallet_topups set status = 'paid', paid_at = now() where id = v_topup.id;
  return v_balance;
end;
$$;

revoke all on function public.fulfil_wallet_topup(uuid) from public, anon, authenticated;
