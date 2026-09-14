import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { getStripe } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { renderEmail } from '@/lib/emails/render';

/**
 * Delete the signed-in parent's account (Profile → Settings → Delete account).
 *
 * QA: "I can't see any options to cancel subscription or delete profile."
 *
 * Order matters: cancel any live Stripe subscription first so a deleted
 * account can never be billed again, then remove the auth user. Deleting the
 * auth user cascades to parent_profiles and everything hanging off it
 * (children, preferences, favourites, notifications). Bookings keep their row
 * for the provider's records but lose the user link, per the Terms' data
 * retention clause.
 *
 * Requires the caller to confirm with { confirm: "DELETE" } so a stray POST
 * can't wipe an account.
 *
 * "unsubscribe_response" (email-flows spec: "when a customer unsubscribes,
 * i.e. deletes account") can't go through the usual notifications-table
 * pipeline — the row it would reference (parent_profiles) is the very thing
 * this route cascades away, so the email/name have to be captured before
 * deletion and sent directly via Resend afterward, best-effort.
 */
export async function POST(request: Request) {
  const { confirm } = (await request.json().catch(() => ({}))) as { confirm?: string };
  if (confirm !== 'DELETE') {
    return NextResponse.json({ error: 'Confirmation required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();

  // Captured now — both are gone once deleteUser() cascades below.
  const { data: profile } = await admin
    .from('parent_profiles')
    .select('full_name')
    .eq('id', user.id)
    .maybeSingle();
  const email = user.email;

  const { data: sub } = await admin
    .from('customer_subscriptions')
    .select('stripe_subscription_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (sub?.stripe_subscription_id) {
    // Best effort: a Stripe outage shouldn't trap someone in their account,
    // but we must not lose the fact that it needs cancelling either.
    try {
      await getStripe().subscriptions.cancel(sub.stripe_subscription_id);
    } catch {
      return NextResponse.json(
        {
          error:
            "We couldn't cancel your subscription just now, so we haven't deleted your account. Please try again shortly or contact hello@babybrain.sg.",
        },
        { status: 502 }
      );
    }
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (email) {
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://babybrain.sg';
      const rendered = renderEmail('unsubscribe_response', {}, { appUrl, recipientName: profile?.full_name });
      if (rendered) {
        const resend = new Resend(process.env.RESEND_API_KEY!);
        await resend.emails.send({
          from: process.env.EMAIL_FROM ?? 'Katie from BabyBrain <hello@updates.babybrain.sg>',
          replyTo: 'hello@babybrain.sg',
          to: email,
          subject: rendered.subject,
          html: rendered.html,
        });
      }
    } catch {
      /* email best-effort — the account is already deleted either way */
    }
  }

  return NextResponse.json({ deleted: true });
}
