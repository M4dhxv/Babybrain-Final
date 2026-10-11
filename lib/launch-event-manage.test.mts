// Run with: npm run test:launch
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signManageToken, verifyManageToken, maskName, maskEmail, maskPhone, MANAGE_TOKEN_TTL_SECONDS } from './launch-event-manage.ts';

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-not-real';
const ID = '3f2b8c1e-7a44-4d2e-9b1a-0c5d6e7f8a90';
const T0 = 1_800_000_000_000;

test('a fresh token verifies and names exactly one registration', () => {
  const t = signManageToken(ID, T0);
  assert.equal(verifyManageToken(t, T0 + 1000), ID);
});

test('a token expires after the time limit', () => {
  const t = signManageToken(ID, T0);
  assert.equal(verifyManageToken(t, T0 + (MANAGE_TOKEN_TTL_SECONDS - 5) * 1000), ID);
  assert.equal(verifyManageToken(t, T0 + (MANAGE_TOKEN_TTL_SECONDS + 5) * 1000), null);
});

test('a tampered token is rejected', () => {
  const t = signManageToken(ID, T0);
  const [, exp, sig] = t.split('.');
  const other = '11111111-2222-3333-4444-555555555555';
  assert.equal(verifyManageToken(`${other}.${exp}.${sig}`, T0), null);          // different registration, same signature
  assert.equal(verifyManageToken(`${ID}.${Number(exp) + 99999}.${sig}`, T0), null); // longer expiry
  assert.equal(verifyManageToken(`${ID}.${exp}.${sig.slice(0, -2)}xx`, T0), null);  // altered signature
  for (const bad of ['', 'abc', null, undefined, 42, `${ID}.${exp}`, 'a.b.c.d']) assert.equal(verifyManageToken(bad as unknown, T0), null);
});

test('a token signed with another secret is rejected', () => {
  const t = signManageToken(ID, T0);
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'a-different-key';
  assert.equal(verifyManageToken(t, T0), null);
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-not-real';
});

test('masking keeps just enough to be recognised', () => {
  assert.equal(maskName('Priya Raman'), 'P**** R****');
  assert.equal(maskEmail('priya@example.com'), 'p****@example.com');
  assert.equal(maskPhone('+65 9123 4567'), '+65 9*** **67');
  assert.equal(maskEmail(null), '');
  assert.ok(!maskName('Priya Raman').includes('riya'));
  assert.ok(!maskPhone('+65 9123 4567').includes('4567'));
});
