'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, C, Skeleton, TestDataBar, adminFetch, card, input, sgd, tabBtn, td, th, toast, peekCache } from '../_lib/core';
import { type Col, SortTh, TableFooter, downloadCsv, useTable } from '../_lib/table';


interface PaymentTxn {
  id: string;
  provider_id: string;
  business_name: string;
  source: 'booking' | 'package';
  gross_cents: number;
  commission_cents: number;
  stripe_fee_cents: number | null;
  net_cents: number;
  fee_payer: 'platform' | 'vendor';
  routed_to_connect: boolean;
  status: string;
  stripe_payment_intent: string | null;
  currency: string;
  created_at: string;
  /** The parent who paid, when the payment is tied to a booking or a package purchase. */
  payer: { id: string; name: string; email: string } | null;
  /** An admin flagged this single payment as test. */
  is_test: boolean;
  /** Why it is not live money (shown only when test data is included). */
  test_reason: 'vendor' | 'stripe_test' | 'flagged' | null;
}

interface PlatformPayout {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  arrival_date: string;
  created: string;
  method: string;
}
interface PaymentsData {
  transactions: PaymentTxn[];
  totals: { gross: number; commission: number; stripeFee: number; net: number; platformOwed: number; count: number };
  platformPayouts: PlatformPayout[] | null;
  platformPayoutsError: string | null;
  includeTest?: boolean;
  excludedSales?: number;
  /** false until migration 00212 is applied: the per-payment test flag cannot be saved yet. */
  testFlagAvailable?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  in_transit: 'In transit',
  paid_out: 'Paid out',
  platform_owed: 'We owe vendor',
  refunded: 'Refunded',
};


