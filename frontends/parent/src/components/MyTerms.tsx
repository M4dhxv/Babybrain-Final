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
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!userId || !enabled) { setTerms([]); setGroupIds(new Set()); return; }
    const { data, error } = await termsDb
      .from("term_enrolments")
      .select("id, booking_group_id, child_id, price_cents, children(name), terms(name, activities(title, slug)), bookings(status, payment_status, activity_sessions(starts_at))")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
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
  return { terms, groupIds, reload: load };
}

const STATUS: Record<MyTerm["status"], { label: string; cls: string }> = {
  enrolled: { label: "Enrolled", cls: "bg-[#DDF3EE] text-[#0F6E56]" },
  unpaid: { label: "Awaiting payment", cls: "bg-[#FEF2D7] text-yellow-800" },
  withdrawn: { label: "Withdrawn", cls: "bg-[#F4EFF0] text-[#697390]" },
  finished: { label: "Finished", cls: "bg-[#F4EFF0] text-[#697390]" },
};

export function MyTermsList({ terms, onChanged }: { terms: MyTerm[]; onChanged: () => void }) {
  const [confirm, setConfirm] = useState<MyTerm | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (terms.length === 0) return null;

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
