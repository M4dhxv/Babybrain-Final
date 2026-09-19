/**
 * Deterministic checks (mocked Wix, fake DB client — no network, no database)
 * for the "vendor cancelled a class on Wix" detection in lib/wix/client.ts and
 * lib/wix/sync.ts. The database half is proven by validate-wix-session-cancel.mjs.
 *
 * Run: npx tsx scripts/validate-wix-dropped-session.mts
 */
import {
  fetchWixSessionLiveness,
  fetchWixClassSessionList,
  encodeWixSlotKey,
} from '../lib/wix/client';
import { cancelWixDroppedSession } from '../lib/wix/sync';

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`);
  if (ok) pass++; else fail++;
};

const creds = { accessToken: 'tok', siteId: 'site' };
const realFetch = globalThis.fetch;
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const mockFetch = (h: Handler) => {
  globalThis.fetch = (async (u: any, i?: any) => h(String(u), i)) as typeof fetch;
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// ---- fetchWixSessionLiveness ----------------------------------------------
mockFetch(() => json({ session: { status: 'CONFIRMED' } }));
check("200 CONFIRMED -> 'active'", (await fetchWixSessionLiveness(creds, 'x')) === 'active');
mockFetch(() => json({ session: { status: 'CANCELLED' } }));
check("200 CANCELLED -> 'cancelled'", (await fetchWixSessionLiveness(creds, 'x')) === 'cancelled');
mockFetch(() => json({ message: 'nope' }, 404));
check("404 -> 'cancelled' (Wix no longer has it)", (await fetchWixSessionLiveness(creds, 'x')) === 'cancelled');
mockFetch(() => json({}, 500));
check("500 -> 'unknown' (never treated as cancelled)", (await fetchWixSessionLiveness(creds, 'x')) === 'unknown');
mockFetch(() => json({ message: 'cannot be decoded' }, 400));
check("400 -> 'unknown'", (await fetchWixSessionLiveness(creds, 'x')) === 'unknown');
mockFetch(() => json({}, 401));
check("401 (revoked key) -> 'unknown', not cancelled", (await fetchWixSessionLiveness(creds, 'x')) === 'unknown');
mockFetch(() => json({ session: { status: 'PENDING' } }));
check("unfamiliar status -> 'unknown'", (await fetchWixSessionLiveness(creds, 'x')) === 'unknown');
mockFetch(() => { throw new Error('network down'); });
check("network error -> 'unknown'", (await fetchWixSessionLiveness(creds, 'x')) === 'unknown');

// ---- fetchWixClassSessionList paging ---------------------------------------
const raw = (id: string, owner = 'svc') => ({
  id, scheduleId: 's', scheduleOwnerId: owner, eventId: 'e', status: 'CONFIRMED', capacity: 5, remainingCapacity: 5,
  start: { timestamp: '2030-01-01T00:00:00Z' }, end: { timestamp: '2030-01-01T01:00:00Z' },
});
let calls = 0;
mockFetch((_u, init) => {
  calls++;
  const q = JSON.parse(String(init?.body)).query.cursorPaging;
  if (!q.cursor) return json({ sessions: [raw('a'), raw('other', 'other-svc')], pagingMetadata: { hasNext: true, cursors: { next: 'c1' } } });
  if (q.cursor === 'c1') return json({ sessions: [raw('b')], pagingMetadata: { hasNext: false, cursors: {} } });
  return json({}, 500);
});
let list = await fetchWixClassSessionList(creds, 'svc', 14);
check('reads every page and flags the list complete', list.complete && calls === 2 && list.sessions.map((s) => s.id).join() === 'a,b', `${calls} calls, ${list.sessions.map((s) => s.id)}`);

mockFetch(() => json({ sessions: [raw('a')], pagingMetadata: { hasNext: true, cursors: {} } }));
list = await fetchWixClassSessionList(creds, 'svc', 14);
check('hasNext but no cursor -> NOT complete', !list.complete);

mockFetch(() => json({ sessions: [raw('a')], pagingMetadata: { hasNext: true, cursors: { next: 'again' } } }));
list = await fetchWixClassSessionList(creds, 'svc', 14);
check('a runaway cursor stops at the page cap and is NOT complete', !list.complete);

// ---- cancelWixDroppedSession decision rules -------------------------------
const rpcCalls: string[] = [];
const admin: any = { rpc: async (_n: string, a: { p_session_id: string }) => { rpcCalls.push(a.p_session_id); return { data: 3, error: null }; } };
const inDays = (d: number) => new Date(Date.now() + d * 864e5).toISOString();
const classKey = encodeWixSlotKey({ kind: 'class', sessionId: 'S1' });
const apptKey = encodeWixSlotKey({ kind: 'appointment', s: 'a', e: 'b', loc: '' });
let asked = 0;
const wixSays = (status: number, body: unknown = {}) => mockFetch(() => { asked++; return json(body, status); });
const run = async (over: Partial<{ starts: string; key: string; complete: boolean }> = {}) => {
  rpcCalls.length = 0; asked = 0;
  await cancelWixDroppedSession(admin, { id: 'sess-1', wix_slot_key: over.key ?? classKey, starts_at: over.starts ?? inDays(3) }, { creds, listComplete: over.complete ?? true });
};

wixSays(404);
await run();
check('future class, list complete, Wix says gone -> cancelled via RPC', rpcCalls.join() === 'sess-1');

wixSays(200, { session: { status: 'CONFIRMED' } });
await run();
check('Wix still says CONFIRMED (list was just missing it) -> NOT cancelled', rpcCalls.length === 0 && asked === 1);

wixSays(500);
await run();
check('Wix error/inconclusive -> NOT cancelled (retried next sync)', rpcCalls.length === 0);

wixSays(404);
await run({ complete: false });
check('incomplete list -> NOT cancelled, and Wix is not even asked', rpcCalls.length === 0 && asked === 0);

wixSays(404);
await run({ starts: inDays(-1) });
check('class already started/past -> NOT cancelled', rpcCalls.length === 0 && asked === 0);

wixSays(404);
await run({ key: apptKey });
check('appointment slot key -> NOT cancelled', rpcCalls.length === 0 && asked === 0);

wixSays(404);
await run({ key: 'wixcourse:abc' });
check('course anchor key (not decodable) -> NOT cancelled, no throw', rpcCalls.length === 0 && asked === 0);

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
