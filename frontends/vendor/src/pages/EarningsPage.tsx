import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Banknote,
  ChevronRight,
  Clock,
  Landmark,
  RefreshCw,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';

interface LedgerRow {
  id: string;
  source: 'booking' | 'package';
  label: string;
  currency: string;
  gross_cents: number;
  commission_cents: number;
  stripe_fee_cents: number | null;
  net_cents: number;
  commission_rate: number;
  fee_payer: 'platform' | 'vendor';
  routed_to_connect: boolean;
  stripe_payout_id: string | null;
  paid_out_at: string | null;
  status: 'pending' | 'in_transit' | 'paid_out' | 'platform_owed' | 'refunded';
  created_at: string;
}

interface Payout {
  id: string;
  amount: number;
  currency: string;
  status: string;
  arrival_date: string | null;
  created: string;
  bank_last4: string | null;
  failure_message: string | null;
}

interface EarningsResponse {
  connected: boolean;
  payouts_enabled: boolean;
  summary: {
    lifetime_gross_cents: number;
    lifetime_net_cents: number;
    lifetime_commission_cents: number;
    lifetime_stripe_fee_cents: number;
    paid_out_cents: number;
    awaiting_payout_cents: number;
    owed_by_babybrain_cents: number;
    sales_count: number;
  };
  balance: { currency: string; available: number; pending: number } | null;
  payouts: Payout[];
  ledger: LedgerRow[];
}

const money = (cents: number, currency = 'sgd') =>
  new Intl.NumberFormat('en-SG', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);

const sgDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' });

const STATUS_LABEL: Record<LedgerRow['status'], { text: string; className: string }> = {
  pending: { text: 'In your Stripe balance', className: 'bg-blue-100 text-blue-800' },
  in_transit: { text: 'On its way to your bank', className: 'bg-blue-100 text-blue-800' },
  paid_out: { text: 'Paid out', className: 'bg-green-300 text-green-800' },
  platform_owed: { text: 'BabyBrain settles directly', className: 'bg-yellow-300 text-yellow-800' },
  refunded: { text: 'Refunded', className: 'bg-gray-100 text-gray-600' },
};

