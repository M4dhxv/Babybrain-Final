-- 00198_marketing_consent_withdrawn_at.sql
--
-- Klaviyo is managed by hand (decided 29 Sep): the app sends nothing to it.
-- Katie exports parents who gave marketing consent from /admin → Marketing and
-- imports them into Klaviyo herself. To do that safely she also needs to know
-- who has since unsubscribed in the app, so she can suppress them in Klaviyo.
--
-- Until now an unsubscribe just cleared marketing_consent_at, leaving no trace
-- that the person had ever opted in. This records when consent was withdrawn;
-- /api/customer/marketing-consent sets it on unsubscribe and clears it if the
-- parent subscribes again.
--
-- Idempotent.

alter table public.parent_profiles
  add column if not exists marketing_consent_withdrawn_at timestamptz;

comment on column public.parent_profiles.marketing_consent_withdrawn_at is
  'When the parent withdrew marketing consent (Settings → Unsubscribe or an email footer link). Null if they never withdrew, or subscribed again. Exported from /admin so they can be suppressed in Klaviyo.';
