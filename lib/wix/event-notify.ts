import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * In-app + email notices to the parent about the state of a Wix Events ticket they paid for. They go
 * through `notifications`, whose insert trigger sends the branded email (lib/emails/render.ts). Never
 * throws: a notice failing must not undo, or stall, the order work around it.
 */
type Admin = SupabaseClient<Database>;

async function notify(
  admin: Admin,
  userId: string,
  type: 'event_ticket_pending' | 'event_ticket_refunded',
  title: string,
  body: string,
  data: Record<string, unknown>
) {
  try {
    const { error } = await admin
      .from('notifications')
      .insert({ user_id: userId, type, title, body, data: { url: '/profile?tab=bookings', ...data } });
    if (error) console.error('[event-notify] could not insert', type, error);
  } catch (e) {
    console.error('[event-notify] failed', type, e);
  }
}

/** Payment taken, ticket not confirmed yet. Sent once, on the first failed attempt. */
export async function notifyEventTicketPending(
  admin: Admin,
  p: { userId: string; eventTitle: string | null; providerName: string | null; orderId: string }
) {
  await notify(
    admin,
    p.userId,
    'event_ticket_pending',
    'Your payment went through — we’re confirming your place',
    `${p.eventTitle ?? 'Your event'}: we’re finishing confirming your place with ${p.providerName ?? 'the organiser'}. Nothing to do — you’ll hear from us as soon as it’s done.`,
    { activity_name: p.eventTitle, provider_name: p.providerName, order_id: p.orderId }
  );
}

/** An admin refunded the ticket in full. */
export async function notifyEventTicketRefunded(
  admin: Admin,
  p: { userId: string; eventTitle: string | null; amount: number | null; orderId: string }
) {
  const amount = p.amount != null ? `S$${p.amount.toFixed(2)}` : null;
  await notify(
    admin,
    p.userId,
    'event_ticket_refunded',
    'We’ve refunded your payment',
    `${p.eventTitle ?? 'Your event'}${amount ? `: ${amount}` : ''} has been refunded in full. It can take a few days to show on your statement.`,
    { activity_name: p.eventTitle, amount, order_id: p.orderId }
  );
}
