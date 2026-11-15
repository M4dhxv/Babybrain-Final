/**
 * Rules for companion mode (migration 00273), run without a database or a browser:
 *
 *   node scripts/test-companions.mjs
 *
 * Covers the server-side validator the API uses, the same one that guards pack-checkout metadata.
 */
import { validateCompanions, packCompanionMetadata, readCompanionMetadata, companionAgeProblem } from '../lib/companions.ts';

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => { if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name} ${detail}`); } };

const adult1 = { companion_enabled: true, companion_count: 1, companion_type: 'adult' };
const child2 = { companion_enabled: true, companion_count: 2, companion_type: 'child' };
const off = { companion_enabled: false, companion_count: 1, companion_type: 'adult' };

t('adult of 34 fits an adult companion', validateCompanions(adult1, 1, [{ seat: 0, name: 'Sam', age: 34 }]).ok);
t('an age of 15 is the first adult age', validateCompanions(adult1, 1, [{ seat: 0, name: 'Sam', age: 15 }]).ok);
t('14 is not an adult', !validateCompanions(adult1, 1, [{ seat: 0, name: 'Sam', age: 14 }]).ok);
t('a child of 9 on an adult place is refused', !validateCompanions(adult1, 1, [{ seat: 0, name: 'Mia', age: 9 }]).ok);
t('the message says what the class wants', /adult \(15 and over\)/.test(companionAgeProblem('adult', 9) ?? ''));
t('12 fits a child companion', validateCompanions(child2, 1, [{ seat: 0, name: 'Leo', age: 12 }]).ok);
t('13 is not a child', !validateCompanions(child2, 1, [{ seat: 0, name: 'Leo', age: 13 }]).ok);
t('an adult on a child place is refused', !validateCompanions(child2, 1, [{ seat: 0, name: 'Sam', age: 40 }]).ok);
t('a name without an age is refused', !validateCompanions(adult1, 1, [{ seat: 0, name: 'Sam', age: null }]).ok);
t('an age without a name is refused', !validateCompanions(adult1, 1, [{ seat: 0, name: '', age: 34 }]).ok);
t('the message asks for the name', /name/i.test(validateCompanions(adult1, 1, [{ seat: 0, name: '', age: 34 }]).error ?? ''));
t('a blank row is dropped, not an error', validateCompanions(adult1, 1, [{ seat: 0, name: '', age: null }]).list?.length === 0);
t('two companions on one ticket exceed an allowance of one', !validateCompanions(adult1, 1, [{ seat: 0, name: 'A', age: 30 }, { seat: 0, name: 'B', age: 31 }]).ok);
t('two companions are fine when two are included', validateCompanions(child2, 1, [{ seat: 0, name: 'A', age: 5 }, { seat: 0, name: 'B', age: 6 }]).ok);
t('one per ticket across two tickets is fine', validateCompanions(adult1, 2, [{ seat: 0, name: 'A', age: 30 }, { seat: 1, name: 'B', age: 31 }]).ok);
t('a companion for a ticket that does not exist is refused', !validateCompanions(adult1, 1, [{ seat: 1, name: 'A', age: 30 }]).ok);
t('companions are refused when the class has none', !validateCompanions(off, 1, [{ seat: 0, name: 'A', age: 30 }]).ok);
t('nothing entered is fine even when the class has none', validateCompanions(off, 1, []).ok);

const list = [{ seat: 0, name: 'Sam Tan', age: 34 }, { seat: 1, name: 'Raj', age: null }];
const roundTrip = readCompanionMetadata(packCompanionMetadata(list));
t('companions survive the trip through checkout metadata', JSON.stringify(roundTrip) === JSON.stringify(list), JSON.stringify(roundTrip));
const big = Array.from({ length: 30 }, (_, i) => ({ seat: i % 20, name: `Person ${i}`, age: 30 }));
t('metadata values stay under Stripe\'s 500 character limit', Object.values(packCompanionMetadata(big)).every((v) => v.length <= 500));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
