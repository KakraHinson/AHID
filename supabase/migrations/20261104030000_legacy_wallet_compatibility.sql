-- Complete the current utility order columns used by fulfillment and admin
-- cancellation, and keep one old wallet RPC callable during migration.

alter table if exists public.utility_orders
  add column if not exists updated_at timestamptz not null default now();

create or replace view public.agent_wallets as
select
  id as agent_id,
  balance as wallet_balance,
  balance,
  overdraft,
  commission_balance,
  updated_at
from public.wallets;
