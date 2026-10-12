-- 00238_guest_seat_label_accompany.sql
--
-- The label for an unnamed extra seat on a multi-child booking changes from
-- "Guest child" to "Accompany" (parent booking form, My Bookings, vendor roster,
-- admin bookings).
--
-- The literal was written by a dozen SQL functions (book_party, redeem_package_credit
-- and their predecessors) and by the Wix booking routes, so instead of redefining
-- each of them this normalises it at the table: any write that sets guest_name to
-- the old default is stored as "Accompany". It covers every writer, including the
-- rename function (a blank name resets to the default), and the app code is
-- updated to write the new label directly.
--
-- Idempotent.

create or replace function public.bookings_normalise_guest_name()
returns trigger
language plpgsql
as $$
begin
  if new.guest_name is not null and lower(btrim(new.guest_name)) = 'guest child' then
    new.guest_name := 'Accompany';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_normalise_guest_name on public.bookings;
create trigger bookings_normalise_guest_name
  before insert or update of guest_name on public.bookings
  for each row execute function public.bookings_normalise_guest_name();

-- Existing seats still carrying the old default. Only guest_name changes (the other
-- booking triggers listen for status / session_id, so none of them fire).
update public.bookings
set guest_name = 'Accompany'
where lower(btrim(guest_name)) = 'guest child';
