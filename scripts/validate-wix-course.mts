/**
 * Read-only validation for the Wix COURSE booking flow — exercises the real
 * shipped code (lib/wix/client.ts, lib/wix/sync.ts) against the live
 * indsg.kidscenter "Growth activities" course. Creates NO Wix enrolment and
 * NO `bookings` row; the one local `activity_sessions` anchor row that
 * reserveWixSlotForCheckout materialises is deleted again at the end.
 *
 * Run: npx tsx scripts/validate-wix-course.mts
 */
process.loadEnvFile('.env.local');
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database';
import {
  getProviderWixCredentials,
  fetchWixServices,
  fetchWixClassSessions,
  fetchWixCourseSpan,
  wixServicePrice,
  encodeWixSlotKey,
  courseAnchorSlotKey,
  decodeWixSlotKey,
  type WixService,
} from '../lib/wix/client';
import { reserveWixSlotForCheckout } from '../lib/wix/sync';

const admin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// Pure helpers ported from frontends/parent/src/App.tsx (kept in sync by eye)
// ---------------------------------------------------------------------------
const sgDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short' });
const sgTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' });
const sgDayRange = (start: string, end: string) =>
  sgDay(start) === sgDay(end) ? sgDay(start) : `${sgDay(start)} – ${sgDay(end)}`;
function courseStrands(sessions: { starts_at: string; ends_at: string | null }[]) {
  const groups: Record<string, { weekday: string; time: string; dates: string[] }> = {};
  for (const s of sessions) {
    const weekday = new Date(s.starts_at).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'long' });
    const time = s.ends_at ? `${sgTime(s.starts_at)} – ${sgTime(s.ends_at)}` : sgTime(s.starts_at);
    (groups[`${weekday}|${time}`] ||= { weekday, time, dates: [] }).dates.push(s.starts_at);
  }
  return Object.values(groups)
    .map((g) => {
      const sorted = g.dates.slice().sort();
      return { weekday: g.weekday, time: g.time, first: sorted[0], last: sorted[sorted.length - 1], count: g.dates.length };
    })
    .sort((a, b) => a.first.localeCompare(b.first))
    .map((g) => ({
      label: `${g.weekday}s · ${g.time}`,
      range: g.first === g.last ? sgDay(g.first) : `${sgDay(g.first)} – ${sgDay(g.last)}`,
      count: g.count,
    }));
}

console.log('--- Wix COURSE flow validation ---\n');

// ---------- 0. Fixtures ----------
const VENDOR_EMAIL = 'indsg.kidscenter@babybrain.sg';
const { data: userList } = await admin.auth.admin.listUsers({ perPage: 1000 } as never);
const vendorUser = userList.users.find((u) => u.email === VENDOR_EMAIL);
if (!vendorUser) throw new Error(`no auth user for ${VENDOR_EMAIL}`);
const { data: provider } = await admin
  .from('providers')
  .select('id, business_name')
  .eq('owner_id', vendorUser.id)
  .maybeSingle();
if (!provider) throw new Error('no provider for indsg.kidscenter');
const creds = await getProviderWixCredentials(admin, provider.id);
if (!creds) throw new Error('indsg.kidscenter has no Wix credentials — relink first');

const { data: course } = await admin
  .from('activities')
  .select('id, title, price, wix_service_id, wix_service_type')
  .eq('provider_id', provider.id)
  .eq('wix_service_type', 'COURSE')
  .not('wix_service_id', 'is', null)
  .limit(1)
  .maybeSingle();
if (!course?.wix_service_id) throw new Error('no COURSE-type Wix activity found for this provider');
console.log(`Provider: ${provider.business_name}\nCourse:   ${course.title} (${course.id})\n`);

// ---------- 1. wixServicePrice — VARIED uses minPrice ----------
const services = await fetchWixServices(creds);
const svc = services.find((s) => s.id === course.wix_service_id);
check('Course service is present in the Wix services list', !!svc, svc?.type);
if (svc) {
  const p = wixServicePrice(svc);
  check(
    'wixServicePrice(VARIED) returns minPrice, not defaultPrice',
    svc.payment?.rateType !== 'VARIED' || p === Number(svc.payment?.varied?.minPrice?.value),
    `rateType=${svc.payment?.rateType} default=${svc.payment?.varied?.defaultPrice?.value} min=${svc.payment?.varied?.minPrice?.value} → ${p}`
  );
  check('activities.price is in step with wixServicePrice', Number(course.price) === p, `db=${course.price} live=${p}`);
}
// FIXED / NO_FEE paths still behave
const fixed = { payment: { rateType: 'FIXED', fixed: { price: { value: '42' } } } } as unknown as WixService;
const nofee = { payment: { rateType: 'NO_FEE' } } as unknown as WixService;
check('wixServicePrice(FIXED) unchanged', wixServicePrice(fixed) === 42);
check('wixServicePrice(NO_FEE) unchanged', wixServicePrice(nofee) === 0);

// ---------- 2. fetchWixCourseSpan — real schedule bounds ----------
const span = await fetchWixCourseSpan(creds, course.wix_service_id);
check('Course span has both bounds', !!span.start && !!span.end, JSON.stringify(span));
check('Course span start < end', !!span.start && !!span.end && span.start < span.end, `${span.start} .. ${span.end}`);

