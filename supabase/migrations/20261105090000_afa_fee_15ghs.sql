-- Keep the AFA quote shown in the agent form and the server-side wallet charge
-- aligned at the requested GHS 15.00.
insert into public.service_pricing (service, price, label)
values ('afa', 15.00, 'AFA Registration Fee')
on conflict (service) do update
  set price = excluded.price,
      label = excluded.label,
      updated_at = now();

do $$
declare
  v_price numeric;
begin
  select price into v_price
  from public.service_pricing
  where service = 'afa';

  if v_price is distinct from 15.00 then
    raise exception 'AFA price is %, expected 15.00', v_price;
  end if;
end;
$$;
