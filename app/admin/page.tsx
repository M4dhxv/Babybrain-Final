'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { planLabel, planMonthlyFeeCents } from '@/lib/plans';

// ---- types mirrored from the /api/admin/* routes ----
type Metrics = {
  totals: {
    parents: number; providers: number; activeProviders: number; bookings: number;
    plusSubscribers: number; growthSubscribers: number; reviews: number; activities: number;
  };
  bookings: { today: number; last7: number };
  signups: { today: number; last7: number };
  daily: { date: string; bookings: number; signups: number }[];
  includeTest: boolean;
  excluded: { vendors: number; parents: number; bookings: number; sales: number };
  revenue: {
    sales: number; gross: number; commission: number; vendorNet: number; stripeFees: number;
    commissionCollected: number; commissionToCollect: number; refunded: number;
    last7: { sales: number; gross: number; commission: number };
    last30: { sales: number; gross: number; commission: number };
  };
  growth: { newParents7: number; newParents30: number; newVendors30: number; parentsWhoBooked: number; activatedVendors: number };
  health: {
    bookingSplit: { manual: number; paid: number; paidAmount: number; other: number };
    bookings30: number; cancelled30: number; cancellationRate: number | null;
    waitlisted: number; upcomingFillRate: number | null; upcomingSessions: number;
  };
  subscriptions: {
    plusActive: number; plusPastDue: number; plusCanceled: number;
    vendorPro: number; vendorPremium: number; vendorPastDue: number; vendorCanceled: number;
  };
};
type Channel = {
  id: string; kind: string; name: string; members: string[]; memberCount: number;
  lastMessage: { text: string; at: string | null; userName: string } | null;
};
type Message = {
  id: string; text: string; at: string | null; userId: string; userName: string; isSupport: boolean;
};
type ContactMessage = {
  id: string; name: string; email: string; subject: string | null; message: string;
  emailed: boolean; email_error: string | null; created_at: string;
};
type VendorResult = { name: string; website: string; outcome: 'price_updated' | 'no_price' | 'no_wp'; price_updated: number };
type VendorRun = {
  id: string; trigger: 'cron' | 'manual'; status: 'running' | 'success' | 'error';
  triggered_by: string | null; checked: number; wp_sites: number; prices_updated: number;
  results: VendorResult[]; error: string | null; started_at: string; finished_at: string | null;
};
type EmailFlow = {
  type: string; category: 'Account' | 'Parent' | 'Provider'; label: string; description: string;
  wired: boolean; trigger: string;
  last30d: { sent: number; pending: number; failed: number; skipped: number; total: number };
};
type VendorTerms = {
  provider_id: string; business_name: string; plan: string;
  connected: boolean; payouts_enabled: boolean; is_test?: boolean;
  commission_rate: number; commission_flat_cents: number;
  fee_payer: 'platform' | 'vendor'; commission_on_packages: boolean; custom_terms: boolean;
  lifetime_gross_cents: number; lifetime_commission_cents: number;
  lifetime_net_cents: number; sales_count: number;
};
type AdminCategory = { slug: string; name: string };
type RecentProvider = {
  id: string; business_name: string; slug: string; vendor_category: string;
  region: string | null; status: string; is_claimed: boolean; is_auto_listed: boolean; created_at: string;
};
type NewVendorMeta = { categories: AdminCategory[]; vendorCategories: string[]; recent: RecentProvider[] };
type DraftLocation = { name: string; address: string; postal_code: string };
type DraftSession = {
  starts_at: string; duration_mins: string; capacity: string; teacher_name: string; studio: string;
};
type DraftActivity = {
  title: string; category_slug: string; description: string;
  age_min_months: string; age_max_months: string; price: string; is_published: boolean;
  image_urls: string; external_booking_url: string; requires_medical_disclosure: boolean;
  is_custom_location: boolean; custom_location_label: string;
  sessions: DraftSession[];
};
/** Images are entered as URLs, one per line. */
const splitUrls = (s: string) => s.split(/[\n,]/).map((u) => u.trim()).filter(Boolean);

/** Upload a file to the admin image bucket and hand back its public URL. */
async function uploadImage(file: File, folder: string): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const body = new FormData();
  body.append('file', file);
  body.append('folder', folder);
  const res = await fetch('/api/admin/upload', {
    method: 'POST',
    headers: session ? { Authorization: `Bearer ${session.access_token}` } : {},
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? 'Upload failed');
  return json.url as string;
}

/**
 * One image: paste a URL or upload a file — both end up as a URL, since that's
 * what the column stores either way. Shows a thumbnail once there's something
 * to show, so a broken link is obvious straight away.
 */
