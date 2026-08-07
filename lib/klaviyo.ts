/**
 * Klaviyo integration.
 *
 * QA: "None of the Klaviyo e-mail flows are set up."
 *
 * Two halves to that job:
 *   1. Getting BabyBrain's data *into* Klaviyo — profiles and the events the
 *      flows trigger off. That's this file, and it runs automatically from the
 *      notification webhook.
 *   2. Building the flows themselves in the Klaviyo UI. That's done in Klaviyo
 *      against the metric names below; nothing here can create them.
 *
 * Set KLAVIYO_API_KEY (a private `pk_…` key) to switch this on. Without it
 * every call is a no-op, so nothing breaks in environments that don't use it.
 *
 * Metric names are stable — renaming one breaks the flow attached to it.
 */

const API = 'https://a.klaviyo.com/api';
const REVISION = '2024-10-15';

/** Notification type → Klaviyo metric name to build a flow against. */
export const KLAVIYO_METRICS: Record<string, string> = {
  welcome: 'Signed Up',
  parent_welcome_free: 'Signed Up',
  parent_welcome_paid: 'Upgraded To Plus',
  booking_confirmed: 'Booking Confirmed',
  booking_cancelled: 'Booking Cancelled',
  booking_reminder: 'Booking Reminder',
  waitlist_promoted: 'Waitlist Spot Opened',
  waitlist_available: 'Waitlist Spot Opened',
  class_followup: 'Class Attended',
  post_activity_checkin: 'Class Attended',
  make_up_token_issued: 'Make-Up Token Issued',
  package_purchased: 'Package Purchased',
  review_request: 'Review Requested',
  support_message: 'Support Reply Sent',
  message_response: 'Support Reply Sent',
  provider_booking_received: 'Provider Booking Received',
  provider_add_activities: 'Provider Nudge Add Activities',
};

const enabled = () => Boolean(process.env.KLAVIYO_API_KEY);

async function klaviyo(path: string, body: unknown): Promise<boolean> {
  if (!enabled()) return false;
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
        revision: REVISION,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    // Marketing analytics must never break a transactional send.
    return false;
  }
}

export interface KlaviyoProfile {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  properties?: Record<string, unknown>;
}

/** Create or update a Klaviyo profile (safe to call repeatedly). */
export async function upsertProfile(profile: KlaviyoProfile): Promise<boolean> {
  const [first, ...rest] = (profile.firstName ?? '').split(' ');
  return klaviyo('/profile-import', {
    data: {
      type: 'profile',
      attributes: {
        email: profile.email,
        first_name: first || undefined,
        last_name: profile.lastName ?? (rest.length ? rest.join(' ') : undefined),
        phone_number: profile.phone ?? undefined,
        properties: profile.properties ?? {},
      },
    },
  });
}

/**
 * Record an event a Klaviyo flow can trigger on. `metric` should come from
 * KLAVIYO_METRICS so the names stay in step with the configured flows.
 */
export async function trackEvent(params: {
  metric: string;
  email: string;
  name?: string | null;
  properties?: Record<string, unknown>;
}): Promise<boolean> {
  return klaviyo('/events', {
    data: {
      type: 'event',
      attributes: {
        properties: params.properties ?? {},
        metric: { data: { type: 'metric', attributes: { name: params.metric } } },
        profile: {
          data: {
            type: 'profile',
            attributes: {
              email: params.email,
              first_name: params.name?.split(' ')[0] || undefined,
            },
          },
        },
      },
    },
  });
}

/** Map a BabyBrain notification onto its Klaviyo metric, if one exists. */
export function metricFor(notificationType: string): string | null {
  return KLAVIYO_METRICS[notificationType] ?? null;
}

export const klaviyoEnabled = enabled;
