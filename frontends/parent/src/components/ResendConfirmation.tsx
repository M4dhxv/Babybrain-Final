import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";

const COOLDOWN_SECONDS = 60;

/** "Didn't get the email?" — re-sends the sign-up confirmation with a cooldown so
 *  a nervous parent can't hammer the mail provider's rate limit. */
export function ResendConfirmation({ email, startCoolingDown = false }: { email: string; startCoolingDown?: boolean }) {
  const { resendConfirmation } = useAuth();
  const [wait, setWait] = useState(startCoolingDown ? COOLDOWN_SECONDS : 0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(t);
  }, [wait]);

  async function resend() {
    setBusy(true);
    setMessage(null);
    const { error } = await resendConfirmation(email);
    setBusy(false);
    if (error) {
      setMessage({
        ok: false,
        text: /rate|seconds|too many/i.test(error)
          ? "That was a bit quick — wait a minute and try again."
          : "We couldn't send it just now. Try again in a minute, or email hello@babybrain.sg and we'll get you set up.",
      });
      return;
    }
    setWait(COOLDOWN_SECONDS);
    setMessage({ ok: true, text: `Sent again to ${email}. It can take a couple of minutes — check spam too.` });
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={resend}
        disabled={busy || wait > 0}
        className="text-sm font-black text-baby-pink underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
      >
        {busy ? "Sending…" : wait > 0 ? `Resend email (${wait}s)` : "Resend confirmation email"}
      </button>
      {message && (
        <p role="status" className={`mt-2 text-sm font-semibold ${message.ok ? "text-[#44507b]" : "text-baby-cta"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
