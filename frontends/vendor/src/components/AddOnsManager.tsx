import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Switch } from '@/components/ui/switch';
import { supabase } from '@/lib/supabase';

/**
 * Extra people a parent can add to a booking of this activity, each with its own price
 * (migration 00273): e.g. "Adult +$12", "Sibling +$8". They sit on top of the class price, can be
 * added to a booking the parent already holds, and never use a class place.
 *
 * Saves each row as it is edited (like the other managers), so it needs an activity that already
 * exists. Only owners and managers can change them; staff see them read-only.
 */
export type AddOn = {
  id: string;
  name: string;
  price_cents: number;
  max_per_booking: number | null;
  /** Who the price is for, in whole years: Child is typically up to 12, Adult 15 and over. */
  min_age: number | null;
  max_age: number | null;
  active: boolean;
  sort_order: number;
};

// The tables are newer than the generated types, so the client is used loosely here.
type Loose = {
  from: (t: string) => {
    select: (c: string) => { eq: (c: string, v: unknown) => { order: (c: string) => PromiseLike<{ data: unknown; error: { message: string } | null }> } };
    insert: (v: unknown) => { select: (c: string) => { single: () => PromiseLike<{ data: unknown; error: { message: string } | null }> } };
    update: (v: unknown) => { eq: (c: string, v: unknown) => PromiseLike<{ error: { message: string } | null }> };
    delete: () => { eq: (c: string, v: unknown) => PromiseLike<{ error: { message: string } | null }> };
  };
};
const db = supabase as unknown as Loose;

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-pink-300';

