# Babybrain-Final

## Git and deploys (MUST)

- Never run `git commit`, `git push` or `supabase db push` without explicit confirmation from Aman, in every session.
- Work in batches: finish and verify the changes, list what is uncommitted, and ask whether to bundle it into one commit. Do not commit per task.
- Once confirmed, commit straight to `main` (no feature branch, no PR).
- A push to `main` ships to Production via Vercel, and `supabase db push` applies every pending migration, not just yours. Confirm both before running.

## Parent app images

Vendor images (logos and photos) come in any shape, so never crop a vendor's logo.
- Activity page hero (`HeroCarousel` in `frontends/parent/src/App.tsx`): `object-cover` anchored near the top (`object-[center_15%]`) so faces stay in.
- Explore and other activity cards (`frontends/parent/src/components/ui.tsx`): `object-contain` on a plain tint, no crop. Wix thumbnails must use `/v1/fit/`, not `/v1/fill/`.
- Any new activity image surface should follow the same two rules.
