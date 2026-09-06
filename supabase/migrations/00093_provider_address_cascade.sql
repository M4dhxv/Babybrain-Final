-- 00093_provider_address_cascade.sql
--
-- QA 04/09: "Updated address on settings and it didn't reflect. Any changes
-- made to the listing details should update on parent side."
--
-- Everything the parent sees resolves the address as
-- `coalesce(a.address, p.address)` — the activity's own address first
-- (search_activities, the listing page, the booking emails). That is correct
-- for a class that genuinely runs somewhere other than the head office.
--
-- The problem is that almost nothing is actually inheriting. The vendor import
-- copies the provider's address onto every activity it creates, so 280 of the
-- 292 published activities carry their own copy, and only 15 hold an address
-- that differs at all. Editing the provider's address therefore changed
-- nothing a parent could see.
--
-- So: when a provider's address changes, carry it to the activities that were
-- merely holding a copy of the old one. An activity whose address genuinely
-- differs is left alone — that is a deliberate override, and this must not
-- flatten it. Postal code and coordinates ride along with the address they
-- belong to, which also re-runs set_activity_region (00032/00086) so the area
-- filter follows the move.

begin;

create or replace function public.cascade_provider_address()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Only when the address itself moved. `is distinct from` so a null on either
  -- side behaves.
  if new.address is not distinct from old.address then
    return new;
  end if;

  update public.activities a
  set address     = new.address,
      postal_code = new.postal_code,
      latitude    = new.latitude,
      longitude   = new.longitude
  where a.provider_id = new.id
    -- Only the ones that were carrying a copy of the address being replaced.
    -- A null own-address already inherits through coalesce and needs no write;
    -- a different one is an override and is left exactly as it is.
    and a.address is not distinct from old.address;

  return new;
end;
$$;

comment on function public.cascade_provider_address() is
  'Carries a provider address change onto the activities that were holding a '
  'copy of the old one, leaving deliberate per-activity addresses alone.';

drop trigger if exists providers_address_cascade on public.providers;
create trigger providers_address_cascade
  after update of address, postal_code, latitude, longitude on public.providers
  for each row execute function public.cascade_provider_address();

commit;
