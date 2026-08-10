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
  { type: 'parent_welcome_paid', category: 'Parent', label: 'Welcome (Plus)', description: 'Welcome variant for parents who sign up already on Plus.', wired: false, trigger: 'Not wired — the signup trigger always sends the Free welcome regardless of plan.' },
  { type: 'booking_confirmed', category: 'Parent', label: 'Booking confirmed', description: 'Sent the moment a booking is confirmed.', wired: true, trigger: 'DB trigger on bookings insert/update.' },
  { type: 'booking_reminder', category: 'Parent', label: 'Booking reminder', description: 'Reminder ahead of an upcoming session.', wired: true, trigger: 'Hourly pg_cron job.' },
  { type: 'waitlist_available', dbType: 'waitlist_promoted', category: 'Parent', label: 'Waitlist spot available', description: 'A spot opened up for someone on the waitlist.', wired: true, trigger: 'Fired by the waitlist-promotion function.' },
  { type: 'post_activity_checkin', dbType: 'class_followup', category: 'Parent', label: 'How was it? (review nudge)', description: 'Sent after a session, asks for a review or re-book.', wired: true, trigger: 'Daily pg_cron job.' },
  { type: 'missed_activity', category: 'Parent', label: 'Missed activity check-in', description: 'Sent when a booking is marked as missed/not-attended.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'suggested_activities', category: 'Parent', label: 'Weekly suggested activities', description: 'Curated activities matching saved preferences.', wired: false, trigger: 'Not wired — this is the "digest" flow; needs a weekly cron function.' },
  { type: 'package_token_reminder', category: 'Parent', label: 'Unused passes reminder', description: 'Nudge to use active packages/make-up tokens.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'message_response', dbType: 'support_message', category: 'Parent', label: "You've got a message", description: 'A message the parent sent got a reply.', wired: true, trigger: 'Stream chat webhook.' },
  { type: 'unsubscribe_response', category: 'Parent', label: 'Sorry to see you go', description: 'Sent when a Plus subscription is cancelled.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'downgrade_response', category: 'Parent', label: 'Sorry you downgraded', description: 'Sent on downgrade from Plus.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'upgrade_nudge', category: 'Parent', label: 'Upgrade nudge', description: 'Reminds a Free parent what Plus unlocks.', wired: false, trigger: 'Not wired — candidate for a "N days since signup, still Free" cron.' },
  { type: 'providers_added', category: 'Parent', label: 'New vendors added', description: 'Announces newly onboarded vendors.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'package_rebook', category: 'Parent', label: 'Re-book your package', description: 'Nudge to re-buy a package after it runs out.', wired: false, trigger: 'Not wired to anything yet.' },

  // ---- Provider lifecycle ----
  { type: 'provider_welcome_free', category: 'Provider', label: 'Welcome (Free)', description: 'First email after a vendor signs up on Free.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_welcome_growth', category: 'Provider', label: 'Welcome (Growth)', description: 'Welcome variant for vendors on Growth.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_welcome_pro', category: 'Provider', label: 'Welcome (Pro)', description: 'Welcome variant for vendors on Pro.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_welcome_premium', category: 'Provider', label: 'Welcome (Premium)', description: 'Welcome variant for vendors on Premium.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_message_response', category: 'Provider', label: "You've got a message", description: 'A message the vendor sent got a reply.', wired: false, trigger: 'Not wired — the parent-side equivalent fires from the chat webhook, this one does not.' },
  { type: 'provider_unsubscribe_response', category: 'Provider', label: 'Sorry to see you go', description: 'Sent when a vendor cancels their paid plan.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_downgrade_response', category: 'Provider', label: 'Sorry you downgraded', description: 'Sent when a vendor downgrades plan.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_upgrade_free_to_growth', category: 'Provider', label: 'Upgrade nudge: Free → Growth', description: 'Reminds a Free vendor what Growth unlocks.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_upgrade_growth_to_pro', category: 'Provider', label: 'Upgrade nudge: Growth → Pro', description: 'Reminds a Growth vendor what Pro unlocks.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_upgrade_pro_to_premium', category: 'Provider', label: 'Upgrade nudge: Pro → Premium', description: 'Reminds a Pro vendor what Premium unlocks.', wired: false, trigger: 'Not wired to anything yet.' },
  { type: 'provider_booking_received', category: 'Provider', label: 'New booking received', description: 'Tells a vendor they just got a booking.', wired: false, trigger: 'Not wired — parents get "Booking confirmed" but vendors get no equivalent email today.' },
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
