/**
 * Brand every Supabase Auth email.
 *
 * Two problems to fix, and they're separate:
 *   1. "comes from Supabase" — no custom SMTP is set, so Auth sends from
 *      Supabase's own shared sender. Fixed by pointing SMTP at Resend, using
 *      the already-verified updates.babybrain.sg domain.
 *   2. "isn't branded" — every template is Supabase's stock HTML. Fixed by
 *      writing the same layout lib/emails/render.ts uses for our own mail.
 *
 * These templates are Supabase's own — it renders them itself and never calls
 * our code, so they duplicate the layout in lib/emails/render.ts rather than
 * importing it. Change one, change the other.
 *
 * Run (dry by default — prints the plan and writes nothing):
 *
 *   SBP=<supabase management token> \
 *   RESEND_API_KEY=$(grep '^RESEND_API_KEY' .env.local | cut -d= -f2-) \
 *   node scripts/brand-supabase-auth-emails.mjs [--live]
 *
 * The management token comes from supabase.com/dashboard/account/tokens and is
 * never stored here. Re-running is safe and idempotent.
 *
 * Deliberately does NOT enable the send-email auth hook: that would route auth
 * mail through our own Vercel endpoint, so a missing RESEND_API_KEY there would
 * break sign-up and password reset outright. SMTP keeps auth mail working even
 * if the app is down.
 */
const SBP = process.env.SBP;
const RESEND = process.env.RESEND_API_KEY;
const REF = process.env.SUPA_REF || 'laftgypwwfevzggxknii';
const SITE = process.env.SITE_URL || 'https://babybrain-final.vercel.app';
const LIVE = process.argv.includes('--live');
if (!SBP) throw new Error('SBP (Supabase management token) is required');
if (!RESEND) throw new Error('RESEND_API_KEY is required');

const PINK = '#FA5D93';
const IG = 'https://www.instagram.com/babybrain.sg';

/* Mirrors layout() in lib/emails/render.ts: white ground, Fredoka-ish stack at
   18px/#767676, centred logo, left-aligned copy, footer with the wordmark,
   the Instagram line and its glyph. Kept as literal HTML here because Supabase
   renders these itself — it never calls our code. */
const layout = (inner) => `<div style="background:#FFFFFF;margin:0;padding:0">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:'Fredoka','Helvetica Neue',Arial,sans-serif;font-weight:300;font-size:18px;line-height:1.6;color:#767676">
    <div style="text-align:center;margin-bottom:28px">
      <img src="${SITE}/assets/brand/logo-stacked.png" alt="BabyBrain" width="150" style="max-width:150px;height:auto" />
    </div>
    <div style="text-align:left">${inner}</div>
    <div style="text-align:center;margin-top:40px;padding-top:24px;border-top:1px solid #eee">
      <img src="${SITE}/assets/brand/logo-horizontal.png" alt="BabyBrain" width="132" style="max-width:132px;height:auto;margin-bottom:12px" /><br/>
      <a href="${IG}" style="color:#767676;text-decoration:none;font-size:14px">Follow us on Instagram <img src="${SITE}/assets/brand/instagram.png" alt="Instagram" width="15" height="15" style="width:15px;height:15px;vertical-align:-2px;border:0" /></a>
      <div style="margin-top:10px;font-size:13px;color:#9a9a9a">
        <a href="${SITE}/profile" style="color:#9a9a9a">Update your profile</a> &nbsp;&middot;&nbsp;
        <a href="mailto:hello@babybrain.sg" style="color:#9a9a9a">hello@babybrain.sg</a>
      </div>
    </div>
  </div>
</div>`;

const p = (html) => `<p style="margin:0 0 16px">${html}</p>`;
const cta = (label) =>
  `<p style="margin:0 0 20px"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:${PINK};color:#ffffff;font-weight:600;font-size:16px;text-decoration:none;padding:14px 28px;border-radius:11px">${label}</a></p>`;
const fallback =
  `<p style="margin:0 0 16px;font-size:14px;color:#9a9a9a">Or paste this into your browser:<br/><span style="word-break:break-all">{{ .ConfirmationURL }}</span></p>`;
const code = () =>
  `<p style="margin:0 0 20px;font-size:30px;font-weight:700;letter-spacing:5px;color:#4a4a4a">{{ .Token }}</p>`;
const sign = `<p style="margin:24px 0 0">All the best,<br/>Katie<br/>Founder, BabyBrain</p>`;
const greet = `<p style="margin:0 0 16px">Hi there &#128075;</p>`;

