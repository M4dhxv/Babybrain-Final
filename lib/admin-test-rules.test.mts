// Run with: npm run test:admin   (Node's built-in test runner; no extra packages)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookingBucket, classifyParent, countsAsParent, isLiveEarning, isManualBooking, isNeverConfirmed, isParentBooking, isTestEmail, refundOutcome,
  type BookingRuleInput,
} from './admin-test-rules.ts';

const live = { isTestVendor: false };
const demo = { isTestVendor: true };

test('test-looking emails', () => {
  for (const e of ['a@babybrain.sg', 'x@BabyBrain.com', 'q@example.com', 'q@example.org', 'dev@foo.test', 'z@mailinator.com']) assert.equal(isTestEmail(e), true, e);
  for (const e of ['mum@gmail.com', 'info@omastudio.sg', 'a@babybrain.sg.evil.com', '', null, undefined]) assert.equal(isTestEmail(e as string), false, String(e));
});

test('a plain parent is a parent', () => {
  const c = classifyParent({ email: 'mum@gmail.com' });
  assert.deepEqual(c, { kind: 'parent', isVendor: false, testSource: null, testReason: null });
  assert.equal(countsAsParent(c.kind), true);
});

test('a test email is a test account (automatic)', () => {
  const c = classifyParent({ email: 'qa@babybrain.sg' });
  assert.equal(c.kind, 'test');
  assert.equal(c.testSource, 'auto');
  assert.equal(countsAsParent(c.kind), false);
});

test('manual test flag always wins, even over a real-parent override', () => {
  const c = classifyParent({ email: 'mum@gmail.com', manualTest: true, forcedReal: true });
  assert.equal(c.kind, 'test');
  assert.equal(c.testSource, 'manual');
});

test('forced real overrides the automatic test rules', () => {
  assert.equal(classifyParent({ email: 'qa@babybrain.sg', forcedReal: true }).kind, 'parent');
  assert.equal(classifyParent({ email: 'x@gmail.com', seats: [demo], forcedReal: true }).kind, 'vendor_parent');
});

test('vendor login with no parent activity is its own status, not "test"', () => {
  const c = classifyParent({ email: 'info@physiodownunder.sg', seats: [live], hasParentActivity: false });
  assert.equal(c.kind, 'vendor_login');
  assert.equal(c.isVendor, true);
  assert.equal(c.testSource, null);
  assert.equal(countsAsParent(c.kind), false);
});

test('a vendor who also books as a parent is vendor + parent and counts', () => {
  const c = classifyParent({ email: 'katie@icloud.com', seats: [live], hasParentActivity: true });
  assert.equal(c.kind, 'vendor_parent');
  assert.equal(countsAsParent(c.kind), true);
});

test('a login that works only for test vendors is test; one live seat is enough to avoid that', () => {
  assert.equal(classifyParent({ email: 'a@gmail.com', seats: [demo], hasParentActivity: true }).kind, 'test');
  assert.equal(classifyParent({ email: 'a@gmail.com', seats: [demo, live], hasParentActivity: true }).kind, 'vendor_parent');
  assert.equal(classifyParent({ email: 'a@gmail.com', seats: [demo, live], hasParentActivity: false }).kind, 'vendor_login');
});

test('test beats vendor in the precedence order', () => {
  assert.equal(classifyParent({ email: 'hello@babybrain.sg', seats: [live], hasParentActivity: true }).kind, 'test');
});

const booking = (o: Partial<BookingRuleInput> = {}): BookingRuleInput => ({
  user_id: 'u1', status: 'confirmed', payment_status: 'none', amount: null, package_purchase_id: null, ...o,
});

test('never-confirmed: an unpaid, priced booking that was cancelled was pending', () => {
  assert.equal(isNeverConfirmed(booking({ status: 'cancelled', amount: 55 })), true);
});

test('never-confirmed: cancelled after payment, a free class or a package credit are real cancellations', () => {
  assert.equal(isNeverConfirmed(booking({ status: 'cancelled', payment_status: 'paid', amount: 55 })), false);
  assert.equal(isNeverConfirmed(booking({ status: 'cancelled', payment_status: 'refunded', amount: 55 })), false);
  assert.equal(isNeverConfirmed(booking({ status: 'cancelled', amount: null })), false); // free class
  assert.equal(isNeverConfirmed(booking({ status: 'cancelled', amount: 55, package_purchase_id: 'p1' })), false);
});

