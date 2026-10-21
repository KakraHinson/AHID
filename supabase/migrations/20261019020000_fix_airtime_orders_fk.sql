-- ============================================================================
-- Migration: Fix airtime_orders foreign key constraint and auto-provisioning
-- Created: 2026-10-19
-- Resolves: "insert or update on table 'airtime_orders' violates foreign key
--           constraint 'airtime_orders_agent_id_fkey'"
-- ============================================================================

-- 1. INSPECT & FIX FOREIGN KEY CONSTRAINTS
-- Root cause: airtime_orders_agent_id_fkey previously referenced public.agents(id).
-- Users authenticated via Supabase Auth live in auth.users(id). If their public.agents
-- row was not yet provisioned, inserting into airtime_orders failed with an FK violation.
-- By referencing auth.users(id) ON DELETE CASCADE, any active authenticated user/agent ID
-- is guaranteed valid, while cascade-deleting cleanly if an auth account is deleted.

alter table public.airtime_orders
  drop constraint if exists airtime_orders_agent_id_fkey;

alter table public.airtime_orders
  add constraint airtime_orders_agent_id_fkey
  foreign key (agent_id) references auth.users(id)
  on delete cascade;

alter table public.airtime_orders
  drop constraint if exists airtime_orders_user_id_fkey;

alter table public.airtime_orders
  add constraint airtime_orders_user_id_fkey
  foreign key (user_id) references auth.users(id)
  on delete cascade;

-- Ensure agents table schema aligns with auth users
alter table public.agents drop constraint if exists agents_phone_number_key;
alter table public.agents alter column phone_number drop not null;
alter table public.agents alter column agent_code drop not null;
alter table public.agents add column if not exists updated_at timestamptz not null default now();
alter table public.agents add column if not exists phone text;

