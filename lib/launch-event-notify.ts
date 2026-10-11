import { Resend } from 'resend';
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderEmail } from '@/lib/emails/render';

/**
 * Tell parents their waitlisted registration has been confirmed ("a spot opened up").
 *
 * The database promotes (automatically when seats free up, or by an admin - migration 00232) and
 * stamps `promoted_at`; this sends the email for every confirmed row that was promoted and not
 * yet notified, then stamps `notified_at` (or records `notify_error` so the admin can see and
 * retry). Safe to call repeatedly - a row is only ever emailed once.
 */

const ADDRESS: Record<string, string> = {
  'launch-2026': '7 Holland Vlg Wy, #01-20, Singapore, 275748',
};

export type NotifyResult = { sent: number; failed: number; noEmail: number; error?: string; disabled?: boolean };

/** Launch emails are ON HOLD until both Resend is configured (RESEND_API_KEY) and LAUNCH_EVENT_EMAILS=on is set.
 *  Until then promotions still happen and stay marked as awaiting a notification, so switching it on later lets
 *  "Send emails now" catch up. */
export const launchEmailsEnabled = (): boolean => process.env.LAUNCH_EVENT_EMAILS === 'on' && Boolean(process.env.RESEND_API_KEY);

const dayText = (d: string | null) =>
  d ? new Date(`${d}T00:00:00+08:00`).toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Singapore' }) : null;

