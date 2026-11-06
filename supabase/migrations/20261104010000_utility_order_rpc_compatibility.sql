-- Keep the legacy admin cancellation RPC compatible with the current utility
-- order schema. New code uses agent_id; the RPC still reads user_id.

alter table if exists public.utility_orders
  add column if not exists user_id uuid,
  add column if not exists failure_reason text;

alter table if exists public.utility_orders
  drop constraint if exists utility_orders_status_check;

alter table if exists public.utility_orders
  add constraint utility_orders_status_check
  check (status in ('pending_payment', 'paid', 'processing', 'completed', 'failed', 'cancelled'));

update public.utility_orders
set user_id = agent_id
where user_id is null
  and agent_id is not null;

create or replace function public.sync_utility_order_user_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.user_id := coalesce(new.user_id, new.agent_id);
  return new;
end;
$$;

drop trigger if exists sync_utility_order_user_id on public.utility_orders;
create trigger sync_utility_order_user_id
before insert or update of agent_id, user_id on public.utility_orders
for each row execute function public.sync_utility_order_user_id();
