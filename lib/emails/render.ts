/**
 * BabyBrain branded transactional email templates (per the "E-mail Flows" spec).
 *
 * Each notification `type` maps to a template that produces { subject, html }
 * from the notification's `data` payload. The webhook
 * (app/api/webhooks/notifications) looks the type up here and sends via Resend;
 * unknown types fall back to a generic layout so nothing ever fails to send.
 *
 * Format (from the spec): white background, Fredoka Light 300 / 18px / #767676,
 * centred logo, left-aligned copy, footer with wordmark + Instagram + profile /
 * unsubscribe links. Sender "Katie from BabyBrain <hello@babybrain.sg>",
 * reply-to hello@babybrain.sg (set by the sender, not here).
 */

const IG_URL = process.env.EMAIL_INSTAGRAM_URL ?? 'https://www.instagram.com/babybrain.sg';
const PINK = '#FA5D93';

export type EmailData = Record<string, unknown>;
export interface EmailCtx {
  appUrl: string;
  recipientName?: string | null;
}
export interface RenderedEmail {
  subject: string;
  html: string;
}

// ---- helpers ----
/** HTML-escape an untrusted value for interpolation into an email body. Exported
 *  so callers assembling their own fallback HTML (e.g. the notifications webhook)
 *  escape user-supplied fields the same way every template here already does. */
export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const str = (d: EmailData, k: string): string | undefined => {
  const v = d[k];
  return v == null || v === '' ? undefined : String(v);
};

const greet = (name?: string | null) => `Hi ${name ? esc(name) : 'there'} 👋`;
const p = (html: string) => `<p style="margin:0 0 16px">${html}</p>`;
const bold = (t: string) => `<strong style="color:#4a4a4a">${esc(t)}</strong>`;
const sign = `<p style="margin:24px 0 0">All the best,<br/>Katie<br/>Founder, BabyBrain</p>`;

// `path` is normally a root-relative path ("/activity?slug=…#reviews") that the
// notification producer supplies; prefix it with the app origin. If a caller
// (or a stale `data` payload) hands us a full URL, use it as-is rather than
// concatenating a second origin in front of it.
const link = (ctx: EmailCtx, path: string, label: string) =>
  `<a href="${/^https?:\/\//i.test(path) ? path : `${ctx.appUrl}${path}`}" style="color:${PINK};font-weight:400;text-decoration:underline">${esc(label)}</a>`;

/** Bold activity name + date/time / duration / address block, when present.
 *  `includeType` adds the provider's business name as a trailing line — the
 *  email-flows spec doesn't call for it on every template that uses this
 *  block (e.g. booking_confirmed lists just name/date/duration/address). */
function details(d: EmailData, includeType = true): string {
  const rows = [
    str(d, 'activity_name') ? bold(str(d, 'activity_name')!) : null,
    str(d, 'date_time'),
    str(d, 'duration'),
    str(d, 'address'),
    includeType ? str(d, 'type') : null,
  ].filter(Boolean).map((r) => (r!.startsWith('<strong') ? r : esc(r!)));
  return rows.length ? `<p style="margin:0 0 16px">${rows.join('<br/>')}</p>` : '';
}

/** Accent-rail activity card for suggested_activities — a pink-tinted fill
 *  with a solid left rail, chosen (option B of 4) over a plain detail list
 *  so a multi-activity digest reads as distinct picks rather than one long
 *  block of text. */
function activityCard(ctx: EmailCtx, a: EmailData): string {
  const name = str(a, 'activity_name');
  const metaLine = [str(a, 'date_time'), str(a, 'duration')].filter(Boolean).join(' · ');
  const metaRows = [metaLine, str(a, 'address'), str(a, 'type')].filter(Boolean).map((r) => esc(r!));
  const href = /^https?:\/\//i.test(str(a, 'url') ?? '') ? str(a, 'url')! : `${ctx.appUrl}${str(a, 'url') ?? '/explore'}`;
  return `<div style="background:#FCEFF4;border-left:4px solid ${PINK};border-radius:4px 10px 10px 4px;padding:16px 20px 18px 18px;margin:0 0 12px">
    ${name ? `<h3 style="margin:0 0 8px;font-size:16.5px;font-weight:600;color:#3a3a3a;font-family:'Fredoka','Helvetica Neue',Arial,sans-serif">${esc(name)}</h3>` : ''}
    ${metaRows.length ? `<div style="font-size:14.5px;color:#767676;line-height:1.75">${metaRows.join('<br/>')}</div>` : ''}
    <a href="${href}" style="display:inline-block;margin-top:10px;color:${PINK};font-weight:600;font-size:14.5px;text-decoration:none">Book now →</a>
  </div>`;
}

