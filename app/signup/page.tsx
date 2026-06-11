'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function SignupPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmationSent, setConfirmationSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function signUpWithEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: `${location.origin}/auth/callback?next=/onboarding`,
      },
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    if (data.session) {
      // Email confirmation disabled — signed in immediately.
      router.push('/onboarding');
      router.refresh();
    } else {
      setConfirmationSent(true);
    }
  }

  async function signUpWithGoogle() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}/auth/callback?next=/onboarding` },
    });
  }

  if (confirmationSent) {
    return (
      <main className="container">
        <section className="form-card auth-card">
          <h2>Check your email</h2>
          <p className="notice">
            We sent a confirmation link to <strong>{email}</strong>. Click it to
            activate your account and start onboarding.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="container">
      <section className="form-card auth-card">
        <h2 style={{ marginTop: 0 }}>Create your profile</h2>
        <p className="hint" style={{ margin: '-6px 0 16px' }}>
          Tell us about your child and get matched in minutes.
        </p>
        {error && <p className="notice error">{error}</p>}
        <form onSubmit={signUpWithEmail}>
          <div className="field">
            <label className="f-label">Full name</label>
            <input
              placeholder="e.g. Sarah Tan"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
            />
          </div>
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
              placeholder="Min 6 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          </div>
          <button className="btn" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Creating…' : 'Sign Up'}
          </button>
        </form>
        <button
          className="btn outline block"
          style={{ marginTop: 10 }}
          onClick={signUpWithGoogle}
        >
          <span style={{ fontWeight: 900 }}>G</span> Continue with Google
        </button>
        <p className="hint center" style={{ marginTop: 14 }}>
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </section>
    </main>
  );
}
