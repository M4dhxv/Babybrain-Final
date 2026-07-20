# BabyBrain — Operations Runbook & Maintenance Schedule

Operational reference for running BabyBrain in production: the moving parts, the
scheduled jobs, a recurring maintenance schedule, health checks, and how to
respond when something breaks.

- Production: **https://babybrain-final.vercel.app** (Vercel project `babybrain-final`)
- Architecture detail: [backend-architecture.md](backend-architecture.md) · [vendor-architecture.md](vendor-architecture.md)
- First-time setup: [SETUP.md](SETUP.md) · [vendor-setup.md](vendor-setup.md)
- Vendor scraping: [vendor-scraping.md](vendor-scraping.md)

---

## 1. System at a glance

| Layer | What | Where |
|---|---|---|
| Backend / API | Next.js API routes, webhooks, middleware | `app/`, deployed on Vercel |
| Parent SPA | Vite React app, served at `/` (assets under `/app/`) | `frontends/parent/` → `public/app/` |
| Vendor SPA | Vite React app, served at `/vendor/` (HashRouter) | `frontends/vendor/` → `public/vendor/` |
| Database | Postgres + RLS + pg_cron + pg_net | Supabase project `laftgypwwfevzggxknii` |
| Chat | GetStream (enquiry, class group, support) | webhook → `/api/webhooks/stream` |
| Payments | Stripe (subscriptions, Connect payouts, boosts) | webhook → `/api/webhooks/stripe` |
| Email | Resend, fired from `notifications` rows via pg_net | webhook → `/api/webhooks/notifications` |

Both SPAs are static builds committed into `public/` and served by the single
Next.js deployment. **A frontend change is not live until its SPA is rebuilt** —
see §6.

---

## 2. Scheduled jobs (Supabase pg_cron)

All times UTC. Singapore is UTC+8.

| Job | Schedule | Cron | Does |
|---|---|---|---|
| `booking-reminders` | hourly | `0 * * * *` | Inserts `booking_reminder` notifications ~24–36h before a session |
| `class-followups` | daily 01:00 | `0 1 * * *` | Inserts `class_followup` notifications after a session (review nudge) |
| `refresh-activity-popularity` | daily 18:00 | `0 18 * * *` | Recomputes activity popularity rollups |
| `refresh-recommendations` | daily 18:30 | `30 18 * * *` | Recomputes per-child recommendations |
| `weekly-vendor-refresh` | Mon 03:00 (~11am SGT) | `0 3 * * 1` | POSTs `/api/cron/refresh-vendors` → scrape + fill prices ([vendor-scraping.md](vendor-scraping.md)) |

Inspect or verify jobs in the Supabase SQL editor:

```sql
select jobname, schedule, active from cron.job order by jobname;
-- recent runs + failures:
select jobname, status, start_time, return_message
from cron.job_run_details
order by start_time desc
limit 20;
```

The weekly vendor refresh also self-logs to `vendor_sync_runs`, visible in `/admin`.

---

## 3. Maintenance schedule

Concrete recurring tasks. Owner = whoever operates the platform (founder).

### Daily (2–3 min, or on alert)
- [ ] **Support inbox** — answer parent support chats in the GetStream Dashboard
      (channels `support-<user-id>`), or via `/admin` → Messages.
- [ ] **Error glance** — Vercel → project → Logs: scan for 5xx spikes on `/api/**`.
- [ ] **Payment/webhook failures** — Stripe Dashboard → Developers → Webhooks: any
      failed deliveries to `/api/webhooks/stripe`? Retry or investigate.

### Weekly (~15 min)
- [ ] **Cron health** — run the `cron.job_run_details` query (§2); confirm the five
      jobs ran and `status='succeeded'`.
- [ ] **Vendor refresh** — `/admin` → Vendors: confirm Monday's run succeeded; note
      `unreachable` counts. Trigger extra manual batches to churn through the list.
- [ ] **Apify usage** (once the key is set) — Apify console: check compute-unit spend
      is in range; if climbing, lower `APIFY_BATCH`/`maxPages` in `lib/vendor-refresh.ts`.