function ImageField({
  label, value, folder, onChange, placeholder,
}: {
  label: string; value: string; folder: string;
  onChange: (url: string) => void; placeholder?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = `up-${label.replace(/\W+/g, '')}-${folder}`;

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';           // so re-picking the same file still fires
    if (!f) return;
    setBusy(true); setErr(null);
    try { onChange(await uploadImage(f, folder)); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 5 }}>
        {label}
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={value} onChange={(e) => onChange(e.target.value)} style={input()}
          placeholder={placeholder ?? 'https://… or upload →'} />
        <label htmlFor={id} style={{ ...tabBtn(false), whiteSpace: 'nowrap', lineHeight: '22px', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Uploading…' : 'Upload'}
        </label>
        <input id={id} type="file" accept="image/*" onChange={pick} style={{ display: 'none' }} />
      </div>
      {err && <div style={{ color: C.pink, fontSize: 12, marginTop: 5 }}>{err}</div>}
      {value.trim() && (
        <img src={value} alt="" style={{ height: 40, marginTop: 6, borderRadius: 6, background: C.panel2 }} />
      )}
    </div>
  );
}

/** Several images for one class: a list of URLs plus an uploader that appends. */
function ImageListField({
  value, folder, onChange,
}: { value: string; folder: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = `upl-${folder}`;
  const urls = splitUrls(value);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true); setErr(null);
    try {
      const added: string[] = [];
      for (const f of files) added.push(await uploadImage(f, folder));
      onChange([...urls, ...added].join('\n'));
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
        <label style={{ fontSize: 12, fontWeight: 800, color: C.muted }}>
          Images <span style={{ fontWeight: 600 }}>· paste URLs, one per line, or upload</span>
        </label>
        <label htmlFor={id} style={{ ...tabBtn(false), padding: '4px 9px', fontSize: 12, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Uploading…' : '+ Upload'}
        </label>
        <input id={id} type="file" accept="image/*" multiple onChange={pick} style={{ display: 'none' }} />
      </div>
      <textarea value={value} rows={2} style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
        placeholder="https://…/photo.jpg" onChange={(e) => onChange(e.target.value)} />
      {err && <div style={{ color: C.pink, fontSize: 12, marginTop: 5 }}>{err}</div>}
      {urls.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {urls.slice(0, 6).map((u, k) => (
            <img key={k} src={u} alt="" style={{ height: 38, borderRadius: 6, background: C.panel2 }} />
          ))}
        </div>
      )}
    </div>
  );
}
const blankSession = (): DraftSession =>
  ({ starts_at: '', duration_mins: '60', capacity: '', teacher_name: '', studio: '' });
type CreatedVendor = {
  provider: { id: string; slug: string; business_name: string; region: string | null };
  locations: number; activities: number; geocoded: number; warnings: string[];
};
type EditLocation = {
  id: string; name: string; address: string | null; postal_code: string | null;
  region: string | null; is_primary: boolean; latitude: number | null; longitude: number | null;
};
type EditSession = {
  id: string; starts_at: string; ends_at: string; capacity: number | null;
  teacher_name: string | null; studio: string | null;
  // Captured once from the pristine starts_at/ends_at when this row loads —
  // see the save-payload builder below for why this can't be recomputed from
  // current form state.
  duration_mins: number;
};
type EditActivity = {
  id: string; title: string; slug: string; category_slug: string | null; category_name: string | null;
  age_min_months: number; age_max_months: number; price: number | null; is_published: boolean;
  description: string | null; external_booking_url: string | null;
  image_urls: string[]; requires_medical_disclosure: boolean; bookings_paused: boolean;
  location_id: string | null;
  is_custom_location: boolean; custom_location_label: string | null;
  sessions: EditSession[];
};
type ProviderDetail = {
  id: string; business_name: string; slug: string | null; description: string | null;
  vendor_category: string | null; contact_email: string | null; contact_phone: string | null;
  whatsapp: string | null; website: string | null; address: string | null; postal_code: string | null;
  region: string | null; status: string; is_claimed: boolean; is_auto_listed: boolean;
  latitude: number | null; longitude: number | null;
  logo_url: string | null; cover_image_url: string | null; uen: string | null;
  social: { instagram?: string | null; facebook?: string | null; tiktok?: string | null } | null;
  payouts_enabled: boolean; allow_manual_payouts: boolean;
  locations: EditLocation[]; activities: EditActivity[];
};
type SaveResult = {
  provider: { id: string; business_name: string; slug: string | null; region: string | null };
  locationsChanged: number; activitiesChanged: number; sessionsChanged: number;
  regeocoded: boolean; warnings: string[];
};

const VENDOR_CATEGORY_LABELS: Record<string, string> = {
  'baby-toddler-classes': 'Baby & toddler classes',
  playspaces: 'Playspace',
  'camps-holiday': 'Holiday camps',
  'community-events': 'Community events',
  'mum-bub-exercise': 'Parent & child exercise',
  other: 'Other',
};

const C = {
  bg: '#0d1424', panel: '#151d31', panel2: '#1c2740', border: '#26324f',
  text: '#e8edf7', muted: '#8b96b3', blue: '#4a90ff', green: '#34c77b', pink: '#ff5a9a',
};

const supabase = createClient();

// ---- navigation: grouped sidebar, tab kept in the URL (?tab=) ----
type Tab = 'metrics' | 'parents' | 'messages' | 'contact' | 'addVendor' | 'vendors' | 'commercials' | 'payments' | 'flows' | 'marketing';
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
function tabFromUrl(): Tab {
  const t = new URLSearchParams(window.location.search).get('tab');
  return (TAB_IDS as string[]).includes(t ?? '') ? (t as Tab) : 'metrics';
}

const ADMIN_CSS = `
@keyframes bb-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
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

// ---- toasts: call toast('Saved') / toast(msg, 'error') from anywhere ----
type ToastItem = { id: number; msg: string; kind: 'ok' | 'error' };
let pushToast: ((msg: string, kind: 'ok' | 'error') => void) | null = null;
function toast(msg: string, kind: 'ok' | 'error' = 'ok') { pushToast?.(msg, kind); }

function Toaster() {
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
type Tone = 'green' | 'blue' | 'pink' | 'amber' | 'grey';
function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const bg = { green: C.green, blue: C.blue, pink: C.pink, amber: '#f5b942', grey: C.panel2 }[tone];
  const fg = tone === 'grey' ? C.muted : '#0d1424';
  return (
    <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 800, padding: '3px 8px', borderRadius: 999,
      background: bg, color: fg, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>{children}</span>
  );
}
function Skeleton({ rows = 5, height = 44 }: { rows?: number; height?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" style={{ display: 'grid', gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="bb-skel" style={{ height }} />)}
    </div>
  );
}
function CardsSkeleton() {
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

async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
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
    if (res.status === 401 || res.status === 403) onAuthFailure?.(message);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

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
    url.searchParams.set('tab', t);
    window.history.pushState(null, '', url);
  }, []);
  const signOut = async () => { await supabase.auth.signOut(); setPhase('login'); };

  useEffect(() => {
    onAuthFailure = (message) => setPhase(/Not an admin/.test(message) ? 'denied' : 'login');
    return () => { onAuthFailure = null; };
  }, []);

  const check = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setPhase('login'); return; }
    try {
      await adminFetch('/api/admin/metrics');
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
          <nav className="bb-groups" data-open={menuOpen} aria-label="Admin sections">
            {NAV_GROUPS.map((g) => (
              <div key={g.label} style={{ marginBottom: 14 }}>
                <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', padding: '0 12px 6px' }}>{g.label}</div>
                {g.items.map((i) => (
                  <button key={i.id} className="bb-navbtn" aria-current={tab === i.id ? 'page' : undefined} onClick={() => setTab(i.id)}>
                    <NavIcon name={i.icon} />{i.label}
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
        {phase === 'ok' && tab === 'metrics' && <MetricsView />}
        {phase === 'ok' && tab === 'parents' && <ParentsView />}
        {phase === 'ok' && tab === 'messages' && <MessagesView />}
        {phase === 'ok' && tab === 'contact' && <ContactView />}
        {phase === 'ok' && tab === 'addVendor' && <AddVendorView />}
        {phase === 'ok' && tab === 'vendors' && <VendorsView />}
        {phase === 'ok' && tab === 'commercials' && <CommercialsView />}
        {phase === 'ok' && tab === 'payments' && <PaymentsView />}
        {phase === 'ok' && tab === 'flows' && <FlowsView />}
        {phase === 'ok' && tab === 'marketing' && <MarketingView />}
      </main>
      </div>
      </div>
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

/** Shows what the live-data filter left out, with the switch to bring it back. */
function TestDataBar({ includeTest, setIncludeTest, excluded }: {
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

const pctText = (v: number | null) => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`);

function MetricsView() {
  const [m, setM] = useState<Metrics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [includeTest, setIncludeTest] = useState(false);
  useEffect(() => {
    let stale = false;
    setErr(null);
    adminFetch<Metrics>(`/api/admin/metrics${includeTest ? '?include_test=1' : ''}`)
      .then((r) => { if (!stale) setM(r); })
      .catch((e) => { if (!stale) setErr(String(e.message ?? e)); });
    return () => { stale = true; };
  }, [includeTest]);

  if (err) return <p style={{ color: C.pink }}>{err}</p>;
  if (!m) return <CardsSkeleton />;

  type Row = [string, number | string, string, string?];
  const section = (title: string, rows: Row[]) => (
    <div>
      <div style={{ fontWeight: 800, fontSize: 14, margin: '22px 0 10px' }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
        {rows.map(([label, value, color, sub]) => (
          <div key={label} style={card()}>
            <div style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontSize: 28, fontWeight: 900, color, marginTop: 6 }}>{value}</div>
            {sub && <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );

  const r = m.revenue;
  const maxDaily = Math.max(1, ...m.daily.map((d) => Math.max(d.bookings, d.signups)));
  const ex = m.excluded;
  const excludedText = [
    ex.vendors ? `${ex.vendors} vendor${ex.vendors === 1 ? '' : 's'}` : '',
    ex.parents ? `${ex.parents} parent${ex.parents === 1 ? '' : 's'}` : '',
    ex.bookings ? `${ex.bookings} booking${ex.bookings === 1 ? '' : 's'}` : '',
    ex.sales ? `${ex.sales} sale${ex.sales === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(', ');

  return (
    <div>
      <TestDataBar includeTest={includeTest} setIncludeTest={setIncludeTest} excluded={excludedText} />

      {section('Revenue and commission', [
        ['Gross sales', sgd(r.gross), C.text, `${r.sales} paid sale${r.sales === 1 ? '' : 's'}`],
        ['BabyBrain commission', sgd(r.commission), C.green, 'Before Stripe fees'],
        ['Commission collected', sgd(r.commissionCollected), C.green, 'Taken automatically by Stripe'],
        ['Commission to collect', sgd(r.commissionToCollect), C.pink, 'On sales we settle manually'],
        ["Stripe's fees", sgd(r.stripeFees), C.muted],
        ['Vendor net', sgd(r.vendorNet), C.text],
        ['Last 7 days', sgd(r.last7.gross), C.blue, `${r.last7.sales} sales · ${sgd(r.last7.commission)} commission`],
        ['Last 30 days', sgd(r.last30.gross), C.blue, `${r.last30.sales} sales · ${sgd(r.last30.commission)} commission`],
      ])}

      {section('Growth', [
        ['Parents', m.totals.parents, C.blue],
        ['New parents (7d)', m.growth.newParents7, C.blue],
        ['New parents (30d)', m.growth.newParents30, C.blue],
        ['Parents who booked', m.growth.parentsWhoBooked, C.pink, m.totals.parents ? `${pctText(m.growth.parentsWhoBooked / m.totals.parents)} of parents` : undefined],
        ['Vendors (active)', m.totals.activeProviders, C.green, `${m.totals.providers} in total`],
        ['New vendors (30d)', m.growth.newVendors30, C.blue],
        ['Activated vendors', m.growth.activatedVendors, C.green, 'Live class and a booking'],
      ])}

      {section('Booking health', [
        ['Bookings today', m.bookings.today, C.pink],
        ['Bookings (7d)', m.bookings.last7, C.pink],
        ['Bookings (30d)', m.health.bookings30, C.pink],
        ['Bookings (all)', m.totals.bookings, C.muted],
        ['Manual bookings', m.health.bookingSplit.manual, C.blue, 'Added by vendors, no parent account'],
        ['Paid bookings', m.health.bookingSplit.paid, C.green, `${sgdDollars(m.health.bookingSplit.paidAmount)} paid online`],
        ['Free / package', m.health.bookingSplit.other, C.muted, 'Free classes and package credits'],
        ['Cancellation rate (30d)', pctText(m.health.cancellationRate), C.text, `${m.health.cancelled30} cancelled`],
        ['Upcoming fill rate', pctText(m.health.upcomingFillRate), C.green, `${m.health.upcomingSessions} sessions with a capacity`],
        ['On waitlists', m.health.waitlisted, C.muted],
        ['Activities', m.totals.activities, C.muted],
        ['Reviews', m.totals.reviews, C.muted],
      ])}

      {section('Subscriptions', [
        ['Plus subscribers', m.subscriptions.plusActive, C.green, `${m.subscriptions.plusPastDue} past due · ${m.subscriptions.plusCanceled} cancelled`],
        ['Vendors on Pro', m.subscriptions.vendorPro, C.green],
        ['Vendors on Premium', m.subscriptions.vendorPremium, C.green],
        ['Vendor plans at risk', m.subscriptions.vendorPastDue, C.pink, `${m.subscriptions.vendorCanceled} cancelled`],
      ])}

      <div style={{ ...card(), marginTop: 22, padding: 20 }}>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>Last 14 days</div>
        <div style={{ display: 'flex', gap: 16, color: C.muted, fontSize: 12, marginBottom: 14 }}>
          <span><span style={{ color: C.pink }}>■</span> Bookings</span>
          <span><span style={{ color: C.blue }}>■</span> Signups</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 140 }}>
          {m.daily.map((d) => (
            <div key={d.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 110, width: '100%', justifyContent: 'center' }}>
                <div title={`${d.bookings} bookings`} style={{ width: 8, background: C.pink, borderRadius: 3,
                  height: `${(d.bookings / maxDaily) * 100}%`, minHeight: d.bookings ? 3 : 0 }} />
                <div title={`${d.signups} signups`} style={{ width: 8, background: C.blue, borderRadius: 3,
                  height: `${(d.signups / maxDaily) * 100}%`, minHeight: d.signups ? 3 : 0 }} />
              </div>
              <div style={{ color: C.muted, fontSize: 9 }}>{d.date.slice(5)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MessagesView() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  // Tracks whichever channel is current *right now*, synchronously — `active`
  // state is a snapshot from whenever the closure that reads it was created,
  // so an in-flight fetch/send that reads `active` instead of this ref would
  // apply its result to a channel the admin has since clicked away from.
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    adminFetch<{ channels: Channel[] }>('/api/admin/channels').then((r) => setChannels(r.channels)).catch(() => setChannels([]));
  }, []);

  const openChannel = useCallback(async (ch: Channel) => {
    activeIdRef.current = ch.id;
    setActive(ch); setMessages([]); setLoadingMsgs(true);
    try {
      const r = await adminFetch<{ messages: Message[] }>(`/api/admin/messages?channelId=${encodeURIComponent(ch.id)}`);
      // The admin may have clicked a different channel while this was in
      // flight — a slower fetch for the channel clicked *first* landing
      // after a faster one for the channel clicked *second* used to show
      // the wrong thread under the current header.
      if (activeIdRef.current !== ch.id) return;
      setMessages(r.messages);
    } finally {
      if (activeIdRef.current === ch.id) setLoadingMsgs(false);
    }
  }, []);

  async function send() {
    if (!active || !reply.trim()) return;
    const channelId = active.id;
    setSending(true);
    try {
      const r = await adminFetch<{ message: Message }>('/api/admin/messages', {
        method: 'POST', body: JSON.stringify({ channelId, text: reply.trim() }),
      });
      // Same guard as openChannel: don't let a reply sent to channel A land
      // in whichever channel happens to be open when the response arrives —
      // append it only if the admin is still looking at the channel it was
      // actually sent to.
      if (activeIdRef.current === channelId) {
        setMessages((prev) => [...prev, r.message]);
        setReply('');
      }
    } finally { setSending(false); }
  }

  const filtered = (channels ?? []).filter((c) =>
    !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.kind.toLowerCase().includes(q.toLowerCase()));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, height: 'calc(100vh - 150px)' }}>
      {/* channel list */}
      <div style={{ ...card(), padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: 12, borderBottom: `1px solid ${C.border}` }}>
          <input placeholder="Search conversations…" value={q} onChange={(e) => setQ(e.target.value)} style={input()} />
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {channels === null && <div style={{ padding: 16 }}><Skeleton rows={6} height={40} /></div>}
          {channels?.length === 0 && <p style={{ color: C.muted, padding: 16 }}>No conversations yet.</p>}
          {filtered.map((ch) => (
            <button key={ch.id} onClick={() => openChannel(ch)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px', background:
                active?.id === ch.id ? C.panel2 : 'transparent', border: 'none', borderBottom: `1px solid ${C.border}`,
                color: C.text, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontWeight: 800, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.name}</span>
                <span style={{ fontSize: 10, color: C.blue, flexShrink: 0 }}>{ch.kind}</span>
              </div>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ch.lastMessage ? `${ch.lastMessage.userName}: ${ch.lastMessage.text}` : `${ch.memberCount} members`}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* thread */}
      <div style={{ ...card(), padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!active ? (
          <div style={{ margin: 'auto', color: C.muted }}>Select a conversation.</div>
        ) : (
          <>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontWeight: 900 }}>{active.name}</div>
              <div style={{ color: C.muted, fontSize: 12 }}>{active.kind} · {active.members.join(', ')}</div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {loadingMsgs && <Skeleton rows={4} height={36} />}
              {!loadingMsgs && messages.length === 0 && <p style={{ color: C.muted }}>No messages yet.</p>}
              {messages.map((msg) => (
                <div key={msg.id} style={{ alignSelf: msg.isSupport ? 'flex-end' : 'flex-start', maxWidth: '70%' }}>
                  <div style={{ fontSize: 11, color: msg.isSupport ? C.green : C.muted, marginBottom: 2 }}>
                    {msg.userName}{msg.at ? ` · ${new Date(msg.at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
                  </div>
                  <div style={{ background: msg.isSupport ? C.blue : C.panel2, color: msg.isSupport ? '#fff' : C.text,
                    padding: '8px 12px', borderRadius: 12, fontSize: 14, wordBreak: 'break-word' }}>{msg.text}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, padding: 14, borderTop: `1px solid ${C.border}` }}>
              <input placeholder="Reply as BabyBrain Support…" value={reply} onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                style={{ ...input(), flex: 1 }} />
              <button onClick={send} disabled={sending || !reply.trim()} style={primaryBtn()}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const sgTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';

/**
 * Contact-form inbox.
 *
 * Every /contact submission lands here whether or not the email went out, so
 * nothing is lost while the Resend sending domain is unverified. Rows that
 * failed to send show why.
 */
function ContactView() {
  const [rows, setRows] = useState<ContactMessage[] | null>(null);
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

const OUTCOME: Record<VendorResult['outcome'], { label: string; color: string }> = {
  price_updated: { label: 'Price updated', color: C.green },
  no_price: { label: 'Crawled · no price', color: C.muted },
  no_wp: { label: 'Unreachable / no content', color: C.pink },
};

/**
 * Add a vendor to the directory by hand — the business, its venues and its
 * classes — without touching SQL. Everything the parent app needs to show a
 * listing properly is on this one form; venues are geocoded server-side so the
 * new vendor appears on the Explore map and under its area filter immediately.
 */
function AddVendorView() {
  const [meta, setMeta] = useState<NewVendorMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<CreatedVendor | null>(null);

  // business
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [vendorCategory, setVendorCategory] = useState('baby-toddler-classes');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [bookingUrl, setBookingUrl] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [address, setAddress] = useState('');
  const [postal, setPostal] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [uen, setUen] = useState('');
  const [instagram, setInstagram] = useState('');
  const [facebook, setFacebook] = useState('');
  const [tiktok, setTiktok] = useState('');

  const [locations, setLocations] = useState<DraftLocation[]>([]);
  const [activities, setActivities] = useState<DraftActivity[]>([]);
  // A new vendor never has payouts set up yet — publishing a class that
  // checks out through BabyBrain (no external booking link) needs this
  // ticked, or the create call is rejected. See admin-create-provider.ts.
  const [overridePayoutGate, setOverridePayoutGate] = useState(false);

  // directory list: search + which vendor is open in the editor
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setMeta(await adminFetch<NewVendorMeta>('/api/admin/providers')); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const q = search.trim().toLowerCase();
  const filteredVendors = !meta ? [] : !q ? meta.recent : meta.recent.filter((p) =>
    [p.business_name, p.slug, p.region ?? '', VENDOR_CATEGORY_LABELS[p.vendor_category] ?? p.vendor_category]
      .join(' ').toLowerCase().includes(q));

  // The slug is derived from the name until the founder edits it herself.
  const autoSlug = name.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
  const effectiveSlug = slugTouched ? slug : autoSlug;

  const defaultCategory = meta?.categories[0]?.slug ?? 'music';

  function reset() {
    setName(''); setSlug(''); setSlugTouched(false); setVendorCategory('baby-toddler-classes');
    setDescription(''); setWebsite(''); setBookingUrl(''); setEmail(''); setPhone('');
    setWhatsapp(''); setAddress(''); setPostal(''); setLocations([]); setActivities([]);
    setLogoUrl(''); setCoverUrl(''); setUen(''); setInstagram(''); setFacebook(''); setTiktok('');
    setOverridePayoutGate(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setDone(null);
    try {
      const payload = {
        business_name: name,
        slug: effectiveSlug,
        description,
        vendor_category: vendorCategory,
        contact_email: email,
        contact_phone: phone,
        whatsapp,
        website,
        booking_url: bookingUrl,
        address,
        postal_code: postal,
        logo_url: logoUrl,
        cover_image_url: coverUrl,
        uen,
        social: { instagram, facebook, tiktok },
        locations: locations.map((l) => ({ name: l.name, address: l.address, postal_code: l.postal_code })),
        activities: activities
          .filter((a) => a.title.trim())
          .map((a) => ({
            title: a.title,
            category_slug: a.category_slug,
            description: a.description,
            age_min_months: a.age_min_months === '' ? null : Number(a.age_min_months),
            age_max_months: a.age_max_months === '' ? null : Number(a.age_max_months),
            price: a.price === '' ? null : Number(a.price),
            is_published: a.is_published,
            image_urls: splitUrls(a.image_urls),
            external_booking_url: a.external_booking_url,
            requires_medical_disclosure: a.requires_medical_disclosure,
            is_custom_location: a.is_custom_location,
            custom_location_label: a.is_custom_location ? a.custom_location_label : null,
            sessions: a.sessions
              .filter((s) => s.starts_at.trim())
              .map((s) => ({
                starts_at: s.starts_at,
                duration_mins: s.duration_mins === '' ? null : Number(s.duration_mins),
                capacity: s.capacity === '' ? null : Number(s.capacity),
                teacher_name: s.teacher_name,
                studio: s.studio,
              })),
          })),
        overridePayoutGate,
      };
      const r = await adminFetch<CreatedVendor>('/api/admin/providers', {
        method: 'POST', body: JSON.stringify(payload),
      });
      setDone(r);
      toast('Vendor created');
      reset();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  }

  const label = (t: string): React.CSSProperties => ({ fontSize: 12, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 5 });
  const field = { marginBottom: 12 };
  const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };

  return (
    <div>
      <form onSubmit={submit}>
        <div style={card()}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Add a vendor to the directory</div>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 4, maxWidth: 720 }}>
            Creates the business, its venues and its classes in one go. Addresses are looked up
            automatically so the vendor shows on the Explore map and under the right area filter.
            The listing is unclaimed, so the vendor can claim it later, and the weekly crawler will
            never overwrite what you type here.
          </div>
        </div>

        {/* ---- business ---- */}
        <div style={{ ...card(), marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 14 }}>Business</div>

          <div style={grid2}>
            <div style={field}>
              <label style={label('')}>Business name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} style={input()} placeholder="Little Blue Chair" required />
            </div>
            <div style={field}>
              <label style={label('')}>Page address (slug)</label>
              <input value={effectiveSlug}
                onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }}
                style={input()} placeholder="little-blue-chair" />
            </div>
          </div>

          <div style={grid2}>
            <div style={field}>
              <label style={label('')}>Business type *</label>
              <select value={vendorCategory} onChange={(e) => setVendorCategory(e.target.value)} style={input()}>
                {(meta?.vendorCategories ?? Object.keys(VENDOR_CATEGORY_LABELS)).map((v) => (
                  <option key={v} value={v}>{VENDOR_CATEGORY_LABELS[v] ?? v}</option>
                ))}
              </select>
            </div>
            <div style={field}>
              <label style={label('')}>Website</label>
              <input value={website} onChange={(e) => setWebsite(e.target.value)} style={input()} placeholder="https://…" />
            </div>
          </div>

          <div style={field}>
            <label style={label('')}>Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              rows={3} style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="What they do, in a sentence or two — this is what parents read on the listing." />
          </div>

          <div style={grid2}>
            <div style={field}>
              <label style={label('')}>Address</label>
              <input value={address} onChange={(e) => setAddress(e.target.value)} style={input()} placeholder="25E Lor Liput, Singapore" />
            </div>
            <div style={field}>
              <label style={label('')}>Postal code <span style={{ color: C.blue }}>· drives the map pin &amp; area</span></label>
              <input value={postal} onChange={(e) => setPostal(e.target.value)} style={input()} placeholder="277736" />
            </div>
          </div>

          <div style={grid2}>
            <div style={field}>
              <label style={label('')}>Contact email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} style={input()} placeholder="hello@…" />
            </div>
            <div style={field}>
              <label style={label('')}>Phone</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} style={input()} placeholder="8123 4567" />
            </div>
          </div>

          <div style={grid2}>
            <div style={field}>
              <label style={label('')}>WhatsApp</label>
              <input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} style={input()} placeholder="+65…" />
            </div>
            <div style={field}>
              <label style={label('')}>Booking link</label>
              <input value={bookingUrl} onChange={(e) => setBookingUrl(e.target.value)} style={input()}
                placeholder="Leave blank to send parents to the website" />
            </div>
          </div>

          <div style={grid2}>
            <div style={field}>
              <ImageField label="Logo" value={logoUrl} folder={effectiveSlug || 'new-vendor'} onChange={setLogoUrl} />
            </div>
            <div style={field}>
              <ImageField label="Cover image" value={coverUrl} folder={effectiveSlug || 'new-vendor'} onChange={setCoverUrl} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
            <div style={field}>
              <label style={label('')}>Instagram</label>
              <input value={instagram} onChange={(e) => setInstagram(e.target.value)} style={input()} placeholder="@handle or URL" />
            </div>
            <div style={field}>
              <label style={label('')}>Facebook</label>
              <input value={facebook} onChange={(e) => setFacebook(e.target.value)} style={input()} />
            </div>
            <div style={field}>
              <label style={label('')}>TikTok</label>
              <input value={tiktok} onChange={(e) => setTiktok(e.target.value)} style={input()} />
            </div>
            <div style={field}>
              <label style={label('')}>UEN</label>
              <input value={uen} onChange={(e) => setUen(e.target.value)} style={input()} placeholder="business reg. no." />
            </div>
          </div>
        </div>

        {/* ---- venues ---- */}
        <div style={{ ...card(), marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 800 }}>Venues</div>
              <div style={{ color: C.muted, fontSize: 13, marginTop: 3 }}>
                One per place they teach — each gets its own pin. Skip this if they only use the address above.
              </div>
            </div>
            <button type="button" onClick={() => setLocations((p) => [...p, { name: '', address: '', postal_code: '' }])}
              style={{ ...tabBtn(false), whiteSpace: 'nowrap' }}>+ Add venue</button>
          </div>

          {locations.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No extra venues.</div>}
          {locations.map((l, i) => (
            <div key={i} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 140px 40px', gap: 10, alignItems: 'end' }}>
                <div>
                  <label style={label('')}>Venue name</label>
                  <input value={l.name} style={input()} placeholder="East Coast studio"
                    onChange={(e) => setLocations((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                </div>
                <div>
                  <label style={label('')}>Address</label>
                  <input value={l.address} style={input()}
                    onChange={(e) => setLocations((p) => p.map((x, j) => j === i ? { ...x, address: e.target.value } : x))} />
                </div>
                <div>
                  <label style={label('')}>Postal code</label>
                  <input value={l.postal_code} style={input()}
                    onChange={(e) => setLocations((p) => p.map((x, j) => j === i ? { ...x, postal_code: e.target.value } : x))} />
                </div>
                <button type="button" title="Remove venue"
                  onClick={() => setLocations((p) => p.filter((_, j) => j !== i))}
                  style={{ ...tabBtn(false), color: C.pink, borderColor: C.border, height: 42 }}>✕</button>
              </div>
            </div>
          ))}
        </div>

        {/* ---- classes ---- */}
        <div style={{ ...card(), marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 800 }}>Classes</div>
              <div style={{ color: C.muted, fontSize: 13, marginTop: 3 }}>
                What parents can browse and book. A vendor with no classes won&rsquo;t appear in search results.
              </div>
            </div>
            <button type="button"
              onClick={() => setActivities((p) => [...p, {
                title: '', category_slug: defaultCategory, description: '',
                age_min_months: '', age_max_months: '', price: '', is_published: true,
                image_urls: '', external_booking_url: '', requires_medical_disclosure: false,
                is_custom_location: false, custom_location_label: '',
                sessions: [],
              }])}
              style={{ ...tabBtn(false), whiteSpace: 'nowrap' }}>+ Add class</button>
          </div>

          {activities.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No classes yet.</div>}
          {activities.map((a, i) => (
            <div key={i} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 40px', gap: 10, alignItems: 'end' }}>
                <div>
                  <label style={label('')}>Class name</label>
                  <input value={a.title} style={input()} placeholder="Outdoor Sensory Play"
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />
                </div>
                <div>
                  <label style={label('')}>Category</label>
                  <select value={a.category_slug} style={input()}
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, category_slug: e.target.value } : x))}>
                    {(meta?.categories ?? []).map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                  </select>
                </div>
                <button type="button" title="Remove class"
                  onClick={() => setActivities((p) => p.filter((_, j) => j !== i))}
                  style={{ ...tabBtn(false), color: C.pink, borderColor: C.border, height: 42 }}>✕</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginTop: 10 }}>
                <div>
                  <label style={label('')}>Age from (months)</label>
                  <input value={a.age_min_months} inputMode="numeric" style={input()} placeholder="0"
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, age_min_months: e.target.value.replace(/\D/g, '') } : x))} />
                </div>
                <div>
                  <label style={label('')}>Age to (months)</label>
                  <input value={a.age_max_months} inputMode="numeric" style={input()} placeholder="132"
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, age_max_months: e.target.value.replace(/\D/g, '') } : x))} />
                </div>
                <div>
                  <label style={label('')}>Price (SGD)</label>
                  <input value={a.price} inputMode="decimal" style={input()} placeholder="blank = on enquiry"
                    // Strip anything but digits/dot, then collapse any dot
                    // after the first one — "12.3.4" used to pass straight
                    // through, becoming NaN at submit, which JSON.stringify
                    // silently turns into null: the vendor saved fine but
                    // its price silently became "on enquiry" with no error.
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, price: e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') } : x))} />
                </div>
                <div>
                  <label style={label('')}>Visible to parents</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42, fontSize: 14 }}>
                    <input type="checkbox" checked={a.is_published}
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, is_published: e.target.checked } : x))} />
                    {a.is_published ? 'Published' : 'Hidden'}
                  </label>
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <label style={label('')}>Description</label>
                <input value={a.description} style={input()} placeholder="Falls back to the business description if blank"
                  onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                <ImageListField
                  value={a.image_urls}
                  folder={`${effectiveSlug || 'new-vendor'}-class-${i}`}
                  onChange={(v) => setActivities((p) => p.map((x, j) => j === i ? { ...x, image_urls: v } : x))}
                />
                <div>
                  <label style={label('')}>Booking link for this class</label>
                  <input value={a.external_booking_url} style={input()}
                    placeholder="blank = use the business booking link"
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, external_booking_url: e.target.value } : x))} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13 }}>
                    <input type="checkbox" checked={a.requires_medical_disclosure}
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, requires_medical_disclosure: e.target.checked } : x))} />
                    Ask for a medical disclosure before booking
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13 }}>
                    <input type="checkbox" checked={a.is_custom_location}
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, is_custom_location: e.target.checked } : x))} />
                    Private session at the customer&rsquo;s home (no fixed venue)
                  </label>
                  {a.is_custom_location && (
                    <input value={a.custom_location_label} style={{ ...input(), marginTop: 6 }}
                      placeholder='Shown to parents instead of "Custom", e.g. "We travel to you"'
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, custom_location_label: e.target.value } : x))} />
                  )}
                </div>
              </div>

              {/* Schedule. Without a session a class shows "Schedule TBC" and
                  can't be booked — most of the catalogue is in that state. */}
              <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: C.muted }}>
                    SESSIONS {a.sessions.length === 0 && <span style={{ color: C.pink }}>· none yet — shows &ldquo;Schedule TBC&rdquo; and can&rsquo;t be booked</span>}
                  </span>
                  <button type="button" style={{ ...tabBtn(false), padding: '5px 10px', fontSize: 12 }}
                    onClick={() => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: [...x.sessions, blankSession()] } : x))}>
                    + Session
                  </button>
                </div>
                {a.sessions.map((s, si) => (
                  <div key={si} style={{ display: 'grid', gridTemplateColumns: '1.4fr 80px 80px 1fr 1fr 34px', gap: 8, marginBottom: 8 }}>
                    <input type="datetime-local" value={s.starts_at} style={input()}
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, starts_at: e.target.value } : y) } : x))} />
                    <input value={s.duration_mins} inputMode="numeric" style={input()} placeholder="mins"
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, duration_mins: e.target.value.replace(/\D/g, '') } : y) } : x))} />
                    <input value={s.capacity} inputMode="numeric" style={input()} placeholder="cap"
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, capacity: e.target.value.replace(/\D/g, '') } : y) } : x))} />
                    <input value={s.teacher_name} style={input()} placeholder="teacher"
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, teacher_name: e.target.value } : y) } : x))} />
                    <input value={s.studio} style={input()} placeholder="room"
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, studio: e.target.value } : y) } : x))} />
                    <button type="button" style={{ ...tabBtn(false), color: C.pink, padding: 0 }}
                      onClick={() => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.filter((_, k) => k !== si) } : x))}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {err && <div style={{ ...card(), marginTop: 12, borderColor: C.pink, color: C.pink }}>{err}</div>}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: C.muted }}>
          <input type="checkbox" checked={overridePayoutGate}
            onChange={(e) => setOverridePayoutGate(e.target.checked)} />
          Let this vendor publish without Stripe — BabyBrain will settle their paid bookings manually until they connect Stripe (saved on the vendor, so their own portal lets them publish too)
        </label>

        {done && (
          <div style={{ ...card(), marginTop: 12, borderColor: C.green }}>
            <div style={{ color: C.green, fontWeight: 800 }}>
              {done.provider.business_name} added — {done.activities} class{done.activities === 1 ? '' : 'es'},{' '}
              {done.locations} venue{done.locations === 1 ? '' : 's'}
              {done.provider.region ? `, ${done.provider.region}` : ''}.
            </div>
            <div style={{ color: C.muted, fontSize: 13, marginTop: 6 }}>
              {done.geocoded} address{done.geocoded === 1 ? '' : 'es'} placed on the map. Find it at{' '}
              <a href={`/explore?q=${encodeURIComponent(done.provider.business_name)}`}
                target="_blank" rel="noreferrer" style={{ color: C.blue }}>
                Explore &rarr; {done.provider.business_name}
              </a>
            </div>
            {done.warnings.map((w, i) => (
              <div key={i} style={{ color: C.pink, fontSize: 13, marginTop: 6 }}>⚠ {w}</div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
          <button type="submit" disabled={busy || !name.trim()}
            style={{ ...primaryBtn(), opacity: busy || !name.trim() ? 0.55 : 1 }}>
            {busy ? 'Adding…' : 'Add vendor'}
          </button>
          <button type="button" onClick={reset} style={tabBtn(false)}>Clear</button>
          {busy && <span style={{ color: C.muted, fontSize: 13 }}>Looking up addresses…</span>}
        </div>
      </form>

      {/* ---- the directory: search, then click to edit ---- */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '26px 0 10px', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 800 }}>
          All vendors {meta ? <span style={{ color: C.muted, fontWeight: 600 }}>({filteredVendors.length} of {meta.recent.length})</span> : null}
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, area or type…" style={{ ...input(), maxWidth: 320 }} />
      </div>
      {!meta ? <Skeleton /> : (
        <div style={{ ...card(), padding: 0, overflow: 'hidden' }}>
          {filteredVendors.length === 0 && (
            <div style={{ padding: 16, color: C.muted, fontSize: 14 }}>No vendor matches that.</div>
          )}
          {filteredVendors.slice(0, 60).map((p, i) => (
            <button key={p.id} type="button" onClick={() => setEditingId(p.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', width: '100%',
                textAlign: 'left', background: 'transparent', color: C.text, cursor: 'pointer',
                border: 'none', borderTop: i ? `1px solid ${C.border}` : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.business_name}
                </div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
                  {VENDOR_CATEGORY_LABELS[p.vendor_category] ?? p.vendor_category}
                  {p.region ? ` · ${p.region}` : ' · no area'}
                  {` · ${new Date(p.created_at).toLocaleDateString('en-SG')}`}
                </div>
              </div>
              <Badge tone={p.is_claimed ? 'green' : 'grey'}>
                {p.is_claimed ? 'Claimed' : p.is_auto_listed ? 'Auto-listed' : 'Added by hand'}
              </Badge>
              <span style={{ color: C.blue, fontWeight: 800, fontSize: 13 }}>Edit</span>
            </button>
          ))}
          {filteredVendors.length > 60 && (
            <div style={{ padding: '10px 14px', color: C.muted, fontSize: 12, borderTop: `1px solid ${C.border}` }}>
              Showing the first 60 — search to narrow it down.
            </div>
          )}
        </div>
      )}

      {editingId && (
        <EditVendorModal
          id={editingId}
          categories={meta?.categories ?? []}
          vendorCategories={meta?.vendorCategories ?? Object.keys(VENDOR_CATEGORY_LABELS)}
          onClose={() => setEditingId(null)}
          onSaved={async () => { setEditingId(null); await load(); }}
        />
      )}
    </div>
  );
}

/** Full editor for one vendor: the business, its venues and its classes.
 *  Saves patch-style, so an untouched section is left exactly as it was. */
function EditVendorModal({
  id, categories, vendorCategories, onClose, onSaved,
}: {
  id: string;
  categories: AdminCategory[];
  vendorCategories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<ProviderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string[] | null>(null);
  // ids marked for removal — applied on save, so a misclick is undoable
  const [dropLoc, setDropLoc] = useState<string[]>([]);
  const [dropAct, setDropAct] = useState<string[]>([]);
  // Existing sessions removed in the UI. New (unsaved) ones just vanish from
  // the array, but a saved one has to be sent back with _delete.
  const [dropSess, setDropSess] = useState<{ actId: string; sessId: string }[]>([]);
  const [newLocs, setNewLocs] = useState<DraftLocation[]>([]);
  useEffect(() => {
    adminFetch<ProviderDetail>(`/api/admin/providers/${id}`)
      .then((p) =>
        setD({
          ...p,
          activities: p.activities.map((a) => ({
            ...a,
            sessions: a.sessions.map((s) => ({
              ...s,
              // Fixed at load time from the session's real, pristine
              // starts_at/ends_at. The form only lets the admin edit
              // starts_at (there's no end-time/duration field), so this must
              // survive that edit unchanged rather than being rederived from
              // it later — see the save-payload builder below.
              duration_mins: Math.max(5, Math.round(
                (new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000
              )),
            })),
          })),
        })
      )
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [id]);

  const set = <K extends keyof ProviderDetail>(k: K, v: ProviderDetail[K]) =>
    setD((p) => (p ? { ...p, [k]: v } : p));

  async function save() {
    if (!d) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await adminFetch<SaveResult>(`/api/admin/providers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          provider: {
            business_name: d.business_name,
            slug: d.slug ?? undefined,
            description: d.description,
            vendor_category: d.vendor_category,
            contact_email: d.contact_email,
            contact_phone: d.contact_phone,
            whatsapp: d.whatsapp,
            website: d.website,
            address: d.address,
            postal_code: d.postal_code,
            status: d.status,
            logo_url: d.logo_url,
            cover_image_url: d.cover_image_url,
            uen: d.uen,
            social: d.social ?? {},
            // Saved on the vendor (migration 00200) so their own portal lets
            // them publish too, not just this save.
            allow_manual_payouts: d.allow_manual_payouts,
          },
          locations: [
            ...d.locations.map((l) => ({
              id: l.id, name: l.name, address: l.address, postal_code: l.postal_code,
              is_primary: l.is_primary, _delete: dropLoc.includes(l.id),
            })),
            ...newLocs.filter((l) => l.name.trim() || l.address.trim())
              .map((l) => ({ name: l.name, address: l.address, postal_code: l.postal_code })),
          ],
          activities: d.activities.map((a) => ({
            id: a.id, title: a.title, category_slug: a.category_slug ?? undefined,
            description: a.description, age_min_months: a.age_min_months,
            age_max_months: a.age_max_months, price: a.price, is_published: a.is_published,
            image_urls: a.image_urls.map((u) => u.trim()).filter(Boolean),
            external_booking_url: a.external_booking_url,
            requires_medical_disclosure: a.requires_medical_disclosure,
            bookings_paused: a.bookings_paused,
            location_id: a.is_custom_location ? null : a.location_id,
            is_custom_location: a.is_custom_location,
            custom_location_label: a.is_custom_location ? a.custom_location_label : null,
            sessions: [
              ...a.sessions
                .filter((s) => s.starts_at.trim())
                .map((s) => ({
                  ...(s.id ? { id: s.id } : {}),
                  starts_at: s.starts_at,
                  // The form only ever edits starts_at (no end-time/duration
                  // field exists), so this has to be the value fixed at load
                  // time from the session's real, pristine starts_at/ends_at
                  // — recomputing from CURRENT starts_at against the still-
                  // pristine ends_at (the old code here) silently corrupted
                  // the length of any rescheduled session: moving a 60-min
                  // class's start later shrank it toward the clamp floor,
                  // moving it earlier ballooned it.
                  duration_mins: s.duration_mins,
                  capacity: s.capacity,
                  teacher_name: s.teacher_name,
                  studio: s.studio,
                })),
              // only the ones that belonged to this class
              ...dropSess.filter((x) => x.actId === a.id).map((x) => ({ id: x.sessId, _delete: true })),
            ],
            _delete: dropAct.includes(a.id),
          })),
        }),
      });
      setNote([
        `Saved — ${r.locationsChanged} venue${r.locationsChanged === 1 ? '' : 's'}, ${r.activitiesChanged} class${r.activitiesChanged === 1 ? '' : 'es'}, ${r.sessionsChanged} session${r.sessionsChanged === 1 ? '' : 's'}${r.regeocoded ? ', map pin moved' : ''}${r.provider.region ? `, ${r.provider.region}` : ''}.`,
        ...r.warnings,
      ]);
      toast('Vendor saved');
      setTimeout(onSaved, 1200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  }

  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 5 };
  const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.55)', overflow: 'auto', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ ...card(), maxWidth: 860, margin: '0 auto', padding: 20 }}>
        {!d ? (
          <p style={{ color: C.muted }}>{err ?? 'Loading…'}</p>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>{d.business_name}</div>
                <div style={{ color: C.muted, fontSize: 13, marginTop: 3 }}>
                  {d.is_claimed
                    ? 'This vendor has claimed their page — they can see and change what you edit here.'
                    : d.is_auto_listed ? 'Auto-listed by the crawler; the weekly refresh may overwrite prices.'
                    : 'Added by hand; the crawler leaves it alone.'}
                </div>
              </div>
              <button type="button" onClick={onClose} style={tabBtn(false)}>Close</button>
            </div>

            {/* business */}
            <div style={{ fontWeight: 800, margin: '4px 0 10px' }}>Business</div>
            <div style={grid2}>
              <div>
                <label style={lbl}>Business name</label>
                <input value={d.business_name} style={input()} onChange={(e) => set('business_name', e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Page address (slug)</label>
                <input value={d.slug ?? ''} style={input()} onChange={(e) => set('slug', e.target.value)} />
              </div>
            </div>
            <div style={grid2}>
              <div>
                <label style={lbl}>Business type</label>
                <select value={d.vendor_category ?? 'other'} style={input()}
                  onChange={(e) => set('vendor_category', e.target.value)}>
                  {vendorCategories.map((v) => <option key={v} value={v}>{VENDOR_CATEGORY_LABELS[v] ?? v}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Listing status</label>
                <select value={d.status} style={input()} onChange={(e) => set('status', e.target.value)}>
                  {['active', 'draft', 'pending', 'suspended'].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Description</label>
              <textarea value={d.description ?? ''} rows={3}
                style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
                onChange={(e) => set('description', e.target.value)} />
            </div>
            <div style={grid2}>
              <div>
                <label style={lbl}>Address</label>
                <input value={d.address ?? ''} style={input()} onChange={(e) => set('address', e.target.value)} />
              </div>
              <div>
                <label style={lbl}>
                  Postal code <span style={{ color: C.blue }}>· {d.region ? `currently ${d.region}` : 'no area yet'}</span>
                </label>
                <input value={d.postal_code ?? ''} style={input()} onChange={(e) => set('postal_code', e.target.value)} />
              </div>
            </div>
            <div style={grid2}>
              <div>
                <label style={lbl}>Website</label>
                <input value={d.website ?? ''} style={input()} onChange={(e) => set('website', e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Contact email</label>
                <input value={d.contact_email ?? ''} style={input()} onChange={(e) => set('contact_email', e.target.value)} />
              </div>
            </div>
            <div style={grid2}>
              <div>
                <label style={lbl}>Phone</label>
                <input value={d.contact_phone ?? ''} style={input()} onChange={(e) => set('contact_phone', e.target.value)} />
              </div>
              <div>
                <label style={lbl}>WhatsApp</label>
                <input value={d.whatsapp ?? ''} style={input()} onChange={(e) => set('whatsapp', e.target.value)} />
              </div>
            </div>

            <div style={grid2}>
              <ImageField label="Logo" value={d.logo_url ?? ''} folder={d.slug ?? d.id}
                onChange={(u) => set('logo_url', u)} />
              <ImageField label="Cover image" value={d.cover_image_url ?? ''} folder={d.slug ?? d.id}
                onChange={(u) => set('cover_image_url', u)} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={lbl}>Instagram</label>
                <input value={d.social?.instagram ?? ''} style={input()}
                  onChange={(e) => set('social', { ...(d.social ?? {}), instagram: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>Facebook</label>
                <input value={d.social?.facebook ?? ''} style={input()}
                  onChange={(e) => set('social', { ...(d.social ?? {}), facebook: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>TikTok</label>
                <input value={d.social?.tiktok ?? ''} style={input()}
                  onChange={(e) => set('social', { ...(d.social ?? {}), tiktok: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>UEN</label>
                <input value={d.uen ?? ''} style={input()} onChange={(e) => set('uen', e.target.value)} />
              </div>
            </div>

            {/* venues */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 10px' }}>
              <div style={{ fontWeight: 800 }}>Venues <span style={{ color: C.muted, fontWeight: 600, fontSize: 13 }}>({d.locations.length})</span></div>
              <button type="button" style={tabBtn(false)}
                onClick={() => setNewLocs((p) => [...p, { name: '', address: '', postal_code: '' }])}>+ Add venue</button>
            </div>
            {d.locations.map((l) => {
              const gone = dropLoc.includes(l.id);
              return (
                <div key={l.id} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10, opacity: gone ? 0.45 : 1 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 130px 80px', gap: 10, alignItems: 'end' }}>
                    <div>
                      <label style={lbl}>Name{l.is_primary ? ' · primary' : ''}</label>
                      <input value={l.name} style={input()} disabled={gone}
                        onChange={(e) => set('locations', d.locations.map((x) => x.id === l.id ? { ...x, name: e.target.value } : x))} />
                    </div>
                    <div>
                      <label style={lbl}>Address</label>
                      <input value={l.address ?? ''} style={input()} disabled={gone}
                        onChange={(e) => set('locations', d.locations.map((x) => x.id === l.id ? { ...x, address: e.target.value } : x))} />
                    </div>
                    <div>
                      <label style={lbl}>Postal {l.latitude ? '· pinned' : '· NO PIN'}</label>
                      <input value={l.postal_code ?? ''} style={input()} disabled={gone}
                        onChange={(e) => set('locations', d.locations.map((x) => x.id === l.id ? { ...x, postal_code: e.target.value } : x))} />
                    </div>
                    <button type="button" style={{ ...tabBtn(false), color: gone ? C.blue : C.pink, height: 42 }}
                      onClick={() => setDropLoc((p) => gone ? p.filter((x) => x !== l.id) : [...p, l.id])}>
                      {gone ? 'Undo' : 'Remove'}
                    </button>
                  </div>
                </div>
              );
            })}
            {newLocs.map((l, i) => (
              <div key={`new-${i}`} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10, border: `1px dashed ${C.blue}` }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 130px 80px', gap: 10, alignItems: 'end' }}>
                  <div>
                    <label style={lbl}>New venue name</label>
                    <input value={l.name} style={input()}
                      onChange={(e) => setNewLocs((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                  </div>
                  <div>
                    <label style={lbl}>Address</label>
                    <input value={l.address} style={input()}
                      onChange={(e) => setNewLocs((p) => p.map((x, j) => j === i ? { ...x, address: e.target.value } : x))} />
                  </div>
                  <div>
                    <label style={lbl}>Postal code</label>
                    <input value={l.postal_code} style={input()}
                      onChange={(e) => setNewLocs((p) => p.map((x, j) => j === i ? { ...x, postal_code: e.target.value } : x))} />
                  </div>
                  <button type="button" style={{ ...tabBtn(false), color: C.pink, height: 42 }}
                    onClick={() => setNewLocs((p) => p.filter((_, j) => j !== i))}>Remove</button>
                </div>
              </div>
            ))}

            {/* classes */}
            <div style={{ fontWeight: 800, margin: '18px 0 10px' }}>
              Classes <span style={{ color: C.muted, fontWeight: 600, fontSize: 13 }}>
                ({d.activities.filter((a) => a.is_published).length} live of {d.activities.length})
              </span>
            </div>
            {d.activities.length === 0 && (
              <div style={{ color: C.muted, fontSize: 13, marginBottom: 10 }}>
                No classes — this vendor won&rsquo;t appear in search results.
              </div>
            )}
            {d.activities.map((a) => {
              const gone = dropAct.includes(a.id);
              return (
                <div key={a.id} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10, opacity: gone ? 0.45 : 1 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 190px 80px', gap: 10, alignItems: 'end' }}>
                    <div>
                      <label style={lbl}>Class name</label>
                      <input value={a.title} style={input()} disabled={gone}
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, title: e.target.value } : x))} />
                    </div>
                    <div>
                      <label style={lbl}>Category</label>
                      <select value={a.category_slug ?? ''} style={input()} disabled={gone}
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, category_slug: e.target.value } : x))}>
                        {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                      </select>
                    </div>
                    <button type="button" style={{ ...tabBtn(false), color: gone ? C.blue : C.pink, height: 42 }}
                      onClick={() => setDropAct((p) => gone ? p.filter((x) => x !== a.id) : [...p, a.id])}>
                      {gone ? 'Undo' : 'Delete'}
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 150px', gap: 10, marginTop: 10 }}>
                    <div>
                      <label style={lbl}>Age from (months)</label>
                      <input value={String(a.age_min_months)} inputMode="numeric" style={input()} disabled={gone}
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, age_min_months: Number(e.target.value.replace(/\D/g, '') || 0) } : x))} />
                    </div>
                    <div>
                      <label style={lbl}>Age to (months)</label>
                      <input value={String(a.age_max_months)} inputMode="numeric" style={input()} disabled={gone}
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, age_max_months: Number(e.target.value.replace(/\D/g, '') || 0) } : x))} />
                    </div>
                    <div>
                      <label style={lbl}>Price (SGD)</label>
                      <input value={a.price == null ? '' : String(a.price)} inputMode="decimal" style={input()} disabled={gone}
                        placeholder="on enquiry"
                        onChange={(e) => { const v = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
                          set('activities', d.activities.map((x) => x.id === a.id ? { ...x, price: v === '' ? null : Number(v) } : x)); }} />
                    </div>
                    <div>
                      <label style={lbl}>Visible to parents</label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42, fontSize: 14 }}>
                        <input type="checkbox" checked={a.is_published} disabled={gone}
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, is_published: e.target.checked } : x))} />
                        {a.is_published ? 'Published' : 'Hidden'}
                      </label>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                    <ImageListField
                      value={a.image_urls.join('\n')}
                      folder={`${d.slug ?? d.id}-${a.slug}`}
                      onChange={(v) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, image_urls: v.split('\n') } : x))}
                    />
                    <div>
                      <label style={lbl}>Booking link for this class</label>
                      <input value={a.external_booking_url ?? ''} style={input()} disabled={gone}
                        placeholder="blank = books through BabyBrain"
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, external_booking_url: e.target.value } : x))} />
                      <div style={{ display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                          <input type="checkbox" checked={a.requires_medical_disclosure} disabled={gone}
                            onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, requires_medical_disclosure: e.target.checked } : x))} />
                          Medical disclosure
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                          <input type="checkbox" checked={a.bookings_paused} disabled={gone}
                            onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, bookings_paused: e.target.checked } : x))} />
                          Bookings paused
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                          <input type="checkbox" checked={a.is_custom_location} disabled={gone}
                            onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id
                              ? { ...x, is_custom_location: e.target.checked, location_id: e.target.checked ? null : x.location_id }
                              : x))} />
                          Private session at customer&rsquo;s home
                        </label>
                      </div>
                      {/* Exactly one of the two: a fixed venue from this
                          provider's own list, or (Private session ticked)
                          the free-text label shown to parents instead. */}
                      <label style={{ ...lbl, marginTop: 8, display: 'block' }}>Location</label>
                      {a.is_custom_location ? (
                        <input value={a.custom_location_label ?? ''} style={{ ...input(), marginTop: 8 }} disabled={gone}
                          placeholder='Shown to parents instead of "Custom", e.g. "We travel to you"'
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, custom_location_label: e.target.value } : x))} />
                      ) : (
                        <select value={a.location_id ?? ''} style={{ ...input(), marginTop: 8 }} disabled={gone}
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, location_id: e.target.value || null } : x))}>
                          <option value="">No fixed venue</option>
                          {d.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                      )}
                    </div>
                  </div>

                  {/* schedule */}
                  <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: C.muted }}>
                        SESSIONS ({a.sessions.length})
                        {a.sessions.length === 0 && <span style={{ color: C.pink }}> · none — shows &ldquo;Schedule TBC&rdquo; and can&rsquo;t be booked</span>}
                      </span>
                      <button type="button" disabled={gone} style={{ ...tabBtn(false), padding: '5px 10px', fontSize: 12 }}
                        onClick={() => set('activities', d.activities.map((x) => x.id === a.id
                          ? { ...x, sessions: [...x.sessions, { id: '', starts_at: '', ends_at: '', duration_mins: 60, capacity: null, teacher_name: '', studio: '' }] } : x))}>
                        + Session
                      </button>
                    </div>
                    {a.sessions.map((s, si) => (
                      <div key={s.id || `new-${si}`} style={{ display: 'grid', gridTemplateColumns: '1.4fr 80px 1fr 1fr 34px', gap: 8, marginBottom: 8 }}>
                        <input type="datetime-local" value={s.starts_at} style={input()} disabled={gone}
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, starts_at: e.target.value } : y) } : x))} />
                        <input value={s.capacity == null ? '' : String(s.capacity)} inputMode="numeric" style={input()} placeholder="cap" disabled={gone}
                          onChange={(e) => { const v = e.target.value.replace(/\D/g, '');
                            set('activities', d.activities.map((x) => x.id === a.id ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, capacity: v === '' ? null : Number(v) } : y) } : x)); }} />
                        <input value={s.teacher_name ?? ''} style={input()} placeholder="teacher" disabled={gone}
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, teacher_name: e.target.value } : y) } : x))} />
                        <input value={s.studio ?? ''} style={input()} placeholder="room" disabled={gone}
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, studio: e.target.value } : y) } : x))} />
                        <button type="button" style={{ ...tabBtn(false), color: C.pink, padding: 0 }} disabled={gone}
                          onClick={() => {
                            if (s.id) setDropSess((p) => [...p, { actId: a.id, sessId: s.id }]);
                            set('activities', d.activities.map((x) => x.id === a.id ? { ...x, sessions: x.sessions.filter((_, k) => k !== si) } : x));
                          }}>✕</button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {err && <div style={{ ...card(), marginTop: 12, borderColor: C.pink, color: C.pink }}>{err}</div>}
            {note && (
              <div style={{ ...card(), marginTop: 12, borderColor: C.green }}>
                <div style={{ color: C.green, fontWeight: 800 }}>{note[0]}</div>
                {note.slice(1).map((w, i) => <div key={i} style={{ color: C.pink, fontSize: 13, marginTop: 6 }}>⚠ {w}</div>)}
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, fontSize: 13, color: C.muted }}>
              <input type="checkbox" style={{ marginTop: 2 }}
                checked={d.allow_manual_payouts || d.payouts_enabled}
                disabled={d.payouts_enabled}
                onChange={(e) => set('allow_manual_payouts', e.target.checked)} />
              <span>
                Let this vendor publish without Stripe — BabyBrain settles their paid bookings manually until they connect Stripe.
                {' '}
                {d.payouts_enabled
                  ? 'Not needed: their Stripe payouts are already on.'
                  : 'Saved on the vendor: it also lets them publish from their own portal, not just in this save.'}
              </span>
            </label>

            <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
              <button type="button" onClick={save} disabled={busy}
                style={{ ...primaryBtn(), opacity: busy ? 0.55 : 1 }}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" onClick={onClose} style={tabBtn(false)}>Cancel</button>
              {(dropLoc.length > 0 || dropAct.length > 0 || dropSess.length > 0) && (
                <span style={{ color: C.pink, fontSize: 13, fontWeight: 700 }}>
                  {dropLoc.length + dropAct.length + dropSess.length} item
                  {dropLoc.length + dropAct.length + dropSess.length === 1 ? '' : 's'} will be removed on save
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function VendorsView() {
  const [runs, setRuns] = useState<VendorRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch<{ runs: VendorRun[] }>('/api/admin/vendors/runs');
      setRuns(r.runs);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runNow() {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await adminFetch<{ checked: number; wp_sites: number; prices_updated: number; no_wp: number }>(
        '/api/admin/vendors/refresh', { method: 'POST' });
      setNote(`Done — checked ${r.checked}, ${r.prices_updated} price${r.prices_updated === 1 ? '' : 's'} updated, ${r.no_wp} unreachable.`);
      toast('Price refresh finished');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div style={{ ...card(), display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Vendor directory refresh</div>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 4, maxWidth: 640 }}>
            Crawls each vendor&rsquo;s public site (via Apify when a key is set, otherwise the WordPress
            REST API) and fills in a detected price for auto-listed, unclaimed directory vendors. Runs
            automatically every Monday; you can also run a batch now. Each run processes the
            least-recently-synced vendors, so click a few times to work through the whole list. Claimed
            vendors are never touched.
          </div>
        </div>
        <button onClick={runNow} disabled={busy} style={{ ...primaryBtn(), opacity: busy ? 0.6 : 1, whiteSpace: 'nowrap' }}>
          {busy ? 'Running…' : 'Run refresh now'}
        </button>
      </div>

      {note && <div style={{ ...card(), marginTop: 12, borderColor: C.green, color: C.green }}>{note}</div>}
      {err && <div style={{ ...card(), marginTop: 12, borderColor: C.pink, color: C.pink }}>{err}</div>}

      <div style={{ fontWeight: 800, margin: '22px 0 10px' }}>Run history</div>
      {runs === null && <Skeleton rows={4} />}
      {runs?.length === 0 && <p style={{ color: C.muted }}>No runs yet — trigger one above.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(runs ?? []).map((run) => {
          const statusColor = run.status === 'success' ? C.green : run.status === 'error' ? C.pink : C.muted;
          const noWp = Math.max(0, run.checked - run.wp_sites);
          const isOpen = open === run.id;
          return (
            <div key={run.id} style={card()}>
              <button onClick={() => setOpen(isOpen ? null : run.id)}
                style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 12, background: 'none',
                  border: 'none', color: C.text, cursor: 'pointer', textAlign: 'left', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5,
                  color: statusColor, border: `1px solid ${statusColor}`, borderRadius: 6, padding: '2px 7px' }}>{run.status}</span>
                <span style={{ fontSize: 11, color: C.blue }}>{run.trigger === 'manual' ? 'Manual' : 'Weekly cron'}</span>
                <span style={{ fontWeight: 700 }}>{sgTime(run.started_at)}</span>
                <span style={{ color: C.muted, fontSize: 13, marginLeft: 'auto' }}>
                  {run.checked} checked · <span style={{ color: C.green }}>{run.prices_updated} priced</span> · {noWp} unreachable
                </span>
                <span style={{ color: C.muted }}>{isOpen ? '▾' : '▸'}</span>
              </button>

              {isOpen && (
                <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                  <div style={{ color: C.muted, fontSize: 12, marginBottom: 10 }}>
                    {run.triggered_by ? `Triggered by ${run.triggered_by}. ` : ''}
                    Finished {sgTime(run.finished_at)} · {run.wp_sites} site{run.wp_sites === 1 ? '' : 's'} reachable.
                  </div>
                  {run.error && <div style={{ color: C.pink, fontSize: 13, marginBottom: 10 }}>Error: {run.error}</div>}
                  {run.results.length === 0 ? (
                    <p style={{ color: C.muted, fontSize: 13 }}>No vendors in this batch.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {run.results.map((r, i) => {
                        const o = OUTCOME[r.outcome] ?? OUTCOME.no_price;
                        return (
                          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13,
                            padding: '5px 0', borderBottom: `1px solid ${C.border}` }}>
                            <span style={{ fontWeight: 700, minWidth: 160 }}>{r.name}</span>
                            <span style={{ color: o.color, minWidth: 210 }}>
                              {o.label}{r.price_updated ? ` (${r.price_updated})` : ''}
                            </span>
                            <a href={r.website} target="_blank" rel="noreferrer"
                              style={{ color: C.muted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r.website.replace(/^https?:\/\//, '')}
                            </a>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const CATEGORY_ORDER = ['Account', 'Parent', 'Provider'] as const;

type MarketingSummary = { list: string; count: number; headers: string[]; preview: Record<string, string>[] };

/**
 * Klaviyo is managed by hand (decided 29 Sep): the app sends nothing to it.
 * This tab gives the founder the two lists she needs to do it herself — who
 * may be emailed, and who has unsubscribed and must be suppressed.
 */
function MarketingView() {
  const [consented, setConsented] = useState<MarketingSummary | null>(null);
  const [withdrawn, setWithdrawn] = useState<MarketingSummary | null>(null);
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
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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

function FlowsView() {
  const [flows, setFlows] = useState<EmailFlow[] | null>(null);
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


// ---- Commercials: bespoke commission terms per vendor ----
const sgd = (cents: number) =>
  new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(cents / 100);

function CommercialsView() {
  const [rows, setRows] = useState<VendorTerms[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const { vendors } = await adminFetch<{ vendors: VendorTerms[] }>('/api/admin/commercials');
      setRows(vendors);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load commercial terms.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(providerId: string, patch: Partial<VendorTerms>) {
    setSaving(providerId);
    setNote(null);
    setError(null);
    try {
      const r = await adminFetch<{ ok: true; applied: Partial<VendorTerms> }>('/api/admin/commercials', {
        method: 'PATCH',
        body: JSON.stringify({ provider_id: providerId, ...patch }),
      });
      // Optimistic: merge what the backend actually applied (r.applied), not
      // just the patch this call sent — editing commission_rate or
      // commission_flat_cents also silently sets custom_terms=true
      // server-side (locking the vendor out of future plan-driven resets),
      // which r.applied includes and the sent `patch` doesn't. Merging only
      // `patch` left the "· bespoke" badge not showing until the next reload
      // even though the backend had already locked the terms.
      setRows((prev) => prev?.map((row) => (row.provider_id === providerId ? { ...row, ...r.applied } : row)) ?? prev);
      setNote('Saved. Applies to future sales — past earnings keep their original terms.');
      toast('Commercial terms saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
      void load();
    } finally {
      setSaving(null);
    }
  }

  const visible = (rows ?? []).filter((r) =>
    r.business_name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={card()}>
        <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 6 }}>Commercial terms</div>
        <p style={{ color: C.muted, fontSize: 13, margin: 0, lineHeight: 1.6 }}>
          The deal per vendor. Rates are read at checkout and stamped onto each sale, so changes apply to
          future bookings only. <strong style={{ color: C.text }}>Stripe fee</strong> decides who absorbs
          Stripe&apos;s processing cost — charges stay destination charges either way, so switching it to the
          vendor moves the cost but <em>not</em> chargeback liability. Editing a rate marks the vendor
          <strong style={{ color: C.text }}> bespoke</strong>, after which plan changes no longer reset it.
        </p>
      </div>

      {error && <div style={{ ...card(), borderColor: C.pink, color: C.pink }}>{error}</div>}
      {note && <div style={{ ...card(), borderColor: C.green, color: C.green }}>{note}</div>}

      <input
        style={input()}
        placeholder="Filter by business name…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {!rows ? (
        <Skeleton />
      ) : visible.length === 0 ? (
        <p style={{ color: C.muted }}>No vendors match.</p>
      ) : (
        <div style={{ ...card(), padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: C.muted, textAlign: 'left' }}>
                <th style={th()}>Business</th>
                <th style={th()}>Plan</th>
                <th style={th()}>Commission %</th>
                <th style={th()}>Recurring fee</th>
                <th style={th()}>Stripe fee</th>
                <th style={th()}>Packs</th>
                <th style={th()}>Test account</th>
                <th style={{ ...th(), textAlign: 'right' }}>Sold</th>
                <th style={{ ...th(), textAlign: 'right' }}>We kept</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.provider_id} style={{ borderTop: `1px solid ${C.border}`,
                  opacity: saving === r.provider_id ? 0.5 : 1 }}>
                  <td style={td()}>
                    <div style={{ fontWeight: 700 }}>
                      {r.business_name}
                      {r.is_test && <span style={{ color: C.muted, fontWeight: 600 }}> · test</span>}
                    </div>
                    <div style={{ color: C.muted, fontSize: 11 }}>
                      {r.payouts_enabled ? 'Payouts on' : r.connected ? 'Connect pending' : 'Not connected'}
                      {r.custom_terms && <span style={{ color: C.pink }}> · bespoke</span>}
                    </div>
                  </td>
                  {/* r.plan is the raw DB key ('growth'/'pro'/'free'/'premium'), which predates a
                      vendor-facing rename and no longer matches what vendors/customers actually
                      see: 'growth' shows as "Pro" and 'pro' shows as "Premium" everywhere else
                      (planLabel, lib/plans.ts) — this table was printing the DB key itself
                      capitalized, so an admin reading "Growth" here was looking at the same plan
                      a vendor's own portal calls "Pro". */}
                  <td style={td()}>{planLabel(r.plan)}</td>
                  <td style={td()}>
                    <input
                      style={{ ...input(), width: 78, padding: '6px 8px' }}
                      type="text" inputMode="decimal" autoComplete="off"
                      // Rounding at the same 0.1-point precision `onBlur`
                      // below actually saves at (rather than a bare `* 100`)
                      // avoids reprinting float noise for any rate that
                      // isn't a "nice" binary fraction — 0.07 * 100 is
                      // 7.000000000000001 in JS, not 7.
                      defaultValue={(Math.round(r.commission_rate * 1000) / 10).toString()}
                      onBlur={(e) => {
                        const pct = Number(e.target.value);
                        const rate = Math.round(pct * 10) / 1000;
                        // A text box no longer enforces the 0-50 range, so do it here.
                        if (Number.isFinite(rate) && pct >= 0 && pct <= 50 && rate !== r.commission_rate) {
                          void save(r.provider_id, { commission_rate: rate });
                        }
                      }}
                    />
                  </td>
                  {/* The vendor's subscription price for their plan — not
                      commission_flat_cents (a separate, still-real per-booking
                      surcharge used in the actual commission split math, just
                      with no admin UI of its own right now). Read-only: it
                      follows the Plan column, not something to edit per row. */}
                  <td style={td()}>{sgd(planMonthlyFeeCents(r.plan))} / mo</td>
                  <td style={td()}>
                    <select
                      style={{ ...input(), width: 118, padding: '6px 8px' }}
                      value={r.fee_payer}
                      onChange={(e) => void save(r.provider_id, { fee_payer: e.target.value as 'platform' | 'vendor' })}
                    >
                      <option value="platform">We absorb</option>
                      <option value="vendor">Vendor pays</option>
                    </select>
                  </td>
                  <td style={td()}>
                    <input
                      type="checkbox"
                      checked={r.commission_on_packages}
                      onChange={(e) => void save(r.provider_id, { commission_on_packages: e.target.checked })}
                    />
                  </td>
                  <td style={td()}>
                    <input
                      type="checkbox"
                      title="Demo / QA vendor: left out of admin Metrics and Payments"
                      checked={Boolean(r.is_test)}
                      onChange={(e) => void save(r.provider_id, { is_test: e.target.checked })}
                    />
                  </td>
                  <td style={{ ...td(), textAlign: 'right' }}>
                    {sgd(r.lifetime_gross_cents)}
                    <div style={{ color: C.muted, fontSize: 11 }}>{r.sales_count} sales</div>
                  </td>
                  <td style={{ ...td(), textAlign: 'right', color: C.green, fontWeight: 700 }}>
                    {sgd(r.lifetime_commission_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface PaymentTxn {
  id: string;
  provider_id: string;
  business_name: string;
  source: 'booking' | 'package';
  gross_cents: number;
  commission_cents: number;
  stripe_fee_cents: number | null;
  net_cents: number;
  fee_payer: 'platform' | 'vendor';
  routed_to_connect: boolean;
  status: string;
  stripe_payment_intent: string | null;
  currency: string;
  created_at: string;
}
interface PlatformPayout {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  arrival_date: string;
  created: string;
  method: string;
}
interface PaymentsData {
  transactions: PaymentTxn[];
  totals: { gross: number; commission: number; stripeFee: number; net: number; platformOwed: number; count: number };
  platformPayouts: PlatformPayout[] | null;
  platformPayoutsError: string | null;
  includeTest?: boolean;
  excludedSales?: number;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  in_transit: 'In transit',
  paid_out: 'Paid out',
  platform_owed: 'We owe vendor',
  refunded: 'Refunded',
};

function PaymentsView() {
  const [data, setData] = useState<PaymentsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeTest, setIncludeTest] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await adminFetch<PaymentsData>(`/api/admin/payments?limit=100${includeTest ? '&include_test=1' : ''}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load payments.');
    }
  }, [includeTest]);
  useEffect(() => { void load(); }, [load]);

  const sgdDate = (iso: string) =>
    new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={card()}>
        <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 6 }}>Payments</div>
        <p style={{ color: C.muted, fontSize: 13, margin: 0, lineHeight: 1.6 }}>
          Every sale&apos;s split, and separately what Stripe has actually paid into BabyBrain&apos;s bank
          account. Those are different things — a sale can be collected today and not reach the bank for
          weeks, on Stripe&apos;s own monthly payout schedule.
        </p>
      </div>

      <TestDataBar
        includeTest={includeTest}
        setIncludeTest={setIncludeTest}
        excluded={data?.excludedSales ? `${data.excludedSales} sale${data.excludedSales === 1 ? '' : 's'}` : ''}
      />

      {error && <div style={{ ...card(), borderColor: C.pink, color: C.pink }}>{error}</div>}

      {!data ? (
        <Skeleton />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
            {[
              ['Gross collected', data.totals.gross, C.text],
              ['BabyBrain commission', data.totals.commission, C.green],
              ["Stripe's real fees", data.totals.stripeFee, C.muted],
              ['Vendor net', data.totals.net, C.text],
              ['Still owed to vendors', data.totals.platformOwed, C.pink],
            ].map(([label, cents, color]) => (
              <div key={label as string} style={card()}>
                <div style={{ color: C.muted, fontSize: 12 }}>{label}</div>
                <div style={{ fontWeight: 900, fontSize: 18, color: color as string }}>{sgd(cents as number)}</div>
              </div>
            ))}
          </div>

          <div style={{ ...card(), padding: 0, overflowX: 'auto' }}>
            <div style={{ fontWeight: 800, padding: '12px 16px' }}>Recent transactions ({data.totals.count} all-time)</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: C.muted, textAlign: 'left' }}>
                  <th style={th()}>When</th>
                  <th style={th()}>Provider</th>
                  <th style={th()}>Source</th>
                  <th style={{ ...th(), textAlign: 'right' }}>Gross</th>
                  <th style={{ ...th(), textAlign: 'right' }}>Commission</th>
                  <th style={{ ...th(), textAlign: 'right' }}>Stripe fee</th>
                  <th style={{ ...th(), textAlign: 'right' }}>Vendor net</th>
                  <th style={th()}>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.transactions.map((t) => (
                  <tr key={t.id} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={td()}>{sgdDate(t.created_at)}</td>
                    <td style={td()}>{t.business_name}</td>
                    <td style={{ ...td(), textTransform: 'capitalize' }}>{t.source}</td>
                    <td style={{ ...td(), textAlign: 'right' }}>{sgd(t.gross_cents)}</td>
                    <td style={{ ...td(), textAlign: 'right', color: C.green }}>{sgd(t.commission_cents)}</td>
                    <td style={{ ...td(), textAlign: 'right', color: C.muted }}>
                      {t.stripe_fee_cents == null ? '—' : sgd(t.stripe_fee_cents)}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' }}>{sgd(t.net_cents)}</td>
                    <td style={td()}>
                      <span style={{ color: t.status === 'platform_owed' ? C.pink : t.status === 'paid_out' ? C.green : C.muted }}>
                        {STATUS_LABEL[t.status] ?? t.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {data.transactions.length === 0 && (
                  <tr><td style={td()} colSpan={8}>No payments yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ ...card(), padding: 0, overflowX: 'auto' }}>
            <div style={{ fontWeight: 800, padding: '12px 16px' }}>Sent to BabyBrain&apos;s bank account</div>
            {data.platformPayoutsError ? (
              <div style={{ padding: '0 16px 16px', color: C.pink, fontSize: 13 }}>
                Couldn&apos;t reach Stripe to check this — {data.platformPayoutsError}. This is not the same as
                &ldquo;no payouts yet&rdquo;; try reloading.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ color: C.muted, textAlign: 'left' }}>
                    <th style={th()}>Arrival date</th>
                    <th style={{ ...th(), textAlign: 'right' }}>Amount</th>
                    <th style={th()}>Status</th>
                    <th style={th()}>Method</th>
                  </tr>
                </thead>
                <tbody>
                  {data.platformPayouts?.map((p) => (
                    <tr key={p.id} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={td()}>{sgdDate(p.arrival_date)}</td>
                      <td style={{ ...td(), textAlign: 'right' }}>{sgd(p.amount_cents)}</td>
                      <td style={td()}><Badge tone={p.status === 'active' ? 'green' : p.status === 'pending' ? 'amber' : 'grey'}>{p.status}</Badge></td>
                      <td style={{ ...td(), textTransform: 'capitalize' }}>{p.method}</td>
                    </tr>
                  ))}
                  {(!data.platformPayouts || data.platformPayouts.length === 0) && (
                    <tr><td style={td()} colSpan={4}>No payouts to BabyBrain&apos;s bank account yet.</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Parents: who signed up, what they hold and spend, filterable ----
type ParentRowT = {
  id: string; name: string; email: string; phone: string | null; area: string | null;
  children: { name: string; ageMonths: number }[];
  plan: 'free' | 'plus' | 'plus_past_due' | 'plus_canceled'; bookings: number; upcoming: number; spend: number;
  bookingSpend: number; planPaid: number;
  lastBookingAt: string | null; marketing: 'consented' | 'withdrawn' | 'not_consented'; onboarded: boolean;
  joinedAt: string; isTest: boolean; isVendor: boolean; vendorNames: string[]; regions: string[];
};
type ParentsPage = { rows: ParentRowT[]; total: number; page: number; pages: number; pageSize: number };
type ParentFilters = {
  q: string; plan: string; marketing: string; activity: string; has_children: string;
  joined_from: string; joined_to: string; child_min: string; child_max: string;
  onboarded: string; min_spend: string; area: string; test: string; account: string; region: string;
};
const NO_FILTERS: ParentFilters = {
  q: '', plan: '', marketing: '', activity: '', has_children: '', joined_from: '', joined_to: '',
  child_min: '', child_max: '', onboarded: '', min_spend: '', area: '', test: 'hide', account: '', region: '',
};
const PLAN_BADGE: Record<ParentRowT['plan'], { label: string; tone: Tone }> = {
  free: { label: 'Free', tone: 'grey' }, plus: { label: 'Plus', tone: 'blue' },
  plus_past_due: { label: 'Plus · past due', tone: 'amber' }, plus_canceled: { label: 'Plus · canceled', tone: 'grey' },
};
const MARKETING_BADGE: Record<ParentRowT['marketing'], { label: string; tone: Tone }> = {
  consented: { label: 'Consented', tone: 'green' }, withdrawn: { label: 'Withdrawn', tone: 'pink' }, not_consented: { label: 'Not consented', tone: 'grey' },
};
const REGION_LABELS: Record<string, string> = {
  central: 'Central', east: 'East', 'north-east': 'North-East', north: 'North', west: 'West', sentosa: 'Sentosa',
};
const regionText = (v: string[]) => v.map((x) => REGION_LABELS[x] ?? x).join(', ');
const childAge = (m: number) => (m < 0 ? 'unborn' : m < 24 ? `${m}m` : `${Math.floor(m / 12)}y`);
const sgdDollars = (v: number) => new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(v);
const sgDay = (iso: string) => new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore' });

type ParentDetailT = {
  profile: Record<string, string | number | boolean | null>;
  children: { id: string; name: string; date_of_birth: string; gender: string | null; interests: string[] | null; notes: string | null }[];
  preferences: { preferred_days: string[]; preferred_times: string[]; preferred_regions: string[] | null; budget_min: number | null; budget_max: number | null; interests: string[] } | null;
  subscription: { plan: string; billing_interval: string | null; status: string; current_period_end: string | null; cancel_at_period_end: boolean } | null;
  planPayments: { id: string; paidAt: string; amount: number; currency: string; description: string | null }[];
  bookings: {
    id: string; status: string; payment_status: string; amount: number | null; created_at: string; guest_name: string | null;
    session: { starts_at: string; activity: { title: string } | null } | null;
  }[];
  isTest: boolean; testSource: 'manual' | 'auto' | null; testReason: string | null;
  isVendor: boolean; vendorNames: string[];
};

/** Everything held on one parent, with the test-account checkbox. */
function ParentDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<ParentDetailT | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let stale = false;
    adminFetch<ParentDetailT>(`/api/admin/parents/${id}`)
      .then((r) => { if (!stale) setD(r); })
      .catch((e) => { if (!stale) setErr(e instanceof Error ? e.message : String(e)); });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { stale = true; window.removeEventListener('keydown', onKey); };
  }, [id, onClose]);

  async function toggleTest(next: boolean) {
    if (!d) return;
    setSaving(true);
    try {
      await adminFetch(`/api/admin/parents/${id}`, { method: 'PATCH', body: JSON.stringify({ is_test: next }) });
      setD({ ...d, isTest: next || d.testSource === 'auto', testSource: next ? 'manual' : d.testSource === 'auto' ? 'auto' : null,
        profile: { ...d.profile, is_test: next } });
      toast(next ? 'Marked as a test account' : 'No longer marked as a test account');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setSaving(false); }
  }

  const p = d?.profile;
  const dash = <span style={{ color: C.muted }}>—</span>;
  const when = (v: unknown) => (typeof v === 'string' && v ? new Date(v).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' }) : dash);
  const field = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 10, padding: '6px 0', fontSize: 13 }}>
      <span style={{ color: C.muted, fontWeight: 700 }}>{label}</span><span style={{ wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
  const section = (title: string, body: React.ReactNode) => (
    <div style={{ marginTop: 20 }}>
      <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6, paddingBottom: 6, borderBottom: `1px solid ${C.border}` }}>{title}</div>
      {body}
    </div>
  );
  const list = (v: string[] | null | undefined) => (v && v.length ? v.join(', ') : dash);
  const autoOnly = d?.testSource === 'auto';
  const planTotal = d && d.planPayments.length
    ? new Intl.NumberFormat('en-SG', { style: 'currency', currency: d.planPayments[0].currency.toUpperCase() }).format(d.planPayments.reduce((n, i) => n + i.amount, 0)) : '';

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'flex-end', background: 'rgba(5,9,18,.6)' }}
      onClick={onClose}>
      <aside onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Parent details"
        style={{ width: 'min(560px, 100%)', height: '100%', overflowY: 'auto', background: C.bg, borderLeft: `1px solid ${C.border}`, padding: 22, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 20 }}>{(p?.full_name as string) || (d ? 'No name' : 'Loading…')}</div>
            <div style={{ color: C.muted, fontSize: 13 }}>{p?.email as string}</div>
          </div>
          <button type="button" style={tabBtn(false)} onClick={onClose}>Close</button>
        </div>

        {err && <p style={{ color: C.pink }}>{err}</p>}
        {!d && !err && <div style={{ marginTop: 20 }}><Skeleton rows={6} height={34} /></div>}
        {d && p && (<>
          <div style={{ ...card(), marginTop: 18, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <input id="parent-is-test" type="checkbox" style={{ width: 18, height: 18, marginTop: 2 }}
              checked={d.isTest} disabled={saving || autoOnly} onChange={(e) => toggleTest(e.target.checked)} />
            <label htmlFor="parent-is-test" style={{ cursor: autoOnly ? 'default' : 'pointer' }}>
              <div style={{ fontWeight: 800 }}>Test account {saving && <span style={{ color: C.blue }}>· saving…</span>}</div>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 2, lineHeight: 1.5 }}>
                {autoOnly
                  ? `Treated as a test account automatically (${d.testReason?.toLowerCase() ?? 'by rule'}), so this can’t be unticked here.`
                  : 'Hidden from the Parents list by default and shown with a Test badge when included.'}
              </div>
            </label>
          </div>

          {section('Account', <>
            {field('Name', (p.full_name as string) || dash)}
            {field('Email', p.email as string)}
            {field('Phone', (p.phone as string) || dash)}
            {field('Postal code', (p.postal_code as string) || dash)}
            {field('Joined', when(p.created_at))}
            {field('Last updated', when(p.updated_at))}
            {field('Onboarding', p.onboarding_completed_at ? <>Completed · {when(p.onboarding_completed_at)}</> : 'Not completed')}
            {d.isVendor && field('Vendor', <>{d.vendorNames.join(', ') || 'Yes'} <Badge tone="blue">Vendor</Badge></>)}
            {field('Account ID', <code style={{ fontSize: 12 }}>{id}</code>)}
          </>)}

          {section('Plan', d.subscription ? <>
            {field('Plan', <Badge tone={d.subscription.plan === 'plus' ? 'blue' : 'grey'}>{d.subscription.plan}</Badge>)}
            {field('Status', d.subscription.status)}
            {field('Billing', d.subscription.billing_interval ?? dash)}
            {field('Renews / ends', when(d.subscription.current_period_end))}
            {d.subscription.cancel_at_period_end && field('Cancelling', 'Ends at period end')}
            {field('Paid for plan', d.planPayments.length
              ? <strong>{planTotal}</strong>
              : <span style={{ color: C.muted }}>Nothing paid yet{d.subscription.status === 'trialing' ? ' (in free trial)' : ''}</span>)}
            {d.planPayments.map((i) => (
              <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0 4px 160px', fontSize: 12, color: C.muted }}>
                <span>{sgDay(i.paidAt)}{i.description ? ` · ${i.description}` : ''}</span>
                <span style={{ color: C.text, whiteSpace: 'nowrap' }}>{new Intl.NumberFormat('en-SG', { style: 'currency', currency: i.currency.toUpperCase() }).format(i.amount)}</span>
              </div>
            ))}
          </> : <div style={{ fontSize: 13 }}>Free plan</div>)}

          {section('Marketing & terms', <>
            {field('Marketing consent', p.marketing_consent_at ? <>Consented · {when(p.marketing_consent_at)}</>
              : p.marketing_consent_withdrawn_at ? <>Withdrawn · {when(p.marketing_consent_withdrawn_at)}</> : 'Not consented')}
            {field('Terms accepted', p.terms_accepted_at ? <>{when(p.terms_accepted_at)}{p.terms_version ? ` · v${p.terms_version}` : ''}</> : dash)}
          </>)}

          {section(`Children (${d.children.length})`, d.children.length === 0 ? <div style={{ color: C.muted, fontSize: 13 }}>None added.</div>
            : d.children.map((c) => {
              const months = Math.floor((Date.now() - Date.parse(c.date_of_birth)) / (30.4375 * 864e5));
              return (
                <div key={c.id} style={{ ...card(), marginTop: 8, padding: 12 }}>
                  <div style={{ fontWeight: 800 }}>{c.name} <span style={{ color: C.muted, fontWeight: 600 }}>· {childAge(months)}</span></div>
                  {field('Date of birth', c.date_of_birth)}
                  {field('Gender', c.gender || dash)}
                  {field('Interests', list(c.interests))}
                  {field('Notes', c.notes || dash)}
                </div>
              );
            }))}

          {section('Preferences', d.preferences ? <>
            {field('Preferred days', list(d.preferences.preferred_days))}
            {field('Preferred times', list(d.preferences.preferred_times))}
            {field('Preferred areas', d.preferences.preferred_regions?.length ? regionText(d.preferences.preferred_regions) : dash)}
            {field('Budget', d.preferences.budget_min != null || d.preferences.budget_max != null
              ? `${d.preferences.budget_min ?? 0} – ${d.preferences.budget_max ?? 'any'} SGD` : dash)}
            {field('Interests', list(d.preferences.interests))}
          </> : <div style={{ color: C.muted, fontSize: 13 }}>None set.</div>)}

          {section(`Bookings (${d.bookings.length}${d.bookings.length === 100 ? '+ , latest 100' : ''})`, d.bookings.length === 0
            ? <div style={{ color: C.muted, fontSize: 13 }}>No bookings yet.</div>
            : <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr style={{ color: C.muted, textAlign: 'left' }}>
                  <th style={th()}>Activity</th><th style={th()}>Session</th><th style={th()}>Status</th><th style={{ ...th(), textAlign: 'right' }}>Paid</th><th style={th()}>Booked</th>
                </tr></thead>
                <tbody>
                  {d.bookings.map((b) => (
                    <tr key={b.id} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={td()}>{b.session?.activity?.title ?? dash}{b.guest_name ? <span style={{ color: C.muted }}> · {b.guest_name}</span> : null}</td>
                      <td style={{ ...td(), whiteSpace: 'nowrap' }}>{b.session ? sgDay(b.session.starts_at) : dash}</td>
                      <td style={td()}><Badge tone={b.status === 'confirmed' || b.status === 'completed' ? 'green' : b.status === 'cancelled' ? 'grey' : 'amber'}>{b.status}</Badge></td>
                      <td style={{ ...td(), textAlign: 'right', whiteSpace: 'nowrap' }}>{b.payment_status === 'paid' && b.amount != null ? sgdDollars(Number(b.amount)) : b.payment_status === 'refunded' ? 'Refunded' : dash}</td>
                      <td style={{ ...td(), whiteSpace: 'nowrap' }}>{sgDay(b.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>)}
        </>)}
      </aside>
    </div>
  );
}

function ParentsView() {
  const [f, setF] = useState<ParentFilters>(NO_FILTERS);
  const [q, setQ] = useState('');           // what's typed; copied into f.q after a pause
  const [sort, setSort] = useState('joined');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ParentsPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [more, setMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const cacheRef = useRef(new Map<string, ParentsPage>());
  const freshRef = useRef(false);
  const [extra, setExtra] = useState({ area: false, onboarded: false, last: false });

  useEffect(() => {
    const t = setTimeout(() => { setF((p) => (p.q === q ? p : { ...p, q })); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const qs = useCallback((withPage: boolean) => {
    const sp = new URLSearchParams();
    (Object.keys(f) as (keyof ParentFilters)[]).forEach((k) => { if (f[k]) sp.set(k, f[k]); });
    sp.set('sort', sort); sp.set('dir', dir);
    if (withPage) sp.set('page', String(page));
    return sp;
  }, [f, sort, dir, page]);

  useEffect(() => {
    let stale = false;
    const key = qs(true).toString();
    const hit = cacheRef.current.get(key);
    if (hit) setData(hit);
    setBusy(true); setErr(null);
    const fresh = freshRef.current;
    freshRef.current = false;
    adminFetch<ParentsPage>(`/api/admin/parents?${key}${fresh ? '&fresh=1' : ''}`)
      .then((r) => { cacheRef.current.set(key, r); if (!stale) { setData(r); if (fresh) toast('Parents refreshed'); } })
      .catch((e) => { if (!stale) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!stale) setBusy(false); });
    return () => { stale = true; };
  }, [qs]);

  const set = (k: keyof ParentFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setF((p) => ({ ...p, [k]: e.target.value })); setPage(1);
  };
  const sortBy = (k: string) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSort(k); setDir(k === 'name' ? 'asc' : 'desc'); }
    setPage(1);
  };
  // Skips both caches: the browser's remembered pages and the server's 30-second list.
  const refresh = () => { cacheRef.current.clear(); freshRef.current = true; setF((p) => ({ ...p })); };
  const closeDetail = useCallback(() => setOpenId(null), []);
  const reset = () => { setF(NO_FILTERS); setQ(''); setPage(1); };
  const active = (Object.keys(f) as (keyof ParentFilters)[]).filter((k) => f[k] && f[k] !== NO_FILTERS[k]).length;

  async function exportCsv() {
    setExporting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/parents?${qs(false)}&format=csv`, {
        headers: session ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? res.statusText);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'parents.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Parents exported');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setExporting(false); }
  }

  const lab: React.CSSProperties = { display: 'grid', gap: 4, fontSize: 12, color: C.muted, fontWeight: 700 };
  const sel = (k: keyof ParentFilters, opts: [string, string][]) => (
    <select value={f[k]} onChange={set(k)} style={input()}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
  );
  const sortTh = (k: string, label: string, right?: boolean) => (
    <th style={{ ...th(), textAlign: right ? 'right' : 'left', cursor: 'pointer', userSelect: 'none' }}
      aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => sortBy(k)}>
      {label}{sort === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ ...lab, flex: '1 1 240px' }}>Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email, phone or postal code…" style={input()} />
        </label>
        <label style={{ ...lab, width: 140 }}>Preferred area
          {sel('region', [['', 'Any'], ...Object.entries(REGION_LABELS) as [string, string][]])}
        </label>
        <label style={{ ...lab, width: 140 }}>Account
          {sel('account', [['', 'All'], ['parent', 'Parents only'], ['vendor', 'Vendor staff']])}
        </label>
        <label style={{ ...lab, width: 150 }}>Plan
          {sel('plan', [['', 'All plans'], ['free', 'Free'], ['plus', 'Plus'], ['plus_past_due', 'Plus · past due'], ['plus_canceled', 'Plus · canceled']])}
        </label>
        <label style={{ ...lab, width: 160 }}>Marketing
          {sel('marketing', [['', 'Any'], ['consented', 'Consented'], ['withdrawn', 'Withdrawn'], ['not_consented', 'Not consented']])}
        </label>
        <label style={{ ...lab, width: 190 }}>Booking activity
          {sel('activity', [['', 'Any'], ['never', 'Never booked'], ['once', 'Booked once'], ['repeat', 'Repeat (2+)'],
            ['recent30', 'Booked in last 30 days'], ['dormant60', 'No booking for 60+ days']])}
        </label>
        <button type="button" style={tabBtn(more)} onClick={() => setMore((m) => !m)}>
          More filters{active ? ` · ${active}` : ''} {more ? '▴' : '▾'}
        </button>
      </div>

      {more && (
        <div style={{ ...card(), marginTop: 12, display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
            <label style={lab}>Has children
              {sel('has_children', [['', 'Any'], ['yes', 'Yes'], ['no', 'No'], ])}
            </label>
            <label style={lab}>Child age from (months)
              <input type="number" min={0} value={f.child_min} onChange={set('child_min')} style={input()} placeholder="e.g. 6" />
            </label>
            <label style={lab}>Child age to (months)
              <input type="number" min={0} value={f.child_max} onChange={set('child_max')} style={input()} placeholder="e.g. 18" />
            </label>
            <label style={lab}>Joined from
              <input type="date" value={f.joined_from} onChange={set('joined_from')} style={input()} />
            </label>
            <label style={lab}>Joined to
              <input type="date" value={f.joined_to} onChange={set('joined_to')} style={input()} />
            </label>
            <label style={lab}>Min. spend (SGD)
              <input type="number" min={0} value={f.min_spend} onChange={set('min_spend')} style={input()} placeholder="e.g. 100" />
            </label>
            <label style={lab}>Onboarding
              {sel('onboarded', [['', 'Any'], ['yes', 'Completed'], ['no', 'Not completed']])}
            </label>
            <label style={lab}>Postal code starts with
              <input value={f.area} onChange={set('area')} style={input()} placeholder="e.g. 52" />
            </label>
            <label style={lab}>Test accounts
              {sel('test', [['hide', 'Hide (default)'], ['show', 'Include'], ['only', 'Only test accounts']])}
            </label>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 13, fontWeight: 700 }}>
            <span style={{ color: C.muted }}>Show extra columns:</span>
            {([['area', 'Area'], ['onboarded', 'Onboarded'], ['last', 'Last booking']] as const).map(([k, l]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={extra[k]} onChange={(e) => setExtra((p) => ({ ...p, [k]: e.target.checked }))}
                  style={{ flex: 'none', width: 16, height: 16, margin: 0 }} />{l}
              </label>
            ))}
            <button type="button" style={{ ...tabBtn(false), marginLeft: 'auto' }} onClick={reset}>Clear all filters</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '16px 0 10px', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ color: C.muted, fontSize: 13, fontWeight: 700 }}>
          {data ? `${data.total} parent${data.total === 1 ? '' : 's'}` : ' '}
          {busy && data && <span style={{ color: C.blue, fontWeight: 800, marginLeft: 8 }}>● Updating…</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={{ ...tabBtn(false), display: 'flex', alignItems: 'center', gap: 6 }} onClick={refresh} disabled={busy}
            title="Reload the latest data">
            <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round" style={busy ? { animation: 'bb-spin .8s linear infinite' } : undefined}>
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />
            </svg>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" style={tabBtn(false)} onClick={exportCsv} disabled={exporting || !data?.total}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      {err && <p style={{ color: C.pink }}>{err}</p>}
      {!data && !err && <Skeleton rows={8} height={46} />}
      {data && (
        <div style={{ ...card(), padding: 0, overflowX: 'auto', position: 'relative', opacity: busy ? 0.75 : 1 }}>
          {busy && <div className="bb-skel" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, borderRadius: 0,
            background: `linear-gradient(90deg, transparent 25%, ${C.blue} 50%, transparent 75%)`, backgroundSize: '400% 100%' }} />}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: C.muted, textAlign: 'left' }}>
                {sortTh('name', 'Parent')}
                <th style={th()}>Phone</th>
                {sortTh('children', 'Children')}
                <th style={th()}>Preferred area</th>
                <th style={th()}>Plan</th>
                {sortTh('bookings', 'Bookings')}
                {sortTh('spend', 'Spend', true)}
                <th style={th()}>Marketing</th>
                {extra.area && <th style={th()}>Area</th>}
                {extra.onboarded && <th style={th()}>Onboarded</th>}
                {extra.last && sortTh('last', 'Last booking')}
                {sortTh('joined', 'Joined')}
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && (
                <tr><td colSpan={12} style={{ ...td(), color: C.muted, textAlign: 'center', padding: 28 }}>
                  No parents match these filters.
                </td></tr>
              )}
              {data.rows.map((r) => (
                <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={td()}>
                    <div style={{ fontWeight: 700 }}>
                      <button type="button" onClick={() => setOpenId(r.id)} title="View all details"
                        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 700, cursor: 'pointer',
                          color: C.blue, textAlign: 'left' }}>
                        {r.name || 'No name'}
                      </button>
                      {r.isVendor && <span style={{ marginLeft: 8 }} title={r.vendorNames.join(', ')}><Badge tone="blue">Vendor</Badge></span>}
                      {r.isTest && <span style={{ marginLeft: 8 }}><Badge tone="amber">Test</Badge></span>}
                    </div>
                    <div style={{ color: C.muted, fontSize: 12 }}>{r.email}</div>
                  </td>
                  <td style={{ ...td(), whiteSpace: 'nowrap' }}>{r.phone || <span style={{ color: C.muted }}>—</span>}</td>
                  <td style={td()}>
                    {r.children.length === 0 ? <span style={{ color: C.muted }}>—</span>
                      : <span title={r.children.map((c) => `${c.name} (${childAge(c.ageMonths)})`).join(', ')}>
                          {r.children.length} · {r.children.map((c) => childAge(c.ageMonths)).join(', ')}
                        </span>}
                  </td>
                  <td style={td()}>{r.regions.length ? regionText(r.regions) : <span style={{ color: C.muted }}>—</span>}</td>
                  <td style={td()}><Badge tone={PLAN_BADGE[r.plan].tone}>{PLAN_BADGE[r.plan].label}</Badge></td>
                  <td style={td()}>
                    {r.bookings}{r.upcoming > 0 && <span style={{ color: C.muted }}> · {r.upcoming} upcoming</span>}
                  </td>
                  <td style={{ ...td(), textAlign: 'right', whiteSpace: 'nowrap' }} title={`Bookings ${sgdDollars(r.bookingSpend)} + plan ${sgdDollars(r.planPaid)}`}>{r.spend > 0 ? sgdDollars(r.spend) : <span style={{ color: C.muted }}>—</span>}</td>
                  <td style={td()}><Badge tone={MARKETING_BADGE[r.marketing].tone}>{MARKETING_BADGE[r.marketing].label}</Badge></td>
                  {extra.area && <td style={td()}>{r.area || <span style={{ color: C.muted }}>—</span>}</td>}
                  {extra.onboarded && <td style={td()}>{r.onboarded ? 'Yes' : 'No'}</td>}
                  {extra.last && <td style={{ ...td(), whiteSpace: 'nowrap' }}>{r.lastBookingAt ? sgDay(r.lastBookingAt) : <span style={{ color: C.muted }}>—</span>}</td>}
                  <td style={{ ...td(), whiteSpace: 'nowrap' }}>{sgDay(r.joinedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 14 }}>
          <button type="button" style={tabBtn(false)} disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>← Prev</button>
          <span style={{ color: C.muted, fontSize: 13, fontWeight: 700 }}>Page {data.page} of {data.pages}</span>
          <button type="button" style={tabBtn(false)} disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>Next →</button>
        </div>
      )}

      {openId && <ParentDetail id={openId} onClose={closeDetail} onChanged={() => { cacheRef.current.clear(); setF((p) => ({ ...p })); }} />}
    </div>
  );
}

function th(): React.CSSProperties {
  return { padding: '10px 12px', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' };
}
function td(): React.CSSProperties {
  return { padding: '10px 12px', verticalAlign: 'top' };
}

// ---- style helpers ----
function card(): React.CSSProperties {
  return { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16 };
}
function input(): React.CSSProperties {
  return { width: '100%', padding: '11px 13px', borderRadius: 10, border: `1px solid ${C.border}`,
    background: C.bg, color: C.text, fontSize: 14, outline: 'none' };
}
function primaryBtn(): React.CSSProperties {
  return { padding: '11px 18px', borderRadius: 10, border: 'none', background: C.blue, color: '#fff',
    fontWeight: 800, cursor: 'pointer', fontSize: 14 };
}
function tabBtn(activeTab: boolean): React.CSSProperties {
  return { padding: '8px 14px', borderRadius: 9, border: `1px solid ${activeTab ? C.blue : C.border}`,
    background: activeTab ? C.blue : 'transparent', color: activeTab ? '#fff' : C.text, fontWeight: 700, cursor: 'pointer', fontSize: 14 };
}
