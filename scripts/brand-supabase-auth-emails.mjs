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
 * RESEND_API_KEY is optional: without it, only the branded templates/subjects
 * (and --urls, if passed) are applied, and the SMTP fields are left untouched
 * — the project keeps sending through Supabase's own shared mailer, which is
 * rate-limited but requires no Resend credential.
 *
 * For a non-production project (e.g. the test one), also pass --urls to set its
 * Site URL and Redirect URLs. Password-reset and confirm links only work when
 * the requesting site is on that list; a fresh project defaults to localhost.
 * With SBP and RESEND_API_KEY in a gitignored env file:
 *
 *   ENV_FILE=.env.test.local SUPA_REF=imlfhepnucytyajxpoum \
 *   SITE_URL=https://babybrain-test.vercel.app \
 *   node scripts/brand-supabase-auth-emails.mjs --urls [--live]
 *
 * Deliberately does NOT enable the send-email auth hook: that would route auth
 * mail through our own Vercel endpoint, so a missing RESEND_API_KEY there would
 * break sign-up and password reset outright. SMTP keeps auth mail working even
 * if the app is down.
 */
// Optional: read SBP / RESEND_API_KEY from a gitignored env file. Real env
// vars still win over the file.
if (process.env.ENV_FILE) process.loadEnvFile(process.env.ENV_FILE);
const SBP = process.env.SBP;
// Optional: without it, SMTP is left alone and only templates/subjects (and
// --urls, if passed) are applied — auth mail keeps going through Supabase's
// own shared sender and its default rate limit.
const RESEND = process.env.RESEND_API_KEY;
const PROD_REF = 'laftgypwwfevzggxknii';
const PROD_SITE = 'https://babybrain-final.vercel.app';
const REF = process.env.SUPA_REF || PROD_REF;
const SITE = process.env.SITE_URL || PROD_SITE;
const LIVE = process.argv.includes('--live');
// --urls also sets Site URL + Redirect URLs. Without it they are left alone, so
// re-running against production never changes where auth links point.
const URLS = process.argv.includes('--urls');
// --dump needs no token at all: writes subject+html per template to files for
// pasting into the dashboard by hand (Authentication > Emails), for when the
// account creating the token can't be granted project_admin_write.
const DUMP = process.argv.includes('--dump');
if (URLS && REF === PROD_REF && SITE.replace(/\/$/, '') !== PROD_SITE) {
  throw new Error(`Refusing --urls: production must keep Site URL ${PROD_SITE}`);
}
if (!DUMP && !SBP) throw new Error('SBP (Supabase management token) is required');

const PINK = '#FA5D93';
const IG = 'https://www.instagram.com/babybrainsg';

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
const cta = (label, url = '{{ .ConfirmationURL }}') =>
  `<p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:${PINK};color:#ffffff;font-weight:600;font-size:16px;text-decoration:none;padding:14px 28px;border-radius:11px">${label}</a></p>`;
const fallback = (url = '{{ .ConfirmationURL }}') =>
  `<p style="margin:0 0 16px;font-size:14px;color:#9a9a9a">Or paste this into your browser:<br/><span style="word-break:break-all">${url}</span></p>`;
