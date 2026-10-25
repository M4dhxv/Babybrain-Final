import { useEffect, useRef, useState } from "react";
import { PageShell, Button } from "../components/ui";
import { useAuth } from "../auth/AuthProvider";
import { VerifyEmailCode } from "../components/VerifyEmailCode";
import { PasswordInput } from "../components/PasswordInput";
import { supabase } from "../lib/supabase";
import { goTo, getParam, isSafeNext, rememberLoginNext, peekLoginNext, clearLoginNext } from "../lib/nav";
import { warmDashboard } from "../lib/prefetch";
import { PASSWORD_RULES, passwordError } from "../lib/validation";

export function LoginPage() {
  const { signIn, session } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Supabase's wording for "signed up but never confirmed the email". The
  // parent can confirm right here with the code from that email.
  const [confirming, setConfirming] = useState(false);
  // An email link that was already used (mail scanners often open links before
  // the parent does) or has expired comes back here (app/auth/callback).
  const [linkExpired] = useState(() => getParam("link") === "expired" || getParam("error") === "auth");
  // Nearly everyone lands on Profile right after signing in. Fetch its chunks
  // now, while they type, so the post-login hop isn't a download + skeleton.
  useEffect(() => { warmDashboard(); }, []);
  // Keep the destination somewhere that survives the app being killed and
  // relaunched mid-login (see rememberLoginNext).
  useEffect(() => {
    const next = getParam("next");
    if (isSafeNext(next)) rememberLoginNext(next);
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await signIn(email, password);
    setBusy(false);
    if (error) {
      if (/not confirmed/i.test(error)) return setConfirming(true);
      return setError(error);
    }
    finish();
  }
  /** Signed in (by password, or by confirming with the email code). Runs once: the effect below can see the new session before
   *  submit() gets back here, and a second run would read the destination's
   *  URL, find no `next`, and send the parent to /profile instead. */
  const finished = useRef(false);
  function finish() {
    if (finished.current) return;
    finished.current = true;
    // Honour ?next= for gated pages that bounced here — same-origin
    // relative paths only ("//host" would be an open redirect).
    // The URL's own `next` wins; the remembered one covers a relaunched app.
    const fromUrl = getParam("next");
    const next = isSafeNext(fromUrl) ? fromUrl : peekLoginNext();
    clearLoginNext();
    // Client-side hop, not a reload: AuthProvider already holds the new session
    // (onAuthStateChange fires before signIn resolves) and every per-user hook is
    // keyed on the user id, so the destination mounts straight into the
    // signed-in app. A hard reload here re-downloaded and re-parsed the whole
    // bundle — several seconds on a phone — for nothing.
    goTo(isSafeNext(next) ? next : "/profile", { replace: true });
  }
  // Already signed in: nothing to log in to, so carry on to where they were
  // going. A signed-in parent reaches this page from a "log in to view it"
  // email link, or from a confirm-email link that signed them in on the way.
  useEffect(() => {
    if (session) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  if (confirming) {
    return (
      <PageShell active="/login">
        <main className="mx-auto max-w-[440px] px-6 py-12">
          <div className="rounded-[18px] border border-[#FED7E4] bg-white p-6 shadow-card sm:p-8">
            <VerifyEmailCode email={email} title="Confirm your email first" onVerified={finish} />
            <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
              <button type="button" onClick={() => setConfirming(false)} className="font-black text-baby-pink">← Back to log in</button>
            </p>
          </div>
        </main>
      </PageShell>
    );
  }
  return (
    <PageShell active="/login">
      <main className="mx-auto max-w-[440px] px-6 py-12">
        <div className="rounded-[18px] border border-[#FED7E4] bg-white p-8 shadow-card">
          <h1 className="text-2xl font-black">Welcome back <span>👋</span></h1>
          <p className="mt-1 font-semibold text-[#5a6690]">Log in to see activity suggestions for your children.</p>
          {linkExpired && !error && (
            <div className="mt-4 rounded-[10px] bg-[#FEF9EB] px-3 py-2 text-sm font-bold text-[#7a5a00]">
              That link has expired or was already used. If you've confirmed your email, just log in below. If not, log in and we'll help you confirm it.
            </div>
          )}
          {error && (
            <div className="mt-4 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">
              {error}
            </div>
          )}
          <form onSubmit={submit} className="mt-5 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-black">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-sm font-black">Password</label>
                <a href="/forgot-password" className="bb-tap relative inline-block text-xs font-bold text-baby-pink hover:underline">Forgot password?</a>
              </div>
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" enterKeyHint="go" className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
            </div>
            <Button type="submit" className="w-full justify-center">{busy ? "Signing in…" : "Log in"}</Button>
          </form>
          <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
            New here? <a href="/onboarding" className="bb-tap relative inline-block font-black text-baby-pink">Create a profile</a>
          </p>
        </div>
      </main>
    </PageShell>
  );
}

export function ForgotPasswordPage() {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await resetPassword(email);
    setBusy(false);
    if (error) return setError(error);
    setSent(true);
  }
  return (
    <PageShell active="/login">
      <main className="mx-auto max-w-[440px] px-4 py-12 sm:px-6">
        <div className="rounded-[18px] border border-[#FED7E4] bg-white p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-black">Reset your password</h1>
          {sent ? (
            <div className="mt-3">
              <p className="rounded-[10px] bg-[#F1FBEF] px-3 py-3 text-sm font-semibold text-palette-green">
                If an account exists for <strong>{email}</strong>, we've sent a reset link. Check your inbox and spam folder.
              </p>
              <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
                <a href="/login" className="font-black text-baby-pink">← Back to log in</a>
              </p>
            </div>
          ) : (
            <>
              <p className="mt-1 font-semibold text-[#5a6690]">Enter your email and we'll send you a link to set a new password.</p>
              {error && <p className="mt-4 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}
              <form onSubmit={submit} className="mt-5 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-black">Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="send" className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
                </div>
                <Button type="submit" className="w-full justify-center">{busy ? "Sending…" : "Send reset link"}</Button>
              </form>
              <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
                Remembered it? <a href="/login" className="font-black text-baby-pink">Log in</a>
              </p>
            </>
          )}
        </div>
      </main>
    </PageShell>
  );
}

export function ResetPasswordPage() {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // Scanner-proof links carry a `token_hash` that is only spent when the
  // parent presses Continue — Outlook/Defender pre-opening the link spends nothing.
  const [tokenHash] = useState(() => getParam("token_hash"));
  const [linkError, setLinkError] = useState(false);

  async function continueFromLink() {
    setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: "recovery" });
    setBusy(false);
    if (error) return setLinkError(true);
    setReady(true);
  }

  // Supabase parses the recovery token from the URL and fires PASSWORD_RECOVERY;
  // until we have a session the user can't set a new password.
  useEffect(() => {
    // With a token_hash, only the Continue press may unlock the form — an
    // existing session must not stand in for the link's account.
    if (tokenHash) return;
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY" || s) setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match.");
    // QA: a reset let through any six characters, so a password that would
    // have been rejected at sign-up could be set here and then used to log in.
    // Same rules, same wording, both ends.
    const pwProblem = passwordError(password);
    if (pwProblem) return setError(pwProblem);
    setBusy(true);
    setError(null);
    const { error } = await updatePassword(password);
    setBusy(false);
    if (error) return setError(error);
    setDone(true);
    setTimeout(() => goTo("/profile", { replace: true }), 1500);
  }

  return (
    <PageShell active="/login">
      <main className="mx-auto max-w-[440px] px-4 py-12 sm:px-6">
        <div className="rounded-[18px] border border-[#FED7E4] bg-white p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-black">Set a new password</h1>
          {done ? (
            <p className="mt-3 rounded-[10px] bg-[#F1FBEF] px-3 py-3 text-sm font-semibold text-palette-green">
              Password updated. Taking you to your profile…
            </p>
          ) : tokenHash && !ready ? (
            linkError ? (
              <p className="mt-3 rounded-[10px] bg-[#FEF9EB] px-3 py-3 text-sm font-semibold text-[#FFD77A]">
                That link has expired or was already used. <a href="/forgot-password" className="font-black text-baby-pink">Request a new one</a>, or log in if you've already set your password.
              </p>
            ) : (
              <>
                <p className="mt-1 font-semibold text-[#5a6690]">Continue to choose a new password for your account.</p>
                <Button type="button" onClick={continueFromLink} disabled={busy} className="mt-5 w-full justify-center">{busy ? "Checking link…" : "Continue"}</Button>
              </>
            )
          ) : !ready ? (
            <p className="mt-3 rounded-[10px] bg-[#FEF9EB] px-3 py-3 text-sm font-semibold text-[#FFD77A]">
              This page only works from the reset link in your email. Open that link, or <a href="/forgot-password" className="font-black text-baby-pink">request a new one</a>.
            </p>
          ) : (
            <>
              <p className="mt-1 font-semibold text-[#5a6690]">Choose a new password for your account.</p>
              {error && <p className="mt-4 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}
              <form onSubmit={submit} className="mt-5 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-black">New password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" enterKeyHint="next" className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
                  {/* The same live checklist the sign-up form shows, so the
                      rules are visible before the form is submitted. */}
                  <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs font-semibold">
                    {PASSWORD_RULES.map((rule) => {
                      const met = rule.test(password);
                      return (
                        <li key={rule.label} className={met ? "text-[#A8E59A]" : "text-[#6D748D]"}>
                          {met ? "✓" : "•"} {rule.label}
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-black">Confirm password</label>
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" enterKeyHint="done" className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
                </div>
                <Button type="submit" className="w-full justify-center">{busy ? "Saving…" : "Update password"}</Button>
              </form>
            </>
          )}
        </div>
      </main>
    </PageShell>
  );
}
