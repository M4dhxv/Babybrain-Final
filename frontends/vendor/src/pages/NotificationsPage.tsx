import { useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { CalendarCheck, UserPlus, CalendarX, Star, Gift, Bell } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { RainbowLoader } from '@/components/ui/rainbow-loader';

type Event = {
  kind: 'booking' | 'waitlist' | 'cancellation' | 'review' | 'token_issued';
  event_at: string;
  actor_name: string;
  activity_title: string | null;
  detail: string | null;
};

const KIND_META: Record<Event['kind'], { icon: typeof Bell; color: string; bg: string }> = {
  booking: { icon: CalendarCheck, color: 'text-green-600', bg: 'bg-green-100' },
  waitlist: { icon: UserPlus, color: 'text-yellow-600', bg: 'bg-yellow-100' },
  cancellation: { icon: CalendarX, color: 'text-red-600', bg: 'bg-red-100' },
  review: { icon: Star, color: 'text-purple-600', bg: 'bg-purple-100' },
  token_issued: { icon: Gift, color: 'text-blue-600', bg: 'bg-blue-100' },
};

function message(e: Event): string {
  switch (e.kind) {
    case 'booking':
      return `${e.actor_name} booked ${e.activity_title ?? 'a session'}.`;
    case 'waitlist':
      return `${e.actor_name} joined the waitlist for ${e.activity_title ?? 'an activity'}.`;
    case 'cancellation':
      return `${e.actor_name}'s booking for ${e.activity_title ?? 'a session'} was cancelled.`;
    case 'review':
      return `${e.actor_name} left a ${e.detail ?? '?'}★ review${e.activity_title ? ` on ${e.activity_title}` : ''}.`;
    case 'token_issued':
      return `A make-up token was issued to ${e.actor_name}.`;
  }
}

export default function NotificationsPage() {
  const { provider } = useAuth();
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!provider) return;
    (async () => {
      setLoading(true);
      const { data } = await supabase.rpc('provider_notification_feed', { p_provider: provider.id, p_limit: 50 });
      setEvents((data ?? []) as Event[]);
      setLoading(false);
    })();
  }, [provider]);

  return (
    <div className="relative">
      <div className="flex items-center justify-between px-4 py-5 sm:px-8">
        <div className="w-full text-center sm:w-auto sm:text-left">
          <h1 className="text-2xl font-bold text-gray-900">Notifications</h1>
          <p className="text-sm text-gray-500 mt-1">Recent activity across your bookings, waitlist, reviews and tokens.</p>
        </div>
      </div>

      <div className="px-4 pb-8 sm:px-8">
        {loading && <RainbowLoader className="py-6" label="Loading notifications" />}

        {!loading && (
          <div className="max-w-2xl rounded-xl border border-gray-200 bg-white">
            {events.map((e, i) => {
              const meta = KIND_META[e.kind];
              return (
                <div
                  key={`${e.kind}-${e.event_at}-${i}`}
                  className={cn('flex items-start gap-3 px-5 py-4', i > 0 && 'border-t border-gray-100')}
                >
                  <div className={cn('mt-0.5 grid h-8 w-8 flex-shrink-0 place-items-center rounded-full', meta.bg)}>
                    <meta.icon className={cn('h-4 w-4', meta.color)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900">{message(e)}</p>
                    <p className="mt-0.5 text-xs text-gray-500">{formatDistanceToNow(new Date(e.event_at), { addSuffix: true })}</p>
                  </div>
                </div>
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
