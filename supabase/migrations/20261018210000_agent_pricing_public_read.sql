-- ============================================================================
-- Migration: Allow public read of agent_pricing for storefront display
-- ============================================================================

drop policy if exists "Public can read agent pricing" on public.agent_pricing;
create policy "Public can read agent pricing"
  on public.agent_pricing for select
  to anon, authenticated
  using (true);
