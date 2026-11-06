-- Make the admin wallet tools self-healing on older Supabase projects and
-- expose one durable source for the admin wallet-history API.

create table if not exists public.wallets (
  id uuid primary key references auth.users(id) on delete cascade,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wallets
  add column if not exists sales numeric(12,2) not null default 0,
  add column if not exists deposits numeric(12,2) not null default 0,
  add column if not exists overdraft numeric(12,2) not null default 0,
  add column if not exists commission_balance numeric(12,2) not null default 0,
  add column if not exists total_commission_earned numeric(12,2) not null default 0,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references auth.users(id) on delete cascade,
  reference text not null unique,
  type text not null check (type in ('debit', 'credit')),
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  balance_after numeric(12,2) not null,
  status text not null default 'settled' check (status in ('settled', 'refunded', 'reversed')),
  reversed_transaction_id uuid references public.wallet_transactions(id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wallet_transactions
  add column if not exists status text not null default 'settled',
  add column if not exists reversed_transaction_id uuid references public.wallet_transactions(id) on delete set null,
  add column if not exists meta jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists wallet_transactions_agent_created_idx
  on public.wallet_transactions(agent_id, created_at desc);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references auth.users(id) on delete cascade,
  agent_code text,
  reference text,
  type text not null default 'transaction',
  description text,
  amount numeric(12,2) not null default 0,
  balance_before numeric(12,2) default 0,
  balance_after numeric(12,2) default 0,
  status text not null default 'success',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.transactions
  add column if not exists agent_id uuid references auth.users(id) on delete cascade,
  add column if not exists agent_code text,
  add column if not exists reference text,
  add column if not exists type text not null default 'transaction',
  add column if not exists description text,
  add column if not exists amount numeric(12,2) not null default 0,
  add column if not exists balance_before numeric(12,2) default 0,
  add column if not exists balance_after numeric(12,2) default 0,
  add column if not exists status text not null default 'success',
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists transactions_agent_created_idx
  on public.transactions(agent_id, created_at desc);

create table if not exists public.agent_wallet_refunds (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references auth.users(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  reference text not null unique,
  reason text not null,
  admin_id uuid references auth.users(id) on delete set null,
  source text not null default 'admin_manual_refund',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_wallet_refunds_agent_created_idx
  on public.agent_wallet_refunds(agent_id, created_at desc);

alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.transactions enable row level security;
alter table public.agent_wallet_refunds enable row level security;

-- A wallet row must exist before an admin adjustment can lock it. This also
-- repairs older agent accounts created before wallet provisioning was added.
create or replace function public.admin_adjust_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_type text,
  p_reason text,
  p_admin_id uuid default auth.uid()
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_before numeric;
  v_after numeric;
  v_delta numeric;
  v_ref text;
  v_agent_code text;
begin
  if not public.is_admin() then raise exception 'Unauthorized. Administrator privilege required.'; end if;
  if p_user_id is null then raise exception 'User ID is required.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Adjustment amount must be a positive amount with at most two decimals.';
  end if;
  if lower(trim(coalesce(p_type, ''))) not in ('credit', 'debit') then raise exception 'Invalid adjustment type.'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'An adjustment reason is required.'; end if;

  insert into public.wallets (id, balance) values (p_user_id, 0) on conflict (id) do nothing;
  select coalesce(balance, 0) into v_before from public.wallets where id = p_user_id for update;
  if not found then raise exception 'Wallet could not be created for user %', p_user_id; end if;

  v_delta := case when lower(trim(p_type)) = 'credit' then round(p_amount, 2) else -round(p_amount, 2) end;
  v_after := v_before + v_delta;
  if v_after < 0 then raise exception 'Cannot debit beyond available balance. Current balance is GHS %', v_before; end if;
  update public.wallets set balance = v_after, updated_at = now() where id = p_user_id;
  select agent_code into v_agent_code from public.agents where id = p_user_id;
  v_ref := 'ADM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  insert into public.transactions
    (agent_id, agent_code, reference, type, amount, balance_before, balance_after, description, status, metadata)
  values
    (p_user_id, v_agent_code, v_ref,
     case when v_delta > 0 then 'Admin Credit' else 'Admin Debit' end,
     abs(v_delta), v_before, v_after, trim(p_reason), 'completed',
     jsonb_build_object('admin_id', p_admin_id, 'reference', v_ref, 'manual_adjustment', true));

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, status, meta)
  values
    (p_user_id, v_ref, case when v_delta > 0 then 'credit' else 'debit' end,
     trim(p_reason), abs(v_delta), v_after, 'settled',
     jsonb_build_object('admin_id', p_admin_id, 'manual_adjustment', true, 'signed_delta', v_delta));

  perform public.log_activity(
    'Admin ' || case when v_delta > 0 then 'credit' else 'debit' end || ' of GHS ' || abs(v_delta)
      || ' for user ' || coalesce(v_agent_code, p_user_id::text),
    jsonb_build_object('user_id', p_user_id, 'amount', abs(v_delta), 'type', lower(trim(p_type)),
      'old_balance', v_before, 'new_balance', v_after, 'reason', trim(p_reason), 'reference', v_ref), p_admin_id);

  return jsonb_build_object('success', true, 'userId', p_user_id, 'oldBalance', v_before,
    'newBalance', v_after, 'reference', v_ref);
end;
$$;

revoke all on function public.admin_adjust_wallet(uuid, numeric, text, text, uuid) from public, anon;
grant execute on function public.admin_adjust_wallet(uuid, numeric, text, text, uuid) to service_role;
