-- Keep the Standard Data order table aligned with the admin/order-history
-- readers and provider settlement paths.
alter table public.agent_data_orders
  add column if not exists failure_reason text;

comment on column public.agent_data_orders.failure_reason is
  'Safe customer-facing reason retained when the Standard Data provider rejects or fails an order.';
