import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import type { ProviderRole } from '@/types/database';

/**
 * Owner invites a staff member. If the invitee already has an account they
 * are linked immediately (active member); otherwise a provider_invites row
 * is created and consumed automatically on their first signup. Owner-only.
 * Body: { provider_id: string, email: string, role: 'manager' | 'staff' }
 */
export async function POST(request: Request) {
  const {
    provider_id: providerId,
    email,
    role = 'staff',
  } = (await request.json()) as { provider_id?: string; email?: string; role?: ProviderRole };

  if (!providerId || !email) {
    return NextResponse.json({ error: 'provider_id and email required' }, { status: 400 });
  }
  if (role !== 'manager' && role !== 'staff') {
    return NextResponse.json({ error: 'role must be manager or staff' }, { status: 400 });
  }

  const auth = await requireProviderRole(providerId, 'owner');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const normalized = email.toLowerCase();

  const { data: list } = await admin.auth.admin.listUsers();
  const existing = list.users.find((u) => u.email?.toLowerCase() === normalized);

  if (existing) {
    const { error } = await admin.from('provider_members').upsert(
      { provider_id: providerId, user_id: existing.id, role, status: 'active', invited_email: normalized },
      { onConflict: 'provider_id,user_id' }
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  } else {
    const { error } = await admin.from('provider_invites').upsert(
      { provider_id: providerId, email: normalized, role },
      { onConflict: 'provider_id,email' }
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const { data: provider } = await admin
    .from('providers')
    .select('business_name')
    .eq('id', providerId)
    .single();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  try {
    const resend = new Resend(process.env.RESEND_API_KEY!);
    await resend.emails.send({
      from: process.env.EMAIL_FROM ?? 'BabyBrain <onboarding@resend.dev>',
      to: email,
      subject: `You've been invited to ${provider?.business_name ?? 'a business'} on BabyBrain`,
      html: `<div style="font-family:sans-serif">
        <h2>You're invited as ${role}</h2>
        <p>${provider?.business_name ?? 'A business'} added you to their BabyBrain vendor account.</p>
        <p><a href="${appUrl}/vendor/login">Sign in${existing ? '' : ' / sign up'}</a> with this email to access the dashboard.</p>
      </div>`,
    });
  } catch {
    /* email best-effort */
  }

  return NextResponse.json({ ok: true, linked: Boolean(existing) });
}
