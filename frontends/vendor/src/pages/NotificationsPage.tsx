import { formatDistanceToNow } from 'date-fns';
import { Link } from 'react-router-dom';
import { CalendarCheck, UserPlus, UserMinus, CalendarX, Star, Gift, Bell, ChevronRight, Ticket } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { useProviderQuery } from '@/lib/useProviderQuery';
import { ListRowsSkeleton, RefreshBar } from '@/components/Skeletons';
import { markNotificationsSeen } from '@/lib/notifications';
import { useEffect } from 'react';

type Event = {
  /** 'waitlist_left' (00247): a waitlist place was cancelled — never a booking, so not 'cancellation'. */
  kind: 'booking' | 'waitlist' | 'waitlist_left' | 'cancellation' | 'review' | 'token_issued' | 'credit_returned';
  event_at: string;
  actor_name: string;
  activity_title: string | null;
  detail: string | null;
  booking_id: string | null;
  session_id: string | null;
  activity_id: string | null;
  review_id: string | null;
  token_id: string | null;
};

const KIND_META: Record<Event['kind'], { icon: typeof Bell; color: string; bg: string }> = {
  booking: { icon: CalendarCheck, color: 'text-green-600', bg: 'bg-green-100' },
  waitlist: { icon: UserPlus, color: 'text-yellow-600', bg: 'bg-yellow-100' },
  waitlist_left: { icon: UserMinus, color: 'text-gray-600', bg: 'bg-gray-100' },
  cancellation: { icon: CalendarX, color: 'text-red-600', bg: 'bg-red-100' },
  review: { icon: Star, color: 'text-purple-600', bg: 'bg-purple-100' },
  token_issued: { icon: Gift, color: 'text-blue-600', bg: 'bg-blue-100' },
  credit_returned: { icon: Ticket, color: 'text-indigo-600', bg: 'bg-indigo-100' },
};
// A kind added to the feed later than this build: shown plainly instead of breaking the page.
const FALLBACK_META = { icon: Bell, color: 'text-gray-600', bg: 'bg-gray-100' };

function message(e: Event): string {
  switch (e.kind) {
    case 'booking':
      return `${e.actor_name} booked ${e.activity_title ?? 'a session'}.`;
    case 'waitlist':
      return `${e.actor_name} joined the waitlist for ${e.activity_title ?? 'an activity'}.`;
    case 'waitlist_left':
      // Neutral on purpose: the parent may have left, or been removed, or booked another way.
      return `${e.actor_name} is no longer on the waitlist for ${e.activity_title ?? 'an activity'}.`;
    case 'cancellation':
      return `${e.actor_name}'s booking for ${e.activity_title ?? 'a session'} was cancelled.`;
    case 'review':
      return `${e.actor_name} left a ${e.detail ?? '?'}★ review${e.activity_title ? ` on ${e.activity_title}` : ''}.`;
    case 'token_issued':
      // detail 'auto' (00255): given automatically for a cancelled booking.
      return e.detail === 'auto'
        ? `${e.actor_name} was given a make-up token for a cancelled booking${e.activity_title ? ` (${e.activity_title})` : ''}.`
        : `A make-up token was issued to ${e.actor_name}.`;
    case 'credit_returned':
      return `${e.actor_name}'s package credit was returned after cancelling ${e.activity_title ?? 'a session'}.`;
    default:
      return `${e.actor_name}${e.activity_title ? ` · ${e.activity_title}` : ''}`;
  }
}

/** Where an entry opens. Booking-type entries land on that slot's roster with
 *  the family highlighted. BookingsPage reads ?session= and ?booking= and
 *  picks the right tab / Cancelled filter from the booking's own status. */
function target(e: Event): string {
  if ((e.kind === 'booking' || e.kind === 'waitlist' || e.kind === 'waitlist_left' || e.kind === 'cancellation') && e.session_id) {
    const q = new URLSearchParams({ session: e.session_id });
    if (e.booking_id) q.set('booking', e.booking_id);
    return `/bookings?${q.toString()}`;
  }
  if (e.kind === 'review') return e.review_id ? `/reviews?review=${e.review_id}` : '/reviews';
  if ((e.kind === 'credit_returned' || (e.kind === 'token_issued' && e.detail === 'auto')) && e.session_id && e.booking_id) {
    return `/bookings?${new URLSearchParams({ session: e.session_id, booking: e.booking_id }).toString()}`;
  }
  if (e.kind === 'token_issued') return e.token_id ? `/make-up-tokens?token=${e.token_id}` : '/make-up-tokens';
  return '/bookings';
}

export default function NotificationsPage() {
  const { provider } = useAuth();
  const { data, loading, refreshing } = useProviderQuery<Event[]>(
    provider ? `notifications:${provider.id}` : null,
    async () => {
      const { data: rows } = await supabase.rpc('provider_notification_feed', {
        p_provider: provider!.id,
        p_limit: 50,
        // 00247: cancelled waitlist places come back as 'waitlist_left' only when asked, so a
        // portal built before that kind existed keeps getting 'cancellation' and never breaks.
        p_waitlist_left: true,
        // 00255: automatic make-up tokens and returned package credits, only when asked.
        p_compensation: true,
      });
      // Newest first. The feed RPC unions five kinds; sort here as well so the
      // page is right even before the ordering fix (00240) is applied.
      return ((rows ?? []) as Event[]).sort((a, b) => new Date(b.event_at).getTime() - new Date(a.event_at).getTime());
    },
  );
  const events = data ?? [];

  // Clears the sidebar's unread bubble — see lib/notifications.ts. Fires once
  // per mount (i.e. once per visit to this tab), not on every re-render.
  useEffect(() => {
    if (provider) markNotificationsSeen(provider.id);
  }, [provider]);

  return (
    <div className="relative">
      {refreshing && <RefreshBar />}
      <div className="flex items-center justify-between px-4 py-5 sm:px-8">
        <div className="w-full text-center sm:w-auto sm:text-left">
          <h1 className="text-2xl font-bold text-gray-900">Notifications</h1>
          <p className="text-sm text-gray-500 mt-1">Recent activity across your bookings, waitlist, reviews and tokens.</p>
        </div>
      </div>

      <div className="px-4 pb-8 sm:px-8">
        {loading && <ListRowsSkeleton count={6} lines={1} />}

        {!loading && (
          <div className="max-w-2xl rounded-xl border border-gray-200 bg-white">
            {events.map((e, i) => {
              const meta = KIND_META[e.kind] ?? FALLBACK_META;
              return (
                <Link
                  key={`${e.kind}-${e.event_at}-${i}`}
                  to={target(e)}
                  className={cn('group flex items-start gap-3 px-5 py-4 transition-colors hover:bg-gray-50', i > 0 && 'border-t border-gray-100')}
                >
                  <div className={cn('mt-0.5 grid h-8 w-8 flex-shrink-0 place-items-center rounded-full', meta.bg)}>
                    <meta.icon className={cn('h-4 w-4', meta.color)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900">{message(e)}</p>
                    <p className="mt-0.5 text-xs text-gray-500">{formatDistanceToNow(new Date(e.event_at), { addSuffix: true })}</p>
                  </div>
                  <ChevronRight className="mt-2 h-4 w-4 flex-shrink-0 text-gray-300 group-hover:text-gray-500" />
                </Link>
              );
            })}
            {events.length === 0 && (
              <div className="px-5 py-10 text-center text-sm text-gray-400">
                Nothing yet — new bookings, reviews and waitlist joins will show up here.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
