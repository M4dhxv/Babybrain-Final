'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Badge, C, Skeleton, adminFetch, card, input, primaryBtn, sgTime, tabBtn, td, th, toast } from '../_lib/core';

type EventSummary = {
  slug: string; title: string; starts_on: string | null; venue: string | null;
  registrations: number; confirmedSeats: number; waitlisted: number; capacity: number;
};
type Slot = { slot_key: string; label: string; capacity: number; confirmedSeats: number; seatsLeft: number; waitlisted: number };
type Registration = {
  id: string; slot_key: string; name: string; email: string | null; phone: string;
  adults: number; children: number; party_size: number;
  status: 'confirmed' | 'waitlisted' | 'cancelled'; source: 'web' | 'admin'; over_capacity: boolean;
  held: boolean; promoted_at: string | null; promoted_auto: boolean; notified_at: string | null; notify_error: string | null;
  adult_names: string[]; child_details: { name: string; age: string }[];
  notes: string | null; created_at: string; status_changed_at: string | null; changed_by: string | null;
};
type EventDetail = { event: { slug: string; title: string; starts_on: string | null; venue: string | null }; slots: Slot[]; registrations: Registration[]; emailsEnabled: boolean };

/** Re-run `fn` every `ms` while this browser tab is visible, and when the tab regains focus. */
function useAutoRefresh(fn: () => void, ms: number, paused = false) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (paused) return;
    const tick = () => { if (document.visibilityState === 'visible') ref.current(); };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [ms, paused]);
}
const clock = (d: Date | null) => (d ? d.toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : '');

