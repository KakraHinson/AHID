-- Keep older AFA installations compatible with the current agent/admin flows.
alter table public.afa_registrations
  add column if not exists date_of_birth date,
  add column if not exists occupation text,
  add column if not exists price_id text,
  add column if not exists failure_reason text,
  add column if not exists provider_reference text,
  add column if not exists provider_response jsonb,
  add column if not exists created_by uuid references public.agents(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists afa_registrations_created_by_idx
  on public.afa_registrations(created_by);

alter table public.service_pricing
  add column if not exists label text,
  add column if not exists updated_at timestamptz not null default now();