function layout(ctx: EmailCtx, inner: string): string {
  const { appUrl } = ctx;
  return `<div style="background:#FFFFFF;margin:0;padding:0">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:'Fredoka','Helvetica Neue',Arial,sans-serif;font-weight:300;font-size:18px;line-height:1.6;color:#767676">
    <div style="text-align:center;margin-bottom:28px">
      <img src="${appUrl}/assets/brand/logo-stacked.png" alt="BabyBrain" width="150" style="max-width:150px;height:auto" />
    </div>
    <div style="text-align:left">${inner}</div>
    <div style="text-align:center;margin-top:40px;padding-top:24px;border-top:1px solid #eee">
      <img src="${appUrl}/assets/brand/logo-horizontal.png" alt="BabyBrain" width="132" style="max-width:132px;height:auto;margin-bottom:12px" /><br/>
      <a href="${IG_URL}" style="color:#767676;text-decoration:none;font-size:14px">Follow us on Instagram <img src="${appUrl}/assets/brand/instagram.png" alt="Instagram" width="15" height="15" style="width:15px;height:15px;vertical-align:-2px;border:0" /></a>
      <div style="margin-top:10px;font-size:13px;color:#9a9a9a">
        <a href="${appUrl}/profile" style="color:#9a9a9a">Update your profile</a> &nbsp;·&nbsp;
        <a href="${appUrl}/profile?unsubscribe=1" style="color:#9a9a9a">Unsubscribe</a>
      </div>
    </div>
  </div>
</div>`;
}

const wrap = (ctx: EmailCtx, subject: string, inner: string): RenderedEmail => ({ subject, html: layout(ctx, inner) });

// Benefit bullet list used across welcome/nudge emails.
const bullets = (items: string[]) =>
  `<ul style="margin:0 0 16px;padding-left:20px">${items.map((i) => `<li style="margin:0 0 6px">${esc(i)}</li>`).join('')}</ul>`;

// Weekly suggested activities used to be listed here, but they ship on the free
// plan now, so naming them as a reason to upgrade no longer made sense.
const PARENT_UPGRADE_BENEFITS = [
  'Packages & make-up tokens booked through BabyBrain saved in one place',
  'Messaging other parents booked on the same activity and subscribed vendors',
  'And more!',
];

/** Big pink call-to-action button, for the auth emails. */
const cta = (href: string, label: string) =>
  `<p style="margin:0 0 20px"><a href="${href}" style="display:inline-block;background:${PINK};color:#ffffff;font-weight:600;font-size:16px;text-decoration:none;padding:14px 28px;border-radius:11px">${esc(label)}</a></p>`;

const fallbackLink = (href: string) =>
  `<p style="margin:0 0 16px;font-size:14px;color:#9a9a9a">Or paste this into your browser:<br/><span style="word-break:break-all">${esc(href)}</span></p>`;

// ---- template registry ----
type Template = (d: EmailData, ctx: EmailCtx) => RenderedEmail;

