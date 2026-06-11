'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(
    searchParams.get('error') ? 'Sign-in failed. Please try again.' : null
  );
  const [busy, setBusy] = useState(false);

  const next = searchParams.get('next') ?? '/dashboard';

  async function signInWithEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push(next);
    router.refresh();
  }

  async function signInWithGoogle() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
  }

  return (
    <main className="container">
      <section className="form-card auth-card">
        <h2 style={{ marginTop: 0 }}>Welcome back 👋</h2>
        <p className="hint" style={{ margin: '-6px 0 16px' }}>
          Log in to see activities matched for your child.
        </p>
        {error && <p className="notice error">{error}</p>}
        <form onSubmit={signInWithEmail}>
          <div className="field">
            <label className="f-label">Email address</label>
            <input
              type="email"
              placeholder="e.g. sarah@gmail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="f-label">Password</label>
            <input
              type="password"
              placeholder="Your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button className="btn" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Signing in…' : 'Log In'}
          </button>
        </form>
        <button
          className="btn outline block"
          style={{ marginTop: 10 }}
          onClick={signInWithGoogle}
        >
          <span style={{ fontWeight: 900 }}>G</span> Continue with Google
        </button>
        <p className="hint center" style={{ marginTop: 14 }}>
          <Link href="/reset-password">Forgot password?</Link> ·{' '}
          <Link href="/signup">Create an account</Link>
        </p>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