-- 2. ENSURE AUTO-PROVISIONING HELPER (profiles, agents, wallets)
create or replace function public.ensure_agent_profile(
  p_user_id uuid,
  p_full_name text default null,
  p_phone text default null,
  p_agent_code text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_phone text;
  v_code text;
begin
  if p_user_id is null then
    return;
  end if;

  v_name := coalesce(nullif(trim(p_full_name), ''), 'Agent');
  v_phone := nullif(trim(p_phone), '');
  v_code := coalesce(nullif(trim(p_agent_code), ''), 'SKAI-' || upper(substr(replace(p_user_id::text, '-', ''), 1, 8)));

  -- Ensure profile exists
  insert into public.profiles (id, full_name, phone, agent_code)
  values (p_user_id, v_name, v_phone, v_code)
  on conflict (id) do update
  set
    full_name = coalesce(public.profiles.full_name, excluded.full_name),
    phone = coalesce(public.profiles.phone, excluded.phone),
    agent_code = coalesce(public.profiles.agent_code, excluded.agent_code),
    updated_at = now();

  -- Ensure agent exists with 'agent' role, preserving existing admin role & code
  insert into public.agents (id, full_name, phone, phone_number, agent_code, role)
  values (p_user_id, v_name, v_phone, v_phone, v_code, 'agent')
  on conflict (id) do update
  set
    full_name = coalesce(public.agents.full_name, excluded.full_name),
    phone = coalesce(public.agents.phone, excluded.phone, public.agents.phone_number),
    phone_number = coalesce(public.agents.phone_number, excluded.phone_number, public.agents.phone),
    agent_code = coalesce(public.agents.agent_code, excluded.agent_code),
    updated_at = now();

  -- Ensure wallet exists with 0.00 initial balance
  insert into public.wallets (id, balance)
  values (p_user_id, 0.00)
  on conflict (id) do nothing;
end;
$$;

revoke all on function public.ensure_agent_profile(uuid, text, text, text) from public;
grant execute on function public.ensure_agent_profile(uuid, text, text, text) to authenticated, anon, service_role;

-- 3. BACKFILL PROFILES, AGENTS, AND WALLETS FOR EXISTING AUTH USERS
do $$
declare
  u record;
  v_name text;
  v_phone text;
  v_code text;
begin
  for u in select id, email, raw_user_meta_data from auth.users loop
    v_name := coalesce(
      u.raw_user_meta_data->>'full_name',
      u.raw_user_meta_data->>'name',
      split_part(u.email, '@', 1),
      'Agent'
    );
    v_phone := coalesce(
      u.raw_user_meta_data->>'phone',
      u.raw_user_meta_data->>'phone_number',
      null
    );
    v_code := coalesce(
      u.raw_user_meta_data->>'agent_code',
      null
    );

    perform public.ensure_agent_profile(u.id, v_name, v_phone, v_code);
  end loop;
end;
$$;

-- 4. BEFORE INSERT TRIGGER ON airtime_orders TO AUTO-HEAL MISSING PARENT ROWS
create or replace function public.trg_airtime_orders_auto_heal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.agent_id is not null then
    perform public.ensure_agent_profile(new.agent_id, new.customer_name, new.recipient_phone, null);
  end if;
  if new.user_id is not null and new.user_id <> coalesce(new.agent_id, '00000000-0000-0000-0000-000000000000'::uuid) then
    perform public.ensure_agent_profile(new.user_id, new.customer_name, new.recipient_phone, null);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_airtime_orders_auto_heal on public.airtime_orders;
create trigger trg_airtime_orders_auto_heal
  before insert on public.airtime_orders
  for each row
  execute function public.trg_airtime_orders_auto_heal();

-- 5. UPDATE purchase_agent_airtime TO AUTO-PROVISION BEFORE WALLET CHARGE & INSERT
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
  v_order public.airtime_orders;
begin
  -- Auto-provision profile, agent, and wallet records if missing
  perform public.ensure_agent_profile(p_agent_id, p_customer_name, p_phone, null);

  -- Check and lock wallet balance
  select balance into v_wallet_balance
  from public.wallets
  where id = p_agent_id
  for update;

  if not found then
    raise exception 'Agent wallet not found.';
  end if;

  if v_wallet_balance < p_amount then
    raise exception 'Insufficient wallet balance. Balance: GHS %, Required: GHS %', v_wallet_balance, p_amount;
  end if;

  -- Deduct amount from wallet
  update public.wallets
  set
    balance = balance - p_amount,
    updated_at = now()
  where id = p_agent_id;

  -- Insert order record marked as paid
  insert into public.airtime_orders (
    user_id,
    agent_id,
    payment_reference,
    recipient_phone,
    network,
    amount,
    fee_amount,
    gross_amount,
    payment_method,
    payment_status,
    airtime_status,
    customer_name,
    customer_email
  ) values (
    p_agent_id,
    p_agent_id,
    p_reference,
    p_phone,
    p_network,
    p_amount,
    0.00,
    p_amount,
    'wallet',
    'paid',
    'pending',
    p_customer_name,
    p_customer_email
  )
  returning * into v_order;

  -- Log wallet debit transaction
  insert into public.wallet_transactions (
    agent_id,
    reference,
    type,
    description,
    amount,
    balance_after
  ) values (
    p_agent_id,
    p_reference,
    'debit',
    'Airtime purchase',
    p_amount,
    v_wallet_balance - p_amount
  );

  return v_order;
end;
$$;

-- 6. GRANT PERMISSIONS & RLS POLICIES ON airtime_orders
grant select, insert on public.airtime_orders to authenticated;
grant select on public.airtime_orders to anon;

alter table public.airtime_orders enable row level security;

drop policy if exists "Users and agents can insert own airtime orders" on public.airtime_orders;
create policy "Users and agents can insert own airtime orders"
  on public.airtime_orders for insert
  to authenticated
  with check (
    auth.uid() = user_id or auth.uid() = agent_id
  );

drop policy if exists "Users can view own airtime orders" on public.airtime_orders;
drop policy if exists "Users and agents can view own airtime orders" on public.airtime_orders;
create policy "Users and agents can view own airtime orders"
  on public.airtime_orders for select
  to authenticated
  using (
    auth.uid() = user_id or auth.uid() = agent_id or public.is_admin()
  );
