-- 00242_activity_review_authors.sql
--
-- The activity page's reviews all read "A BabyBrain parent". Parents' profiles are
-- private (parent_profiles RLS), so the page cannot join to them. This returns only a
-- display label per review, "First L." (first name + initial of the last name), computed
-- here so nothing else about the reviewer leaves the database.
--
--   "Rachel Anne Smith" -> "Rachel S."     "Rachel" -> "Rachel"
--   blank, or an email address stored as the name -> NULL (the page falls back)
--
-- Reviews themselves are already public, so this adds a first name + initial and nothing
-- more. Callable by anyone, like the reviews it labels (added to ALLOWED in
-- scripts/check-exposed-functions.mjs). Idempotent.

create or replace function public.activity_review_authors(p_activity_id uuid)
returns table (review_id uuid, author text)
language sql
stable
security definer
set search_path = public
as $$
  select r.id,
         case
           when n.name is null or n.name = '' or n.name like '%@%' then null
           when position(' ' in n.name) = 0 then n.name
           else split_part(n.name, ' ', 1) || ' ' || upper(left((regexp_match(n.name, '(\S+)$'))[1], 1)) || '.'
         end
  from public.reviews r
  left join public.parent_profiles p on p.id = r.user_id
  cross join lateral (select btrim(regexp_replace(coalesce(p.full_name, ''), '\s+', ' ', 'g')) as name) n
  where r.activity_id = p_activity_id;
$$;

revoke all on function public.activity_review_authors(uuid) from public;
grant execute on function public.activity_review_authors(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
