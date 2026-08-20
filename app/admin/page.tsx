'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// ---- types mirrored from the /api/admin/* routes ----
type Metrics = {
  totals: {
    parents: number; providers: number; activeProviders: number; bookings: number;
    plusSubscribers: number; growthSubscribers: number; reviews: number; activities: number;
  };
  bookings: { today: number; last7: number };
  signups: { today: number; last7: number };
  daily: { date: string; bookings: number; signups: number }[];
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
  sessions: DraftSession[];
};
/** Images are entered as URLs, one per line. */
const splitUrls = (s: string) => s.split(/[\n,]/).map((u) => u.trim()).filter(Boolean);
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
};
type EditActivity = {
  id: string; title: string; slug: string; category_slug: string | null; category_name: string | null;
  age_min_months: number; age_max_months: number; price: number | null; is_published: boolean;
  description: string | null; external_booking_url: string | null;
  image_urls: string[]; requires_medical_disclosure: boolean; bookings_paused: boolean;
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
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? res.statusText);
  return res.json() as Promise<T>;
}

export default function AdminPage() {
  const [phase, setPhase] = useState<'loading' | 'login' | 'denied' | 'ok'>('loading');
  const [tab, setTab] = useState<'metrics' | 'messages' | 'contact' | 'addVendor' | 'vendors' | 'flows'>('metrics');

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

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: C.bg, color: C.text,
      overflow: 'auto', fontFamily: 'Nunito, system-ui, sans-serif' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 24px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>BabyBrain · <span style={{ color: C.blue }}>Admin</span></div>
        {phase === 'ok' && (
          <nav style={{ display: 'flex', gap: 8 }}>
            {(['metrics', 'messages', 'contact', 'addVendor', 'vendors', 'flows'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} style={tabBtn(tab === t)}>
                {t === 'metrics' ? 'Metrics' : t === 'messages' ? 'Messages'
                  : t === 'contact' ? 'Contact form' : t === 'addVendor' ? 'Vendors'
                  : t === 'vendors' ? 'Vendor data' : 'Email flows'}
              </button>
            ))}
            <button onClick={async () => { await supabase.auth.signOut(); setPhase('login'); }} style={tabBtn(false)}>
              Sign out
            </button>
          </nav>
        )}
      </header>

      <main style={{ padding: 24, maxWidth: 1180, margin: '0 auto' }}>
        {phase === 'loading' && <p style={{ color: C.muted }}>Loading…</p>}
        {phase === 'login' && <Login onDone={check} />}
        {phase === 'denied' && (
          <div style={{ ...card(), textAlign: 'center', padding: 40 }}>
            <p style={{ fontWeight: 800, fontSize: 18, color: C.text }}>This account isn&apos;t an admin.</p>
            <p style={{ color: C.muted, marginTop: 8 }}>Ask to be added to the ADMIN_EMAILS allowlist.</p>
            <button onClick={async () => { await supabase.auth.signOut(); setPhase('login'); }}
              style={{ ...primaryBtn(), marginTop: 16 }}>Sign out</button>
          </div>
        )}
        {phase === 'ok' && tab === 'metrics' && <MetricsView />}
        {phase === 'ok' && tab === 'messages' && <MessagesView />}
        {phase === 'ok' && tab === 'contact' && <ContactView />}
        {phase === 'ok' && tab === 'addVendor' && <AddVendorView />}
        {phase === 'ok' && tab === 'vendors' && <VendorsView />}
        {phase === 'ok' && tab === 'flows' && <FlowsView />}
      </main>
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

