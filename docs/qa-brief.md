# BabyBrain — End-to-End QA & Documentation Brief

## Your mandate

You are performing a **non-destructive QA audit and documentation pass** on the BabyBrain codebase and its deployed production app. You will produce two deliverables: a PDF explaining how the whole system works, and a problems report. You report problems; you do not fix them.

**You must not fix, change, refactor, or "improve" anything.** No edits to source files, no commits, no pushes, no migrations, no schema changes, no changes to Vercel or Supabase settings, and no edits to existing data. If you find something broken, you write it down — you do not touch it.

Two things you *are* expected to create: your own output files (report, PDF, scratch notes — outside the repo or in a scratch directory you do not commit), and throwaway test data under the strict rules in the "Test data" section below. Creating test records is allowed; changing or deleting anything that was already there is not.

If you believe something is so severe it needs immediate action, say so loudly at the top of your report and stop — do not act on it yourself.

---

## The system in one paragraph

BabyBrain is a Singapore marketplace for children's classes and activities. Parents discover providers, book sessions, buy class packages, and subscribe to a paid "Plus" tier. Vendors (providers) claim or are auto-listed, manage classes/schedules/bookings, subscribe to tiered plans, and receive payouts via Stripe Connect. A founder-only admin panel sits behind an email allowlist. Some vendors sync their catalogue from Wix. Messaging runs on GetStream.

## Architecture facts you can rely on

- **Next.js app** (App Router) serving ~61 API routes under `app/api/**` plus a handful of Next pages (`app/page.tsx`, `/explore`, `/login`, `/signup`, `/dashboard`, `/matches`, `/onboarding`, `/support`, `/contact`, `/admin`, `/reset-password`).
- **Two separate Vite SPAs**, built into `public/`:
  - **Parent SPA** — `frontends/parent/`, essentially one very large `src/App.tsx`. Served at `/`.
  - **Vendor SPA** — `frontends/vendor/`, a **HashRouter** app served at `/vendor`, with 23 pages: Landing, Login, ForgotPassword, ResetPassword, ClaimBusiness, Home, Dashboard, Activities, Schedule, Bookings, Packages, MakeUpTokens, Reviews, Messages, Notifications, Insights, Earnings, Billing, Plans, Settings, SaveListing, Contact, NotFound.
  - `next.config.mjs` has a redirect bouncing bare `/vendor/<path>` deep links into the hash form. Verify it doesn't swallow real static files.
- **Supabase** — Postgres + Auth + RLS + storage. 78 migrations in `supabase/migrations/`. Business logic lives substantially in Postgres functions (57 of them), not just in routes.
- **Stripe** — subscriptions (parent Plus, vendor Growth/Pro), one-off booking/package/event-ticket payments, and Connect for vendor payouts. **Production currently runs Stripe in TEST mode.**
- **Shared libs** in `lib/`: `api-auth.ts`, `vendor.ts` (role checks), `admin.ts` (founder gate), `cors.ts`, `stripe.ts`, `stripe-connect.ts`, `plans.ts`, `commercials.ts`, `payouts.ts`, `refunds.ts`, `stream.ts`, `wix/`, `emails/`.

---

## Ground rules that will save you from doing damage or reporting nonsense

1. **The database you can reach is PRODUCTION with real user data.** You may create your own test data under the rules in "Test data" below. You must never modify or delete anything you did not create.
2. **The data-creating validators are allowed, but announce them.** `npm run validate:booking-rules`, `validate:payments`, `validate:plan-changes`, `validate:claim-flow`, `validate:vendor*` create throwaway providers, activities, parents and bookings and clean up in a `finally`. Run them, include their output, and confirm afterwards that they cleaned up. `npm run validate:migrations` and `validate:stripe-config` are fully read-only.
3. **Do not test against the pre-existing demo data.** There is a demo parent account and `[DEMO]`-tagged listings / "BabyBrain Demo Studio". Those records are stale and have misled past sessions. Note them where you see them, but never treat them as evidence of real behaviour — create your own fresh data instead.
4. **Stripe is in TEST mode — never touch live.** Test-mode checkouts and subscriptions tied to your own test accounts are allowed and expected. No real money moves. Do not create, modify or cancel any Stripe object that belongs to a real customer or vendor, and do not use a live key for anything.
5. **Never paste secrets into your report.** Refer to them by variable name. `.env.local` holds real credentials; do not print values, not even partially.
6. **Distinguish what you verified from what you inferred.** Every finding must be labelled `CONFIRMED` (you observed it) or `SUSPECTED` (it looks wrong from reading the code but you could not trigger it). Do not present reasoning as observation. If you could not verify something, say so — an honest gap is more useful than a confident guess.
7. **Check git state before you start.** Run `git fetch` and confirm you are auditing current `origin/main`, not a stale local branch. A previous session reported wrong conclusions from a 135-commit-stale checkout.

