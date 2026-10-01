'use client';

import { useEffect, useState } from 'react';
import { C, Skeleton, adminFetch, card, sgTime, peekCache } from '../_lib/core';

type ContactMessage = {
  id: string; name: string; email: string; subject: string | null; message: string;
  emailed: boolean; email_error: string | null; created_at: string;
};

/**
 * Contact-form inbox.
 *
 * Every /contact submission lands here whether or not the email went out, so
 * nothing is lost while the Resend sending domain is unverified. Rows that
 * failed to send show why.
 */
export default function ContactView() {
  const [rows, setRows] = useState<ContactMessage[] | null>(() => peekCache<{ messages: ContactMessage[] }>('/api/admin/contact')?.messages ?? null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    adminFetch<{ messages: ContactMessage[] }>('/api/admin/contact')
      .then((r) => setRows(r.messages))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  if (err) return <p style={{ color: C.pink }}>{err}</p>;
  if (!rows) return <Skeleton />;

  const undelivered = rows.filter((r) => !r.emailed).length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <h2 style={{ fontWeight: 900, fontSize: 20 }}>Contact form</h2>
        <span style={{ color: C.muted, fontSize: 13 }}>
          {rows.length} message{rows.length === 1 ? '' : 's'}
          {undelivered > 0 && (
            <> · <span style={{ color: C.pink, fontWeight: 800 }}>{undelivered} not emailed</span></>
          )}
        </span>
      </div>

      {undelivered > 0 && (
        <div style={{ ...card(), borderColor: C.pink, marginBottom: 12 }}>
          <p style={{ fontWeight: 800, color: C.pink }}>Email delivery is failing</p>
          <p style={{ color: C.muted, marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>
            Messages are still captured here, so nothing is lost. To get them into the
            inbox, verify babybrain.sg in Resend and set <code>EMAIL_FROM</code> to an
            address on that domain — the default <code>onboarding@resend.dev</code> can
            only deliver to the Resend account owner.
          </p>
        </div>
      )}

      {rows.length === 0 && <p style={{ color: C.muted }}>No messages yet.</p>}

      <div style={{ display: 'grid', gap: 10 }}>
        {rows.map((m) => (
          <div key={m.id} style={card()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <span style={{ fontWeight: 800 }}>{m.subject || 'No subject'}</span>
                <span style={{ color: C.muted, fontSize: 13 }}>
                  {' '}· {m.name} &lt;{m.email}&gt;
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 999,
                  background: m.emailed ? 'rgba(52,199,123,.15)' : 'rgba(255,90,154,.15)',
                  color: m.emailed ? C.green : C.pink,
                }}>
                  {m.emailed ? 'Emailed' : 'Not emailed'}
                </span>
                <span style={{ color: C.muted, fontSize: 12 }}>{sgTime(m.created_at)}</span>
              </div>
            </div>
            <p style={{ marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{m.message}</p>
            {m.email_error && (
              <p style={{ marginTop: 8, color: C.pink, fontSize: 12 }}>Send error: {m.email_error}</p>
            )}
            <a
              href={`mailto:${m.email}?subject=${encodeURIComponent(`Re: ${m.subject || 'your message to BabyBrain'}`)}`}
              style={{ display: 'inline-block', marginTop: 10, color: C.blue, fontWeight: 800, fontSize: 13 }}
            >
              Reply by email →
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}


