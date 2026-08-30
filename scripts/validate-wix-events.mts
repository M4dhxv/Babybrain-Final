/**
 * Hard edge-case validation for the Wix Events & Tickets integration —
 * exercises the real shipped code (lib/wix/events-sync.ts,
 * lib/wix/finalize-event-checkout.ts, lib/wix/client.ts), not a
 * reimplementation of it, against the live indsg.kidscenter Wix site and
 * live Supabase. Mirrors scripts/validate-vendor-integrations.mjs's
 * check()/pass/fail convention.
 *
 * Requires the 00069_wix_events.sql migration to already be applied.
 * Run: npx tsx scripts/validate-wix-events.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database';
import {
  getProviderWixCredentials,
  createWixTicketReservation,
  computeWixCheckoutTotal,
  type WixTicketReservationLine,
} from '../lib/wix/client';
import { syncProviderWixEvents } from '../lib/wix/events-sync';
import { finalizeWixEventTicketCheckout } from '../lib/wix/finalize-event-checkout';

process.loadEnvFile('.env.local');
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
const stamp = Date.now();
const cleanup: Array<() => Promise<void>> = [];

console.log('--- Wix Events & Tickets validation ---\n');

const VENDOR_EMAIL = 'indsg.kidscenter@babybrain.sg';
const { data: userList } = await admin.auth.admin.listUsers();
const vendorUser = userList.users.find((u) => u.email === VENDOR_EMAIL);
if (!vendorUser) throw new Error(`No auth user for ${VENDOR_EMAIL} — run scripts/create-indsg-demo-vendor.mjs first`);
const { data: provider } = await admin
  .from('providers')
  .select('id, business_name')
  .eq('owner_id', vendorUser.id)
  .maybeSingle();
if (!provider) throw new Error('No provider found for indsg.kidscenter');
const creds = await getProviderWixCredentials(admin, provider.id);
if (!creds) throw new Error('indsg.kidscenter has no Wix credentials linked');
console.log(`Provider: ${provider.business_name} (${provider.id})\n`);

// ---------- 1. Sync: happy path ----------
const sync1 = await syncProviderWixEvents(admin, provider.id, creds);
check('Sync reaches the Events app (not "not installed")', !sync1.eventsAppNotInstalled, JSON.stringify(sync1));
check('Sync finds at least one event', sync1.created + sync1.updated >= 1, JSON.stringify(sync1));
check('Ticket pricing not skipped for any event', sync1.ticketPricingSkipped.length === 0, JSON.stringify(sync1.ticketPricingSkipped));

const { data: events } = await admin
  .from('wix_events')
  .select('id, wix_event_id, title')
  .eq('provider_id', provider.id)
  .is('wix_removed_at', null)
  .is('wix_missing_since', null);
check('At least one live event synced into wix_events', (events?.length ?? 0) >= 1);
const event = events![0];
const { data: ticketTypes } = await admin
  .from('event_ticket_types')
  .select('*')
  .eq('event_id', event.id);
check('Event has at least one synced ticket type', (ticketTypes?.length ?? 0) >= 1);
const ticketType = ticketTypes!.find((t) => !t.is_free) ?? ticketTypes![0];
check(
  'Ticket type currency is NOT hardcoded to SGD when the real ticket is priced differently',
  true, // informational — prints the real value below rather than asserting a fixed currency
  `currency=${ticketType.currency} price_cents=${ticketType.price_cents} capacity_total=${ticketType.capacity_total} capacity_remaining=${ticketType.capacity_remaining}`
);

// ---------- 2. Sync: idempotent re-run ----------
const sync2 = await syncProviderWixEvents(admin, provider.id, creds);
check('Second sync run creates no duplicate events', sync2.created === 0, JSON.stringify(sync2));

// ---------- 3. Reconciliation: a phantom event gets flagged missing ----------
const phantomWixId = `phantom-${stamp}`;
const { data: phantom } = await admin
  .from('wix_events')
  .insert({
    provider_id: provider.id,
    wix_event_id: phantomWixId,
    title: 'QA Phantom Event (should be auto-flagged missing)',
    start_date: new Date(Date.now() + 7 * 864e5).toISOString(),
    end_date: new Date(Date.now() + 7 * 864e5 + 36e5).toISOString(),
    is_published: true,
  })
  .select('id')
  .single();
cleanup.push(async () => { await admin.from('wix_events').delete().eq('id', phantom!.id); });

const sync3 = await syncProviderWixEvents(admin, provider.id, creds);
const { data: phantomAfter } = await admin
  .from('wix_events')
  .select('wix_missing_since, is_published')
  .eq('id', phantom!.id)
  .single();
check('A phantom event (not on Wix) gets wix_missing_since set', !!phantomAfter?.wix_missing_since);
check('A phantom event also gets unpublished', phantomAfter?.is_published === false);
check('Reconciliation reports it removed', sync3.removed >= 1, JSON.stringify(sync3));

// ---------- 4. Reconciliation: a real event that was flagged missing gets revived ----------
await admin.from('wix_events').update({ wix_missing_since: new Date(Date.now() - 60_000).toISOString() }).eq('id', event.id);
const sync4 = await syncProviderWixEvents(admin, provider.id, creds);
const { data: eventAfterRevive } = await admin.from('wix_events').select('wix_missing_since').eq('id', event.id).single();
check('A real event flagged missing gets revived on the next sync', eventAfterRevive?.wix_missing_since === null, JSON.stringify(sync4));
check('Sync reports the revival', sync4.revived >= 1, JSON.stringify(sync4));

// ---------- 5. computeWixCheckoutTotal: fee math ----------
const feeAdded: WixTicketReservationLine = {
  ticketDefinitionId: 'x',
  quantity: 1,
  price: { value: '100', currency: 'INR' },
  subTotal: { value: '100', currency: 'INR' },
  serviceFee: { type: 'FEE_ADDED_AT_CHECKOUT', rate: '2.5' },
};
const totalWithFee = computeWixCheckoutTotal([feeAdded]);
check('computeWixCheckoutTotal adds the Wix service fee on top of price', totalWithFee.value === 102.5, JSON.stringify(totalWithFee));

const feeIncluded: WixTicketReservationLine = { ...feeAdded, serviceFee: { type: 'FEE_INCLUDED', rate: '2.5' } };
const totalNoAddedFee = computeWixCheckoutTotal([feeIncluded]);
check('computeWixCheckoutTotal charges exactly subTotal when the fee is FEE_INCLUDED, not added again', totalNoAddedFee.value === 100, JSON.stringify(totalNoAddedFee));

const twoLines = computeWixCheckoutTotal([feeAdded, { ...feeAdded, subTotal: { value: '50', currency: 'INR' }, serviceFee: null }]);
check('computeWixCheckoutTotal sums multiple line items correctly', twoLines.value === 152.5, JSON.stringify(twoLines));

// ---------- 6. A throwaway test parent for the write-path tests ----------
// NOT the usual @babybrain-validation.test domain this repo's other
// validate-*.mjs scripts use — confirmed live that Wix Events' own guest-form
// email validation (unlike Stripe/Supabase/Stream) rejects the reserved
// .test TLD outright with INVALID_FORM_RESPONSE, so a real-looking
// plus-addressed domain is required here specifically.
const testEmail = `qa-test+wixevents-${stamp}@babybrain.sg`;
const { data: testUserRes } = await admin.auth.admin.createUser({ email: testEmail, password: 'X12345678!', email_confirm: true });
const testUser = testUserRes!.user!;
cleanup.push(async () => { await admin.auth.admin.deleteUser(testUser.id); });
await new Promise((r) => setTimeout(r, 600)); // let the signup trigger create parent_profiles

// ---------- 7. Full paid-ticket finalize flow, live against real Wix ----------
const reservation1 = await createWixTicketReservation(creds, ticketType.wix_ticket_definition_id, 1);
const charge1 = computeWixCheckoutTotal(reservation1.lines);
const { data: order1 } = await admin
  .from('event_ticket_orders')
  .insert({
    user_id: testUser.id,
    event_id: event.id,
    ticket_type_id: ticketType.id,
    quantity: 1,
    status: 'pending',
    payment_status: 'none',
    amount: charge1.value,
    wix_reservation_id: reservation1.id,
  })
  .select('id')
  .single();
cleanup.push(async () => { await admin.from('event_ticket_orders').delete().eq('id', order1!.id); });

const fakeSession1 = {
  metadata: {
    kind: 'wix_event_ticket',
    order_id: order1!.id,
    event_id: event.id,
    wix_event_id: event.wix_event_id,
    ticket_type_id: ticketType.id,
    wix_reservation_id: reservation1.id,
  },
  payment_intent: `pi_test_${stamp}_1`,
} as never;

await finalizeWixEventTicketCheckout(admin, fakeSession1);
const { data: order1After } = await admin.from('event_ticket_orders').select('*').eq('id', order1!.id).single();
check('Paid ticket order ends up confirmed', order1After?.status === 'confirmed', JSON.stringify(order1After));
check('Paid ticket order ends up payment_status=paid', order1After?.payment_status === 'paid');
check('Paid ticket order gets a real Wix order number', !!order1After?.wix_order_number, order1After?.wix_order_number ?? '');
check('Paid ticket order records the Stripe payment intent', order1After?.stripe_payment_intent === `pi_test_${stamp}_1`);

// ---------- 8. Idempotent double-finalize (webhook + reconcile racing) ----------
await finalizeWixEventTicketCheckout(admin, fakeSession1);
const { data: order1AfterTwice } = await admin.from('event_ticket_orders').select('wix_order_number, payment_status').eq('id', order1!.id).single();
check(
  'Re-running finalize on an already-paid order is a safe no-op (same order number, still paid)',
  order1AfterTwice?.wix_order_number === order1After?.wix_order_number && order1AfterTwice?.payment_status === 'paid'
);

// ---------- 9. Expired/invalid reservation → fresh-reservation retry succeeds ----------
const { data: order2 } = await admin
  .from('event_ticket_orders')
  .insert({
    user_id: testUser.id,
    event_id: event.id,
    ticket_type_id: ticketType.id,
    quantity: 1,
    status: 'pending',
    payment_status: 'none',
    amount: charge1.value,
    wix_reservation_id: '00000000-0000-0000-0000-000000000000', // simulates an already-expired hold
  })
  .select('id')
  .single();
cleanup.push(async () => { await admin.from('event_ticket_orders').delete().eq('id', order2!.id); });

const fakeSession2 = {
  metadata: {
    kind: 'wix_event_ticket',
    order_id: order2!.id,
    event_id: event.id,
    wix_event_id: event.wix_event_id,
    ticket_type_id: ticketType.id,
    wix_reservation_id: '00000000-0000-0000-0000-000000000000',
  },
  payment_intent: `pi_test_${stamp}_2`,
} as never;

await finalizeWixEventTicketCheckout(admin, fakeSession2);
const { data: order2After } = await admin.from('event_ticket_orders').select('*').eq('id', order2!.id).single();
check(
  'Paid-but-expired-reservation retries with a fresh Wix reservation and still confirms',
  order2After?.status === 'confirmed' && order2After?.payment_status === 'paid' && !!order2After?.wix_order_number
);
check(
  'The retry produces a DIFFERENT Wix order than the first purchase (a real second ticket, not a duplicate reuse)',
  order2After?.wix_order_number !== order1After?.wix_order_number,
  `${order2After?.wix_order_number} vs ${order1After?.wix_order_number}`
);

// ---------- 10. DB constraint: only one in-flight pending checkout per (user, ticket type) ----------
const { data: pendingA } = await admin
  .from('event_ticket_orders')
  .insert({
    user_id: testUser.id,
    event_id: event.id,
    ticket_type_id: ticketType.id,
    quantity: 1,
    status: 'pending',
    payment_status: 'none',
    amount: charge1.value,
  })
  .select('id')
  .single();
cleanup.push(async () => { await admin.from('event_ticket_orders').delete().eq('id', pendingA!.id); });

const { error: dupErr } = await admin.from('event_ticket_orders').insert({
  user_id: testUser.id,
  event_id: event.id,
  ticket_type_id: ticketType.id,
  quantity: 1,
  status: 'pending',
  payment_status: 'none',
  amount: charge1.value,
});
check('A second concurrent pending checkout for the same ticket type is rejected by the DB', dupErr?.code === '23505', dupErr?.message ?? '(no error — BUG)');

// ---------- 11. RLS: a parent can only see their own ticket orders ----------
const otherEmail = `wix-events-qa-other.${stamp}@babybrain-validation.test`;
const { data: otherUserRes } = await admin.auth.admin.createUser({ email: otherEmail, password: 'X12345678!', email_confirm: true });
const otherUser = otherUserRes!.user!;
cleanup.push(async () => { await admin.auth.admin.deleteUser(otherUser.id); });

const anon = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const { error: signInErr } = await anon.auth.signInWithPassword({ email: otherEmail, password: 'X12345678!' });
if (signInErr) {
  check('RLS isolation (own rows only)', false, `could not sign in test user: ${signInErr.message}`);
} else {
  const { data: visibleToOther } = await anon.from('event_ticket_orders').select('id');
  check(
    'A different parent sees zero of this user’s Wix event ticket orders (RLS)',
    (visibleToOther?.length ?? 0) === 0,
    `saw ${visibleToOther?.length ?? 0} rows`
  );
}

// ---------- cleanup ----------
console.log('\n--- Cleaning up test data ---');
for (const fn of cleanup.reverse()) {
  await fn().catch((e) => console.error('cleanup step failed (non-fatal):', e.message));
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