export default function PaymentsView() {
  const [data, setData] = useState<PaymentsData | null>(() => peekCache<PaymentsData>('/api/admin/payments?limit=100') ?? null);
  const [error, setError] = useState<string | null>(null);
  const [includeTest, setIncludeTest] = useState(false);
  const [limit, setLimit] = useState(100);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await adminFetch<PaymentsData>(`/api/admin/payments?limit=${limit}${includeTest ? '&include_test=1' : ''}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load payments.');
    }
  }, [includeTest, limit]);
  useEffect(() => { void load(); }, [load]);

  const txRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = data?.transactions ?? [];
    return q ? all.filter((t) => `${t.business_name} ${t.source} ${STATUS_LABEL[t.status] ?? t.status} ${t.stripe_payment_intent ?? ''}`.toLowerCase().includes(q)) : all;
  }, [data, query]);
  const txCols: Col<PaymentTxn>[] = [
    { key: 'when', label: 'When', value: (t) => t.created_at },
    { key: 'provider', label: 'Recipient (vendor)', value: (t) => t.business_name },
    { key: 'payer', label: 'Paid by', value: (t) => (t.payer ? `${t.payer.name} <${t.payer.email}>` : '') },
    { key: 'source', label: 'Source', value: (t) => t.source },
    { key: 'gross', label: 'Gross', align: 'right', value: (t) => t.gross_cents / 100 },
    { key: 'commission', label: 'Commission', align: 'right', value: (t) => t.commission_cents / 100 },
    { key: 'fee', label: 'Stripe fee', align: 'right', value: (t) => (t.stripe_fee_cents == null ? '' : t.stripe_fee_cents / 100) },
    { key: 'net', label: 'Vendor net', align: 'right', value: (t) => t.net_cents / 100 },
    { key: 'status', label: 'Status', value: (t) => STATUS_LABEL[t.status] ?? t.status },
    { key: 'pi', label: 'Stripe payment', value: (t) => t.stripe_payment_intent ?? '' },
    { key: 'test', label: 'Test', value: (t) => (t.is_test ? 'flagged' : t.test_reason ?? '') },
  ];
  const tx = useTable(txRows, txCols, { sortKey: 'when', dir: 'desc', pageSize: 25 });

  const [flagging, setFlagging] = useState<string | null>(null);
  async function setTestFlag(t: PaymentTxn, next: boolean) {
    setFlagging(t.id);
    try {
      await adminFetch(`/api/admin/payments/${t.id}`, { method: 'PATCH', body: JSON.stringify({ is_test: next }) });
      toast(next ? 'Payment flagged as test — left out of totals' : 'Payment counted again');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setFlagging(null); }
  }
  const sgdDate = (iso: string) =>
    new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={card()}>
        <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 6 }}>Payments</div>
        <p style={{ color: C.muted, fontSize: 13, margin: 0, lineHeight: 1.6 }}>
          Every sale&apos;s split, and separately what Stripe has actually paid into BabyBrain&apos;s bank
          account. Those are different things — a sale can be collected today and not reach the bank for
          weeks, on Stripe&apos;s own monthly payout schedule.
        </p>
      </div>

      <TestDataBar
        includeTest={includeTest}
        setIncludeTest={setIncludeTest}
        excluded={data?.excludedSales ? `${data.excludedSales} sale${data.excludedSales === 1 ? '' : 's'}` : ''}
      />

      {error && <div style={{ ...card(), borderColor: C.pink, color: C.pink }}>{error}</div>}

      {!data ? (
        <Skeleton />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
            {[
              ['Gross collected', data.totals.gross, C.text],
              ['BabyBrain commission', data.totals.commission, C.green],
              ["Stripe's real fees", data.totals.stripeFee, C.muted],
              ['Vendor net', data.totals.net, C.text],
              ['Still owed to vendors', data.totals.platformOwed, C.pink],
            ].map(([label, cents, color]) => (
              <div key={label as string} style={card()}>
                <div style={{ color: C.muted, fontSize: 12 }}>{label}</div>
                <div style={{ fontWeight: 900, fontSize: 18, color: color as string }}>{sgd(cents as number)}</div>
              </div>
            ))}
          </div>

          <div style={{ ...card(), padding: 0, overflowX: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px' }}>
              <div style={{ fontWeight: 800 }}>Recent transactions ({data.totals.count} all-time)</div>
              <input style={{ ...input(), maxWidth: 260 }} placeholder="Search provider, status or Stripe id…" value={query}
                onChange={(e) => { setQuery(e.target.value); tx.setPage(1); }} />
            </div>
            <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: C.muted, textAlign: 'left' }}>
                  {txCols.filter((c) => c.key !== 'pi' && c.key !== 'test').map((c) => <SortTh key={c.key} col={c} table={tx} />)}
                  <SortTh col={txCols.find((c) => c.key === 'test')!} table={tx} />
                </tr>
              </thead>
              <tbody>
                {tx.pageRows.map((t) => (
                  <tr key={t.id} style={{ borderTop: `1px solid ${C.border}`, opacity: t.test_reason || t.is_test ? 0.6 : 1 }}>
                    <td style={td()}>{sgdDate(t.created_at)}</td>
                    <td style={td()}>
                      {t.business_name}
                      {t.stripe_payment_intent && <div style={{ color: C.muted, fontSize: 11 }}>{t.stripe_payment_intent}</div>}
                    </td>
                    <td style={td()}>
                      {t.payer ? <>{t.payer.name}<div style={{ color: C.muted, fontSize: 11 }}>{t.payer.email}</div></> : <span style={{ color: C.muted }}>—</span>}
                    </td>
                    <td style={{ ...td(), textTransform: 'capitalize' }}>{t.source}</td>
                    <td style={{ ...td(), textAlign: 'right' }}>{sgd(t.gross_cents)}</td>
                    <td style={{ ...td(), textAlign: 'right', color: C.green }}>{sgd(t.commission_cents)}</td>
                    <td style={{ ...td(), textAlign: 'right', color: C.muted }}>
                      {t.stripe_fee_cents == null ? '—' : sgd(t.stripe_fee_cents)}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' }}>{sgd(t.net_cents)}</td>
                    <td style={td()}>
                      <span style={{ color: t.status === 'platform_owed' ? C.pink : t.status === 'paid_out' ? C.green : C.muted }}>
                        {STATUS_LABEL[t.status] ?? t.status}
                      </span>
                    </td>
                    <td style={td()}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: data.testFlagAvailable ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap' }}
                        title={data.testFlagAvailable ? 'Leave this payment out of revenue totals' : 'Needs migration 00212'}>
                        <input type="checkbox" style={{ width: 15, height: 15, margin: 0 }} checked={t.is_test}
                          disabled={!data.testFlagAvailable || flagging === t.id} onChange={(e) => setTestFlag(t, e.target.checked)} />
                        {t.test_reason === 'vendor' ? <Badge tone="amber">Test vendor</Badge> : t.test_reason === 'stripe_test' ? <Badge tone="amber">Stripe test mode</Badge> : t.is_test ? <Badge tone="amber">Flagged</Badge> : null}
                      </label>
                    </td>
                  </tr>
                ))}
                {tx.total === 0 && (
                  <tr><td style={td()} colSpan={10}>{query.trim() ? 'No transactions match.' : 'No payments yet.'}</td></tr>
                )}
              </tbody>
            </table>
            </div>
            <TableFooter total={tx.total} page={tx.page} pages={tx.pages} setPage={tx.setPage} noun="transactions"
              onExport={() => downloadCsv('transactions.csv', txCols, tx.sorted)} />
            {data.transactions.length >= limit && limit < 1000 && (
              <div style={{ padding: '0 14px 12px' }}>
                <button type="button" style={{ ...tabBtn(false), fontSize: 12, padding: '4px 12px' }} onClick={() => setLimit((l) => Math.min(1000, l + 100))}>
                  Load 100 older transactions
                </button>
              </div>
            )}
          </div>

          <div style={{ ...card(), padding: 0, overflowX: 'auto' }}>
            <div style={{ fontWeight: 800, padding: '12px 16px' }}>Sent to BabyBrain&apos;s bank account</div>
            {data.platformPayoutsError ? (
              <div style={{ padding: '0 16px 16px', color: C.pink, fontSize: 13 }}>
                Couldn&apos;t reach Stripe to check this — {data.platformPayoutsError}. This is not the same as
                &ldquo;no payouts yet&rdquo;; try reloading.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ color: C.muted, textAlign: 'left' }}>
                    <th style={th()}>Arrival date</th>
                    <th style={{ ...th(), textAlign: 'right' }}>Amount</th>
                    <th style={th()}>Status</th>
                    <th style={th()}>Method</th>
                  </tr>
                </thead>
                <tbody>
                  {data.platformPayouts?.map((p) => (
                    <tr key={p.id} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={td()}>{sgdDate(p.arrival_date)}</td>
                      <td style={{ ...td(), textAlign: 'right' }}>{sgd(p.amount_cents)}</td>
                      <td style={td()}><Badge tone={p.status === 'active' ? 'green' : p.status === 'pending' ? 'amber' : 'grey'}>{p.status}</Badge></td>
                      <td style={{ ...td(), textTransform: 'capitalize' }}>{p.method}</td>
                    </tr>
                  ))}
                  {(!data.platformPayouts || data.platformPayouts.length === 0) && (
                    <tr><td style={td()} colSpan={4}>No payouts to BabyBrain&apos;s bank account yet.</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

