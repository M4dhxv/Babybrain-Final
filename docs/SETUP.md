# BabyBrain — Remaining Manual Setup

Everything code-side is implemented and validated (`npm run validate` → 44/44).
These few steps need the Supabase/Stream dashboards (no access token was
provided, so they couldn't be automated) or a deployed URL.

## 1. Google OAuth (~2 min, required for "Continue with Google")

Supabase Dashboard → Authentication → Providers → Google:
- Enable, then paste:
  - Client ID: `716084890042-pkcc3dcmsk59hi1cnhpqhqes3e9ep3p7.apps.googleusercontent.com`
  - Client Secret: (the `GOCSPX-…` value)
- In Google Cloud Console → Credentials → that OAuth client, make sure the
  authorized redirect URI is:
  `https://laftgypwwfevzggxknii.supabase.co/auth/v1/callback`

Email/password auth already works with no further setup.

## 2. Resend SMTP for auth emails (recommended)

Supabase's built-in mailer is rate-limited (~2 emails/hour) — fine for
testing, not for users. Dashboard → Project Settings → Authentication → SMTP:

- Host: `smtp.resend.com` · Port: `465` · Username: `resend`
- Password: the `re_…` API key
- Sender: `onboarding@resend.dev` until a domain is verified at
  resend.com/domains, then e.g. `hello@babybrain.sg` (also update
  `EMAIL_FROM` in env).

## 3. At deploy time (Vercel)

1. Set all variables from `.env.local` in Vercel, plus
   `NEXT_PUBLIC_APP_URL=https://<your-domain>`.
2. Supabase → Authentication → URL Configuration:
   - Site URL: `https://<your-domain>`
   - Additional redirect URLs: `https://<your-domain>/auth/callback`
3. Enable notification emails (SQL editor, run once):
   ```sql
   alter database postgres set app.notification_webhook_url
     = 'https://<your-domain>/api/webhooks/notifications';
   alter database postgres set app.webhook_shared_secret
     = '<WEBHOOK_SHARED_SECRET from .env.local>';
   ```
   Until set, the trigger no-ops and notifications stay `email_status='pending'`.
4. GetStream Dashboard → your app → Webhooks: set the URL to
   `https://<your-domain>/api/webhooks/stream` (enables the
   "support replied" notification + email when the parent is offline).

## 4. Answering support chat

Reply as the `babybrain-support` user from the GetStream Dashboard
(Chat Explorer → channels named `support-<user-id>`). No build needed.

## 5. Security note

All API keys for this project were shared in chat during setup —
rotate them (Supabase API keys + DB password, Google client secret,
Stream secret, Resend key) before launch.

## Service-role exceptions (documented per RLS requirements)

RLS gives parents access only to their own rows; these writes intentionally
bypass RLS via the service role or `security definer` SQL:

| What | Where | Why |
|---|---|---|
| Profile/preferences/welcome rows at signup | `handle_new_user()` trigger (definer) | runs before the user has a session |
| Recommendation writes | `compute_recommendations_for_child()` (definer) | clients are read-only on `user_recommendations` |
| Rating rollups on `activities` | `refresh_activity_rating()` trigger (definer) | clients can't write `activities` |
| Activity/session/category management | Supabase Studio / `scripts/seed.mjs` (service role) | no admin portal in Phase 1 |
| `stream_users` upserts | `/api/chat/token` (service role) | server-controlled mapping |
| Notification inserts + `email_status` updates | Stream/notification webhooks (service role) | clients may only flip `read_at` |

## Local dev

```bash
npm run dev        # app on localhost:3000
npm run seed       # idempotent sample activities + sessions
npm run validate   # 44-check end-to-end backend validation
```
