# BabyBrain Phase 2 — Vendor backend setup & API reference

Everything code-side is built and validated:
- `node scripts/validate-vendor.mjs` → **22/22** (schema, staff-role RLS, capacity→waitlist, auto-promote, attendance, review RPC, analytics, isolation)
- `node scripts/validate-vendor-integrations.mjs` → **4/4** (invite auto-link, booking-confirmed email, Stream parent↔provider channel)
- `npm run build` → all 11 vendor routes compile

Migrations `00006`–`00011` are applied to the hosted DB. Remaining work is **provider-side config** (Stripe dashboard) + giving the frontend the API contract below.

## 1. Stripe setup (needed for billing/payouts)

1. Create a Stripe account; in **test mode** create:
   - A **Growth** product with a **monthly** price and an **annual** price (1-month-free is applied in code via trial).
   - Enable **Connect** (Express) for booking payouts.
2. Put the secret key in env: `STRIPE_SECRET_KEY=sk_…` (Vercel + `.env.local`).
3. Add a webhook endpoint → `https://<domain>/api/webhooks/stripe`, subscribe to:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `customer.subscription.created/updated/deleted`, `customer.subscription.trial_will_end`,
   `invoice.payment_failed`, `account.updated`. Copy its signing secret → `STRIPE_WEBHOOK_SECRET=whsec_…`.
4. Store price ids + boost amount in `app_config` (service role / SQL editor):
   ```sql
   insert into app_config(key,value) values
     ('stripe_growth_price_id','price_MONTHLY'),
     ('stripe_growth_price_id_annual','price_ANNUAL'),
     ('stripe_boost_amount_cents','3000')
   on conflict (key) do update set value = excluded.value;
   ```

## 2. GetStream — already wired
The Stream webhook (`/api/webhooks/stream`) now also handles `pp-*` (parent↔provider) channels. No new app needed; just confirm the Stream Dashboard webhook points at `/api/webhooks/stream` (set in Phase 1).

## 3. Vendor API contract (for the frontend you built)

**Direct supabase-js (RLS-scoped, no route):** provider/profile/locations, activities & sessions CRUD, bookings list + status, attendance, make-up tokens, reviews list, listing-event logging. Role enforcement is automatic (staff = attendance only; manager = content/bookings; owner = staff + billing).

**RPCs (supabase.rpc):**
| RPC | Args | Returns |
|---|---|---|
| `provider_overview` | `{ p_provider }` | KPIs row (active_listings, upcoming_bookings, pending_waitlist, profile_views_30d, revenue) |
| `provider_analytics` | `{ p_provider, p_from?, p_to? }` | jsonb (top_age_group, popular_slots, location_ranking, popular_activities, attendance_rate) |
| `promote_waitlist_entry` | `{ p_booking_id }` | — (manager+) |
| `respond_to_review` | `{ p_review_id, p_response }` | — (manager+) |

**Route handlers (POST unless noted), all return `{ url }` for Stripe redirects:**
| Route | Body | Role |
|---|---|---|
| `/api/vendor/stripe/subscription` | `{ provider_id, billing? }` | owner |
| `/api/vendor/stripe/connect` | `{ provider_id }` | owner |
| `/api/vendor/stripe/portal` | `{ provider_id }` | owner |
| `/api/vendor/stripe/boost` | `{ provider_id, activity_id, days? }` | manager+ |
| `/api/bookings/checkout` | `{ booking_id }` | parent (own booking) |
| `/api/vendor/staff/invite` | `{ provider_id, email, role }` | owner |
| `/api/vendor/chat/start` | `{ provider_id }` | parent → returns `{ apiKey, token, channelId, userId }` |
| `GET /api/vendor/chat/token` | — | any member → `{ apiKey, token, userId }`; query channels by membership |

## 4. Automated emails (reuse Phase 1 Resend pipeline)
All fire by inserting a `notifications` row → existing DB webhook → Resend:
- **welcome** (signup trigger), **booking_confirmed** (trigger), **booking_reminder** (hourly cron, ~24–36h before), **class_followup** (daily cron, after session), **waitlist_promoted** (trigger/RPC), **trial_ending** / **payment_failed** (Stripe webhook).

## 5. What's left (not blocking backend)
- Provide `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` and run the `app_config` SQL above to switch billing on.
- Rotate all keys before launch (they passed through chat).
