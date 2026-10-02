'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MultiSelect } from '../_lib/multiselect';
import { Badge, C, Skeleton, adminFetch, card, input, sgDay, sgdDollars, supabase, tabBtn, td, th, toast, type Tone, sgClock } from '../_lib/core';

// ---- Parents: who signed up, what they hold and spend, filterable ----
type ParentRowT = {
  id: string; name: string; email: string; phone: string | null; area: string | null;
  children: { name: string; ageMonths: number }[];
  plan: 'free' | 'plus' | 'plus_past_due' | 'plus_canceled'; bookings: number; upcoming: number; spend: number;
  bookingSpend: number; packageSpend: number; planPaid: number;
  lastBookingAt: string | null; marketing: 'consented' | 'withdrawn' | 'not_consented'; onboarded: boolean;
  joinedAt: string; isTest: boolean; kind: AccountKind; isVendor: boolean; vendorNames: string[]; regions: string[];
};
type AccountKind = 'test' | 'vendor_login' | 'vendor_parent' | 'parent';
type ParentsPage = { rows: ParentRowT[]; total: number; page: number; pages: number; pageSize: number };
export type ParentFilters = {
  q: string; plan: string; marketing: string; activity: string; has_children: string;
  joined_from: string; joined_to: string; child_min: string; child_max: string;
  onboarded: string; min_spend: string; area: string; account: string; region: string;
};
const NO_FILTERS: ParentFilters = {
  q: '', plan: '', marketing: '', activity: '', has_children: '', joined_from: '', joined_to: '',
  child_min: '', child_max: '', onboarded: '', min_spend: '', area: '', account: '', region: '',
};
const ADVANCED_FILTERS: (keyof ParentFilters)[] = ['has_children', 'child_min', 'child_max', 'joined_from', 'joined_to', 'min_spend', 'onboarded', 'area', 'region'];
/** The one badge an account carries. Parents carry none. */
const KIND_BADGE: Record<AccountKind, { label: string; tone: Tone } | null> = {
  test: { label: 'Test', tone: 'amber' }, vendor_login: { label: 'Vendor login', tone: 'blue' },
  vendor_parent: { label: 'Vendor + parent', tone: 'blue' }, parent: null,
};
/** Filters carried in the page link, e.g. /admin?tab=parents&plan=plus. */
function filtersFromUrl(): ParentFilters {
  const sp = new URLSearchParams(window.location.search);
  if (sp.get('tab') !== 'parents') return NO_FILTERS;
  const out = { ...NO_FILTERS };
  (Object.keys(NO_FILTERS) as (keyof ParentFilters)[]).forEach((k) => { const v = sp.get(k); if (v) out[k] = v; });
  return out;
}
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
/** Singapore postal districts by the first two digits of the postal code (the "postal sector"). */
const POSTAL_DISTRICTS: [number[], number, string][] = [
  [[1, 2, 3, 4, 5, 6], 1, 'Raffles Place / Marina'], [[7, 8], 2, 'Tanjong Pagar'], [[14, 15, 16], 3, 'Queenstown / Tiong Bahru'],
  [[9, 10], 4, 'Telok Blangah / Harbourfront'], [[11, 12, 13], 5, 'Pasir Panjang / Clementi'], [[17], 6, 'High Street / Beach Road'],
  [[18, 19], 7, 'Middle Road / Golden Mile'], [[20, 21], 8, 'Little India'], [[22, 23], 9, 'Orchard / River Valley'],
  [[24, 25, 26, 27], 10, 'Bukit Timah / Tanglin'], [[28, 29, 30], 11, 'Novena / Thomson'], [[31, 32, 33], 12, 'Balestier / Toa Payoh'],
  [[34, 35, 36, 37], 13, 'Macpherson / Braddell'], [[38, 39, 40, 41], 14, 'Geylang / Paya Lebar'], [[42, 43, 44, 45], 15, 'Katong / Joo Chiat'],
  [[46, 47, 48], 16, 'Bedok / Upper East Coast'], [[49, 50, 81], 17, 'Changi / Loyang'], [[51, 52], 18, 'Tampines / Pasir Ris'],
  [[53, 54, 55, 82], 19, 'Hougang / Punggol'], [[56, 57], 20, 'Bishan / Ang Mo Kio'], [[58, 59], 21, 'Clementi Park / Upper Bukit Timah'],
  [[60, 61, 62, 63, 64], 22, 'Jurong'], [[65, 66, 67, 68], 23, 'Bukit Panjang / Choa Chu Kang'], [[69, 70, 71], 24, 'Lim Chu Kang / Tengah'],
  [[72, 73], 25, 'Woodlands / Kranji'], [[77, 78], 26, 'Upper Thomson / Springleaf'], [[75, 76], 27, 'Yishun / Sembawang'], [[79, 80], 28, 'Seletar'],
];
/** "D9 – Orchard / River Valley" for a 6-digit Singapore postal code, or null if it isn't one. */
function postalDistrict(code: string | null | undefined): string | null {
  const c = (code ?? '').trim();
  if (!/^\d{6}$/.test(c)) return null;
  const sector = Number(c.slice(0, 2));
  const hit = POSTAL_DISTRICTS.find(([sectors]) => sectors.includes(sector));
  return hit ? `D${hit[1]} – ${hit[2]}` : null;
}
const regionText = (v: string[]) => v.map((x) => REGION_LABELS[x] ?? x).join(', ');
const childAge = (m: number) => (m < 0 ? 'unborn' : m < 24 ? `${m}m` : `${Math.floor(m / 12)}y`);

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
  isTest: boolean; override: 'auto' | 'test' | 'real'; testSource: 'manual' | 'auto' | null; testReason: string | null;
  kind: AccountKind; isVendor: boolean; vendorNames: string[];
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

  async function setMode(mode: 'auto' | 'test' | 'real') {
    if (!d || saving) return;
    setSaving(true);
    try {
      await adminFetch(`/api/admin/parents/${id}`, { method: 'PATCH', body: JSON.stringify({ mode }) });
      toast(mode === 'test' ? 'Marked as a test account' : mode === 'real' ? 'Marked as a real parent' : 'Reset to automatic');
      onChanged();
      // The status badge, reason and override all come from the server, so reload them.
      setD(await adminFetch<ParentDetailT>(`/api/admin/parents/${id}`));
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
          <div style={{ ...card(), marginTop: 18 }}>
            <div style={{ fontWeight: 800 }}>
              How this account is counted {saving && <span style={{ color: C.blue }}>· saving…</span>}
            </div>
            <div style={{ color: C.muted, fontSize: 12, marginTop: 2, lineHeight: 1.5 }}>
              Currently: <strong style={{ color: C.text }}>{d.isTest ? 'a test account' : d.kind === 'vendor_login' ? 'a vendor login (not a parent)' : d.kind === 'vendor_parent' ? 'a vendor who also books as a parent' : 'a parent'}</strong>
              {d.override === 'auto' && d.testReason ? ` — ${d.testReason.toLowerCase()}` : ''}.
            </div>
            <div role="radiogroup" aria-label="How this account is counted" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              {([['auto', 'Automatic', 'The rules decide'], ['test', 'Test account', 'Left out of the list, Metrics and revenue by default'], ['real', 'Real parent', 'Counted even if the rules would say test']] as const).map(([m, label, hint]) => (
                <button key={m} type="button" role="radio" aria-checked={d.override === m} disabled={saving} title={hint} onClick={() => d.override !== m && setMode(m)}
                  style={{ ...tabBtn(d.override === m), padding: '6px 12px', fontSize: 13 }}>{label}</button>
              ))}
            </div>
          </div>

          {section('Account', <>
            {field('Name', (p.full_name as string) || dash)}
            {field('Email', p.email as string)}
            {field('Phone', (p.phone as string) || dash)}
            {field('Postal code', p.postal_code
              ? <>{p.postal_code as string}{postalDistrict(p.postal_code as string) && <span style={{ color: C.muted }}> ({postalDistrict(p.postal_code as string)})</span>}</>
              : dash)}
            {field('Joined', when(p.created_at))}
            {field('Last updated', when(p.updated_at))}
            {field('Onboarding', p.onboarding_completed_at ? <>Completed · {when(p.onboarding_completed_at)}</> : 'Not completed')}
            {d.isVendor && field('Vendor', d.vendorNames.join(', ') || 'Yes')}
            {field('Account type', KIND_BADGE[d.kind] ? <Badge tone={KIND_BADGE[d.kind]!.tone}>{KIND_BADGE[d.kind]!.label}</Badge> : 'Parent')}
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
            {field('Preferred regions', d.preferences.preferred_regions?.length ? regionText(d.preferences.preferred_regions) : dash)}
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

export default function ParentsView() {
  const [f, setF] = useState<ParentFilters>(filtersFromUrl);
  const [q, setQ] = useState(() => filtersFromUrl().q);   // what's typed; copied into f.q after a pause
  const [sort, setSort] = useState('joined');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ParentsPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [more, setMore] = useState(() => { const u = filtersFromUrl(); return ADVANCED_FILTERS.some((k) => u[k] && u[k] !== NO_FILTERS[k]); });
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('open'));
  const cacheRef = useRef(new Map<string, ParentsPage>());
  const freshRef = useRef(false);
  const [extra, setExtra] = useState({ area: false, region: false, onboarded: false, last: false });

  useEffect(() => {
    const t = setTimeout(() => { setF((p) => (p.q === q ? p : { ...p, q })); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // Keep the filters in the page link (?tab=parents&plan=plus…) so a refresh, a shared link and the
  // Metrics cards all land on the same view.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('tab') !== 'parents') return;
    (Object.keys(NO_FILTERS) as (keyof ParentFilters)[]).forEach((k) => {
      if (f[k] && f[k] !== NO_FILTERS[k]) url.searchParams.set(k, f[k]); else url.searchParams.delete(k);
    });
    window.history.replaceState(null, '', url);
  }, [f]);

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

  // ---- bulk selection (admins only; the server refuses anyone else) ----
  const closeDetail = useCallback(() => {
    setOpenId(null);
    const url = new URL(window.location.href);
    if (url.searchParams.has('open')) { url.searchParams.delete('open'); window.history.replaceState(null, '', url); }
  }, []);
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
        <label style={{ ...lab, width: 170 }}>Account type
          {sel('account', [['', 'Parents (default)'], ['all', 'Everyone'], ['parent', 'Parents only'], ['vendor_parent', 'Vendor + parent'], ['vendor_login', 'Vendor logins'], ['test', 'Test accounts']])}
        </label>
        <label style={{ ...lab, width: 150 }}>Plan
          {sel('plan', [['', 'All plans'], ['free', 'Free'], ['plus', 'Plus'], ['plus_past_due', 'Plus · past due'], ['plus_canceled', 'Plus · canceled']])}
        </label>
        <label style={{ ...lab, width: 160 }}>Marketing
          {sel('marketing', [['', 'Any'], ['consented', 'Consented'], ['withdrawn', 'Withdrawn'], ['not_consented', 'Not consented']])}
        </label>
        <label style={{ ...lab, width: 190 }}>Booking activity
          {sel('activity', [['', 'Any'], ['booked', 'Has booked'], ['never', 'Never booked'], ['once', 'Booked once'], ['repeat', 'Repeat (2+)'],
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
            <MultiSelect label="Preferred region" placeholder="Any region"
              options={Object.entries(REGION_LABELS).map(([id, label]) => ({ id, label }))}
              selected={f.region.split(',').filter(Boolean)}
              onChange={(ids) => { setF((p) => ({ ...p, region: ids.join(',') })); setPage(1); }} width={170} />
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
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 13, fontWeight: 700 }}>
            <span style={{ color: C.muted }}>Show extra columns:</span>
            {([['area', 'Postal code'], ['region', 'Preferred region'], ['onboarded', 'Onboarded'], ['last', 'Last booking']] as const).map(([k, l]) => (
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
                <th style={th()}>Plan</th>
                {sortTh('bookings', 'Bookings')}
                {sortTh('spend', 'Spend', true)}
                <th style={th()}>Marketing</th>
                {extra.area && <th style={th()}>Postal code</th>}
                {extra.region && <th style={th()}>Preferred region</th>}
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
                      {KIND_BADGE[r.kind] && (
                        <span style={{ marginLeft: 8 }} title={r.vendorNames.join(', ')}>
                          <Badge tone={KIND_BADGE[r.kind]!.tone}>{KIND_BADGE[r.kind]!.label}</Badge>
                        </span>
                      )}
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
                  <td style={td()}><Badge tone={PLAN_BADGE[r.plan].tone}>{PLAN_BADGE[r.plan].label}</Badge></td>
                  <td style={td()}>
                    {r.bookings}{r.upcoming > 0 && <span style={{ color: C.muted }}> · {r.upcoming} upcoming</span>}
                  </td>
                  <td style={{ ...td(), textAlign: 'right', whiteSpace: 'nowrap' }} title={`Bookings ${sgdDollars(r.bookingSpend)} + packages ${sgdDollars(r.packageSpend)} + plan ${sgdDollars(r.planPaid)}`}>{r.spend > 0 ? sgdDollars(r.spend) : <span style={{ color: C.muted }}>—</span>}</td>
                  <td style={td()}><Badge tone={MARKETING_BADGE[r.marketing].tone}>{MARKETING_BADGE[r.marketing].label}</Badge></td>
                  {extra.area && <td style={td()}>{r.area || <span style={{ color: C.muted }}>—</span>}</td>}
                  {extra.region && <td style={td()}>{r.regions.length ? regionText(r.regions) : <span style={{ color: C.muted }}>—</span>}</td>}
                  {extra.onboarded && <td style={td()}>{r.onboarded ? 'Yes' : 'No'}</td>}
                  {extra.last && <td style={{ ...td(), whiteSpace: 'nowrap' }}>{r.lastBookingAt ? sgDay(r.lastBookingAt) : <span style={{ color: C.muted }}>—</span>}</td>}
                  <td style={{ ...td(), whiteSpace: 'nowrap' }}>
                    {sgDay(r.joinedAt)}
                    <div style={{ color: C.muted, fontSize: 12 }}>{sgClock(r.joinedAt)}</div>
                  </td>
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