const AGES = ['<1', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const dayText = (d: string | null) => (d ? new Date(`${d}T00:00:00+08:00`).toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Singapore' }) : '');
const tone = (s: Registration['status']) => (s === 'confirmed' ? 'green' : s === 'waitlisted' ? 'amber' : 'grey') as 'green' | 'amber' | 'grey';

/**
 * Events: a grid of event boxes (one for now - "BabyBrain Launch"; future events are just more rows in
 * `events`, so they appear here by themselves). Opening one shows who registered, with a drop-down per
 * row for the attendees' names, and the admin controls: add by hand, promote from the waitlist, accept
 * past capacity, move to the waitlist or cancel.
 */
export default function EventsView() {
  const [open, setOpen] = useState<string | null>(null);
  return open ? <EventPage slug={open} onBack={() => setOpen(null)} /> : <EventList onOpen={setOpen} />;
}

function EventList({ onOpen }: { onOpen: (slug: string) => void }) {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadList = useCallback((manual = false) => {
    if (manual) setRefreshing(true);
    adminFetch<{ events: EventSummary[] }>('/api/admin/events')
      .then((r) => { setEvents(r.events); setErr(null); setUpdatedAt(new Date()); })
      .catch((e) => { if (manual || !events) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => setRefreshing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { loadList(); }, [loadList]);
  useAutoRefresh(loadList, 20_000);
  if (err && !events) return <p style={{ color: C.pink }}>{err}</p>;
  if (!events) return <Skeleton rows={2} height={110} />;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ fontWeight: 900, fontSize: 20, color: C.blue }}>Events</h2>
        <span style={{ flex: 1 }} />
        <span style={{ color: C.muted, fontSize: 12 }}>Updated {clock(updatedAt)} · refreshes automatically</span>
        <button type="button" style={tabBtn(false)} disabled={refreshing} onClick={() => loadList(true)}>{refreshing ? 'Refreshing…' : '↻ Refresh'}</button>
      </div>
      {events.length === 0 && <p style={{ color: C.muted }}>No events yet.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
        {events.map((e) => (
          <button key={e.slug} type="button" className="bb-cardbtn" onClick={() => onOpen(e.slug)}
            style={{ ...card(), textAlign: 'left', cursor: 'pointer', color: C.text, font: 'inherit', padding: '18px 20px', display: 'block' }}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>{e.title}</div>
            <div style={{ color: C.muted, fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{dayText(e.starts_on)}{e.venue ? <><br />{e.venue}</> : null}</div>
            <div style={{ display: 'flex', gap: 14, marginTop: 14, fontSize: 13, flexWrap: 'wrap' }}>
              <span><strong>{e.registrations}</strong> registered</span>
              <span><strong>{e.confirmedSeats}</strong> / {e.capacity} seats</span>
              {e.waitlisted > 0 && <span style={{ color: '#f5b942' }}><strong>{e.waitlisted}</strong> waitlisted</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function EventPage({ slug, onBack }: { slug: string; onBack: () => void }) {
  const [data, setData] = useState<EventDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'confirmed' | 'waitlisted' | 'cancelled'>('all');

  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const haveData = useRef(false);
  const load = useCallback((manual?: boolean) => {
    // a click handler passes an event object; only an explicit `true` counts as a manual refresh
    const isManual = manual === true;
    if (isManual) setRefreshing(true);
    adminFetch<EventDetail>(`/api/admin/events/${slug}`)
      .then((d) => { setData(d); haveData.current = true; setErr(null); setUpdatedAt(new Date()); })
      // a failed background refresh keeps what is on screen; the first load and a manual refresh say why
      .catch((e) => { if (isManual || !haveData.current) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => setRefreshing(false));
  }, [slug]);
  useEffect(() => { load(); }, [load]);
  // Live: new registrations, promotions and seat counts appear without a reload. Paused while an
  // action is in flight or the add form is open, so nothing shifts under the admin's hands.
  useAutoRefresh(load, 15_000, busy !== null || adding);

  if (err && !data) return <div><button style={tabBtn(false)} onClick={onBack}>← Events</button><p style={{ color: C.pink, marginTop: 12 }}>{err}</p></div>;
  if (!data) return <Skeleton rows={6} />;

  const slotLabel = (k: string) => data.slots.find((s) => s.slot_key === k)?.label ?? k;
  const rows = data.registrations.filter((r) => filter === 'all' ? r.status !== 'cancelled' : r.status === filter);

  async function setStatus(r: Registration, status: Registration['status'], override = false) {
    setBusy(r.id);
    try {
      const out = await adminFetch<{ promoted?: string[]; notify?: { sent: number; failed: number; error?: string; disabled?: boolean } }>(
        `/api/admin/events/registrations/${r.id}`, { method: 'PATCH', body: JSON.stringify({ status, override }) });
      const head = status === 'confirmed' ? `${r.name} is confirmed` : status === 'waitlisted' ? `${r.name} moved to the waitlist (held)` : `${r.name} cancelled`;
      const auto = out.promoted?.length ? ` · seats freed: ${out.promoted.join(', ')} promoted from the waitlist automatically${out.notify?.disabled ? ' - emails are not set up yet, please tell them yourself' : ''}` : '';
      const mail = out.notify && !out.notify.disabled ? (out.notify.error ? ` · emails not sent: ${out.notify.error}` : out.notify.failed ? ` · ${out.notify.failed} email(s) failed - see "Send emails now"` : out.notify.sent ? ` · ${out.notify.sent} email(s) sent` : '') : '';
      toast(head + auto + mail, !out.notify?.disabled && (out.notify?.error || out.notify?.failed) ? 'error' : 'ok');
      load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (status === 'confirmed' && !override && /Not enough free seats/.test(msg)) {
        if (window.confirm(`${msg.split(' Use ')[0]}\n\nConfirm ${r.name} anyway, over capacity?`)) { setBusy(null); return setStatus(r, status, true); }
      } else toast(msg, 'error');
    }
    setBusy(null);
  }

  const pending = data.registrations.filter((r) => r.status === 'confirmed' && r.promoted_at && !r.notified_at && (r.email || !data.emailsEnabled));
  async function sendPending() {
    setBusy('notify');
    try {
      const out = await adminFetch<{ sent: number; failed: number }>(`/api/admin/events/${slug}/notify`, { method: 'POST', body: '{}' });
      toast(out.failed ? `${out.sent} sent, ${out.failed} failed` : `${out.sent} email${out.sent === 1 ? '' : 's'} sent`, out.failed ? 'error' : 'ok');
      load();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
    setBusy(null);
  }
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const btn = (label: string, onClick: () => void, disabled: boolean, primary = false) => (
    <button type="button" disabled={disabled} onClick={onClick}
      style={{ ...(primary ? { ...primaryBtn(), padding: '6px 10px', fontSize: 12 } : { ...tabBtn(false), padding: '5px 9px', fontSize: 12 }), opacity: disabled ? 0.6 : 1 }}>{label}</button>
  );

  return (
    <div>
      <button type="button" style={tabBtn(false)} onClick={onBack}>← Events</button>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', margin: '14px 0 4px' }}>
        <h2 style={{ fontWeight: 900, fontSize: 20, color: C.blue }}>{data.event.title}</h2>
        <span style={{ color: C.muted, fontSize: 13 }}>{dayText(data.event.starts_on)}{data.event.venue ? ` · ${data.event.venue}` : ''}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, margin: '12px 0 18px' }}>
        {data.slots.map((s) => (
          <div key={s.slot_key} style={card()}>
            <div style={{ fontWeight: 800 }}>{s.label}</div>
            <div style={{ marginTop: 6, fontSize: 24, fontWeight: 900, color: s.seatsLeft === 0 ? C.pink : C.text }}>
              {s.confirmedSeats}<span style={{ color: C.muted, fontSize: 14, fontWeight: 700 }}> / {s.capacity} seats</span>
            </div>
            <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{s.seatsLeft} left · {s.waitlisted} waitlisted</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {(['all', 'confirmed', 'waitlisted', 'cancelled'] as const).map((f) => (
          <button key={f} type="button" style={tabBtn(filter === f)} onClick={() => setFilter(f)}>{f === 'all' ? 'Active' : f[0].toUpperCase() + f.slice(1)}</button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ color: C.muted, fontSize: 12 }}>
          {err ? <span style={{ color: C.pink }}>Couldn’t refresh — {err}</span> : <>Updated {clock(updatedAt)}{adding ? ' · paused while adding' : ' · refreshes automatically'}</>}
        </span>
        <button type="button" style={tabBtn(false)} disabled={refreshing} onClick={() => load(true)}>{refreshing ? 'Refreshing…' : '↻ Refresh'}</button>
        <button type="button" style={primaryBtn()} onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : '+ Add registration'}</button>
      </div>

      {pending.length > 0 && (
        <div style={{ ...card(), borderColor: '#f5b942', marginBottom: 14, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220, fontSize: 13, lineHeight: 1.5 }}>
            <strong style={{ color: '#f5b942' }}>{pending.length} promoted {pending.length === 1 ? 'party hasn’t' : 'parties haven’t'} been told yet{data.emailsEnabled ? ' (email pending)' : ' — email isn’t set up, please contact them yourself'}</strong>
            <span style={{ color: C.muted }}> — {pending.map((p) => p.name).join(', ')}{pending.some((p) => p.notify_error) ? ` · last error: ${pending.find((p) => p.notify_error)!.notify_error}` : ''}</span>
          </div>
          {data.emailsEnabled && <button type="button" style={primaryBtn()} disabled={busy === 'notify'} onClick={sendPending}>{busy === 'notify' ? 'Sending…' : 'Send emails now'}</button>}
        </div>
      )}

      {adding && <AddForm slug={slug} slots={data.slots} onDone={() => { setAdding(false); load(); }} />}

      {rows.length === 0 ? <p style={{ color: C.muted }}>No registrations here yet.</p> : (
        <div style={{ ...card(), padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: C.muted, borderBottom: `1px solid ${C.border}` }}>
                <th style={{ ...th(), width: 36 }} aria-label="Details" />
                <th style={th()}>Name</th><th style={th()}>Email</th><th style={th()}>Phone</th><th style={th()}>Slot</th>
                <th style={{ ...th(), textAlign: 'right' }}>Children</th><th style={{ ...th(), textAlign: 'right' }}>Adults</th>
                <th style={th()}>Status</th><th style={th()}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={td()}>
                      <button type="button" onClick={() => toggle(r.id)} aria-expanded={expanded.has(r.id)} aria-label={`Details for ${r.name}`}
                        style={{ background: 'none', border: 'none', color: C.text, cursor: 'pointer', fontSize: 14, transform: expanded.has(r.id) ? 'rotate(90deg)' : 'none' }}>▶</button>
                    </td>
                    <td style={{ ...td(), fontWeight: 800 }}>{r.name}</td>
                    <td style={{ ...td(), color: r.email ? C.text : C.muted }}>{r.email ?? '—'}</td>
                    <td style={{ ...td(), whiteSpace: 'nowrap' }}>{r.phone}</td>
                    <td style={{ ...td(), whiteSpace: 'nowrap' }}>{slotLabel(r.slot_key)}</td>
                    <td style={{ ...td(), textAlign: 'right' }}>{r.children}</td>
                    <td style={{ ...td(), textAlign: 'right' }}>{r.adults}</td>
                    <td style={td()}>
                      <Badge tone={tone(r.status)}>{r.status}</Badge>
                      {r.over_capacity && <div style={{ color: C.pink, fontSize: 11, fontWeight: 800, marginTop: 4 }}>over capacity</div>}
                      {r.status === 'waitlisted' && r.held && <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }} title="Held by an admin: it is not promoted automatically">held — promote by hand</div>}
                      {r.status === 'confirmed' && r.promoted_at && (
                        <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>
                          {r.promoted_auto ? 'promoted automatically' : 'promoted by hand'}
                          {' · '}
                          {r.notified_at ? <span style={{ color: C.green }}>emailed</span>
                            : !data.emailsEnabled ? <span style={{ color: '#f5b942' }}>not emailed — tell them</span>
                            : r.email ? <span style={{ color: '#f5b942' }} title={r.notify_error ?? undefined}>{r.notify_error ? 'email failed' : 'email pending'}</span>
                            : <span style={{ color: C.pink }}>no email — call them</span>}
                        </div>
                      )}
                      {r.source === 'admin' && <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>added by hand</div>}
                    </td>
                    <td style={{ ...td(), whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        {r.status === 'waitlisted' && btn('Promote', () => setStatus(r, 'confirmed'), busy === r.id, true)}
                        {r.status === 'cancelled' && btn('Re-confirm', () => setStatus(r, 'confirmed'), busy === r.id, true)}
                        {r.status === 'confirmed' && btn('Waitlist', () => setStatus(r, 'waitlisted'), busy === r.id)}
                        {r.status !== 'cancelled' && btn('Cancel', () => { if (window.confirm(`Cancel ${r.name}'s registration?`)) setStatus(r, 'cancelled'); }, busy === r.id)}
                      </span>
                    </td>
                  </tr>
                  {expanded.has(r.id) && (
                    <tr style={{ borderBottom: `1px solid ${C.border}`, background: C.panel2 }}>
                      <td />
                      <td colSpan={8} style={{ ...td(), paddingBottom: 14 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18 }}>
                          <div>
                            <div style={{ color: C.muted, fontSize: 12, fontWeight: 800, marginBottom: 4 }}>Adults ({r.adults})</div>
                            {r.adult_names.map((n, i) => <div key={i}>{n}{i === 0 ? <span style={{ color: C.muted }}> · registrant</span> : null}</div>)}
                          </div>
                          <div>
                            <div style={{ color: C.muted, fontSize: 12, fontWeight: 800, marginBottom: 4 }}>Children ({r.children})</div>
                            {r.child_details.map((c, i) => <div key={i}>{c.name} <span style={{ color: C.muted }}>· age {c.age}</span></div>)}
                          </div>
                          <div>
                            <div style={{ color: C.muted, fontSize: 12, fontWeight: 800, marginBottom: 4 }}>Record</div>
                            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                              Registered {sgTime(r.created_at)}<br />
                              {r.status_changed_at ? <>Status changed {sgTime(r.status_changed_at)}{r.changed_by ? ` by ${r.changed_by}` : ''}<br /></> : null}
                              {r.promoted_at ? <>Promoted from the waitlist {sgTime(r.promoted_at)} ({r.promoted_auto ? 'automatically' : 'by hand'})<br /></> : null}
                              {r.party_size} seat{r.party_size === 1 ? '' : 's'}
                              {r.notes ? <><br />Note: {r.notes}</> : null}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddForm({ slug, slots, onDone }: { slug: string; slots: Slot[]; onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', slot: slots[0]?.slot_key ?? '', secondAdult: '', status: '', notes: '' });
  const [kids, setKids] = useState<{ name: string; age: string }[]>([{ name: '', age: '' }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await adminFetch<{ status: string; overCapacity: boolean }>(`/api/admin/events/${slug}`, {
        method: 'POST',
        body: JSON.stringify({ ...f, status: f.status || undefined, children: kids }),
      });
      toast(`Added — ${r.status}${r.overCapacity ? ' (over capacity)' : ''}`);
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    }
    setBusy(false);
  }

  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 4 };
  return (
    <form onSubmit={submit} style={{ ...card(), marginBottom: 16, display: 'grid', gap: 12 }}>
      <div style={{ fontWeight: 900 }}>Add a registration by hand</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
        <label><span style={lbl}>Name (adult)</span><input style={input()} value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label><span style={lbl}>Email (optional)</span><input style={input()} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></label>
        <label><span style={lbl}>Phone (Singapore)</span><input style={input()} inputMode="numeric" placeholder="9123 4567" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        <label><span style={lbl}>Slot</span>
          <select style={input()} value={f.slot} onChange={(e) => set('slot', e.target.value)}>
            {slots.map((s) => <option key={s.slot_key} value={s.slot_key}>{s.label} ({s.seatsLeft} left)</option>)}
          </select>
        </label>
        <label><span style={lbl}>Second adult (optional)</span><input style={input()} value={f.secondAdult} onChange={(e) => set('secondAdult', e.target.value)} /></label>
        <label><span style={lbl}>Placement</span>
          <select style={input()} value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">Automatic (by capacity)</option>
            <option value="confirmed">Confirmed — even if full</option>
            <option value="waitlisted">Waitlist</option>
          </select>
        </label>
      </div>

      <div>
        <span style={lbl}>Children (1–3)</span>
        <div style={{ display: 'grid', gap: 8 }}>
          {kids.map((k, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 110px auto', gap: 8 }}>
              <input style={input()} placeholder={`Child ${i + 1} name`} value={k.name} onChange={(e) => setKids((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <select style={input()} value={k.age} onChange={(e) => setKids((p) => p.map((x, j) => j === i ? { ...x, age: e.target.value } : x))}>
                <option value="">Age</option>{AGES.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              {kids.length > 1 ? <button type="button" style={tabBtn(false)} onClick={() => setKids((p) => p.filter((_, j) => j !== i))}>Remove</button> : <span />}
            </div>
          ))}
          {kids.length < 3 && <button type="button" style={{ ...tabBtn(false), justifySelf: 'start' }} onClick={() => setKids((p) => [...p, { name: '', age: '' }])}>+ Add child</button>}
        </div>
      </div>

      <label><span style={lbl}>Note (optional)</span><input style={input()} value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="e.g. phoned in on 20 Oct" /></label>
      {err && <p style={{ color: C.pink, fontSize: 13 }}>{err}</p>}
      <div><button type="submit" disabled={busy} style={primaryBtn()}>{busy ? 'Adding…' : 'Add registration'}</button></div>
    </form>
  );
}
