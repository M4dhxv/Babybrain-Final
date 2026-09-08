import { useEffect, useState } from "react";
import { PageShell, Button } from "../components/ui";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { goTo, getParam } from "../lib/nav";
import { PASSWORD_RULES, passwordError } from "../lib/validation";

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await signIn(email, password);
    setBusy(false);
    if (error) return setError(error);
    // Honour ?next= for gated pages that bounced here — same-origin
    // relative paths only ("//host" would be an open redirect).
    const next = getParam("next");
    // Reboot into the signed-in app so every hook starts from the new session.
    goTo(next && next.startsWith("/") && !next.startsWith("//") ? next : "/profile", { hard: true });
  }
  return (
    <PageShell active="/login">
      <main className="mx-auto max-w-[440px] px-6 py-12">
        <div className="rounded-[18px] border border-[#FED7E4] bg-white p-8 shadow-card">
          <h1 className="text-2xl font-black">Welcome back <span>👋</span></h1>
          <p className="mt-1 font-semibold text-[#5a6690]">Log in to see activity suggestions for your children.</p>
          {error && <p className="mt-4 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}
          <form onSubmit={submit} className="mt-5 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-black">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-sm font-black">Password</label>
                <a href="/forgot-password" className="text-xs font-bold text-baby-pink hover:underline">Forgot password?</a>
              </div>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
            </div>
            <Button type="submit" className="w-full justify-center">{busy ? "Signing in…" : "Log in"}</Button>
          </form>
          <p className="mt-4 text-center text-sm font-semibold text-[#5a6690]">
            New here? <a href="/onboarding" className="font-black text-baby-pink">Create a profile</a>
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
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
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

  // Supabase parses the recovery token from the URL and fires PASSWORD_RECOVERY;
  // until we have a session the user can't set a new password.
  useEffect(() => {
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
    setTimeout(() => goTo("/profile", { hard: true }), 1500);
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
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
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
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required className="h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 font-semibold" />
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
