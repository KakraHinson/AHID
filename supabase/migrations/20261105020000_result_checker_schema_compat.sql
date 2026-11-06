-- Bring older result-checker installations up to the current order shape.
-- These are idempotent so fresh projects and existing projects both converge.
alter table public.results_orders
  add column if not exists paid_at timestamptz,
  add column if not exists agent_id uuid references public.agents(id) on delete set null;

create index if not exists results_orders_agent_idx
  on public.results_orders(agent_id);