const T: Record<string, Template> = {
  // ————————————————— Account / auth —————————————————
  // These replace Supabase's default unbranded auth emails; they are sent by
  // app/api/auth/send-email (the Supabase "Send Email" auth hook).
  auth_confirm_signup: (d, ctx) =>
    wrap(ctx, 'Confirm your email 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Welcome to BabyBrain! Just one step to go — confirm your email address and your profile is ready.') +
      cta(str(d, 'action_url') ?? ctx.appUrl, 'Confirm my email') +
      p('This link is valid for 24 hours. If you didn’t create a BabyBrain account you can safely ignore this email.') +
      fallbackLink(str(d, 'action_url') ?? ctx.appUrl) +
      sign),

  auth_recovery: (d, ctx) =>
    wrap(ctx, 'Reset your password 👶🧠',
      p(greet(ctx.recipientName)) +
      p('We received a request to reset the password on your BabyBrain account.') +
      cta(str(d, 'action_url') ?? ctx.appUrl, 'Set a new password') +
      p('This link is valid for one hour. If you didn’t ask for this, nothing has changed — you can ignore this email.') +
      fallbackLink(str(d, 'action_url') ?? ctx.appUrl) +
      sign),

  auth_magic_link: (d, ctx) =>
    wrap(ctx, 'Your BabyBrain log-in link 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Here’s your link to log in — no password needed.') +
      cta(str(d, 'action_url') ?? ctx.appUrl, 'Log in to BabyBrain') +
      p('This link is valid for one hour and can only be used once.') +
      fallbackLink(str(d, 'action_url') ?? ctx.appUrl) +
      sign),

  auth_email_change: (d, ctx) =>
    wrap(ctx, 'Confirm your new email 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`Please confirm ${bold(str(d, 'new_email') ?? 'your new email address')} so we can use it for your BabyBrain account.`) +
      cta(str(d, 'action_url') ?? ctx.appUrl, 'Confirm new email') +
      p('If you didn’t request this change, please contact us at hello@babybrain.sg straight away.') +
      fallbackLink(str(d, 'action_url') ?? ctx.appUrl) +
      sign),

  auth_invite: (d, ctx) =>
    wrap(ctx, 'You’re invited to BabyBrain 👶🧠',
      p(greet(ctx.recipientName)) +
      p('You’ve been invited to join BabyBrain — activities for little ones across Singapore, in one place.') +
      cta(str(d, 'action_url') ?? ctx.appUrl, 'Accept the invitation') +
      fallbackLink(str(d, 'action_url') ?? ctx.appUrl) +
      sign),

  // ————————————————————— Consumers —————————————————————
  parent_welcome_free: (d, ctx) =>
    wrap(ctx, 'Welcome to BabyBrain 👶🧠',
      p(greet()) +
      p('Welcome to BabyBrain!') +
      p('Our mission is to make it easier, simpler and faster for parents in Singapore to find &amp; book activities for their children.') +
      p(`If you haven’t already, you can start discovering what is available for your family’s specific needs and ${link(ctx, '/explore', 'booking activities here')}.`) +
      p(`You can ${link(ctx, '/pricing', 'upgrade your plan')} at any time, to benefit from:`) +
      bullets(PARENT_UPGRADE_BENEFITS) +
      p('If you have any questions or requests, please do not hesitate to reply to this email and we will be sure to get back to you.') +
      p('We look forward to helping you create meaningful experiences for your little ones!') +
      sign),

  parent_welcome_paid: (d, ctx) =>
    wrap(ctx, 'Welcome to BabyBrain 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Welcome to BabyBrain!') +
      p('Our mission is to make it easier, simpler and faster for parents in Singapore to find &amp; book activities for their children.') +
      p(`If you haven’t already, you can start discovering what is available for your family’s specific needs and ${link(ctx, '/explore', 'booking activities here')}.`) +
      p(`Once you have ${link(ctx, '/profile', 'completed your profile')}, you will start receiving suggested activities with availability based on your preferences.`) +
      p('If you have any questions or requests, please do not hesitate to reply to this email and we will be sure to get back to you.') +
      p('We look forward to helping you create meaningful experiences for your little ones!') +
      sign),

  booking_confirmed: (d, ctx) =>
    wrap(ctx, 'Your booking is confirmed 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Your booking is confirmed as follows:') +
      details(d, false) +
      p('If you have any questions regarding the activity, please reach out to the provider directly. If you do not know how to do that, please reply to this email and we will be happy to help.') +
      p('We hope your family enjoys the activity when it comes!') +
      sign),

  booking_reminder: (d, ctx) =>
    wrap(ctx, 'You have an upcoming booking 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Reminding you that your booking is coming up as follows:') +
      details(d, false) +
      p('If you have any questions regarding the activity, please reach out to the provider directly. If you do not know how to do that, please reply to this email and we will be happy to help.') +
      p('We hope your family enjoys the activity!') +
      sign),

  waitlist_available: (d, ctx) =>
    wrap(ctx, 'A spot has become available - book now! 👶🧠',
      p(greet(ctx.recipientName)) +
      p('A spot has come available for the following activity which you joined the waitlist for:') +
      details(d, false) +
      p(`${link(ctx, str(d, 'url') ?? '/profile?tab=bookings', 'Book now')}, before someone else does!`) +
      p('If you have any questions regarding the activity, please reach out to the provider directly. If you do not know how to do that, please reply to this email and we will be happy to help.') +
      p(`We hope you secure the spot and enjoy the activity with your family! If it is no longer available, remember you can ${link(ctx, '/explore', 'explore other activities here')}.`) +
      sign),

  waitlist_confirmed: (d, ctx) =>
    wrap(ctx, 'You’re off the waitlist — you’re in! 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Good news — a spot opened up on the following activity and, as it was already paid for, your place is now confirmed:') +
      details(d) +
      p(`You can see it any time in ${link(ctx, str(d, 'url') ?? '/profile?tab=bookings', 'your bookings')}.`) +
      p('If you have any questions regarding the activity, please reach out to the provider directly. If you do not know how to do that, please reply to this email and we will be happy to help.') +
      p('We hope your family enjoys it!') +
      sign),

  // Fired only when a VENDOR cancels a class and a make-up token gets
  // issued as compensation (public.compensate_cancelled_booking, gated on
  // cancelled_by is not null) — distinct from the generic booking_cancelled
  // notification, which fires for any cancellation including a parent's own.
  class_cancelled: (d, ctx) =>
    wrap(ctx, 'Unfortunately your class has been cancelled 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`Unfortunately ${bold(str(d, 'activity_name') ?? 'your class')} has been cancelled. Any refund or make up token issuance follows the policy of ${bold(str(d, 'provider_name') ?? 'the provider')}.`) +
      p('As always, if you have any questions or feedback, please do not hesitate to reply to this email.') +
      sign),

  // Fired right after a package_purchases row is created (Stripe webhook /
  // /api/stripe/reconcile, lib/notify-package-purchased.ts). Free-tier
  // parents can't see Packages on /profile (PlusLock), so this is their only
  // way to know what they bought and how to use it.
  package_purchased: (d, ctx) =>
    wrap(ctx, 'Your package is ready to use 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`Thanks for your purchase! Your ${bold(str(d, 'package_name') ?? 'package')} with ${bold(str(d, 'provider_name') ?? 'your provider')} is ready — you have ${bold(str(d, 'credits') ?? 'your')} class credits to use.`) +
      p(`${link(ctx, str(d, 'url') ?? '/explore', 'Book your first class')} whenever you’re ready.`) +
      p('As always, if you have any questions or feedback, please do not hesitate to reply to this email.') +
      sign),

  // Fired by compensate_cancelled_booking()'s "Path 2" (migration 00081+,
  // url updated in 00126 to deep-link straight to booking rather than the
  // Plus-gated /profile?tab=makeup) whenever a paid/expired-pack booking is
  // cancelled and a make-up token is issued as compensation.
  make_up_token_issued: (d, ctx) =>
    wrap(ctx, 'Your make-up token is ready 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`Your cancelled booking for ${bold(str(d, 'activity_name') ?? 'a class')} has been replaced with a make-up token for ${bold(str(d, 'provider_name') ?? 'the provider')}. It doesn’t expire.`) +
      p(`${link(ctx, str(d, 'url') ?? '/profile?tab=makeup', 'Book another class with it')} whenever suits you.`) +
      p('As always, if you have any questions or feedback, please do not hesitate to reply to this email.') +
      sign),

  // Fired by compensate_cancelled_booking()'s "Path 0" when a booking made by
  // redeeming a make-up token is itself later cancelled — the token is
  // reinstated so it can be used again.
  make_up_token_returned: (d, ctx) =>
    wrap(ctx, 'Your make-up token is available again 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`Your make-up token for ${bold(str(d, 'provider_name') ?? 'the provider')} is back — the class it was booked on has been cancelled, so it’s free to use again.`) +
      p(`${link(ctx, str(d, 'url') ?? '/profile?tab=makeup', 'Book another class with it')} whenever suits you.`) +
      p('As always, if you have any questions or feedback, please do not hesitate to reply to this email.') +
      sign),

  // Fired by compensate_cancelled_booking()'s "Path 1" when a booking made
  // against a package credit is cancelled and the credit is returned.
  package_credit_returned: (d, ctx) =>
    wrap(ctx, 'Your package credit is back 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`Your credit for ${bold(str(d, 'activity_name') ?? 'a class')} is back on your ${bold(str(d, 'provider_name') ?? 'provider')} package — the booking it was used on has been cancelled.`) +
      p(`${link(ctx, str(d, 'url') ?? '/profile?tab=packages', 'Book another class with it')} whenever suits you.`) +
      p('As always, if you have any questions or feedback, please do not hesitate to reply to this email.') +
      sign),

  // notify_session_rescheduled (migration 00044/00126) fires when a vendor
  // changes a booked session's date/time or location — the in-app
  // notification's own title/body say what changed; this email stays
  // generic per the spec ("review the details") rather than restating it.
  session_rescheduled: (d, ctx) =>
    wrap(ctx, 'There has been a change to an activity you have booked 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`There has been some changes to your ${bold(str(d, 'activity_name') ?? 'activity')} booking. Please make sure you review the details ${link(ctx, str(d, 'url') ?? '/profile?tab=bookings', 'here')}.`) +
      p('As always, if you have any questions or feedback, please do not hesitate to reply to this email.') +
      sign),

  post_activity_checkin: (d, ctx) => {
    // The daily send_class_followups() cron writes `activity_name` (migration
    // 00090); name the session when it's there, and read naturally when it
    // isn't rather than falling back to a bare "your activity".
    const name = str(d, 'activity_name');
    return wrap(ctx, 'How was it? 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`We hope you enjoyed ${name ? bold(name) : 'your session'}! If you would like to leave a review, you can do so ${link(ctx, str(d, 'url') ?? '/explore', 'here')}.`) +
      p(`If you loved the activity, do ${link(ctx, str(d, 'rebook_url') ?? '/explore', 're-book')} or if you’d like to try something new, you can ${link(ctx, '/explore', 'explore more activities here')}.`) +
      p('As always, if you have any questions or feedback, please do not hesitate to reply to this email.') +
      sign);
  },

  missed_activity: (d, ctx) =>
    wrap(ctx, 'You were missed! 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`We understand you missed ${bold(str(d, 'activity_name') ?? 'your activity')} so we wanted to check in and see if everything is ok.`) +
      sign),

  suggested_activities: (d, ctx) => {
    const list = Array.isArray(d.activities) ? (d.activities as EmailData[]) : [];
    const blocks = list.map((a) => activityCard(ctx, a)).join('');
    return wrap(ctx, 'Here are your curated activities 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Below are some options for activities with availability in the next week that we think you’d love:') +
      (blocks || p('Log in to see this week’s suggestions.')) +
      p('As always, if you have any questions or feedback, please do not hesitate to reply to this email.') +
      sign);
  },

  package_token_reminder: (d, ctx) =>
    wrap(ctx, 'Don’t forget you have passes to use 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`As a reminder you have active passes which you can use to book activities. Take a look at what you have ${link(ctx, '/profile', 'here')}.`) +
      p('If you are unsure how to use these passes, please don’t hesitate to send us an email and we’d be happy to help.') +
      sign),

  message_response: (d, ctx) =>
    wrap(ctx, 'You’ve got a message 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`You have a response to a message you sent, ${link(ctx, '/login', 'log in')} to view it.`) +
      sign),

  unsubscribe_response: (d, ctx) =>
    wrap(ctx, 'We are sad to see you go 👶🧠',
      p(greet(ctx.recipientName)) +
      p('We are sad to see that you have decided to unsubscribe from BabyBrain. If you have a moment, we’d love if you could reply to this email sharing the reason behind this so that we can ensure we are continually improving the service we offer to parents in Singapore.') +
      p(`If you have unsubscribed by accident, you can ${link(ctx, '/pricing', 'resubscribe here')}.`) +
      p('Wishing you and your family all the best,<br/>Katie<br/>Founder, BabyBrain')),

  downgrade_response: (d, ctx) =>
    wrap(ctx, 'We are sad you have downgraded 👶🧠',
      p(greet(ctx.recipientName)) +
      p('We are sad to see that you have decided to downgrade your BabyBrain plan. If you have a moment, we’d love if you could reply to this email sharing the reason behind this so that we can ensure we are continually improving the service we offer to parents in Singapore.') +
      p(`If you have downgraded by accident, you can ${link(ctx, '/pricing', 'resubscribe here')}.`) +
      sign),

  upgrade_nudge: (d, ctx) =>
    wrap(ctx, 'We have more to offer! 👶🧠',
      p(greet()) +
      p(`Did you know that if you ${link(ctx, '/pricing', 'upgrade your plan')} you could benefit from:`) +
      bullets(PARENT_UPGRADE_BENEFITS) +
      p('We’d love to know if there is something else you would like to see. Drop us an email and we’ll let you know if we are already working on it or can add it to our to-do list!') +
      sign),

  providers_added: (d, ctx) =>
    wrap(ctx, 'We’ve added more vendors! 👶🧠',
      p(greet()) +
      p(`We’ve added more vendors to BabyBrain. ${link(ctx, '/explore', 'Check them out here')}.`) +
      p('Is there a provider you’d like to see who is currently not listed on BabyBrain? Reply to this email to let us know and we will look into it.') +
      sign),

  package_rebook: (d, ctx) =>
    wrap(ctx, 'Would you like to re-book your package? 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`We hope you loved your package with ${bold(str(d, 'provider_name') ?? 'your provider')}. If you would like to re-book you can do so ${link(ctx, str(d, 'url') ?? '/explore', 'here')}.`) +
      p(`If this activity no longer meets your little ones needs or you’d simply like to try something different, you can ${link(ctx, '/explore', 'explore other options here')}.`) +
      p('As always, if you have any questions or feedback, please do not hesitate to reply to this email.') +
      sign),

  // ————————————————————— Providers —————————————————————
  provider_welcome_free: (d, ctx) =>
    wrap(ctx, 'Welcome to BabyBrain 👶🧠',
      p(greet()) +
      p('Welcome to BabyBrain!') +
      p('Our mission is to make it easier, simpler and faster for you to manage and grow your business.') +
      p(`If you haven’t already, you can start adding more information and photos to your ${link(ctx, '/vendor', 'listing now')}.`) +
      p(`Want to increase the volume of bookings you receive? Research has shown that if a user is able to complete a transaction without leaving your website, they are more likely to book. ${link(ctx, '/vendor', 'Upgrade your plan')} at any time, to benefit from:`) +
      bullets(['Integrated availability, booking & waitlist management', 'Payment processing', 'Package and make-up token allocation', 'And more!']) +
      p('If you have any questions or requests, please do not hesitate to reply to this email and we will be sure to get back to you.') +
      sign),

  provider_welcome_growth: (d, ctx) =>
    wrap(ctx, 'Welcome to BabyBrain 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Welcome to BabyBrain!') +
      p('Our mission is to make it easier, simpler and faster for you to manage and grow your business.') +
      p(`If you haven’t already, you can start adding more information and photos to your ${link(ctx, '/vendor', 'listing now')}.`) +
      p(`Want to increase the volume of bookings you receive? ${link(ctx, '/vendor', 'Upgrade your plan')} at any time, to benefit from:`) +
      bullets(['Bi-weekly emails to target customers with availability prompting to book', 'Direct to user messaging', 'And more!']) +
      p('If you have any questions or requests, please do not hesitate to reply to this email and we will be sure to get back to you.') +
      sign),

  provider_welcome_pro: (d, ctx) =>
    wrap(ctx, 'Welcome to BabyBrain 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Welcome to BabyBrain!') +
      p('Our mission is to make it easier, simpler and faster for you to manage and grow your business.') +
      p(`If you haven’t already, you can start adding more information and photos to your ${link(ctx, '/vendor', 'listing now')}.`) +
      p(`Want to increase the volume of bookings you receive? ${link(ctx, '/vendor', 'Upgrade your plan')} at any time, to benefit from:`) +
      bullets(['Priority ranking', 'Featured placement', 'Performance analytics', 'And more!']) +
      p('If you have any questions or requests, please do not hesitate to reply to this email and we will be sure to get back to you.') +
      sign),

  provider_welcome_premium: (d, ctx) =>
    wrap(ctx, 'Welcome to BabyBrain 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Welcome to BabyBrain!') +
      p('Our mission is to make it easier, simpler and faster for you to manage and grow your business.') +
      p(`If you haven’t already, you can start adding more information and photos to your ${link(ctx, '/vendor', 'listing now')}.`) +
      p('If you have any questions or requests, please do not hesitate to reply to this email and we will be sure to get back to you.') +
      sign),

  provider_staff_invite: (d, ctx) =>
    wrap(ctx, `You’ve been invited to ${esc(str(d, 'business_name') ?? 'a business')} on BabyBrain 👶🧠`,
      p(greet(ctx.recipientName)) +
      p(`${bold(str(d, 'business_name') ?? 'A business')} has added you to their BabyBrain vendor account as ${esc(str(d, 'role') ?? 'a team member')}.`) +
      (str(d, 'set_password_url')
        ? cta(str(d, 'set_password_url')!, 'Set your password') +
          p('This link expires in 24 hours. If it lapses, use “Forgot password?” on the sign-in page with this email address.') +
          fallbackLink(str(d, 'set_password_url')!)
        : cta(str(d, 'sign_in_url') ?? ctx.appUrl, 'Sign in to the vendor portal')) +
      sign),

  provider_message_response: (d, ctx) =>
    wrap(ctx, 'You’ve got a message 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`You have a response to a message you sent, ${link(ctx, '/vendor', 'log in')} to view it.`) +
      sign),

  provider_unsubscribe_response: (d, ctx) =>
    wrap(ctx, 'We are sad to see you go 👶🧠',
      p(greet(ctx.recipientName)) +
      p('We are sad to see that you have decided to unsubscribe from BabyBrain. If you have a moment, we’d love if you could reply to this email sharing the reason behind this so that we can ensure we are continually improving the service we offer to providers in Singapore.') +
      p(`If you have unsubscribed by accident, you can ${link(ctx, '/vendor', 'resubscribe here')}.`) +
      sign),

  provider_downgrade_response: (d, ctx) =>
    wrap(ctx, 'We are sad you have downgraded 👶🧠',
      p(greet(ctx.recipientName)) +
      p('We are sad to see that you have decided to downgrade your BabyBrain plan. If you have a moment, we’d love if you could reply to this email sharing the reason behind this so that we can ensure we are continually improving the service we offer to providers in Singapore.') +
      p(`If you have downgraded by accident, you can ${link(ctx, '/vendor', 're-sign up here')}.`) +
      sign),

  provider_upgrade_free_to_growth: (d, ctx) =>
    wrap(ctx, 'We have more to offer! 👶🧠',
      p(greet()) +
      p(`Did you know that if you ${link(ctx, '/vendor', 'upgrade your plan')} you could benefit from:`) +
      bullets(['Integrated availability, booking & waitlist management', 'Payment processing', 'Package and make-up token allocation', 'And more!']) +
      p('We’d love to know if there is something else you would like to see. Drop us an email and we’ll let you know if we are already working on it or can add it to our to-do list!') +
      sign),

  provider_upgrade_growth_to_pro: (d, ctx) =>
    wrap(ctx, 'We have more to offer! 👶🧠',
      p(greet()) +
      p(`Did you know that if you ${link(ctx, '/vendor', 'upgrade your plan')} you could benefit from:`) +
      bullets(['Bi-weekly emails to target customers with availability prompting to book', 'Direct to user messaging', 'And more!']) +
      p('We’d love to know if there is something else you would like to see. Drop us an email and we’ll let you know if we are already working on it or can add it to our to-do list!') +
      sign),

  provider_upgrade_pro_to_premium: (d, ctx) =>
    wrap(ctx, 'We have more to offer! 👶🧠',
      p(greet()) +
      p(`Did you know that if you ${link(ctx, '/vendor', 'upgrade your plan')} you could benefit from:`) +
      bullets(['Priority ranking', 'Featured placement', 'Performance analytics', 'And more!']) +
      p('We’d love to know if there is something else you would like to see. Drop us an email and we’ll let you know if we are already working on it or can add it to our to-do list!') +
      sign),

  provider_booking_received: (d, ctx) =>
    wrap(ctx, 'You’ve had a booking 👶🧠',
      p(greet(ctx.recipientName)) +
      p('You have received a booking for the following activity:') +
      details(d) +
      p(`You have ${bold(str(d, 'spaces_left') ?? '0')} available spaces left for this activity.`) +
      sign),

  provider_add_activities: (d, ctx) =>
    wrap(ctx, 'Time to add to your schedule 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`Your schedule is looking a little light, please consider adding to it ${link(ctx, '/vendor', 'here')}.`) +
      p('If you are having any issues adding to your listing, please don’t hesitate to reach out for support.') +
      sign),

  // Inbound contact-form message, delivered to the BabyBrain inbox. It used to
  // be sent as a bare unstyled block; it now carries the same branding as every
  // other BabyBrain email. Reply-to is set to the sender by the route, so
  // replying from the inbox goes straight back to the parent.
  /* QA 21/08: "when claiming business, verification code e-mail is not
     BabyBrain branded — any customer facing e-mails need to be BabyBrain
     branded." The claim route hand-rolled its own HTML, so it was the one
     transactional email with no logo, no footer and the wrong typeface. */
  provider_claim_code: (d, ctx) =>
    wrap(ctx, `Your BabyBrain verification code: ${esc(str(d, 'code') ?? '')}`,
      p(greet(ctx.recipientName)) +
      p(`Enter this code on BabyBrain to confirm you manage ${bold(str(d, 'business_name') ?? 'this business')}:`) +
      `<p style="font-size:34px;font-weight:400;letter-spacing:7px;color:${PINK};margin:0 0 16px">${esc(str(d, 'code') ?? '')}</p>` +
      p(`The code expires in ${esc(str(d, 'expires_in_minutes') ?? '15')} minutes.`) +
      p('If you didn’t request this, you can ignore this email — nothing changes.') +
      sign),

  contact_received: (d, ctx) =>
    wrap(ctx, `[Contact] ${str(d, 'subject') ?? 'New contact form message'}`,
      p(bold(str(d, 'subject') ?? 'New contact form message')) +
      p(`<strong style="color:#4a4a4a">From:</strong> ${esc(str(d, 'from_name') ?? '')} ` +
        `&lt;${esc(str(d, 'from_email') ?? '')}&gt;<br/>` +
        `<strong style="color:#4a4a4a">Sent via:</strong> babybrain.sg contact form`) +
      `<div style="white-space:pre-wrap;border-left:3px solid ${PINK};padding-left:12px;margin:0 0 16px">${esc(str(d, 'message') ?? '')}</div>`),
};