---

## Test data — what you may create, and the line you must not cross

You are expected to create your own test data. Most of this app sits behind a login, and an audit that marks every authenticated surface NOT TESTED is close to worthless. Creating and cleaning up throwaway records is the pattern this repo already uses.

The danger is not writing rows. It is **touching records that belong to real people.**

**You may create**, all tagged so they are unmistakably yours:

- Test parent accounts, children, favourites, reviews on your own listings.
- A test provider (or several), its venues, activities, sessions, packages, and staff invites.
- Bookings, package purchases, make-up tokens, and cancellations **against your own test provider only**.
- Stripe test-mode checkouts, subscriptions and customers tied to your test accounts.

**Accounts already provisioned for you.** The run id is **`qa-2026-09-02-a`**. Credentials are in `.qa-credentials.local.md` in the repo root (gitignored — never print or commit its contents). You have:

- a **parent** account, ready to sign in at `/login`;
- a **vendor owner** account, ready at `/vendor/#/login`, owning provider *"QA Test Studio qa-2026-09-02-a"* (`status = 'draft'`, so it is off Explore; it has a free subscription and an owner membership from the triggers, and no activities yet).

Reuse these rather than creating more top-level accounts. Create manager/staff users yourself when you test role gating, on the same run id. If a test needs the provider publicly visible, flip `status` to `active` and flip it back, and say so in your report.

**Tagging is mandatory.** Use that run id — and put it in every record you create: provider business name, activity title, parent email local-part, and Stripe `metadata`. Everything you made must be findable with a single query on that string. Keep a written inventory as you go: every table and row id you created, updated as you create it. You will need it to clean up, and you will need it if cleanup fails.

**You must never:**

- Book, review, message, cancel, refund, or otherwise interact with a **real provider, real activity, real session, or real parent**. Booking a real provider's session notifies that real vendor and consumes a real capacity slot. If you need to test booking, book your own test provider.
- Modify or delete any record you did not create, including demo records.
- Leave a test provider or activity **publicly visible** on Explore. Create them unpublished/inactive where the schema allows it, and if the flow forces a public state, minimise how long it stays that way and say so in your report.
- Send email or messages to a real address. Use addresses you control, on a domain that cannot reach a real user.
- Touch anything in Stripe **live** mode. Test mode only.
- Run a destructive or bulk statement. No `delete` or `update` without a `where` that names your own row ids.

**Cleanup is part of the task, not an afterthought.** At the end, remove everything you created, in dependency order (bookings → sessions → activities → venues → provider; children → parent; then the auth users). Then **verify** by re-querying for your run id and confirming zero rows remain, and include that verification output in your report. If anything cannot be deleted — a Stripe object, an auth user, a row behind a constraint — list it explicitly under "Residue left behind" with its id and why. A silent orphan is worse than a declared one; the demo data already on this system needed hand-written cleanup SQL to remove.

**Be aware of the blast radius even for clean test data:** new rows will appear in the admin metrics panel while they exist, and any cron job that runs during your audit will see them. Note this rather than being surprised by it.

**Two things you should NOT create, and should mark NOT TESTED instead:**

- **Stripe Connect onboarding** — creates a real Express account tied to real identity data even in test mode. Ask the operator to walk this one with you, or document it from the code.
- **Email deliverability** — you can verify that the app *attempts* to send and that the template renders, but do not try to prove inbox delivery. Report the send attempt and the provider's response.

If you are ever unsure whether a record is real or yours, stop and ask the operator rather than guessing.

---

## Part 1 — Functional QA

### 1.1 Every route

For all ~61 API routes under `app/api/**`, build a table recording: path, HTTP methods, who is allowed to call it (public / authenticated parent / vendor staff / vendor owner / founder admin / cron / webhook), what it does, what it returns, and what it writes.

Pay attention to these groups, which have the most surface area:

- `admin/*` — 13 routes. Founder-only. Verify **every one** enforces the admin gate, not just the ones that obviously mutate.
- `vendor/*` — ~22 routes including Stripe (`connect`, `portal`, `subscription`, `boost`), Wix import/sync (10 routes), claim (`start`, `verify`), staff invite, refunds, earnings.
- `customer/*` — account, bookings, Stripe package/portal/subscription.
- `wix/*` — bookings, checkout, redeem-package, slots, busy, events checkout/RSVP.
- `webhooks/*` — `stripe`, `stream`, `notifications`.
- `cron/*` — `refresh-vendors`, `refresh-wix`.
- `public/*` — `booked-counts`, `provider-plan`. These are deliberately public; confirm they leak nothing beyond what they should.
- `geocode`, `contact`, `chat/token`, `chat/class-group`, `stripe/reconcile`, `auth/send-email`.

### 1.2 Every button and interactive element

Drive the deployed app in a browser. For each SPA page listed above, enumerate every button, link, form, toggle, filter, tab and modal, then record: what it should do, what it actually does, and whether it ends in a working state or a dead end.

Watch specifically for the failure classes this app has had before:
- Buttons that navigate to a login page instead of completing the action.
- Deep links that 404 instead of resolving inside the SPA.
- Links to docs or terms that dead-end.
- Mobile layout breaking (test at 375px as well as desktop) — several pages have had mobile-only regressions.
- Actions gated by plan tier that either fail silently or offer something the tier doesn't include.
- Forms that submit but silently drop a field.
- The vendor Mobile/Desktop preview toggle on SaveListing.
- Pagination, empty states, and loading states.

For anything requiring authentication, create your own tagged test accounts per the "Test data" rules — parent, vendor owner, and each vendor staff role, so you can check that role gating is enforced server-side and not just hidden in the UI. Ask the operator for admin access rather than granting yourself any. If you still cannot reach a surface, record it as **NOT TESTED** with the reason — do not guess.

### 1.3 Core user journeys, end to end

Walk and document each, noting every step and every place it can fail:
1. Parent: discover → provider page → select session → book (free and paid) → confirmation → email → view in dashboard → cancel/reschedule.
2. Parent: buy a class package → auto-book → redeem credit → package expiry and slot limits.
3. Parent: make-up token issue → redeem.
4. Parent: subscribe to Plus (monthly and annual) → manage in billing portal → cancel → downgrade.
5. Parent: favourites (per-child), reviews, calendar `.ics` export, messaging a vendor.
6. Vendor: claim listing → verify → onboard → create activity → schedule sessions → take a booking → refund it.
7. Vendor: plan upgrade/downgrade, boost visibility, billing portal.
8. Vendor: Stripe Connect onboarding → payout status → earnings ledger.
9. Vendor: Wix integration → import locations/services/events → sync → orphan sweep.
10. Vendor: staff invite → roster roles → permissions per role.
11. Admin: metrics, messages, add vendor, vendor refresh, email flows.
12. Wix event tickets: checkout → abandoned checkout expiry → RSVP.

### 1.4 Data and state correctness

- Money: confirm displayed prices match what Stripe actually charges, including fee gross-ups and commission splits. A rounding bug previously showed a cent less than the real charge.
- Timezones: sessions, cut-offs, cron windows, `.ics` exports — Singapore time.
- Capacity, waitlist, age gating, skill levels, booking cut-offs.
- Cancellation and reschedule policy enforcement.

---

## Part 2 — Security review

Treat this as an adversarial review, not a checklist tick.

