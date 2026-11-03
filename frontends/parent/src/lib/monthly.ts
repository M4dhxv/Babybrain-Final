import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { apiPost } from "./api";

/**
 * Monthly billing (migration 00268), parent side.
 *
 * An activity the vendor bills monthly takes no payment at booking. The parent enrols once,
 * books any number of sessions, and is invoiced on the 1st for the month just ended, due by the
 * end of the 5th. Until an overdue invoice is paid they can't book more sessions in that
 * activity. Leaving takes 14 days' notice; sessions booked past that date are released.
 *
 * Nothing here is shown unless an activity has monthly_billing_enabled, and a vendor can only
 * switch that on where the vendor preview flag is on, so the parent app is dormant until then.
 */

// The new tables and functions are newer than the generated Database types.
const db = supabase as unknown as SupabaseClient;

export const MONTHLY_NOTICE_DAYS = 14;
export const MONTHLY_DUE_DAY = 5;

export type MonthlyEnrolment = {
  id: string;
  activityId: string;
  title: string;
  slug: string | null;
  provider: string;
  status: "active" | "ending" | "ended";
  enrolledAt: string;
  /** Exclusive end of the notice period (00:00 the day after the last day). */
  endsAt: string | null;
};

export type MonthlyInvoice = {
  id: string;
  enrolmentId: string;
  activityId: string;
  title: string;
  provider: string;
  /** First day of the billed month, YYYY-MM-DD. */
  periodStart: string;
  sessions: number;
  amountCents: number;
  status: "open" | "paid" | "void";
  dueAt: string;
  paidAt: string | null;
  overdue: boolean;
};

export type MonthlyUnbilled = { periodStart: string; sessions: number; amountCents: number };

export type MonthlyData = {
  enrolments: MonthlyEnrolment[];
  invoices: MonthlyInvoice[];
  /** Per enrolment id: what has been booked but not yet invoiced. */
  unbilled: Record<string, MonthlyUnbilled[]>;
};

type EnrolmentRow = {
  id: string; activity_id: string; status: MonthlyEnrolment["status"]; enrolled_at: string; ends_at: string | null;
  activities: { title: string; slug: string | null; providers: { business_name: string | null } | null } | null;
};
type InvoiceRow = {
  id: string; enrolment_id: string; activity_id: string; period_start: string; session_count: number; amount_cents: number;
  status: MonthlyInvoice["status"]; due_at: string; paid_at: string | null;
  activities: { title: string; providers: { business_name: string | null } | null } | null;
};

export async function loadMonthly(userId: string): Promise<MonthlyData> {
  const en = await db
    .from("monthly_enrolments")
    .select("id, activity_id, status, enrolled_at, ends_at, activities(title, slug, providers(business_name))")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (en.error) throw en.error;
  // Most parents have no monthly class: one small indexed lookup is all they cost.
  if (!en.data || en.data.length === 0) return { enrolments: [], invoices: [], unbilled: {} };
  const inv = await db
    .from("monthly_invoices")
    .select("id, enrolment_id, activity_id, period_start, session_count, amount_cents, status, due_at, paid_at, activities(title, providers(business_name))")
    .eq("user_id", userId)
    .neq("status", "void")
    .order("period_start", { ascending: false });
  if (inv.error) throw inv.error;

  const now = Date.now();
  const enrolments = ((en.data ?? []) as unknown as EnrolmentRow[]).map<MonthlyEnrolment>((e) => ({
    id: e.id,
    activityId: e.activity_id,
    title: e.activities?.title ?? "Class",
    slug: e.activities?.slug ?? null,
    provider: e.activities?.providers?.business_name ?? "",
    status: e.status,
    enrolledAt: e.enrolled_at,
    endsAt: e.ends_at,
  }));
  const invoices = ((inv.data ?? []) as unknown as InvoiceRow[]).map<MonthlyInvoice>((i) => ({
    id: i.id,
    enrolmentId: i.enrolment_id,
    activityId: i.activity_id,
    title: i.activities?.title ?? "Class",
    provider: i.activities?.providers?.business_name ?? "",
    periodStart: i.period_start,
    sessions: i.session_count,
    amountCents: i.amount_cents,
    status: i.status,
    dueAt: i.due_at,
    paidAt: i.paid_at,
    overdue: i.status === "open" && new Date(i.due_at).getTime() <= now,
  }));

  const unbilled: Record<string, MonthlyUnbilled[]> = {};
  await Promise.all(
    enrolments
      .filter((e) => e.status !== "ended")
      .map(async (e) => {
        const { data } = await db.rpc("monthly_unbilled", { p_enrolment_id: e.id });
        unbilled[e.id] = ((data ?? []) as { period_start: string; sessions: number; amount_cents: number }[]).map((r) => ({
          periodStart: r.period_start,
          sessions: r.sessions,
          amountCents: r.amount_cents,
        }));
      }),
  );
  return { enrolments, invoices, unbilled };
}

