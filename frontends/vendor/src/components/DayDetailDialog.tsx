import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { MapPin, User as UserIcon, ExternalLink, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useIsMobile } from '@/hooks/use-mobile';

// Screen rect of the date number that was clicked — the popup morphs out of
// this. `radius` seeds the starting border-radius so a round "today" badge
// grows from a circle.
export type OriginRect = { left: number; top: number; width: number; height: number; radius: number };

// A structural subset of SchedulePage's EnrichedSession — only what the day
// popup needs to render a session in the list.
type DaySession = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  booked: number;
  locationName: string | null;
  teacherName: string | null;
  studio: string | null;
  fromWix: boolean;
  isCourse: boolean;
  bookingsPaused: boolean;
};

// Trimmed shape of the provider_session_roster RPC rows (see BookingsPage).
type RosterRow = {
  booking_id: string;
  status: string;
  payment_status: string | null;
  paid_via: 'credit' | 'token' | 'cash' | 'refunded' | 'free' | 'none' | null;
  child_name: string;
  child_age_months: number | null;
  parent_name: string | null;
  is_manual: boolean;
  has_medical: boolean;
  attendance_status: 'present' | 'absent' | 'late' | null;
  waitlist_position: number | null;
};

const sgTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' });

const ageLabel = (m: number | null) => (m == null ? '' : m < 24 ? `${m} mo` : `${Math.round(m / 12)} yr`);

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

type PayKind = 'paid' | 'credit' | 'token' | 'refunded' | 'free' | 'unpaid';
const payKind = (r: RosterRow): PayKind => {
  switch (r.paid_via) {
    case 'cash': return 'paid';
    case 'credit': return 'credit';
    case 'token': return 'token';
    case 'refunded': return 'refunded';
    case 'free': return 'free';
    case 'none': return 'unpaid';
    default: return r.payment_status === 'paid' ? 'paid' : 'unpaid';
  }
};
const PAY_STYLE: Record<PayKind, { label: string; cls: string }> = {
  paid: { label: 'Paid', cls: 'bg-green-100 text-green-700' },
  credit: { label: 'Credit', cls: 'bg-indigo-100 text-indigo-700' },
  token: { label: 'Make-up', cls: 'bg-amber-100 text-amber-800' },
  refunded: { label: 'Refunded', cls: 'bg-gray-100 text-gray-600' },
  free: { label: 'Free', cls: 'bg-gray-100 text-gray-500' },
  unpaid: { label: 'Unpaid', cls: 'bg-gray-100 text-gray-600' },
};