// key -> { subject, html }
const T = {
  confirmation: {
    subject: 'Confirm your email 👶🧠',
    html: layout(greet +
      p('Welcome to BabyBrain! Just one step to go — confirm your email address and your profile is ready.') +
      cta('Confirm my email') +
      p('This link is valid for 24 hours. If you didn’t create a BabyBrain account you can safely ignore this email.') +
      fallback + sign),
  },
  recovery: {
    subject: 'Reset your password 👶🧠',
    html: layout(greet +
      p('We received a request to reset the password on your BabyBrain account.') +
      cta('Set a new password') +
      p('This link is valid for one hour. If you didn’t ask for this, nothing has changed — you can ignore this email.') +
      fallback + sign),
  },
  magic_link: {
    subject: 'Your BabyBrain log-in link 👶🧠',
    html: layout(greet +
      p('Here’s your link to log in — no password needed.') +
      cta('Log in to BabyBrain') +
      p('This link is valid for one hour and can only be used once.') +
      fallback + sign),
  },
  invite: {
    subject: 'You’re invited to BabyBrain 👶🧠',
    html: layout(greet +
      p('You’ve been invited to join BabyBrain — activities for little ones across Singapore, in one place.') +
      cta('Accept the invitation') +
      fallback + sign),
  },
  email_change: {
    subject: 'Confirm your new email 👶🧠',
    html: layout(greet +
      p('Please confirm <strong style="color:#4a4a4a">{{ .NewEmail }}</strong> so we can use it for your BabyBrain account.') +
      cta('Confirm new email') +
      p('If you didn’t request this change, please contact us at hello@babybrain.sg straight away.') +
      fallback + sign),
  },
  reauthentication: {
    subject: 'Your BabyBrain verification code 👶🧠',
    html: layout(greet +
      p('Use the code below to verify it’s really you.') +
      code() +
      p('The code expires shortly. If you didn’t ask for it, you can ignore this email.') + sign),
  },
  // Security notices. Disabled on the project today, but branded so they're
  // right if they're ever switched on.
  password_changed_notification: {
    subject: 'Your BabyBrain password was changed',
    html: layout(greet +
      p('The password on your BabyBrain account was just changed.') +
      p('If that was you, there’s nothing to do. If not, please email hello@babybrain.sg straight away.') + sign),
  },
  email_changed_notification: {
    subject: 'Your BabyBrain email address was changed',
    html: layout(greet +
      p('The email address on your BabyBrain account was changed to <strong style="color:#4a4a4a">{{ .NewEmail }}</strong>.') +
      p('If that wasn’t you, please email hello@babybrain.sg straight away.') + sign),
  },
};

const payload = {
  // ---- 1. sender: Resend SMTP on the verified subdomain ----
  smtp_host: 'smtp.resend.com',
  smtp_port: '587',
  smtp_user: 'resend',
  smtp_pass: RESEND,
  smtp_sender_name: 'BabyBrain',
  smtp_admin_email: 'hello@updates.babybrain.sg',
};
// ---- 2. branded templates + subjects ----
for (const [k, v] of Object.entries(T)) {
  payload[`mailer_subjects_${k}`] = v.subject;
  payload[`mailer_templates_${k}_content`] = v.html;
}

(async () => {
  console.log(`project ${REF}`);
  console.log(`sender   BabyBrain <hello@updates.babybrain.sg> via smtp.resend.com:587`);
  console.log(`branding ${Object.keys(T).length} templates:`);
  for (const [k, v] of Object.entries(T)) {
    console.log(`   ${k.padEnd(32)} "${v.subject}"  (${v.html.length} chars)`);
  }
  if (!LIVE) { console.log('\nDRY RUN — nothing written. Re-run with --live.'); return; }

  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/config/auth`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${SBP}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('\nFAILED', r.status, JSON.stringify(body).slice(0, 500));
    process.exit(1);
  }
  console.log('\nAPPLIED.');
  console.log('  smtp_host        =', body.smtp_host);
  console.log('  smtp_sender_name =', body.smtp_sender_name);
  console.log('  smtp_admin_email =', body.smtp_admin_email);
  const custom = body.mailer_templates_custom_contents || {};
  const on = Object.entries(custom).filter(([, v]) => v).map(([k]) => k.replace('MAILER_TEMPLATES_', '').replace('_CONTENT', '').toLowerCase());
  console.log('  custom templates =', on.join(', ') || '(none)');
})();
