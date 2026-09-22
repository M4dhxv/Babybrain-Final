/**
 * One-off: delete the 5 test bookings found on the live database on 2026-09-21.
 *
 *   Aman (as***@gmail.com)   Wonder Tots            pending    21 Sep
 *   madhav (ma***@gmail.com) Storytime Stretch      pending     4 Jul
 *   madhav (ma***@gmail.com) Baby Beats             pending     5 Jul
 *   Test (ye***@meonvr.com)  Test Activity 2 (x2)   confirmed  14 Sep
 *
 * It targets these exact booking ids only. It is a DRY RUN unless you pass --yes.
 * It refuses to delete unless every id still exists with the status it had when
 * it was listed, and it writes a JSON backup of the rows before deleting.
 *
 * Reads .env.local (the production project). Delete cascades are already in the
 * schema: rows that reference a booking are removed or unlinked, and there is no
 * delete trigger on bookings.
 *
 *   node scripts/delete-test-bookings.mjs          # dry run: shows what would go
 *   node scripts/delete-test-bookings.mjs --yes    # backs up, then deletes
 */
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');

const EXPECTED = {
  '043265ea-7fa5-4585-bb38-a9100969e5bf': 'pending',
  'df5df561-4582-4ee1-bf82-f6bb05e50e4b': 'pending',
  'f04fedc4-9f84-4c39-ad9d-9b12504d7c77': 'pending',
  '4ee0e12c-c83a-4ce5-af7a-417f83e88add': 'confirmed',
  'c82d8906-9b9e-4dc4-951e-80b0780e8611': 'confirmed',
};
const ids = Object.keys(EXPECTED);
const commit = process.argv.includes('--yes');

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: rows, error } = await admin.from('bookings').select('*').in('id', ids);
if (error) throw error;

console.log(`Found ${rows.length} of ${ids.length} bookings:`);
for (const r of rows) {
  console.log(`  ${r.id}  ${r.status}  ${r.payment_status}  booked ${r.created_at.slice(0, 16).replace('T', ' ')}`);
}

const problems = ids.filter((id) => {
  const row = rows.find((r) => r.id === id);
  return !row || row.status !== EXPECTED[id];
});
if (problems.length) {
  console.log('\nStopping: these no longer match what was reviewed (missing or status changed):');
  problems.forEach((id) => console.log('  ' + id));
  process.exit(1);
}
if (rows.some((r) => r.payment_status !== 'none')) {
  console.log('\nStopping: one of these has a payment recorded. Check it before deleting.');
  process.exit(1);
}

if (!commit) {
  console.log('\nDry run only. Nothing was changed. Re-run with --yes to back up and delete these 5.');
  process.exit(0);
}

const backup = `deleted-test-bookings-backup-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(backup, JSON.stringify(rows, null, 2));
console.log(`\nBackup written: ${backup}`);

const { error: delError, count } = await admin.from('bookings').delete({ count: 'exact' }).in('id', ids);
if (delError) throw delError;
console.log(`Deleted ${count} booking(s).`);

const { count: left } = await admin.from('bookings').select('*', { count: 'exact', head: true }).in('id', ids);
console.log(`Still present: ${left}`);
