import { useCallback, useEffect, useState } from "react";
import { apiPost } from "../lib/api";
import { cleanRpcErrorMessage } from "../lib/errors";
import { sgDateTime, sgDay } from "../lib/schedule";
import { termsDb } from "../lib/terms";

/**
 * The parent's term enrolments (00243 / 00244), one card each, on the Bookings
 * tab. A term's seats are ordinary bookings sharing the enrolment's
 * booking_group_id; the page leaves those groups out of its session list
 * (`groupIds`) so a 20-session term is one card, not a card listing the child
 * 20 times.
 */

export type MyTerm = {
  id: string;
  groupId: string;
  termName: string;
  activityTitle: string;
  slug: string;
  childId: string | null;
  childName: string;
  priceCents: number;
  total: number;
  attended: number;
  left: number;
  next: string | null;
  last: string | null;
  status: "enrolled" | "unpaid" | "withdrawn" | "finished";
};

/** A place on a full term group's waitlist (00260), from my_term_waitlist(). */
export type MyTermWait = {
  id: string;
  status: "waiting" | "holding";
  slot_id: string;
  term_name: string;
  activity_title: string;
  slug: string;
  child_id: string | null;
  child_name: string | null;
  next_session: string | null;
  sessions_left: number;
  price_cents: number;
  joinable: boolean;
  free_places: number;
  /** The child has since got into another group of the same term. */
  enrolled_elsewhere: boolean;
  /** The provider offered this family a place, which may go over capacity (00261). */
  vendor_offered?: boolean;
};

type Row = {
  id: string;
  booking_group_id: string;
  child_id: string | null;
  price_cents: number;
  children: { name: string } | null;
  terms: { name: string; activities: { title: string; slug: string } | null } | null;
  bookings: { status: string; payment_status: string; activity_sessions: { starts_at: string } | null }[];
};

export function useMyTerms(userId: string | null | undefined, enabled: boolean) {
  const [terms, setTerms] = useState<MyTerm[]>([]);
  const [waiting, setWaiting] = useState<MyTermWait[]>([]);
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!userId || !enabled) { setTerms([]); setWaiting([]); setGroupIds(new Set()); return; }
    const [{ data, error }, { data: wait }] = await Promise.all([
      termsDb
        .from("term_enrolments")
        .select("id, booking_group_id, child_id, price_cents, children(name), terms(name, activities(title, slug)), bookings(status, payment_status, activity_sessions(starts_at))")
        .eq("user_id", userId)
        .order("created_at", { ascending: false }),
      termsDb.rpc("my_term_waitlist"),
    ]);
    setWaiting((wait ?? []) as MyTermWait[]);
    if (error || !data) return;
    const now = Date.now();
    const rows = data as unknown as Row[];
    setGroupIds(new Set(rows.map((r) => r.booking_group_id)));
    setTerms(
      rows
        .map((r): MyTerm => {
          const live = r.bookings.filter((b) => b.status !== "cancelled" && b.activity_sessions);
          const starts = live.map((b) => b.activity_sessions!.starts_at).sort();
          const future = starts.filter((s) => Date.parse(s) > now);
          const status: MyTerm["status"] =
            live.length === 0 ? "withdrawn"
            : live.some((b) => b.status === "pending") ? "unpaid"
            : future.length === 0 ? "finished"
            : "enrolled";
          return {
            id: r.id,
            groupId: r.booking_group_id,
            termName: r.terms?.name ?? "Term",
            activityTitle: r.terms?.activities?.title ?? "",
            slug: r.terms?.activities?.slug ?? "",
            childId: r.child_id,
            childName: r.children?.name ?? "Your child",
            priceCents: r.price_cents,
            total: starts.length,
            attended: starts.length - future.length,
            left: future.length,
            next: future[0] ?? null,
            last: starts[starts.length - 1] ?? null,
            status,
          };
        })
        // Withdrawn before it started, or an abandoned checkout that expired: nothing to show.
        .filter((t) => t.status !== "withdrawn" || t.attended > 0),
    );
  }, [userId, enabled]);

  useEffect(() => { void load(); }, [load]);
  return { terms, waiting, groupIds, reload: load };
}

// "Stay on this waitlist" (decision 3) is remembered on this device so the
// question isn't asked on every visit. Nothing depends on it surviving.
const STAY_KEY = "bb_term_wait_stay_v1";
function stayedIds(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(STAY_KEY) ?? "[]") as string[]); } catch { return new Set(); }
}
function rememberStay(id: string) {
  try { localStorage.setItem(STAY_KEY, JSON.stringify([...stayedIds(), id])); } catch { /* private mode */ }
}

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

