-- ---------------------------------------------------------------------------
-- Live Price & Commission Control
-- ---------------------------------------------------------------------------
-- `bundle_catalog` remains the single source of truth for Standard Data
-- selling prices. This migration makes the existing commission table the
-- single source for live airtime/utility rates and records the exact wallet
-- discount on every order.

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

alter table public.service_commission_rates
  add column if not exists agent_share_percent numeric(7,3);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'service_commission_rates_agent_share_check'
       and conrelid = 'public.service_commission_rates'::regclass
  ) then
    alter table public.service_commission_rates
      add constraint service_commission_rates_agent_share_check
      check (agent_share_percent is null or agent_share_percent between 0 and 100);
  end if;
end $$;

alter table public.service_commission_rates enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'service_commission_rates'
       and policyname = 'Signed in agents can view service commission rates'
  ) then
    create policy "Signed in agents can view service commission rates"
      on public.service_commission_rates for select to authenticated using (true);
  end if;
end $$;

-- Existing code used merchant_share_percent for the agent's share. Keep it as
-- a compatibility mirror while exposing the clearer agent_share_percent name.
update public.service_commission_rates
   set agent_share_percent = coalesce(agent_share_percent, merchant_share_percent, 0),
       merchant_share_percent = coalesce(merchant_share_percent, agent_share_percent, 0),
       hubtel_share_percent = coalesce(hubtel_share_percent, 100 - coalesce(agent_share_percent, merchant_share_percent, 0)),
       updated_at = now()
 where agent_share_percent is null
    or merchant_share_percent is null
    or hubtel_share_percent is null;

-- The supplied values are decimal percentages in business notation:
-- 0.171 = 17.1%, 0.0007 = 0.07%, and 0.05 = 5%.
insert into public.service_commission_rates
  (service, label, commission_percent, agent_share_percent, merchant_share_percent, hubtel_share_percent)
values
  ('ecg_prepaid', 'ECG Prepaid', 17.100, 0, 0, 100),
  ('ecg_postpaid', 'ECG Postpaid', 17.100, 0, 0, 100),
  ('ghana_water', 'Ghana Water', 0.070, 0, 0, 100),
  ('startimes', 'StarTimes', 35.000, 0, 0, 100),
  ('gotv', 'GOtv', 35.000, 0, 0, 100),
  ('dstv', 'DStv', 35.000, 0, 0, 100),
  ('mtn_airtime', 'MTN Airtime', 5.000, 0, 0, 100),
  ('telecel_airtime', 'Telecel Airtime', 2.800, 0, 0, 100),
  ('airteltigo_airtime', 'AirtelTigo Airtime', 35.000, 0, 0, 100),
  -- Legacy keys stay aligned for older referral rows and admin screens.
  ('at_airtime', 'AirtelTigo Airtime', 35.000, 0, 0, 100),
  ('vodafone_airtime', 'Telecel Airtime', 2.800, 0, 0, 100)
on conflict (service) do update set
  label = excluded.label,
  commission_percent = excluded.commission_percent,
  agent_share_percent = coalesce(public.service_commission_rates.agent_share_percent, excluded.agent_share_percent),
  merchant_share_percent = coalesce(public.service_commission_rates.merchant_share_percent, excluded.merchant_share_percent),
  hubtel_share_percent = coalesce(public.service_commission_rates.hubtel_share_percent, excluded.hubtel_share_percent),
  updated_at = now();

-- Every new transaction stores the requested amount, provider commission,
-- agent benefit, and actual wallet debit. Existing rows are backfilled so
-- status/refund paths can use the correct amount without schema errors.
alter table public.airtime_orders
  add column if not exists commission_service text,
  add column if not exists commission_rate_percent numeric(7,3) not null default 0,
  add column if not exists commission_amount numeric(12,2) not null default 0,
  add column if not exists agent_commission_amount numeric(12,2) not null default 0,
  add column if not exists platform_commission_amount numeric(12,2) not null default 0,
  add column if not exists wallet_charge_amount numeric(12,2);

alter table public.utility_orders
  add column if not exists commission_service text,
  add column if not exists commission_rate_percent numeric(7,3) not null default 0,
  add column if not exists commission_amount numeric(12,2) not null default 0,
  add column if not exists agent_commission_amount numeric(12,2) not null default 0,
  add column if not exists platform_commission_amount numeric(12,2) not null default 0,
  add column if not exists wallet_charge_amount numeric(12,2);

update public.airtime_orders
   set wallet_charge_amount = coalesce(wallet_charge_amount, gross_amount, amount)
 where wallet_charge_amount is null;

update public.utility_orders
   set wallet_charge_amount = coalesce(wallet_charge_amount, gross_amount, amount)
 where wallet_charge_amount is null;

alter table public.airtime_orders
  alter column wallet_charge_amount set default 0;
alter table public.utility_orders
  alter column wallet_charge_amount set default 0;

