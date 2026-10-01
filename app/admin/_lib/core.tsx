'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export const C = {
  bg: '#0d1424', panel: '#151d31', panel2: '#1c2740', border: '#26324f',
  text: '#e8edf7', muted: '#8b96b3', blue: '#4a90ff', green: '#34c77b', pink: '#ff5a9a',
};

export const supabase = createClient();

// ---- toasts: call toast('Saved') / toast(msg, 'error') from anywhere ----
export type ToastItem = { id: number; msg: string; kind: 'ok' | 'error' };
let pushToast: ((msg: string, kind: 'ok' | 'error') => void) | null = null;
export function toast(msg: string, kind: 'ok' | 'error' = 'ok') { pushToast?.(msg, kind); }

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    let n = 0;
    pushToast = (msg, kind) => {
      const id = ++n;
      setItems((p) => [...p.slice(-3), { id, msg, kind }]);
      setTimeout(() => setItems((p) => p.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
    };
    return () => { pushToast = null; };
  }, []);
  return (
    <div role="status" aria-live="polite" style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 10000,
      display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 'min(380px, calc(100vw - 32px))' }}>
      {items.map((t) => (
        <div key={t.id} onClick={() => setItems((p) => p.filter((x) => x.id !== t.id))}
          style={{ background: C.panel2, color: C.text, border: `1px solid ${t.kind === 'error' ? C.pink : C.green}`,
            borderLeftWidth: 4, borderRadius: 10, padding: '10px 14px', fontSize: 13, fontWeight: 700,
            cursor: 'pointer', boxShadow: '0 6px 20px rgba(0,0,0,.35)', animation: 'bb-toast-in .18s ease-out' }}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ---- status badge + skeleton loaders ----
export type Tone = 'green' | 'blue' | 'pink' | 'amber' | 'grey';
export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const bg = { green: C.green, blue: C.blue, pink: C.pink, amber: '#f5b942', grey: C.panel2 }[tone];
  const fg = tone === 'grey' ? C.muted : '#0d1424';
  return (
    <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 800, padding: '3px 8px', borderRadius: 999,
      background: bg, color: fg, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>{children}</span>
  );
}
export function Skeleton({ rows = 5, height = 44 }: { rows?: number; height?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" style={{ display: 'grid', gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="bb-skel" style={{ height }} />)}
    </div>
  );
}
export function CardsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, marginTop: 22 }}>
      {Array.from({ length: 8 }, (_, i) => <div key={i} className="bb-skel" style={{ height: 84 }} />)}
    </div>
  );
}

/**
 * Any tab's own fetch can outlive the page-load admin check (token expires
 * mid-session, or ADMIN_EMAILS changes under a live tab). Without this, only
 * the very first `/api/admin/metrics` call ever flips the shared `phase`, so
 * a later 401/403 from some other tab just left the nav bar up with a stray
 * inline error instead of the shared login/denied screen. AdminPage registers
 * this on mount so every adminFetch call can report auth failures back up.
 */
let onAuthFailure: ((message: string) => void) | null = null;
export function setAuthFailureHandler(fn: ((message: string) => void) | null) { onAuthFailure = fn; }

const readCache = new Map<string, unknown>();
/** The last successful GET of `path`, if any — used to paint a tab instantly before it refetches. */
export function peekCache<T>(path: string): T | undefined {
  return readCache.get(path) as T | undefined;
}
/** Forget every remembered read (used by the Refresh action so tabs repaint from fresh data). */
export function clearAdminCache(): void { readCache.clear(); warmedAt.clear(); }
const warmedAt = new Map<string, number>();
/** Fetch these read endpoints in the background (at most once a minute each) so the tab opens warm. */
export function warmAdminData(paths: string[]): void {
  const now = Date.now();
  for (const p of paths) {
    if (now - (warmedAt.get(p) ?? 0) < 60_000) continue;
    warmedAt.set(p, now);
    adminFetch(p).catch(() => { /* the real visit reports errors */ });
  }
}

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const message = (await res.json().catch(() => ({})))?.error ?? res.statusText;
    // 'Admin only' = a support login hit an admin-only endpoint; that is not a sign-in problem.
    if ((res.status === 401 || res.status === 403) && message !== 'Admin only') onAuthFailure?.(message);
    throw new Error(message);
  }
  const data = (await res.json()) as T;
  // Remember every successful read so a tab can paint its last data at once on the next visit
  // (stale-while-revalidate: the view still refetches and replaces it).
  if (!init?.method || init.method === 'GET') readCache.set(path, data);
  return data;
}

/** Shows what the live-data filter left out, with the switch to bring it back. */
export function TestDataBar({ includeTest, setIncludeTest, excluded }: {
  includeTest: boolean; setIncludeTest: (v: boolean) => void; excluded: string;
}) {
  return (
    <div style={{ ...card(), display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px' }}>
      <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
        {includeTest
          ? <><strong style={{ color: C.pink }}>Including test data</strong> — demo vendors, test-mode payments and test parents are counted.</>
          : <><strong style={{ color: C.green }}>Live data only</strong> — demo vendors, Stripe test-mode payments and test parents are left out{excluded ? ` (${excluded})` : ''}.</>}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
        Include test data
      </label>
    </div>
  );
}

export const pctText = (v: number | null) => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`);

export const sgTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';

export const sgd = (cents: number) =>
  new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(cents / 100);

export function th(): React.CSSProperties {
  return { padding: '10px 12px', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' };
}
export function td(): React.CSSProperties {
  return { padding: '10px 12px', verticalAlign: 'top' };
}

// ---- style helpers ----
export function card(): React.CSSProperties {
  return { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16 };
}
export function input(): React.CSSProperties {
  return { width: '100%', padding: '11px 13px', borderRadius: 10, border: `1px solid ${C.border}`,
    background: C.bg, color: C.text, fontSize: 14, outline: 'none' };
}
export function primaryBtn(): React.CSSProperties {
  return { padding: '11px 18px', borderRadius: 10, border: 'none', background: C.blue, color: '#fff',
    fontWeight: 800, cursor: 'pointer', fontSize: 14 };
}
export function tabBtn(activeTab: boolean): React.CSSProperties {
  return { padding: '8px 14px', borderRadius: 9, border: `1px solid ${activeTab ? C.blue : C.border}`,
    background: activeTab ? C.blue : 'transparent', color: activeTab ? '#fff' : C.text, fontWeight: 700, cursor: 'pointer', fontSize: 14 };
}

export const sgdDollars = (v: number) => new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(v);

export const sgDay = (iso: string) => new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore' });

export const CATEGORY_ORDER = ['Account', 'Parent', 'Provider'] as const;
