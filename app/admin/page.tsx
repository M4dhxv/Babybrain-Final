'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import { C, Skeleton, Toaster, adminFetch, card, input, primaryBtn, setAuthFailureHandler, supabase, tabBtn, toast, warmAdminData, clearAdminCache } from './_lib/core';
import type { ParentFilters } from './_views/parents';
import { CommandPalette } from './_lib/palette';

// Each view is its own chunk, loaded when its tab is first opened (or warmed when the pointer
// reaches its sidebar item), so opening the admin no longer downloads every view up front.
const LOADERS: Record<string, () => Promise<unknown>> = {
  metrics: () => import('./_views/metrics'),
  parents: () => import('./_views/parents'),
  messages: () => import('./_views/messages'),
  contact: () => import('./_views/contact'),
  addVendor: () => import('./_views/vendors'),
  vendors: () => import('./_views/vendors'),
  commercials: () => import('./_views/commercials'),
  payments: () => import('./_views/payments'),
  flows: () => import('./_views/flows'),
  marketing: () => import('./_views/marketing'),
  audit: () => import('./_views/audit'),
};
// The read endpoints each tab loads first, fetched in the background when its sidebar item is hovered.
const WARM_DATA: Record<string, string[]> = {
  metrics: ['/api/admin/metrics'],
  messages: ['/api/admin/channels'],
  contact: ['/api/admin/contact'],
  addVendor: ['/api/admin/providers'],
  vendors: ['/api/admin/vendors/runs'],
  commercials: ['/api/admin/commercials'],
  payments: ['/api/admin/payments?limit=100'],
  flows: ['/api/admin/email-flows'],
  audit: ['/api/admin/audit?limit=300'],
  marketing: ['/api/admin/marketing-contacts?list=consented&format=json', '/api/admin/marketing-contacts?list=withdrawn&format=json'],
};
const preloadTab = (t: string) => {
  LOADERS[t]?.().catch(() => { /* retried on real navigation */ });
  if (WARM_DATA[t]) warmAdminData(WARM_DATA[t]);
};
const viewLoading = () => <Skeleton rows={6} />;
const MetricsView = dynamic(() => import('./_views/metrics'), { ssr: false, loading: viewLoading });
const ParentsView = dynamic(() => import('./_views/parents'), { ssr: false, loading: viewLoading });
const MessagesView = dynamic(() => import('./_views/messages'), { ssr: false, loading: viewLoading });
const ContactView = dynamic(() => import('./_views/contact'), { ssr: false, loading: viewLoading });
const AddVendorView = dynamic(() => import('./_views/vendors'), { ssr: false, loading: viewLoading });
const VendorsView = dynamic(() => import('./_views/vendors').then((m) => m.VendorsView), { ssr: false, loading: viewLoading });
const CommercialsView = dynamic(() => import('./_views/commercials'), { ssr: false, loading: viewLoading });
const PaymentsView = dynamic(() => import('./_views/payments'), { ssr: false, loading: viewLoading });
const FlowsView = dynamic(() => import('./_views/flows'), { ssr: false, loading: viewLoading });
const AuditView = dynamic(() => import('./_views/audit'), { ssr: false, loading: viewLoading });
const MarketingView = dynamic(() => import('./_views/marketing'), { ssr: false, loading: viewLoading });

// ---- navigation: grouped sidebar, tab kept in the URL (?tab=) ----
type Tab = 'metrics' | 'audit' | 'parents' | 'messages' | 'contact' | 'addVendor' | 'vendors' | 'commercials' | 'payments' | 'flows' | 'marketing';
const NAV_GROUPS: { label: string; items: { id: Tab; label: string; icon: string }[] }[] = [
  { label: 'Overview', items: [{ id: 'metrics', label: 'Metrics', icon: 'grid' }] },
  { label: 'People', items: [
    { id: 'parents', label: 'Parents', icon: 'user' },
    { id: 'addVendor', label: 'Vendors', icon: 'plus' },
    { id: 'vendors', label: 'Vendor data', icon: 'list' },
    { id: 'marketing', label: 'Marketing', icon: 'mail' },
  ] },
  { label: 'Money', items: [
    { id: 'commercials', label: 'Commercials', icon: 'percent' },
    { id: 'payments', label: 'Payments', icon: 'dollar' },
  ] },
  { label: 'Comms', items: [
    { id: 'messages', label: 'Messages', icon: 'chat' },
    { id: 'contact', label: 'Contact form', icon: 'phone' },
    { id: 'flows', label: 'Email flows', icon: 'bolt' },
  ] },
  { label: 'System', items: [{ id: 'audit', label: 'Audit log', icon: 'shield' }] },
];
const ICON_PATHS: Record<string, string> = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  plus: 'M12 5v14M5 12h14',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
  percent: 'M19 5L5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  dollar: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  shield: 'M12 3l8 3v6c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V6z',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};
