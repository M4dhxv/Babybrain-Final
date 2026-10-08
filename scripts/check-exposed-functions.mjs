/**
 * List every public-schema function the browser can call that we did not mean
 * it to.
 *
 *   node scripts/check-exposed-functions.mjs
 *
 * Postgres grants EXECUTE on a new function to PUBLIC, and Supabase serves
 * every public-schema function at /rest/v1/rpc/<name> to anyone holding the
 * anon key (which ships in the browser bundle). So a function is callable by
 * the whole internet unless its migration revokes that — and `grant execute
 * ... to service_role` on its own revokes nothing. That is how
 * confirm_paid_booking_seats (mark a booking paid), the send_*_digest email
 * jobs and consume_provider_invites were all reachable until 00229.
 *
 * A function belongs in ALLOWED only if the parent or vendor app really calls
 * it (or an RLS policy does) AND it checks the caller itself. Anything else
 * this prints needs, in its migration:
 *
 *   revoke all on function public.<name>(<args>) from public, anon, authenticated;
 *
 * Read-only. Safe to run against production. Exits 1 if anything is listed.
 */
import postgres from 'postgres';
import { parseDbUrl } from './lib/db-url.mjs';

process.loadEnvFile('.env.local');

const ALLOWED = new Set([
  // Parent app
  'book_party', 'cancel_booking', 'cancel_booking_group', 'reschedule_booking',
  'redeem_package_credit', 'redeem_make_up_token', 'rename_booking_guest',
  'mark_own_attendance', 'my_booking_activities', 'child_journey_stats',
  'save_push_subscription', 'delete_push_subscription', 'record_parent_device',
  // Catalogue (public by design)
  'search_activities', 'matching_activities', 'search_activity_facets',
  'upcoming_activity_sessions', 'session_required_policies', 'search_claimable_providers',
  // Vendor portal (each checks membership of the provider it is asked about)
  'provider_overview', 'provider_analytics', 'provider_bookings_table', 'provider_make_up_tokens',
  'provider_notification_feed', 'provider_notification_unread_count', 'provider_package_purchases',
  'provider_recent_bookings', 'provider_session_roster', 'provider_set_purchase_expiry',
  'provider_trial_conversion', 'mark_provider_notifications_seen', 'promote_waitlist_entry',
  'respond_to_review', 'vendor_cancel_session',
  // Used inside RLS policies, so the calling role must be able to run them
  'user_provider_ids', 'user_manage_provider_ids', 'user_owner_provider_ids',
  // Pure helpers / read-only lookups of already-public data
  'booking_display_name', 'change_when', 'change_venue', 'child_age_months', 'distance_km',
  'plan_commission_rate', 'sg_region', 'time_of_day', 'session_email_details', 'session_price',
]);

const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), prepare: false, ssl: 'require', max: 1 });
try {
  const rows = await sql`
    select p.proname as name,
           pg_get_function_identity_arguments(p.oid) as args,
           p.prosecdef as definer,
           has_function_privilege('anon', p.oid, 'execute') as anon
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    -- extension-owned functions (pg_trgm and friends) are not ours
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
    where n.nspname = 'public'
      and p.prokind = 'f'
      and d.objid is null
      -- a trigger function cannot be called outside a trigger
      and p.prorettype <> 'trigger'::regtype
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute'))
    order by 1`;

  const unexpected = rows.filter((r) => !ALLOWED.has(r.name));
  if (unexpected.length === 0) {
    console.log(`ok: ${rows.length} functions are callable from the browser, all on the allowlist.`);
  } else {
    console.error(`${unexpected.length} function(s) callable from the browser that are not on the allowlist:\n`);
    for (const r of unexpected) {
      console.error(
        `  ${r.name}(${r.args})  [${r.anon ? 'anon + signed-in' : 'signed-in'}${r.definer ? ', security definer' : ''}]`
      );
    }
    console.error('\nRevoke each in a migration, or add it to ALLOWED if the apps call it and it checks its caller.');
    process.exitCode = 1;
  }
} catch (e) {
  console.error('check-exposed-functions failed:', e.message);
  process.exitCode = 2;
} finally {
  await sql.end();
}
