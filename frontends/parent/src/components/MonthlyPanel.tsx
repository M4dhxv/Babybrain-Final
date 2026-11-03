import { useEffect, useState } from "react";
import { Button, Icon } from "./ui";
import { cleanRpcErrorMessage } from "../lib/errors";
import { getParam } from "../lib/nav";
import {
  MONTHLY_DUE_DAY,
  MONTHLY_NOTICE_DAYS,
  giveMonthlyNotice,
  lastDayOf,
  lastPayDay,
  money,
  monthName,
  noticeLastDay,
  payMonthlyInvoice,
  sgDayLong,
  sgDayShort,
  withdrawMonthlyNotice,
  type MonthlyData,
  type MonthlyEnrolment,
  type MonthlyInvoice,
} from "../lib/monthly";

/**
 * The Monthly billing tab (00268): the invoices a parent owes, and the monthly classes they are
 * enrolled in with what they have booked so far, plus giving (and taking back) notice.
 */
export function MonthlyPanel({ data, reload }: { data: MonthlyData; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState<string | null>(null);

  const open = data.invoices.filter((i) => i.status === "open");
  const overdue = open.filter((i) => i.overdue);
  const paidReturn = getParam("paid") === "1";

  // Back from Stripe: the webhook (or the reconcile call on this page) may land a moment after we do,
  // so look again a couple of times before leaving a paid invoice reading "due".
  useEffect(() => {
    if (!paidReturn || open.length === 0) return;
    const timers = [2500, 6000].map((ms) => window.setTimeout(() => { reload(); }, ms));
    return () => timers.forEach(window.clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paidReturn, open.length]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(cleanRpcErrorMessage(e as { message: string; code?: string | null }) || "Something went wrong — please try again.");
      setBusy(null);
      return;
    }
    await reload();
    setBusy(null);
  }

  const live = data.enrolments.filter((e) => e.status !== "ended");
  const past = data.enrolments.filter((e) => e.status === "ended");

  return (
    <div>
      <h1 className="text-[26px] font-black">Monthly billing</h1>
      <p className="mb-4 mt-1 text-sm font-semibold text-[#59658d]">
        For classes billed monthly you don't pay when you book. Book as many sessions as you like; on the 1st we invoice you for the month just ended,
        and you have until the end of the {MONTHLY_DUE_DAY}th to pay. Leaving takes {MONTHLY_NOTICE_DAYS} days' notice.
      </p>

      {paidReturn && open.length === 0 && (
        <p role="status" className="mb-4 rounded-[12px] bg-[#F1FBEF] p-4 font-semibold text-palette-green">
          <Icon name="check" className="mr-2 inline h-5 w-5" />
          Payment received — thank you.
        </p>
      )}
      {error && <p role="alert" className="mb-4 rounded-[12px] bg-[#FDECEC] p-3 text-sm font-bold text-[#B42318]">{error}</p>}

      {overdue.length > 0 && (
        <p role="alert" className="mb-4 rounded-[12px] bg-[#FDECEC] p-4 text-sm font-bold text-[#B42318]">
          <Icon name="bell" className="mr-2 inline h-4 w-4" />
          You have {overdue.length === 1 ? "an overdue invoice" : `${overdue.length} overdue invoices`}. You can't book more sessions in{" "}
          {Array.from(new Set(overdue.map((i) => i.title))).join(", ")} until {overdue.length === 1 ? "it is" : "they are"} paid.
        </p>
      )}

      <h2 className="mb-2 mt-6 text-lg font-black">Invoices</h2>
      {data.invoices.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-[#DCD2D5] bg-white p-6 text-center text-sm font-semibold text-[#68718f]">
          No invoices yet. Your first one arrives on the 1st of next month, for the sessions you have this month.
        </div>
      ) : (
        <div className="space-y-2.5">
          {data.invoices.map((i) => (
            <InvoiceRow key={i.id} invoice={i} busy={busy === `pay:${i.id}`} onPay={() => run(`pay:${i.id}`, () => payMonthlyInvoice(i.id))} />
          ))}
        </div>
      )}

      <h2 className="mb-2 mt-8 text-lg font-black">Your monthly classes</h2>
      {live.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-[#DCD2D5] bg-white p-6 text-center text-sm font-semibold text-[#68718f]">
          You're not enrolled in a monthly class right now.
        </div>
      ) : (
        <div className="space-y-3">
          {live.map((e) => (
            <EnrolmentCard
              key={e.id}
              enrolment={e}
              unbilled={data.unbilled[e.id] ?? []}
              busy={busy}
              confirming={confirmLeave === e.id}
              onAskLeave={() => setConfirmLeave(e.id)}
              onCancelLeave={() => setConfirmLeave(null)}
              onLeave={() => run(`leave:${e.id}`, async () => { await giveMonthlyNotice(e.id); setConfirmLeave(null); })}
              onKeep={() => run(`keep:${e.id}`, () => withdrawMonthlyNotice(e.id))}
            />
          ))}
        </div>
      )}

      {past.length > 0 && (
        <p className="mt-6 text-xs font-semibold text-[#6D7486]">
          Ended: {past.map((e) => e.title).join(", ")}.
        </p>
      )}
    </div>
  );
}

function InvoiceRow({ invoice: i, busy, onPay }: { invoice: MonthlyInvoice; busy: boolean; onPay: () => void }) {
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-[12px] border bg-white p-3.5 shadow-card ${i.overdue ? "border-[#F2B8B5]" : "border-[#F4EFF0]"}`}>
      <div className="min-w-0 flex-1">
        <div className="truncate font-black">{i.title}</div>
        <div className="text-sm font-semibold text-[#59658d]">
          {monthName(i.periodStart)} · {i.sessions} {i.sessions === 1 ? "session" : "sessions"}
          {i.provider ? ` · ${i.provider}` : ""}
        </div>
        {i.status === "open" && (
          <div className={`mt-0.5 text-xs font-bold ${i.overdue ? "text-[#B42318]" : "text-[#8A6A00]"}`}>
            {i.overdue ? `Overdue — was due ${lastPayDay(i.dueAt)}` : `Pay by ${lastPayDay(i.dueAt)}`}
          </div>
        )}
        {i.status === "paid" && i.paidAt && <div className="mt-0.5 text-xs font-bold text-palette-green">Paid {sgDayShort(i.paidAt)}</div>}
      </div>
      <div className="text-lg font-black">{money(i.amountCents)}</div>
      {i.status === "open" && (
        <Button type="button" size="sm" onClick={onPay} disabled={busy} className={busy ? "opacity-60" : ""}>
          {busy ? "Opening…" : "Pay now"}
        </Button>
      )}
    </div>
  );
}

function EnrolmentCard({
  enrolment: e, unbilled, busy, confirming, onAskLeave, onCancelLeave, onLeave, onKeep,
}: {
  enrolment: MonthlyEnrolment;
  unbilled: { periodStart: string; sessions: number; amountCents: number }[];
  busy: string | null;
  confirming: boolean;
  onAskLeave: () => void;
  onCancelLeave: () => void;
  onLeave: () => void;
  onKeep: () => void;
}) {
  const ending = e.status === "ending" && e.endsAt;
  return (
    <div className="rounded-[14px] border border-[#F4EFF0] bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-black">{e.title}</div>
          {e.provider && <div className="text-sm font-semibold text-[#59658d]">{e.provider}</div>}
        </div>
        {ending ? (
          <span className="rounded-full bg-[#FFF4D6] px-2.5 py-1 text-xs font-black text-[#8A6A00]">Leaving {sgDayLong(lastDayOf(e.endsAt!))}</span>
        ) : (
          <span className="rounded-full bg-[#F1FBEF] px-2.5 py-1 text-xs font-black text-palette-green">Enrolled</span>
        )}
      </div>

      <div className="mt-3 text-sm font-semibold text-[#59658d]">
        {unbilled.length === 0 ? (
          "Nothing booked yet that hasn't been invoiced."
        ) : (
          <>
            <div className="mb-1 text-xs font-black uppercase tracking-wide text-[#6D7486]">Booked, to be invoiced</div>
            {unbilled.map((u) => (
              <div key={u.periodStart} className="flex justify-between gap-3">
                <span>{monthName(u.periodStart)} · {u.sessions} {u.sessions === 1 ? "session" : "sessions"}</span>
                <span className="font-black text-[#2f3a5a]">{money(u.amountCents)}</span>
              </div>
            ))}
            <p className="mt-1 text-xs">Cancelled sessions aren't charged. Prices are confirmed on the invoice.</p>
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {e.slug && !ending && <Button href={`/activity?slug=${encodeURIComponent(e.slug)}`} variant="outline" size="sm">Book a session</Button>}
        {ending ? (
          <Button type="button" variant="outline" size="sm" onClick={onKeep} disabled={busy === `keep:${e.id}`}>
            {busy === `keep:${e.id}` ? "Saving…" : "Keep my place"}
          </Button>
        ) : (
          !confirming && <Button type="button" variant="ghost" size="sm" onClick={onAskLeave}>Give notice</Button>
        )}
      </div>

      {ending && (
        <p className="mt-2 text-xs font-semibold text-[#59658d]">
          You can still attend sessions up to and including {sgDayLong(lastDayOf(e.endsAt!))}; they're billed as usual and your final invoice arrives on the 1st.
        </p>
      )}

      {confirming && (
        <div className="mt-3 rounded-[12px] bg-[#FFF8E6] p-3 text-sm font-semibold text-[#6B5200]">
          <p>
            Give {MONTHLY_NOTICE_DAYS} days' notice for {e.title}? Your last day would be <b>{sgDayLong(noticeLastDay())}</b>. Sessions up to then are billed as
            usual. Any session you've booked after that date will be cancelled, and you won't be charged for it.
          </p>
          <div className="mt-2 flex gap-2">
            <Button type="button" size="sm" onClick={onLeave} disabled={busy === `leave:${e.id}`}>
              {busy === `leave:${e.id}` ? "Saving…" : "Yes, give notice"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onCancelLeave}>Not now</Button>
          </div>
        </div>
      )}
    </div>
  );
}