create table if not exists public.service_commission_ledger (
  id uuid primary key default gen_random_uuid(),
  order_table text not null check (order_table in ('airtime_orders', 'utility_orders')),
  order_id uuid not null,
  reference text not null,
  agent_id uuid references auth.users(id) on delete set null,
  service text not null,
  transaction_amount numeric(12,2) not null check (transaction_amount >= 0),
  commission_rate_percent numeric(7,3) not null default 0,
  commission_amount numeric(12,2) not null default 0 check (commission_amount >= 0),
  agent_share_percent numeric(7,3) not null default 0 check (agent_share_percent between 0 and 100),
  agent_commission_amount numeric(12,2) not null default 0 check (agent_commission_amount >= 0),
  platform_commission_amount numeric(12,2) not null default 0 check (platform_commission_amount >= 0),
  wallet_charge_amount numeric(12,2) not null default 0 check (wallet_charge_amount >= 0),
  status text not null default 'pending' check (status in ('pending', 'earned', 'reversed')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (order_table, order_id),
  unique (reference)
);

create index if not exists service_commission_ledger_agent_created_idx
  on public.service_commission_ledger(agent_id, created_at desc);

alter table public.service_commission_ledger enable row level security;

drop policy if exists "Agents can view their own commission ledger" on public.service_commission_ledger;
create policy "Agents can view their own commission ledger"
  on public.service_commission_ledger for select
  to authenticated using (auth.uid() = agent_id);

drop policy if exists "Admins can view commission ledger" on public.service_commission_ledger;
create policy "Admins can view commission ledger"
  on public.service_commission_ledger for select
  to authenticated using (public.is_admin());

-- Replace the old seven-argument RPC with a backward-compatible function that
-- computes the wallet debit from the live commission row and records it.
drop function if exists public.purchase_agent_airtime(uuid, text, text, text, numeric, text, text);

create or replace function public.purchase_agent_airtime(
  p_agent_id uuid,
  p_reference text,
  p_phone text,
  p_network text,
  p_amount numeric,
  p_customer_name text default null,
  p_customer_email text default null,
  p_commission_service text default null
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
  v_service text;
  v_rate numeric := 0;
  v_agent_share numeric := 0;
  v_commission numeric := 0;
  v_agent_commission numeric := 0;
  v_platform_commission numeric := 0;
begin
  if nullif(trim(p_reference), '') is null then raise exception 'Airtime reference is required.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Airtime amount must be a positive amount with at most two decimals.';
  end if;

  v_service := coalesce(nullif(trim(p_commission_service), ''),
    case lower(p_network)
      when 'mtn' then 'mtn_airtime'
      when 'telecel' then 'telecel_airtime'
      when 'at' then 'airteltigo_airtime'
      else null
    end);

  select commission_percent, coalesce(agent_share_percent, merchant_share_percent, 0)
    into v_rate, v_agent_share
    from public.service_commission_rates
   where service = v_service;

  v_rate := greatest(0, least(coalesce(v_rate, 0), 100));
  v_agent_share := greatest(0, least(coalesce(v_agent_share, 0), 100));
  v_commission := round(p_amount * v_rate / 100, 2);
  v_agent_commission := round(v_commission * v_agent_share / 100, 2);
  v_platform_commission := greatest(0, round(v_commission - v_agent_commission, 2));
  v_debit := greatest(0, round(p_amount - v_agent_commission, 2));

  select balance into v_wallet_balance from public.wallets where id = p_agent_id for update;
  if not found then raise exception 'Agent wallet not found.'; end if;
  if coalesce(v_wallet_balance, 0) < v_debit then
    raise exception 'Insufficient wallet balance. Balance: GHS %, Required: GHS %', v_wallet_balance, v_debit;
  end if;

  if v_debit > 0 then
    update public.wallets set balance = balance - v_debit, updated_at = now() where id = p_agent_id;
    insert into public.wallet_transactions
      (agent_id, reference, type, description, amount, balance_after, meta)
    values
      (p_agent_id, p_reference, 'debit', 'Airtime purchase', v_debit, v_wallet_balance - v_debit,
       jsonb_build_object('service', v_service, 'commission_amount', v_commission,
         'agent_commission_amount', v_agent_commission));
  end if;

  insert into public.airtime_orders (
    user_id, agent_id, payment_reference, recipient_phone, network,
    amount, fee_amount, gross_amount, wallet_charge_amount,
    commission_service, commission_rate_percent, commission_amount,
    agent_commission_amount, platform_commission_amount,
    payment_method, payment_status, airtime_status, customer_name, customer_email
  ) values (
    p_agent_id, p_agent_id, p_reference, p_phone, p_network,
    round(p_amount, 2), 0.00, round(p_amount, 2), v_debit,
    v_service, v_rate, v_commission, v_agent_commission, v_platform_commission,
    'wallet', 'paid', 'pending', p_customer_name, p_customer_email
  ) returning * into v_order;
  return v_order;
end;
$$;

revoke all on function public.purchase_agent_airtime(uuid, text, text, text, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public.purchase_agent_airtime(uuid, text, text, text, numeric, text, text, text) to service_role;