const PAYOUT_STATUS: Record<string, { text: string; className: string }> = {
  paid: { text: 'Paid', className: 'bg-green-300 text-green-800' },
  in_transit: { text: 'On its way', className: 'bg-blue-100 text-blue-800' },
  pending: { text: 'Pending', className: 'bg-blue-100 text-blue-800' },
  failed: { text: 'Failed', className: 'bg-red-100 text-red-700' },
  canceled: { text: 'Cancelled', className: 'bg-gray-100 text-gray-600' },
};

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  hint?: string;
  accent?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${accent ?? 'bg-gray-100'}`}>
          <Icon className="w-4 h-4" />
        </div>
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <div className="text-xl font-bold text-gray-900 sm:text-2xl">{value}</div>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

/**
 * The vendor's money. Splits deliberately into "what you're owed" and "what
 * has actually landed", because those are different questions and the answer
 * to the first depends on whether they've finished Stripe onboarding — until
 * they have, BabyBrain is holding the money and Stripe will never pay it out.
 */
export default function EarningsPage() {
  const navigate = useNavigate();
  const { provider } = useAuth();
  const [data, setData] = useState<EarningsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!provider) return;
    setError(null);
    try {
      setData(await apiGet<EarningsResponse>(`/api/vendor/earnings?provider_id=${provider.id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your earnings.');
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void load();
  }, [load]);

  const s = data?.summary;
  const currency = data?.balance?.currency ?? data?.ledger[0]?.currency ?? 'sgd';

  return (
    <div className="relative">
      {/* On mobile the title/subtitle sit centred, with the back and refresh
          controls pinned to the edges; from sm up it's the usual left-aligned
          row. */}
      <div className="relative flex items-start justify-between gap-2 px-4 py-5 sm:items-center sm:gap-3 sm:px-8">
        <button
          onClick={() => navigate('/dashboard')}
          className="absolute left-1 top-4 p-2 hover:bg-gray-100 rounded-lg sm:static sm:shrink-0"
        >
          <ChevronRight className="w-5 h-5 text-gray-600 rotate-180" />
        </button>
        <div className="min-w-0 flex-1 px-11 text-center sm:px-0 sm:text-left">
          <h1 className="text-xl font-bold text-gray-900 sm:text-2xl">Earnings & payouts</h1>
          <p className="text-sm text-gray-500 mt-1">
            What you've earned, what you're owed, and when it reached your bank.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          title="Refresh"
          className="absolute right-1 top-4 p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-50 sm:static sm:shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="px-4 pb-8 space-y-6 sm:px-8">
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* Not on Connect yet: Stripe has nothing to show, so say what happens
            to the money instead of showing empty payout tables. */}
        {data && !data.payouts_enabled && (
          <div className="rounded-xl bg-yellow-50 border border-yellow-300 px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-yellow-700 mt-0.5 flex-shrink-0" />
              <div className="flex-1 text-sm text-yellow-900">
                <p className="font-medium">Payouts aren't switched on yet.</p>
                <p className="text-xs mt-0.5">
                  Bookings still get paid — BabyBrain collects them and settles with you directly. Finish Stripe
                  setup and future bookings pay straight into your bank account.
                </p>
              </div>
            </div>
            <Button
              onClick={() => navigate('/billing')}
              variant="outline"
              className="rounded-lg border-yellow-400 text-yellow-900 hover:bg-yellow-100 text-sm w-full flex-shrink-0 sm:w-auto"
            >
              Set up payouts
            </Button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <StatCard
            icon={Wallet}
            accent="bg-green-100 text-green-700"
            label="Paid out to you"
            value={s ? money(s.paid_out_cents, currency) : '—'}
            hint="Landed in your bank"
          />
          <StatCard
            icon={Clock}
            accent="bg-blue-100 text-blue-700"
            label="On the way"
            value={s ? money(s.awaiting_payout_cents, currency) : '—'}
            hint="In Stripe, not yet paid out"
          />
          <StatCard
            icon={Landmark}
            accent="bg-yellow-100 text-yellow-700"
            label="Owed by BabyBrain"
            value={s ? money(s.owed_by_babybrain_cents, currency) : '—'}
            hint="Collected before payouts were on"
          />
          <StatCard
            icon={Banknote}
            accent="bg-pink-100 text-[#FA4D8D]"
            label="Lifetime earnings"
            value={s ? money(s.lifetime_net_cents, currency) : '—'}
            hint={s ? `${s.sales_count} paid sale${s.sales_count === 1 ? '' : 's'}` : undefined}
          />
        </div>

        {/* Where the money went, in total. */}
        {s && s.lifetime_gross_cents > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
            <h3 className="font-semibold text-gray-900 mb-4">Where it went</h3>
            <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3 sm:gap-6">
              <div>
                <div className="text-xs text-gray-500">Parents paid</div>
                <div className="text-lg font-semibold text-gray-900">{money(s.lifetime_gross_cents, currency)}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">BabyBrain commission</div>
                <div className="text-lg font-semibold text-gray-900">
                  −{money(s.lifetime_commission_cents, currency)}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Your earnings</div>
                <div className="text-lg font-semibold text-green-700">{money(s.lifetime_net_cents, currency)}</div>
              </div>
            </div>
          </div>
        )}

        {/* Payout history — read live from Stripe. */}
        {data?.connected && (
          <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
            <h3 className="font-semibold text-gray-900 mb-1">Payouts</h3>
            <p className="text-xs text-gray-500 mb-4">Straight from Stripe — every transfer to your bank.</p>
            {data.payouts.length === 0 ? (
              <p className="text-sm text-gray-500">
                No payouts yet. Once a booking is paid, Stripe pays it out on your schedule.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                      <th className="pb-2 font-medium">Amount</th>
                      <th className="pb-2 font-medium">Status</th>
                      <th className="pb-2 font-medium">Arrived / expected</th>
                      <th className="pb-2 font-medium">To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payouts.map((p) => {
                      const badge = PAYOUT_STATUS[p.status] ?? {
                        text: p.status,
                        className: 'bg-gray-100 text-gray-600',
                      };
                      return (
                        <tr key={p.id} className="border-b border-gray-100 last:border-0">
                          <td className="py-3 font-medium text-gray-900">{money(p.amount, p.currency)}</td>
                          <td className="py-3">
                            <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${badge.className}`}>
                              {badge.text}
                            </span>
                            {p.failure_message && (
                              <div className="text-xs text-red-600 mt-1">{p.failure_message}</div>
                            )}
                          </td>
                          <td className="py-3 text-gray-600">
                            {p.arrival_date ? sgDate(p.arrival_date) : sgDate(p.created)}
                          </td>
                          <td className="py-3 text-gray-600">
                            {p.bank_last4 ? `••••${p.bank_last4}` : 'Your bank account'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* The per-sale ledger. */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
          <h3 className="font-semibold text-gray-900 mb-1">Every paid sale</h3>
          <p className="text-xs text-gray-500 mb-4">
            What the parent paid, what came off, and what reached you.
          </p>
          {loading && !data ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : data && data.ledger.length === 0 ? (
            <p className="text-sm text-gray-500">
              No paid bookings yet. Free classes and pack redemptions don't appear here.
            </p>
          ) : (
            <>
              {/* Mobile: one card per sale — an 8-column money table doesn't
                  survive a phone width. Desktop keeps the table. */}
              <div className="space-y-3 sm:hidden">
                {(data?.ledger ?? []).map((row) => {
                  const badge = STATUS_LABEL[row.status];
                  const pct = (row.commission_rate * 100).toFixed((row.commission_rate * 100) % 1 ? 1 : 0);
                  return (
                    <div key={row.id} className="rounded-xl border border-gray-200 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900">{row.label}</div>
                          <div className="text-xs text-gray-400">
                            {row.source === 'package' ? 'Class pack' : 'Booking'} · {sgDate(row.created_at)}
                          </div>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
                        >
                          {badge.text}
                        </span>
                      </div>
                      <dl className="mt-3 space-y-1.5 border-t border-gray-100 pt-3 text-sm">
                        <div className="flex justify-between gap-3">
                          <dt className="text-gray-500">Parent paid</dt>
                          <dd className="text-gray-900">{money(row.gross_cents, row.currency)}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-gray-500">
                            Commission <span className="text-gray-400">{pct}%</span>
                          </dt>
                          <dd className="text-gray-600">−{money(row.commission_cents, row.currency)}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-gray-500">Stripe fee</dt>
                          <dd>
                            {row.stripe_fee_cents === null ? (
                              <span className="text-gray-300">—</span>
                            ) : row.fee_payer === 'vendor' ? (
                              <span className="text-gray-600">−{money(row.stripe_fee_cents, row.currency)}</span>
                            ) : (
                              <span className="text-gray-400" title="Covered by BabyBrain">
                                {money(row.stripe_fee_cents, row.currency)}
                              </span>
                            )}
                          </dd>
                        </div>
                        {row.paid_out_at && (
                          <div className="flex justify-between gap-3">
                            <dt className="text-gray-500">Paid out</dt>
                            <dd className="text-gray-600">{sgDate(row.paid_out_at)}</dd>
                          </div>
                        )}
                      </dl>
                      <div className="mt-3 flex justify-between gap-3 border-t border-gray-100 pt-3 text-sm font-medium">
                        <span className="text-gray-900">You earned</span>
                        <span className="text-green-700">{money(row.net_cents, row.currency)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[820px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                      <th className="pb-2 font-medium">Date</th>
                      <th className="pb-2 font-medium">Sale</th>
                      <th className="pb-2 font-medium text-right">Parent paid</th>
                      <th className="pb-2 font-medium text-right">Commission</th>
                      <th className="pb-2 font-medium text-right">Stripe fee</th>
                      <th className="pb-2 font-medium text-right">You earned</th>
                      <th className="pb-2 font-medium">Status</th>
                      <th className="pb-2 font-medium">Paid out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.ledger ?? []).map((row) => {
                      const badge = STATUS_LABEL[row.status];
                      return (
                        <tr key={row.id} className="border-b border-gray-100 last:border-0">
                          <td className="py-3 text-gray-600 whitespace-nowrap">{sgDate(row.created_at)}</td>
                          <td className="py-3">
                            <div className="text-gray-900">{row.label}</div>
                            <div className="text-xs text-gray-400">
                              {row.source === 'package' ? 'Class pack' : 'Booking'}
                            </div>
                          </td>
                          <td className="py-3 text-right text-gray-900">{money(row.gross_cents, row.currency)}</td>
                          <td className="py-3 text-right text-gray-600">
                            −{money(row.commission_cents, row.currency)}
                            <div className="text-xs text-gray-400">
                              {(row.commission_rate * 100).toFixed(row.commission_rate * 100 % 1 ? 1 : 0)}%
                            </div>
                          </td>
                          <td className="py-3 text-right text-gray-600">
                            {/* Only a deduction from the vendor when their terms
                                say they absorb it; otherwise it's BabyBrain's cost
                                and shown greyed for transparency. */}
                            {row.stripe_fee_cents === null ? (
                              <span className="text-gray-300">—</span>
                            ) : row.fee_payer === 'vendor' ? (
                              <>−{money(row.stripe_fee_cents, row.currency)}</>
                            ) : (
                              <span className="text-gray-400" title="Covered by BabyBrain">
                                {money(row.stripe_fee_cents, row.currency)}
                              </span>
                            )}
                          </td>
                          <td className="py-3 text-right font-medium text-green-700">
                            {money(row.net_cents, row.currency)}
                          </td>
                          <td className="py-3">
                            <span className={`px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap ${badge.className}`}>
                              {badge.text}
                            </span>
                          </td>
                          <td className="py-3 text-gray-600 whitespace-nowrap">
                            {row.paid_out_at ? sgDate(row.paid_out_at) : <span className="text-gray-300">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
