'use client';

import { useCallback, useEffect, useState } from 'react';
import { planLabel, planMonthlyFeeCents } from '@/lib/plans';
import { C, Skeleton, adminFetch, card, input, sgd, td, th, toast, peekCache } from '../_lib/core';
import { type Col, SortTh, TableFooter, downloadCsv, useTable } from '../_lib/table';

// ---- Commercials: bespoke commission terms per vendor ----

type VendorTerms = {
  provider_id: string; business_name: string; plan: string;
  connected: boolean; payouts_enabled: boolean; is_test?: boolean;
  commission_rate: number; commission_flat_cents: number;
  fee_payer: 'platform' | 'vendor'; commission_on_packages: boolean; custom_terms: boolean;
  lifetime_gross_cents: number; lifetime_commission_cents: number;
  lifetime_net_cents: number; sales_count: number;
};

export default function CommercialsView() {
  const [rows, setRows] = useState<VendorTerms[] | null>(() => peekCache<{ vendors: VendorTerms[] }>('/api/admin/commercials')?.vendors ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const { vendors } = await adminFetch<{ vendors: VendorTerms[] }>('/api/admin/commercials');
      setRows(vendors);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load commercial terms.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(providerId: string, patch: Partial<VendorTerms>) {
    setSaving(providerId);
    setNote(null);
    setError(null);
    try {
      const r = await adminFetch<{ ok: true; applied: Partial<VendorTerms> }>('/api/admin/commercials', {
        method: 'PATCH',
        body: JSON.stringify({ provider_id: providerId, ...patch }),
      });
      // Optimistic: merge what the backend actually applied (r.applied), not
      // just the patch this call sent — editing commission_rate or
      // commission_flat_cents also silently sets custom_terms=true
      // server-side (locking the vendor out of future plan-driven resets),
      // which r.applied includes and the sent `patch` doesn't. Merging only
      // `patch` left the "· bespoke" badge not showing until the next reload
      // even though the backend had already locked the terms.
      setRows((prev) => prev?.map((row) => (row.provider_id === providerId ? { ...row, ...r.applied } : row)) ?? prev);
      setNote('Saved. Applies to future sales — past earnings keep their original terms.');
      toast('Commercial terms saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
      void load();
    } finally {
      setSaving(null);
    }
  }

  const visible = (rows ?? []).filter((r) =>
    r.business_name.toLowerCase().includes(filter.trim().toLowerCase()));
  const cols: Col<VendorTerms>[] = [
    { key: 'business', label: 'Business', value: (r) => r.business_name },
    { key: 'plan', label: 'Plan', value: (r) => planLabel(r.plan) },
    { key: 'commission', label: 'Commission %', value: (r) => Math.round(r.commission_rate * 1000) / 10 },
    { key: 'fee', label: 'Recurring fee', value: (r) => planMonthlyFeeCents(r.plan) / 100 },
    { key: 'payer', label: 'Stripe fee', value: (r) => r.fee_payer },
    { key: 'packs', label: 'Packs', value: (r) => (r.commission_on_packages ? 'yes' : 'no') },
    { key: 'test', label: 'Test account', value: (r) => (r.is_test ? 'yes' : 'no') },
    { key: 'sold', label: 'Sold', align: 'right', value: (r) => r.lifetime_gross_cents / 100 },
    { key: 'kept', label: 'We kept', align: 'right', value: (r) => r.lifetime_commission_cents / 100 },
  ];
  const table = useTable(visible, cols, { pageSize: 1000 });

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={card()}>
        <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 6 }}>Commercial terms</div>
        <p style={{ color: C.muted, fontSize: 13, margin: 0, lineHeight: 1.6 }}>
          The deal per vendor. Rates are read at checkout and stamped onto each sale, so changes apply to
          future bookings only. <strong style={{ color: C.text }}>Stripe fee</strong> decides who absorbs
          Stripe&apos;s processing cost — charges stay destination charges either way, so switching it to the
          vendor moves the cost but <em>not</em> chargeback liability. Editing a rate marks the vendor
          <strong style={{ color: C.text }}> bespoke</strong>, after which plan changes no longer reset it.
        </p>
      </div>

      {error && <div style={{ ...card(), borderColor: C.pink, color: C.pink }}>{error}</div>}
      {note && <div style={{ ...card(), borderColor: C.green, color: C.green }}>{note}</div>}

      <input
        style={input()}
        placeholder="Filter by business name…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {!rows ? (
        <Skeleton />
      ) : visible.length === 0 ? (
        <p style={{ color: C.muted }}>No vendors match.</p>
      ) : (
        <div style={{ ...card(), padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: C.muted, textAlign: 'left' }}>
                {cols.map((c) => <SortTh key={c.key} col={c} table={table} />)}
              </tr>
            </thead>
            <tbody>
              {table.pageRows.map((r) => (
                <tr key={r.provider_id} style={{ borderTop: `1px solid ${C.border}`,
                  opacity: saving === r.provider_id ? 0.5 : 1 }}>
                  <td style={td()}>
                    <div style={{ fontWeight: 700 }}>
                      {r.business_name}
                      {r.is_test && <span style={{ color: C.muted, fontWeight: 600 }}> · test</span>}
                    </div>
                    <div style={{ color: C.muted, fontSize: 11 }}>
                      {r.payouts_enabled ? 'Payouts on' : r.connected ? 'Connect pending' : 'Not connected'}
                      {r.custom_terms && <span style={{ color: C.pink }}> · bespoke</span>}
                    </div>
                  </td>
                  {/* r.plan is the raw DB key ('growth'/'pro'/'free'/'premium'), which predates a
                      vendor-facing rename and no longer matches what vendors/customers actually
                      see: 'growth' shows as "Pro" and 'pro' shows as "Premium" everywhere else
                      (planLabel, lib/plans.ts) — this table was printing the DB key itself
                      capitalized, so an admin reading "Growth" here was looking at the same plan
                      a vendor's own portal calls "Pro". */}
                  <td style={td()}>{planLabel(r.plan)}</td>
                  <td style={td()}>
                    <input
                      style={{ ...input(), width: 78, padding: '6px 8px' }}
                      type="text" inputMode="decimal" autoComplete="off"
                      // Rounding at the same 0.1-point precision `onBlur`
                      // below actually saves at (rather than a bare `* 100`)
                      // avoids reprinting float noise for any rate that
                      // isn't a "nice" binary fraction — 0.07 * 100 is
                      // 7.000000000000001 in JS, not 7.
                      defaultValue={(Math.round(r.commission_rate * 1000) / 10).toString()}
                      onBlur={(e) => {
                        const pct = Number(e.target.value);
                        const rate = Math.round(pct * 10) / 1000;
                        // A text box no longer enforces the 0-50 range, so do it here.
                        if (Number.isFinite(rate) && pct >= 0 && pct <= 50 && rate !== r.commission_rate) {
                          void save(r.provider_id, { commission_rate: rate });
                        }
                      }}
                    />
                  </td>
                  {/* The vendor's subscription price for their plan — not
                      commission_flat_cents (a separate, still-real per-booking
                      surcharge used in the actual commission split math, just
                      with no admin UI of its own right now). Read-only: it
                      follows the Plan column, not something to edit per row. */}
                  <td style={td()}>{sgd(planMonthlyFeeCents(r.plan))} / mo</td>
                  <td style={td()}>
                    <select
                      style={{ ...input(), width: 118, padding: '6px 8px' }}
                      value={r.fee_payer}
                      onChange={(e) => void save(r.provider_id, { fee_payer: e.target.value as 'platform' | 'vendor' })}
                    >
                      <option value="platform">We absorb</option>
                      <option value="vendor">Vendor pays</option>
                    </select>
                  </td>
                  <td style={td()}>
                    <input
                      type="checkbox"
                      checked={r.commission_on_packages}
                      onChange={(e) => void save(r.provider_id, { commission_on_packages: e.target.checked })}
                    />
                  </td>
                  <td style={td()}>
                    <input
                      type="checkbox"
                      title="Demo / QA vendor: left out of admin Metrics and Payments"
                      checked={Boolean(r.is_test)}
                      onChange={(e) => void save(r.provider_id, { is_test: e.target.checked })}
                    />
                  </td>
                  <td style={{ ...td(), textAlign: 'right' }}>
                    {sgd(r.lifetime_gross_cents)}
                    <div style={{ color: C.muted, fontSize: 11 }}>{r.sales_count} sales</div>
                  </td>
                  <td style={{ ...td(), textAlign: 'right', color: C.green, fontWeight: 700 }}>
                    {sgd(r.lifetime_commission_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <TableFooter total={table.total} page={table.page} pages={table.pages} setPage={table.setPage} noun="vendors"
            onExport={() => downloadCsv('commercial-terms.csv', cols, table.sorted)} />
        </div>
      )}
    </div>
  );
}



