-- 00111_pin_coords_on_ambiguous_postal_activities.sql
--
-- QA re-report: "Play & Bloom location is incorrect — should be Central, not
-- Sentosa." (Same line 00095's header quotes.)
--
-- The data is already correct: 00095 taught sg_region() to trust
-- coordinates over the 098/099 postal prefix, and 00096 had
-- set_activity_region() borrow the PROVIDER's coordinates for an activity
-- that carries none. Every Play & Bloom region — provider, the HarbourFront
-- Centre venue, all 12 published activities, and the search_activities RPC —
-- now reads 'central'. Verified live.
--
-- What's left is fragility, not a live bug. Those 12 activities have no
-- coordinates of their own; they only resolve to 'central' because the
-- trigger borrows the provider's. sg_region('099253', null, null) is still
-- 'sentosa' by design (you cannot tell HarbourFront from Sentosa Cove from
-- the prefix alone). So if a Wix sync or a failed geocode ever cleared the
-- provider's latitude/longitude, the next write to any of these rows would
-- recompute it to 'sentosa'.
--
-- Fix: give an 098/099 activity that lacks coordinates a copy of its
-- provider's, so it resolves on its own signal. Narrow on purpose — only the
-- 098/099 ambiguity 00095/00096 were about. 00096 established that borrowing
-- provider coordinates unconditionally moves activities wrongly, so this does
-- not do that. Region re-derives through activities_region_trg (BEFORE
-- UPDATE OF latitude, longitude). A later provider move still propagates:
-- 00110's cascade_provider_address() carries new coordinates onto the
-- same-postal activities.
--
-- Currently 13 rows: 12 Play & Bloom, 1 BabyBrain Demo Provider (both
-- mainland). Swim Sentosa's 3 rows are genuinely on the island and stay
-- 'sentosa' — their coordinates land inside sg_region()'s Sentosa box.

begin;

update public.activities a
set latitude  = p.latitude,
    longitude = p.longitude
from public.providers p
where p.id = a.provider_id
  and a.postal_code ~ '^09[89]'
  and a.latitude is null
  and a.longitude is null
  and p.latitude is not null
  and p.longitude is not null;

commit;