/** Everything the signed-in parent has with monthly billing. `data` is null until the first answer. */
export function useMonthly(userId: string | null | undefined) {
  const [data, setData] = useState<MonthlyData | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(async () => {
    if (!userId) return;
    try {
      setData(await loadMonthly(userId));
      setError(false);
    } catch (e) {
      console.error("Could not load monthly billing", e);
      setError(true);
    }
  }, [userId]);
  useEffect(() => {
    if (!userId) { setData(null); return; }
    reload();
  }, [userId, reload]);
  return { data, error, reload };
}

/** The parent's live enrolment in one activity, and whether an invoice for it is overdue. */
export function useActivityMonthly(userId: string | null | undefined, activityId: string | null | undefined, enabled: boolean) {
  const { data, reload } = useMonthly(enabled ? userId : null);
  const enrolment = enabled && activityId
    ? data?.enrolments.find((e) => e.activityId === activityId && e.status !== "ended") ?? null
    : null;
  const overdue = enabled && activityId
    ? data?.invoices.find((i) => i.activityId === activityId && i.overdue) ?? null
    : null;
  return { resolved: !enabled || !userId || data !== null, enrolment, overdue, reload };
}

export async function enrolMonthly(activityId: string): Promise<string> {
  const { data, error } = await db.rpc("monthly_enrol", { p_activity_id: activityId });
  if (error) throw error;
  return data as string;
}

export async function giveMonthlyNotice(enrolmentId: string): Promise<string> {
  const { data, error } = await db.rpc("monthly_give_notice", { p_enrolment_id: enrolmentId });
  if (error) throw error;
  return data as string;
}

export async function withdrawMonthlyNotice(enrolmentId: string): Promise<void> {
  const { error } = await db.rpc("monthly_withdraw_notice", { p_enrolment_id: enrolmentId });
  if (error) throw error;
}

/** Start Stripe Checkout for an invoice and go there. */
export async function payMonthlyInvoice(invoiceId: string): Promise<void> {
  const { url } = await apiPost<{ url?: string }>("/api/customer/monthly/checkout", { invoice_id: invoiceId });
  if (!url) throw new Error("Could not start payment");
  window.location.href = url;
}

const SGT = "Asia/Singapore";
/** "Tuesday 17 Nov" */
export const sgDayLong = (iso: string) =>
  new Date(iso).toLocaleDateString("en-SG", { timeZone: SGT, weekday: "long", day: "numeric", month: "short" });
export const sgDayShort = (iso: string) =>
  new Date(iso).toLocaleDateString("en-SG", { timeZone: SGT, day: "numeric", month: "short", year: "numeric" });
export const monthName = (periodStart: string) =>
  new Date(`${periodStart}T00:00:00+08:00`).toLocaleDateString("en-SG", { timeZone: SGT, month: "long", year: "numeric" });
export const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-SG", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
/** The last day a parent can pay on time: due_at is 00:00 on the 6th, so the day before. */
export const lastPayDay = (dueAt: string) => sgDayLong(new Date(new Date(dueAt).getTime() - 864e5).toISOString());
/** The last day someone who gives notice today would still attend (today + 14 days, Singapore). */
export function noticeLastDay(now = new Date()): string {
  const sgToday = new Date(now.toLocaleDateString("en-CA", { timeZone: SGT }) + "T00:00:00+08:00");
  return new Date(sgToday.getTime() + MONTHLY_NOTICE_DAYS * 864e5).toISOString();
}
/** The last day of an enrolment whose notice ends at `endsAt` (exclusive). */
export const lastDayOf = (endsAt: string) => new Date(new Date(endsAt).getTime() - 864e5).toISOString();
