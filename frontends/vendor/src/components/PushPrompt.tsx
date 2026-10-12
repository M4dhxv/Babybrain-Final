import { useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import {
  PUSH_CLOSE_MS,
  PUSH_NOT_NOW_MS,
  isPushSnoozed,
  loadPushConfig,
  pushAvailable,
  pushPermission,
  snoozePush,
  subscribeToPush,
  syncPushSubscription,
  usePushServerEnabled,
} from '@/lib/push';

/**
 * Asks a signed-in vendor to turn on notifications (new bookings, fully booked
 * sessions, payouts). A soft prompt: the browser's own dialog opens only when
 * they tap "Turn on". Shown only once the server confirms push is configured,
 * "Not now" hides it for 3 days and the cross for 24 hours; Settings →
 * Notifications always works. If permission was already granted it quietly
 * attaches this browser to the signed-in account.
 */
export function PushPrompt() {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const serverEnabled = usePushServerEnabled();
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void loadPushConfig(); }, []);
  useEffect(() => { if (userId) void syncPushSubscription(userId); }, [userId, serverEnabled]);

  const due = !!userId && serverEnabled && !dismissed && pushAvailable() && pushPermission() === 'default' && !isPushSnoozed();

  useEffect(() => {
    if (!due) { setOpen(false); return; }
    const t = window.setTimeout(() => setOpen(true), 2500);
    return () => window.clearTimeout(t);
  }, [due]);

  if (!open || !due) return null;

  const hide = (ms: number) => { snoozePush(ms); setDismissed(true); setOpen(false); };
  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      const state = await subscribeToPush();
      if (state === 'subscribed') { setDismissed(true); setOpen(false); return; }
      hide(PUSH_NOT_NOW_MS); // blocked, or the browser's dialog was closed unanswered
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't turn on notifications. Try again in Settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Turn on notifications"
      className="fixed bottom-4 right-4 z-40 w-[calc(100vw-2rem)] max-w-sm rounded-2xl border border-gray-200 bg-white p-4 shadow-lg"
    >
      <button
        type="button"
        onClick={() => hide(PUSH_CLOSE_MS)}
        aria-label="Close"
        className="absolute right-2.5 top-2.5 rounded p-1 text-gray-400 hover:text-gray-700"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex items-start gap-3 pr-6">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-pink-50">
          <Bell className="h-5 w-5 text-[#FA4D8D]" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Get new bookings the moment they land</h2>
          <p className="mt-1 text-sm text-gray-600">
            Turn on notifications to hear about new bookings, fully booked sessions and payouts, even when this tab is closed.
          </p>
        </div>
      </div>
      {error && <p className="mt-2 text-sm font-medium text-red-600">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={turnOn}
          disabled={busy}
          className="flex-1 rounded-lg bg-[#FA4D8D] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {busy ? 'Turning on…' : 'Turn on'}
        </button>
        <button
          type="button"
          onClick={() => hide(PUSH_NOT_NOW_MS)}
          className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
