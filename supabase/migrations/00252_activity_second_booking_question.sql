-- 00252_activity_second_booking_question.sql
--
-- A second bespoke question per activity (QA: "can we enable vendors to add two
-- bespoke questions per activity"). The first is activities.info_request_prompt
-- (00074), answered in bookings.info_response.
--
-- Only the question is new. The parent's answers to both questions go in the
-- one bookings.info_response, as two labelled paragraphs, so every booking
-- path (book_session, book_party, redeem_package_credit, the Wix routes...)
-- and the "info_request_enabled needs an answer" gate keep working unchanged,
-- and the vendor reads both answers where they already read the first.
--
-- Compatibility with the deployed apps (see 00247): one nullable column, read
-- by nothing that exists today. The parent app loads activities with
-- select('*'), so it shows the second question once a vendor sets one, and
-- the vendor portal only writes the column when a second question is set.
--
-- Idempotent.

alter table public.activities
  add column if not exists info_request_prompt_2 text;

comment on column public.activities.info_request_prompt_2 is
  'Optional second question for parents at booking time (asked only while info_request_enabled). Answers to both questions are stored together in bookings.info_response.';

notify pgrst, 'reload schema';