**Authorization**
- For every route, confirm the authorization check exists **and is correct** — not merely present. Look for routes that check authentication but never check *ownership* (an authenticated vendor reaching another vendor's data by passing a different `provider_id`). Enumerate every route that accepts an id in the body or query and confirm it is scoped to the caller.
- Confirm founder-admin routes use the allowlist gate and that the allowlist is server-side.
- Check staff role enforcement: which roles can do what, and whether the server enforces it or only the UI hides it.

**RLS and database**
- Review policies on every table. Look for tables with RLS disabled, permissive `using (true)` policies, or `SECURITY DEFINER` functions that bypass RLS without re-checking the caller.
- All 57 Postgres functions: check each `SECURITY DEFINER` one validates the caller owns the rows it touches.
- Check `search_path` is pinned on `SECURITY DEFINER` functions.

**Secrets and exposure**
- Confirm no service-role key, Stripe secret, or Wix credential can reach the client. Grep the built bundles in `public/` for key prefixes and for anything that looks like a credential.
- Confirm `NEXT_PUBLIC_*` vars contain nothing sensitive.
- Check the Wix credential "reveal" route very carefully — it exists to return a stored credential.

**Webhooks**
- Confirm every webhook verifies its signature before acting, and that the correct secret is used per endpoint (the platform and Connect endpoints have different secrets).
- Confirm replay protection and idempotency: can the same event be processed twice to double-credit something?

**Payments**
- Look for any path where a booking or package can be confirmed without a verified payment.
- Check refund routes for authorization and for double-refund potential.
- Check commission/earnings arithmetic for rounding that favours or penalises either side.

**Input handling**
- SSRF in `geocode` and the Wix routes (do they fetch attacker-controlled URLs?).
- File upload (`admin/upload`, activity images, policy documents): type/size validation, path traversal, public bucket exposure.
- SQL injection anywhere raw SQL is built, and injection into `.unsafe()` calls.
- XSS: anywhere vendor- or parent-supplied text renders as HTML.

**Other**
- CORS configuration in `lib/cors.ts` — is the origin allowlist tight?
- Rate limiting on auth, contact, claim-verify, and checkout routes.
- Account enumeration on login/forgot-password/claim.
- Invite/claim token strength, expiry, and single-use enforcement.
- Session handling across the parent and vendor SPAs, which share an origin.

---

## Part 3 — Deliverable 1: the documentation PDF

Produce a genuinely extensive PDF titled **"BabyBrain — How It Works"**. This is reference documentation for someone new to the codebase, not a summary. Aim for real depth; long is fine.

Required structure:

1. **Overview** — what the product is, who the actors are, the business model.
2. **Architecture** — the Next API, the two SPAs, how they are served and routed, Supabase, Stripe, Wix, GetStream. Include a diagram.
3. **Data model** — every table, its columns, its relationships, and what owns it. Include an ER diagram. Call out the Postgres functions and what each is for.
4. **Authentication and authorization** — how parents, vendor staff (per role), and admins are identified and gated, end to end.
5. **Feature walkthroughs** — one section per journey in §1.3, each with a sequence diagram, the routes involved, the tables written, and the emails/notifications fired.
6. **Payments** — subscription tiers, one-off payments, commission and fee-payer rules, the earnings ledger, Connect payouts, refunds. Document which Stripe objects are mode-scoped.
7. **Integrations** — Wix (auth, import, sync, cron, orphan sweep), GetStream messaging, Resend email, OneMap geocoding.
8. **Scheduled work** — every cron job, what it does, and its schedule.
9. **Environments and configuration** — every environment variable and `app_config` key, what reads it, and what breaks without it. **Names only, never values.**
10. **Operational runbook** — how to apply a migration, how to validate schema and Stripe config, how to set up webhooks, and the Stripe test→live switch procedure.
11. **Appendix** — the complete route table from §1.1.

Generate the PDF with the `pdf` skill if it is available in your session; otherwise author Markdown, convert to styled HTML, and render to PDF. Save it outside the repo (or in a scratch directory) and tell the operator the path.

---

## Part 4 — Deliverable 2: the problems report

A separate document (Markdown is fine; also include it as an appendix in the PDF). **Every entry must have exactly these fields:**

- **Problem** — what is wrong, in one sentence.
- **Why it matters** — the concrete consequence. Who is affected, what they experience, what it costs. Not "this is bad practice" — what actually happens.
- **How to fix** — the specific change, naming the file and line. Enough that someone could implement it without rediscovering the issue. **Describe the fix; do not make it.**

Plus, for each entry: a severity (`Critical` / `High` / `Medium` / `Low`), a category (security / correctness / data integrity / UX / performance / accessibility / documentation), `file:line`, evidence status (`CONFIRMED` / `SUSPECTED`), and reproduction steps where applicable.

Order the report by severity, then by blast radius. Open with an executive summary: counts by severity, the three things you would fix first, and an explicit list of what you could **not** test and why.

Do not pad the report. A short report of real findings beats a long one full of style opinions. If you find nothing in a category, say so — that is a result too.

---

## Working method

Use static reading and live driving together; neither alone is sufficient. Read the route and its authorization helper before you decide a route is safe, and drive the UI before you decide a button works. When a finding depends on database state, query the database read-only to confirm rather than assuming.

Be systematic about coverage: keep a running checklist of the 61 routes and 23+ pages and mark each as PASS / FAIL / NOT TESTED, so the final report can honestly state coverage. Report progress as you go rather than only at the end.

Where you disagree with how something is built but it works correctly, put it in a separate "Observations / suggestions" section — do not inflate the problems list with preferences.
