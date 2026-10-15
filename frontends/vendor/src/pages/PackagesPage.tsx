import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { NumberInput } from '@/components/ui/number-input';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Package as PackageIcon, Pencil, Trash2, Users, Plus, X, AlertTriangle, CalendarRange, Ticket } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { useProviderQuery } from '@/lib/useProviderQuery';
import { ListRowsSkeleton, RefreshBar } from '@/components/Skeletons';
import { SelectField, Opt } from '@/components/ui/select-field';
import { MultiSelectField } from '@/components/ui/multi-select-field';
import { TimePicker } from '@/components/ui/time-picker';
import { DatePicker } from '@/components/ui/date-picker';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SectionCard, ToggleRow } from '@/components/FormKit';
import { packagesClosedActivityIds, termsPreviewEnabled, useTerms, useTermsEnabledMap } from '@/lib/termsPreview';

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

const packInputCls = 'h-11 w-full rounded-xl border px-4 text-[15px] font-medium text-gray-900 placeholder:font-normal placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-pink-300';
const packLabelCls = 'mb-1.5 block text-sm font-semibold text-gray-800';
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const tabs = ['Packs', 'Purchases'];

type Pack = {
  id: string; name: string; credits: number; price_cents: number; active: boolean;
  activity_ids: string[] | null; validity_days: number | null; expiry_date: string | null;
  allowed_weekday: number | null; allowed_start_time: string | null; starts_at: string | null;
  available_until: string | null;
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
  starts_date: '', starts_time: '', until_date: '', until_time: '', best_value: false,
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

/** A pack's own [available from, available until) sale window, or null when
 *  it isn't scheduled at all (an ordinary always-on pack, which never
 *  conflicts with anything — multiple such packs per activity is intended,
 *  see packages-multi-per-activity-is-intended). Only packs that actually
 *  use the start-date feature participate in conflict checking. This is
 *  purely about when the pack can be *bought*; expiry_date/validity_days
 *  (00132) instead govern how long a purchase already made stays valid for
 *  its buyer, and don't bound the pack itself. */
function packWindow(p: { starts_at: string | null; available_until: string | null }): { start: number; end: number } | null {
  if (!p.starts_at) return null;
  return {
    start: new Date(p.starts_at).getTime(),
    end: p.available_until ? new Date(p.available_until).getTime() : Infinity,
  };
}
/** Packs are for classes only: a Wix Event (one ticketed occurrence), COURSE
 *  (enrolled as a whole programme) or APPOINTMENT (a single one-to-one slot)
 *  can't be paid for with a one-credit-per-session pack. The parent app already
 *  hides packs on these (BookingPage's packagesNotOffered), so offering them in
 *  the "Restrict to activities" picker only invited packs that can never be used. */
const PACK_INELIGIBLE_WIX_TYPES = new Set(['EVENT', 'COURSE', 'APPOINTMENT']);
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
    activities: { id: string; title: string; wix_service_type: string | null }[];
    packs: Pack[];
    purchases: Purchase[];
  }>(
    provider ? `packages:${provider.id}` : null,
    async () => {
      const [{ data: acts }, { data: pks }, { data: purch }] = await Promise.all([
        supabase.from('activities').select('id, title, wix_service_type').eq('provider_id', provider!.id).is('archived_at', null),
        supabase.from('packages').select('id, name, credits, price_cents, active, activity_ids, validity_days, expiry_date, allowed_weekday, allowed_start_time, starts_at, available_until, best_value').eq('provider_id', provider!.id).order('created_at', { ascending: false }),
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
  // What a pack can be scoped to. `activities` (all of them) stays for naming
  // an existing pack's restriction, even if it points at an ineligible one.
  const packEligibleActivities = activities.filter((a) => !PACK_INELIGIBLE_WIX_TYPES.has(a.wix_service_type ?? ''));
  const packs = data?.packs ?? [];
  // Activities whose terms don't accept packages (term enrolment, preview).
  // They can't be picked for a pack, and packs already limited to them say so.
  const terms = useTerms();
  const termsEnabled = useTermsEnabledMap();
  const closedToPacks = termsPreviewEnabled() ? packagesClosedActivityIds(terms, termsEnabled) : new Set<string>();
  const activityName = (id: string) => activities.find((a) => a.id === id)?.title ?? 'one activity';
  /** The pack's restricted activities whose terms don't accept packages. */
  const blockedFor = (ids: string[] | null) => (ids ?? []).filter((id) => closedToPacks.has(id));
  const blockedNote = (ids: string[] | null) => {
    const blocked = blockedFor(ids);
    if (blocked.length === 0) return null;
    const names = blocked.map(activityName).join(', ');
    return blocked.length === (ids ?? []).length
      ? `Parents can't use this pack anywhere right now: the terms on ${names} don't accept packages.`
      : `Not usable at ${names}: ${blocked.length === 1 ? 'its' : 'their'} terms don't accept packages.`;
  };
  const purchases = data?.purchases ?? [];

  const [packForm, setPackForm] = useState(emptyPack);
  const [savingPack, setSavingPack] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);
  const [packNotice, setPackNotice] = useState<string | null>(null);
  const [editingPackId, setEditingPackId] = useState<string | null>(null);
  // The new/edit pack form is a pop-up; this is whether it is open.
  const [packModal, setPackModal] = useState(false);
  // Set when the pack being edited was scoped only to Events/Courses/
  // Appointments: with those dropped from the picker its scope would read as
  // empty = "any of my activities", so saving must first pick real classes.
  const [needsClassScope, setNeedsClassScope] = useState(false);
  const [togglingPackId, setTogglingPackId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Pack | null>(null);
  const [deletingPack, setDeletingPack] = useState(false);
  // Name/credits/price used to only be checked inside createPack() — so a
  // mistake was invisible until Save was clicked, then again after every
  // fix. These three are common enough (and cheap enough to validate) to
  // flag as soon as the field is touched, instead of only at submit.
  const [packTouched, setPackTouched] = useState<{ name?: boolean; credits?: boolean; price?: boolean }>({});
  const touch = (field: keyof typeof packTouched) => setPackTouched((t) => ({ ...t, [field]: true }));
  const packNameErr = packTouched.name && !packForm.name.trim() ? 'Give the pack a name.' : null;
  const packCreditsErr = packTouched.credits && !(Number(packForm.credits) >= 1) ? 'At least 1 session.' : null;
  const packPriceErr = packTouched.price && packForm.price !== '' && (Number.isNaN(Number(packForm.price)) || Number(packForm.price) < 0) ? 'Enter a valid price.' : null;

  const load = refetch;

  // Dashboard's "Create a Package" shortcut deep-links here with ?new=pack.
  const newParam = searchParams.get('new');
  useEffect(() => {
    if (newParam !== 'pack' || !canManage) return;
    openNewPack();
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newParam, canManage]);

  /** Active/Upcoming/Expired reflects the sale window (available_from /
   *  available_until) the parent app actually enforces; Paused is the
   *  vendor's own on/off switch. This is about whether the pack can still be
   *  bought — separate from expiry_date/validity_days, which only govern how
   *  long a purchase already made stays valid. Mirrors displayStatus below,
   *  which does the analogous thing for purchases. */
  const packStatus = (p: Pack): 'paused' | 'upcoming' | 'active' | 'expired' => {
    if (!p.active) return 'paused';
    const now = new Date();
    if (p.starts_at && new Date(p.starts_at) > now) return 'upcoming';
    if (p.available_until && new Date(p.available_until) <= now) return 'expired';
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
    if (p.starts_at) parts.push(`available from ${fmtDateTime(p.starts_at)}`);
    if (p.available_until) parts.push(`until ${fmtDateTime(p.available_until)}`);
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

  function openNewPack() {
    setEditingPackId(null);
    setNeedsClassScope(false);
    setPackForm(emptyPack);
    setPackError(null);
    setPackNotice(null);
    setPackTouched({});
    setPackModal(true);
  }

  function closePackModal() {
    setPackModal(false);
    setEditingPackId(null);
    setNeedsClassScope(false);
    setPackForm(emptyPack);
    setPackError(null);
    setPackNotice(null);
    setPackTouched({});
  }

  function editPack(p: Pack) {
    setPackModal(true);
    setEditingPackId(p.id);
    setPackError(null);
    setPackNotice(null);
    setPackTouched({});
    const onlyIneligible = !!p.activity_ids?.length && !p.activity_ids.some((id) => packEligibleActivities.some((a) => a.id === id));
    setNeedsClassScope(onlyIneligible);
    if (onlyIneligible) setPackNotice('This pack was limited to events, courses or appointments, which no longer support packs. Choose the classes it should apply to before saving.');
    const starts = p.starts_at ? sgtDateTimeParts(p.starts_at) : null;
    const until = p.available_until ? sgtDateTimeParts(p.available_until) : null;
    setPackForm({
      name: p.name,
      credits: String(p.credits),
      price: String(p.price_cents / 100),
      expiryMode: p.expiry_date ? 'date' : p.validity_days != null ? 'days' : 'none',
      validity_days: p.validity_days != null ? String(p.validity_days) : '',
      expiry_date: p.expiry_date ?? '',
      // Drop any ineligible (Event/Course/Appointment) activity a pack was
      // scoped to before this rule: the picker no longer offers them, and
      // leaving them selected would carry them silently through a save.
      activity_ids: (p.activity_ids ?? []).filter((id) => packEligibleActivities.some((a) => a.id === id)),
      allowed_weekday: p.allowed_weekday != null ? String(p.allowed_weekday) : '',
      allowed_start_time: p.allowed_start_time ?? '',
      starts_date: starts?.date ?? '',
      starts_time: starts?.time ?? '',
      until_date: until?.date ?? '',
      until_time: until?.time ?? '',
      best_value: p.best_value,
    });
  }

  async function togglePack(p: Pack) {
    setTogglingPackId(p.id);
    const { error } = await supabase.from('packages').update({ active: !p.active }).eq('id', p.id);
    setTogglingPackId(null);
    if (error) { toast.error(`Could not ${p.active ? 'pause' : 'resume'} "${p.name}".`, { description: error.message }); return; }
    toast.success(`"${p.name}" ${p.active ? 'paused' : 'resumed'}.`);
    load();
  }

  async function deletePack(p: Pack) {
    setDeletingPack(true);
    const { error } = await supabase.from('packages').delete().eq('id', p.id);
    setDeletingPack(false);
    setDeleteTarget(null);
    if (error) {
      // A pack that has been purchased is referenced by package_purchases, so
      // deleting it would orphan real credits — deactivate instead.
      toast.error(`Could not delete "${p.name}".`, { description: 'It already has purchases — try marking it inactive instead.' });
      return;
    }
    if (editingPackId === p.id) { setEditingPackId(null); setPackForm(emptyPack); }
    toast.success(`Deleted "${p.name}".`);
    load();
  }

  async function createPack() {
    if (!provider) return;
    setPackError(null);
    setPackNotice(null);
    setPackTouched({ name: true, credits: true, price: true });
    const credits = Number(packForm.credits);
    const price = Number(packForm.price);
    if (!packForm.name.trim()) return setPackError('Give the pack a name.');
    if (needsClassScope && packForm.activity_ids.length === 0) return setPackError('Choose which classes this pack applies to — it was limited to events, courses or appointments, which no longer support packs.');
    if (!credits || credits < 1) return setPackError('Credits must be at least 1.');
    if (packForm.price !== '' && (Number.isNaN(price) || price < 0)) return setPackError('Enter a valid price.');
    if (packForm.expiryMode === 'days' && (!packForm.validity_days || Number(packForm.validity_days) < 1)) return setPackError('Enter how many days the pack stays valid, or choose another expiry.');
    if (packForm.expiryMode === 'date' && !packForm.expiry_date) return setPackError('Pick an expiry date.');
    if (packForm.starts_time && !packForm.starts_date) return setPackError('Pick a start date too.');
    if (packForm.until_time && !packForm.until_date) return setPackError('Pick an "available until" date too.');
    if (packForm.until_date && packForm.starts_date && `${packForm.until_date}T${packForm.until_time || '00:00'}` <= `${packForm.starts_date}T${packForm.starts_time || '00:00'}`) {
      return setPackError('"Available until" is before "Available from".');
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
      available_until: packForm.until_date ? new Date(`${packForm.until_date}T${packForm.until_time || '23:59'}:00+08:00`).toISOString() : null,
      best_value: packForm.best_value,
    };
    const { error } = editingPackId
      ? await supabase.from('packages').update(fields).eq('id', editingPackId)
      : await supabase.from('packages').insert({ provider_id: provider.id, ...fields });
    setSavingPack(false);
    if (error) return setPackError(error.message);
    setPackNotice(editingPackId ? `Updated "${fields.name}".` : `Added "${fields.name}".`);
    setPackModal(false);
    setEditingPackId(null);
    setNeedsClassScope(false);
    setPackForm(emptyPack);
    setPackTouched({});
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
        available_until: packForm.until_date ? new Date(`${packForm.until_date}T${packForm.until_time || '23:59'}:00+08:00`).toISOString() : null,
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
          <div id="pack-form" className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Your packs</h2>
                <p className="mt-0.5 max-w-xl text-sm text-gray-500">
                  Make-up tokens are separate: issue one from <button onClick={() => navigate('/bookings')} className="font-semibold text-[#FA4D8D] hover:underline">Bookings</button>, or see who holds one under <button onClick={() => navigate('/make-up-tokens')} className="font-semibold text-[#FA4D8D] hover:underline">Make-up tokens</button>.
                </p>
              </div>
              {canManage && (
                <button
                  onClick={openNewPack}
                  className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#FA4D8D] px-5 text-[15px] font-bold text-white hover:bg-[#e23f7c]"
                >
                  <Plus className="h-5 w-5" /> New pack
                </button>
              )}
            </div>

            {packNotice && !packModal && (
              <p className="rounded-xl bg-green-50 px-4 py-3 text-sm font-semibold text-green-800">{packNotice}</p>
            )}

            {packs.length === 0 ? (
              <div className="rounded-2xl border-2 border-dashed border-gray-300 bg-white p-10 text-center">
                <PackageIcon className="mx-auto h-9 w-9 text-gray-300" />
                <p className="mt-3 text-base font-bold text-gray-800">No packs yet</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-gray-500">
                  A pack bundles several sessions at a better price, and gives parents flexibility to book when it suits them.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {packs.map((p) => (
                  <div key={p.id} className="flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-bold text-gray-900">{p.name}</span>
                        {p.best_value && (
                          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-800">Best value</span>
                        )}
                      </div>
                      <div className="mt-1 text-sm font-semibold text-gray-700">
                        {p.credits} {p.credits === 1 ? 'session' : 'sessions'} · ${(p.price_cents / 100).toFixed(0)}
                        {p.credits > 0 && <span className="ml-2 font-normal text-gray-500">about ${(p.price_cents / 100 / p.credits).toFixed(0)} each</span>}
                      </div>
                      {packRestriction(p) && <div className="mt-1 text-sm text-purple-700">{packRestriction(p)}</div>}
                      {blockedNote(p.activity_ids) && (
                        <div className="mt-1.5 flex items-start gap-1.5 text-sm font-semibold text-amber-800">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {blockedNote(p.activity_ids)}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      {canManage ? (
                        <button
                          onClick={() => togglePack(p)}
                          disabled={togglingPackId === p.id}
                          title={p.active ? 'Pause this pack' : 'Resume this pack'}
                          className={cn(packStatusBadge(packStatus(p)), togglingPackId === p.id && 'opacity-50')}
                        >
                          {togglingPackId === p.id ? 'Working…' : packStatusLabel(packStatus(p))}
                        </button>
                      ) : (
                        <span className={packStatusBadge(packStatus(p))}>{packStatusLabel(packStatus(p))}</span>
                      )}
                      {canManage && (
                        <>
                          <button onClick={() => editPack(p)} title="Edit pack" aria-label="Edit pack" className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800">
                            <Pencil className="h-5 w-5" />
                          </button>
                          <button onClick={() => setDeleteTarget(p)} title="Delete pack" aria-label="Delete pack" className="rounded-lg p-2 text-gray-500 hover:bg-red-50 hover:text-red-600">
                            <Trash2 className="h-5 w-5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {canManage && packModal && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6"
                onMouseDown={(e) => { if (e.target === e.currentTarget) closePackModal(); }}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label={editingPackId ? 'Edit pack' : 'New pack'}
                  className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
                >
                  <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-6 py-4">
                    <h3 className="text-xl font-bold text-gray-900">{editingPackId ? 'Edit pack' : 'New pack'}</h3>
                    <button onClick={closePackModal} className="rounded-lg p-2 hover:bg-gray-100" aria-label="Close">
                      <X className="h-5 w-5 text-gray-600" />
                    </button>
                  </div>

                  <div className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-gray-50/60 p-4 sm:p-6">
                    {packError && (
                      <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {packError}
                      </div>
                    )}
                    {packNotice && (
                      <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {packNotice}
                      </div>
                    )}

                    <SectionCard id="pack-basics" icon={PackageIcon} tone="pink" title="The pack" subtitle="What parents buy: a number of sessions for one price.">
                      <div>
                        <label className={packLabelCls}>Pack name</label>
                        <input
                          id="pack-name-input"
                          value={packForm.name}
                          onChange={(e) => setPackForm({ ...packForm, name: e.target.value })}
                          onBlur={() => touch('name')}
                          placeholder="10-session pack"
                          className={cn(packInputCls, packNameErr ? 'border-red-400' : 'border-gray-300')}
                        />
                        {packNameErr && <p className="mt-1 text-[13px] font-semibold text-red-600">{packNameErr}</p>}
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className={packLabelCls}>Sessions</label>
                          <NumberInput
                            value={packForm.credits}
                            onChange={(e) => setPackForm({ ...packForm, credits: e.target.value })}
                            onBlur={() => touch('credits')}
                            placeholder="10"
                            className={cn(packInputCls, packCreditsErr ? 'border-red-400' : 'border-gray-300')}
                          />
                          {packCreditsErr && <p className="mt-1 text-[13px] font-semibold text-red-600">{packCreditsErr}</p>}
                        </div>
                        <div>
                          <label className={packLabelCls}>Price (SGD)</label>
                          <NumberInput
                            min="0"
                            step="any"
                            value={packForm.price}
                            onChange={(e) => setPackForm({ ...packForm, price: e.target.value })}
                            onBlur={() => touch('price')}
                            placeholder="180"
                            className={cn(packInputCls, packPriceErr ? 'border-red-400' : 'border-gray-300')}
                          />
                          {packPriceErr && <p className="mt-1 text-[13px] font-semibold text-red-600">{packPriceErr}</p>}
                        </div>
                      </div>
                      {Number(packForm.credits) >= 1 && Number(packForm.price) > 0 && (
                        <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-700">
                          That works out at about ${(Number(packForm.price) / Number(packForm.credits)).toFixed(2)} per session.
                        </p>
                      )}
                      <div className="border-t border-gray-100 pt-5">
                        <ToggleRow
                          title={'Mark as "Best value"'}
                          hint="Shows parents a highlighted badge on this pack. Leave every pack unmarked and we highlight whichever is cheapest per session."
                          checked={packForm.best_value}
                          onChange={(v) => setPackForm({ ...packForm, best_value: v })}
                        />
                      </div>
                    </SectionCard>

                    <SectionCard id="pack-sale" icon={CalendarRange} tone="blue" title="When it's sold and how long it lasts" subtitle="The sale window decides when parents can buy. Expiry decides how long their credits stay valid.">
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                          <label className={packLabelCls}>Available from (optional)</label>
                          <div className="flex gap-2">
                            <DatePicker value={packForm.starts_date} onChange={(v) => setPackForm({ ...packForm, starts_date: v })} aria-label="Pack available-from date" className="h-11 min-w-0 flex-1" />
                            <TimePicker value={packForm.starts_time} onChange={(v) => setPackForm({ ...packForm, starts_time: v })} className="h-11 w-28 flex-shrink-0" clearable title="Available-from time (SGT); leave blank for start of day" aria-label="Available-from time" />
                          </div>
                        </div>
                        <div>
                          <label className={packLabelCls}>Available until (optional)</label>
                          <div className="flex gap-2">
                            <DatePicker value={packForm.until_date} onChange={(v) => setPackForm({ ...packForm, until_date: v })} aria-label="Pack available-until date" className="h-11 min-w-0 flex-1" />
                            <TimePicker value={packForm.until_time} onChange={(v) => setPackForm({ ...packForm, until_time: v })} className="h-11 w-28 flex-shrink-0" clearable title="Available-until time (SGT); leave blank for end of day" aria-label="Available-until time" />
                          </div>
                        </div>
                      </div>
                      <div className="border-t border-gray-100 pt-5">
                        <label className={packLabelCls}>Expiry of each purchase</label>
                        <div className="flex flex-wrap gap-2">
                          <SelectField
                            value={packForm.expiryMode}
                            onChange={(v) => setPackForm({ ...packForm, expiryMode: v as ExpiryMode, validity_days: '', expiry_date: '' })}
                            aria-label="Pack expiry type"
                            className="h-11 w-full px-4 sm:w-56"
                          >
                            <Opt value="none">No expiry</Opt>
                            <Opt value="days">Days after purchase</Opt>
                            <Opt value="date">Fixed date</Opt>
                          </SelectField>
                          {packForm.expiryMode === 'days' && (
                            <NumberInput min="1" value={packForm.validity_days} onChange={(e) => setPackForm({ ...packForm, validity_days: e.target.value })} placeholder="90" className={cn(packInputCls, 'w-28 border-gray-300')} aria-label="Days valid" />
                          )}
                          {packForm.expiryMode === 'date' && (
                            <DatePicker value={packForm.expiry_date} onChange={(v) => setPackForm({ ...packForm, expiry_date: v })} aria-label="Pack expiry date" className="h-11 w-44" />
                          )}
                        </div>
                        <p className="mt-2 text-[13px] text-gray-500">Always counted from the day a parent buys, not from "Available from".</p>
                      </div>
                    </SectionCard>

                    <SectionCard id="pack-scope" icon={Ticket} tone="purple" title="Where it can be used" subtitle="Leave both blank and credits work on any of your classes.">
                      <div>
                        <label className={packLabelCls}>Restrict to activities (optional)</label>
                        <MultiSelectField
                          values={packForm.activity_ids}
                          onChange={(v) => setPackForm({ ...packForm, activity_ids: v })}
                          allLabel="Any of my activities"
                          aria-label="Restrict to activities"
                          className="h-11 w-full"
                          panelWidth={320}
                        >
                          {packEligibleActivities.map((a) => (
                            <Opt key={a.id} value={a.id} disabled={closedToPacks.has(a.id) && !packForm.activity_ids.includes(a.id)}>
                              {closedToPacks.has(a.id) ? `${a.title} (terms don't accept packages)` : a.title}
                            </Opt>
                          ))}
                        </MultiSelectField>
                        <p className="mt-1.5 text-[13px] text-gray-500">Packs are for classes only. Wix events, courses and appointments can't be paid for with a pack.</p>
                      </div>
                      <div>
                        <label className={packLabelCls}>Restrict to weekly slot (optional)</label>
                        <div className="flex flex-wrap gap-2">
                          <SelectField value={packForm.allowed_weekday} onChange={(v) => setPackForm({ ...packForm, allowed_weekday: v })} aria-label="Restrict to weekday" className="h-11 flex-1 px-4 sm:flex-none sm:w-48">
                            <Opt value="">Any day</Opt>
                            {WEEKDAY_NAMES.map((d, i) => <Opt key={d} value={String(i)}>{d}</Opt>)}
                          </SelectField>
                          <TimePicker value={packForm.allowed_start_time} onChange={(v) => setPackForm({ ...packForm, allowed_start_time: v })} className="h-11 flex-1 sm:w-36 sm:flex-none" clearable placeholder="Any time" title="Session start time (SGT); leave blank for any time" aria-label="Session start time" />
                        </div>
                        <p className="mt-1.5 text-[13px] text-gray-500">For example, a 4-session pack limited to the Monday 4:00 pm session.</p>
                      </div>
                      {blockedNote(packForm.activity_ids) && (
                        <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          {blockedNote(packForm.activity_ids)} Remove {blockedFor(packForm.activity_ids).length === 1 ? 'it' : 'them'}, or open packages in that term.
                        </p>
                      )}
                      {packConflicts.length > 0 && (
                        <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          Overlaps {packConflicts.map((c) => `"${c.name}" (${packRestriction(c) || 'no other restrictions'})`).join(', ')} for the same activity. That's allowed, and parents with credits on more than one can pick which to spend, but check the dates are what you meant.
                        </p>
                      )}
                    </SectionCard>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-3 border-t border-gray-200 bg-white px-6 py-4">
                    <button onClick={closePackModal} className="h-11 rounded-xl border-2 border-gray-300 px-5 text-[15px] font-bold text-gray-700 hover:bg-gray-50">
                      Cancel
                    </button>
                    <button onClick={createPack} disabled={savingPack} className="h-11 rounded-xl bg-[#FA4D8D] px-6 text-[15px] font-bold text-white hover:bg-[#e23f7c] disabled:opacity-50">
                      {savingPack ? 'Saving…' : editingPackId ? 'Save pack' : 'Add pack'}
                    </button>
                  </div>
                </div>
              </div>
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

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={deleteTarget ? `Delete "${deleteTarget.name}"?` : ''}
        description="Parents who already bought it keep their credits."
        confirmLabel="Delete"
        loading={deletingPack}
        onConfirm={() => deleteTarget && deletePack(deleteTarget)}
      />
    </div>
  );
}
