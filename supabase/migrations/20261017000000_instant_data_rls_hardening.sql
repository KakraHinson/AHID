-- Instant Data security hardening.
--
-- `data_transactions` is the authoritative Instant Data order table. The
-- older `transactions` table predates this flow and is not used by any current
-- fulfillment function, but it had a legacy public-insert policy. Remove that
-- write path so a browser cannot create fake payment history.

alter table if exists public.profiles enable row level security;
alter table if exists public.networks enable row level security;
alter table if exists public.bundles enable row level security;
alter table if exists public.data_transactions enable row level security;
alter table if exists public.transactions enable row level security;

drop policy if exists "Allow public insert on transactions" on public.transactions;

revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.networks from anon, authenticated;
revoke insert, update, delete on public.bundles from anon, authenticated;
revoke insert, update, delete on public.data_transactions from anon, authenticated;
revoke insert, update, delete on public.transactions from anon, authenticated;

comment on table public.data_transactions is
  'Authoritative Instant Data fulfillment log. Writes go through server-side Edge Functions.';
