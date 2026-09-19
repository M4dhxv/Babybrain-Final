import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { apiGet, apiPost } from "../lib/api";
import { supabase } from "../lib/supabase";

/* A parent who picks Plus on the sign-up form has no session until they
 * confirm their email, so payment can't start there. The choice is kept on the
 * account (auth metadata `intended_plan`) and this picks it up once they're
 * back and signed in:
 *
 *   1. asks the server what plan they're on (authoritative, not the local
 *      cache) — if it's already Plus the intent is cleared and nothing happens;
 *   2. otherwise, once per browser session, sends them to Stripe Checkout;
 *   3. if they back out (or checkout fails) a persistent banner offers to
 *      continue, or to stay on Free ("Not now" clears the intent).
 *
 * The once-per-session guard is what stops a parent who cancels at Stripe from
 * being bounced straight back there. It never runs on the post-checkout return
 * (`billing=success`), where the webhook may not have flipped the plan yet. */

const attemptKey = (uid: string) => `bb-pending-plus:${uid}`;

export function PendingPlusGate() {
  const { session } = useAuth();
  const uid = session?.user.id;
  const meta = session?.user.user_metadata as { intended_plan?: string; intended_billing?: string } | undefined;
  const pending = !!uid && meta?.intended_plan === "plus";
  const billing = meta?.intended_billing === "annual" ? "annual" : "monthly";

  const [banner, setBanner] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startCheckout(): Promise<boolean> {
    try {
      const { url } = await apiPost<{ url?: string }>("/api/customer/stripe/subscription", { billing });
      if (url) {
        window.location.href = url;
        return true;
      }
      setError("We couldn't start payment just now. Please try again.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't start payment just now. Please try again.");
    }
    return false;
  }

  async function clearIntent() {
    await supabase.auth.updateUser({ data: { intended_plan: null, intended_billing: null } });
  }

  useEffect(() => {
    if (!pending || !uid) {
      setBanner(false);
      return;
    }
    // Just back from Stripe: the plan may not have landed yet, so leave it be.
    if (/[?&](billing=success|session_id=)/.test(window.location.search)) return;

    let cancelled = false;
    (async () => {
      let plan: string | undefined;
      try {
        plan = (await apiGet<{ plan?: string }>("/api/customer/stripe/subscription")).plan;
      } catch {
        // Can't tell — say nothing rather than nag someone who may be paid up.
        return;
      }
      if (cancelled) return;
      if (plan === "plus") {
        await clearIntent();
        return;
      }
      // Back from a cancelled Stripe checkout: show the banner, don't bounce
      // them straight into it again.
      let attempted = /[?&]billing=cancelled/.test(window.location.search);
      try {
        attempted = attempted || sessionStorage.getItem(attemptKey(uid)) === "1";
        if (!attempted) sessionStorage.setItem(attemptKey(uid), "1");
      } catch {
        attempted = true; // no storage: fall back to the banner, never a redirect loop
      }
      if (attempted) {
        setBanner(true);
        return;
      }
      setBusy(true);
      const redirected = await startCheckout();
      if (!redirected && !cancelled) {
        setBusy(false);
        setBanner(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, uid]);

  if (!pending || !banner) return null;

  return (
    <div
      role="region"
      aria-label="Finish upgrading to Plus"
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-[#F4C6D6] bg-white px-4 pt-3 shadow-[0_-4px_16px_rgba(17,26,76,0.08)]"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto flex max-w-[720px] flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-sm font-bold text-[#34406f]">
          You chose BabyBrain Plus when you signed up, but payment isn't complete yet. You're on the Free plan for now.
          {error && <span className="mt-1 block font-semibold text-[#C90044]">{error}</span>}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              if (!(await startCheckout())) setBusy(false);
            }}
            className="h-10 rounded-[10px] bg-[#FA4D8D] px-4 text-sm font-black text-white disabled:opacity-60"
          >
            {busy ? "One moment…" : "Continue to payment"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await clearIntent();
              setBanner(false);
              setBusy(false);
            }}
            className="h-10 rounded-[10px] border border-[#EBE3E5] bg-white px-4 text-sm font-black text-[#4a5685]"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
