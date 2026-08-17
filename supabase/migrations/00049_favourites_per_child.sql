-- QA 17/08/26: "On a profile with multiple children, is it possible to assign
-- saved favourites to a certain child or both and show it this way on overview
-- / saved favourites tab?"
--
-- `favorites` is keyed (user_id, activity_id) with no child link, which is why
-- the child selector on the Favourites tab was inert — there was nothing to
-- filter on. Rather than putting child_id into the primary key (which would
-- force every favourite to belong to exactly one child, and can't express "both"
-- or "no one in particular"), the assignment lives in a join table:
--
--   · a favourite with NO rows here is saved for the whole family — the
--     behaviour every existing favourite already has, so nothing is migrated
--     and nothing changes for current users;
--   · a favourite with rows is assigned to exactly those children, and "both"
--     is simply two rows.

begin;

create table if not exists public.favorite_children (
  user_id     uuid not null,
  activity_id uuid not null,
  child_id    uuid not null references public.children (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, activity_id, child_id),
  -- Cascade off the favourite itself, so un-hearting an activity clears its
  -- assignments rather than leaving orphans behind.
  foreign key (user_id, activity_id)
    references public.favorites (user_id, activity_id) on delete cascade
);

create index if not exists favorite_children_child_idx
  on public.favorite_children (child_id);

alter table public.favorite_children enable row level security;

-- Own rows only, and the child has to actually be one of theirs — otherwise a
-- parent could pin a favourite to someone else's child id.
drop policy if exists "select own favorite_children" on public.favorite_children;
create policy "select own favorite_children" on public.favorite_children
  for select using (user_id = auth.uid());

drop policy if exists "insert own favorite_children" on public.favorite_children;
create policy "insert own favorite_children" on public.favorite_children
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.children c
      where c.id = child_id and c.parent_id = auth.uid()
    )
  );

drop policy if exists "delete own favorite_children" on public.favorite_children;
create policy "delete own favorite_children" on public.favorite_children
  for delete using (user_id = auth.uid());

grant select, insert, delete on public.favorite_children to authenticated;

commit;