// Recovery links point straight at the app with the hashed token, instead of
// at Supabase's /verify (which spends the token on the first GET). Mail
// scanners such as Microsoft Defender Safe Links open every link before the
// recipient does, so the /verify link was dead by the time a vendor clicked it.
// The app spends the token only when the user presses Continue (verifyOtp).
// Both reset pages handle `?token_hash=` — deploy them before applying this.
const RECOVERY_URL = '{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery';
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
      fallback() + sign),
  },
  recovery: {
    subject: 'Reset your password 👶🧠',
    html: layout(greet +
      p('We received a request to reset the password on your BabyBrain account.') +
      cta('Set a new password', RECOVERY_URL) +
      p('This link is valid for one hour. If you didn’t ask for this, nothing has changed — you can ignore this email.') +
      fallback(RECOVERY_URL) + sign),
  },
  magic_link: {
    subject: 'Your BabyBrain log-in link 👶🧠',
    html: layout(greet +
      p('Here’s your link to log in — no password needed.') +
      cta('Log in to BabyBrain') +
      p('This link is valid for one hour and can only be used once.') +
      fallback() + sign),
  },
  invite: {
    subject: 'You’re invited to BabyBrain 👶🧠',
    html: layout(greet +
      p('You’ve been invited to join BabyBrain — activities for little ones across Singapore, in one place.') +
      cta('Accept the invitation') +
      fallback() + sign),
  },
  email_change: {
    subject: 'Confirm your new email 👶🧠',
    html: layout(greet +
      p('Please confirm <strong style="color:#4a4a4a">{{ .NewEmail }}</strong> so we can use it for your BabyBrain account.') +
      cta('Confirm new email') +
      p('If you didn’t request this change, please contact us at hello@babybrain.sg straight away.') +
      fallback() + sign),
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

if (DUMP) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const outDir = process.env.DUMP_DIR || path.join(process.cwd(), '.auth-email-dump');
  fs.mkdirSync(outDir, { recursive: true });
  // key -> the label Supabase's dashboard uses under Authentication > Emails
  const DASHBOARD_NAME = {
    confirmation: 'Confirm signup',
    recovery: 'Reset password',
    magic_link: 'Magic Link',
    invite: 'Invite user',
    email_change: 'Change email address',
    reauthentication: 'Reauthentication',
    password_changed_notification: 'Password changed (Security notification — may not be editable in the UI yet)',
    email_changed_notification: 'Email changed (Security notification — may not be editable in the UI yet)',
  };
  console.log(`Writing templates to ${outDir}\n`);
  for (const [k, v] of Object.entries(T)) {
    const file = path.join(outDir, `${k}.html`);
    fs.writeFileSync(file, v.html, 'utf8');
    console.log(`${DASHBOARD_NAME[k] || k}`);
    console.log(`  subject: ${v.subject}`);
    console.log(`  body:    ${file}`);
  }
  console.log(`\nIn the Supabase dashboard: Authentication > Emails (per template) — paste the`);
  console.log(`Subject as shown, and the .html file's contents into the message body/source view.`);
  process.exit(0);
}

const payload = {};
// ---- 1. sender: Resend SMTP on the verified subdomain (only when a key is given) ----
if (RESEND) {
  payload.smtp_host = 'smtp.resend.com';
  payload.smtp_port = '587';
  payload.smtp_user = 'resend';
  payload.smtp_pass = RESEND;
  payload.smtp_sender_name = process.env.SMTP_SENDER_NAME || 'BabyBrain';
  // Must be on a domain verified under the account that owns RESEND_API_KEY —
  // defaults to production's verified domain, override for other accounts
  // (e.g. Resend's onboarding@resend.dev sandbox address).
  payload.smtp_admin_email = process.env.SMTP_ADMIN_EMAIL || 'hello@updates.babybrain.sg';
}
// ---- 1b. where auth links may point (only with --urls) ----
// Reset / magic-link / confirm links only work when the requesting site is the
// Site URL or matches the allow-list; otherwise Supabase falls back to Site URL,
// which is localhost:3000 on a fresh project.
if (URLS) {
  const base = SITE.replace(/\/$/, '');
  payload.site_url = base;
  payload.uri_allow_list = [base, `${base}/**`].join(',');
}
// ---- 2. branded templates + subjects ----
for (const [k, v] of Object.entries(T)) {
  payload[`mailer_subjects_${k}`] = v.subject;
  payload[`mailer_templates_${k}_content`] = v.html;
}

(async () => {
  console.log(`project ${REF}`);
  console.log(RESEND
    ? `sender   ${payload.smtp_sender_name} <${payload.smtp_admin_email}> via smtp.resend.com:587`
    : `sender   (unchanged — no RESEND_API_KEY given, Supabase's own mailer stays in place)`);
  if (URLS) console.log(`urls     site_url ${payload.site_url}  allow-list ${payload.uri_allow_list}`);
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
  if (RESEND) {
    console.log('  smtp_host        =', body.smtp_host);
    console.log('  smtp_sender_name =', body.smtp_sender_name);
    console.log('  smtp_admin_email =', body.smtp_admin_email);
  }
  if (URLS) {
    console.log('  site_url         =', body.site_url);
    console.log('  uri_allow_list   =', body.uri_allow_list);
  }
  const custom = body.mailer_templates_custom_contents || {};
  const on = Object.entries(custom).filter(([, v]) => v).map(([k]) => k.replace('MAILER_TEMPLATES_', '').replace('_CONTENT', '').toLowerCase());
  console.log('  custom templates =', on.join(', ') || '(none)');
})();
