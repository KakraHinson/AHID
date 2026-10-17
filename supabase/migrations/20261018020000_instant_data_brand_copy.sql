update public.networks
set tagline = 'From wallet ' || chr(183) || ' Instant delivery',
    updated_at = now()
where id in ('mtn', 'telecel', 'at');