export function AddOnsManager({ activityId, providerId, canManage }: { activityId: string; providerId: string; canManage: boolean }) {
  const [rows, setRows] = useState<AddOn[] | null>(null);
  const [adding, setAdding] = useState(false);
  const emptyDraft = { name: '', price: '', max: '', minAge: '', maxAge: '' };
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);

  // Bumped after an add so the list is read again from the database.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    db.from('activity_addons')
      .select('id, name, price_cents, max_per_booking, min_age, max_age, active, sort_order')
      .eq('activity_id', activityId)
      .order('sort_order')
      .then(({ data }) => { if (!cancelled) setRows((data ?? []) as AddOn[]); });
    return () => { cancelled = true; };
  }, [activityId, version]);

  const dollars = (cents: number) => (cents / 100).toFixed(2);

  async function add() {
    const name = draft.name.trim();
    if (!name) { toast.error('Give the add-on a name, e.g. "Adult".'); return; }
    const price = draft.price === '' ? 0 : Math.round(Number(draft.price) * 100);
    if (!Number.isFinite(price) || price < 0 || price > 100000) { toast.error('Enter a price between 0 and 1000.'); return; }
    const max = draft.max === '' ? null : Math.max(1, Math.min(10, Math.round(Number(draft.max))));
    const minAge = draft.minAge === '' ? null : Math.round(Number(draft.minAge));
    const maxAge = draft.maxAge === '' ? null : Math.round(Number(draft.maxAge));
    if ([minAge, maxAge].some((a) => a !== null && (!Number.isFinite(a) || a < 0 || a > 120))) { toast.error('Ages must be between 0 and 120.'); return; }
    if (minAge !== null && maxAge !== null && minAge > maxAge) { toast.error('"From age" can\'t be higher than "to age".'); return; }
    setBusy(true);
    const { error } = await db
      .from('activity_addons')
      .insert({ activity_id: activityId, provider_id: providerId, name, price_cents: price, max_per_booking: max, min_age: minAge, max_age: maxAge, sort_order: (rows?.length ?? 0) })
      .select('id')
      .single();
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setDraft(emptyDraft);
    setAdding(false);
    toast.success(`${name} added`);
    setVersion((v) => v + 1);
  }

  async function patch(row: AddOn, fields: Partial<Pick<AddOn, 'name' | 'price_cents' | 'max_per_booking' | 'min_age' | 'max_age' | 'active'>>) {
    const { error } = await db.from('activity_addons').update(fields).eq('id', row.id);
    if (error) { toast.error(error.message); return; }
    setRows((rs) => (rs ?? []).map((r) => (r.id === row.id ? { ...r, ...fields } : r)));
  }

  async function remove(row: AddOn) {
    // Purchases keep their own copy of the name and price, so removing an add-on never changes what a parent already paid.
    const { error } = await db.from('activity_addons').delete().eq('id', row.id);
    if (error) { toast.error(error.message); return; }
    setRows((rs) => (rs ?? []).filter((r) => r.id !== row.id));
    toast.success(`${row.name} removed`);
  }

  return (
    <div className="space-y-3 pt-2 border-t border-gray-100">
      <div>
        <div className="text-sm font-medium text-gray-900">Prices for additional people</div>
        <div className="text-xs text-gray-500">
          Set the age restriction for each ticket type.
        </div>
      </div>

      {rows === null ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 p-2.5">
              <input
                className={`${inputCls} min-w-[7rem] flex-1`}
                defaultValue={r.name}
                maxLength={60}
                disabled={!canManage}
                aria-label="Add-on name"
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== r.name) void patch(r, { name: v }); else e.target.value = r.name; }}
              />
              <div className="flex items-center gap-1">
                <span className="text-sm text-gray-500">+$</span>
                <NumberInput
                  step="any"
                  className={`${inputCls} w-20`}
                  defaultValue={dollars(r.price_cents)}
                  disabled={!canManage}
                  aria-label="Add-on price"
                  onBlur={(e) => {
                    const cents = Math.round(Number(e.target.value || 0) * 100);
                    if (Number.isFinite(cents) && cents >= 0 && cents <= 100000 && cents !== r.price_cents) void patch(r, { price_cents: cents });
                    else e.target.value = dollars(r.price_cents);
                  }}
                />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-gray-500">Max tickets</span>
                <NumberInput
                  className={`${inputCls} w-14`}
                  placeholder="any"
                  defaultValue={r.max_per_booking != null ? String(r.max_per_booking) : ''}
                  disabled={!canManage}
                  aria-label="Most of this add-on per booking"
                  onBlur={(e) => {
                    const next = e.target.value === '' ? null : Math.max(1, Math.min(10, Math.round(Number(e.target.value))));
                    if (next !== r.max_per_booking) void patch(r, { max_per_booking: next });
                  }}
                />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-gray-500">ages</span>
                <NumberInput
                  className={`${inputCls} w-14`}
                  placeholder="any"
                  defaultValue={r.min_age != null ? String(r.min_age) : ''}
                  disabled={!canManage}
                  aria-label="Youngest age this add-on is for"
                  onBlur={(e) => {
                    const next = e.target.value === '' ? null : Math.max(0, Math.min(120, Math.round(Number(e.target.value))));
                    if (next === r.min_age) return;
                    if (next !== null && r.max_age !== null && next > r.max_age) { toast.error('"From age" can\'t be higher than "to age".'); e.target.value = r.min_age != null ? String(r.min_age) : ''; return; }
                    void patch(r, { min_age: next });
                  }}
                />
                <span className="text-xs text-gray-500">to</span>
                <NumberInput
                  className={`${inputCls} w-14`}
                  placeholder="any"
                  defaultValue={r.max_age != null ? String(r.max_age) : ''}
                  disabled={!canManage}
                  aria-label="Oldest age this add-on is for"
                  onBlur={(e) => {
                    const next = e.target.value === '' ? null : Math.max(0, Math.min(120, Math.round(Number(e.target.value))));
                    if (next === r.max_age) return;
                    if (next !== null && r.min_age !== null && next < r.min_age) { toast.error('"To age" can\'t be lower than "from age".'); e.target.value = r.max_age != null ? String(r.max_age) : ''; return; }
                    void patch(r, { max_age: next });
                  }}
                />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <Switch checked={r.active} disabled={!canManage} onCheckedChange={(v) => void patch(r, { active: v })} />
                {r.active ? 'On offer' : 'Hidden'}
              </label>
              {canManage && (
                <button type="button" onClick={() => void remove(r)} aria-label={`Remove ${r.name}`} className="ml-auto rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {rows.length === 0 && !adding && <p className="text-xs text-gray-400">No prices set yet. Add one so parents can add additional people.</p>}
        </div>
      )}

      {canManage && (
        adding ? (
          <div className="space-y-2 rounded-xl border border-pink-200 bg-pink-50/40 p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
              <span>Quick start:</span>
              <button type="button" className="rounded-full border border-pink-200 bg-white px-2.5 py-1 hover:bg-pink-50" onClick={() => setDraft({ ...draft, name: draft.name || 'Child', minAge: '', maxAge: '12' })}>Child (up to 12)</button>
              <button type="button" className="rounded-full border border-pink-200 bg-white px-2.5 py-1 hover:bg-pink-50" onClick={() => setDraft({ ...draft, name: draft.name || 'Adult', minAge: '15', maxAge: '' })}>Adult (15 and over)</button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[7rem] flex-1">
                <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
                <input className={inputCls} placeholder="e.g. Adult" maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="w-24">
                <label className="mb-1 block text-xs font-medium text-gray-600">Extra price ($)</label>
                <NumberInput step="any" className={inputCls} placeholder="12" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
              </div>
              <div className="w-20">
                <label className="mb-1 block text-xs font-medium text-gray-600">Most per booking</label>
                <NumberInput className={inputCls} placeholder="any" value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} />
              </div>
              <div className="w-20">
                <label className="mb-1 block text-xs font-medium text-gray-600">From age</label>
                <NumberInput className={inputCls} placeholder="any" value={draft.minAge} onChange={(e) => setDraft({ ...draft, minAge: e.target.value })} />
              </div>
              <div className="w-20">
                <label className="mb-1 block text-xs font-medium text-gray-600">To age</label>
                <NumberInput className={inputCls} placeholder="any" value={draft.maxAge} onChange={(e) => setDraft({ ...draft, maxAge: e.target.value })} />
              </div>
            </div>
            <p className="text-xs text-gray-500">Leave blank for no limit.</p>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={busy} onClick={() => void add()}>{busy ? 'Adding…' : 'Add'}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { setAdding(false); setDraft(emptyDraft); }}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-4 w-4" /> Add a price
          </Button>
        )
      )}
    </div>
  );
}
