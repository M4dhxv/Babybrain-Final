import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiPost } from '@/lib/api';
import { PushPreferences } from '@/components/PushPreferences';
import { getPushState, subscribeToPush, unsubscribeFromPush, type PushState } from '@/lib/push';

/** Settings → Notifications: turn browser notifications on or off for this device, and send a test. */
export function PushSettings() {
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    getPushState().then(setState).catch(() => setState('unsupported'));
  }, []);

  async function toggle() {
    setBusy(true);
    setError(null);
    setTestMsg(null);
    try {
      setState(state === 'subscribed' ? await unsubscribeFromPush() : await subscribeToPush());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update your notification setting. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await apiPost<{ ok?: boolean; outcome?: string }>('/api/customer/push-test', {});
      setTestMsg(
        r.ok
          ? 'Sent. It should arrive on this device in a few seconds.'
          : r.outcome === 'no_devices'
            ? 'No device is subscribed yet. Turn notifications off and on again.'
            : "We couldn't deliver it. Turn notifications off and on again, then retry."
      );
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : "Couldn't send the test. Try again.");
    } finally {
      setTesting(false);
    }
  }

  const unavailable = state === 'unsupported';

  return (
    <div className="max-w-2xl bg-white rounded-xl border border-gray-200 p-6">
      <div className="mb-5 flex flex-col items-center gap-2 text-center sm:flex-row sm:items-center sm:gap-3 sm:text-left">
        <div className="w-10 h-10 rounded-xl bg-pink-50 flex items-center justify-center"><Bell className="w-5 h-5 text-[#FA4D8D]" /></div>
        <div>
          <h3 className="font-semibold text-gray-900">Notifications</h3>
          <p className="text-xs text-gray-500">Hear about new bookings and payouts on this device, even when the portal is closed.</p>
        </div>
      </div>

      {unavailable ? (
        <p className="text-sm text-gray-600">
          Notifications aren't available on this browser or aren't switched on for this site yet.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-gray-50 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">Browser notifications</p>
            <p className="mt-1 text-sm text-gray-600">
              {state === 'denied'
                ? 'Blocked in your browser settings. Allow notifications for this site there to turn this back on.'
                : state === 'needs-install'
                  ? 'On iPhone and iPad, add this site to your Home Screen to get notifications.'
                  : state === 'subscribed'
                    ? 'On for this device.'
                    : 'Off for this device.'}
            </p>
          </div>
          {state !== 'denied' && state !== 'loading' && state !== 'needs-install' && (
            <Button
              type="button"
              variant={state === 'subscribed' ? 'outline' : 'default'}
              size="sm"
              onClick={toggle}
              disabled={busy}
            >
              {busy ? 'Saving…' : state === 'subscribed' ? 'Turn off' : 'Turn on'}
            </Button>
          )}
        </div>
      )}

      {state === 'subscribed' && (
        <div className="mt-3">
          <button
            type="button"
            onClick={sendTest}
            disabled={testing}
            className="text-sm font-medium text-[#FA4D8D] hover:underline disabled:opacity-60"
          >
            {testing ? 'Sending…' : 'Send a test notification'}
          </button>
          {testMsg && <p className="mt-1 text-sm text-gray-600">{testMsg}</p>}
        </div>
      )}
      {state === 'subscribed' && <PushPreferences />}
      {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
    </div>
  );
}