function NavIcon({ name }: { name: string }) {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      <path d={ICON_PATHS[name] ?? ICON_PATHS.grid} />
    </svg>
  );
}
const TAB_IDS = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
/** What a support login may open (everyone in ADMIN_EMAILS may open everything). */
const SUPPORT_TABS = new Set<string>(['parents', 'messages', 'contact', 'flows']);
function tabFromUrl(): Tab {
  const t = new URLSearchParams(window.location.search).get('tab');
  return (TAB_IDS as string[]).includes(t ?? '') ? (t as Tab) : 'metrics';
}

const ADMIN_CSS = `
@keyframes bb-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
.bb-cardbtn:hover, .bb-cardbtn:focus-visible { border-color: #4a90ff !important; outline: none; }
.bb-cardlink { opacity: .0; transition: opacity .12s; }
.bb-cardbtn:hover .bb-cardlink, .bb-cardbtn:focus-visible .bb-cardlink { opacity: 1; }
@keyframes bb-spin { to { transform: rotate(360deg) } }
@keyframes bb-toast-in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
.bb-skel { border-radius: 8px; background: linear-gradient(90deg, #151d31 25%, #1c2740 37%, #151d31 63%); background-size: 400% 100%; animation: bb-shimmer 1.6s ease infinite; }
.bb-shell { display: flex; min-height: 100%; }
.bb-side { width: 220px; flex: none; border-right: 1px solid #26324f; padding: 16px 12px; position: sticky; top: 0; align-self: flex-start; height: 100vh; overflow-y: auto; box-sizing: border-box; }
.bb-main { flex: 1; min-width: 0; }
.bb-navbtn { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; border-radius: 9px; border: none; background: transparent; color: #e8edf7; font: inherit; font-weight: 700; font-size: 14px; cursor: pointer; text-align: left; }
.bb-navbtn:hover { background: #1c2740; }
.bb-navbtn[aria-current="page"] { background: #4a90ff; color: #fff; }
.bb-menu { display: none; }
@media (max-width: 800px) {
  .bb-shell { flex-direction: column; }
  .bb-side { width: auto; height: auto; position: static; border-right: none; border-bottom: 1px solid #26324f; padding: 10px 12px; }
  .bb-menu { display: block; }
  .bb-groups[data-open="false"] { display: none; }
}
`;

