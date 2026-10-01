'use client';

import { useEffect, useState } from 'react';
import { C, Skeleton, adminFetch, card, primaryBtn, supabase, peekCache, toast } from '../_lib/core';


type MarketingSummary = { list: string; count: number; headers: string[]; preview: Record<string, string>[] };

/**
 * Klaviyo is managed by hand (decided 29 Sep): the app sends nothing to it.
 * This tab gives the founder the two lists she needs to do it herself — who
 * may be emailed, and who has unsubscribed and must be suppressed.
 */
export default function MarketingView() {
  const [consented, setConsented] = useState<MarketingSummary | null>(() => peekCache<MarketingSummary>('/api/admin/marketing-contacts?list=consented&format=json') ?? null);
  const [withdrawn, setWithdrawn] = useState<MarketingSummary | null>(() => peekCache<MarketingSummary>('/api/admin/marketing-contacts?list=withdrawn&format=json') ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      adminFetch<MarketingSummary>('/api/admin/marketing-contacts?list=consented&format=json'),
      adminFetch<MarketingSummary>('/api/admin/marketing-contacts?list=withdrawn&format=json'),
    ])
      .then(([c, w]) => { setConsented(c); setWithdrawn(w); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  async function download(list: 'consented' | 'withdrawn') {
    setBusy(list);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/marketing-contacts?list=${list}`, {
        headers: session ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? res.statusText);
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `babybrain-marketing-${list}.csv`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Download started');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  if (err) return <p style={{ color: C.pink }}>{err}</p>;
  if (!consented || !withdrawn) return <Skeleton />;

  const step = (n: number, text: React.ReactNode) => (
    <li style={{ display: 'grid', gridTemplateColumns: '26px 1fr', gap: 10, marginBottom: 8 }}>
      <span style={{ width: 22, height: 22, borderRadius: 999, background: C.panel2, display: 'grid', placeItems: 'center', fontWeight: 900, fontSize: 12 }}>{n}</span>
      <span style={{ color: C.text, fontSize: 14, lineHeight: 1.55 }}>{text}</span>
    </li>
  );

  return (
    <div>
      <h2 style={{ fontWeight: 900, fontSize: 20, marginBottom: 6 }}>Marketing</h2>
      <p style={{ color: C.muted, fontSize: 14, marginBottom: 16, maxWidth: 760, lineHeight: 1.6 }}>
        BabyBrain doesn&apos;t send anything to Klaviyo. Download who has agreed to marketing emails and import them yourself.
        Only people on the first list may be emailed.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div style={card()}>
          <div style={{ color: C.muted, fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>Can be emailed</div>
          <div style={{ fontSize: 32, fontWeight: 900, color: C.green, margin: '4px 0' }}>{consented.count}</div>
          <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
            Parents who ticked marketing consent and haven&apos;t withdrawn it. Includes name, consent date, plan, area and children&apos;s ages for segments.
          </p>
          <button onClick={() => download('consented')} disabled={busy !== null || consented.count === 0} style={{ ...primaryBtn(), opacity: consented.count === 0 ? 0.5 : 1 }}>
            {busy === 'consented' ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
        <div style={card()}>
          <div style={{ color: C.muted, fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>Unsubscribed — suppress</div>
          <div style={{ fontSize: 32, fontWeight: 900, color: C.pink, margin: '4px 0' }}>{withdrawn.count}</div>
          <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
            Parents who unsubscribed in the app (Settings or an email footer link). Recorded from 29 Sep 2026.
          </p>
          <button onClick={() => download('withdrawn')} disabled={busy !== null || withdrawn.count === 0} style={{ ...primaryBtn(), background: C.pink, opacity: withdrawn.count === 0 ? 0.5 : 1 }}>
            {busy === 'withdrawn' ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
      </div>

      <div style={card()}>
        <p style={{ fontWeight: 800, marginBottom: 10 }}>Importing into Klaviyo</p>
        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {step(1, <>Download <b>Can be emailed</b> above.</>)}
          {step(2, <>In Klaviyo, open <b>Audience → Lists &amp; segments</b> and choose your newsletter list.</>)}
          {step(3, <>Choose <b>Manage list → Import contacts</b>, upload the file, and match the columns (Email, First Name and Last Name map automatically; keep the rest as custom properties).</>)}
          {step(4, <>When Klaviyo asks about consent, choose <b>subscribed / consent given</b>. Everyone in this file ticked the marketing box.</>)}
          {step(5, <>Download <b>Unsubscribed</b> and add those emails to <b>Audience → Suppressed profiles</b> (or unsubscribe them from the list) so they&apos;re never emailed again.</>)}
          {step(6, <>Repeat whenever you send a campaign. Importing the same person twice just updates them.</>)}
        </ol>
        <p style={{ color: C.muted, fontSize: 13, marginTop: 8, lineHeight: 1.55 }}>
          People who unsubscribe from a Klaviyo email are handled by Klaviyo itself. People who unsubscribe inside BabyBrain appear in the second list.
        </p>
      </div>
    </div>
  );
}

