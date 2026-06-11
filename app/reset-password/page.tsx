'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function ResetPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/auth/callback?next=/reset-password/update`,
    });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <main className="container">
      <section className="form-card auth-card">
        <h2>Reset your password</h2>
        {error && <p className="notice error">{error}</p>}
        {sent ? (
          <p className="notice">
            If an account exists for <strong>{email}</strong>, a reset link is on
            its way.
          </p>
        ) : (
          <form onSubmit={requestReset}>
            <div className="field">
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <button className="btn" style={{ width: '100%' }}>
              Send reset link
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
