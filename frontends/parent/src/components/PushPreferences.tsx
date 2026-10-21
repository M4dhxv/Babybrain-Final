import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

type Prefs = { push_bookings: boolean; push_messages: boolean; push_reminders: boolean; push_suggestions: boolean };
const ALL_ON: Prefs = { push_bookings: true, push_messages: true, push_reminders: true, push_suggestions: true };

const ROWS: { key: keyof Prefs; title: string; copy: string }[] = [
  { key: "push_bookings", title: "Bookings and changes", copy: "Confirmations, cancellations, moved sessions and waitlist spots." },
  { key: "push_messages", title: "Messages", copy: "Replies from providers and BabyBrain Support." },
  { key: "push_reminders", title: "Reminders", copy: "Before a session starts, and asking how it went." },
  { key: "push_suggestions", title: "Suggested activities", copy: "Activities picked for your family, on Tuesdays and Thursdays." },
];

/**
 * Which kinds of push notification this parent wants (Settings → Notifications). Saved on the
 * account, so it applies to every device; emails are unaffected. No saved row means everything is on.
 * Hidden until the server answers, and stays hidden if it can't (preferences not set up yet).
 */
export function PushPreferences() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (supabase as unknown as SupabaseClient)
      .from("notification_preferences")
      .select("push_bookings, push_messages, push_reminders, push_suggestions")
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (cancelled || err) return;
        setPrefs((data as Prefs | null) ?? ALL_ON);
      });
    return () => { cancelled = true; };
  }, []);

  if (!prefs) return null;

  async function toggle(key: keyof Prefs) {
    if (!prefs) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next); // optimistic
    setError(null);
    const { error: err } = await (supabase.rpc as unknown as (
      fn: string,
      args: Record<string, boolean>
    ) => PromiseLike<{ error: { message: string } | null }>)("set_push_preferences", {
      p_bookings: next.push_bookings,
      p_messages: next.push_messages,
      p_reminders: next.push_reminders,
      p_suggestions: next.push_suggestions,
    });
    if (err) {
      setPrefs(prefs);
      setError("Couldn't save that. Try again in a moment.");
    }
  }

  return (
    <div className="mt-4 border-t border-[#F4EFF0] pt-4">
      <p className="text-sm font-black">What to notify me about</p>
      <div className="mt-2 space-y-3">
        {ROWS.map((r) => (
          <label key={r.key} className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={prefs[r.key]}
              onChange={() => void toggle(r.key)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[#FA4D8D]"
            />
            <span className="min-w-0">
              <span className="block text-sm font-black">{r.title}</span>
              <span className="block text-sm font-semibold text-[#59658d]">{r.copy}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="mt-2 text-sm font-bold text-red-600">{error}</p>}
    </div>
  );
}