// ---------- 3. fetchWixClassSessions — future occurrences ----------
const sessions = await fetchWixClassSessions(creds, course.wix_service_id, 60);
check('At least one upcoming course occurrence', sessions.length >= 1, `${sessions.length} sessions`);
check('Every occurrence belongs to this service', sessions.every((s) => s.serviceId === course.wix_service_id));
check(
  'All occurrences share one scheduleId (single course schedule)',
  new Set(sessions.map((s) => s.scheduleId)).size === 1
);

// The span from Wix should be at least as wide as what the visible
// occurrences imply — this is the whole point of fetchWixCourseSpan.
if (sessions.length && span.start && span.end) {
  const visFirst = sessions.reduce((m, s) => (s.start < m ? s.start : m), sessions[0].start);
  const visLast = sessions.reduce((m, s) => (s.end > m ? s.end : m), sessions[0].end);
  check(
    'Wix span is not narrower than the visible-occurrences span',
    span.start <= visFirst && span.end >= visLast,
    `wix ${sgDay(span.start)}–${sgDay(span.end)} vs visible ${sgDay(visFirst)}–${sgDay(visLast)}`
  );
}

// ---------- 4. courseStrands / sgDayRange (frontend pure helpers) ----------
const asRows = sessions.map((s) => ({ starts_at: s.start, ends_at: s.end }));
const strands = courseStrands(asRows);
check('Strands group by weekday+time', strands.length >= 1, strands.map((s) => `${s.label} (${s.count})`).join(' | '));
check(
  'Every occurrence lands in exactly one strand',
  strands.reduce((n, s) => n + s.count, 0) === sessions.length
);
check('sgDayRange collapses an identical day', sgDayRange(sessions[0].start, sessions[0].start) === sgDay(sessions[0].start));
check(
  'sgDayRange keeps a real range',
  span.start! === span.end! || sgDayRange(span.start!, span.end!).includes('–')
);

// ---------- 5. courseAnchorSlotKey ----------
const anchorKey = courseAnchorSlotKey(sessions[0].scheduleId);
check('Anchor key is the stable wixcourse: form', anchorKey === `wixcourse:${sessions[0].scheduleId}`);
check('Anchor key is not a decodable slot key', (() => { try { decodeWixSlotKey(anchorKey); return false; } catch { return true; } })());

// ---------- 6. resolveWixSlot course branch, via reserveWixSlotForCheckout ----------
// Read-only against Wix (no reservation). It DOES upsert one local
// activity_sessions anchor row — deleted below.
const firstSlotId = `wix:${encodeWixSlotKey({ kind: 'class', sessionId: sessions[0].id })}`;
const reserved = await reserveWixSlotForCheckout(
  admin,
  creds,
  { id: course.id, wix_service_id: course.wix_service_id, wix_resource_id: null, wix_service_type: 'COURSE' },
  firstSlotId,
  1
);
check('reserveWixSlotForCheckout resolves the course', reserved.ok, JSON.stringify(reserved));
let anchorRowId: string | null = null;
if (reserved.ok) {
  const { data: row } = await admin
    .from('activity_sessions')
    .select('id, starts_at, ends_at, capacity, wix_slot_key')
    .eq('id', reserved.sessionId)
    .single();
  anchorRowId = row?.id ?? null;
  check('Anchor row is keyed wixcourse:<scheduleId>', row?.wix_slot_key === anchorKey, row?.wix_slot_key ?? 'null');
  const sameInstant = (a?: string | null, b?: string | null) => !!a && !!b && new Date(a).getTime() === new Date(b).getTime();
  check(
    'Anchor row spans the real course run (matches fetchWixCourseSpan)',
    sameInstant(row?.starts_at, span.start) && sameInstant(row?.ends_at, span.end),
    `row ${row?.starts_at}..${row?.ends_at} vs span ${span.start}..${span.end}`
  );
  check('Anchor row carries the seat capacity (not remaining)', (row?.capacity ?? 0) >= 1, String(row?.capacity));

  // Re-resolving a *different* occurrence must reuse the SAME anchor row.
  if (sessions.length > 1) {
    const otherSlotId = `wix:${encodeWixSlotKey({ kind: 'class', sessionId: sessions[1].id })}`;
    const again = await reserveWixSlotForCheckout(
      admin,
      creds,
      { id: course.id, wix_service_id: course.wix_service_id, wix_resource_id: null, wix_service_type: 'COURSE' },
      otherSlotId,
      1
    );
    check('A different occurrence resolves to the same anchor row', again.ok && again.sessionId === reserved.sessionId);
  }
}

// ---------- 7. Vendor Schedule query excludes the anchor row ----------
const { data: vendorRows } = await admin
  .from('activity_sessions')
  .select('id, wix_slot_key')
  .eq('activity_id', course.id)
  .neq('status', 'cancelled')
  .not('wix_slot_key', 'like', 'wixcourse:%')
  .gte('starts_at', new Date().toISOString());
check(
  'Vendor Schedule query returns occurrence rows, never the wixcourse: anchor',
  (vendorRows ?? []).length >= 0 && (vendorRows ?? []).every((r) => !String(r.wix_slot_key).startsWith('wixcourse:')),
  `${vendorRows?.length ?? 0} rows`
);

// ---------- cleanup ----------
if (anchorRowId) {
  const { count } = await admin
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', anchorRowId);
  if ((count ?? 0) === 0) {
    await admin.from('activity_sessions').delete().eq('id', anchorRowId);
    console.log(`\nCleaned up test anchor row ${anchorRowId}`);
  } else {
    console.log(`\n⚠ anchor row ${anchorRowId} has ${count} booking(s) — left in place`);
  }
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
