import { NextResponse } from 'next/server';
import { createClient, type EmailOtpType, type Session } from '@supabase/supabase-js';
import { isSitePath } from '@/lib/notification-links';

/**
 * Shared by the email-link landing routes (/auth/callback, /auth/confirm).
 *
 * Both apps (the parent SPA and the vendor portal) keep their session in
 * localStorage under their own key, never in this domain's cookies. So a link
 * verified here with the cookie client signed the parent in only as far as
 * the server was concerned: the app they landed in had no session and sent
 * them to log in again. These hand the session to the app instead, in the
 * same shape Supabase's own /verify redirect uses.
 */

/** Only ever redirect to a path on our own origin ("/profile", never
 *  "//evil.com", "@evil.com" or "/\evil.com", which `${origin}${next}` or the
 *  browser would turn into a different host). */
export function safeNext(next: string | null): string | null {
  return isSitePath(next) ? next : null;
}

/** Spends an email link's token_hash and returns the session it signs in. A
 *  plain client, not the cookie one: a cookie session is invisible to both
 *  apps. */
export async function verifyEmailToken(tokenHash: string, type: EmailOtpType) {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  return { session: data.session, error };
}

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Into the app, signed in. The session rides in the URL fragment, which
 *  never reaches a server; the app's supabase-js reads it on load, stores it
 *  under the app's own key and clears the fragment (a recovery link also fires
 *  PASSWORD_RECOVERY, which both reset pages listen for). */
export function redirectSignedIn(origin: string, next: string, session: Session | null, type: string): NextResponse {
  const path = next.split('#')[0];
  if (!session) return NextResponse.redirect(`${origin}${path}`, { headers: NO_STORE });
  const fragment = new URLSearchParams({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: String(session.expires_in),
    ...(session.expires_at ? { expires_at: String(session.expires_at) } : {}),
    token_type: session.token_type || 'bearer',
    type,
  });
  return NextResponse.redirect(`${origin}${path}#${fragment}`, { headers: NO_STORE });
}

/** For a link whose session (or failure) is in the fragment, which the server
 *  never sees: Supabase's own /verify link, the {{ .ConfirmationURL }} in the
 *  confirm-signup email, redirects here as `…#access_token=…` or
 *  `…#error=access_denied&error_code=otp_expired`. A server redirect can't
 *  read that, so this page decides in the browser: a session goes on to `next`
 *  with the fragment, which signs the app in; a used or expired link goes to
 *  log in, which says so. */
export function fragmentBounce(next: string): Response {
  // JSON, with "<" escaped, so nothing in `next` can close the script tag.
  const target = JSON.stringify(next.split('#')[0]).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>BabyBrain</title></head>
<body style="font-family:system-ui,sans-serif;color:#767676;text-align:center;padding:48px 16px">
<p>Signing you in…</p>
<noscript><p><a href="/login">Continue to log in</a></p></noscript>
<script>
(function () {
  var h = location.hash;
  if (/[#&]access_token=/.test(h)) location.replace(${target} + h);
  else if (/[#&]error/.test(h)) location.replace("/login?link=expired");
  else location.replace("/login?error=auth");
})();
</script>
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE } });
}
