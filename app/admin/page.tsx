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
type VendorResult = { name: string; website: string; outcome: 'price_updated' | 'no_price' | 'no_wp'; price_updated: number };
type VendorRun = {
  id: string; trigger: 'cron' | 'manual'; status: 'running' | 'success' | 'error';
  triggered_by: string | null; checked: number; wp_sites: number; prices_updated: number;
  results: VendorResult[]; error: string | null; started_at: string; finished_at: string | null;
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
  const [tab, setTab] = useState<'metrics' | 'messages' | 'vendors'>('metrics');

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
            {(['metrics', 'messages', 'vendors'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} style={tabBtn(tab === t)}>
                {t === 'metrics' ? 'Metrics' : t === 'messages' ? 'Messages' : 'Vendor data'}
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
        {phase === 'ok' && tab === 'vendors' && <VendorsView />}
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

const OUTCOME: Record<VendorResult['outcome'], { label: string; color: string }> = {
  price_updated: { label: 'Price updated', color: C.green },
  no_price: { label: 'Checked · no price', color: C.muted },
  no_wp: { label: 'No WordPress feed / unreachable', color: C.pink },
};

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
      setNote(`Done — checked ${r.checked}, ${r.prices_updated} price${r.prices_updated === 1 ? '' : 's'} updated, ${r.no_wp} with no WordPress feed.`);
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
            Pulls the latest info (currently prices from vendors on WordPress) for auto-listed, unclaimed
            directory vendors. Runs automatically every Monday; you can also run a batch now. Each run
            processes the 25 least-recently-synced vendors, so click a few times to work through the whole list.
            Claimed vendors are never touched.
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
                  {run.checked} checked · <span style={{ color: C.green }}>{run.prices_updated} priced</span> · {noWp} no-WP
                </span>
                <span style={{ color: C.muted }}>{isOpen ? '▾' : '▸'}</span>
              </button>

              {isOpen && (
                <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                  <div style={{ color: C.muted, fontSize: 12, marginBottom: 10 }}>
                    {run.triggered_by ? `Triggered by ${run.triggered_by}. ` : ''}
                    Finished {sgTime(run.finished_at)} · {run.wp_sites} WordPress sites found.
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
