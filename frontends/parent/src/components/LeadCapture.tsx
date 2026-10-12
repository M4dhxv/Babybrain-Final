import { useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { Button, Icon } from "./ui";

/** Same flag the Explore pop-up sets, so a visitor who has already left their
 *  email (or dismissed that pop-up) is not asked a second time. */
const LEAD_KEY = "bb_lead_captured";

function alreadyCaptured(): boolean {
  try {
    return !!localStorage.getItem(LEAD_KEY);
  } catch {
    return false;
  }
}

/** Email capture for the landing page. Visitors who are not logged in leave
 *  their email and it lands in `public.leads` (source "home-landing"), the same
 *  table as the Explore pop-up (migration 00028: anyone may insert, nobody can
 *  read it back through the API). Hidden for signed-in parents, whose email we
 *  already hold, and for anyone who has already submitted from this browser. */
export function LeadCapture() {
  const { session, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading || session || (!done && alreadyCaptured())) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { setError("Please enter a valid email."); return; }
    setBusy(true);
    setError(null);
    const { error: insertError } = await supabase.from("leads").insert({ email: value, source: "home-landing" });
    setBusy(false);
    if (insertError) { setError("Something went wrong. Please try again."); return; }
    try { localStorage.setItem(LEAD_KEY, "submitted"); } catch { /* private mode: fine */ }
    setDone(true);
  }

  return (
    <section className="bb-reveal mx-auto max-w-[1120px] px-6 py-4" style={{ animationDelay: "160ms" }}>
      <div className="grid items-center gap-5 rounded-[18px] border border-[#E9E1F5] bg-gradient-to-r from-[#F4F0FA] via-white to-[#FEEBF2] px-6 py-6 md:grid-cols-[1fr_380px] md:px-10">
        {done ? (
          <div className="md:col-span-2 text-center">
            <span className="mx-auto mb-2 grid h-12 w-12 place-items-center rounded-full bg-[#F1FBEF] text-[#A8E59A]"><Icon name="check" className="h-7 w-7" /></span>
            <h2 className="text-xl font-black">You&apos;re in!</h2>
            <p className="mt-1 text-sm font-semibold text-[#4e5982]">Thanks for joining. We&apos;ll be in touch with activities for your little one.</p>
          </div>
        ) : (
          <>
            <div>
              <h2 className="text-2xl font-black">Be the first to hear what&apos;s new</h2>
              <p className="mt-1 font-semibold text-[#4e5982]">Leave your email and we&apos;ll share new activities, classes and events for your little ones.</p>
            </div>
            <form onSubmit={submit} noValidate>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  aria-label="Email address"
                  autoComplete="email"
                  inputMode="email"
                  autoCapitalize="none"
                  className="h-12 min-w-0 flex-1 rounded-[12px] border border-[#EBE3E5] bg-white px-4 font-semibold shadow-card focus:border-baby-pink focus:outline-none"
                />
                <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Notify me"}</Button>
              </div>
              {error && <p role="alert" className="mt-2 text-sm font-semibold text-baby-cta">{error}</p>}
            </form>
          </>
        )}
      </div>
    </section>
  );
}