/** Aliases so existing DB-trigger type names resolve to the new templates. */
const ALIASES: Record<string, string> = {
  welcome: 'parent_welcome_free',
  class_followup: 'post_activity_checkin',
  // The DB now distinguishes the two waitlist outcomes (migration 00083): a
  // seat that is free to book (`waitlist_available`, its own type) versus one
  // the parent has already paid for and is simply now confirmed on
  // (`waitlist_promoted`). Before 00083 everything came through as
  // `waitlist_promoted` and got the "book now" copy even though the booking
  // had already been auto-confirmed, which read as a mistake to the parent.
  waitlist_promoted: 'waitlist_confirmed',
  support_message: 'message_response',
  // A reply on a parent↔provider chat (app/api/webhooks/stream/route.ts)
  // inserts this type for the parent — it had no template or alias at all,
  // so it silently fell through to the generic unbranded fallback email
  // instead of "You've got a message" like every other reply notification.
  provider_message: 'message_response',
};

/** Returns the branded email for a notification type, or null if unmapped. */
export function renderEmail(type: string, data: EmailData, ctx: EmailCtx): RenderedEmail | null {
  const tpl = T[type] ?? T[ALIASES[type] ?? ''];
  return tpl ? tpl(data, ctx) : null;
}

export const EMAIL_TYPES = Object.keys(T);
