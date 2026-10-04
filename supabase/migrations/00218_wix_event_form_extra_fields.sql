-- 00218_wix_event_form_extra_fields.sql
--
-- A Wix event's registration form can make fields mandatory that BabyBrain does not collect
-- (BeAlere's asks for child name, child age and phone; anything beyond those is "extra").
-- Wix rejects an order whose form misses a mandatory field, and by then the parent has paid
-- (a paid ticket for BeAlere's "The Crest" sat unfulfilled on 4 Oct 2026).
--
-- The event sync records the labels of mandatory fields BabyBrain cannot fill, so the vendor
-- Activities page can refuse to publish the activity until the vendor turns on "Ask parents
-- for extra information" (info_request_enabled), whose answer is sent to Wix for those fields.
-- Empty = nothing extra, or not a Wix Events activity.
alter table public.activities
  add column if not exists wix_form_extra_fields text[] not null default '{}';
