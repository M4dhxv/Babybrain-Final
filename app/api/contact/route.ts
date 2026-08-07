import { NextResponse } from 'next/server';
import { Resend } from 'resend';

/**
 * Contact form on /contact — emails the support inbox.
 *
 * QA: "Bottom of contact page… could we add a contact form here which sends to
 * the e-mail?" Open to signed-out visitors by design, so it's rate-limited per
 * IP and the reply-to is set to the sender so support can just hit reply.
 */

const SUPPORT_INBOX = process.env.SUPPORT_EMAIL ?? 'hello@babybrain.sg';

// Small in-memory throttle: 5 messages per IP per 10 minutes. Good enough to
// stop casual abuse on a single instance; swap for a shared store if we scale
// the API out horizontally.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}

const esc = (v: string) =>
  v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export async function POST(request: Request) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "You've sent a few messages already — please email hello@babybrain.sg directly." },
      { status: 429 }
    );
  }

  const { name, email, subject, message } = (await request.json().catch(() => ({}))) as {
    name?: string;
    email?: string;
    subject?: string;
    message?: string;
  };

  if (!name?.trim() || !message?.trim()) {
    return NextResponse.json({ error: 'Name and message are required' }, { status: 400 });
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 });
  }
  if (message.length > 5000) {
    return NextResponse.json({ error: 'That message is too long' }, { status: 400 });
  }

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json(
      { error: 'Email is not configured — please write to hello@babybrain.sg.' },
      { status: 503 }
    );
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const heading = subject?.trim() ? esc(subject.trim()) : 'New contact form message';
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM ?? 'BabyBrain <hello@babybrain.sg>',
    to: SUPPORT_INBOX,
    replyTo: email.trim(),
    subject: `[Contact] ${heading}`,
    html: `
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#1c2b61">
        <h2 style="margin:0 0 12px">${heading}</h2>
        <p style="margin:0 0 4px"><strong>From:</strong> ${esc(name.trim())} &lt;${esc(email.trim())}&gt;</p>
        <p style="margin:0 0 16px;color:#68718f"><strong>Sent via:</strong> babybrain.sg contact form</p>
        <div style="white-space:pre-wrap;border-left:3px solid #FA5D93;padding-left:12px">${esc(message.trim())}</div>
      </div>`,
  });

  if (error) {
    return NextResponse.json(
      { error: "We couldn't send that just now — please email hello@babybrain.sg." },
      { status: 502 }
    );
  }

  return NextResponse.json({ sent: true });
}