export default function AdminPage() {
  const [phase, setPhase] = useState<'loading' | 'login' | 'denied' | 'ok'>('loading');
  const [tab, setTabState] = useState<Tab>('metrics');
  const [menuOpen, setMenuOpen] = useState(false);

  // The tab lives in ?tab= so a refresh keeps your place and a view can be linked to.
  useEffect(() => {
    setTabState(tabFromUrl());
    const onPop = () => setTabState(tabFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    setMenuOpen(false);
    const url = new URL(window.location.href);
    url.search = '';              // a tab's filters don't leak into the next tab
    url.searchParams.set('tab', t);
    window.history.pushState(null, '', url);
  }, []);
  /** Open the Parents tab with these filters already applied (used by the Metrics cards). */
  const openParents = useCallback((filters: Partial<ParentFilters> & { open?: string }) => {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('tab', 'parents');
    for (const [k, v] of Object.entries(filters)) if (v) url.searchParams.set(k, v);
    window.history.pushState(null, '', url);
    setTabState('parents');
    setMenuOpen(false);
    window.scrollTo(0, 0);
  }, []);
  /** Open a vendor straight in its editor (used by the quick search). */
  const openVendor = useCallback((id: string) => {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('tab', 'addVendor');
    url.searchParams.set('edit', id);
    window.history.pushState(null, '', url);
    setTabState('addVendor');
    setMenuOpen(false);
    window.scrollTo(0, 0);
  }, []);
  // ---- live updates: poll a few cheap counts once a minute while the tab is visible ----
  type Pulse = { parents: number; bookings: number; contactUndelivered: number };
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [baseline, setBaseline] = useState<Pulse | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (phase !== 'ok') return;
    let stop = false;
    const poll = () => {
      if (document.visibilityState !== 'visible') return;
      adminFetch<Pulse>('/api/admin/pulse').then((p) => {
        if (stop) return;
        setPulse(p);
        setBaseline((b) => b ?? p);
      }).catch(() => { /* a missed poll is fine */ });
    };
    poll();
    const id = window.setInterval(poll, 60_000);
    document.addEventListener('visibilitychange', poll);
    return () => { stop = true; window.clearInterval(id); document.removeEventListener('visibilitychange', poll); };
  }, [phase]);
  const newSignups = pulse && baseline ? Math.max(0, pulse.parents - baseline.parents) : 0;
  const newBookings = pulse && baseline ? Math.max(0, pulse.bookings - baseline.bookings) : 0;
  const refreshAll = useCallback(() => {
    clearAdminCache();
    setRefreshKey((k) => k + 1);
    setBaseline(pulse);
  }, [pulse]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const signOut = async () => { await supabase.auth.signOut(); setPhase('login'); };

  useEffect(() => {
    setAuthFailureHandler((message) => setPhase(/Not an admin/.test(message) ? 'denied' : 'login'));
    return () => { setAuthFailureHandler(null); };
  }, []);

  const [role, setRole] = useState<'admin' | 'support'>('admin');
  const can = (t: string) => role === 'admin' || SUPPORT_TABS.has(t);
  const viewOk = (t: string) => phase === 'ok' && can(t) && tab === t;

  // A support login that lands on a tab it can't open goes to the inbox instead of a blank page.
  useEffect(() => {
    if (phase === 'ok' && !can(tab)) setTab('messages');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, role, tab]);

  const check = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setPhase('login'); return; }
    try {
      const me = await adminFetch<{ role: 'admin' | 'support' }>('/api/admin/me');
      setRole(me.role);
      setPhase('ok');
    } catch (e) {
      setPhase(e instanceof Error && /Not an admin/.test(e.message) ? 'denied' : 'login');
    }
  }, []);

  useEffect(() => { check(); }, [check]);

  const current = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === tab);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: C.bg, color: C.text,
      overflow: 'auto', fontFamily: 'Nunito, system-ui, sans-serif' }}>
      <style>{ADMIN_CSS}</style>
      <div className="bb-shell">
      {phase === 'ok' ? (
        <aside className="bb-side">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px 14px' }}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>BabyBrain · <span style={{ color: C.blue }}>Admin</span></div>
            <button className="bb-menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)} style={tabBtn(false)}>
              {current?.label ?? 'Menu'} ▾
            </button>
          </div>
          <button type="button" className="bb-navbtn" onClick={() => setPaletteOpen(true)} aria-label="Search (Ctrl+K)"
            style={{ border: `1px solid ${C.border}`, marginBottom: 14, color: C.muted, justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}><NavIcon name="search" />Search</span>
            <span style={{ fontSize: 11, border: `1px solid ${C.border}`, borderRadius: 6, padding: '1px 6px' }}>Ctrl K</span>
          </button>
          {(newSignups > 0 || newBookings > 0) && (
            <button type="button" className="bb-navbtn" onClick={refreshAll}
              style={{ border: `1px solid ${C.blue}`, marginBottom: 14, color: C.blue, fontSize: 12, lineHeight: 1.4 }}>
              <span aria-hidden>●</span>
              <span>{[newSignups ? `${newSignups} new signup${newSignups === 1 ? '' : 's'}` : '', newBookings ? `${newBookings} new booking${newBookings === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')} — Refresh</span>
            </button>
          )}
          <nav className="bb-groups" data-open={menuOpen} aria-label="Admin sections">
            {NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => can(i.id)) })).filter((g) => g.items.length > 0).map((g) => (
              <div key={g.label} style={{ marginBottom: 14 }}>
                <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', padding: '0 12px 6px' }}>{g.label}</div>
                {g.items.map((i) => (
                  <button key={i.id} className="bb-navbtn" aria-current={tab === i.id ? 'page' : undefined} onClick={() => setTab(i.id)}
                    onMouseEnter={() => preloadTab(i.id)} onFocus={() => preloadTab(i.id)}>
                    <NavIcon name={i.icon} />{i.label}
                    {i.id === 'contact' && (pulse?.contactUndelivered ?? 0) > 0 && (
                      <span title="Contact messages not emailed" style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, background: C.pink, color: '#0d1424', borderRadius: 999, padding: '1px 7px' }}>{pulse!.contactUndelivered}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
            <button className="bb-navbtn" onClick={signOut} style={{ color: C.muted }}>
              <NavIcon name="out" />Sign out
            </button>
          </nav>
        </aside>
      ) : (
        <header style={{ padding: '16px 24px', position: 'absolute', top: 0, left: 0 }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>BabyBrain · <span style={{ color: C.blue }}>Admin</span></div>
        </header>
      )}
      <div className="bb-main">
      <main style={{ padding: 24, maxWidth: 1180, margin: '0 auto' }}>
        {phase === 'loading' && <Skeleton rows={3} />}
        {phase === 'login' && <Login onDone={check} />}
        {phase === 'denied' && (
          <div style={{ ...card(), textAlign: 'center', padding: 40 }}>
            <p style={{ fontWeight: 800, fontSize: 18, color: C.text }}>This account isn&apos;t an admin.</p>
            <p style={{ color: C.muted, marginTop: 8 }}>Ask to be added to the ADMIN_EMAILS allowlist.</p>
            <button onClick={signOut}
              style={{ ...primaryBtn(), marginTop: 16 }}>Sign out</button>
          </div>
        )}
        {viewOk('metrics') && <MetricsView key={refreshKey} onOpenParents={openParents} onGoTab={(t) => setTab(t as Tab)} />}
        {viewOk('parents') && <ParentsView key={refreshKey} />}
        {viewOk('messages') && <MessagesView key={refreshKey} />}
        {viewOk('contact') && <ContactView key={refreshKey} />}
        {viewOk('addVendor') && <AddVendorView key={refreshKey} />}
        {viewOk('vendors') && <VendorsView key={refreshKey} />}
        {viewOk('commercials') && <CommercialsView key={refreshKey} />}
        {viewOk('payments') && <PaymentsView key={refreshKey} />}
        {viewOk('flows') && <FlowsView key={refreshKey} />}
        {viewOk('marketing') && <MarketingView key={refreshKey} />}
        {viewOk('audit') && <AuditView key={refreshKey} />}
      </main>
      </div>
      </div>
      <CommandPalette open={paletteOpen && phase === 'ok'} onClose={() => setPaletteOpen(false)}
        tabs={NAV_GROUPS.flatMap((g) => g.items).filter((i) => can(i.id)).map((i) => ({ id: i.id, label: i.label }))}
        onTab={(id) => setTab(id as Tab)}
        onParent={(id, email) => openParents({ q: email, account: 'all', open: id })}
        onVendor={openVendor} />
      <Toaster />
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setErr(error.message);
    else onDone();
  }

  return (
    <form onSubmit={submit} style={{ ...card(), maxWidth: 380, margin: '48px auto', padding: 28 }}>
      <h1 style={{ fontWeight: 900, fontSize: 22, marginBottom: 4, color: C.text }}>Admin sign in</h1>
      <p style={{ color: C.muted, marginBottom: 20, fontSize: 14 }}>Founder access only.</p>
      {err && <p style={{ color: C.pink, marginBottom: 12, fontSize: 14 }}>{err}</p>}
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
        autoComplete="username" style={input()} />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password" style={{ ...input(), marginTop: 10 }} />
      <button type="submit" disabled={busy} style={{ ...primaryBtn(), width: '100%', marginTop: 16 }}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

