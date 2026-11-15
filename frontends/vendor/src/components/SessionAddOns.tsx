import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { supabase } from '@/lib/supabase';

/**
 * The extra people coming to one session (migration 00273): free companions that come with a ticket
 * and additional people parents paid for. They are headcount only: they never appear as roster seats
 * and never use class capacity, so the vendor needs them somewhere else to plan the room. Renders
 * nothing when there are none.
 *
 * `whoByBooking` maps a roster booking id to a label ("Ava (parent: Sam)") so each line says whose
 * ticket it hangs off.
 */
type Row = {
  id: string;
  booking_id: string;
  name: string;
  quantity: number;
  person_names: string[];
  person_ages: Array<number | null>;
  kind: 'companion' | 'additional' | null;
};

type Loose = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: unknown) => { in: (c: string, v: string[]) => PromiseLike<{ data: unknown }> };
    };
  };
};

export function SessionAddOns({ sessionId, whoByBooking, seatIds }: { sessionId: string; whoByBooking: Map<string, string>; seatIds: string[] }) {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!sessionId || seatIds.length === 0) return;
    let cancelled = false;
    // Scoped to this roster's own bookings, which also leaves out anything on a cancelled booking.
    (supabase as unknown as Loose)
      .from('booking_addons')
      .select('id, booking_id, name, quantity, person_names, person_ages, kind')
      .eq('payment_status', 'paid')
      .in('booking_id', seatIds)
      .then(({ data }) => { if (!cancelled) setRows((data ?? []) as Row[]); });
    return () => { cancelled = true; };
    // seatIds identity changes every render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, seatIds.join(',')]);

  // Rows from a previous session are ignored the moment the roster changes.
  const shown = sessionId && seatIds.length > 0 ? rows.filter((r) => seatIds.includes(r.booking_id)) : [];
  if (shown.length === 0) return null;
  const total = shown.reduce((n, r) => n + r.quantity, 0);
  const companions = shown.filter((r) => r.kind === 'companion').reduce((n, r) => n + r.quantity, 0);
  const additional = total - companions;
  const byName = new Map<string, number>();
  for (const r of shown) byName.set(r.name, (byName.get(r.name) ?? 0) + r.quantity);

  return (
    <div className="mb-4 rounded-xl border border-purple-200 bg-purple-50/60 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-purple-900">
        <Users className="h-4 w-4" />
        {total} extra {total === 1 ? 'person' : 'people'} coming
        <span className="font-normal text-purple-800">
          ({[...byName.entries()].map(([n, q]) => `${q} ${n}`).join(', ')})
        </span>
      </div>
      <p className="mt-0.5 text-xs text-purple-800/80">
        {companions > 0 && `${companions} free companion${companions === 1 ? '' : 's'}`}
        {companions > 0 && additional > 0 && ' · '}
        {additional > 0 && `${additional} paid additional`}
        {' · Not counted in class places.'}
      </p>
      <ul className="mt-2 space-y-1 text-xs text-gray-700">
        {shown.map((r) => {
          const people = Array.from({ length: r.quantity }, (_, i) => ({
            name: r.person_names?.[i] ?? '',
            age: r.person_ages?.[i] ?? null,
          })).filter((p) => p.name || p.age != null);
          return (
            <li key={r.id}>
              <span className="font-medium">{r.quantity} {r.name}</span>
              {people.length > 0 && (
                <>
                  {' — '}
                  {people.map((p, i) => (
                    <span key={i}>
                      {i > 0 && ', '}
                      {[p.name, p.age != null ? `age ${p.age}` : ''].filter(Boolean).join(' ')}
                    </span>
                  ))}
                </>
              )}
              {whoByBooking.get(r.booking_id) && <span className="text-gray-500"> · with {whoByBooking.get(r.booking_id)}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
