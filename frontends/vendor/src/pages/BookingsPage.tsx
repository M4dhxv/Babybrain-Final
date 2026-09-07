import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams} from 'react-router-dom';
import {
  CalendarDays, Search, UserPlus, MessageSquare, Shield, CalendarCheck,
  Clock, Baby, Info, Check, X, Save, Gift, FileCheck, User as UserIcon,
  Pencil, Trash2, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RainbowLoader } from '@/components/ui/rainbow-loader';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { apiPost } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import { SelectField, Opt } from '@/components/ui/select-field';

/**
 * The class roster table's column tracks. Header and body rows are separate grids, so the
 * track list is shared to keep them in step, and every track is
 * `minmax(0, …)` rather than a bare `Nfr` — a bare fr floors at min-content,
 * so one long child name widened that row's track and left the row
 * misaligned against the header. `gap-x-4` keeps neighbouring values from
 * sitting flush. Same fix as the activities table.
 */
const ROSTER_COLS =
  'grid min-w-[570px] gap-x-4 grid-cols-[minmax(0,0.5fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1fr)]';

const bookingsTabs = ['Bookings', 'Waitlist', 'Attendance'];
const PALETTE = ['bg-pink-300 text-pink-800', 'bg-blue-300 text-blue-800', 'bg-yellow-300 text-yellow-800', 'bg-purple-300 text-purple-800', 'bg-green-300 text-green-800'];

const sgDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
// YYYY-MM-DD in Singapore time — matches what a <input type="date"> both
// stores and expects, so a session's calendar day (not just its UTC one,
// which can differ around midnight SGT) can be compared against the filter.
const sgDateKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
// Start of a Singapore-time calendar day as a UTC ISO string. SGT is a fixed
// UTC+8 (no DST), so 00:00 SGT is 16:00 UTC the day before. The default
// session picker starts here — "today" stays in the list all day, even after
// a slot's time has passed, so the vendor can still work its roster.
const sgStartOfDayIso = (key: string) => new Date(`${key}T00:00:00+08:00`).toISOString();
const sgTodayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
// `key` shifted by `days` (negative = earlier), still a SGT YYYY-MM-DD.
const sgKeyShift = (key: string, days: number) => {
  const d = new Date(`${key}T00:00:00+08:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
};
// How far back the date filter can reach.
const PAST_FILTER_DAYS = 30;
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const ageLabel = (m: number | null) => (m == null ? '' : m < 24 ? `${m} months` : `${Math.round(m / 12)} years`);

type SessionOpt = {
  id: string; starts_at: string; capacity: number | null; title: string;
  // Who's taking it and where. Typed in by the vendor for a site-native
  // session; imported from Wix by importWixSessionStaff (lib/wix/sync.ts) for
  // a Wix-sourced one, so a Wix vendor's roster names the instructor too.
  teacher_name: string | null; studio: string | null;
};

type RosterRow = {
  booking_id: string; status: string; payment_status: string; child_name: string;
  child_age_months: number | null; has_medical: boolean; waitlist_position: number | null;
  attendance_status: 'present' | 'absent' | 'late' | null;
  child_id: string | null; skill_level: 'beginner' | 'intermediate' | 'advanced' | null;
  is_manual: boolean; user_id: string | null;
  parent_name: string | null; medical_disclosure: string | null; policies_accepted: number;
  // The parent's answer to whatever this activity asks for (migration 00074).
  info_response: string | null;
  // How the booking was settled (migration 00085): a package credit, a
  // redeemed make-up token, a Stripe payment, a refund, or nothing.
  paid_via: 'credit' | 'token' | 'cash' | 'refunded' | 'free' | 'none' | null;
};

// Roster badge + detail-card wording for each settlement type. Falls back to
// payment_status when paid_via isn't present yet (RPC not deployed).
const PAY_BADGE: Record<string, { label: string; cls: string }> = {
  cash: { label: 'Paid', cls: 'bg-green-300 text-green-800' },
  credit: { label: 'Credit', cls: 'bg-indigo-200 text-indigo-800' },
  token: { label: 'Make-up', cls: 'bg-amber-200 text-amber-900' },
  refunded: { label: 'Refunded', cls: 'bg-gray-200 text-gray-700' },
  free: { label: 'Free', cls: 'bg-gray-100 text-gray-500' },
  none: { label: 'Unpaid', cls: 'bg-gray-100 text-gray-600' },
};
const PAY_DETAIL: Record<string, string> = {
  cash: 'Paid', credit: 'Package credit', token: 'Make-up token', refunded: 'Refunded', free: 'Free', none: 'None',
};
// Always resolves to a key that exists in both maps — a paid_via value this
// build doesn't know (RPC ahead of the deploy) must never white-screen the
// page, it just falls back to "Unpaid".
const payKind = (r: Pick<RosterRow, 'paid_via' | 'payment_status'>): keyof typeof PAY_BADGE => {
  const v =
    r.paid_via ?? (r.payment_status === 'paid' ? 'cash' : r.payment_status === 'refunded' ? 'refunded' : 'none');
  return v in PAY_BADGE ? (v as keyof typeof PAY_BADGE) : 'none';
};
const payBadge = (r: Pick<RosterRow, 'paid_via' | 'payment_status'>) => PAY_BADGE[payKind(r)];
const payDetail = (r: Pick<RosterRow, 'paid_via' | 'payment_status'>) => PAY_DETAIL[payKind(r)];

export default function BookingsPage() {
  const { provider, role, session, subscription } = useAuth();
  const plan = subscription?.plan ?? 'free';
  const canMessage = plan === 'growth' || plan === 'pro' || plan === 'premium';
  const canManage = role === 'owner' || role === 'manager';
  const navigate = useNavigate();
  const [issuing, setIssuing] = useState(false);
  const [issuedFor, setIssuedFor] = useState<string | null>(null);
  /* QA 24/08: "Can't currently adjust expiry on a make up token — need to be
     able to set bespoke expiry." It was hardcoded to 60 days. Presets cover
     the common cases; 'custom' takes a date, and 'none' issues a token that
     never expires (the column is nullable and the UI already renders '—'). */
  const [tokenExpiry, setTokenExpiry] = useState<string>('60');
  const [tokenExpiryDate, setTokenExpiryDate] = useState<string>('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [messaging, setMessaging] = useState(false);

  const [messageError, setMessageError] = useState<string | null>(null);

  /* QA 24/08: "clicked message parent when both vendor and parent on paid tier
     and nothing happened." The route's own 500 (Stream rejects addMembers for
     members already in the channel) was fixed separately — but this had a
     try/finally with no catch, so ANY failure was swallowed into an unhandled
     rejection and the click genuinely looked like it did nothing. */
  async function messageParent(parentUserId: string) {
    if (!provider) return;
    setMessageError(null);
    setMessaging(true);
    try {
      const { channelId } = await apiPost<{ channelId: string }>('/api/vendor/chat/open', {
        provider_id: provider.id,
        parent_user_id: parentUserId,
      });
      if (!channelId) {
        setMessageError('Chat could not be opened just now — please try again.');
        return;
      }
      navigate(`/messages?channel=${channelId}`);
    } catch (e) {
      setMessageError(e instanceof Error ? e.message : 'Could not open the chat — please try again.');
    } finally {
      setMessaging(false);
    }
  }

  /* Deep-linkable so the dashboard's "View details" can land on the right tab
     rather than dumping everyone on Bookings. */
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(
    bookingsTabs.find((t) => t.toLowerCase() === (requestedTab || '').toLowerCase()) ?? 'Bookings'
  );
  useEffect(() => {
    const match = bookingsTabs.find((t) => t.toLowerCase() === (requestedTab || '').toLowerCase());
    if (match && match !== activeTab) setActiveTab(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTab]);
  const selectTab = (t: string) => {
    setActiveTab(t);
    // The left-hand list is a different set of people per tab, so a held
    // selection index would point at the wrong family after switching.
    setSelected(0);
    setSearchParams(t === 'Bookings' ? {} : { tab: t }, { replace: true });
  };
  const [sessions, setSessions] = useState<SessionOpt[]>([]);
  const [sessionActivity, setSessionActivity] = useState<Record<string, string>>({});
  const [sessionId, setSessionId] = useState<string>('');
  // Narrows the session picker to one calendar day — useful once a Wix-linked
  // activity's half-hourly slots push everything else off the (soonest-50)
  // list. Empty string = no filter, matching <input type="date">'s own "no
  // value" state.
  const [dateFilter, setDateFilter] = useState('');
  const dateFilterRef = useRef<HTMLInputElement>(null);
  // Recomputed on mount (and if `sessions` changes) — fine for a page a
  // vendor doesn't leave open across midnight.
  const startTodayIso = useMemo(() => sgStartOfDayIso(sgTodayKey()), []);
  // No date filter → today (incl. slots already past) plus everything ahead.
  // A date filter → exactly that calendar day, which can be up to
  // PAST_FILTER_DAYS in the past.
  const filteredSessions = useMemo(
    () =>
      dateFilter
        ? sessions.filter((s) => sgDateKey(s.starts_at) === dateFilter)
        : sessions.filter((s) => s.starts_at >= startTodayIso),
    [sessions, dateFilter, startTodayIso]
  );
  // Switching (or clearing) the date filter can leave the current selection
  // out of view — jump to the first session that's still in it rather than
  // showing a roster for a session no longer in the visible list.
  useEffect(() => {
    if (filteredSessions.length && !filteredSessions.some((s) => s.id === sessionId)) {
      setSessionId(filteredSessions[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSessions]);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState('');
  const [attDraft, setAttDraft] = useState<Record<string, 'present' | 'absent'>>({});
  const [tokenStatus, setTokenStatus] = useState<Record<string, string>>({});
  // Which waivers/consents a booking actually accepted — fetched per booking
  // (cached by booking_id) rather than bundled into the roster RPC, since
  // this only needs to be looked at for the one booking currently open.
  const [policyAcceptances, setPolicyAcceptances] = useState<Record<string, { policy_id: string; policy_title: string; accepted_at: string }[]>>({});
  const [loading, setLoading] = useState(true);

  // 2.1: manual booking entry (bookings taken outside BabyBrain)
  const [showManual, setShowManual] = useState(false);
  const [manualForm, setManualForm] = useState({ name: '', contact: '', paid: false });
  const [savingManual, setSavingManual] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  async function addManualBooking() {
    if (!sessionId || !manualForm.name.trim()) { setManualError('A name is required.'); return; }
    setSavingManual(true);
    setManualError(null);
    const { error } = await supabase.from('bookings').insert({
      session_id: sessionId,
      guest_name: manualForm.name.trim(),
      guest_contact: manualForm.contact.trim() || null,
      payment_status: manualForm.paid ? 'paid' : 'none',
    });
    setSavingManual(false);
    if (error) { setManualError(error.message); return; }
    setManualForm({ name: '', contact: '', paid: false });
    setShowManual(false);
    loadRoster(sessionId);
  }

  // 2.4: per-child skill level for this activity, set from the roster.
  const [savingSkill, setSavingSkill] = useState(false);
  async function setSkillLevel(row: RosterRow, level: string) {
    if (!row.child_id || !currentSession) return;
    const activityId = sessionActivity[currentSession.id];
    if (!activityId) return;
    setSavingSkill(true);
    if (level) {
      await supabase.from('child_skill_levels').upsert(
        { child_id: row.child_id, activity_id: activityId, level: level as 'beginner' | 'intermediate' | 'advanced', set_by: session?.user.id ?? null },
        { onConflict: 'child_id,activity_id' }
      );
    } else {
      await supabase.from('child_skill_levels').delete().eq('child_id', row.child_id).eq('activity_id', activityId);
    }
    setSavingSkill(false);
    loadRoster(sessionId);
  }

  // Load this provider's upcoming sessions (RLS-scoped via activities join).
  useEffect(() => {
    if (!provider) return;
    (async () => {
      const { data: acts } = await supabase.from('activities').select('id, title').eq('provider_id', provider.id);
      const map = new Map((acts ?? []).map((a) => [a.id, a.title]));
      const ids = [...map.keys()];
      if (!ids.length) { setSessions([]); setLoading(false); return; }
      // Capped per activity, not globally — a single high-frequency
      // Wix-linked activity can generate hundreds of rows (30-min slots
      // over weeks), which under one shared cap silently squeezed every
      // other activity's sessions out entirely. A low-frequency one (a
      // once-off course, a monthly class) could vanish from the picker
      // even though it's genuinely upcoming. One query per activity,
      // each capped, guarantees every activity gets a fair share.
      const perActivityCap = 20;
      // Two windows per activity so a past date is always reachable from the
      // filter without a high-frequency Wix activity's history crowding out
      // its future slots: today→ahead (ascending), and the last
      // PAST_FILTER_DAYS before today (descending, so the most recent past
      // sessions are the ones that survive the cap).
      const dayStartIso = sgStartOfDayIso(sgTodayKey());
      const pastStartIso = sgStartOfDayIso(sgKeyShift(sgTodayKey(), -PAST_FILTER_DAYS));
      const pastCap = 40;
      const results = await Promise.all(
        ids.flatMap((id) => [
          supabase
            .from('activity_sessions')
            .select('id, starts_at, capacity, activity_id, teacher_name, studio')
            .eq('activity_id', id)
            .gte('starts_at', dayStartIso)
            .order('starts_at', { ascending: true })
            .limit(perActivityCap),
          supabase
            .from('activity_sessions')
            .select('id, starts_at, capacity, activity_id, teacher_name, studio')
            .eq('activity_id', id)
            .gte('starts_at', pastStartIso)
            .lt('starts_at', dayStartIso)
            .order('starts_at', { ascending: false })
            .limit(pastCap),
        ])
      );
      const seen = new Set<string>();
      const sess = results
        .flatMap((r) => r.data ?? [])
        .filter((s) => !seen.has(s.id) && seen.add(s.id))
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      const opts = sess.map((s) => ({
        id: s.id, starts_at: s.starts_at, capacity: s.capacity, title: map.get(s.activity_id) ?? 'Activity',
        teacher_name: s.teacher_name, studio: s.studio,
      }));
      setSessionActivity(Object.fromEntries(sess.map((s) => [s.id, s.activity_id])));
      setSessions(opts);
      // The Schedule tab deep-links here with ?session=, so a click on a
      // calendar session lands straight on its roster instead of whichever
      // session happened to load first.
      const requested = searchParams.get('session');
      const preselect = requested && opts.some((o) => o.id === requested) ? requested : '';
      // Default to the first session from today onward (past ones are only
      // there for the date filter); fall back to the most recent past one if
      // there's nothing upcoming.
      const firstUpcoming = opts.find((o) => o.starts_at >= dayStartIso);
      setSessionId((cur) => cur || preselect || firstUpcoming?.id || opts[opts.length - 1]?.id || '');
      if (requested) setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('session'); return next; }, { replace: true });
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  /* Whether the roster on screen belongs to a session that has already run —
     reachable via the date filter, which reaches PAST_FILTER_DAYS back. Uses
     the same Singapore day boundary the picker does, so "past" means an
     earlier day rather than merely an earlier hour of today. */
  const currentSessionIsPast = !!currentSession && currentSession.starts_at < startTodayIso;
  const booked = useMemo(() => roster.filter((r) => r.status === 'confirmed' || r.status === 'completed'), [roster]);
  const waitlisted = useMemo(() => roster.filter((r) => r.status === 'waitlisted'), [roster]);
  /* QA 04/09: "Under bookings, when there is a waitlist and you click on that
     tab, all the bookings are still showing on the left — should just show the
     waitlist." The left-hand list now follows the tab. Attendance is still
     taken against the confirmed roster, so it keeps the booked list. */
  const listSource = activeTab === 'Waitlist' ? waitlisted : booked;
  const visibleBookings = listSource.filter((b) => b.child_name.toLowerCase().includes(search.toLowerCase()));
  const presentCount = booked.filter((b) => (attDraft[b.booking_id] ?? b.attendance_status) === 'present').length;
  const absentCount = booked.filter((b) => (attDraft[b.booking_id] ?? b.attendance_status) === 'absent').length;

  async function promote(bookingId: string) {
    await supabase.rpc('promote_waitlist_entry', { p_booking_id: bookingId });
    loadRoster(sessionId);
  }
  async function removeBooking(bookingId: string) {
    const { error } = await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', bookingId);
    // Used to swallow the error entirely, so a refused update looked like it
    // had worked until the roster reloaded unchanged.
    if (error) { setRowError(error.message); return; }
    setRowError(null);
    loadRoster(sessionId);
  }

  /* ---- QA 04/09: acting on one booking, not the whole activity ----
     "Currently can only cancel a whole activity, not just a particular
     booking" and "when a booking is added manually, can't edit or delete".

     Two different actions, deliberately: a real parent's booking is
     CANCELLED — that notifies them and hands back whatever paid for it (the
     compensate_cancelled_booking trigger returns a package credit or reissues
     a make-up token) — while a manual guest entry, which is the vendor's own
     record of something arranged offline, can be corrected or deleted
     outright. Migration 00084 adds the delete policy, scoped to manual rows. */
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState(false);
  const [editingManual, setEditingManual] = useState<string | null>(null);
  const [manualEdit, setManualEdit] = useState({ name: '', contact: '', paid: false });
  /* The cancel confirm panel for the selected booking: the vendor picks
     whether the parent is made whole (credit reinstated / make-up token — the
     compensate_cancelled_booking trigger decides which from how it was paid)
     or gets nothing, and must say why for a no-refund cancel. */
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [cancelMode, setCancelMode] = useState<'refund' | 'none'>('refund');
  const [cancelReason, setCancelReason] = useState('');

  async function startManualEdit(row: RosterRow) {
    setRowError(null);
    // The roster RPC returns the display name but not the stored guest fields,
    // so read the row itself to seed the form with what's actually saved.
    const { data } = await supabase
      .from('bookings')
      .select('guest_name, guest_contact, payment_status')
      .eq('id', row.booking_id)
      .maybeSingle();
    setManualEdit({
      name: data?.guest_name ?? row.child_name,
      contact: data?.guest_contact ?? '',
      paid: (data?.payment_status ?? row.payment_status) === 'paid',
    });
    setEditingManual(row.booking_id);
  }

  async function saveManualEdit(bookingId: string) {
    if (!manualEdit.name.trim()) { setRowError('A name is required.'); return; }
    setRowBusy(true);
    const { error } = await supabase.from('bookings').update({
      guest_name: manualEdit.name.trim(),
      guest_contact: manualEdit.contact.trim() || null,
      payment_status: manualEdit.paid ? 'paid' : 'none',
    }).eq('id', bookingId);
    setRowBusy(false);
    if (error) { setRowError(error.message); return; }
    setRowError(null);
    setEditingManual(null);
    loadRoster(sessionId);
  }

  async function deleteManualBooking(row: RosterRow) {
    if (!window.confirm(`Delete the manual entry for ${row.child_name}? It's removed from the roster for good.`)) return;
    setRowBusy(true);
    const { error, count } = await supabase
      .from('bookings')
      .delete({ count: 'exact' })
      .eq('id', row.booking_id);
    setRowBusy(false);
    if (error) { setRowError(error.message); return; }
    // RLS returns success with zero rows when the policy doesn't match, so a
    // silent no-op has to be reported rather than looking like it worked.
    if (!count) { setRowError('That entry could not be deleted — only manually-added bookings can be.'); return; }
    setRowError(null);
    setSelected(0);
    loadRoster(sessionId);
  }

  function openCancel(row: RosterRow) {
    setRowError(null);
    setCancelMode('refund');
    setCancelReason('');
    setCancelFor(row.booking_id);
  }

  async function cancelBooking(row: RosterRow) {
    if (cancelMode === 'none' && !cancelReason.trim()) {
      setRowError('A reason is required when cancelling with no refund.');
      return;
    }
    setRowBusy(true);
    const { error } = await supabase
      .from('bookings')
      .update({
        status: 'cancelled',
        cancel_refund_mode: cancelMode,
        cancel_reason: cancelMode === 'none' ? cancelReason.trim() : null,
        cancelled_by: session?.user.id ?? null,
      })
      .eq('id', row.booking_id);
    setRowBusy(false);
    if (error) { setRowError(error.message); return; }
    setRowError(null);
    setCancelFor(null);
    setSelected(0);
    loadRoster(sessionId);
  }

  /* Rendered wherever a token can be issued, so the expiry is set where the
     decision is made rather than on another tab. */
  const expiryPicker = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-gray-500">Expires</span>
      <SelectField
        value={tokenExpiry}
        onChange={setTokenExpiry}
        aria-label="Token expiry"
        className="px-2 py-1 text-xs text-gray-700"
      >
        <Opt value="30">in 30 days</Opt>
        <Opt value="60">in 60 days</Opt>
        <Opt value="90">in 90 days</Opt>
        <Opt value="180">in 6 months</Opt>
        <Opt value="365">in 12 months</Opt>
        <Opt value="custom">on a set date…</Opt>
        <Opt value="none">never</Opt>
      </SelectField>
      {tokenExpiry === 'custom' && (
        <input
          type="date"
          value={tokenExpiryDate}
          onChange={(e) => setTokenExpiryDate(e.target.value)}
          className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700"
        />
      )}
    </div>
  );

  /** The chosen expiry as an ISO instant, or null for a token that never expires. */
  function tokenExpiresAt(): string | null | 'invalid' {
    if (tokenExpiry === 'none') return null;
    if (tokenExpiry === 'custom') {
      if (!tokenExpiryDate) return 'invalid';
      // End of the chosen day in Singapore time, so a token dated "today" is
      // still usable for the rest of today.
      const d = new Date(`${tokenExpiryDate}T23:59:59+08:00`);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return 'invalid';
      return d.toISOString();
    }
    return new Date(Date.now() + Number(tokenExpiry) * 864e5).toISOString();
  }

  async function issueToken(bookingId: string) {
    if (!provider) return;
    setTokenError(null);
    const expiresAt = tokenExpiresAt();
    if (expiresAt === 'invalid') {
      setTokenError('Pick an expiry date in the future.');
      return;
    }
    setIssuing(true);
    const { data: bk } = await supabase.from('bookings').select('user_id, child_id').eq('id', bookingId).maybeSingle();
    if (!bk?.user_id) {
      // Manual bookings have no parent account, so there is nobody to hold the
      // token. Said out loud rather than silently doing nothing.
      setTokenError('This booking has no parent account, so a token can\'t be issued for it.');
      setIssuing(false);
      return;
    }
    const { error } = await supabase.from('make_up_tokens').insert({
      provider_id: provider.id,
      user_id: bk.user_id,
      child_id: bk.child_id,
      origin_booking_id: bookingId,
      status: 'issued',
      issued_by: session?.user.id ?? null,
      expires_at: expiresAt,
    });
    setIssuing(false);
    if (error) {
      setTokenError(error.message);
      return;
    }
    setIssuedFor(bookingId);
    setTokenStatus((m) => ({ ...m, [bookingId]: 'issued' }));
  }
  /* The button wrote the roster but said nothing, so it read as doing nothing.
     It now reports success or the actual error, and the confirmation clears
     itself so a second save is obviously a fresh one. */
  const [rosterSaving, setRosterSaving] = useState(false);
  const [rosterNotice, setRosterNotice] = useState<string | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);

  async function saveRoster() {
    if (!sessionId) return;
    setRosterSaving(true);
    setRosterNotice(null);
    setRosterError(null);
    const rows = booked
      .map((b) => ({ booking_id: b.booking_id, session_id: sessionId, status: (attDraft[b.booking_id] ?? b.attendance_status ?? 'present') as 'present' | 'absent', marked_by: session?.user.id ?? null, marked_at: new Date().toISOString() }))
      .filter((r) => r.status);
    if (!rows.length) {
      setRosterSaving(false);
      setRosterError('Nobody is booked on this session yet.');
      return;
    }
    const { error } = await supabase.from('attendance').upsert(rows, { onConflict: 'booking_id' });
    setRosterSaving(false);
    if (error) { setRosterError(error.message); return; }
    const present = rows.filter((r) => r.status === 'present').length;
    setRosterNotice(`Saved — ${present} present, ${rows.length - present} absent.`);
    window.setTimeout(() => setRosterNotice(null), 4000);
    loadRoster(sessionId);
  }

  const sel = visibleBookings[selected];

  // Don't carry a half-finished edit, or an error about one booking, onto
  // whichever booking is selected next.
  useEffect(() => { setEditingManual(null); setCancelFor(null); setRowError(null); }, [sel?.booking_id, sessionId]);

  useEffect(() => {
    if (!sel || sel.policies_accepted === 0 || policyAcceptances[sel.booking_id]) return;
    (async () => {
      const { data } = await supabase
        .from('booking_policy_acceptances')
        .select('policy_id, policy_title, accepted_at')
        .eq('booking_id', sel.booking_id)
        .order('accepted_at');
      setPolicyAcceptances((prev) => ({ ...prev, [sel.booking_id]: data ?? [] }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.booking_id]);

  return (
    <div className="relative">
      <div className="flex items-center justify-between px-4 py-5 sm:px-8">
        <div className="w-full text-center sm:w-auto sm:text-left">
          <h1 className="text-2xl font-bold text-gray-900">Bookings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage bookings for your sessions.</p>
        </div>
      </div>

      <div className="px-4 pb-8 sm:px-8">
        {/* Session Selector (real sessions). One pill: on mobile it stacks so
            the date filter sits on its own row below the session box (it used
            to be crammed alongside and overflow); on desktop it's the same
            single inline pill as before. */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex w-full flex-col gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 sm:w-auto sm:flex-row sm:items-center">
            <div className="flex min-w-0 items-center gap-2">
              <Baby className="w-4 h-4 shrink-0 text-[#FA4D8D]" />
              <SelectField bare value={sessionId} onChange={setSessionId} aria-label="Session" className="min-w-0 flex-1 font-medium sm:flex-none" placeholder={dateFilter ? 'No sessions on this date' : 'No sessions yet'}>
                {filteredSessions.length === 0 && <Opt value="" disabled>{dateFilter ? 'No sessions on this date' : 'No sessions yet'}</Opt>}
                {filteredSessions.map((s) => (
                  <Opt key={s.id} value={s.id}>
                    {s.title} • {sgDateTime(s.starts_at)}{s.starts_at < startTodayIso ? ' • past' : ''}
                  </Opt>
                ))}
              </SelectField>
            </div>
            <div className="h-px w-full bg-gray-200 sm:h-4 sm:w-px" />
            <div className="flex min-w-0 items-center gap-2">
              {/* The input's own native picker-indicator icon is hidden — this
                  icon opens the same picker instead, so there's only one
                  calendar symbol instead of two. */}
              <CalendarDays
                className="w-4 h-4 shrink-0 text-[#FA4D8D] cursor-pointer"
                onClick={() => dateFilterRef.current?.showPicker?.()}
              />
              <input
                ref={dateFilterRef}
                type="date"
                value={dateFilter}
                min={sgKeyShift(sgTodayKey(), -PAST_FILTER_DAYS)}
                onChange={(e) => setDateFilter(e.target.value)}
                className="min-w-0 flex-1 bg-transparent font-medium focus:outline-none [&::-webkit-calendar-picker-indicator]:hidden sm:flex-none"
                aria-label={`Filter sessions by date — past ${PAST_FILTER_DAYS} days available`}
                title={`Pick any date from the last ${PAST_FILTER_DAYS} days onward to open that day's roster`}
              />
              {dateFilter && (
                <button onClick={() => setDateFilter('')} className="shrink-0 text-xs font-medium text-gray-400 hover:text-gray-600">
                  Clear
                </button>
              )}
            </div>
          </div>
          {canManage && sessionId && (
            <button
              onClick={() => { setShowManual((v) => !v); setManualError(null); }}
              className="flex w-full items-center justify-center gap-2 px-4 py-2.5 bg-pink-50 text-[#FA4D8D] rounded-xl text-sm font-medium hover:bg-pink-100 sm:w-auto"
            >
              <UserPlus className="w-4 h-4" /> Add booking
            </button>
          )}
          {/* Who's on this session, so whoever is working the roster knows who
              to hand it to without opening Schedule. For a Wix-linked session
              this is the staff member Wix has assigned (imported by
              importWixSessionStaff) — it can't be edited here, same as every
              other Wix-owned detail. */}
          {currentSession && (currentSession.teacher_name || currentSession.studio) && (
            <div className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-gray-600 sm:w-auto">
              <UserIcon className="h-4 w-4 shrink-0 text-[#FA4D8D]" />
              <span className="truncate font-medium">
                {[currentSession.teacher_name, currentSession.studio].filter(Boolean).join(' · ')}
              </span>
            </div>
          )}
        </div>

        {/* 2.1: record a booking taken outside BabyBrain */}
        {showManual && (
          <div className="mb-6 max-w-2xl rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-sm font-semibold text-gray-900 mb-1">Add a booking taken outside BabyBrain</div>
            <p className="text-xs text-gray-500 mb-3">Recorded against the selected session so your roster and attendance stay complete.</p>
            {manualError && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{manualError}</div>}
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Child / guest name <span className="text-[#FA4D8D]">*</span></label>
                <input value={manualForm.name} onChange={(e) => setManualForm({ ...manualForm, name: e.target.value })} placeholder="e.g. Mia Tan" className="h-9 w-48 rounded-lg border border-gray-300 px-3 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Contact (optional)</label>
                <input value={manualForm.contact} onChange={(e) => setManualForm({ ...manualForm, contact: e.target.value })} placeholder="Phone or email" className="h-9 w-52 rounded-lg border border-gray-300 px-3 text-sm" />
              </div>
              <label className="flex h-9 items-center gap-2 text-sm text-gray-700">
                <Checkbox checked={manualForm.paid} onCheckedChange={(v) => setManualForm({ ...manualForm, paid: Boolean(v) })} className="data-[state=checked]:bg-[#C90044]" />
                Paid outside BabyBrain
              </label>
              <button onClick={addManualBooking} disabled={savingManual || !manualForm.name.trim()} className="h-9 rounded-lg bg-[#C90044] px-4 text-sm font-medium text-white disabled:opacity-50">
                {savingManual ? 'Adding…' : 'Add booking'}
              </button>
              <button onClick={() => setShowManual(false)} className="h-9 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-6 border-b border-gray-200 mb-6 overflow-x-auto">
          {bookingsTabs.map((tab) => (
            <button key={tab} onClick={() => selectTab(tab)}
              className={cn('flex items-center gap-2 text-sm font-medium pb-3 border-b-2 transition-colors',
                activeTab === tab ? 'text-[#FA4D8D] border-[#C90044]' : 'text-gray-500 border-transparent hover:text-gray-700')}>
              {tab === 'Bookings' && <CalendarDays className="w-4 h-4" />}
              {tab === 'Waitlist' && <UserPlus className="w-4 h-4" />}
              {tab === 'Attendance' && <CalendarCheck className="w-4 h-4" />}
              {tab}{tab === 'Waitlist' && waitlisted.length > 0 ? ` (${waitlisted.length})` : ''}
            </button>
          ))}
        </div>

        {loading && <RainbowLoader className="py-6" label="Loading bookings" />}

        <div className="flex flex-col gap-6 lg:flex-row">
          {/* Booking list */}
          <div className="w-full flex-shrink-0 lg:w-80">
            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={activeTab === 'Waitlist' ? 'Search waitlist...' : 'Search bookings...'}
                className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-pink-300" />
            </div>
            <div className="space-y-2">
              {visibleBookings.map((b, idx) => (
                <div key={b.booking_id} onClick={() => setSelected(idx)}
                  className={cn('flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-colors',
                    selected === idx ? 'bg-pink-50 border border-pink-300' : 'hover:bg-gray-50 border border-transparent')}>
                  <div className={cn('w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0', PALETTE[idx % PALETTE.length])}>
                    {initials(b.child_name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-gray-900 text-sm">{b.child_name}</span>
                    <div className="text-xs text-gray-500">
                      {[ageLabel(b.child_age_months), b.parent_name ? `Parent: ${b.parent_name}` : '']
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {b.has_medical && <span className="inline-block px-1.5 py-0.5 text-xs rounded bg-purple-300 text-purple-800">Medical Disclosure</span>}
                      {b.is_manual && <span className="inline-block px-1.5 py-0.5 text-xs rounded bg-blue-300 text-blue-800">Manual</span>}
                      {b.skill_level && <span className="inline-block px-1.5 py-0.5 text-xs rounded bg-orange-300 text-orange-800 capitalize">{b.skill_level}</span>}
                    </div>
                  </div>
                  <span className={cn('inline-block px-2 py-0.5 text-xs rounded-full', payBadge(b).cls)}>
                    {payBadge(b).label}
                  </span>
                </div>
              ))}
              {!loading && visibleBookings.length === 0 && (
                <div className="text-sm text-gray-400 px-1">
                  {activeTab === 'Waitlist' ? 'No one on the waitlist for this session.' : 'No bookings for this session.'}
                </div>
              )}
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
                      <div className="text-sm text-gray-700">{payDetail(sel)}</div>
                    </div>
                    {sel.parent_name && (
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Booked by</div>
                        <div className="text-sm text-gray-700">{sel.parent_name}</div>
                      </div>
                    )}
                    <div>
                      <div className="text-xs text-gray-500 mb-2">Medical Disclosure</div>
                      <div className={cn('flex items-start gap-2 px-3 py-2 rounded-lg', sel.has_medical ? 'bg-purple-50' : 'bg-gray-50')}>
                        <Shield className={cn('w-4 h-4 mt-0.5 shrink-0', sel.has_medical ? 'text-purple-600' : 'text-gray-400')} />
                        <span className={cn('text-sm whitespace-pre-wrap', sel.has_medical ? 'text-purple-700' : 'text-gray-500')}>
                          {sel.medical_disclosure || (sel.has_medical ? 'On file' : 'None provided')}
                        </span>
                      </div>
                    </div>
                    {/* Whatever this activity asked the parent for (00074) —
                        only rendered when there is an answer, so activities
                        that ask nothing don't grow an empty row. */}
                    {sel.info_response && (
                      <div>
                        <div className="text-xs text-gray-500 mb-2">Information you requested</div>
                        <div className="flex items-start gap-2 rounded-lg bg-blue-50 px-3 py-2">
                          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                          <span className="whitespace-pre-wrap text-sm text-blue-800">{sel.info_response}</span>
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="text-xs text-gray-500 mb-2">Waivers &amp; consents</div>
                      {sel.policies_accepted > 0 ? (
                        <div className="rounded-lg bg-green-50 px-3 py-2 space-y-1.5">
                          {(policyAcceptances[sel.booking_id] ?? []).length === 0 ? (
                            <RainbowLoader size="sm" className="justify-start py-0.5" label="Loading waivers" />
                          ) : (
                            policyAcceptances[sel.booking_id].map((p) => (
                              <div key={p.policy_id} className="flex items-start gap-2">
                                <FileCheck className="w-4 h-4 mt-0.5 shrink-0 text-green-600" />
                                <div className="text-sm text-green-700">
                                  {p.policy_title}
                                  <span className="block text-xs text-green-600/80">
                                    Accepted {sgDateTime(p.accepted_at)}
                                  </span>
                                </div>
                              </div>
                            ))
                          )}
                          <button
                            type="button"
                            onClick={() => navigate('/settings?tab=policies')}
                            className="text-xs font-medium text-green-700 underline underline-offset-2 hover:text-green-800"
                          >
                            View waivers &amp; consents →
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50">
                          <FileCheck className="w-4 h-4 text-gray-400" />
                          <span className="text-sm text-gray-500">
                            {sel.is_manual ? 'Manual booking — collected offline' : 'None on file'}
                          </span>
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Attendance</div>
                      <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-yellow-500" />
                        <span className="text-sm text-gray-700 capitalize">{sel.attendance_status ?? 'Not marked'}</span>
                      </div>
                    </div>
                    {sel.child_id && (
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Skill level (this class)</div>
                        <SelectField
                          value={sel.skill_level ?? ''}
                          disabled={!canManage || savingSkill}
                          onChange={(v) => setSkillLevel(sel, v)}
                          aria-label="Skill level for this class"
                          className="w-full px-3 py-2"
                        >
                          <Opt value="">Not set</Opt>
                          {['beginner', 'intermediate', 'advanced'].map((l) => (
                            <Opt key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</Opt>
                          ))}
                        </SelectField>
                      </div>
                    )}
                  </div>
                  {/* Messaging is a paid feature — the plans page lists "Direct
                      to user messaging" from Growth up, but this button was
                      live on Free. */}
                  {!canMessage ? (
                    <button
                      onClick={() => navigate('/plans')}
                      className="flex items-center gap-2 mt-6 text-sm text-gray-400 hover:text-[#FA4D8D]"
                      title="Messaging parents is available on Pro and above"
                    >
                      <MessageSquare className="w-4 h-4" /> Message parent — upgrade to Pro
                    </button>
                  ) : sel.user_id ? (
                    <button
                      onClick={() => messageParent(sel.user_id!)}
                      disabled={messaging}
                      className="flex items-center gap-2 mt-6 text-sm text-[#FA4D8D] font-medium hover:underline disabled:opacity-60"
                    >
                      <MessageSquare className="w-4 h-4" /> {messaging ? 'Opening chat…' : 'Message parent'}
                    </button>
                  ) : (
                    <button disabled className="flex items-center gap-2 mt-6 text-sm text-gray-400 cursor-not-allowed" title="Manual bookings have no parent account to message">
                      <MessageSquare className="w-4 h-4" /> Message parent
                    </button>
                  )}
                  {messageError && (
                    <p className="mt-2 text-xs font-medium text-red-600">{messageError}</p>
                  )}
                  {canManage && (
                    <div className="mt-3">
                      <button
                        onClick={() => issueToken(sel.booking_id)}
                        disabled={issuing || issuedFor === sel.booking_id || !!tokenStatus[sel.booking_id]}
                        className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 disabled:opacity-60"
                      >
                        <Gift className="w-4 h-4" />
                        {tokenStatus[sel.booking_id] === 'redeemed' ? 'Make-up token redeemed' : tokenStatus[sel.booking_id] || issuedFor === sel.booking_id ? 'Make-up token issued ✓' : issuing ? 'Issuing…' : 'Issue make-up token'}
                      </button>
                      {/* Only worth showing while a token can still be issued. */}
                      {!tokenStatus[sel.booking_id] && issuedFor !== sel.booking_id && (
                        <div className="mt-2">{expiryPicker}</div>
                      )}
                      {tokenError && <p className="mt-2 text-xs font-medium text-red-600">{tokenError}</p>}
                    </div>
                  )}

                  {/* Per-booking actions (QA 04/09). */}
                  {canManage && sel.status !== 'cancelled' && (
                    <div className="mt-6 border-t border-gray-100 pt-4">
                      {editingManual === sel.booking_id ? (
                        <div className="space-y-3">
                          <div className="text-sm font-medium text-gray-900">Edit this manual entry</div>
                          <div>
                            <label className="mb-1 block text-xs font-medium text-gray-600">Child / guest name</label>
                            <input
                              value={manualEdit.name}
                              onChange={(e) => setManualEdit({ ...manualEdit, name: e.target.value })}
                              className="h-9 w-full rounded-lg border border-gray-300 px-3 text-sm"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-xs font-medium text-gray-600">Contact (optional)</label>
                            <input
                              value={manualEdit.contact}
                              onChange={(e) => setManualEdit({ ...manualEdit, contact: e.target.value })}
                              placeholder="Phone or email"
                              className="h-9 w-full rounded-lg border border-gray-300 px-3 text-sm"
                            />
                          </div>
                          <label className="flex items-center gap-2 text-sm text-gray-700">
                            <Checkbox
                              checked={manualEdit.paid}
                              onCheckedChange={(v) => setManualEdit({ ...manualEdit, paid: Boolean(v) })}
                              className="data-[state=checked]:bg-[#C90044]"
                            />
                            Paid outside BabyBrain
                          </label>
                          <div className="flex gap-2">
                            <button
                              onClick={() => saveManualEdit(sel.booking_id)}
                              disabled={rowBusy || !manualEdit.name.trim()}
                              className="h-9 rounded-lg bg-[#C90044] px-4 text-sm font-medium text-white disabled:opacity-50"
                            >
                              {rowBusy ? 'Saving…' : 'Save changes'}
                            </button>
                            <button
                              onClick={() => { setEditingManual(null); setRowError(null); }}
                              className="h-9 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : cancelFor === sel.booking_id ? (
                        <div className="space-y-3">
                          <div className="text-sm font-medium text-gray-900">Cancel {sel.child_name}&rsquo;s booking</div>
                          <p className="text-xs text-gray-500">
                            The parent is notified and the place is freed either way.
                          </p>
                          <div>
                            <label className="mb-1 block text-xs font-medium text-gray-600">Refund</label>
                            <SelectField
                              value={cancelMode}
                              onChange={(v) => setCancelMode(v as 'refund' | 'none')}
                              aria-label="Refund"
                              className="h-9 w-full px-3"
                            >
                              <Opt value="refund">Refund as package credit / make-up token</Opt>
                              <Opt value="none">No refund</Opt>
                            </SelectField>
                          </div>
                          {cancelMode === 'none' && (
                            <div className="space-y-2">
                              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                                Payment for this activity is non-refundable, if cancelled. No package credit or make-up token is returned.
                              </p>
                              <div>
                                <label className="mb-1 block text-xs font-medium text-gray-600">
                                  Reason <span className="text-[#FA4D8D]">*</span>
                                </label>
                                <textarea
                                  value={cancelReason}
                                  onChange={(e) => setCancelReason(e.target.value)}
                                  rows={2}
                                  placeholder="Why is no refund being given?"
                                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                                />
                              </div>
                            </div>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => cancelBooking(sel)}
                              disabled={rowBusy || (cancelMode === 'none' && !cancelReason.trim())}
                              className="h-9 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                            >
                              {rowBusy ? 'Cancelling…' : 'Confirm cancellation'}
                            </button>
                            <button
                              onClick={() => { setCancelFor(null); setRowError(null); }}
                              className="h-9 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
                            >
                              Keep booking
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-4">
                          {/* A manual entry is the vendor's own offline record — correct
                              it or remove it. A parent's booking is neither. */}
                          {sel.is_manual && (
                            <>
                              <button
                                onClick={() => startManualEdit(sel)}
                                className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
                              >
                                <Pencil className="h-4 w-4" /> Edit entry
                              </button>
                              <button
                                onClick={() => deleteManualBooking(sel)}
                                disabled={rowBusy}
                                className="flex items-center gap-2 text-sm font-medium text-red-600 hover:text-red-700 disabled:opacity-60"
                              >
                                <Trash2 className="h-4 w-4" /> Delete entry
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => openCancel(sel)}
                            disabled={rowBusy}
                            className="flex items-center gap-2 text-sm font-medium text-red-600 hover:text-red-700 disabled:opacity-60"
                          >
                            <XCircle className="h-4 w-4" /> Cancel this booking
                          </button>
                        </div>
                      )}
                      {rowError && <p className="mt-2 text-xs font-medium text-red-600">{rowError}</p>}
                    </div>
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
              {/* The picker now reaches back over recent sessions (QA 04/09), so
                  say plainly when the roster on screen is one that already ran. */}
              {currentSessionIsPast && (
                <div className="mb-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <p className="text-xs text-amber-800">
                    This session has already run — you can still mark and save attendance for it.
                  </p>
                </div>
              )}
              <div className="flex items-center gap-4 mb-5">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-green-100 rounded-lg">
                  <Check className="w-4 h-4 text-green-600" /><span className="text-sm font-medium text-green-700">Present {presentCount}</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 bg-red-100 rounded-lg">
                  <X className="w-4 h-4 text-red-600" /><span className="text-sm font-medium text-red-700">Absent {absentCount}</span>
                </div>
                <span className="ml-auto text-sm text-gray-700"><strong>{booked.length}</strong> booked</span>
              </div>
              {/* Absent families get a make-up token from this roster, so the
                  expiry has to be settable here too. */}
              <div className="mb-4 flex flex-wrap items-center gap-3">
                {canManage && expiryPicker}
                {tokenError && <p className="text-xs font-medium text-red-600">{tokenError}</p>}
              </div>
              <div className="border border-gray-200 rounded-xl overflow-x-auto mb-5">
                <div className={cn(ROSTER_COLS, 'px-4 py-2.5 bg-gray-50 text-xs font-medium text-gray-500')}>
                  <div>Present</div><div>Child</div><div>Status</div><div>Make-up token</div>
                </div>
                {booked.map((c) => {
                  const cur = attDraft[c.booking_id] ?? c.attendance_status;
                  const tok = tokenStatus[c.booking_id];
                  return (
                    <div key={c.booking_id} className={cn(ROSTER_COLS, 'px-4 py-3 border-t border-gray-100 items-center')}>
                      <Checkbox className="data-[state=checked]:bg-[#C90044]" checked={cur === 'present'}
                        onCheckedChange={(v) => setAttDraft({ ...attDraft, [c.booking_id]: v ? 'present' : 'absent' })} />
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="w-8 h-8 flex-shrink-0 rounded-full bg-pink-300 text-pink-800 flex items-center justify-center text-xs font-bold">{initials(c.child_name)}</div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900 break-words">{c.child_name}</div>
                          <div className="text-xs text-gray-500">{ageLabel(c.child_age_months)}</div>
                        </div>
                      </div>
                      <span className={cn('text-sm capitalize', cur === 'present' ? 'text-green-600' : cur === 'absent' ? 'text-red-600' : 'text-gray-400')}>
                        {cur ?? 'Not marked'}
                      </span>
                      <div>
                        {tok === 'redeemed' ? (
                          <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-purple-300 text-purple-800">Redeemed</span>
                        ) : tok ? (
                          <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-green-300 text-green-800">Issued ✓</span>
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
                <Button onClick={saveRoster} disabled={rosterSaving} className="w-full gradient-primary text-white rounded-xl hover:opacity-90 gap-2">
                  <Save className="w-4 h-4" /> {rosterSaving ? 'Saving…' : 'Save roster'}
                </Button>
              )}
              {(rosterError || rosterNotice) && (
                <p className={cn('mt-2 text-center text-sm font-medium', rosterError ? 'text-red-600' : 'text-green-700')}>
                  {rosterError ?? rosterNotice}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
