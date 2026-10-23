import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { useAuth, type AuthIssue } from '@/auth/AuthProvider';
import { AuthHeader } from '@/components/AuthHeader';
import { AuthFieldAction, AuthFieldMessage, AuthHelpLine } from '@/components/AuthFieldMessage';
import { suggestEmail } from '@/lib/emailTypo';

/** Red edge for a field that's wrong. The Input's own `aria-invalid:` styling
 *  never applies: Tailwind 3 has no aria-invalid variant. */
const INVALID = 'border-red-400 focus-visible:border-red-400 focus-visible:ring-red-200';

/** Where to go once signed in: the portal page RequireAuth sent them here
 *  from (?next=), else the dashboard. A route inside the portal only. */
function destination(next: string | null): string {
  return next && /^\/(?![/\\])/.test(next) && !/[\\\u0000-\u001f\u007f]/.test(next) && !next.startsWith('/login')
    ? next
    : '/dashboard';
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const dest = destination(searchParams.get('next'));
  const { signIn, session } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [issue, setIssue] = useState<AuthIssue | null>(null);
  // The email the issue was about — the field may have been edited since.
  const [issueEmail, setIssueEmail] = useState('');
  const [failures, setFailures] = useState(0);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Already signed in (or just signed in below)? Go on to where they were going.
  useEffect(() => {
    if (session) navigate(dest, { replace: true });
  }, [session, navigate, dest]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setIssue(null);
    const result = await signIn(email, password);
    setBusy(false);
    if (!result.error) {
      navigate(dest, { replace: true });
      return;
    }
    setFailures((n) => n + 1);
    if (!result.issue) {
      setError(result.error);
      return;
    }
    setIssue(result.issue);
    setIssueEmail(email.trim());
    if (result.issue.kind === 'wrong_password') {
      setPassword('');
      passwordRef.current?.focus();
    } else {
      emailRef.current?.select();
    }
  }

  function forgotPassword() {
    navigate('/forgot-password', { state: { email: email.trim() } });
  }

  function applyEmail(next: string) {
    setEmail(next);
    setIssue(null);
    if (next) passwordRef.current?.focus();
    else emailRef.current?.focus();
  }

  const emailIssue = issue && issue.kind !== 'wrong_password' ? issue : null;
  const suggestion = emailIssue?.kind === 'unknown_email' ? suggestEmail(issueEmail) : null;

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      {/* Was an inline copy of AuthHeader. Shared now, so the mobile nav
          dropdown only has to exist in one place. */}
      <AuthHeader>
        {/* A "Log in" button here used to link right back to /login — this
            page. Same dead-CTA shape as "Upgrade your listing" on Plans. */}
        <Button
          onClick={() => navigate('/claim-business')}
          className="rounded-full px-6 border-0 bg-gradient-to-r from-[#FA4D8D] to-[#FF6B9B] text-white shadow-[0_8px_20px_rgba(250,93,147,0.32)] transition hover:brightness-105"
        >
          Claim your listing
        </Button>
      </AuthHeader>

      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="mb-1 text-xl font-bold text-gray-900">Welcome back 👋</h1>
          <p className="mb-6 text-sm text-gray-500">Sign in to manage your business.</p>
          {error && (
            <div role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {error}
            </div>
          )}
          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                ref={emailRef}
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailIssue) setIssue(null);
                }}
                aria-invalid={emailIssue?.kind === 'unknown_email' || undefined}
                className={emailIssue?.kind === 'unknown_email' ? INVALID : undefined}
                aria-describedby={emailIssue ? 'email-issue' : undefined}
                required
              />
              {emailIssue?.kind === 'unknown_email' && (
                <AuthFieldMessage
                  id="email-issue"
                  actions={suggestion && <AuthFieldAction onClick={() => applyEmail(suggestion)}>Use {suggestion}</AuthFieldAction>}
                >
                  {suggestion ? (
                    <>No account uses <strong>{issueEmail}</strong>. Did you mean <strong>{suggestion}</strong>?</>
                  ) : (
                    <>No account uses <strong>{issueEmail}</strong>. Check the spelling and try again.</>
                  )}
                </AuthFieldMessage>
              )}
              {emailIssue?.kind === 'contact_email' && (
                <AuthFieldMessage
                  id="email-issue"
                  tone="warn"
                  actions={<AuthFieldAction onClick={() => applyEmail('')}>Enter the login email</AuthFieldAction>}
                >
                  <strong>{issueEmail}</strong> is {emailIssue.businessName}'s contact email, not a login.{' '}
                  {emailIssue.loginHint ? (
                    <>Your login email is <strong>{emailIssue.loginHint}</strong>.</>
                  ) : (
                    <>Sign in with the owner's login email.</>
                  )}
                </AuthFieldMessage>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="password">Password</Label>
                <button type="button" className="text-xs font-semibold text-[#A7D8F8]" onClick={forgotPassword}>
                  Forgot password?
                </button>
              </div>
              <PasswordInput
                ref={passwordRef}
                id="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (issue?.kind === 'wrong_password') setIssue(null);
                }}
                aria-invalid={issue?.kind === 'wrong_password' || undefined}
                className={issue?.kind === 'wrong_password' ? INVALID : undefined}
                aria-describedby={issue?.kind === 'wrong_password' ? 'password-issue' : undefined}
                required
              />
              {issue?.kind === 'wrong_password' && (
                <AuthFieldMessage
                  id="password-issue"
                  actions={<AuthFieldAction onClick={forgotPassword}>Reset password</AuthFieldAction>}
                >
                  That password isn't right. Try again, or reset it.
                </AuthFieldMessage>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Logging in…' : 'Log in'}
            </Button>
          </form>
          <p className="mt-4 text-center text-xs text-gray-500">
            New here?{' '}
            <button className="font-semibold text-[#A7D8F8]" onClick={() => navigate('/claim-business')}>
              Claim your listing
            </button>
          </p>
          {failures >= 2 && <AuthHelpLine />}
        </div>
      </div>
    </div>
  );
}
