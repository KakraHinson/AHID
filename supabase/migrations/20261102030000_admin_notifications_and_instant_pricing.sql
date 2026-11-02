-- Admin controls for the live instant-data catalogue.
--
-- The public catalogue can only see active rows. Admins need to see the full
-- list in the console so an out-of-stock plan can be restored without relying
-- on the service-role Edge Function for every read. Writes still go through
-- admin-portal-api, which keeps validation and audit context server-side.

drop policy if exists "Admins can view all instant data bundles" on public.instant_data_bundles;
create policy "Admins can view all instant data bundles"
  on public.instant_data_bundles for select
  to authenticated
  using (public.is_admin());
