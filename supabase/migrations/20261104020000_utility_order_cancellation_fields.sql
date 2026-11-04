-- Fields required by the shared admin cancellation/refund workflow.

alter table if exists public.utility_orders
  add column if not exists failure_reason text;

alter table if exists public.utility_orders
  drop constraint if exists utility_orders_status_check;

alter table if exists public.utility_orders
  add constraint utility_orders_status_check
  check (status in ('pending_payment', 'paid', 'processing', 'completed', 'failed', 'cancelled'));
