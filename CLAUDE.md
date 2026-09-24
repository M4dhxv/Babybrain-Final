# Babybrain-Final

## Git and deploys (MUST)

- Claude must never run `git commit`, `git push` or `supabase db push` without explicit confirmation from whoever is running that session (Aman, Madhav, or any other collaborator/admin), in every session. This restriction applies only to Claude — it does not require Aman's specific sign-off, and it does not restrict human collaborators (e.g. Madhav) committing or pushing directly themselves under their own judgement; Claude should not block or second-guess a human's own commits.
- Work in batches: finish and verify the changes, list what is uncommitted, and ask whether to bundle it into one commit. Do not commit per task.
- Once confirmed, commit straight to `main` (no feature branch, no PR).
- A push to `main` ships to Production via Vercel, and `supabase db push` applies every pending migration, not just yours. Confirm both before running.

## Parent app images

Vendor images (logos and photos) come in any shape, so never crop a vendor's logo.
- Activity page hero (`HeroCarousel` in `frontends/parent/src/App.tsx`): `object-cover` anchored near the top (`object-[center_15%]`) so faces stay in, **except** the vendor's own `provider.logo_url` — that one is never cropped regardless of aspect ratio, because a landscape logo/wordmark and a landscape photo are indistinguishable from aspect ratio alone. Identify it by comparing the URL (see `providerLogoUrl` in `frontends/parent/src/lib/activityMedia.ts`), never by guessing from shape.
- Explore and other activity cards (`frontends/parent/src/components/ui.tsx`): `object-contain` on a plain tint, no crop. Wix thumbnails must use `/v1/fit/`, not `/v1/fill/`.
- Any new activity image surface should follow the same rules: crop-safe surfaces (`object-contain`) never need special-casing the logo; any surface that crops (`object-cover`) must exempt `provider.logo_url` by URL comparison, the same way the hero does.