const ordinal = (n: number) => {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
};
/** "Sunday 8th November 2026" from a YYYY-MM-DD event date. */
export function longDate(d: string | null): string | null {
  if (!d) return null;
  const parts = new Intl.DateTimeFormat('en-SG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Singapore' })
    .formatToParts(new Date(`${d}T00:00:00+08:00`));
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${get('weekday')} ${ordinal(Number(get('day')))} ${get('month')} ${get('year')}`;
}

type Reg = { id: string; event_slug: string; slot_key: string; name: string; email: string | null; adults: number; children: number;
  adult_names?: string[] | null; child_details?: { name: string; age: string }[] | null };

/** Everything the confirmation email needs, from a registration + its event and slot. */
export function launchEmailData(r: Reg, ev: { title: string; starts_on: string | null; venue: string | null } | null | undefined, slotLabel: string | null, appUrl: string) {
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(r.slot_key);
  const at = (h: string, mi: string) => (ev?.starts_on && m ? `${ev.starts_on}T${h}:${mi}:00+08:00` : null);
  const starts = m ? at(m[1], m[2]) : null;
  const ends = m ? at(m[3], m[4]) : null;
  const mins = starts && ends ? Math.round((new Date(ends).getTime() - new Date(starts).getTime()) / 60000) : 0;
  const duration = mins === 60 ? '1 hour' : mins > 0 && mins % 60 === 0 ? `${mins / 60} hours` : mins > 0 ? `${mins} minutes` : '1 hour';
  const others = [...(r.adult_names ?? []).slice(1), ...(r.child_details ?? []).map((c) => c.name)].filter(Boolean).join(', ');
  const venue = ev?.venue ?? null;
  const address = ADDRESS[r.event_slug] ?? null;
  const rsvp = `mailto:hello@babybrain.sg?subject=${encodeURIComponent('Update my BabyBrain Launch Event RSVP')}&body=${encodeURIComponent(`Hi Katie,

Please update the RSVP for ${r.name} (${slotLabel ?? 'the launch event'}):

`)}`;
  return {
    event_title: ev ? `${ev.title} event` : 'BabyBrain launch event',
    date_text: longDate(ev?.starts_on ?? null),
    slot_label: slotLabel,
    duration,
    venue,
    address,
    others: others || null,
    party_text: `${r.adults} adult${r.adults === 1 ? '' : 's'} and ${r.children} child${r.children === 1 ? '' : 'ren'}`,
    activity_name: 'BabyBrain Launch Event',
    starts_at: starts,
    ends_at: ends,
    calendar_venue: [venue, address].filter(Boolean).join(', ') || null,
    rsvp_href: rsvp,
  };
}

export async function notifyPromoted(db: SupabaseClient, slug?: string): Promise<NotifyResult> {
  const result: NotifyResult = { sent: 0, failed: 0, noEmail: 0 };
  if (!launchEmailsEnabled()) return { ...result, disabled: true };

  let q = db.from('event_registrations')
    .select('id, event_slug, slot_key, name, email, adults, children, adult_names, child_details')
    .eq('status', 'confirmed')
    .not('promoted_at', 'is', null)
    .is('notified_at', null)
    .not('email', 'is', null)
    .order('promoted_at')
    .limit(100);
  if (slug) q = q.eq('event_slug', slug);
  const { data: pending, error } = await q;
  if (error) return { ...result, error: error.message };
  if (!pending || pending.length === 0) return result;

  if (!process.env.RESEND_API_KEY) {
    return { ...result, error: 'RESEND_API_KEY is not set - the emails were not sent.' };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://babybrain.sg';

  const slugs = [...new Set(pending.map((r: { event_slug: string }) => r.event_slug))];
  const [events, slots] = await Promise.all([
    db.from('events').select('slug, title, starts_on, venue').in('slug', slugs),
    db.from('event_slots').select('event_slug, slot_key, label').in('event_slug', slugs),
  ]);
  const eventBy = new Map((events.data ?? []).map((e: { slug: string }) => [e.slug, e]));
  const slotBy = new Map((slots.data ?? []).map((s: { event_slug: string; slot_key: string; label: string }) => [`${s.event_slug}:${s.slot_key}`, s.label]));

  for (const r of pending as Array<{ id: string; event_slug: string; slot_key: string; name: string; email: string; adults: number; children: number; adult_names: string[] | null; child_details: { name: string; age: string }[] | null }>) {
    const ev = eventBy.get(r.event_slug) as { title: string; starts_on: string | null; venue: string | null } | undefined;
    // Claim the row first so two overlapping calls (admin click + another admin action) can't both email it.
    const claim = await db.from('event_registrations')
      .update({ notified_at: new Date().toISOString(), notify_error: null })
      .eq('id', r.id).is('notified_at', null).select('id');
    if (claim.error || !claim.data || claim.data.length === 0) continue;

    const rendered = renderEmail('event_waitlist_promoted',
      launchEmailData(r as unknown as Reg, ev, slotBy.get(`${r.event_slug}:${r.slot_key}`) ?? null, appUrl),
      { appUrl, recipientName: r.name });
    if (!rendered) {
      result.failed++;
      await db.from('event_registrations').update({ notified_at: null, notify_error: 'template missing' }).eq('id', r.id);
      continue;
    }

    const { error: sendErr } = await resend.emails.send({
      from: process.env.EMAIL_FROM ?? 'Katie from BabyBrain <hello@updates.babybrain.sg>',
      replyTo: 'hello@babybrain.sg',
      to: r.email,
      subject: rendered.subject,
      html: rendered.html,
    });
    if (sendErr) {
      result.failed++;
      console.error(`[launch-notify] could not email registration ${r.id}: ${sendErr.name ?? 'error'} - ${sendErr.message}`);
      // give the claim back so the admin can retry, and keep the reason
      await db.from('event_registrations').update({ notified_at: null, notify_error: `${sendErr.name ?? 'error'}: ${sendErr.message}`.slice(0, 300) }).eq('id', r.id);
    } else {
      result.sent++;
    }
  }
  return result;
}

/**
 * The receipt right after someone registers: "you're registered" or "you're on the waitlist".
 * Best effort and never throws - the registration itself is already saved. A failure is kept on the
 * row (notify_error) so the admin can see it; nothing is retried automatically.
 */
export async function emailRegistration(db: SupabaseClient, registrationId: string): Promise<{ sent: boolean; reason?: string }> {
  try {
    if (!launchEmailsEnabled()) return { sent: false, reason: 'disabled' };
    if (!process.env.RESEND_API_KEY) return { sent: false, reason: 'RESEND_API_KEY not set' };

    const { data: r } = await db.from('event_registrations')
      .select('id, event_slug, slot_key, name, email, adults, children, status, adult_names, child_details')
      .eq('id', registrationId).maybeSingle();
    if (!r || !r.email || r.status === 'cancelled') return { sent: false, reason: 'nothing to send' };

    const [ev, slot] = await Promise.all([
      db.from('events').select('title, starts_on, venue').eq('slug', r.event_slug).maybeSingle(),
      db.from('event_slots').select('label').eq('event_slug', r.event_slug).eq('slot_key', r.slot_key).maybeSingle(),
    ]);
    const waitlisted = r.status === 'waitlisted';
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://babybrain.sg';
    const rendered = renderEmail(waitlisted ? 'event_registration_waitlisted' : 'event_registration_confirmed',
      { ...launchEmailData(r as unknown as Reg, ev.data, slot.data?.label ?? null, appUrl), date_text: waitlisted ? dayText(ev.data?.starts_on ?? null) : longDate(ev.data?.starts_on ?? null) },
      { appUrl, recipientName: r.name });
    if (!rendered) return { sent: false, reason: 'template missing' };

    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM ?? 'Katie from BabyBrain <hello@updates.babybrain.sg>',
      replyTo: 'hello@babybrain.sg',
      to: r.email,
      subject: rendered.subject,
      html: rendered.html,
    });
    if (error) {
      console.error(`[launch-notify] receipt email failed for ${r.id}: ${error.name ?? 'error'} - ${error.message}`);
      await db.from('event_registrations').update({ notify_error: `receipt: ${error.name ?? 'error'}: ${error.message}`.slice(0, 300) }).eq('id', r.id);
      return { sent: false, reason: error.message };
    }
    return { sent: true };
  } catch (e) {
    console.error('[launch-notify] receipt email crashed:', e);
    return { sent: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
