-- ============================================================================
-- Migration: scheduled sweep for Hubtel orders whose callback never arrived
-- ============================================================================
--
-- Hubtel settles an order by calling one of the three webhooks
-- (hubtel-data-webhook, hubtel-airtime-webhook, hubtel-utility-webhook). Hubtel
-- does retry, but a callback can be lost for good - a webhook that answers 5xx
-- while it is being redeployed is the usual cause. Every order left behind is a
-- customer with no airtime, data or bill, and an agent whose wallet is still
-- debited.
--
-- `reconcile-hubtel-orders` closes that gap: it asks Hubtel's Status Check API
-- for every order still pending more than five minutes after it was created,
-- and settles the ones Hubtel has since closed. This migration only schedules
-- the call - the five-minute rule lives in the function, so it can be tuned
-- without rescheduling the job.
--
-- ---------------------------------------------------------------------------
-- ONE-TIME SETUP, run once per project after deploying the function
-- ---------------------------------------------------------------------------
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'hubtel_project_url');
--   select vault.create_secret('<a long random value>', 'hubtel_reconcile_secret');
--   select public.schedule_hubtel_reconcile_sweep();
--
--   supabase secrets set HUBTEL_RECONCILE_SECRET=<the same random value>
--
-- The two copies of the secret must match. The function refuses every request
-- when its own copy is unset, so a half-finished setup fails closed instead of
-- leaving an unauthenticated endpoint that anyone could make hammer Hubtel.
--
-- The secrets live in Vault rather than in this file on purpose: a migration is
-- committed, and a shared secret in version control is not a secret.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.schedule_hubtel_reconcile_sweep()
returns text
language plpgsql
security definer
set search_path = public, extensions, cron, net, vault
as $$
declare
  v_url text;
  v_secret text;
  v_job_id bigint;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name = 'hubtel_project_url'
  limit 1;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'hubtel_reconcile_secret'
  limit 1;

  if v_url is null or v_secret is null then
    raise exception
      'Set the vault secrets hubtel_project_url and hubtel_reconcile_secret before scheduling this sweep (see the header of migration 20261024000000).';
  end if;

  -- Re-runnable: replace the existing job rather than stacking a second one.
  if exists (select 1 from cron.job where jobname = 'hubtel-reconcile-sweep') then
    perform cron.unschedule('hubtel-reconcile-sweep');
  end if;

  -- Every minute. The function ignores anything younger than five minutes, so
  -- this is the polling resolution, not the grace period - a lost callback is
  -- noticed within roughly a minute of it being provably lost.
  select cron.schedule(
    'hubtel-reconcile-sweep',
    '* * * * *',
    format(
      $job$
        select net.http_post(
          url := %L,
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-reconcile-secret', %L
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 25000
        );
      $job$,
      rtrim(v_url, '/') || '/functions/v1/reconcile-hubtel-orders',
      v_secret
    )
  ) into v_job_id;

  return format(
    'Scheduled hubtel-reconcile-sweep (job %s) to run every minute. Responses are recorded in net._http_response.',
    v_job_id
  );
end;
$$;

-- Only the operator (postgres) and the service role may (re)schedule this.
-- `public` includes every signed-in agent, who must not be able to point the
-- sweep at a URL of their choosing.
revoke all on function public.schedule_hubtel_reconcile_sweep() from public, anon, authenticated;
grant execute on function public.schedule_hubtel_reconcile_sweep() to service_role;