function MetricsView() {
  const [m, setM] = useState<Metrics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    adminFetch<Metrics>('/api/admin/metrics').then(setM).catch((e) => setErr(String(e.message ?? e)));
  }, []);

  if (err) return <p style={{ color: C.pink }}>{err}</p>;
  if (!m) return <p style={{ color: C.muted }}>Loading metrics…</p>;

  const cards: [string, number | string, string][] = [
    ['Parents', m.totals.parents, C.blue],
    ['Vendors (total)', m.totals.providers, C.blue],
    ['Vendors (active)', m.totals.activeProviders, C.green],
    ['Bookings today', m.bookings.today, C.pink],
    ['Bookings (7d)', m.bookings.last7, C.pink],
    ['Bookings (all)', m.totals.bookings, C.muted],
    ['Plus subscribers', m.totals.plusSubscribers, C.green],
    ['Growth vendors', m.totals.growthSubscribers, C.green],
    ['Signups today', m.signups.today, C.blue],
    ['Signups (7d)', m.signups.last7, C.blue],
    ['Activities', m.totals.activities, C.muted],
    ['Reviews', m.totals.reviews, C.muted],
  ];
  const maxDaily = Math.max(1, ...m.daily.map((d) => Math.max(d.bookings, d.signups)));

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
        {cards.map(([label, value, color]) => (
          <div key={label} style={card()}>
            <div style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontSize: 30, fontWeight: 900, color, marginTop: 6 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ ...card(), marginTop: 20, padding: 20 }}>
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

  useEffect(() => {
    adminFetch<{ channels: Channel[] }>('/api/admin/channels').then((r) => setChannels(r.channels)).catch(() => setChannels([]));
  }, []);

  const openChannel = useCallback(async (ch: Channel) => {
    setActive(ch); setMessages([]); setLoadingMsgs(true);
    try {
      const r = await adminFetch<{ messages: Message[] }>(`/api/admin/messages?channelId=${encodeURIComponent(ch.id)}`);
      setMessages(r.messages);
    } finally { setLoadingMsgs(false); }
  }, []);

  async function send() {
    if (!active || !reply.trim()) return;
    setSending(true);
    try {
      const r = await adminFetch<{ message: Message }>('/api/admin/messages', {
        method: 'POST', body: JSON.stringify({ channelId: active.id, text: reply.trim() }),
      });
      setMessages((prev) => [...prev, r.message]);
      setReply('');
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
          {channels === null && <p style={{ color: C.muted, padding: 16 }}>Loading…</p>}
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
              {loadingMsgs && <p style={{ color: C.muted }}>Loading messages…</p>}
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
  if (!rows) return <p style={{ color: C.muted }}>Loading…</p>;

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
      };
      const r = await adminFetch<CreatedVendor>('/api/admin/providers', {
        method: 'POST', body: JSON.stringify(payload),
      });
      setDone(r);
      reset();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
              <label style={label('')}>Logo image URL</label>
              <input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} style={input()} placeholder="https://…/logo.png" />
            </div>
            <div style={field}>
              <label style={label('')}>Cover image URL</label>
              <input value={coverUrl} onChange={(e) => setCoverUrl(e.target.value)} style={input()} placeholder="https://…/cover.jpg" />
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
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, price: e.target.value.replace(/[^\d.]/g, '') } : x))} />
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
                <div>
                  <label style={label('')}>Image URLs <span style={{ color: C.muted }}>· one per line</span></label>
                  <textarea value={a.image_urls} rows={2}
                    style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
                    placeholder="https://…/photo.jpg"
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, image_urls: e.target.value } : x))} />
                </div>
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
      {!meta ? <p style={{ color: C.muted }}>Loading…</p> : (
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
              <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 8px', borderRadius: 999,
                background: p.is_claimed ? C.green : C.panel2, color: p.is_claimed ? '#04220f' : C.muted }}>
                {p.is_claimed ? 'Claimed' : p.is_auto_listed ? 'Auto-listed' : 'Added by hand'}
              </span>
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
      .then(setD)
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
            sessions: [
              ...a.sessions
                .filter((s) => s.starts_at.trim())
                .map((s) => ({
                  ...(s.id ? { id: s.id } : {}),
                  starts_at: s.starts_at,
                  // The form edits a start time; keep whatever length the
                  // session already had rather than silently resetting it.
                  duration_mins: s.id && s.ends_at
                    ? Math.max(5, Math.round((new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000))
                    : 60,
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
      setTimeout(onSaved, 1200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
              <div>
                <label style={lbl}>Logo image URL</label>
                <input value={d.logo_url ?? ''} style={input()} placeholder="https://…/logo.png"
                  onChange={(e) => set('logo_url', e.target.value)} />
                {d.logo_url ? <img src={d.logo_url} alt="" style={{ height: 34, marginTop: 6, borderRadius: 6, background: C.panel2 }} /> : null}
              </div>
              <div>
                <label style={lbl}>Cover image URL</label>
                <input value={d.cover_image_url ?? ''} style={input()} placeholder="https://…/cover.jpg"
                  onChange={(e) => set('cover_image_url', e.target.value)} />
                {d.cover_image_url ? <img src={d.cover_image_url} alt="" style={{ height: 34, marginTop: 6, borderRadius: 6, background: C.panel2 }} /> : null}
              </div>
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
                        onChange={(e) => { const v = e.target.value.replace(/[^\d.]/g, '');
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
                    <div>
                      <label style={lbl}>Image URLs <span style={{ color: C.muted }}>· one per line</span></label>
                      <textarea value={a.image_urls.join('\n')} rows={2} disabled={gone}
                        style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, image_urls: e.target.value.split('\n') } : x))} />
                      {a.image_urls.filter(Boolean).length > 0 && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          {a.image_urls.filter(Boolean).slice(0, 4).map((u, k) => (
                            <img key={k} src={u} alt="" style={{ height: 34, borderRadius: 6, background: C.panel2 }} />
                          ))}
                        </div>
                      )}
                    </div>
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
                      </div>
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
                          ? { ...x, sessions: [...x.sessions, { id: '', starts_at: '', ends_at: '', capacity: null, teacher_name: '', studio: '' }] } : x))}>
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
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
      {runs === null && <p style={{ color: C.muted }}>Loading…</p>}
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
  if (!flows) return <p style={{ color: C.muted }}>Loading…</p>;

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
                <p style={{ color: C.muted, padding: 24 }}>Loading…</p>
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
