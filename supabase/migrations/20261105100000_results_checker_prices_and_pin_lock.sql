-- Shared result-checker prices. The agent checkout and admin portal both read
-- these rows, so an admin price change is used consistently everywhere.
insert into public.service_pricing (service, price, label)
values
  ('result_checker_bece', 19.00, 'BECE Result Checker PIN'),
  ('result_checker_wassce', 22.00, 'WASSCE / NOV/DEC Result Checker PIN')
on conflict (service) do nothing;

-- A PIN or serial identifies one physical checker. Do not allow the same
-- credential to be uploaded under another exam type or another PIN row.
create unique index if not exists result_checker_pins_pin_global_key
  on public.result_checker_pins (lower(btrim(pin)));

create unique index if not exists result_checker_pins_serial_global_key
  on public.result_checker_pins (lower(btrim(serial)))
  where serial is not null and btrim(serial) <> '';

create or replace function public.prevent_result_checker_pin_reuse()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- A sold credential is immutable. It can never be returned to stock or
  -- attached to a different order.
  if tg_op = 'UPDATE' and old.status = 'sold' then
    if new.status <> 'sold'
      or lower(btrim(new.pin)) is distinct from lower(btrim(old.pin))
      or lower(btrim(coalesce(new.serial, ''))) is distinct from lower(btrim(coalesce(old.serial, '')))
      or new.exam_type is distinct from old.exam_type
      or new.result_order_id is distinct from old.result_order_id then
      raise exception 'Sold result checker PINs and serials cannot be reused or changed';
    end if;
  end if;

  -- This also protects databases that already contain legacy rows before the
  -- unique indexes were installed.
  if new.status = 'available' then
    if exists (
      select 1 from public.result_checker_pins p
      where p.id is distinct from new.id
        and p.status = 'sold'
        and lower(btrim(p.pin)) = lower(btrim(new.pin))
    ) then
      raise exception 'This result checker PIN was already sold';
    end if;

    if nullif(btrim(new.serial), '') is not null and exists (
      select 1 from public.result_checker_pins p
      where p.id is distinct from new.id
        and p.status = 'sold'
        and lower(btrim(p.serial)) = lower(btrim(new.serial))
    ) then
      raise exception 'This result checker serial was already sold';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists result_checker_pin_reuse_guard on public.result_checker_pins;
create trigger result_checker_pin_reuse_guard
before insert or update on public.result_checker_pins
for each row execute function public.prevent_result_checker_pin_reuse();
