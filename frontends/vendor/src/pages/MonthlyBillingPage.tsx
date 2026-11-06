import { useMemo, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/auth/AuthProvider';
import { useProviderQuery } from '@/lib/useProviderQuery';
import { TableRowsSkeleton, RefreshBar } from '@/components/Skeletons';
import {
  fetchMonthlyEnrolments, fetchMonthlyInvoices, settleMonthlyInvoice, monthlyPreviewEnabled,
  monthLabel, sgd, MONTHLY_NOTICE_DAYS, MONTHLY_DUE_DAY,
  type MonthlyEnrolmentRow, type MonthlyInvoiceRow,
} from '@/lib/monthlyBilling';

/**
 * Monthly billing (00268): who is enrolled in your monthly activities and what they owe.
 * An invoice is issued on the 1st for the sessions a family had in the month just ended, and is
 * due by the end of the 5th. A family with an overdue invoice cannot book more sessions in that
 * activity until it is paid. If a family pays you another way, mark the invoice paid here.
 */

const INVOICE_COLS =
  'grid min-w-[860px] gap-x-4 grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,0.7fr)_minmax(0,0.8fr)_minmax(0,1.1fr)]';
const FAMILY_COLS =
  'grid min-w-[860px] gap-x-4 grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]';

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' });
/** due_at is 00:00 on the 6th, so the last day to pay is the day before. */
const lastPayDay = (iso: string) => fmtDate(new Date(new Date(iso).getTime() - 864e5).toISOString());

const badge = (tone: 'amber' | 'red' | 'green' | 'gray' | 'blue') =>
  cn(
    'inline-flex items-center px-2 py-0.5 text-xs rounded-full font-medium',
    tone === 'amber' && 'bg-amber-100 text-amber-800',
    tone === 'red' && 'bg-red-100 text-red-700',
    tone === 'green' && 'bg-green-100 text-green-800',
    tone === 'blue' && 'bg-blue-100 text-blue-800',
    tone === 'gray' && 'bg-gray-100 text-gray-600',
  );

type Tab = 'invoices' | 'families';
const invoiceFilters = ['Needs payment', 'Paid', 'All'] as const;

export default function MonthlyBillingPage() {
  const { provider, role } = useAuth();
  const canManage = role === 'owner' || role === 'manager';
  const [tab, setTab] = useState<Tab>('invoices');
  const [filter, setFilter] = useState<typeof invoiceFilters[number]>('Needs payment');
  const [confirming, setConfirming] = useState<{ id: string; action: 'paid' | 'void' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invoicesQ = useProviderQuery<MonthlyInvoiceRow[]>(
    provider ? `monthly-invoices:${provider.id}` : null,
    () => fetchMonthlyInvoices(provider!.id),
  );
  const familiesQ = useProviderQuery<MonthlyEnrolmentRow[]>(
    provider ? `monthly-enrolments:${provider.id}` : null,
    () => fetchMonthlyEnrolments(provider!.id),
  );
  const invoices = useMemo(() => invoicesQ.data ?? [], [invoicesQ.data]);
  const families = useMemo(() => familiesQ.data ?? [], [familiesQ.data]);
  const loading = invoicesQ.loading || familiesQ.loading;
  const refreshing = invoicesQ.refreshing || familiesQ.refreshing;

  const totals = useMemo(() => {
    const open = invoices.filter((i) => i.status === 'open');
    return {
      owed: open.reduce((s, i) => s + i.amount_cents, 0),
      overdue: open.filter((i) => i.overdue).reduce((s, i) => s + i.amount_cents, 0),
      overdueCount: open.filter((i) => i.overdue).length,
      active: families.filter((f) => f.status !== 'ended').length,
      leaving: families.filter((f) => f.status === 'ending').length,
    };
  }, [invoices, families]);

  const visibleInvoices = useMemo(
    () => invoices.filter((i) => (filter === 'All' ? true : filter === 'Paid' ? i.status === 'paid' : i.status === 'open')),
    [invoices, filter],
  );

  async function settle() {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    try {
      await settleMonthlyInvoice(confirming.id, confirming.action);
      setConfirming(null);
      invoicesQ.refetch();
      familiesQ.refetch();
    } catch (e) {
      setError((e as { message?: string })?.message ?? 'Could not update the invoice. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!monthlyPreviewEnabled()) {
    return <div className="px-4 py-10 text-center text-sm text-gray-500 sm:px-8">Monthly billing is not available yet.</div>;
  }

  return (
    <div className="relative">
      {refreshing && <RefreshBar />}
      <div className="px-4 py-5 sm:px-8">
        <div className="text-center sm:text-left">
          <h1 className="text-2xl font-bold text-gray-900">Monthly billing</h1>
          <p className="mt-1 text-sm text-gray-500">
            Families who choose monthly billing on one of your activities book as many sessions as they like and are invoiced on the 1st for the month just ended,
            to pay by the {MONTHLY_DUE_DAY}th. A family that hasn't paid by then can't book more sessions until they do. Leaving takes {MONTHLY_NOTICE_DAYS} days' notice.
            Everyone else still pays per booking. Offer monthly billing on an activity in Activities → edit.
          </p>
        </div>
      </div>

      <div className="px-4 pb-8 sm:px-8">
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-2xl font-bold text-gray-900">{sgd(totals.owed)}</div>
            <div className="text-sm text-gray-500">Invoiced, not yet paid</div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className={cn('text-2xl font-bold', totals.overdue > 0 ? 'text-red-600' : 'text-gray-900')}>{sgd(totals.overdue)}</div>
            <div className="text-sm text-gray-500">Overdue ({totals.overdueCount})</div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-2xl font-bold text-gray-900">{totals.active}</div>
            <div className="text-sm text-gray-500">Families enrolled</div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-2xl font-bold text-gray-900">{totals.leaving}</div>
            <div className="text-sm text-gray-500">Working their notice</div>
          </div>
        </div>

        <div className="mb-4 flex w-full rounded-xl border border-gray-200 bg-white p-1 sm:inline-flex sm:w-auto">
          {(['invoices', 'families'] as Tab[]).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={cn('h-8 flex-1 px-4 text-sm font-medium rounded-lg transition-colors sm:flex-none', tab === k ? 'bg-pink-50 text-[#FA4D8D]' : 'text-gray-600 hover:bg-gray-100')}
            >
              {k === 'invoices' ? 'Invoices' : 'Families'}
            </button>
          ))}
        </div>

        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {loading && <TableRowsSkeleton cols={6} count={6} />}

        {!loading && tab === 'invoices' && (
          <>
            <div className="mb-3 flex w-full rounded-xl border border-gray-200 bg-white p-1 sm:inline-flex sm:w-auto">
              {invoiceFilters.map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn('h-8 flex-1 px-3 text-sm font-medium rounded-lg transition-colors sm:flex-none', filter === f ? 'bg-pink-50 text-[#FA4D8D]' : 'text-gray-600 hover:bg-gray-100')}
                >
                  {f}
                </button>
              ))}
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
              <div className={cn(INVOICE_COLS, 'bg-gray-50 px-5 py-3 text-xs font-medium text-gray-500')}>
                <div>Family</div><div>Activity</div><div>Month</div><div>Amount</div><div>Due</div><div>Status</div>
              </div>
              {visibleInvoices.map((i) => (
                <div key={i.invoice_id} className="border-t border-gray-100">
                  <div className={cn(INVOICE_COLS, 'items-center px-5 py-3')}>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-gray-900">{i.parent_name}</div>
                      {i.parent_email && <div className="truncate text-xs text-gray-500">{i.parent_email}</div>}
                    </div>
                    <div className="min-w-0 break-words text-sm text-gray-700">{i.activity_title}</div>
                    <div className="text-sm text-gray-700">
                      {monthLabel(i.period_start)}
                      <div className="text-xs text-gray-500">{i.session_count} {i.session_count === 1 ? 'session' : 'sessions'}</div>
                    </div>
                    <div className="text-sm font-medium text-gray-900">{sgd(i.amount_cents)}</div>
                    <div className="text-xs text-gray-500">{i.status === 'open' ? lastPayDay(i.due_at) : '—'}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      {i.status === 'paid' && <span className={badge('green')}>{i.paid_manually ? 'Paid (by you)' : 'Paid'}</span>}
                      {i.status === 'void' && <span className={badge('gray')}>Waived</span>}
                      {i.status === 'open' && <span className={badge(i.overdue ? 'red' : 'amber')}>{i.overdue ? 'Overdue' : 'Awaiting payment'}</span>}
                      {i.status === 'open' && canManage && (
                        <>
                          <button onClick={() => setConfirming({ id: i.invoice_id, action: 'paid' })} className="text-xs font-medium text-[#FA4D8D] hover:underline">Mark paid</button>
                          <button onClick={() => setConfirming({ id: i.invoice_id, action: 'void' })} className="text-xs font-medium text-gray-500 hover:underline">Waive</button>
                        </>
                      )}
                    </div>
                  </div>
                  {confirming?.id === i.invoice_id && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3 text-sm text-gray-700">
                      <span>
                        {confirming.action === 'paid'
                          ? `Mark ${sgd(i.amount_cents)} from ${i.parent_name} as paid? Use this when they paid you another way.`
                          : `Waive ${sgd(i.amount_cents)} for ${i.parent_name}? They won't be asked to pay it.`}
                      </span>
                      <button onClick={settle} disabled={busy} className="rounded-lg bg-[#FA4D8D] px-3 py-1 text-xs font-medium text-white hover:bg-[#e23f7c] disabled:opacity-60">
                        {busy ? 'Saving…' : 'Confirm'}
                      </button>
                      <button onClick={() => setConfirming(null)} className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100">Cancel</button>
                    </div>
                  )}
                </div>
              ))}
              {visibleInvoices.length === 0 && (
                <div className="px-5 py-8 text-center text-sm text-gray-400">
                  {invoices.length === 0 ? 'No invoices yet. The first ones are issued on the 1st of next month.' : 'Nothing here.'}
                </div>
              )}
            </div>
          </>
        )}

        {!loading && tab === 'families' && (
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <div className={cn(FAMILY_COLS, 'bg-gray-50 px-5 py-3 text-xs font-medium text-gray-500')}>
              <div>Family</div><div>Activity</div><div>Booked, not yet invoiced</div><div>Invoiced, unpaid</div><div>Enrolled</div><div>Status</div>
            </div>
            {families.map((f) => (
              <div key={f.enrolment_id} className={cn(FAMILY_COLS, 'items-center border-t border-gray-100 px-5 py-3')}>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate text-sm font-medium text-gray-900">
                    <CalendarClock className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />{f.parent_name}
                  </div>
                  {f.parent_email && <div className="truncate text-xs text-gray-500">{f.parent_email}</div>}
                </div>
                <div className="min-w-0 break-words text-sm text-gray-700">{f.activity_title}</div>
                <div className="text-sm text-gray-700">
                  {f.unbilled_sessions} {f.unbilled_sessions === 1 ? 'session' : 'sessions'}
                  <div className="text-xs text-gray-500">{sgd(f.unbilled_cents)}</div>
                </div>
                <div className={cn('text-sm', f.overdue_cents > 0 ? 'font-medium text-red-600' : 'text-gray-700')}>
                  {sgd(f.open_cents)}
                  {f.overdue_cents > 0 && <div className="text-xs">{sgd(f.overdue_cents)} overdue</div>}
                </div>
                <div className="text-xs text-gray-500">{fmtDate(f.enrolled_at)}</div>
                <div>
                  {f.status === 'active' && <span className={badge('green')}>Active</span>}
                  {f.status === 'ending' && (
                    <>
                      <span className={badge('amber')}>Leaving</span>
                      {f.ends_at && <div className="mt-0.5 text-xs text-gray-500">last day {fmtDate(new Date(new Date(f.ends_at).getTime() - 864e5).toISOString())}</div>}
                    </>
                  )}
                  {f.status === 'ended' && <span className={badge('gray')}>Ended</span>}
                </div>
              </div>
            ))}
            {families.length === 0 && <div className="px-5 py-8 text-center text-sm text-gray-400">No families have enrolled yet.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
