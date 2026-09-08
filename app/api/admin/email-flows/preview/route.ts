import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { renderEmail, type EmailData } from '@/lib/emails/render';

/** Placeholder data so every template renders with something readable rather
 *  than blank fields — keyed by the fields each template in render.ts reads.
 *
 *  `url` / `rebook_url` are ROOT-RELATIVE paths, exactly as the notification
 *  producers write them (see send_class_followups() et al. in migration 00090):
 *  render.ts's `link()` prefixes the app origin itself, so an absolute URL here
 *  would render doubled ("https://babybrain.sghttps://…") and the preview link
 *  would point nowhere. */
function sampleData(type: string): EmailData {
  const SLUG = 'baby-beats-music-circle';
  const activity = {
    activity_name: 'Baby Beats Music Circle',
    date_time: 'Wed, 20 Aug · 10:00 AM',
    duration: '45 minutes',
    address: 'BabyBrain Demo Studio, 30 Raffles Place, #04-01',
    url: `/activity?slug=${SLUG}`,
    rebook_url: `/book?slug=${SLUG}`,
  };
  switch (type) {
    case 'post_activity_checkin':
    case 'class_followup':
      // The review form is a section on the activity page — link straight to it.
      return { ...activity, url: `/activity?slug=${SLUG}#reviews`, rebook_url: `/book?slug=${SLUG}` };
    case 'suggested_activities':
      return {
        activities: [
          activity,
          { ...activity, activity_name: 'Sensory Splash Play', date_time: 'Fri, 22 Aug · 4:00 PM', url: '/activity?slug=sensory-splash-play', rebook_url: '/book?slug=sensory-splash-play' },
        ],
      };
    case 'waitlist_available':
    case 'waitlist_confirmed':
    case 'waitlist_promoted':
      // These link the parent to their own bookings list, not the activity.
      return { ...activity, url: '/profile?tab=bookings' };
    case 'provider_booking_received':
      return { ...activity, spaces_left: '4' };
    case 'auth_email_change':
      return { action_url: 'https://babybrain.sg/auth/callback', new_email: 'newemail@example.com' };
    case 'auth_confirm_signup':
    case 'auth_recovery':
    case 'auth_magic_link':
    case 'auth_invite':
      return { action_url: 'https://babybrain.sg/auth/callback' };
    case 'package_rebook':
      return { ...activity, provider_name: 'BabyBrain Demo Studio' };
    case 'provider_claim_code':
      return { code: '481920', business_name: 'Little Explorers Studio', expires_in_minutes: 30 };
    default:
      return activity;
  }
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const type = new URL(request.url).searchParams.get('type');
  if (!type) return NextResponse.json({ error: 'Missing type' }, { status: 400 });

  const rendered = renderEmail(type, sampleData(type), {
    appUrl: 'https://babybrain.sg',
    recipientName: 'Sarah',
  });
  if (!rendered) return NextResponse.json({ error: `Unknown email type "${type}"` }, { status: 404 });

  return NextResponse.json(rendered);
}