test('never-confirmed: a booking that is not cancelled is never "never confirmed"', () => {
  for (const status of ['pending', 'confirmed', 'completed', 'waitlisted']) assert.equal(isNeverConfirmed(booking({ status, amount: 55 })), false, status);
});

test('never-confirmed: a recorded cancel origin overrides the inference', () => {
  assert.equal(isNeverConfirmed(booking({ status: 'cancelled', payment_status: 'paid', amount: 55, cancelled_from_status: 'pending' })), true);
  assert.equal(isNeverConfirmed(booking({ status: 'cancelled', amount: 55, cancelled_from_status: 'waitlisted' })), true);
  assert.equal(isNeverConfirmed(booking({ status: 'cancelled', amount: 55, cancelled_from_status: 'confirmed' })), false);
});

test('manual bookings have no parent account; they are not parent bookings', () => {
  const manual = booking({ user_id: null });
  assert.equal(isManualBooking(manual), true);
  assert.equal(isParentBooking(manual), false);
  assert.equal(isParentBooking(booking()), true);
  assert.equal(isParentBooking(booking({ status: 'cancelled' })), false);
  assert.equal(isParentBooking(booking({ status: 'waitlisted' })), false);
});

test('every booking lands in exactly one bucket', () => {
  assert.equal(bookingBucket(booking({ user_id: null })), 'manual');
  assert.equal(bookingBucket(booking({ user_id: null, payment_status: 'paid' })), 'manual'); // manual wins
  assert.equal(bookingBucket(booking({ payment_status: 'paid', amount: 25 })), 'paid');
  assert.equal(bookingBucket(booking({ package_purchase_id: 'p1' })), 'other');
  assert.equal(bookingBucket(booking({ payment_status: 'refunded' })), 'other');
});

test('live earnings leave out test vendors, Stripe test mode and flagged transactions', () => {
  assert.equal(isLiveEarning({ vendorIsTest: false }), true);
  assert.equal(isLiveEarning({ vendorIsTest: false, livemode: true, flaggedTest: false }), true);
  assert.equal(isLiveEarning({ vendorIsTest: true }), false);
  assert.equal(isLiveEarning({ vendorIsTest: false, livemode: false }), false);
  assert.equal(isLiveEarning({ vendorIsTest: false, flaggedTest: true }), false);
});

const refund = (o: Partial<Parameters<typeof refundOutcome>[0]> = {}) =>
  refundOutcome({ status: 'cancelled', paymentStatus: 'none', packagePurchaseId: null, hasCompensationToken: false, cancelRefundMode: null, ...o });

test('refund: only a cancelled booking has one', () => {
  for (const status of ['confirmed', 'pending', 'completed', 'waitlisted']) assert.equal(refund({ status, paymentStatus: 'paid' }), null, status);
});

test('refund: a package booking gets its credit back', () => {
  assert.deepEqual(refund({ packagePurchaseId: 'p1' }), { status: 'completed', via: 'credit', note: null });
});

test('refund: a cash booking gets a make-up token', () => {
  assert.deepEqual(refund({ paymentStatus: 'paid', hasCompensationToken: true }), { status: 'completed', via: 'token', note: null });
});

test('refund: a package booking whose pack expired gets a make-up token instead', () => {
  assert.equal(refund({ packagePurchaseId: 'p1', hasCompensationToken: true })?.via, 'token');
});

test('refund: cash refunded in Stripe counts as completed (cash)', () => {
  assert.deepEqual(refund({ paymentStatus: 'refunded' }), { status: 'completed', via: 'cash', note: null });
});

test('refund: a vendor who withholds it means not refunded', () => {
  const r = refund({ paymentStatus: 'paid', cancelRefundMode: 'none' });
  assert.equal(r?.status, 'not_refunded');
  assert.equal(r?.via, null);
  assert.equal(refund({ packagePurchaseId: 'p1', cancelRefundMode: 'none' })?.status, 'not_refunded');
});

test('refund: nothing paid means nothing to refund', () => {
  assert.equal(refund()?.status, 'not_applicable');
  assert.equal(refund({ paymentStatus: 'none', cancelRefundMode: 'none' })?.status, 'not_applicable');
});

test('refund: paid but nothing was issued is flagged as not refunded', () => {
  const r = refund({ paymentStatus: 'paid' });
  assert.equal(r?.status, 'not_refunded');
  assert.match(r?.note ?? '', /no make-up token/);
});