function SessionBadges({ s }: { s: DaySession }) {
  return (
    <>
      {s.fromWix && <span className="rounded-full bg-purple-100 px-1.5 text-[10px] font-semibold text-purple-700">Wix</span>}
      {s.isCourse && <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700">Course</span>}
      {s.bookingsPaused && <span className="rounded-full bg-amber-200 px-1.5 text-[10px] font-semibold text-amber-800">Paused</span>}
    </>
  );
}

// The roster for one session — a table on desktop, stacked rows on mobile.
// Shared by both the master–detail (desktop) and accordion (mobile) layouts.
function RosterBody({
  session, roster, compact, onOpen,
}: {
  session: DaySession;
  roster: RosterRow[] | undefined;
  compact: boolean;
  onOpen: () => void;
}) {
  const booked = (roster ?? []).filter((r) => r.status === 'confirmed' || r.status === 'completed' || r.status === 'pending');
  const waitlisted = (roster ?? []).filter((r) => r.status === 'waitlisted');

  return (
    <div>
      {!compact && <div className="text-sm font-semibold text-gray-900">{session.title}</div>}
      <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500', !compact && 'mt-0.5')}>
        <span>{sgTime(session.starts_at)} – {sgTime(session.ends_at)}</span>
        {session.locationName && (
          <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{session.locationName}</span>
        )}
        {(session.teacherName || session.studio) && (
          <span className="flex items-center gap-1">
            <UserIcon className="h-3 w-3" />
            {[session.teacherName, session.studio].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>

      {roster === undefined ? (
        <div className="mt-4 text-sm text-gray-400">Loading bookings…</div>
      ) : booked.length === 0 && waitlisted.length === 0 ? (
        <div className="mt-4 text-sm text-gray-400">No bookings yet.</div>
      ) : compact ? (
        <div className="mt-3">
          {booked.map((r) => {
            const pk = PAY_STYLE[payKind(r)];
            return (
              <div key={r.booking_id} className="flex items-center gap-2 border-t border-gray-100 py-2 first:border-t-0">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-pink-100 text-[10px] font-bold text-pink-700">
                  {initials(r.child_name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 text-xs font-medium text-gray-900">
                    <span className="truncate">{r.child_name}</span>
                    {r.has_medical && <span title="Medical note on file" className="text-amber-500">•</span>}
                  </div>
                  <div className="truncate text-[11px] text-gray-500">
                    {(r.is_manual ? 'Manual entry' : r.parent_name ?? '—')}
                    {ageLabel(r.child_age_months) ? ` · ${ageLabel(r.child_age_months)}` : ''}
                  </div>
                </div>
                <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold', pk.cls)}>{pk.label}</span>
                {r.attendance_status === 'present' && <span className="shrink-0 text-[11px] text-green-600">Present</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-3">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-gray-400">
                <th className="pb-1.5 font-normal">Child</th>
                <th className="pb-1.5 font-normal">Parent</th>
                <th className="pb-1.5 font-normal">Age</th>
                <th className="pb-1.5 font-normal">Payment</th>
                <th className="pb-1.5 text-right font-normal">Attendance</th>
              </tr>
            </thead>
            <tbody>
              {booked.map((r) => {
                const pk = PAY_STYLE[payKind(r)];
                return (
                  <tr key={r.booking_id} className="border-t border-gray-100">
                    <td className="py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-pink-100 text-[10px] font-bold text-pink-700">
                          {initials(r.child_name)}
                        </span>
                        <span className="text-gray-900">{r.child_name}</span>
                        {r.has_medical && <span title="Medical note on file" className="text-amber-500">•</span>}
                      </div>
                    </td>
                    <td className="py-1.5 text-gray-600">{r.is_manual ? 'Manual entry' : r.parent_name ?? '—'}</td>
                    <td className="py-1.5 text-gray-600">{ageLabel(r.child_age_months) || '—'}</td>
                    <td className="py-1.5">
                      <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold', pk.cls)}>{pk.label}</span>
                    </td>
                    <td className="py-1.5 text-right">
                      {r.attendance_status === 'present' ? (
                        <span className="text-green-600">Present</span>
                      ) : r.attendance_status === 'absent' ? (
                        <span className="text-gray-400">Absent</span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {roster !== undefined && waitlisted.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-xs font-medium text-gray-500">Waitlist ({waitlisted.length})</div>
          <div className="space-y-1">
            {waitlisted.map((r, i) => (
              <div key={r.booking_id} className="flex items-center gap-2 text-xs text-gray-600">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-gray-100 text-[10px] font-medium text-gray-600">
                  {r.waitlist_position ?? i + 1}
                </span>
                <span className="text-gray-900">{r.child_name}</span>
                <span className="text-gray-400">{ageLabel(r.child_age_months)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={onOpen}
        className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-[#FA4D8D] hover:underline"
      >
        Open full booking page <ExternalLink className="h-3 w-3" />
      </button>
    </div>
  );
}

const MORPH_MS = 340;
const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function DayDetailDialog({
  date,
  origin,
  sessions,
  onClose,
  onOpenSession,
}: {
  // null keeps the dialog closed; a Date opens it for that day.
  date: Date | null;
  // Where the click came from — the popup grows out of this rect.
  origin: OriginRect | null;
  // That day's sessions, already time-sorted (SchedulePage's sessionsFor).
  sessions: DaySession[];
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const isMobile = useIsMobile();
  const [activeId, setActiveId] = useState<string | null>(null); // desktop: selected row
  const [openId, setOpenId] = useState<string | null>(null);     // mobile: expanded row
  // Rosters are fetched lazily on first open and cached for the life of the
  // dialog — moving between sessions is then instant. Cleared on day change.
  const [rosters, setRosters] = useState<Record<string, RosterRow[]>>({});
  const reqSeq = useRef(0);

  // ---- container-morph open animation (FLIP) ----
  const panelRef = useRef<HTMLDivElement>(null);
  const [morph, setMorph] = useState<{ transform: string; borderRadius: string; transition: string }>();
  const [bodyShown, setBodyShown] = useState(false);

  useLayoutEffect(() => {
    if (!date) { setMorph(undefined); setBodyShown(false); return; }
    const el = panelRef.current;
    if (!el || !origin || prefersReducedMotion()) {
      setMorph({ transform: 'translate(-50%, -50%)', borderRadius: '12px', transition: 'none' });
      setBodyShown(true);
      return;
    }
    const F = el.getBoundingClientRect();
    const sx = Math.max(origin.width / F.width, 0.04);
    const sy = Math.max(origin.height / F.height, 0.04);
    const tx = origin.left + origin.width / 2 - (F.left + F.width / 2);
    const ty = origin.top + origin.height / 2 - (F.top + F.height / 2);
    // First frame: sit exactly on the clicked badge.
    setMorph({
      transform: `translate(-50%, -50%) translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`,
      borderRadius: `${origin.radius}px`,
      transition: 'none',
    });
    setBodyShown(false);
    // Next frame: release to the resting position and fade the contents in.
    const r1 = requestAnimationFrame(() => {
      const r2 = requestAnimationFrame(() => {
        setMorph({
          transform: 'translate(-50%, -50%)',
          borderRadius: '12px',
          transition: `transform ${MORPH_MS}ms cubic-bezier(.3,.7,.2,1), border-radius ${MORPH_MS}ms ease`,
        });
        setBodyShown(true);
      });
      return () => cancelAnimationFrame(r2);
    });
    return () => cancelAnimationFrame(r1);
  }, [date, origin]);

  useEffect(() => {
    if (!date) return;
    setRosters({});
    setActiveId(sessions[0]?.id ?? null);
    setOpenId(sessions[0]?.id ?? null);
    // Re-seed only when the day itself changes — `sessions` gets a fresh array
    // identity on every parent render and must not retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // The one session whose roster is on screen right now.
  const wantId = isMobile ? openId : activeId;

  useEffect(() => {
    if (!wantId || rosters[wantId]) return;
    const seq = ++reqSeq.current;
    (async () => {
      const { data } = await supabase.rpc('provider_session_roster', { p_session_id: wantId });
      if (seq !== reqSeq.current) return; // a newer selection superseded this one
      setRosters((m) => ({ ...m, [wantId]: (data as RosterRow[]) ?? [] }));
    })();
  }, [wantId, rosters]);

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);
  const totalBooked = sessions.reduce((n, s) => n + s.booked, 0);
  const summary = sessions.length === 0
    ? 'No sessions'
    : `${sessions.length} session${sessions.length > 1 ? 's' : ''} · ${totalBooked} booked`;

  return (
    <DialogPrimitive.Root open={!!date} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          ref={panelRef}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => e.preventDefault()}
          style={morph}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-full max-w-[calc(100%-2rem)] flex-col overflow-hidden border bg-background shadow-lg outline-none will-change-transform sm:max-w-3xl lg:max-w-4xl',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-150'
          )}
        >
          {date && (
            <div
              className={cn('flex min-h-0 flex-1 flex-col transition-opacity', bodyShown ? 'opacity-100' : 'opacity-0')}
              style={{ transitionDuration: '160ms', transitionDelay: bodyShown ? '120ms' : '0ms' }}
            >
              <div className="shrink-0 border-b border-gray-200 px-5 py-4">
                <DialogPrimitive.Title asChild>
                  <h2 className="text-base font-semibold text-gray-900">{format(date, 'EEEE d MMMM')}</h2>
                </DialogPrimitive.Title>
                <p className="mt-0.5 text-xs text-gray-500">{summary}</p>
              </div>

              {sessions.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-gray-400">Nothing scheduled for this day.</div>
              ) : isMobile ? (
                // Design A — one column, each session expands its roster inline.
                <div className="min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto">
                  {sessions.map((s) => {
                    const full = s.capacity != null && s.booked >= s.capacity;
                    const expanded = openId === s.id;
                    return (
                      <div key={s.id}>
                        <button
                          onClick={() => setOpenId(expanded ? null : s.id)}
                          aria-expanded={expanded}
                          className="flex w-full items-start justify-between gap-3 px-5 py-3 text-left"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-gray-900">{sgTime(s.starts_at)} – {sgTime(s.ends_at)}</div>
                            <div className="truncate text-sm text-gray-800">{s.title}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                              <span className={cn('text-[11px]', full ? 'font-medium text-[#FA4D8D]' : 'text-gray-500')}>
                                {s.booked}{s.capacity != null ? `/${s.capacity}` : ''}{full ? ' · Full' : ''}
                              </span>
                              <SessionBadges s={s} />
                            </div>
                          </div>
                          <ChevronDown className={cn('mt-1 h-4 w-4 shrink-0 text-gray-400 transition-transform', expanded && 'rotate-180')} />
                        </button>
                        {expanded && (
                          <div className="px-5 pb-4">
                            <RosterBody session={s} roster={rosters[s.id]} compact onOpen={() => onOpenSession(s.id)} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                // Design B — sessions left, selected session's roster right.
                <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,240px)_minmax(0,1fr)] overflow-hidden">
                  <div className="overflow-y-auto border-r border-gray-200 p-2">
                    {sessions.map((s) => {
                      const full = s.capacity != null && s.booked >= s.capacity;
                      return (
                        <button
                          key={s.id}
                          onClick={() => setActiveId(s.id)}
                          className={cn(
                            'mb-1 w-full rounded-lg border px-3 py-2 text-left transition-colors',
                            s.id === activeId ? 'border-[#FA4D8D] bg-pink-50' : 'border-transparent hover:bg-gray-50'
                          )}
                        >
                          <div className="text-xs font-semibold text-gray-900">{sgTime(s.starts_at)}</div>
                          <div className="truncate text-xs text-gray-700">{s.title}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <span className={cn('text-[11px]', full ? 'font-medium text-[#FA4D8D]' : 'text-gray-500')}>
                              {s.booked}{s.capacity != null ? `/${s.capacity}` : ''}{full ? ' · Full' : ''}
                            </span>
                            <SessionBadges s={s} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="overflow-y-auto p-4">
                    {active && (
                      <RosterBody
                        session={active}
                        roster={rosters[active.id]}
                        compact={false}
                        onOpen={() => onOpenSession(active.id)}
                      />
                    )}
                  </div>
                </div>
              )}

              <DialogPrimitive.Close
                aria-label="Close"
                className="absolute right-4 top-4 rounded-xs text-gray-500 opacity-70 transition-opacity hover:opacity-100 focus:outline-none"
              >
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
