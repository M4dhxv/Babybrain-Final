import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Email flows — every branded template in lib/emails/render.ts, whether it's
 * actually wired to fire automatically today, and how often it's fired in
 * the last 30 days. Answers "which of our email flows are live" without
 * digging through migrations and trigger code.
 *
 * `wired` / `trigger` / `dbType` are read off the actual DB triggers, cron
 * jobs and webhook code (see supabase/migrations/00011_vendor_notifications.sql,
 * 00008_vendor_functions.sql, app/api/webhooks/stream/route.ts,
 * app/api/auth/send-email/route.ts) — kept here rather than derived at
 * request time because "does a trigger call this" isn't something you can
 * introspect from Postgres cheaply, and this list changes about as often as
 * the templates themselves.
 */
type FlowMeta = {
  type: string;
  dbType?: string; // the notifications.type value this renders under, if different
  category: 'Account' | 'Parent' | 'Provider';
  label: string;
  description: string;
  wired: boolean;
  trigger: string;
};

const FLOWS: FlowMeta[] = [
  // ---- Account / auth ----
  { type: 'auth_confirm_signup', category: 'Account', label: 'Confirm your email', description: 'Sent when someone signs up, parent or vendor.', wired: true, trigger: 'Supabase "Send Email" auth hook — needs enabling once in the Supabase dashboard (Authentication → Hooks).' },
  { type: 'auth_recovery', category: 'Account', label: 'Reset your password', description: 'Sent when someone requests a password reset.', wired: true, trigger: 'Supabase "Send Email" auth hook — needs enabling once in the Supabase dashboard (Authentication → Hooks).' },
  { type: 'auth_magic_link', category: 'Account', label: 'Log-in link', description: 'Passwordless sign-in link.', wired: true, trigger: 'Supabase "Send Email" auth hook — needs enabling once in the Supabase dashboard (Authentication → Hooks).' },
  { type: 'auth_email_change', category: 'Account', label: 'Confirm new email', description: 'Sent when someone changes their account email.', wired: true, trigger: 'Supabase "Send Email" auth hook — needs enabling once in the Supabase dashboard (Authentication → Hooks).' },
  { type: 'auth_invite', category: 'Account', label: "You're invited", description: 'Team member invite (vendor staff).', wired: true, trigger: 'Supabase "Send Email" auth hook — needs enabling once in the Supabase dashboard (Authentication → Hooks).' },

  // ---- Parent lifecycle ----
  { type: 'parent_welcome_free', dbType: 'welcome', category: 'Parent', label: 'Welcome (Free)', description: 'First email after signing up on the Free plan.', wired: true, trigger: 'DB trigger on new parent signup.' },
  { type: 'parent_welcome_paid', category: 'Parent', label: 'Welcome (Plus)', description: 'Sent the first time a parent upgrades to Plus (signup is always Free — there is no combined sign-up-and-pay flow).', wired: true, trigger: 'Stripe webhook, on the free→plus transition only (checkout.session.completed and customer.subscription.* both guard against re-firing on renewals).' },
  { type: 'booking_confirmed', category: 'Parent', label: 'Booking confirmed', description: 'Sent the moment a booking is confirmed.', wired: true, trigger: 'DB trigger on bookings insert/update.' },
  { type: 'booking_reminder', category: 'Parent', label: 'Booking reminder', description: 'Reminder ahead of an upcoming session.', wired: true, trigger: 'Hourly pg_cron job.' },
  { type: 'package_purchased', category: 'Parent', label: 'Package purchased', description: 'Confirms a class pack purchase and how to book with it — the only way a free-tier parent (Packages is Plus-only on /profile) finds out what they bought.', wired: true, trigger: 'Stripe webhook / /api/stripe/reconcile, right after the package_purchases row is created (lib/notify-package-purchased.ts).' },
  { type: 'class_cancelled', category: 'Parent', label: 'Class cancelled', description: 'A vendor (not a self-cancelling parent) cancelled a class and a make-up token was issued.', wired: true, trigger: 'DB trigger, compensate_cancelled_booking()\'s make-up-token path, gated on bookings.cancelled_by is not null (migration 00125).' },
  { type: 'make_up_token_issued', category: 'Parent', label: 'Make-up token issued', description: 'A cancelled paid booking (or one against an expired pack) was compensated with a make-up token, with a link straight to booking with it.', wired: true, trigger: 'DB trigger, compensate_cancelled_booking()\'s "Path 2" (migrations 00081, 00127).' },
  { type: 'make_up_token_returned', category: 'Parent', label: 'Make-up token available again', description: 'A booking made by redeeming a make-up token was itself cancelled, so the token is usable again.', wired: true, trigger: 'DB trigger, compensate_cancelled_booking()\'s "Path 0" (migrations 00081, 00127).' },
  { type: 'package_credit_returned', category: 'Parent', label: 'Package credit returned', description: 'A booking made against a package credit was cancelled, so the credit is back on the pack.', wired: true, trigger: 'DB trigger, compensate_cancelled_booking()\'s "Path 1" (migrations 00081, 00127).' },
  { type: 'session_rescheduled', category: 'Parent', label: 'Activity details changed', description: 'A vendor changed a booked session\'s date/time or location.', wired: true, trigger: 'DB trigger on activity_sessions, update of starts_at or location_id (migrations 00044/00126).' },
  { type: 'waitlist_available', category: 'Parent', label: 'Waitlist spot available', description: 'A seat came free on a class this parent is waitlisted for, and is theirs to book.', wired: true, trigger: 'Fired when a booking is cancelled, or a session’s capacity is raised, and the freed seat has not been paid for (migration 00083).' },
  { type: 'waitlist_confirmed', dbType: 'waitlist_promoted', category: 'Parent', label: 'Waitlist spot confirmed', description: 'A waitlisted booking that was already paid for has been auto-confirmed.', wired: true, trigger: 'Fired on cancellation when the next waitlisted booking is already settled (paid, package credit, make-up token, or a free class), and by the vendor’s manual “promote” action.' },
  { type: 'post_activity_checkin', dbType: 'class_followup', category: 'Parent', label: 'How was it? (review nudge)', description: 'Sent after a session, asks for a review or re-book.', wired: true, trigger: 'Daily pg_cron job.' },
  { type: 'missed_activity', category: 'Parent', label: 'Missed activity check-in', description: 'Sent when a vendor marks a booking as not attended.', wired: true, trigger: 'DB trigger on the attendance table, on the transition into \'absent\' — skipped if the parent self-reported their own absence (migration 00119).' },
  { type: 'suggested_activities', category: 'Parent', label: 'Weekly suggested activities', description: 'Top 5 available activities (incl. synced Wix events) matching a Plus parent\'s children\'s saved preferences, skipped if none qualify.', wired: true, trigger: 'pg_cron, Tue 09:00 + Thu 19:00 SGT, Plus parents only (migration 00120).' },
  { type: 'package_token_reminder', category: 'Parent', label: 'Unused passes reminder', description: 'Nudge to use active packages/make-up tokens.', wired: true, trigger: 'pg_cron, every Wednesday, no-ops unless it\'s the 2nd Wednesday of the month (migration 00121).' },
  { type: 'message_response', dbType: 'support_message', category: 'Parent', label: "You've got a message", description: 'A message the parent sent got a reply.', wired: true, trigger: 'Stream chat webhook.' },
  { type: 'unsubscribe_response', category: 'Parent', label: 'Sorry to see you go', description: 'Sent when a parent deletes their account.', wired: true, trigger: 'Sent directly (not via the notifications table — parent_profiles is gone by the time it would fire) from app/api/customer/account/route.ts, right after account deletion succeeds.' },
  { type: 'downgrade_response', category: 'Parent', label: 'Sorry you downgraded', description: 'Sent when a Plus parent drops to Free but keeps their account.', wired: true, trigger: 'Stripe webhook, on customer.subscription.deleted only, plus→free transition (app/api/webhooks/stripe/route.ts). Distinct from unsubscribe_response, which is account deletion.' },
  { type: 'upgrade_nudge', category: 'Parent', label: 'Upgrade nudge', description: 'Reminds a Free parent what Plus unlocks.', wired: true, trigger: 'pg_cron, 1st Saturday of Jan/Apr/Jul/Oct SGT, every Free parent (migration 00122).' },
  { type: 'providers_added', category: 'Parent', label: 'New vendors added', description: 'Announces newly onboarded, active, published vendors.', wired: true, trigger: 'pg_cron, weekly Monday 09:00 SGT, skipped if none qualified that week, every parent (migration 00123).' },
  { type: 'package_rebook', category: 'Parent', label: 'Re-book your package', description: 'Nudge to re-buy a package the day after it expires.', wired: true, trigger: 'Daily pg_cron job, matches package_purchases.expires_at (SGT date) against yesterday (migration 00124).' },

  // ---- Provider lifecycle ----
  { type: 'provider_welcome_free', category: 'Provider', label: 'Welcome (Free)', description: 'First email after a vendor signs up on Free.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_welcome_growth', category: 'Provider', label: 'Welcome (Growth)', description: 'Welcome variant for vendors on Growth.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_welcome_pro', category: 'Provider', label: 'Welcome (Pro)', description: 'Welcome variant for vendors on Pro.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_welcome_premium', category: 'Provider', label: 'Welcome (Premium)', description: 'Welcome variant for vendors on Premium.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_message_response', category: 'Provider', label: "You've got a message", description: 'A message the vendor sent got a reply.', wired: true, trigger: 'Sent only if still unread 8h after the message (webhook defers; hourly send_pending_chat_emails cron, migration 00142). Stream chat webhook — every non-sender member of a parent↔provider (pp-*) channel who is an active provider_members row gets this type instead of provider_message.' },
  { type: 'provider_unsubscribe_response', category: 'Provider', label: 'Sorry to see you go', description: 'Sent when a vendor cancels their paid plan.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_downgrade_response', category: 'Provider', label: 'Sorry you downgraded', description: 'Sent when a vendor downgrades plan.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_upgrade_free_to_growth', category: 'Provider', label: 'Upgrade nudge: Free → Growth', description: 'Reminds a Free vendor what Growth unlocks.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_upgrade_growth_to_pro', category: 'Provider', label: 'Upgrade nudge: Growth → Pro', description: 'Reminds a Growth vendor what Pro unlocks.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_upgrade_pro_to_premium', category: 'Provider', label: 'Upgrade nudge: Pro → Premium', description: 'Reminds a Pro vendor what Premium unlocks.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_booking_received', category: 'Provider', label: 'New booking received', description: 'Tells a vendor they just got a booking.', wired: true, trigger: 'DB trigger on bookings, transition into \'confirmed\' — fans out to every active provider_members row (migration 00141).' },
  { type: 'provider_activity_full', category: 'Provider', label: 'Add more capacity to your activity', description: 'Nudges a vendor to extend capacity once a session is fully booked.', wired: true, trigger: 'Same DB trigger as provider_booking_received, fired once when a confirmed booking fills the session\'s capacity (migration 00141).' },
  { type: 'provider_add_activities', category: 'Provider', label: 'Add more to your schedule', description: 'Nudges a vendor whose schedule is thin.', wired: false, trigger: 'Not wired to anything yet.' },
];

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: rows } = await admin
    .from('notifications')
    .select('type, email_status')
    .gte('created_at', since);

  const counts = new Map<string, { sent: number; pending: number; failed: number; skipped: number; total: number }>();
  for (const r of rows ?? []) {
    const c = counts.get(r.type) ?? { sent: 0, pending: 0, failed: 0, skipped: 0, total: 0 };
    if (r.email_status === 'sent') c.sent++;
    else if (r.email_status === 'pending') c.pending++;
    else if (r.email_status === 'failed') c.failed++;
    else if (r.email_status === 'skipped') c.skipped++;
    c.total++;
    counts.set(r.type, c);
  }

  const flows = FLOWS.map((f) => ({
    ...f,
    last30d: counts.get(f.dbType ?? f.type) ?? { sent: 0, pending: 0, failed: 0, skipped: 0, total: 0 },
  }));

  return NextResponse.json({ flows });
}
