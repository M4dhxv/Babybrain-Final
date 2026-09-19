import type { createAdminClient } from '@/lib/supabase/admin';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The "welcome to Plus" email is for a parent who SIGNED UP on Plus, once their
 * payment lands — not for a parent who upgrades later (they were welcomed at
 * sign-up and get nothing on upgrade).
 *
 * The sign-up form stores the chosen plan on the account as auth metadata
 * (`intended_plan: 'plus'`) so it survives the email-confirmation round trip.
 * This is called by the Stripe webhook when a parent's plan becomes Plus:
 *   · no `intended_plan`  → a later upgrade: send nothing;
 *   · `intended_plan`     → clear it, then send the paid welcome once.
 *
 * The flag is cleared BEFORE sending, and a prior parent_welcome_paid row is
 * checked, so the two webhook events a checkout produces (checkout.session.completed
 * and customer.subscription.created) can't both send it.
 */
export async function welcomeIfSignedUpPaid(admin: Admin, userId: string): Promise<void> {
  const { data } = await admin.auth.admin.getUserById(userId);
  const user = data?.user;
  if (!user) return;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  if (meta.intended_plan !== 'plus') return;

  await admin.auth.admin.updateUserById(userId, {
    user_metadata: { ...meta, intended_plan: null, intended_billing: null },
  });

  const { count } = await admin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('type', 'parent_welcome_paid');
  if (count) return;

  await admin.from('notifications').insert({
    user_id: userId,
    type: 'parent_welcome_paid',
    title: 'Welcome to BabyBrain Plus!',
    body: 'Complete your profile to start getting suggested activities based on your preferences.',
    data: { url: '/explore' },
  });
}
