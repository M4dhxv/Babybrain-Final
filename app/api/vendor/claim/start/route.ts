import { createHash, randomInt } from 'node:crypto';
import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Start a "Claim Your Business" attempt: generate one-time codes and send them
 * to the business's contact channels.
 *
 * QA: "claim your business, no code sent to e-mail and phone."
 *
 * The email code always goes out via Resend. SMS needs an SMS provider —
 * when SMS_* env vars aren't set we say so plainly rather than pretending a
 * text was sent, and email alone is enough to verify.
 *
 * Body: { provider_id, email, phone?, uen? }
 */

const CODE_TTL_MINUTES = 30;
const hash = (code: string) => createHash('sha256').update(code).digest('hex');
const sixDigits = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export async function POST(request: Request) {
  const {
    provider_id: providerId,
    email,
    phone,
    uen,
  } = (await request.json().catch(() => ({}))) as {
    provider_id?: string;
    email?: string;
    phone?: string;
    uen?: string;
  };

  if (!providerId) return NextResponse.json({ error: 'Choose your venue first' }, { status: 400 });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return NextResponse.json({ error: 'Enter a valid business email address' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: provider } = await admin
    .from('providers')
    .select('id, business_name, is_claimed')
    .eq('id', providerId)
    .maybeSingle();

  if (!provider) return NextResponse.json({ error: 'Venue not found' }, { status: 404 });
  if (provider.is_claimed) {
    return NextResponse.json(
      { error: 'This business has already been claimed. Email hello@babybrain.sg if that wasn’t you.' },
      { status: 409 }
    );
  }

  const emailCode = sixDigits();
  const phoneCode = phone?.trim() ? sixDigits() : null;

  const { data: claim, error: claimError } = await admin
    .from('provider_claims')
    .insert({
      provider_id: providerId,
      contact_email: email.trim(),
      contact_phone: phone?.trim() || null,
      uen: uen?.trim() || null,
      email_code_hash: hash(emailCode),
      phone_code_hash: phoneCode ? hash(phoneCode) : null,
      expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString(),
    })
    .select('id')
    .single();

  if (claimError || !claim) {
    return NextResponse.json({ error: 'Could not start verification' }, { status: 500 });
  }

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ error: 'Email delivery is not configured' }, { status: 503 });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error: sendError } = await resend.emails.send({
    from: process.env.EMAIL_FROM ?? 'BabyBrain <hello@updates.babybrain.sg>',
    replyTo: 'hello@babybrain.sg',
    to: email.trim(),
    subject: `Your BabyBrain verification code: ${emailCode}`,
    html: `
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;color:#1c2b61;max-width:520px">
        <h2 style="margin:0 0 12px">Verify ${provider.business_name}</h2>
        <p style="margin:0 0 16px">Enter this code on BabyBrain to confirm you manage this business:</p>
        <p style="font-size:34px;font-weight:700;letter-spacing:7px;color:#FA5D93;margin:0 0 16px">${emailCode}</p>
        <p style="margin:0 0 8px;color:#68718f">The code expires in ${CODE_TTL_MINUTES} minutes.</p>
        <p style="margin:0;color:#68718f">If you didn't request this, you can ignore this email — nothing changes.</p>
      </div>`,
  });

  if (sendError) {
    return NextResponse.json({ error: 'Could not send the email code — please try again.' }, { status: 502 });
  }

  // SMS is optional plumbing: wire an provider here (Twilio, MessageBird…) and
  // set SMS_FROM/SMS_API_KEY to switch the phone channel on.
  const smsConfigured = Boolean(process.env.SMS_API_KEY && process.env.SMS_FROM);

  return NextResponse.json({
    claim_id: claim.id,
    email_sent: true,
    // Deliberately explicit — the UI tells the vendor which channels to check.
    phone_sent: false,
    phone_channel: phoneCode
      ? smsConfigured
        ? 'pending'
        : 'unavailable'
      : 'not_requested',
    expires_in_minutes: CODE_TTL_MINUTES,
  });
}
