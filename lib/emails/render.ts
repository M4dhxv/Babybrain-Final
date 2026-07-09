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
const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const str = (d: EmailData, k: string): string | undefined => {
  const v = d[k];
  return v == null || v === '' ? undefined : String(v);
};

const greet = (name?: string | null) => `Hi ${name ? esc(name) : 'there'} 👋`;
const p = (html: string) => `<p style="margin:0 0 16px">${html}</p>`;
const bold = (t: string) => `<strong style="color:#4a4a4a">${esc(t)}</strong>`;
const sign = `<p style="margin:24px 0 0">All the best,<br/>Katie<br/>Founder, BabyBrain</p>`;

const link = (ctx: EmailCtx, path: string, label: string) =>
  `<a href="${ctx.appUrl}${path}" style="color:${PINK};font-weight:400;text-decoration:underline">${esc(label)}</a>`;

/** Bold activity name + date/time / duration / address block, when present. */
function details(d: EmailData): string {
  const rows = [
    str(d, 'activity_name') ? bold(str(d, 'activity_name')!) : null,
    str(d, 'date_time'),
    str(d, 'duration'),
    str(d, 'address'),
    str(d, 'type'),
  ].filter(Boolean).map((r) => (r!.startsWith('<strong') ? r : esc(r!)));
  return rows.length ? `<p style="margin:0 0 16px">${rows.join('<br/>')}</p>` : '';
}

function layout(ctx: EmailCtx, inner: string): string {
  const { appUrl } = ctx;
  return `<div style="background:#FFFFFF;margin:0;padding:0">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:'Fredoka','Helvetica Neue',Arial,sans-serif;font-weight:300;font-size:18px;line-height:1.6;color:#767676">
    <div style="text-align:center;margin-bottom:28px">
      <img src="${appUrl}/assets/logo-full.png" alt="BabyBrain" width="120" style="max-width:120px;height:auto" />
    </div>
    <div style="text-align:left">${inner}</div>
    <div style="text-align:center;margin-top:40px;padding-top:24px;border-top:1px solid #eee">
      <img src="${appUrl}/assets/logo-full.png" alt="BabyBrain" width="96" style="max-width:96px;height:auto;margin-bottom:12px" /><br/>
      <a href="${IG_URL}" style="color:#767676;text-decoration:none;font-size:14px">Follow us on Instagram</a>
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

const PARENT_UPGRADE_BENEFITS = [
  'Suggested activities with availability each week based on saved preferences',
  'Packages & make-up tokens booked through BabyBrain saved in one place',
  'Messaging other parents booked on the same activity and subscribed vendors',
  'And more!',
];

// ---- template registry ----
type Template = (d: EmailData, ctx: EmailCtx) => RenderedEmail;

const T: Record<string, Template> = {
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
      sign),

  parent_welcome_paid: (d, ctx) =>
    wrap(ctx, 'Welcome to BabyBrain 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Welcome to BabyBrain!') +
      p('Our mission is to make it easier, simpler and faster for parents in Singapore to find &amp; book activities for their children.') +
      p(`If you haven’t already, you can start discovering what is available for your family’s specific needs and ${link(ctx, '/explore', 'booking activities here')}.`) +
      p(`Once you have ${link(ctx, '/profile', 'completed your profile')}, you will start receiving suggested activities with availability based on your preferences.`) +
      p('If you have any questions or requests, please do not hesitate to reply to this email and we will be sure to get back to you.') +
      sign),

  booking_confirmed: (d, ctx) =>
    wrap(ctx, 'Your booking is confirmed 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Your booking is confirmed as follows:') +
      details(d) +
      p('If you have any questions regarding the activity, please reach out to the provider directly. If you do not know how to do that, please reply to this email and we will be happy to help.') +
      p('We hope your family enjoys the activity when it comes!') +
      sign),

  booking_reminder: (d, ctx) =>
    wrap(ctx, 'You have an upcoming booking 👶🧠',
      p(greet(ctx.recipientName)) +
      p('Reminding you that your booking is coming up as follows:') +
      details(d) +
      p('If you have any questions regarding the activity, please reach out to the provider directly. If you do not know how to do that, please reply to this email and we will be happy to help.') +
      p('We hope your family enjoys the activity!') +
      sign),

  waitlist_available: (d, ctx) =>
    wrap(ctx, 'A spot has become available - book now! 👶🧠',
      p(greet(ctx.recipientName)) +
      p('A spot has come available for the following activity which you joined the waitlist for:') +
      details(d) +
      p(`${link(ctx, str(d, 'url') ?? '/explore', 'Book now')}, before someone else does!`) +
      p('If you have any questions regarding the activity, please reach out to the provider directly. If you do not know how to do that, please reply to this email and we will be happy to help.') +
      p(`We hope you secure the spot and enjoy the activity with your family! If it is no longer available, remember you can ${link(ctx, '/explore', 'explore other activities here')}.`) +
      sign),

  post_activity_checkin: (d, ctx) =>
    wrap(ctx, 'How was it? 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`We hope you enjoyed ${bold(str(d, 'activity_name') ?? 'your activity')}! If you would like to leave a review, you can do so ${link(ctx, str(d, 'url') ?? '/explore', 'here')}.`) +
      p(`If you loved the activity, do ${link(ctx, str(d, 'rebook_url') ?? '/explore', 're-book')} or if you’d like to try something new, you can ${link(ctx, '/explore', 'explore more activities here')}.`) +
      p('As always, if you have any questions or feedback, please do not hesitate to reply to this email.') +
      sign),

  missed_activity: (d, ctx) =>
    wrap(ctx, 'You were missed! 👶🧠',
      p(greet(ctx.recipientName)) +
      p(`We understand you missed ${bold(str(d, 'activity_name') ?? 'your activity')} so we wanted to check in and see if everything is ok.`) +
      sign),

  suggested_activities: (d, ctx) => {
    const list = Array.isArray(d.activities) ? (d.activities as EmailData[]) : [];
    const blocks = list.map((a) => details(a) + p(link(ctx, str(a, 'url') ?? '/explore', 'Book now'))).join('<hr style="border:none;border-top:1px solid #f0f0f0;margin:8px 0 16px"/>');
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
};

/** Aliases so existing DB-trigger type names resolve to the new templates. */
const ALIASES: Record<string, string> = {
  welcome: 'parent_welcome_free',
  class_followup: 'post_activity_checkin',
  waitlist_promoted: 'waitlist_available',
  support_message: 'message_response',
};

/** Returns the branded email for a notification type, or null if unmapped. */
export function renderEmail(type: string, data: EmailData, ctx: EmailCtx): RenderedEmail | null {
  const tpl = T[type] ?? T[ALIASES[type] ?? ''];
  return tpl ? tpl(data, ctx) : null;
}

export const EMAIL_TYPES = Object.keys(T);
