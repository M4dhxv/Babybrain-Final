# Babybrain-Final

## Git and deploys (MUST)

- Claude must never run `git commit`, `git push` or `supabase db push` without explicit confirmation from whoever is running that session (Aman, Madhav, or any other collaborator/admin), in every session. This restriction applies only to Claude — it does not require Aman's specific sign-off, and it does not restrict human collaborators (e.g. Madhav) committing or pushing directly themselves under their own judgement; Claude should not block or second-guess a human's own commits.
- Work in batches: finish and verify the changes, list what is uncommitted, and ask whether to bundle it into one commit. Do not commit per task.
- Once confirmed, commit straight to `main` (no feature branch, no PR).
- A push to `main` ships to Production via Vercel, and `supabase db push` applies every pending migration, not just yours. Confirm both before running.

## Shipping cadence and warnings (MUST)

Every push to `main` deploys to Production, and on 3 Oct we shipped four times in six hours. Stability for parents (fast, accurate, never "not found") comes before new features or polish. Aim for **at most 2-3 Production ships per day**, each a larger, verified batch, not many small ones.

Claude must warn the person running the session, in chat, before acting, whenever any of these is true. Warn once, plainly, say what to do instead, and then do what they decide (a warning is not a refusal):

1. **Ship count.** Before any `git push`, run `node scripts/ships-today.mjs`. Say "this would be ship N of 3 today". At 3 or more, warn and suggest holding the change for tomorrow's batch.
2. **Small push.** If they ask to push a change that is small or cosmetic and more work is plausibly coming, suggest bundling it into the next batch instead.
3. **Late night.** Between 21:00 and 07:00 India time, warn against shipping unless it is an urgent fix for something broken right now.
4. **Fresh work on the critical path.** For Explore, activity pages, booking, payments and anything touching `search_activities`, ask for the smoke check first (`node scripts/smoke.mjs`) and check the `uptime` GitHub workflow is green after the push.
5. **Explore polish freeze.** Until the test-site gate (below) is enabled and the `uptime` workflow has run green for a week, push back on new animations, transitions, scroll tricks and other visual polish on Explore, activity and booking pages. Fixes and accuracy work are fine. Ask: "is this worth the risk to the page parents depend on?"
6. **Mixed batch.** Before offering a commit, list uncommitted files. If they include unrelated work (another feature, someone else's changes), say so and propose splitting or confirming scope.
7. **Stacking caches.** If a request adds another layer of caching or persistence, warn that it trades accuracy (stale availability) for speed, and name the staleness window.

Before a ship: build passes, smoke check passes, the batch is listed, and the user has confirmed. After a ship: watch the `uptime` run, and do not start the next change until it is green.

**Test-site gate (needs a person in Vercel, not code).** In both Vercel projects, turn on Deployment Checks / require the GitHub `uptime` check before a deployment is promoted, or move shipping to a `release` branch that deploys the test site first. Until that is done, the test deploy is not a gate: both projects deploy within minutes of each other.

## Parent app images

Vendor images (logos and photos) come in any shape, so never crop a vendor's logo.
- Activity page hero (`HeroCarousel` in `frontends/parent/src/App.tsx`): `object-cover` anchored near the top (`object-[center_15%]`) so faces stay in, **except** the vendor's own `provider.logo_url` — that one is never cropped regardless of aspect ratio, because a landscape logo/wordmark and a landscape photo are indistinguishable from aspect ratio alone. Identify it by comparing the URL (see `providerLogoUrl` in `frontends/parent/src/lib/activityMedia.ts`), never by guessing from shape.
- Explore and other activity cards (`frontends/parent/src/components/ui.tsx`): `object-contain` on a plain tint, no crop. Wix thumbnails must use `/v1/fit/`, not `/v1/fill/`.
- Any new activity image surface should follow the same rules: crop-safe surfaces (`object-contain`) never need special-casing the logo; any surface that crops (`object-cover`) must exempt `provider.logo_url` by URL comparison, the same way the hero does.
