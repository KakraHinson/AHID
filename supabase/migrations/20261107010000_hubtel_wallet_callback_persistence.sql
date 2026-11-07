-- Persist the final Hubtel callback so a successful payment can be settled
-- from the agent return flow even when transaction-status IP allowlisting is
-- not yet enabled for the Edge Function.
alter table if exists public.wallet_topups
  add column if not exists provider_response jsonb;
