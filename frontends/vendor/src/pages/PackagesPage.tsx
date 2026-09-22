import { useEffect, useState } from 'react';
import { NumberInput } from '@/components/ui/number-input';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Package as PackageIcon, Pencil, Trash2, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { useProviderQuery } from '@/lib/useProviderQuery';
import { ListRowsSkeleton, RefreshBar } from '@/components/Skeletons';
import { SelectField, Opt } from '@/components/ui/select-field';
import { MultiSelectField } from '@/components/ui/multi-select-field';
import { TimePicker } from '@/components/ui/time-picker';
import { DatePicker } from '@/components/ui/date-picker';

/**
 * The package purchases table's column tracks. Header and body rows are separate grids, so the
 * track list is shared to keep them in step, and every track is
 * `minmax(0, …)` rather than a bare `Nfr` — a bare fr floors at min-content,
 * so one long buyer or pack name widened that row's track and left the row
 * misaligned against the header. `gap-x-4` keeps neighbouring values from
 * sitting flush. Same fix as the activities table.
 */
const PURCHASE_COLS =
  'grid min-w-[790px] gap-x-4 grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1fr)]';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const tabs = ['Packs', 'Purchases'];

type Pack = {
  id: string; name: string; credits: number; price_cents: number; active: boolean;
  activity_ids: string[] | null; validity_days: number | null; expiry_date: string | null;
  allowed_weekday: number | null; allowed_start_time: string | null; starts_at: string | null;
  best_value: boolean;
};
type Purchase = {
  purchase_id: string; package_name: string; buyer_name: string;
  credits_total: number; credits_remaining: number; status: string;
  created_at: string; expires_at: string | null;
};

type ExpiryMode = 'none' | 'days' | 'date';
const emptyPack = {
  name: '', credits: '', price: '',
  expiryMode: 'none' as ExpiryMode, validity_days: '', expiry_date: '',
  activity_ids: [] as string[], allowed_weekday: '', allowed_start_time: '',
  starts_date: '', starts_time: '', best_value: false,
};
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
/** A plain YYYY-MM-DD (no time component) formatted without a UTC round-trip,
 *  so it can't drift a day off depending on the viewer's timezone. */
const fmtPlainDate = (isoDate: string) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
};
/** fmtDate plus a time, dropped when the instant is exactly midnight (a
 *  start picked with no time, i.e. "start of day"). */
const fmtDateTime = (iso: string) => {
  const time = new Date(iso).toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });
  return time === '12:00 am' ? fmtDate(iso) : `${fmtDate(iso)} ${time}`;
};
/** Reads a stored instant back out as Singapore wall-clock date/time, for
 *  re-populating the edit form (same convention as ActivitiesPage's
 *  startEditSess). */
