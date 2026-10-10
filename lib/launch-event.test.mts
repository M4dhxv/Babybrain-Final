// Run with: npm run test:launch   (Node's built-in test runner; no extra packages)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRegistration, normaliseSgPhone, CHILD_AGES } from './launch-event.ts';

const good = {
  name: ' Priya  Raman ',
  email: 'Priya@Example.com ',
  phone: '9123 4567',
  slot: '1445-1545',
  termsAccepted: true,
  secondAdult: '',
  children: [{ name: 'Mia', age: '3' }],
};

test('phone numbers: Singapore only, normalised', () => {
  assert.equal(normaliseSgPhone('91234567'), '+65 9123 4567');
  assert.equal(normaliseSgPhone('+65 9123 4567'), '+65 9123 4567');
  assert.equal(normaliseSgPhone('6591234567'), '+65 9123 4567');
  assert.equal(normaliseSgPhone('6123 4567'), '+65 6123 4567'); // landline
  assert.equal(normaliseSgPhone('5123 4567'), null);
  assert.equal(normaliseSgPhone('9123 456'), null);
  assert.equal(normaliseSgPhone(null), null);
});

test('a good public registration is accepted and normalised', () => {
  const r = parseRegistration(good, 'public');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.name, 'Priya Raman');
    assert.equal(r.value.email, 'priya@example.com');
    assert.equal(r.value.phone, '+65 9123 4567');
    assert.deepEqual(r.value.adultNames, ['Priya Raman']);
    assert.deepEqual(r.value.children, [{ name: 'Mia', age: '3' }]);
  }
});

test('public: terms, email and a child are mandatory', () => {
  assert.equal(parseRegistration({ ...good, termsAccepted: false }, 'public').ok, false);
  assert.equal(parseRegistration({ ...good, termsAccepted: 'true' }, 'public').ok, false);
  assert.equal(parseRegistration({ ...good, email: '' }, 'public').ok, false);
  assert.equal(parseRegistration({ ...good, email: 'nope' }, 'public').ok, false);
  assert.equal(parseRegistration({ ...good, children: [] }, 'public').ok, false);
});

test('children: up to 3, name and an offered age each', () => {
  const kid = (i: number) => ({ name: `K${i}`, age: '2' });
  assert.equal(parseRegistration({ ...good, children: [kid(1), kid(2), kid(3)] }, 'public').ok, true);
  assert.equal(parseRegistration({ ...good, children: [kid(1), kid(2), kid(3), kid(4)] }, 'public').ok, false);
  assert.equal(parseRegistration({ ...good, children: [{ name: 'Mia', age: '12' }] }, 'public').ok, false);
  assert.equal(parseRegistration({ ...good, children: [{ name: '', age: '3' }] }, 'public').ok, false);
  for (const a of CHILD_AGES) assert.equal(parseRegistration({ ...good, children: [{ name: 'Mia', age: a }] }, 'public').ok, true, a);
});

test('a second adult is optional but needs a name when sent', () => {
  const ok = parseRegistration({ ...good, secondAdult: 'Grandma' }, 'public');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.value.adultNames, ['Priya Raman', 'Grandma']);
  assert.equal(parseRegistration({ ...good, secondAdult: '   ' }, 'public').ok, false);
});

test('admin entries: email and terms optional, notes kept', () => {
  const r = parseRegistration({ ...good, email: '', termsAccepted: false, notes: ' phoned in ' }, 'admin');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.email, null);
    assert.equal(r.value.notes, 'phoned in');
  }
  assert.equal(parseRegistration({ ...good, phone: '1234' }, 'admin').ok, false);
  assert.equal(parseRegistration({ ...good, name: '' }, 'admin').ok, false);
});

test('public registrations never carry notes', () => {
  const r = parseRegistration({ ...good, notes: 'sneaky' }, 'public');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.notes, null);
});
