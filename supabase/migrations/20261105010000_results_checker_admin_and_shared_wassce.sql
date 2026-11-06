-- Results checker admin access and shared WASSCE/NOV-DEC stock.
-- BECE remains a separate stock pool. WASSCE and NOV/DEC use the same PIN type.

-- The admin browser is protected by the admin-only RLS policies created in the
-- portal expansion migration. These grants are required in addition to RLS;
-- policies cannot grant table privileges that were never granted.
grant select, delete on table public.result_checker_pins to authenticated;
grant select on table public.results_orders to authenticated;

-- Keep legacy NOV/DEC rows usable, but let WASSCE and NOV/DEC orders draw from
-- one shared pool. New application writes are normalized to WASSCE.
create or replace function public.fulfil_result_checker_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.results_orders%rowtype;
  v_pins jsonb;
  v_count integer;
begin
  select * into v_order
    from public.results_orders
   where id = p_order_id
   for update;

  if not found then
    raise exception 'Result order not found';
  end if;

  if v_order.status = 'paid' then
    return coalesce(v_order.serial_pin::jsonb, '[]'::jsonb);
  end if;

  with selected as (
    select id, pin, serial
      from public.result_checker_pins
     where status = 'available'
       and (
         (v_order.exam_type = 'BECE' and exam_type = 'BECE')
         or (v_order.exam_type in ('WASSCE', 'NOV/DEC') and exam_type in ('WASSCE', 'NOV/DEC'))
       )
     order by created_at
     for update skip locked
     limit v_order.quantity
  ), updated as (
    update public.result_checker_pins p
       set status = 'sold', result_order_id = v_order.id, sold_at = now()
      from selected s
     where p.id = s.id
     returning s.pin, s.serial
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object('pin', pin, 'serial', serial)), '[]'::jsonb)
    into v_count, v_pins
    from updated;

  if v_count <> v_order.quantity then
    raise exception 'Insufficient PIN stock for %', v_order.exam_type;
  end if;

  update public.results_orders
     set status = 'paid', serial_pin = v_pins::text, paid_at = now()
   where id = v_order.id;

  return v_pins;
end;
$$;

revoke all on function public.fulfil_result_checker_order(uuid) from public, anon, authenticated;
grant execute on function public.fulfil_result_checker_order(uuid) to service_role;
