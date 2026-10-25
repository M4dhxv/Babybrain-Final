import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { Button, Icon } from "./ui";

/**
 * Profile → Overview → "Rate BabyBrain": a 1–5 star rating and an optional
 * comment about BabyBrain itself (QA: there was nowhere to review the
 * platform). It sits beside "Share BabyBrain", where parents already are,
 * and opens a dialog in the same frame as Reschedule / Cancel. One rating per
 * account, editable later; stored in platform_feedback (migration 00253) and
 * read by the team in /admin → Reviews. Activity reviews stay on each activity.
 *
 * Until 00253 is applied the read fails and the button stays hidden, so this
 * can ship ahead of the migration.
 */

type Saved = { rating: number; comment: string | null };
const LABELS = ["", "Poor", "Could be better", "Good", "Great", "Love it"];
const MAX_COMMENT = 2000;

function StarIcon({ filled, className = "h-9 w-9" }: { filled: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M12 2.8l2.83 5.73 6.33.92-4.58 4.46 1.08 6.3L12 17.24l-5.66 2.97 1.08-6.3L2.84 9.45l6.33-.92L12 2.8z"
        fill={filled ? "#FFBC1F" : "none"}
        stroke={filled ? "#FFBC1F" : "#D6CCD0"}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RateBabyBrainButton() {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  // undefined = still loading / unavailable (hidden); null = not rated yet.
  const [saved, setSaved] = useState<Saved | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    supabase
      .from("platform_feedback")
      .select("rating, comment")
      .eq("user_id", userId)
      .maybeSingle()
      .then(({ data, error: e }) => {
        if (!alive) return;
        if (e) return setSaved(undefined); // table not there yet: keep the button hidden
        setSaved(data);
      });
    return () => { alive = false; };
  }, [userId]);

  if (!userId || saved === undefined) return null;

  function show() {
    setRating(saved?.rating ?? 0);
    setComment(saved?.comment ?? "");
    setHover(0);
    setError(null);
    setThanks(false);
    setOpen(true);
  }
  const close = () => { if (!busy) setOpen(false); };

  async function submit() {
    if (!userId || rating < 1) return;
    setBusy(true);
    setError(null);
    const row = { user_id: userId, rating, comment: comment.trim() || null, updated_at: new Date().toISOString() };
    const { error: e } = await supabase
      .from("platform_feedback")
      .upsert(row, { onConflict: "user_id" });
    setBusy(false);
    if (e) {
      setError("Couldn't send your feedback just now. Please try again.");
      return;
    }
    setSaved({ rating, comment: row.comment });
    setThanks(true);
  }

  const shown = hover || rating;
  return (
    <>
      <Button type="button" variant="outline" onClick={show}>
        <Icon name="star" className="h-4 w-4" />
        {saved ? <>Your rating <span className="font-black">★ {saved.rating}</span></> : "Rate BabyBrain"}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={close}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="rate-title"
            className="flex w-full max-w-md flex-col rounded-[16px] bg-white shadow-card"
            onClick={(e) => e.stopPropagation()}
          >
            {thanks ? (
              <>
                <div className="px-5 pt-6 text-center sm:px-6">
                  <div className="flex justify-center gap-1" aria-label={`You rated BabyBrain ${rating} out of 5`}>
                    {[1, 2, 3, 4, 5].map((n) => <StarIcon key={n} filled={n <= rating} className="h-8 w-8" />)}
                  </div>
                  <h3 id="rate-title" className="mt-3 text-lg font-black">Thank you!</h3>
                  <p className="mt-1 text-sm font-semibold text-[#59658d]">
                    Your feedback goes straight to the BabyBrain team. You can change your rating here any time.
                  </p>
                </div>
                <div className="mt-5 border-t border-[#EBE3E5] px-5 py-4 sm:px-6">
                  <Button type="button" className="w-full" onClick={() => setOpen(false)}>Done</Button>
                </div>
              </>
            ) : (
              <>
                <div className="px-5 pt-5 sm:px-6 sm:pt-6">
                  <h3 id="rate-title" className="text-lg font-black">How are you finding BabyBrain?</h3>
                  <p className="mt-1 text-sm font-semibold text-[#59658d]">
                    Your rating goes to the BabyBrain team, not to any provider.
                  </p>
                </div>
                <div className="px-5 py-4 sm:px-6">
                  <div className="flex flex-col items-center" onMouseLeave={() => setHover(0)}>
                    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Your rating">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          role="radio"
                          aria-checked={rating === n}
                          aria-label={`${n} star${n === 1 ? "" : "s"}, ${LABELS[n]}`}
                          onClick={() => setRating(n)}
                          onMouseEnter={() => setHover(n)}
                          onFocus={() => setHover(n)}
                          onBlur={() => setHover(0)}
                          className="rounded-full p-0.5 transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-baby-pink"
                        >
                          <StarIcon filled={n <= shown} />
                        </button>
                      ))}
                    </div>
                    <p className="mt-1.5 h-5 text-sm font-bold text-[#3f4b78]" aria-live="polite">
                      {shown ? LABELS[shown] : "Tap a star to rate"}
                    </p>
                  </div>
                  <label className="mt-4 block">
                    <span className="text-sm font-black">Anything you&rsquo;d like to tell us? <span className="font-semibold text-[#6D748A]">(optional)</span></span>
                    <textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT))}
                      rows={3}
                      placeholder="What you love, what's missing, what could be easier…"
                      className="mt-2 w-full rounded-[10px] border border-[#FED7E4] px-3 py-2 text-sm font-semibold"
                    />
                  </label>
                  {error && <p className="mt-2 text-sm font-bold text-red-600">{error}</p>}
                </div>
                <div className="space-y-2 border-t border-[#EBE3E5] px-5 py-4 sm:px-6">
                  <Button
                    type="button"
                    className={`w-full ${rating < 1 ? "opacity-50" : ""}`}
                    disabled={busy || rating < 1}
                    onClick={() => void submit()}
                  >
                    {busy ? "Sending…" : saved ? "Update my rating" : "Send feedback"}
                  </Button>
                  <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={close}>
                    {saved ? "Cancel" : "Not now"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
