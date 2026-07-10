import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays, Search, UserPlus, MessageSquare, Shield, CalendarCheck,
  Clock, Baby, Info, Check, X, Save, Gift,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';

const bookingsTabs = ['Bookings', 'Waitlist', 'Attendance'];
const PALETTE = ['bg-pink-100 text-pink-600', 'bg-blue-100 text-blue-600', 'bg-yellow-100 text-yellow-600', 'bg-purple-100 text-purple-600', 'bg-green-100 text-green-600'];

const sgDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const ageLabel = (m: number | null) => (m == null ? '' : m < 24 ? `${m} months` : `${Math.round(m / 12)} years`);

type SessionOpt = { id: string; starts_at: string; capacity: number | null; title: string };
type RosterRow = {
  booking_id: string; status: string; payment_status: string; child_name: string;
  child_age_months: number | null; has_medical: boolean; waitlist_position: number | null;
  attendance_status: 'present' | 'absent' | 'late' | null;
};

export default function BookingsPage() {
  const { provider, role, session } = useAuth();
  const canManage = role === 'owner' || role === 'manager';
  const [issuing, setIssuing] = useState(false);
  const [issuedFor, setIssuedFor] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState('Bookings');
  const [sessions, setSessions] = useState<SessionOpt[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState('');
  const [attDraft, setAttDraft] = useState<Record<string, 'present' | 'absent'>>({});
  const [tokenStatus, setTokenStatus] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  // Load this provider's upcoming sessions (RLS-scoped via activities join).
  useEffect(() => {
    if (!provider) return;
    (async () => {
      const { data: acts } = await supabase.from('activities').select('id, title').eq('provider_id', provider.id);
      const map = new Map((acts ?? []).map((a) => [a.id, a.title]));
      const ids = [...map.keys()];
      if (!ids.length) { setSessions([]); setLoading(false); return; }
      const { data: sess } = await supabase
        .from('activity_sessions').select('id, starts_at, capacity, activity_id')
        .in('activity_id', ids).order('starts_at', { ascending: false }).limit(50);
      const opts = (sess ?? []).map((s) => ({ id: s.id, starts_at: s.starts_at, capacity: s.capacity, title: map.get(s.activity_id) ?? 'Activity' }));
      setSessions(opts);
      setSessionId((cur) => cur || opts[0]?.id || '');
      setLoading(false);
    })();
  }, [provider]);

  async function loadRoster(id: string) {
    if (!id) return;
    const { data } = await supabase.rpc('provider_session_roster', { p_session_id: id });
    const rows = (data as RosterRow[]) ?? [];
    setRoster(rows);
    setSelected(0);
    setAttDraft({});
    // Make-up tokens already issued against these bookings (issued/redeemed).
    if (rows.length) {
      const { data: toks } = await supabase
        .from('make_up_tokens')
        .select('origin_booking_id, status')
        .in('origin_booking_id', rows.map((r) => r.booking_id));
      const map: Record<string, string> = {};
      (toks ?? []).forEach((t) => { if (t.origin_booking_id) map[t.origin_booking_id] = t.status; });
      setTokenStatus(map);
    } else {
      setTokenStatus({});
    }
  }
  useEffect(() => { loadRoster(sessionId); /* eslint-disable-next-line */ }, [sessionId]);

  const currentSession = sessions.find((s) => s.id === sessionId);
  const booked = useMemo(() => roster.filter((r) => r.status === 'confirmed' || r.status === 'completed'), [roster]);
  const waitlisted = useMemo(() => roster.filter((r) => r.status === 'waitlisted'), [roster]);
  const visibleBookings = booked.filter((b) => b.child_name.toLowerCase().includes(search.toLowerCase()));
  const presentCount = booked.filter((b) => (attDraft[b.booking_id] ?? b.attendance_status) === 'present').length;
  const absentCount = booked.filter((b) => (attDraft[b.booking_id] ?? b.attendance_status) === 'absent').length;

  async function promote(bookingId: string) {
    await supabase.rpc('promote_waitlist_entry', { p_booking_id: bookingId });
    loadRoster(sessionId);
  }
  async function removeBooking(bookingId: string) {
    await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', bookingId);
    loadRoster(sessionId);
  }
  async function issueToken(bookingId: string) {
    if (!provider) return;
    setIssuing(true);
    const { data: bk } = await supabase.from('bookings').select('user_id, child_id').eq('id', bookingId).maybeSingle();
    if (bk?.user_id) {
      await supabase.from('make_up_tokens').insert({
        provider_id: provider.id,
        user_id: bk.user_id,
        child_id: bk.child_id,
        origin_booking_id: bookingId,
        status: 'issued',
        issued_by: session?.user.id ?? null,
        expires_at: new Date(Date.now() + 60 * 864e5).toISOString(),
      });
      setIssuedFor(bookingId);
      setTokenStatus((m) => ({ ...m, [bookingId]: 'issued' }));
    }
    setIssuing(false);
  }
  async function saveRoster() {
    if (!sessionId) return;
    const rows = booked
      .map((b) => ({ booking_id: b.booking_id, session_id: sessionId, status: (attDraft[b.booking_id] ?? b.attendance_status ?? 'present') as 'present' | 'absent', marked_by: session?.user.id ?? null, marked_at: new Date().toISOString() }))
      .filter((r) => r.status);
    await supabase.from('attendance').upsert(rows, { onConflict: 'booking_id' });
    loadRoster(sessionId);
  }

  const sel = visibleBookings[selected];

  return (
    <div className="relative">
      <div className="flex items-center justify-between px-8 py-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bookings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage bookings for your sessions.</p>
        </div>
      </div>

      <div className="px-8 pb-8">
        {/* Session Selector (real sessions) */}
        <div className="mb-6">
          <div className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-700">
            <Baby className="w-4 h-4 text-[#E91E63]" />
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} className="bg-transparent font-medium focus:outline-none">
              {sessions.length === 0 && <option>No sessions yet</option>}
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.title} • {sgDateTime(s.starts_at)}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-6 border-b border-gray-200 mb-6">
          {bookingsTabs.map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={cn('flex items-center gap-2 text-sm font-medium pb-3 border-b-2 transition-colors',
                activeTab === tab ? 'text-[#E91E63] border-[#E91E63]' : 'text-gray-500 border-transparent hover:text-gray-700')}>
              {tab === 'Bookings' && <CalendarDays className="w-4 h-4" />}
              {tab === 'Waitlist' && <UserPlus className="w-4 h-4" />}
              {tab === 'Attendance' && <CalendarCheck className="w-4 h-4" />}
              {tab}{tab === 'Waitlist' && waitlisted.length > 0 ? ` (${waitlisted.length})` : ''}
            </button>
          ))}
        </div>

        {loading && <div className="text-sm text-gray-400">Loading…</div>}

        <div className="flex gap-6">
          {/* Booking list */}
          <div className="w-80 flex-shrink-0">
            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search bookings..."
                className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-pink-200" />
            </div>
            <div className="space-y-2">
              {visibleBookings.map((b, idx) => (
                <div key={b.booking_id} onClick={() => setSelected(idx)}
                  className={cn('flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-colors',
                    selected === idx ? 'bg-pink-50 border border-pink-200' : 'hover:bg-gray-50 border border-transparent')}>
                  <div className={cn('w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0', PALETTE[idx % PALETTE.length])}>
                    {initials(b.child_name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-gray-900 text-sm">{b.child_name}</span>
                    <div className="text-xs text-gray-500">{ageLabel(b.child_age_months)}</div>
                    {b.has_medical && <span className="inline-block mt-1 px-1.5 py-0.5 text-xs rounded bg-purple-100 text-purple-700">Medical Disclosure</span>}
                  </div>
                  <span className={cn('inline-block px-2 py-0.5 text-xs rounded-full', b.payment_status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600')}>
                    {b.payment_status === 'paid' ? 'Paid' : 'Unpaid'}
                  </span>
                </div>
              ))}
              {!loading && visibleBookings.length === 0 && <div className="text-sm text-gray-400 px-1">No bookings for this session.</div>}
            </div>
            <div className="mt-4 text-sm text-gray-500">{booked.length} bookings</div>
          </div>

          {/* Bookings detail */}
          {activeTab === 'Bookings' && (
            <div className="flex-1 bg-white rounded-xl border border-gray-200 p-5">
              {sel ? (
                <>
                  <div className="flex items-center gap-3 mb-5">
                    <div className="w-12 h-12 rounded-full bg-pink-100 flex items-center justify-center text-lg font-bold text-pink-600">{initials(sel.child_name)}</div>
                    <div>
                      <h3 className="font-semibold text-gray-900">{sel.child_name}</h3>
                      <p className="text-sm text-gray-500">{ageLabel(sel.child_age_months)}</p>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Payment</div>
                      <div className="text-sm text-gray-700 capitalize">{sel.payment_status}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-2">Medical Disclosure</div>
                      <div className={cn('flex items-center gap-2 px-3 py-2 rounded-lg', sel.has_medical ? 'bg-purple-50' : 'bg-gray-50')}>
                        <Shield className={cn('w-4 h-4', sel.has_medical ? 'text-purple-600' : 'text-gray-400')} />
                        <span className={cn('text-sm', sel.has_medical ? 'text-purple-700' : 'text-gray-500')}>
                          {sel.has_medical ? 'On file' : 'None provided'}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Attendance</div>
                      <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-yellow-500" />
                        <span className="text-sm text-gray-700 capitalize">{sel.attendance_status ?? 'Not marked'}</span>
                      </div>
                    </div>
                  </div>
                  <button className="flex items-center gap-2 mt-6 text-sm text-[#E91E63] font-medium hover:underline" title="Live chat ships in Phase 2">
                    <MessageSquare className="w-4 h-4" /> Message parent
                  </button>
                  {canManage && (
                    <button
                      onClick={() => issueToken(sel.booking_id)}
                      disabled={issuing || issuedFor === sel.booking_id || !!tokenStatus[sel.booking_id]}
                      className="flex items-center gap-2 mt-3 text-sm font-medium text-gray-700 hover:text-gray-900 disabled:opacity-60"
                    >
                      <Gift className="w-4 h-4" />
                      {tokenStatus[sel.booking_id] === 'redeemed' ? 'Make-up token redeemed' : tokenStatus[sel.booking_id] || issuedFor === sel.booking_id ? 'Make-up token issued ✓' : issuing ? 'Issuing…' : 'Issue make-up token'}
                    </button>
                  )}
                </>
              ) : (
                <div className="text-sm text-gray-400">Select a booking.</div>
              )}
            </div>
          )}

          {/* Waitlist */}
          {activeTab === 'Waitlist' && (
            <div className="flex-1 bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-4 mb-5 text-sm">
                <span>Capacity <strong className="text-gray-900">{booked.length}/{currentSession?.capacity ?? '∞'}</strong></span>
                <span className="text-gray-300">•</span>
                <span>Waitlist <strong className="text-gray-900">{waitlisted.length}</strong></span>
              </div>
              <div className="space-y-3">
                <h4 className="text-sm font-medium text-gray-700">Waitlist (in order)</h4>
                {waitlisted.map((p, idx) => (
                  <div key={p.booking_id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                    <span className="w-6 h-6 bg-gray-200 rounded-full flex items-center justify-center text-xs font-medium text-gray-700">{p.waitlist_position ?? idx + 1}</span>
                    <div className={cn('w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold', PALETTE[idx % PALETTE.length])}>{initials(p.child_name)}</div>
                    <div className="flex-1">
                      <div className="font-medium text-gray-900 text-sm">{p.child_name}</div>
                      <div className="text-xs text-gray-500">{ageLabel(p.child_age_months)}</div>
                    </div>
                    {canManage && (
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => promote(p.booking_id)} className="rounded-lg text-xs bg-green-500 text-white hover:bg-green-600">Promote + notify</Button>
                        <Button size="sm" variant="outline" onClick={() => removeBooking(p.booking_id)} className="rounded-lg text-xs bg-red-50 text-red-600 hover:bg-red-100 border border-red-200">Remove</Button>
                      </div>
                    )}
                  </div>
                ))}
                {waitlisted.length === 0 && <div className="text-sm text-gray-400">No one on the waitlist.</div>}
              </div>
              <div className="flex items-start gap-2 mt-5 p-3 bg-blue-50 rounded-xl">
                <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-blue-700">Promoting a family confirms their booking and sends a notification.</p>
              </div>
            </div>
          )}

          {/* Attendance */}
          {activeTab === 'Attendance' && (
            <div className="flex-1 bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-4 mb-5">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-green-100 rounded-lg">
                  <Check className="w-4 h-4 text-green-600" /><span className="text-sm font-medium text-green-700">Present {presentCount}</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 bg-red-100 rounded-lg">
                  <X className="w-4 h-4 text-red-600" /><span className="text-sm font-medium text-red-700">Absent {absentCount}</span>
                </div>
                <span className="ml-auto text-sm text-gray-700"><strong>{booked.length}</strong> booked</span>
              </div>
              <div className="border border-gray-200 rounded-xl overflow-hidden mb-5">
                <div className="grid grid-cols-[0.5fr_1.4fr_0.8fr_1fr] px-4 py-2.5 bg-gray-50 text-xs font-medium text-gray-500">
                  <div>Present</div><div>Child</div><div>Status</div><div>Make-up token</div>
                </div>
                {booked.map((c) => {
                  const cur = attDraft[c.booking_id] ?? c.attendance_status;
                  const tok = tokenStatus[c.booking_id];
                  return (
                    <div key={c.booking_id} className="grid grid-cols-[0.5fr_1.4fr_0.8fr_1fr] px-4 py-3 border-t border-gray-100 items-center">
                      <Checkbox className="data-[state=checked]:bg-[#E91E63]" checked={cur === 'present'}
                        onCheckedChange={(v) => setAttDraft({ ...attDraft, [c.booking_id]: v ? 'present' : 'absent' })} />
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-pink-100 text-pink-600 flex items-center justify-center text-xs font-bold">{initials(c.child_name)}</div>
                        <div>
                          <div className="text-sm font-medium text-gray-900">{c.child_name}</div>
                          <div className="text-xs text-gray-500">{ageLabel(c.child_age_months)}</div>
                        </div>
                      </div>
                      <span className={cn('text-sm capitalize', cur === 'present' ? 'text-green-600' : cur === 'absent' ? 'text-red-600' : 'text-gray-400')}>
                        {cur ?? 'Not marked'}
                      </span>
                      <div>
                        {tok === 'redeemed' ? (
                          <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-purple-100 text-purple-700">Redeemed</span>
                        ) : tok ? (
                          <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700">Issued ✓</span>
                        ) : cur === 'absent' && canManage ? (
                          <button
                            onClick={() => issueToken(c.booking_id)}
                            disabled={issuing}
                            className="px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Add token
                          </button>
                        ) : (
                          <span className="text-sm text-gray-300">—</span>
                        )}
                      </div>
                    </div>
                  );
                })}
                {booked.length === 0 && <div className="px-4 py-6 text-center text-sm text-gray-400">No confirmed attendees.</div>}
              </div>
              {canManage && (
                <Button onClick={saveRoster} className="w-full gradient-primary text-white rounded-xl hover:opacity-90 gap-2">
                  <Save className="w-4 h-4" /> Save roster
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
