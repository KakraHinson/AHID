-- Give each agent storefront a readable, unique link based on the agent name.
-- The existing unique agent_stores.slug is the public handle used by checkout.

create or replace function public.slugify_agent_name(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select nullif(
    trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g')),
    ''
  );
$$;

revoke all on function public.slugify_agent_name(text) from public, anon;
grant execute on function public.slugify_agent_name(text) to authenticated, service_role;

create or replace function public.generate_unique_agent_store_slug(
  p_agent_id uuid,
  p_exclude_store_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_base text;
  v_slug text;
  v_suffix integer := 0;
  v_id text := substr(replace(p_agent_id::text, '-', ''), 1, 8);
begin
  select full_name into v_name from public.agents where id = p_agent_id;
  v_base := public.slugify_agent_name(v_name);
  v_base := coalesce(v_base, 'agent-' || v_id);
  v_base := substr(v_base, 1, 30);
  v_slug := v_base;

  loop
    exit when not exists (
      select 1 from public.agent_stores
      where slug = v_slug
        and (p_exclude_store_id is null or id <> p_exclude_store_id)
    );
    v_suffix := v_suffix + 1;
    v_slug := substr(v_base, 1, 30 - length(v_suffix::text) - 1) || '-' || v_suffix;
  end loop;
  return v_slug;
end;
$$;

-- Refresh existing handles in a stable order. Duplicate names receive a
-- numeric suffix while every resulting slug remains unique.
do $$
declare
  store_row record;
begin
  for store_row in
    select id, agent_id from public.agent_stores order by created_at, id
  loop
    update public.agent_stores
    set slug = public.generate_unique_agent_store_slug(store_row.agent_id, store_row.id)
    where id = store_row.id;
  end loop;
end;
$$;

create or replace function public.sync_agent_store_name_slug()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.full_name is distinct from old.full_name then
    update public.agent_stores
    set slug = public.generate_unique_agent_store_slug(new.id, id)
    where agent_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists agents_sync_store_name_slug on public.agents;
create trigger agents_sync_store_name_slug
  after update of full_name on public.agents
  for each row execute function public.sync_agent_store_name_slug();

-- Keep provisioning for newly registered agents name-based as well.
create or replace function public.generate_store_slug(p_agent_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.generate_unique_agent_store_slug(p_agent_id, null);
end;
$$;

revoke all on function public.generate_unique_agent_store_slug(uuid, uuid) from public, anon, authenticated;
revoke all on function public.generate_store_slug(uuid) from public, anon, authenticated;
revoke all on function public.sync_agent_store_name_slug() from public, anon, authenticated;
grant execute on function public.generate_store_slug(uuid) to service_role;
