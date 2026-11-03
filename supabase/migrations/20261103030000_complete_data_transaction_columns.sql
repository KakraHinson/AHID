-- Complete the columns required by the Instant Data order history and
-- provider-reconciliation paths. These were referenced by the application but
-- were absent from the live data_transactions table.
alter table public.data_transactions
  add column if not exists provider text not null default 'hubtel',
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.data_transactions.provider is
  'Fulfilment provider for this transaction; Instant Data uses Hubtel.';

comment on column public.data_transactions.metadata is
  'Safe provider/order metadata used for reconciliation; credentials are never stored.';
