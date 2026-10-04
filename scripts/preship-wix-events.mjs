/**
 * Pre-ship check for the Wix Events release: is the database ready for the code?
 *
 *   node scripts/preship-wix-events.mjs
 *
 * The new code reads columns and a function that migrations 00218, 00219 and 00221 create. Shipped before
 * them, it breaks My Bookings (it selects activity_sessions.wix_event_id), the events sync and every
 * Wix event booking. Run this AFTER applying the migrations and BEFORE pushing. It exits non-zero and says
 * what is missing. Read-only; safe to run against production.
 */
import postgres from 'postgres';
import { parseDbUrl } from './lib/db-url.mjs';

process.loadEnvFile('.env.local');
const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), max: 1, ssl: 'require', idle_timeout: 5, connect_timeout: 15 });

const COLUMNS = {
  activities: ['wix_form_extra_fields', 'wix_event_blockers', 'wix_event_checked_at', 'wix_series_id', 'wix_registration_type'],
  activity_sessions: ['wix_event_id', 'wix_day'],
  event_ticket_orders: [
    'fulfilment_error', 'fulfilment_attempts', 'fulfilment_last_attempt_at', 'tickets', 'wix_order_status',
    'wix_synced_at', 'refunded_at', 'stripe_refund_id', 'form_response', 'selected_days', 'party_size',
  ],
  wix_events: [
    'wix_series_id', 'recurrence_status', 'registration_type', 'registration_status', 'external_url', 'rsvp_limit',
    'rsvp_waitlist', 'rsvp_allows_guests', 'form_questions', 'booking_blockers',
  ],
  event_rsvps: ['id', 'user_id', 'event_id', 'status', 'wix_rsvp_id', 'form_response'],
};

const problems = [];
try {
  const have = await sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`;
  const set = new Set(have.map((r) => `${r.table_name}.${r.column_name}`));
  for (const [table, cols] of Object.entries(COLUMNS)) {
    for (const c of cols) if (!set.has(`${table}.${c}`)) problems.push(`missing column ${table}.${c}`);
  }

  const fn = await sql`
    select pg_get_function_result(p.oid) as result
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'upcoming_activity_sessions'`;
  if (!fn[0] || !String(fn[0].result).includes('wix_event_id') || !String(fn[0].result).includes('wix_day')) {
    problems.push('upcoming_activity_sessions() does not return wix_event_id and wix_day (migration 00221 not applied)');
  }

  const cron = await sql`select schedule from cron.job where jobname = 'reconcile-wix-events'`;
  if (!cron[0]) problems.push('cron job "reconcile-wix-events" is not scheduled (migration 00219)');

  const idx = await sql`select 1 from pg_indexes where schemaname = 'public' and indexname = 'activities_provider_series_idx'`;
  if (!idx[0]) problems.push('unique index activities_provider_series_idx is missing (migration 00221)');

  const secret = await sql`select 1 from vault.decrypted_secrets where name = 'cron_shared_secret'`;
  if (!secret[0]) problems.push('Vault secret "cron_shared_secret" is not set - the 10-minute job could not authenticate');
} catch (e) {
  problems.push(`could not inspect the database: ${e.message}`);
} finally {
  await sql.end();
}

if (problems.length) {
  console.log('NOT READY - do not push yet:\n  - ' + problems.join('\n  - '));
  console.log('\nApply migrations 00218, 00219 and 00221 first (supabase db push applies every pending migration).');
  process.exit(1);
}
console.log('READY - the database has everything the Wix Events code needs.');