/** The parent's places on full term groups' waitlists (00260). */
function TermWaitCards({ waiting, onChanged }: { waiting: MyTermWait[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stayed, setStayed] = useState<Set<string>>(() => stayedIds());

  async function leave(w: MyTermWait) {
    setBusy(true);
    setErr(null);
    const { error } = await termsDb.rpc("leave_term_waitlist_entry", { p_entry_id: w.id });
    setBusy(false);
    if (error) { setErr(cleanRpcErrorMessage(error)); return; }
    onChanged();
  }

  return (
    <div className="space-y-3">
      {err && <p className="rounded-[10px] bg-[#FAF7F7] px-4 py-2.5 text-sm font-bold text-[#59658d]">{err}</p>}
      {waiting.map((w) => {
        const child = w.child_name ?? "Your child";
        const offered = w.status === "waiting" && w.joinable && !!w.vendor_offered;
        const enrolHref = `/book?slug=${encodeURIComponent(w.slug)}&term_slot=${encodeURIComponent(w.slot_id)}&mode=term${w.child_id ? `&child=${encodeURIComponent(w.child_id)}` : ""}${offered ? "&offered=1" : ""}`;
        const placeFree = w.status === "waiting" && w.joinable && (w.free_places > 0 || offered);
        const askStay = w.enrolled_elsewhere && !stayed.has(w.id);
        return (
          <div key={w.id} className="rounded-[16px] border border-[#EBE3E5] bg-white p-4 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <a href={w.slug ? `/activity?slug=${encodeURIComponent(w.slug)}` : undefined} className="font-black text-[#34406f] hover:underline">
                  {w.term_name}
                </a>
                <p className="text-sm font-semibold text-[#59658d]">{w.activity_title} · {child}</p>
              </div>
              <span className="rounded-full bg-[#FEF2D7] px-2.5 py-0.5 text-[11px] font-black text-yellow-800">
                {w.status === "holding" ? "Holding a place" : "Waiting for a place"}
              </span>
            </div>
            <p className="mt-2 text-sm font-semibold text-[#59658d]">
              {w.next_session ? `Group from ${sgDateTime(w.next_session)}. ` : ""}
              {!w.joinable
                ? "This term has closed to new families."
                : w.status === "holding"
                  ? "You're enrolling now. Finish paying under Terms to keep the place."
                  : `If you got a place today: ${w.sessions_left} sessions, ${money(w.price_cents)}.`}
            </p>
            {askStay && (
              <div className="mt-3 rounded-[12px] border border-[#F3C2D3] bg-[#FFF5F8] p-3">
                <p className="text-sm font-bold text-[#34406f]">{child} is now enrolled in another group of {w.term_name}. Stay on this waitlist too?</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" disabled={busy} onClick={() => leave(w)} className="rounded-full bg-[#FA4D8D] px-4 py-1.5 text-sm font-black text-white disabled:opacity-60">
                    Leave this waitlist
                  </button>
                  <button type="button" onClick={() => { rememberStay(w.id); setStayed(new Set(stayed).add(w.id)); }} className="rounded-full border border-[#DCD2D5] px-4 py-1.5 text-sm font-black text-[#34406f]">
                    Stay on it
                  </button>
                </div>
              </div>
            )}
            {placeFree && (
              <div className="mt-3 flex flex-col gap-1.5 rounded-[12px] bg-[#F1FBEF] p-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-bold text-palette-greenInk">
                  {offered ? "The provider has offered you a place. Enrol and pay to confirm it." : "A place is free. The first family to enrol gets it."}
                </p>
                <a href={enrolHref} className="rounded-full bg-[#FA4D8D] px-4 py-2 text-center text-sm font-black text-white">Enrol now</a>
              </div>
            )}
            {!askStay && w.status === "waiting" && (
              <div className="mt-3">
                <button type="button" disabled={busy} onClick={() => leave(w)} className="rounded-full border border-[#DCD2D5] px-4 py-2 text-sm font-black text-[#34406f] disabled:opacity-60">
                  Leave waitlist
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const STATUS: Record<MyTerm["status"], { label: string; cls: string }> = {
  enrolled: { label: "Enrolled", cls: "bg-[#DDF3EE] text-[#0F6E56]" },
  unpaid: { label: "Awaiting payment", cls: "bg-[#FEF2D7] text-yellow-800" },
  withdrawn: { label: "Withdrawn", cls: "bg-[#F4EFF0] text-[#697390]" },
  finished: { label: "Finished", cls: "bg-[#F4EFF0] text-[#697390]" },
};

export function MyTermsList({ terms, waiting = [], onChanged }: { terms: MyTerm[]; waiting?: MyTermWait[]; onChanged: () => void }) {
  const [confirm, setConfirm] = useState<MyTerm | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (terms.length === 0 && waiting.length === 0) return null;

  async function withdraw(t: MyTerm) {
    setBusy(true);
    setErr(null);
    const { data, error } = await termsDb.rpc("withdraw_from_term", { p_enrolment_id: t.id });
    setBusy(false);
    if (error) { setErr(cleanRpcErrorMessage(error)); return; }
    setConfirm(null);
    setErr(`${t.childName} has been withdrawn. ${Number(data)} upcoming session${Number(data) === 1 ? "" : "s"} cancelled.`);
    onChanged();
  }

  async function pay(t: MyTerm) {
    setBusy(true);
    setErr(null);
    try {
      const { url } = await apiPost<{ url?: string }>("/api/terms/checkout", { group_id: t.groupId });
      if (url) { window.location.href = url; return; }
    } catch {
      setErr("Could not start payment — please try again.");
    }
    setBusy(false);
  }

  return (
    <section className="mb-6">
      <h2 className="mb-3 text-[19px] font-black">Terms</h2>
      {err && <p className="mb-3 rounded-[10px] bg-[#FAF7F7] px-4 py-2.5 text-sm font-bold text-[#59658d]">{err}</p>}
      {waiting.length > 0 && (
        <div className={terms.length > 0 ? "mb-3" : ""}>
          <TermWaitCards waiting={waiting} onChanged={onChanged} />
        </div>
      )}
      <div className="space-y-3">
        {terms.map((t) => (
          <div key={t.id} className="rounded-[16px] border border-[#EBE3E5] bg-white p-4 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <a href={t.slug ? `/activity?slug=${encodeURIComponent(t.slug)}` : undefined} className="font-black text-[#34406f] hover:underline">
                  {t.termName}
                </a>
                <p className="text-sm font-semibold text-[#59658d]">{t.activityTitle} · {t.childName}</p>
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-black ${STATUS[t.status].cls}`}>{STATUS[t.status].label}</span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[
                { k: "Done", v: t.attended },
                { k: "To go", v: t.left },
                { k: "Total", v: t.total },
              ].map((c) => (
                <div key={c.k} className="rounded-[10px] bg-[#FAF7F7] py-2">
                  <div className="text-lg font-black text-[#34406f]">{c.v}</div>
                  <div className="text-[11px] font-bold text-[#697390]">{c.k}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#F4EFF0]">
              <div className="h-full rounded-full bg-[#FA4D8D]" style={{ width: `${t.total ? Math.round((t.attended / t.total) * 100) : 0}%` }} />
            </div>
            <p className="mt-3 text-sm font-semibold text-[#59658d]">
              {t.next ? `Next class ${sgDateTime(t.next)}` : t.last ? `Last class was ${sgDay(t.last)}` : ""}
            </p>
            {(t.status === "unpaid" || t.status === "enrolled") && (
              <div className="mt-3 flex flex-wrap gap-2">
                {t.status === "unpaid" && (
                  <button type="button" disabled={busy} onClick={() => pay(t)} className="rounded-full bg-[#FA4D8D] px-4 py-2 text-sm font-black text-white disabled:opacity-60">
                    Pay ${(t.priceCents / 100).toFixed(2)}
                  </button>
                )}
                {t.left > 0 && (
                  <button type="button" disabled={busy} onClick={() => setConfirm(t)} className="rounded-full border border-[#DCD2D5] px-4 py-2 text-sm font-black text-[#34406f] disabled:opacity-60">
                    Withdraw from term
                  </button>
                )}
              </div>
            )}
            {confirm?.id === t.id && (
              <div className="mt-3 rounded-[12px] border border-[#F3C2D3] bg-[#FFF5F8] p-3">
                <p className="text-sm font-bold text-[#34406f]">
                  Withdraw {t.childName} from {t.termName}? Their upcoming sessions are cancelled under the provider's
                  cancellation policy. Sessions inside the cancellation window stay booked.
                </p>
                <div className="mt-2 flex gap-2">
                  <button type="button" disabled={busy} onClick={() => withdraw(t)} className="rounded-full bg-[#C90044] px-4 py-1.5 text-sm font-black text-white disabled:opacity-60">
                    Withdraw
                  </button>
                  <button type="button" onClick={() => setConfirm(null)} className="rounded-full border border-[#DCD2D5] px-4 py-1.5 text-sm font-black text-[#34406f]">
                    Keep
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
