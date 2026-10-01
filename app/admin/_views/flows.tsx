'use client';

import { useEffect, useState } from 'react';
import { C, CATEGORY_ORDER, Skeleton, adminFetch, card, tabBtn, peekCache } from '../_lib/core';

type EmailFlow = {
  type: string; category: 'Account' | 'Parent' | 'Provider'; label: string; description: string;
  wired: boolean; trigger: string;
  last30d: { sent: number; pending: number; failed: number; skipped: number; total: number };
};

export default function FlowsView() {
  const [flows, setFlows] = useState<EmailFlow[] | null>(() => peekCache<{ flows: EmailFlow[] }>('/api/admin/email-flows')?.flows ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ type: string; label: string; subject: string; html: string } | 'loading' | null>(null);

  useEffect(() => {
    adminFetch<{ flows: EmailFlow[] }>('/api/admin/email-flows')
      .then((r) => setFlows(r.flows))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  async function openPreview(f: EmailFlow) {
    setPreview('loading');
    try {
      const r = await adminFetch<{ subject: string; html: string }>(`/api/admin/email-flows/preview?type=${encodeURIComponent(f.type)}`);
      setPreview({ type: f.type, label: f.label, subject: r.subject, html: r.html });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPreview(null);
    }
  }

  if (err) return <p style={{ color: C.pink }}>{err}</p>;
  if (!flows) return <Skeleton />;

  const wiredCount = flows.filter((f) => f.wired).length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
        <h2 style={{ fontWeight: 900, fontSize: 20 }}>Email flows</h2>
        <span style={{ color: C.muted, fontSize: 13 }}>
          {wiredCount} of {flows.length} actually fire today · the rest are branded templates waiting on a trigger
        </span>
      </div>

      {CATEGORY_ORDER.map((cat) => {
        const rows = flows.filter((f) => f.category === cat);
        if (!rows.length) return null;
        return (
          <div key={cat} style={{ marginBottom: 22 }}>
            <div style={{ fontWeight: 800, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, color: C.muted, marginBottom: 8 }}>
              {cat}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map((f) => {
                // "Wired" just means something triggers it — that trigger can
                // still be firing into a broken send (e.g. Resend's domain
                // isn't verified yet, same issue the Contact tab flags).
                // sent===0 with attempts in the last 30d means every attempt
                // failed, which is worse than "not wired" — it looks live but
                // nobody is getting the email.
                const failing = f.wired && f.last30d.total > 0 && f.last30d.sent === 0;
                const badge = !f.wired
                  ? { label: 'Not wired', bg: 'rgba(139,150,179,.15)', color: C.muted }
                  : failing
                    ? { label: 'Failing', bg: 'rgba(255,90,154,.15)', color: C.pink }
                    : { label: 'Live', bg: 'rgba(52,199,123,.15)', color: C.green };
                return (
                <div key={f.type} style={card()}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 240, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 800 }}>{f.label}</span>
                        <span style={{
                          fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: 0.4,
                          background: badge.bg, color: badge.color,
                        }}>
                          {badge.label}
                        </span>
                      </div>
                      <p style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>{f.description}</p>
                      <p style={{ color: C.muted, fontSize: 12, marginTop: 4, fontStyle: 'italic' }}>
                        {failing ? 'Firing, but every attempt in the last 30 days failed to send — check the Resend domain/EMAIL_FROM setup (see Contact form tab).' : f.trigger}
                      </p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
                      {f.last30d.total > 0 && (
                        <div style={{ fontSize: 12, color: C.muted, textAlign: 'right' }}>
                          <div><span style={{ color: C.green, fontWeight: 800 }}>{f.last30d.sent}</span> sent</div>
                          {f.last30d.failed > 0 && <div style={{ color: C.pink }}>{f.last30d.failed} failed</div>}
                          <div>last 30d</div>
                        </div>
                      )}
                      <button onClick={() => openPreview(f)} style={tabBtn(false)}>Preview</button>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {preview && (
        <div
          onClick={() => setPreview(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 640, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.panel, color: C.text }}>
              <div>
                <div style={{ fontWeight: 800 }}>{preview === 'loading' ? 'Loading preview…' : preview.label}</div>
                {preview !== 'loading' && <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>Subject: {preview.subject}</div>}
              </div>
              <button onClick={() => setPreview(null)} style={tabBtn(false)}>Close</button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', background: '#f4f4f4' }}>
              {preview === 'loading' ? (
                <div style={{ padding: 24 }}><Skeleton rows={4} /></div>
              ) : (
                <iframe title="Email preview" srcDoc={preview.html} style={{ width: '100%', height: '70vh', border: 'none', background: '#fff' }} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


