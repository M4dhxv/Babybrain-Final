import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { renderEmail, type EmailData } from '@/lib/emails/render';

/** Placeholder data so every template renders with something readable rather
 *  than blank fields — keyed by the fields each template in render.ts reads. */
function sampleData(type: string): EmailData {
  const activity = {
    activity_name: 'Baby Beats Music Circle',
    date_time: 'Wed, 20 Aug · 10:00 AM',
    duration: '45 minutes',
    address: 'BabyBrain Demo Studio, 30 Raffles Place, #04-01',
    url: 'https://babybrain.sg/explore',
    rebook_url: 'https://babybrain.sg/explore',
  };
  switch (type) {
    case 'suggested_activities':
      return { activities: [activity, { ...activity, activity_name: 'Sensory Splash Play', date_time: 'Fri, 22 Aug · 4:00 PM' }] };
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
