# BabyBrain — Setup Status & Remaining Steps

Production: **https://babybrain-final.vercel.app** (Vercel project `babybrain-final`).

## Already done (verified working)

- ✅ All 5 migrations applied to Supabase; `npm run validate` → 44/44
- ✅ Vercel env vars set (Production): Supabase, Stream, Resend, webhook secret, `NEXT_PUBLIC_APP_URL`
- ✅ Notification email pipeline live: notification INSERT → pg_net → `/api/webhooks/notifications` → Resend (verified `email_status='sent'` end to end). Config lives in the `app_config` table (see 00005 migration), not env vars.
- ✅ GetStream event hook (v2) pointed at `/api/webhooks/stream` for `message.new`
- ✅ Email/password auth works in production

## Remaining (dashboard-only, ~10 min total)

### 1. Google OAuth
Supabase Dashboard → Authentication → Providers → Google → enable and paste:
- Client ID: `716084890042-pkcc3dcmsk59hi1cnhpqhqes3e9ep3p7.apps.googleusercontent.com`
- Client Secret: (the `GOCSPX-…` value)

In Google Cloud Console, the OAuth client's authorized redirect URI must be:
`https://laftgypwwfevzggxknii.supabase.co/auth/v1/callback`

### 2. Auth URL configuration
Supabase Dashboard → Authentication → URL Configuration:
- Site URL: `https://babybrain-final.vercel.app`
- Additional redirect URLs: `https://babybrain-final.vercel.app/auth/callback`
(Update both when moving to babybrain.sg.)

### 3. Resend domain + SMTP (required before real users)
The current sender `onboarding@resend.dev` can only deliver to Resend test
addresses — real parents won't receive emails until a domain is verified:
1. Verify a domain at resend.com/domains (DNS records).
2. Update `EMAIL_FROM` on Vercel (e.g. `BabyBrain <hello@babybrain.sg>`) and redeploy.
3. Supabase Dashboard → Project Settings → Authentication → SMTP:
   host `smtp.resend.com`, port `465`, user `resend`, password = the `re_…` key —
   this moves signup-confirmation/reset emails off Supabase's ~2/hour built-in mailer.

### 4. Rotate keys before launch
All keys for this project passed through chat during setup: rotate Supabase API
keys + DB password, Google client secret, Stream secret, and the Resend key,
then update Vercel env + `.env.local`.

## Answering support chat

Reply as `babybrain-support` from the GetStream Dashboard (channels are named
`support-<user-id>`). Replies to offline parents trigger an in-app notification
(+ email once the Resend domain is verified).

## Service-role exceptions (per RLS requirements)

RLS gives parents access only to their own rows; these writes intentionally
bypass RLS via the service role or `security definer` SQL:

| What | Where | Why |
|---|---|---|
| Profile/preferences/welcome rows at signup | `handle_new_user()` trigger (definer) | runs before the user has a session |
| Recommendation writes | `compute_recommendations_for_child()` (definer) | clients are read-only on `user_recommendations` |
| Rating rollups on `activities` | `refresh_activity_rating()` trigger (definer) | clients can't write `activities` |
| Activity/session/category management | Supabase Studio / `scripts/seed.mjs` (service role) | no admin portal in Phase 1 |
| `stream_users` upserts | `/api/chat/token` (service role) | server-controlled mapping |
| Notification inserts + `email_status` updates | webhooks (service role) | clients may only flip `read_at` |
| `app_config` reads/writes | definer trigger / service role | holds webhook URL + shared secret |

## Local dev

```bash
npm run dev        # app on localhost:3000
npm run seed       # idempotent sample activities + sessions
npm run validate   # 44-check end-to-end backend validation
```
