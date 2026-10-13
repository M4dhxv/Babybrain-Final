-- 00239_guest_seat_label_guest.sql
--
-- The label for an unnamed extra seat changes from "Accompany" (00238) to
-- "Guest" — the seat may be an adult, not only a child. The booking form,
-- My Bookings, vendor roster and admin bookings all read it from guest_name.
--
-- Re-points the 00238 normaliser at the new label: SQL functions that still
-- write the original "Guest child" default, and any "Accompany" write, are
-- stored as "Guest". Idempotent.

create or replace function public.bookings_normalise_guest_name()
returns trigger
language plpgsql
as $$
begin
  if new.guest_name is not null and lower(btrim(new.guest_name)) in ('guest child', 'accompany') then
    new.guest_name := 'Guest';
  end if;
  return new;
end;
$$;

-- Existing seats still carrying either old default. Only guest_name changes.
update public.bookings
set guest_name = 'Guest'
where lower(btrim(guest_name)) in ('guest child', 'accompany');
