-- Remove the Telecel Broadband and Telecel Postpaid Bill utility services.
--
-- Both were added in 20261010120000 but never fulfilled: every utility order is
-- verified through the provider before the wallet is charged, and the provider
-- was never configured, so no telecel_* order ever existed and no wallet debit
-- is outstanding. The deletes below are therefore defensive (a no-op on a live
-- database) and only exist to guarantee the constraints can be tightened.

delete from public.utility_orders
  where bill_type in ('telecel_broadband', 'telecel_postpaid');

delete from public.service_commission_rates
  where service in ('telecel_broadband', 'telecel_postpaid');

alter table public.utility_orders
  drop constraint if exists utility_orders_bill_type_check;

alter table public.utility_orders
  add constraint utility_orders_bill_type_check
  check (bill_type in ('ecg', 'ecg_postpaid', 'ghana_water', 'dstv', 'gotv', 'startimes'));

alter table public.utility_orders
  drop constraint if exists utility_orders_bill_category_check;

alter table public.utility_orders
  add constraint utility_orders_bill_category_check
  check (bill_category in ('electricity', 'water', 'tv'));
