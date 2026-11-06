import { useEffect, useSyncExternalStore } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Monthly billing (migration 00268).
 *
 * A vendor switches an activity to "billed monthly" (activities.monthly_billing_enabled). Parents
 * enrol once, book any number of sessions, and are invoiced on the 1st for the month just ended,
 * due by the end of the 5th. See the migration header for the rules.
 *
 * Gated like terms: the switch and the Monthly billing page only show when the preview flag is on
 * (dev build, a build pointed at the test database, or `?monthly=preview` once, which is
 * remembered), so a push to main cannot expose half a feature to vendors.
 */

const FLAG_KEY = 'bb_monthly_preview';

// The new tables and functions are newer than the generated Database types.
const db = supabase as unknown as SupabaseClient;

// The babybrain-test Supabase project (same default-on rule as terms).
const TEST_SUPABASE_REF = 'imlfhepnucytyajxpoum';

export function monthlyPreviewEnabled(): boolean {
  try {
    if (import.meta.env.DEV) return true;
    const inHash = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('monthly');
    const p = new URLSearchParams(window.location.search).get('monthly') ?? inHash;
    if (p === 'preview') window.localStorage.setItem(FLAG_KEY, '1');
    if (p === 'off') window.localStorage.setItem(FLAG_KEY, '0');
    const stored = window.localStorage.getItem(FLAG_KEY);
    const testBuild = String(import.meta.env.VITE_SUPABASE_URL ?? '').includes(TEST_SUPABASE_REF);
    return stored === '1' || (testBuild && stored !== '0');
  } catch {
    return false;
  }
}

/** The rules the parent is shown and the database enforces (keep in step with 00268). */
export const MONTHLY_NOTICE_DAYS = 14;
export const MONTHLY_DUE_DAY = 5;

export type MonthlyEnrolmentRow = {
  enrolment_id: string;
  activity_id: string;
  activity_title: string;
  user_id: string;
  parent_name: string;
  parent_email: string | null;
  status: 'active' | 'ending' | 'ended';
  enrolled_at: string;
  ends_at: string | null;
  /** Seats booked but not yet on an invoice. */
  unbilled_sessions: number;
  unbilled_cents: number;
  open_cents: number;
  overdue_cents: number;
};

export type MonthlyInvoiceRow = {
  invoice_id: string;
  enrolment_id: string;
  activity_id: string;
  activity_title: string;
  user_id: string;
  parent_name: string;
  parent_email: string | null;
  /** First day of the month the sessions were in, YYYY-MM-DD. */
  period_start: string;
  session_count: number;
  amount_cents: number;
  status: 'open' | 'paid' | 'void';
  issued_at: string;
  due_at: string;
  paid_at: string | null;
  paid_manually: boolean;
  overdue: boolean;
  settle_note: string | null;
};

export async function fetchMonthlyEnrolments(providerId: string): Promise<MonthlyEnrolmentRow[]> {
  const { data, error } = await db.rpc('monthly_provider_enrolments', { p_provider: providerId });
  if (error) throw error;
  return (data ?? []) as MonthlyEnrolmentRow[];
}

export async function fetchMonthlyInvoices(providerId: string): Promise<MonthlyInvoiceRow[]> {
  const { data, error } = await db.rpc('monthly_provider_invoices', { p_provider: providerId });
  if (error) throw error;
  return (data ?? []) as MonthlyInvoiceRow[];
}

/** Mark an invoice paid outside the app (bank transfer, cash) or waive it. */
export async function settleMonthlyInvoice(invoiceId: string, action: 'paid' | 'void', note?: string): Promise<void> {
  const { error } = await db.rpc('monthly_settle_invoice', { p_invoice_id: invoiceId, p_action: action, p_note: note?.trim() || null });
  if (error) throw error;
}

export const sgd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-SG', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** "October 2026" from a YYYY-MM-DD month start. */
export const monthLabel = (periodStart: string) =>
  new Date(`${periodStart}T00:00:00+08:00`).toLocaleDateString('en-SG', { month: 'long', year: 'numeric', timeZone: 'Asia/Singapore' });

/* ── per-activity switch ── */

const NO_ENABLED: Record<string, boolean> = {};
let enabledCache: Record<string, boolean> = NO_ENABLED;
let enabledFor: string | null = null;
const enabledListeners = new Set<() => void>();

async function loadEnabled(providerId: string) {
  const { data, error } = await db.from('activities').select('id, monthly_billing_enabled').eq('provider_id', providerId);
  if (error) throw error;
  enabledCache = Object.fromEntries(((data ?? []) as { id: string; monthly_billing_enabled: boolean }[]).map((a) => [a.id, !!a.monthly_billing_enabled]));
  enabledListeners.forEach((l) => l());
}

export function useMonthlyEnabledMap(): Record<string, boolean> {
  const { provider } = useAuth();
  const providerId = provider?.id ?? null;
  useEffect(() => {
    if (!providerId || enabledFor === providerId) return;
    enabledFor = providerId;
    enabledCache = NO_ENABLED;
    loadEnabled(providerId).catch((e) => { console.error('Could not load monthly billing switches', e); enabledFor = null; });
  }, [providerId]);
  return useSyncExternalStore(
    (cb) => {
      enabledListeners.add(cb);
      return () => enabledListeners.delete(cb);
    },
    () => enabledCache,
    () => enabledCache,
  );
}

/** Turn "Bill this activity monthly" on or off. The database refuses to turn it on for a Wix-synced
 *  activity or one that offers terms, and to turn it off while parents are enrolled or owe an invoice. */
export async function setMonthlyEnabled(activityId: string, on: boolean): Promise<void> {
  if ((enabledCache[activityId] ?? false) === on) return;
  const { error } = await db.from('activities').update({ monthly_billing_enabled: on }).eq('id', activityId);
  if (error) throw error;
  enabledCache = { ...enabledCache, [activityId]: on };
  enabledListeners.forEach((l) => l());
}