- [ ] **Email deliverability** — Resend Dashboard: bounce/complaint rate sane; spot-check
      `notifications.email_status = 'sent'`.
- [ ] **Backups exist** — Supabase → Database → Backups: confirm daily backups present.

### Monthly (~30–45 min)
- [ ] **Dependency review** — `npm outdated` at repo root and in both `frontends/*`;
      patch/minor bumps for security. See §7 for the upgrade routine.
- [ ] **`npm audit`** in all three package roots; address high/critical advisories.
- [ ] **Full validation suite** against a safe environment:
      `npm run validate` · `npm run validate:vendor` · `npm run validate:vendor-int`.
- [ ] **Storage & DB size** — Supabase usage dashboard; watch row growth on
      `notifications`, `listing_events`, `vendor_sync_runs`.
- [ ] **Log-table pruning** — archive/delete old rows if `listing_events` /
      `vendor_sync_runs` / `notifications` grow large (see §8).
- [ ] **Restore drill (quarterly-ish)** — actually restore a backup into a scratch
      project once in a while; an untested backup is not a backup.

### Quarterly (~1–2 h)
- [ ] **Secret rotation** — rotate Supabase keys + DB password, Stream secret, Resend
      key, Stripe keys, `WEBHOOK_SHARED_SECRET`, `APIFY_API_TOKEN`. Update Vercel env
      **and** `.env.local`, redeploy, re-verify webhooks. (§5)
- [ ] **Access review** — Supabase/Vercel/Stripe/Stream/Apify collaborators; remove
      anyone who's left. Review `ADMIN_EMAILS`.
- [ ] **RLS spot-audit** — confirm a parent still can't read another parent's rows and
      a `staff` member still can't touch billing (the validation scripts cover the core
      of this; re-run and skim).
- [ ] **Framework upgrades** — evaluate Next.js / React / Vite / Supabase-js majors.

### On every deploy
- [ ] Typecheck + build all three apps (§6) before pushing.
- [ ] After deploy, run the smoke test (§4).

---

## 4. Smoke test (post-deploy, ~5 min)

Quickest end-to-end confidence check, using the demo accounts
(`.demo-credentials.local.md`, gitignored):

1. **Parent public** — open `/`, click **Explore Activities**, open an activity, open
   **Book a Class**. No blank screens, no console errors.
2. **Parent auth** — log in as the demo parent; the dashboard loads with Bookings,
   Packages, Notifications populated.
3. **Vendor auth** — log in as the demo vendor at `/vendor/#/login`; Dashboard,
   Activities, Bookings (pick a session with bookings), Messages, Settings, Billing all
   render.
4. **Shared flow** — the parent's "Demo Child" booking shows in the vendor's Bookings
   roster.
5. **Mobile** — resize to ~375px on Explore (parent) and Dashboard (vendor); cards
   stack and nothing overflows.

Zero console errors across the above = healthy.

---

## 5. Secrets & environment

All secrets live in Vercel env (Production) and `.env.local` (dev). Names only:

| Var | Used by |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client auth/data |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` | server (admin client, migrations) |
| `NEXT_PUBLIC_STREAM_KEY`, `STREAM_SECRET` | GetStream chat + token minting |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | payments + webhook verification |
| `RESEND_API_KEY`, `EMAIL_FROM` | transactional email |
| `WEBHOOK_SHARED_SECRET` | authenticates pg_net → webhook/cron calls |
| `APIFY_API_TOKEN` | vendor scraping (falls back to WP if unset) |
| `NEXT_PUBLIC_APP_URL` | absolute links in emails/redirects |
| `GEMINI_API_KEY`, `KIMI_API_KEY` | offline enrichment scripts only (not runtime) |

**Rotation is quarterly and after any suspected exposure** (all keys passed through
chat during initial setup — rotate before real launch, per [SETUP.md](SETUP.md) §4).
After rotating a webhook-signing secret, re-test that provider's webhook.

---

## 6. Build & deploy

```bash
# Full production build (parent SPA + vendor SPA + Next):
npm run build

