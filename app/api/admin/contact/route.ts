import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Contact-form inbox.
 *
 * Every /contact submission is stored, whether or not the email went out, so
 * the founder can read enquiries here even while the Resend sending domain is
 * unverified. `emailed` shows whether delivery actually succeeded.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('contact_messages')
    .select('id, name, email, subject, message, emailed, email_error, created_at')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ messages: data ?? [] });
}