function sgtDateTimeParts(iso: string) {
  const sgt = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${sgt.getFullYear()}-${pad(sgt.getMonth() + 1)}-${pad(sgt.getDate())}`,
    time: `${pad(sgt.getHours())}:${pad(sgt.getMinutes())}`,
  };
}

/** A pack's own [start, end) window, or null when it isn't scheduled at all
 *  (an ordinary always-on pack, which never conflicts with anything —
 *  multiple such packs per activity is intended, see packages-multi-
 *  per-activity-is-intended). Only packs that actually use the start-date
 *  feature participate in conflict checking. expiry_date is a fixed
 *  calendar date shared by every purchase (00132); validity_days is
 *  per-purchase and so doesn't bound the pack itself. */
function packWindow(p: { starts_at: string | null; expiry_date: string | null }): { start: number; end: number } | null {
  if (!p.starts_at) return null;
  return {
    start: new Date(p.starts_at).getTime(),
    end: p.expiry_date ? new Date(`${p.expiry_date}T23:59:59+08:00`).getTime() : Infinity,
  };
}
const scopeSet = (ids: string[] | null) => (ids && ids.length ? new Set(ids) : null);
/** null scope = "any of the provider's activities", which overlaps everything. */
const scopesOverlap = (a: Set<string> | null, b: Set<string> | null) => {
  if (!a || !b) return true;
  for (const id of a) if (b.has(id)) return true;
  return false;
};

export default function PackagesPage() {
  const { provider, role } = useAuth();
  const canManage = role === 'owner' || role === 'manager';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState('Packs');

  const { data, loading, refreshing, refetch } = useProviderQuery<{
    activities: { id: string; title: string }[];
    packs: Pack[];
    purchases: Purchase[];
  }>(
    provider ? `packages:${provider.id}` : null,
    async () => {
      const [{ data: acts }, { data: pks }, { data: purch }] = await Promise.all([
        supabase.from('activities').select('id, title').eq('provider_id', provider!.id).is('archived_at', null),
        supabase.from('packages').select('id, name, credits, price_cents, active, activity_ids, validity_days, expiry_date, allowed_weekday, allowed_start_time, starts_at, best_value').eq('provider_id', provider!.id).order('created_at', { ascending: false }),
        supabase.rpc('provider_package_purchases', { p_provider: provider!.id }),
      ]);
      return {
        activities: acts ?? [],
        packs: (pks ?? []) as Pack[],
        purchases: (purch ?? []) as Purchase[],
      };
    },
  );
  const activities = data?.activities ?? [];
  const packs = data?.packs ?? [];
  const purchases = data?.purchases ?? [];

  const [packForm, setPackForm] = useState(emptyPack);
  const [savingPack, setSavingPack] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);
  const [packNotice, setPackNotice] = useState<string | null>(null);
  const [editingPackId, setEditingPackId] = useState<string | null>(null);

  const load = refetch;

  // Dashboard's "Create a Package" shortcut deep-links here with ?new=pack.
  const newParam = searchParams.get('new');
  useEffect(() => {
    if (newParam !== 'pack' || !canManage) return;
    requestAnimationFrame(() => {
      document.getElementById('pack-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById('pack-name-input')?.focus();
    });
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newParam, canManage]);

  /** Active/Upcoming/Expired reflects the schedule the parent app actually
   *  enforces; Paused is the vendor's own on/off switch. Mirrors
   *  displayStatus below, which does the same for purchases. */
  const packStatus = (p: Pack): 'paused' | 'upcoming' | 'active' | 'expired' => {
    if (!p.active) return 'paused';
    const now = new Date();
    if (p.starts_at && new Date(p.starts_at) > now) return 'upcoming';
    if (p.expiry_date && new Date(`${p.expiry_date}T23:59:59+08:00`) <= now) return 'expired';
    return 'active';
  };
  const packStatusBadge = (s: ReturnType<typeof packStatus>) => cn(
    'text-xs font-medium px-2.5 py-1 rounded-full',
    s === 'active' ? 'bg-green-300 text-green-800'
      : s === 'upcoming' ? 'bg-purple-100 text-purple-700'
      : s === 'expired' ? 'bg-red-100 text-red-600'
      : 'bg-gray-100 text-gray-500'
  );
  const packStatusLabel = (s: ReturnType<typeof packStatus>) => s === 'paused' ? 'Paused' : s === 'upcoming' ? 'Upcoming' : s === 'expired' ? 'Expired' : 'Active';

  const packRestriction = (p: Pack) => {
    const parts: string[] = [];
    if (p.starts_at) parts.push(`starts ${fmtDateTime(p.starts_at)}`);
    if (p.activity_ids && p.activity_ids.length > 0) {
      const names = p.activity_ids.map((id) => activities.find((a) => a.id === id)?.title ?? 'one activity');
      parts.push(names.length <= 2 ? names.join(' & ') : `${names.length} activities`);
    }
    if (p.allowed_weekday != null) {
      const t = p.allowed_start_time ? ` ${p.allowed_start_time.slice(0, 5)}` : '';
      parts.push(`${WEEKDAY_NAMES[p.allowed_weekday]}${t} only`);
    } else if (p.allowed_start_time) {
      parts.push(`${p.allowed_start_time.slice(0, 5)} slot only`);
    }
    if (p.validity_days) parts.push(`expires ${p.validity_days}d after purchase`);
    else if (p.expiry_date) parts.push(`expires ${fmtPlainDate(p.expiry_date)}`);
    return parts.join(' · ');
  };

  function editPack(p: Pack) {
    setEditingPackId(p.id);
    setPackError(null);
    setPackNotice(null);
    const starts = p.starts_at ? sgtDateTimeParts(p.starts_at) : null;
    setPackForm({
      name: p.name,
      credits: String(p.credits),
      price: String(p.price_cents / 100),
      expiryMode: p.expiry_date ? 'date' : p.validity_days != null ? 'days' : 'none',
      validity_days: p.validity_days != null ? String(p.validity_days) : '',
      expiry_date: p.expiry_date ?? '',
      activity_ids: p.activity_ids ?? [],
      allowed_weekday: p.allowed_weekday != null ? String(p.allowed_weekday) : '',
      allowed_start_time: p.allowed_start_time ?? '',
      starts_date: starts?.date ?? '',
      starts_time: starts?.time ?? '',
      best_value: p.best_value,
    });
    document.getElementById('pack-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function togglePack(p: Pack) {
    await supabase.from('packages').update({ active: !p.active }).eq('id', p.id);
    load();
  }

  async function deletePack(p: Pack) {
    if (!window.confirm(`Delete "${p.name}"? Parents who already bought it keep their credits.`)) return;
    const { error } = await supabase.from('packages').delete().eq('id', p.id);
    if (error) {
      // A pack that has been purchased is referenced by package_purchases, so
      // deleting it would orphan real credits — deactivate instead.
      setPackError(`${error.message}. Try marking it inactive instead.`);
      return;
    }
    if (editingPackId === p.id) { setEditingPackId(null); setPackForm(emptyPack); }
    setPackNotice(`Deleted "${p.name}".`);
    load();
  }

  async function createPack() {
    if (!provider) return;
    setPackError(null);
    setPackNotice(null);
    const credits = Number(packForm.credits);
    const price = Number(packForm.price);
    if (!packForm.name.trim()) return setPackError('Give the pack a name.');
    if (!credits || credits < 1) return setPackError('Credits must be at least 1.');
    if (packForm.price !== '' && (Number.isNaN(price) || price < 0)) return setPackError('Enter a valid price.');
    if (packForm.expiryMode === 'days' && (!packForm.validity_days || Number(packForm.validity_days) < 1)) return setPackError('Enter how many days the pack stays valid, or choose another expiry.');
    if (packForm.expiryMode === 'date' && !packForm.expiry_date) return setPackError('Pick an expiry date.');
    if (packForm.starts_time && !packForm.starts_date) return setPackError('Pick a start date too.');
    if (packForm.starts_date && packForm.expiryMode === 'date' && packForm.expiry_date && packForm.expiry_date < packForm.starts_date) {
      return setPackError('Expiry date is before the start date.');
    }

    setSavingPack(true);
    const fields = {
      name: packForm.name.trim(),
      credits,
      price_cents: Math.round((price || 0) * 100),
      validity_days: packForm.expiryMode === 'days' && packForm.validity_days ? Number(packForm.validity_days) : null,
      expiry_date: packForm.expiryMode === 'date' ? packForm.expiry_date : null,
      activity_ids: packForm.activity_ids.length ? packForm.activity_ids : null,
      allowed_weekday: packForm.allowed_weekday !== '' ? Number(packForm.allowed_weekday) : null,
      allowed_start_time: packForm.allowed_start_time || null,
      starts_at: packForm.starts_date ? new Date(`${packForm.starts_date}T${packForm.starts_time || '00:00'}:00+08:00`).toISOString() : null,
      best_value: packForm.best_value,
    };
    const { error } = editingPackId
      ? await supabase.from('packages').update(fields).eq('id', editingPackId)
      : await supabase.from('packages').insert({ provider_id: provider.id, ...fields });
    setSavingPack(false);
    if (error) return setPackError(error.message);
    setPackNotice(editingPackId ? `Updated "${fields.name}".` : `Added "${fields.name}".`);
    setEditingPackId(null);
    setPackForm(emptyPack);
    load();
  }

  // Inline expiry editor for a single purchase — same control as the make-up
  // tokens page, for when a parent asks for more time and the vendor agrees.
  const [editingPurchaseId, setEditingPurchaseId] = useState<string | null>(null);
  const [expiryMode, setExpiryMode] = useState<string>('none');
  const [expiryDate, setExpiryDate] = useState<string>('');
  const [savingExpiry, setSavingExpiry] = useState(false);
  const [expiryError, setExpiryError] = useState<string | null>(null);

  function startEditExpiry(p: Purchase) {
    setEditingPurchaseId(p.purchase_id);
    setExpiryError(null);
    if (p.expires_at) {
      setExpiryMode('custom');
      setExpiryDate(new Date(p.expires_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }));
    } else {
      setExpiryMode('none');
      setExpiryDate('');
    }
  }

  async function saveExpiry(p: Purchase) {
    setExpiryError(null);
    let expiresAt: string | null = null;
    if (expiryMode === 'custom') {
      const d = new Date(`${expiryDate}T23:59:59+08:00`);
      if (!expiryDate || Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        setExpiryError('Pick an expiry date in the future.');
        return;
      }
      expiresAt = d.toISOString();
    } else if (expiryMode !== 'none') {
      expiresAt = new Date(Date.now() + Number(expiryMode) * 864e5).toISOString();
    }
    setSavingExpiry(true);
    const { error } = await supabase.rpc('provider_set_purchase_expiry', {
      p_purchase: p.purchase_id,
      p_expires_at: expiresAt,
    });
    setSavingExpiry(false);
    if (error) {
      setExpiryError(error.message);
      return;
    }
    setEditingPurchaseId(null);
    refetch();
  }

  const statusBadge = (s: string) => cn(
    'inline-block px-2 py-0.5 text-xs rounded-full capitalize',
    s === 'active' ? 'bg-green-300 text-green-800' : s === 'used' ? 'bg-gray-100 text-gray-600' : 'bg-red-100 text-red-600'
  );

  // The DB status column only ever moves active -> used (credits hit 0); it
  // never reflects expires_at, so a purchase can sit at "Active" here for
  // weeks after the parent app has already stopped offering it. Compute the
  // status parents actually experience instead of trusting the raw column.
  const displayStatus = (p: Purchase) =>
    p.status === 'active' && p.expires_at && new Date(p.expires_at) <= new Date() ? 'expired' : p.status;

  // Non-blocking heads-up when the pack being scheduled overlaps another
  // scheduled pack on the same activity — multiple packages per activity
  // stays allowed (see packWindow above), this just flags it.
  const formWindow = packForm.starts_date
    ? packWindow({
        starts_at: new Date(`${packForm.starts_date}T${packForm.starts_time || '00:00'}:00+08:00`).toISOString(),
        expiry_date: packForm.expiryMode === 'date' ? packForm.expiry_date || null : null,
      })
    : null;
  const packConflicts = formWindow
    ? packs.filter((p) => {
        if (p.id === editingPackId) return false;
        const w = packWindow(p);
        if (!w) return false;
        if (!scopesOverlap(scopeSet(packForm.activity_ids), scopeSet(p.activity_ids))) return false;
        return formWindow!.start < w.end && w.start < formWindow!.end;
      })
    : [];

  return (
    <div className="relative">
      {refreshing && <RefreshBar />}
      <div className="flex items-center justify-between px-4 py-5 sm:px-8">
        <div className="w-full text-center sm:w-auto sm:text-left">
          <h1 className="text-2xl font-bold text-gray-900">Packages</h1>
          <p className="text-sm text-gray-500 mt-1">Multi-session packs parents can buy, and who's bought them.</p>
        </div>
      </div>

      <div className="px-4 pb-8 sm:px-8">
        <div className="flex gap-6 border-b border-gray-200 mb-6 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'flex items-center gap-2 text-sm font-medium pb-3 border-b-2 transition-colors',
                activeTab === tab ? 'text-[#FA4D8D] border-[#C90044]' : 'text-gray-500 border-transparent hover:text-gray-700'
              )}
            >
              {tab === 'Packs' ? <PackageIcon className="w-4 h-4" /> : <Users className="w-4 h-4" />}
              {tab}{tab === 'Purchases' && purchases.length > 0 ? ` (${purchases.length})` : ''}
            </button>
          ))}
        </div>

        {loading && <ListRowsSkeleton count={4} lines={1} />}

        {!loading && activeTab === 'Packs' && (
          <div id="pack-form" className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-xs text-gray-500 mb-4">
              Make-up tokens are separate: issue one from <button onClick={() => navigate('/bookings')} className="font-medium text-[#FA4D8D] hover:underline">Bookings</button>, or see who holds one under <button onClick={() => navigate('/make-up-tokens')} className="font-medium text-[#FA4D8D] hover:underline">Make-up tokens</button>.
            </p>
            {packs.length > 0 && (
              <div className="space-y-2">
                {packs.map((p) => (
                  <div key={p.id} className="flex flex-col gap-2 rounded-lg border border-gray-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <span className="font-medium text-gray-900">{p.name}</span>
                      <span className="ml-2 text-sm text-gray-500">{p.credits} classes · ${(p.price_cents / 100).toFixed(0)}</span>
                      {p.best_value && (
                        <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Best value</span>
                      )}
                      {packRestriction(p) && <div className="mt-0.5 text-xs text-purple-700">{packRestriction(p)}</div>}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      {canManage ? (
                        <button onClick={() => togglePack(p)} title={p.active ? 'Pause this pack' : 'Resume this pack'} className={packStatusBadge(packStatus(p))}>
                          {packStatusLabel(packStatus(p))}
                        </button>
                      ) : (
                        <span className={packStatusBadge(packStatus(p))}>{packStatusLabel(packStatus(p))}</span>
                      )}
                      {canManage && (
                        <>
                          <button onClick={() => editPack(p)} title="Edit pack" className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => deletePack(p)} title="Delete pack" className="rounded-lg p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {packs.length === 0 && <div className="text-sm text-gray-400">No packs yet.</div>}

            {canManage && (
              <>
                <div className="mt-5 flex flex-col items-center gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                  <div className="w-full sm:w-auto">
                    <label className="block text-xs font-medium text-gray-600 mb-1 text-center sm:text-left">Pack name</label>
                    <input id="pack-name-input" value={packForm.name} onChange={(e) => setPackForm({ ...packForm, name: e.target.value })} placeholder="10-class pack" className="h-9 w-full rounded-lg border border-gray-300 px-3 text-sm sm:w-auto" />
                  </div>
                  <div className="w-full sm:w-auto">
                    <label className="block text-xs font-medium text-gray-600 mb-1 text-center sm:text-left">Classes</label>
                    <NumberInput value={packForm.credits} onChange={(e) => setPackForm({ ...packForm, credits: e.target.value })} placeholder="10" className="h-9 w-full rounded-lg border border-gray-300 px-3 text-sm sm:w-24" />
                  </div>
                  <div className="w-full sm:w-auto">
                    <label className="block text-xs font-medium text-gray-600 mb-1 text-center sm:text-left">Price (SGD)</label>
                    <NumberInput min="0" step="any" value={packForm.price} onChange={(e) => setPackForm({ ...packForm, price: e.target.value })} placeholder="180" className="h-9 w-full rounded-lg border border-gray-300 px-3 text-sm sm:w-28" />
                  </div>
                  <div className="flex w-full items-center gap-2 sm:w-auto sm:self-end sm:pb-2">
                    <input
                      id="pack-best-value"
                      type="checkbox"
                      checked={packForm.best_value}
                      onChange={(e) => setPackForm({ ...packForm, best_value: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300 text-[#FA4D8D] focus:ring-[#FA4D8D]"
                    />
                    <label htmlFor="pack-best-value" className="text-sm font-medium text-gray-700">
                      Mark as "Best value"
                    </label>
                  </div>
                  <div className="w-full sm:w-auto">
                    <label className="block text-xs font-medium text-gray-600 mb-1 text-center sm:text-left">Start (optional)</label>
                    <div className="flex w-full gap-2">
                      <DatePicker value={packForm.starts_date} onChange={(v) => setPackForm({ ...packForm, starts_date: v })} aria-label="Pack start date" className="w-32 flex-shrink-0" />
                      <TimePicker value={packForm.starts_time} onChange={(v) => setPackForm({ ...packForm, starts_time: v })} className="h-9 w-28 flex-shrink-0" clearable title="Start time (SGT); leave blank for start of day" aria-label="Start time" />
                    </div>
                  </div>
                  <div className="w-full sm:w-auto">
                    <label className="block text-xs font-medium text-gray-600 mb-1 text-center sm:text-left">Expiry</label>
                    <div className="flex w-full gap-2">
                      <SelectField
                        value={packForm.expiryMode}
                        onChange={(v) => setPackForm({ ...packForm, expiryMode: v as ExpiryMode, validity_days: '', expiry_date: '' })}
                        aria-label="Pack expiry type"
                        className="h-9 flex-1 px-3 sm:flex-none sm:w-40"
                      >
                        <Opt value="none">No expiry</Opt>
                        <Opt value="days">Days after purchase</Opt>
                        <Opt value="date">Fixed date</Opt>
                      </SelectField>
                      {packForm.expiryMode === 'days' && (
                        <NumberInput min="1" value={packForm.validity_days} onChange={(e) => setPackForm({ ...packForm, validity_days: e.target.value })} placeholder="90" className="h-9 w-24 flex-shrink-0 rounded-lg border border-gray-300 px-3 text-sm" />
                      )}
                      {packForm.expiryMode === 'date' && (
                        <DatePicker value={packForm.expiry_date} onChange={(v) => setPackForm({ ...packForm, expiry_date: v })} aria-label="Pack expiry date" className="w-36 flex-shrink-0" />
                      )}
                    </div>
                  </div>
                  <button onClick={createPack} disabled={savingPack} className="h-9 w-full rounded-lg bg-[#FA4D8D] px-4 text-sm font-medium text-white disabled:opacity-50 sm:w-auto">
                    {savingPack ? 'Saving…' : editingPackId ? 'Save pack' : 'Add pack'}
                  </button>
                  {editingPackId && (
                    <button
                      onClick={() => { setEditingPackId(null); setPackForm(emptyPack); setPackError(null); setPackNotice(null); }}
                      className="h-9 w-full rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 sm:w-auto"
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {(packError || packNotice) && (
                  <p className={cn('mt-2 text-sm font-medium', packError ? 'text-red-600' : 'text-green-700')}>
                    {packError ?? packNotice}
                  </p>
                )}
                {packConflicts.length > 0 && (
                  <p className="mt-2 text-sm font-medium text-amber-700">
                    Overlaps {packConflicts.map((c) => `"${c.name}" (${packRestriction(c) || 'no other restrictions'})`).join(', ')} for the same activity. That's allowed — parents with credits on more than one will get to pick which pack to spend — but check the dates are what you meant.
                  </p>
                )}
                <div className="mt-3 flex flex-col items-center gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                  <div className="w-full sm:w-auto">
                    <label className="block text-xs font-medium text-gray-600 mb-1 text-center sm:text-left">Restrict to activities (optional)</label>
                    <MultiSelectField
                      values={packForm.activity_ids}
                      onChange={(v) => setPackForm({ ...packForm, activity_ids: v })}
                      allLabel="Any of my activities"
                      aria-label="Restrict to activities"
                      className="h-9 w-full sm:w-56"
                      panelWidth={256}
                    >
                      {activities.map((a) => <Opt key={a.id} value={a.id}>{a.title}</Opt>)}
                    </MultiSelectField>
                  </div>
                  <div className="w-full sm:w-auto">
                    <label className="block text-xs font-medium text-gray-600 mb-1 text-center sm:text-left">Restrict to weekly slot (optional)</label>
                    <div className="flex w-full gap-2">
                      <SelectField value={packForm.allowed_weekday} onChange={(v) => setPackForm({ ...packForm, allowed_weekday: v })} aria-label="Restrict to weekday" className="h-9 flex-1 px-3 sm:flex-none">
                        <Opt value="">Any day</Opt>
                        {WEEKDAY_NAMES.map((d, i) => <Opt key={d} value={String(i)}>{d}</Opt>)}
                      </SelectField>
                      <TimePicker value={packForm.allowed_start_time} onChange={(v) => setPackForm({ ...packForm, allowed_start_time: v })} className="h-9 flex-1 sm:w-28 sm:flex-none" clearable placeholder="Any time" title="Session start time (SGT); leave blank for any time" aria-label="Session start time" />
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-xs text-gray-500">Restricted packs can only be redeemed against matching sessions — e.g. a 4-class pack limited to the Monday 4:00 pm class.</p>
                <p className="mt-1 text-xs text-gray-500">"Best value" shows parents a highlighted badge on this pack. Mark any pack yourself, or leave every pack unmarked to let us highlight whichever works out cheapest per class.</p>
              </>
            )}
          </div>
        )}

        {!loading && activeTab === 'Purchases' && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <div className={cn(PURCHASE_COLS, 'px-5 py-3 bg-gray-50 text-xs font-medium text-gray-500')}>
              <div>Buyer</div><div>Pack</div><div>Credits</div><div>Status</div><div>Purchased / Expires</div>
            </div>
            {purchases.map((p) => (
              <div key={p.purchase_id}>
                <div className={cn(PURCHASE_COLS, 'px-5 py-3 border-t border-gray-100 items-center')}>
                  <div className="min-w-0 text-sm font-medium text-gray-900 break-words">{p.buyer_name}</div>
                  <div className="min-w-0 text-sm text-gray-700 break-words">{p.package_name}</div>
                  <div className="min-w-0 text-sm text-gray-700">{p.credits_remaining}/{p.credits_total}</div>
                  <div><span className={statusBadge(displayStatus(p))}>{displayStatus(p)}</span></div>
                  <div className="text-xs text-gray-500">
                    <div>{fmtDate(p.created_at)}</div>
                    <button
                      onClick={() => (editingPurchaseId === p.purchase_id ? setEditingPurchaseId(null) : startEditExpiry(p))}
                      className="inline-flex items-center gap-1 text-left text-[#FA4D8D] hover:underline"
                      title="Edit expiry"
                    >
                      {p.expires_at ? `Expires ${fmtDate(p.expires_at)}` : 'Set expiry'}
                      <Pencil className="h-3 w-3 flex-shrink-0" />
                    </button>
                  </div>
                </div>
                {editingPurchaseId === p.purchase_id && (
                  <div className="border-t border-gray-100 bg-gray-50 px-5 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-gray-500">Expires</span>
                      <SelectField
                        value={expiryMode}
                        onChange={setExpiryMode}
                        aria-label="Expires"
                        className="px-2 py-1 text-xs text-gray-700"
                      >
                        <Opt value="30">in 30 days</Opt>
                        <Opt value="60">in 60 days</Opt>
                        <Opt value="90">in 90 days</Opt>
                        <Opt value="180">in 6 months</Opt>
                        <Opt value="365">in 12 months</Opt>
                        <Opt value="custom">on a set date…</Opt>
                        <Opt value="none">never</Opt>
                      </SelectField>
                      {expiryMode === 'custom' && (
                        <DatePicker
                          value={expiryDate}
                          onChange={setExpiryDate}
                          aria-label="Purchase expiry date"
                          className="px-2 py-1 text-xs text-gray-700"
                        />
                      )}
                      <button
                        onClick={() => saveExpiry(p)}
                        disabled={savingExpiry}
                        className="rounded-lg bg-[#FA4D8D] px-3 py-1 text-xs font-medium text-white hover:bg-[#e23f7c] disabled:opacity-60"
                      >
                        {savingExpiry ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => setEditingPurchaseId(null)}
                        className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                      >
                        Cancel
                      </button>
                      {expiryError && <span className="text-xs font-medium text-red-600">{expiryError}</span>}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {purchases.length === 0 && <div className="px-5 py-8 text-center text-sm text-gray-400">No one has bought a pack yet.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