# Individual SPA rebuilds (needed after editing a frontend):
npm run build:parent
npm run build:vendor
```

`npm run build` builds both SPAs into `public/app` and `public/vendor`, then builds
Next. Deploy is `git push` to the branch wired to the Vercel project (Vercel runs
`npm run build`).

**Pre-deploy gate** (fast, catches most regressions):

```bash
npx tsc --noEmit                                   # Next app
npm --prefix frontends/parent run typecheck        # parent SPA (tsc --noEmit)
npm --prefix frontends/vendor exec tsc -b          # vendor SPA
```

> Editing a frontend but not rebuilding its `public/` bundle is the single most
> common "my change isn't live" mistake. The Next server serves the committed build.

---

## 7. Dependency upgrades

Three independent `package.json` roots: repo root (Next backend),
`frontends/parent`, `frontends/vendor`.

```bash
npm outdated                                  # per root
npm install <pkg>@<version>                   # bump
# then, for whichever app(s) it affects:
npx tsc --noEmit          # or the app's typecheck
npm run build             # confirm it still builds
```

Then run the §4 smoke test. Do patch/minor bumps monthly; treat majors (Next, React,
Vite, `@supabase/*`, `stream-chat*`, `stripe`) as their own reviewed change with a
full regression pass.

---

## 8. Database maintenance

Migrations are ordered SQL in `supabase/migrations/`. Apply new ones in the Supabase
SQL editor (or via the DB URL); never rewrite an applied migration — add a new one.

**Tables that grow unbounded** — prune/archive when large:

```sql
-- Vendor refresh history: keep ~90 days
delete from vendor_sync_runs where started_at < now() - interval '90 days';

-- Listing analytics events: keep ~180 days (or roll up first)
delete from listing_events where created_at < now() - interval '180 days';

-- Read, old notifications: keep ~180 days
delete from notifications where read_at is not null and created_at < now() - interval '180 days';
```

Run the validation suite after any schema change:
`npm run validate && npm run validate:vendor && npm run validate:vendor-int`.

---

## 9. Incident playbooks

**Emails not sending** → check `notifications.email_status` (stuck at `pending`?);
Resend Dashboard for errors; that the pg_net webhook (`app_config` / vault) still
points at `/api/webhooks/notifications` with the right `WEBHOOK_SHARED_SECRET`;
Resend domain still verified.

**Payments failing / subscriptions not updating** → Stripe → Webhooks: failed
deliveries to `/api/webhooks/stripe`? Verify `STRIPE_WEBHOOK_SECRET` matches the live
endpoint; check that `app_config` price ids ([vendor-setup.md](vendor-setup.md) §1)
are current.

**Chat won't load** → token route (`/api/vendor/chat/token`) returning 200? Stream
key/secret valid? Stream webhook still pointed at `/api/webhooks/stream`?

**Weekly vendor refresh not running / erroring** → `/admin` → Vendors for the run row
and error; `cron.job_run_details` for the pg_cron side; confirm the cron URL matches
prod and `WEBHOOK_SHARED_SECRET` matches. If Apify-specific, check the Apify console
for failed/timed-out runs and remaining credit. With no token it falls back to WP and
keeps working. See [vendor-scraping.md](vendor-scraping.md).

**Frontend change not appearing** → the SPA wasn't rebuilt; run `npm run build:parent`
/ `build:vendor` and redeploy (§6).

**Site down / 5xx storm** → Vercel Logs for the failing route; Supabase status
(connection limits, paused project?); roll back to the last good Vercel deployment
while investigating.

---

## 10. Ownership checklist (keep current)

- [ ] Supabase project owner + billing
- [ ] Vercel project owner + billing
- [ ] Stripe account owner + payout bank
- [ ] GetStream app owner
- [ ] Resend account + verified sending domain
- [ ] Apify account + billing
- [ ] Domain registrar (when moving to babybrain.sg)
- [ ] `ADMIN_EMAILS` list for `/admin` access
