import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { NumberInput } from '@/components/ui/number-input';
import { LoadingRows } from '@/components/Skeletons';
import { useSearchParams } from 'react-router-dom';
import {
  CalendarPlus,
  MapPin,
  CalendarDays,
  CalendarClock,
  Search,
  SlidersHorizontal,
  MoreVertical,
  Star,
  X,
  Pencil,
  CalendarCheck,
  Trash2,
  ArchiveRestore,
  Plus,
  Clock,
  Crop,
  ImageUp,
  Pause,
  Play,
  RefreshCw,
  Eye,
  Store,
  Music,
  ExternalLink,
  Mail,
  MessageCircle,
  Users,
  Heart,
  PauseCircle,
  PlayCircle,
  FileText,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  Lock,
  Check,
  Sparkles,
  AlertTriangle,
  type LucideIcon,
  Copy,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RainbowLoader } from '@/components/ui/rainbow-loader';
import { SelectField, Opt } from '@/components/ui/select-field';
import { MultiSelectField } from '@/components/ui/multi-select-field';
import { TimePicker } from '@/components/ui/time-picker';
import { DatePicker } from '@/components/ui/date-picker';
import { DurationInput } from '@/components/DurationInput';
import { formatMinutes } from '@/lib/duration';
import { AgeRangeField } from '@/components/AgeRangeField';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PoliciesManager } from '@/components/PoliciesManager';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { cacheGet, cacheSet } from '@/lib/queryCache';
import { resizeImage } from '@/lib/resizeImage';
import { PhotoEditorDialog } from '@/components/PhotoEditorDialog';
import { SKIP_EDITOR_TYPES } from '@/lib/usePhotoEditor';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import LocationsManager from '@/components/LocationsManager';
import { TermsPanel } from '@/components/TermsPanel';
import { fetchTermSlotStats, hasLiveTerm, headlineLabel, headlineParts, saveTerm, setTermsEnabled, termHeadline, termPriceRange, termSessionsBetween, termStatus, termsPreviewEnabled, useTerms, useTermsEnabledMap, type TermSession } from '@/lib/termsPreview';
import { SectionCard, SectionStatus, TONES, ToggleRow, type FormIssue, type Tone } from '@/components/FormKit';
import { BookModeChoice, TermEnrolPanel, TermPicker, TermSessionPicker, UpcomingOfferings, buildTermView, offeringFor, oneOffFor, quoteFor, sgDay, sgTime, type BookMode } from '@/components/ParentTermBooking';
import { ActivityLocationsField, dayPricesFromJson, dayPricesToJson, type DayPrices, type ExtraLocation } from '@/components/ActivityLocationsField';
import { WixFormHandling } from '@/components/WixFormHandling';
import type { Activity, ActivityCategory, VendorCategory } from '@/lib/database.types';


/** The Edit activity form's sections, in order — drives the navigator, the
 *  scroll-to behaviour and which issues belong where. */
const FORM_SECTIONS: { id: string; title: string; icon: LucideIcon; tone: Tone }[] = [
  { id: 'about', title: 'About', icon: Sparkles, tone: 'pink' },
  { id: 'where', title: 'Who, where, price', icon: MapPin, tone: 'blue' },
  { id: 'photos', title: 'Photos', icon: ImageUp, tone: 'purple' },
  { id: 'rules', title: 'Booking rules', icon: ShieldCheck, tone: 'amber' },
  { id: 'parents', title: 'Parent info', icon: MessageCircle, tone: 'teal' },
];

/**
 * The activities table's column tracks. The header and every body row are
 * separate grids, so the track list has to be one shared string — they
 * silently drift apart otherwise.
 *
 * Every track is `minmax(0, …)` rather than a bare `Nfr`: a bare `fr` floors
 * at min-content, so a long category ("Community Events") or location
 * ("Ind-SG Kids Center — Little India") grew its own track, pushed that row's
 * later columns sideways, and left the row misaligned with the header — which
 * read as two columns bleeding into each other. minmax(0, …) holds every row
 * to the same widths and lets long values wrap instead.
 *
 * `gap-x-4` is what actually keeps neighbouring text apart; without it the
 * columns sat flush and "Community Events" ran straight into "Singapore Zoo".
 */
const TABLE_COLS =
  'grid min-w-[1180px] gap-x-4 grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,0.6fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.35fr)]';

const ageLabel = (min: number, max: number) => {
  const f = (m: number) => (m < 24 ? `${m}m` : `${Math.round((m / 12) * 10) / 10}y`);
  return `${f(min)} – ${f(max)}`;
};
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Matches formatDuration in the parent app, so the preview reads identically. */
const formatDuration = (mins: number | null | undefined): string => {
  if (!mins || mins <= 0) return '';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

/** True if [aStart, aEnd) and [bStart, bEnd) share any time. */
/** What to store in activity_sessions.price: null (inherit the activity's
 *  price, migration 00074) when blank, when the activity is a Wix Event, or
 *  when it equals the activity's own price; otherwise the session's override. */
const sessionPriceOverride = (
  raw: string,
  activityPrice: number | string | null | undefined,
  isWixEvent: boolean,
): number | null => {
  if (isWixEvent || raw.trim() === '') return null;
  const n = Math.max(0, Number(raw));
  return activityPrice != null && n === Number(activityPrice) ? null : n;
};
const rangesOverlap = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && aEnd > bStart;
/** Day of the week in Singapore, 0 = Sunday — the key activity_locations.day_prices uses. */
const sgDow = (iso: string) =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Date(iso).toLocaleDateString('en-US', { timeZone: 'Asia/Singapore', weekday: 'short' }));

/** Matches ageLabel-adjacent formatting the parent app uses on the booking
 *  and confirmation pages ("6m – 2.5y"), reused verbatim by the preview. */
type PreviewSession = { id: string; starts_at: string; ends_at: string; capacity: number | null; price: number | null; location_id: string | null };
type ActivitiesSnapshot = {
  activities: Activity[];
  categories: ActivityCategory[];
  locations: { id: string; name: string; address: string | null; postal_code: string | null; latitude: number | null; longitude: number | null }[];
  sessionCounts: Record<string, number>;
  bookingTotals: Record<string, number>;
};
type PreviewPolicy = { id: string; title: string; body: string; document_url: string | null; required: boolean };
type PreviewPackage = { id: string; name: string; credits: number; price_cents: number };

/* Recurrence helpers for the "Add sessions" form. All operate on plain
   yyyy-mm-dd calendar strings via UTC so a vendor in another timezone still
   gets the Singapore calendar day they picked — the same reason the session
   timestamps below are pinned to +08:00. */
/** Weekday of a yyyy-mm-dd date, 0 = Sunday … 6 = Saturday. */
const dowOfYmd = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
/** yyyy-mm-dd shifted by n whole days. */
const shiftYmd = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const p = (x: number) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
};
/** Human date from a yyyy-mm-dd, built from parts so it never shifts a day. */
const fmtYmd = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
};
/** Monday-first, so the toggle row reads the way a week is written here. */
const WEEKDAY_TOGGLES = [
  { i: 1, label: 'M', name: 'Monday' },
  { i: 2, label: 'T', name: 'Tuesday' },
  { i: 3, label: 'W', name: 'Wednesday' },
  { i: 4, label: 'T', name: 'Thursday' },
  { i: 5, label: 'F', name: 'Friday' },
  { i: 6, label: 'S', name: 'Saturday' },
  { i: 0, label: 'S', name: 'Sunday' },
];
/** Every yyyy-mm-dd a given recurrence setting would create a session on. */
const plannedDates = (f: {
  date: string; weeks: string; weekdays: number[]; customDates: string[];
}): string[] => {
  if (!f.date) return [];
  if (f.weeks === 'custom') {
    return [...new Set([f.date, ...f.customDates].filter(Boolean))].sort();
  }
  const nWeeks = Math.min(12, Math.max(1, Number(f.weeks) || 1));
  const baseDow = dowOfYmd(f.date);
  // No day ticked → just the start date's own weekday.
  const days = f.weekdays.length ? f.weekdays : [baseDow];
  const out = new Set<string>();
  for (let w = 0; w < nWeeks; w++) {
    for (const wd of days) {
      // `(wd - baseDow + 7) % 7` keeps week 0 on/after the start date, so
      // picking Wednesday as the start with Monday ticked lands on the NEXT
      // Monday, never the one two days before.
      out.add(shiftYmd(f.date, w * 7 + ((wd - baseDow + 7) % 7)));
    }
  }
  return [...out].sort();
};
/** Guardrail on one "Add to schedule" click. */
const MAX_SESSIONS_PER_ADD = 100;

const emptyForm = {
  title: '', category_id: '', secondary_category_id: '', vendor_category: '' as VendorCategory | '',
  description: '', age_min_months: '', age_max_months: '', price: '',
  location_id: '', default_capacity: '',
  // A private session held at the customer's own home rather than a fixed
  // venue — see 00175. Clears location_id and always matches every region
  // filter on Explore instead of inheriting the provider's own address.
  is_custom_location: false,
  custom_location_label: '',
  // 00250 — the primary venue's weekday prices, and every other venue the
  // activity runs at (each with its own price and weekday prices).
  primary_day_prices: {} as DayPrices,
  extra_locations: [] as ExtraLocation[],
  // Images (00130): 'profile' (default) borrows the provider's own
  // logo/cover/gallery; 'custom' uses this activity's own uploads. Either
  // way cover_image_url is an explicit pick from whichever set is active.
  image_source: 'profile' as 'profile' | 'custom',
  image_urls: [] as string[],
  cover_image_url: '',
  allow_cancellation: true, allow_rescheduling: true,
  cancellation_cutoff_hours: '24', reschedule_cutoff_hours: '24',
  cancellation_refund_mode: 'refund' as 'refund' | 'none',
  // 00074 — booking cut-off, the bespoke information request, and the copy
  // parents see once they've booked.
  booking_cutoff_minutes: '15',
  info_request_enabled: false, info_request_prompt: '',
  // 00252 — an optional second question. '' = none.
  info_request_prompt_2: '',
  what_to_bring: '', confirmation_message: '',
};

/* Per-session booking-policy override (migrations 00133/00137) — surfaced in
   the "Manage schedule" drawer as one "Booking policies" dropdown rather than
   six more always-visible fields on an already-crowded form. 'inherit' (the
   default) sends null for every column; 'custom' sends the values below,
   mirroring the activity-level card. */
type SessPolicy = {
  mode: 'inherit' | 'custom';
  allow_cancellation: boolean;
  cancellation_cutoff_hours: string;
  cancellation_refund_mode: 'refund' | 'none';
  allow_rescheduling: boolean;
  reschedule_cutoff_hours: string;
  booking_cutoff_minutes: string;
};
const inheritSessPolicy: SessPolicy = {
  mode: 'inherit', allow_cancellation: true, cancellation_cutoff_hours: '24',
  cancellation_refund_mode: 'refund', allow_rescheduling: true, reschedule_cutoff_hours: '24',
  booking_cutoff_minutes: '15',
};
/** null for every column when inheriting the activity's own policy. */
/** Booking cut-off is capped at 14 days; over that used to be clamped silently on save. */
const MAX_BOOKING_CUTOFF_MINS = 20160;
function cutoffTooLong(v: string): string | null {
  return v !== '' && Number(v) > MAX_BOOKING_CUTOFF_MINS
    ? 'Booking cut-off can be at most 14 days.'
    : null;
}

/** The line under a booking cut-off field. Blank saves as the 15-minute default. */
function cutoffSentence(v: string): string {
  if (v === '0') return 'Parents can book right up to the start time.';
  const mins = v === '' || !Number.isFinite(Number(v)) ? 15 : Number(v);
  return `Parents can't book within ${formatMinutes(mins)} of the session starting.`;
}

function sessPolicyPayload(p: SessPolicy) {
  if (p.mode === 'inherit') {
    return {
      allow_cancellation: null, cancellation_cutoff_hours: null,
      cancellation_refund_mode: null, allow_rescheduling: null, reschedule_cutoff_hours: null,
      booking_cutoff_minutes: null,
    };
  }
  return {
    allow_cancellation: p.allow_cancellation,
    cancellation_cutoff_hours: hoursOrDefault(p.cancellation_cutoff_hours),
    cancellation_refund_mode: p.cancellation_refund_mode,
    allow_rescheduling: p.allow_rescheduling,
    reschedule_cutoff_hours: hoursOrDefault(p.reschedule_cutoff_hours),
    booking_cutoff_minutes:
      p.booking_cutoff_minutes === ''
        ? 15
        : Math.max(0, Math.min(20160, Number(p.booking_cutoff_minutes))),
  };
}

/** Blank -> the 24h default; an explicit 0 ("no cut-off") must stay 0, which
    `Number(x) || 24` used to silently turn into 24. */
function hoursOrDefault(v: string | number | null | undefined): number {
  if (v === '' || v == null) return 24;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : 24;
}

/** The "Booking policies" dropdown shared by the Add-sessions and per-session
 *  edit forms in the Manage schedule drawer — a single SelectField, same
 *  progressive-disclosure idea as that drawer's own "Repeat for" control,
 *  instead of five more always-visible fields. */
function SessionPolicyEditor({ policy, onChange }: { policy: SessPolicy; onChange: (p: SessPolicy) => void }) {
  const fieldCls = 'w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-pink-300';
  return (
    <div className="space-y-3 rounded-xl bg-gray-50 p-3">
      <div>
        <label className="mb-1 block text-[13px] font-semibold text-gray-700">Booking policies</label>
        <SelectField
          className={fieldCls}
          value={policy.mode}
          onChange={(v) => onChange({ ...policy, mode: v as 'inherit' | 'custom' })}
          aria-label="Booking policies"
        >
          <Opt value="inherit">Same as the activity</Opt>
          <Opt value="custom">Custom for this session</Opt>
        </SelectField>
      </div>
      {policy.mode === 'custom' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-700">Allow cancellations</span>
            <Switch checked={policy.allow_cancellation} onCheckedChange={(v) => onChange({ ...policy, allow_cancellation: v })} />
          </div>
          {policy.allow_cancellation && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Cancellation cut-off (hrs)</label>
                <NumberInput
                  min="0" className={fieldCls}
                  value={policy.cancellation_cutoff_hours}
                  onChange={(e) => onChange({ ...policy, cancellation_cutoff_hours: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">When cancelled</label>
                <SelectField
                  className={fieldCls}
                  value={policy.cancellation_refund_mode}
                  onChange={(v) => onChange({ ...policy, cancellation_refund_mode: v as 'refund' | 'none' })}
                  aria-label="When a booking is cancelled"
                >
                  <Opt value="refund">Refund credit / token</Opt>
                  <Opt value="none">No refund</Opt>
                </SelectField>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-700">Allow rescheduling</span>
            <Switch checked={policy.allow_rescheduling} onCheckedChange={(v) => onChange({ ...policy, allow_rescheduling: v })} />
          </div>
          {policy.allow_rescheduling && (
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Rescheduling cut-off (hrs)</label>
              <NumberInput
                min="0" className={fieldCls}
                value={policy.reschedule_cutoff_hours}
                onChange={(e) => onChange({ ...policy, reschedule_cutoff_hours: e.target.value })}
              />
            </div>
          )}
          {/* Not gated by either switch above — same as the activity-level
              card, a booking cut-off applies regardless of whether
              cancelling/rescheduling are allowed. */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Booking cut-off</label>
            <DurationInput
              className={fieldCls}
              aria-label="Booking cut-off"
              value={policy.booking_cutoff_minutes}
              onChange={(v) => onChange({ ...policy, booking_cutoff_minutes: v })}
            />
            <p className="mt-1 text-[11px] text-gray-400">{cutoffSentence(policy.booking_cutoff_minutes)}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ActivitiesPage() {
  const { provider, role, refreshProvider } = useAuth();
  // Live Stripe payouts, or an admin-granted waiver (providers.allow_manual_payouts,
  // migration 00200 — only the admin API can set it).
  const canPublishWithoutStripe = Boolean(provider?.payouts_enabled || provider?.allow_manual_payouts);
  const canManage = role === 'owner' || role === 'manager';

  const [showDrawer, setShowDrawer] = useState(false);
  /* The dashboard's shortcuts used to drop the vendor on this page's default
     view and leave them to find the right form. `?new=activity|package` opens
     it directly. */
  const [searchParams, setSearchParams] = useSearchParams();

  // Act on ?new=activity once, then strip it so a refresh doesn't reopen the
  // form. (?new=pack is handled by PackagesPage now.)
  const newParam = searchParams.get('new');
  useEffect(() => {
    if (newParam !== 'activity' || !canManage) return;
    openCreate();
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newParam, canManage]);
  const [showMenu, setShowMenu] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [activities, setActivities] = useState<Activity[]>([]);
  const [categories, setCategories] = useState<ActivityCategory[]>([]);
  /* QA 28/08: "It doesn't make sense to have locations in settings and weird
     redirecting from activities to there — can location move to sit under the
     'activities' tab." Venues now live here, next to the activities that use
     them; Settings redirects its old tab across so existing links still land. */
  const [pageTab, setPageTab] = useState<'activities' | 'locations' | 'policies'>('activities');
  const [openNewLocation, setOpenNewLocation] = useState(false);

  /* Deep-linkable: Settings forwards its retired ?tab=locations here (and its
     retired Waivers & consents tab as ?tab=policies), and the dashboard's
     "Add a location" adds &new=location to open the form straight away. Driven
     off the router's params rather than read once at mount, so arriving from
     another page while already on /activities still switches. */
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t === 'locations') {
      setPageTab('locations');
      if (searchParams.get('new') === 'location') setOpenNewLocation(true);
    } else if (t === 'policies') {
      setPageTab('policies');
    }
  }, [searchParams]);

  /* Policy & consent management → Medical disclosure. A provider-level rule
     (00117): off, or on for "all" / "some" of the vendor's classes. The DB
     mirrors it onto activities.requires_medical_disclosure — which the parent
     booking form and every Wix checkout path already read — so a new class
     picks up an "all" rule automatically. */
  const mdMode = (provider?.medical_disclosure_mode ?? 'off') as 'off' | 'all' | 'some';
  const mdIdsSaved = provider?.medical_disclosure_activity_ids ?? [];
  const [mdDraftMode, setMdDraftMode] = useState<'off' | 'all' | 'some'>(mdMode);
  const [mdDraftIds, setMdDraftIds] = useState<string[]>(mdIdsSaved);
  const [mdSaving, setMdSaving] = useState(false);
  const [mdMsg, setMdMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Re-seed the draft whenever the stored rule changes (first load, or after a
  // save round-trips through refreshProvider).
  useEffect(() => {
    setMdDraftMode(mdMode);
    setMdDraftIds(mdIdsSaved);
    setMdMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id, mdMode, mdIdsSaved.join(',')]);

  const mdDirty =
    mdDraftMode !== mdMode ||
    (mdDraftMode === 'some' &&
      (mdDraftIds.length !== mdIdsSaved.length ||
        [...mdDraftIds].sort().join(',') !== [...mdIdsSaved].sort().join(',')));

  async function saveMedicalDisclosure() {
    if (!provider) return;
    setMdSaving(true);
    setMdMsg(null);
    const { error } = await supabase
      .from('providers')
      .update({
        medical_disclosure_mode: mdDraftMode,
        medical_disclosure_activity_ids: mdDraftMode === 'some' ? mdDraftIds : [],
      })
      .eq('id', provider.id);
    setMdSaving(false);
    if (error) {
      setMdMsg({ ok: false, text: error.message });
      return;
    }
    setMdMsg({ ok: true, text: 'Saved' });
    await refreshProvider();
    load();
  }

  const [locations, setLocations] = useState<{ id: string; name: string; address: string | null; postal_code: string | null; latitude: number | null; longitude: number | null }[]>([]);

  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({});
  const [bookingTotals, setBookingTotals] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  // Filter bar (mirrors the design: Status / Location / Age / Category / Sort)
  const [fStatus, setFStatus] = useState('');
  const [fLocation, setFLocation] = useState('');
  const [fAge, setFAge] = useState('');
  // QA: filtering this table by category doesn't help a vendor — they want to
  // pull up one activity and read its stats. Filters by activity instead.
  const [fActivity, setFActivity] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'name' | 'rating'>('updated');

  // Create/Edit-activity form (editingId set = editing an existing activity)
  const [editingId, setEditingId] = useState<string | null>(null);
  // Set while creating a copy (openDuplicate): the original's name, for the drawer header.
  const [copyFrom, setCopyFrom] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  // "Add a second question" clicked, before anything is typed in it (00252).
  const [showSecondQ, setShowSecondQ] = useState(false);
  // A Wix Event–backed activity's price is the cheapest of its ticket types,
  // pulled live from Wix on every sync (lib/wix/events-sync.ts). Anything a
  // vendor typed here would be overwritten on the next run, so the price
  // field is read-only for these — they change it in Wix.
  const editingActivity = editingId ? activities.find((a) => a.id === editingId) ?? null : null;
  // Everything Wix owns is rewritten by the sync on every run (the cron
  // ticks every 5 minutes), so a value typed here is silently undone
  // minutes later. Freeze the lot for any Wix-linked activity rather than
  // letting a vendor edit something that cannot stick — and, worse, letting
  // a parent see a price or capacity Wix will not honour at booking.
  const wixKind = editingActivity?.wix_service_type ?? null;
  // A recurring-series event activity has neither id (its dates carry the events) but is Wix-owned all the same.
  const isWixLinked = !!(editingActivity?.wix_service_id || editingActivity?.wix_event_id || editingActivity?.wix_series_id);
  const isWixEvent = wixKind === 'EVENT';
  // A Wix ticketed event or course is enrolled/reserved inside Wix's own
  // ticketing, not through BabyBrain — there is nothing here to cancel, so
  // the "Allow cancellations" toggle is hidden for these and the activity is
  // always flagged non-cancellable to parents. Native activities and Wix
  // Class / Appointment services keep the toggle.
  const cancellationLocked = wixKind === 'EVENT' || wixKind === 'COURSE';
  // An appointment is 1:1 by definition — a frozen "1" is just noise.
  const hideCapacity = wixKind === 'APPOINTMENT';
  // Price is the one Wix-owned field a vendor may claim, and only on a Wix
  // *Bookings* service: BabyBrain charges those through its own Stripe, so
  // the number is purely commercial and nothing reconciles it against Wix.
  // An event's charge comes from Wix's own ticket reservation, so an
  // editable price there would advertise one amount and take another (00082).
  const priceOverridable = isWixLinked && wixKind !== 'EVENT';
  const [priceOverridden, setPriceOverridden] = useState(false);
  // What Wix itself charges, shown next to an overridden price so the vendor
  // can see it move. wix_price is only filled from the next sync on, hence
  // the fallback to the mirrored price.
  const wixPrice = editingActivity?.wix_price ?? editingActivity?.price ?? null;
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Schedule manager (sessions = the bookable dates/times of an activity)
  type Sess = {
    id: string; starts_at: string; ends_at: string; capacity: number | null; booked: number; waitlisted: number;
    location_id: string | null; price: number | null;
    teacher_name: string | null; studio: string | null;
    /* QA 04/09: pause is per-session as well as per-activity (migration 00084),
       so a week the teacher is away can be closed without shutting the class. */
    bookings_paused: boolean;
    // Per-session booking-policy override (migrations 00133/00137) — null =
    // inherit the activity's own setting.
    allow_cancellation: boolean | null;
    cancellation_cutoff_hours: number | null;
    cancellation_refund_mode: 'refund' | 'none' | null;
    allow_rescheduling: boolean | null;
    reschedule_cutoff_hours: number | null;
    booking_cutoff_minutes: number | null;
  };
  const [scheduleFor, setScheduleFor] = useState<Activity | null>(null);
  // Term enrolment is a UI preview behind a flag (lib/termsPreview.ts).
  const termsOn = termsPreviewEnabled();
  const [scheduleTab, setScheduleTab] = useState<'single' | 'terms'>('single');
  // Edit activity pop-up: which section is in view, and the scroller it lives in.
  const [formSection, setFormSection] = useState('about');
  const formScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (showDrawer) setFormSection('about'); }, [showDrawer]);
  // The open activity's venues and their prices (00250), for the schedule
  // drawer's venue list and the price each session will actually cost.
  const [scheduleLocs, setScheduleLocs] = useState<{ location_id: string; price: number | null; day_prices: Record<string, number> }[]>([]);
  const [sessions, setSessions] = useState<Sess[]>([]);
  // True from the moment the schedule drawer opens until its sessions have
  // actually loaded — otherwise the empty initial list reads as "no sessions".
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const scheduleOpenSeq = useRef(0);
  // Same story as the edit drawer's price field: a Wix Event's price comes
  // from its ticket types and is re-synced every run, so the per-session
  // price boxes in here are read-only for one.
  const scheduleIsWixEvent = scheduleFor?.wix_service_type === 'EVENT';
  // Sessions for ANY Wix-linked activity are Wix's: /api/wix/slots mirrors
  // live availability into activity_sessions and reconciles away anything
  // that no longer matches. A hand-added session here is either swept or
  // becomes a slot Wix will refuse to book, so the whole schedule is
  // read-only for them.
  const scheduleIsWix = !!(scheduleFor?.wix_service_id || scheduleFor?.wix_event_id || scheduleFor?.wix_series_id);
  /* QA 21/08: location and price move to the schedule, so the same class at
     three venues (or three prices) is ONE activity. Blank inherits the
     activity's own value. */
  /* Recurrence is now two independent controls plus an escape hatch:
       weekdays   — which days of the week a session lands on
       weeks      — how many weeks the pattern runs for ('1'..'12', or
                    'custom' to hand-pick dates instead)
       customDates — the hand-picked list, used only when weeks === 'custom'
     `date` is the anchor: week 0 of the pattern, and always the first custom
     date. See plannedDates() for how the three combine. */
  const [sessForm, setSessForm] = useState({
    date: '', time: '', duration: '45', capacity: '',
    weekdays: [] as number[], weeks: '1', customDates: [] as string[],
    teacher: '', studio: '', location_id: '', price: '',
    policy: inheritSessPolicy,
  });
  // The date sitting in the "extra dates" picker before it's added to the list.
  const [customDateDraft, setCustomDateDraft] = useState('');
  const [savingSess, setSavingSess] = useState(false);
  const [sessError, setSessError] = useState<string | null>(null);
  const [togglingSessId, setTogglingSessId] = useState<string | null>(null);
  const [removeSessTarget, setRemoveSessTarget] = useState<Sess | null>(null);

  // Term classes of the activity being scheduled (UI preview). They sit in the
  // same list as drop-in sessions, tagged "Term", so one can't be mistaken for
  // a single class and removed without knowing who it affects.
  const allTerms = useTerms();
  // Does this activity offer terms at all? (activity id -> on). Off = the Terms
  // tab is frozen; on = the activity's own price and capacity are frozen.
  const termsEnabledMap = useTermsEnabledMap();
  const [termsToggle, setTermsToggle] = useState(false);
  useEffect(() => {
    if (showDrawer) setTermsToggle(termsOn && editingId ? !!termsEnabledMap[editingId] : false);
    // Only when the form opens or a different activity is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDrawer, editingId]);
  const [skipTermTarget, setSkipTermTarget] = useState<TermSession | null>(null);
  const termClassRows = useMemo(() => {
    if (!termsOn || !scheduleFor) return [];
    const mine = allTerms.filter((t) => t.activityId === scheduleFor.id);
    if (mine.length === 0) return [];
    return termSessionsBetween(mine, new Map([[scheduleFor.id, scheduleFor.title]]), new Date(), new Date(Date.now() + 400 * 86_400_000));
  }, [termsOn, scheduleFor, allTerms]);
  // While an activity offers terms ("Offer this activity as a term" in Edit
  // activity), its sessions come from its terms, so the Single sessions tab is
  // locked for adding new ones. Off: the Terms tab is the locked one instead.
  const singlesLocked = !!(termsOn && scheduleFor && termsEnabledMap[scheduleFor.id]);
  const sessionItems = useMemo(
    () =>
      [
        ...sessions.map((s) => ({ at: s.starts_at, s, term: undefined })),
        ...termClassRows.map((t) => ({ at: t.starts_at, s: undefined, term: t })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [sessions, termClassRows],
  );
  /** Removing one class of a draft term means skipping that date for the slot.
   *  (A published term's classes are real sessions, cancelled like any other.) */
  async function skipTermClass(t: TermSession) {
    const term = allTerms.find((x) => x.id === t.termId);
    if (!term) return;
    try {
      await saveTerm({
        ...term,
        slots: term.slots.map((sl) => (sl.id === t.slotId ? { ...sl, skip: [...(sl.skip ?? []), t.ymd] } : sl)),
      });
      toast('Session skipped for this term');
    } catch (e) {
      toast.error((e as { message?: string })?.message ?? 'Could not skip that session');
    }
    setSkipTermTarget(null);
  }
  const [removingSess, setRemovingSess] = useState(false);
  // Heads-up only: sessions were saved, but overlap something on the Wix calendar.
  const [sessNotice, setSessNotice] = useState<string | null>(null);
  // Every date the current recurrence settings would create a session on —
  // drives the count shown under the form and the rows addSessions() inserts.
  const plannedSessionDates = useMemo(() => plannedDates(sessForm), [sessForm]);

  // Per-session teacher/studio can also be set after the fact (a substitute
  // teacher, or a room reassignment) without recreating the session.
  const [editingSessId, setEditingSessId] = useState<string | null>(null);
  /* QA 21/08: "under activities, manage schedule when you click edit upcoming
     sessions, it only allows you to add teacher and studio details — it should
     allow you to edit all the details." Date, start time, duration and capacity
     are now editable too; changing any of them rewrites starts_at/ends_at. */
  const [sessEditForm, setSessEditForm] = useState({
    date: '', time: '', duration: '45', capacity: '', teacher: '', studio: '', location_id: '', price: '',
    policy: inheritSessPolicy,
  });
  const [sessEditError, setSessEditError] = useState<string | null>(null);
  const [savingSessEdit, setSavingSessEdit] = useState(false);

  /* Parent-view preview. Vendors kept publishing blind and then opening the
     public site in another tab to check; this shows the same information
     without leaving the table. Read-only — the CTAs are rendered inert.
     Three pages mirror the parent's actual journey: the activity page, the
     booking page, and the post-booking confirmation — navigated with the
     arrows in the header bar. */
  const [previewFor, setPreviewFor] = useState<Activity | null>(null);
  // Places still free in each group of the previewed activity's published terms.
  const [previewPlaces, setPreviewPlaces] = useState<Record<string, number | null>>({});
  useEffect(() => {
    if (!termsOn || !previewFor) { setPreviewPlaces({}); return; }
    const published = allTerms.filter((t) => t.activityId === previewFor.id && t.status === 'published');
    if (published.length === 0) { setPreviewPlaces({}); return; }
    let stale = false;
    Promise.all(published.map((t) => fetchTermSlotStats(t.id)))
      .then((lists) => { if (!stale) setPreviewPlaces(Object.fromEntries(lists.flat().map((s) => [s.slot_id, s.places_left]))); })
      .catch(() => { if (!stale) setPreviewPlaces({}); });
    return () => { stale = true; };
  }, [termsOn, previewFor, allTerms]);
  const [previewDuration, setPreviewDuration] = useState<number | 'loading' | null>('loading');
  const [previewPage, setPreviewPage] = useState(0);
  // Term enrolment in the preview: which option the vendor is looking at, the
  // slot, and how far into the term to pretend it is (all outside the replica).
  const [previewMode, setPreviewMode] = useState<BookMode>('term');
  const [previewSlotIdx, setPreviewSlotIdx] = useState(0);
  /** The term picked under "Which term?" on the booking page; null = the first. */
  const [previewTermId, setPreviewTermId] = useState<string | null>(null);
  /** The date picked for a trial, single or package booking of a term. */
  const [previewOneOffDate, setPreviewOneOffDate] = useState<string | null>(null);
  const [previewPassed, setPreviewPassed] = useState(0);
  // How many trial sessions the previewed child has already used.
  const [previewTrialUsed, setPreviewTrialUsed] = useState(0);
  const previewForId = previewFor?.id;
  useEffect(() => { setPreviewMode('term'); setPreviewSlotIdx(0); setPreviewPassed(0); setPreviewTrialUsed(0); setPreviewTermId(null); setPreviewOneOffDate(null); }, [previewForId]);
  const PREVIEW_PAGE_COUNT = 3;
  const [previewSessions, setPreviewSessions] = useState<PreviewSession[]>([]);
  const [previewPolicies, setPreviewPolicies] = useState<PreviewPolicy[]>([]);
  const [previewPackages, setPreviewPackages] = useState<PreviewPackage[]>([]);
  /* Index into the carousel shown on page 1 — the one thing in the preview
     that stays interactive, so a vendor can check every photo's crop without
     leaving the table. Reset whenever a different activity (or a fresh open
     of the same one) is previewed. */
  const [previewPhotoAt, setPreviewPhotoAt] = useState(0);

  function openPreview(a: Activity) {
    setShowMenu(null);
    setPreviewFor(a);
    setPreviewPage(0);
    setPreviewPhotoAt(0);
  }

  /* Nothing stores a duration on the activity — the parent page derives it
     from the next session, so this reads that single row to match. Kept in an
     effect rather than the open handler so it re-runs whenever the previewed
     activity changes or its session count moves (adding or deleting sessions
     refreshes sessionCounts), and the stale guard drops a slow response that
     lands after the vendor has moved on. */
  useEffect(() => {
    if (!previewFor) return;
    let stale = false;
    setPreviewDuration('loading');
    (async () => {
      const { data } = await supabase
        .from('activity_sessions')
        .select('starts_at, ends_at')
        .eq('activity_id', previewFor.id)
        .neq('status', 'cancelled')
        .gte('starts_at', new Date().toISOString())
        .order('starts_at')
        .limit(1)
        .maybeSingle();
      if (stale) return;
      if (!data) { setPreviewDuration(null); return; }
      const mins = Math.round((new Date(data.ends_at).getTime() - new Date(data.starts_at).getTime()) / 60000);
      setPreviewDuration(mins > 0 ? mins : null);
    })();
    return () => { stale = true; };
  }, [previewFor, sessionCounts]);

  /* Feeds the booking-page and confirmation-page previews: the next few
     upcoming sessions (for the date/time step and the "when" line), and this
     provider's terms and packages, scoped to this activity exactly as the
     real booking page scopes them (provider-wide, or activity_ids includes
     this one). */
  useEffect(() => {
    if (!previewFor || !provider) { setPreviewSessions([]); setPreviewPolicies([]); setPreviewPackages([]); return; }
    let stale = false;
    supabase
      .from('activity_sessions')
      .select('id, starts_at, ends_at, capacity, price, location_id')
      .eq('activity_id', previewFor.id)
      .neq('status', 'cancelled')
      .gte('starts_at', new Date().toISOString())
      .order('starts_at')
      .limit(6)
      .then(({ data }) => { if (!stale) setPreviewSessions((data ?? []) as PreviewSession[]); });
    supabase
      .from('provider_policies')
      .select('id, title, body, document_url, required, activity_ids')
      .eq('provider_id', provider.id)
      .eq('active', true)
      .order('sort_order')
      .then(({ data }) => {
        if (stale) return;
        const rows = (data ?? []) as unknown as Array<PreviewPolicy & { activity_ids: string[] | null }>;
        setPreviewPolicies(rows.filter((p) => !p.activity_ids || p.activity_ids.length === 0 || p.activity_ids.includes(previewFor.id)));
      });
    supabase
      .from('packages')
      .select('id, name, credits, price_cents, activity_ids, starts_at, available_until')
      .eq('provider_id', provider.id)
      .eq('active', true)
      .then(({ data }) => {
        if (stale) return;
        const rows = ((data ?? []) as unknown as Array<PreviewPackage & { activity_ids: string[] | null; starts_at: string | null; available_until: string | null }>)
          // Same sale-window rule as the parent app's isPackOnSale: a pack
          // that hasn't reached "Available from" (or is past "Available
          // until") isn't shown to parents, so the preview must hide it too.
          .filter((p) => {
            const now = Date.now();
            if (p.starts_at && new Date(p.starts_at).getTime() > now) return false;
            if (p.available_until && new Date(p.available_until).getTime() <= now) return false;
            return true;
          });
        // Packs are for classes only — the parent app hides them on a Wix
        // Event/COURSE/APPOINTMENT, so the preview must too.
        const packsNotOffered = previewFor.wix_service_type === 'EVENT' || previewFor.wix_service_type === 'COURSE' || previewFor.wix_service_type === 'APPOINTMENT';
        setPreviewPackages(packsNotOffered ? [] : rows.filter((p) => !p.activity_ids || p.activity_ids.length === 0 || p.activity_ids.includes(previewFor.id)));
      });
    return () => { stale = true; };
  }, [previewFor, provider]);

  /* The activity's own address is often blank on Wix-synced rows, which left
     the parent view with no Location at all. Fall back to the linked venue. */
  const previewLocation = (a: Activity) => {
    if (a.address) return [a.address, a.postal_code].filter(Boolean).join(', ');
    const l = locations.find((x) => x.id === a.location_id);
    if (!l) return null;
    return [l.name, l.address, l.postal_code].filter(Boolean).join(', ');
  };

  // Escape closes the preview, like every other dialog on the platform.
  useEffect(() => {
    if (!previewFor) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewFor(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewFor]);

  /* The edit / schedule panels are centred pop-ups with a dimmed backdrop
     (they used to be right-edge drawers that covered the row-actions
     three-dots). Escape closes them, the same as the preview. */
  useEffect(() => {
    if (!showDrawer && !scheduleFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setShowDrawer(false);
      setScheduleFor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showDrawer, scheduleFor]);

  /* Defence in depth. Nothing on this page should ever leave the document
     locked, but if a portaled overlay somewhere does hand back a body with
     `pointer-events: none` (the page would feel frozen), release it the moment
     every menu / drawer / preview here is closed — unless another Radix popper
     (a filter dropdown) is legitimately open. Pure DOM, no network, no cost. */
  useEffect(() => {
    if (showMenu || showDrawer || scheduleFor || previewFor) return;
    if (
      document.body.style.pointerEvents === 'none' &&
      !document.querySelector('[data-radix-popper-content-wrapper]')
    ) {
      document.body.style.pointerEvents = '';
    }
  }, [showMenu, showDrawer, scheduleFor, previewFor]);

  /** The schedule activity's row for a session's venue (no venue = the primary). */
  const schedLoc = (locId: string | null | undefined) =>
    scheduleLocs.find((r) => r.location_id === (locId || scheduleFor?.location_id));
  /** What a session at this venue costs before any day price: the venue's own price, else the activity's. */
  const venueBasePrice = (locId: string | null | undefined) => schedLoc(locId)?.price ?? scheduleFor?.price ?? null;
  /** What a session really costs — the same rule as session_price() in 00250:
   *  the venue's weekday price, then the session's own, the venue's, the activity's. */
  const sessEffectivePrice = (x: { starts_at: string; price: number | string | null; location_id: string | null }) => {
    const r = schedLoc(x.location_id);
    const day = r?.day_prices?.[String(sgDow(x.starts_at))];
    return day ?? (x.price != null ? Number(x.price) : null) ?? r?.price ?? scheduleFor?.price ?? null;
  };
  /** An activity with several venues offers only those; otherwise every venue the vendor has. */
  const scheduleVenues = scheduleLocs.length > 1
    ? scheduleLocs.map((r) => locations.find((l) => l.id === r.location_id)).filter((l): l is (typeof locations)[number] => !!l)
    : locations;

  async function openSchedule(a: Activity) {
    setShowMenu(null);
    const seq = ++scheduleOpenSeq.current;
    setScheduleTab('single');
    // Drop the previous activity's rows so nothing stale shows while loading.
    setSessions([]);
    setSessionsLoading(true);
    setScheduleFor(a);
    setScheduleLocs([]);
    supabase
      .from('activity_locations')
      .select('location_id, price, day_prices, position')
      .eq('activity_id', a.id)
      .order('position')
      .then(({ data }) => {
        if (seq === scheduleOpenSeq.current && data) setScheduleLocs(data);
      });
    setSessError(null);
    setSessNotice(null);
    // Pre-fill from the activity's default capacity so a vendor adding
    // sessions doesn't have to retype the same number every time.
    setSessForm((f) => ({
      ...f,
      capacity: a.default_capacity != null ? String(a.default_capacity) : f.capacity,
      // Start from the activity's own venue/price so the common case (all
      // sessions the same) is still one click.
      location_id: a.location_id ?? '',
      price: a.price != null ? String(a.price) : '',
      // Don't carry a half-built recurrence from a previous activity.
      date: '', weekdays: [], weeks: '1', customDates: [],
      policy: inheritSessPolicy,
    }));
    setCustomDateDraft('');
    // This drawer's own copy tells a vendor "these sessions mirror live
    // availability on your Wix calendar" — but until now nothing here ever
    // actually asked Wix for it. SchedulePage already does this same live
    // refresh on every load (for every Wix-linked activity in one batch),
    // so a vendor who's visited that tab even once already has fresh data
    // here too; this closes the gap for the vendor who opens this preview
    // straight after importing, before ever visiting Schedule, and would
    // otherwise see a blank date/time/duration for a fully-configured Wix
    // appointment/class/course. Best-effort: a slow or failing Wix call
    // never blocks the drawer from opening with whatever's already cached.
    if (a.wix_service_id) {
      try {
        await apiGet(`/api/wix/slots?activityId=${a.id}&days=${a.wix_service_type === 'COURSE' ? 60 : 30}`);
      } catch {
        // best-effort — loadSessions below still shows the last saved copy
      }
    }
    try {
      await loadSessions(a.id, seq);
    } finally {
      if (seq === scheduleOpenSeq.current) setSessionsLoading(false);
    }
  }

  // `seq` pins this call to the drawer that was open when it was kicked off
  // (scheduleOpenSeq at call time) — if the vendor has since closed that
  // drawer or opened a different activity's before this round-trip lands, the
  // response is dropped instead of overwriting the now-current drawer's
  // sessions (and their capacity/duration numbers) with another activity's.
  async function loadSessions(activityId: string, seq: number = scheduleOpenSeq.current) {
    const { data: sess } = await supabase
      .from('activity_sessions')
      .select('id, starts_at, ends_at, capacity, teacher_name, studio, location_id, price, bookings_paused, allow_cancellation, cancellation_cutoff_hours, cancellation_refund_mode, allow_rescheduling, reschedule_cutoff_hours, booking_cutoff_minutes')
      .eq('activity_id', activityId)
      // A class the vendor cancelled on Wix is marked cancelled by the sync
      // (cancel_wix_session); it is gone, so it doesn't belong in the schedule.
      .neq('status', 'cancelled')
      .gte('starts_at', new Date().toISOString())
      .order('starts_at');
    const rows = sess ?? [];
    // Seats held per session (what capacity can't drop below) and the
    // waitlist, counted apart — a waitlisted row holds no seat, so it must not
    // count toward the capacity floor or the "booked" figure.
    const counts: Record<string, number> = {};
    const waiting: Record<string, number> = {};
    if (rows.length) {
      const { data: bks } = await supabase
        .from('bookings')
        .select('session_id, status')
        .in('session_id', rows.map((s) => s.id));
      (bks ?? []).forEach((b) => {
        if (b.status === 'waitlisted') waiting[b.session_id] = (waiting[b.session_id] ?? 0) + 1;
        else if (b.status !== 'cancelled') counts[b.session_id] = (counts[b.session_id] ?? 0) + 1;
      });
    }
    if (seq !== scheduleOpenSeq.current) return;
    setSessions(rows.map((s) => ({ ...s, booked: counts[s.id] ?? 0, waitlisted: waiting[s.id] ?? 0 })));
  }

  async function addSessions() {
    if (!scheduleFor || !sessForm.date || !sessForm.time) {
      setSessError('Pick a date and start time.');
      return;
    }
    if (!sessForm.capacity || Number(sessForm.capacity) < 1) {
      setSessError('Set a capacity for this session.');
      return;
    }
    const dates = plannedSessionDates;
    if (dates.length === 0) {
      setSessError(sessForm.weeks === 'custom' ? 'Add at least one date.' : 'Pick at least one day of the week.');
      return;
    }
    if (dates.length > MAX_SESSIONS_PER_ADD) {
      setSessError(`That works out to ${dates.length} sessions in one go — trim the days or weeks, or add them in a couple of batches.`);
      return;
    }
    if (!Number.isFinite(Number(sessForm.duration)) || Number(sessForm.duration) < 15) {
      setSessError('Duration must be at least 15 minutes.');
      return;
    }
    const cutoffErrNew = sessForm.policy.mode === 'inherit' ? null : cutoffTooLong(sessForm.policy.booking_cutoff_minutes);
    if (cutoffErrNew) { setSessError(cutoffErrNew); return; }
    setSavingSess(true);
    setSessError(null);
    setSessNotice(null);
    const durationMins = Number(sessForm.duration);
    // Each date is a Singapore calendar day (plannedDates keeps it TZ-safe);
    // the start time is pinned to +08:00 so a vendor travelling abroad still
    // schedules in the platform's timezone.
    const rows = dates.map((ymd) => {
      const starts = new Date(`${ymd}T${sessForm.time}:00+08:00`);
      const ends = new Date(starts.getTime() + durationMins * 60000);
      return {
        activity_id: scheduleFor.id,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        capacity: sessForm.capacity ? Number(sessForm.capacity) : null,
        // Left blank for activity types where neither applies (playspaces,
        // community events) — that's what "N/A" means here.
        teacher_name: sessForm.teacher.trim() || null,
        studio: sessForm.studio.trim() || null,
        // Blank inherits the activity's venue/price (migration 00074). The
        // picker is pre-filled with the activity's own venue, so "left as-is"
        // must store null (inherit), not a copy — otherwise moving the
        // activity later leaves these sessions, and their booking emails,
        // pointing at the old place (migration 00112).
        location_id:
          sessForm.location_id && sessForm.location_id !== (scheduleFor.location_id ?? '')
            ? sessForm.location_id
            : null,
        // A Wix Event's price is Wix's — never override it per session. The
        // field is pre-filled with the activity's price, so "left as-is" must
        // store null (inherit), not a copy — otherwise changing the activity
        // price later leaves these sessions on the old one (same idea as
        // location_id above).
        price: sessionPriceOverride(sessForm.price, venueBasePrice(sessForm.location_id), scheduleIsWixEvent),
        ...sessPolicyPayload(sessForm.policy),
      };
    });
    // Overlapping something on the Wix calendar is allowed (parallel classes,
    // rooms and staff differ) — but the vendor gets a heads-up after saving.
    // A failed lookup never blocks saving either.
    let clashNotice: string | null = null;
    if (provider?.wix_site_id) {
      try {
        const { ranges } = await apiGet<{ ranges: { start: string; end: string }[] }>(`/api/wix/busy?providerId=${provider.id}`);
        const clashing = rows.filter((row) => {
          const start = new Date(row.starts_at);
          const end = new Date(row.ends_at);
          return ranges.some((r) => rangesOverlap(start, end, new Date(r.start), new Date(r.end)));
        });
        if (clashing.length) {
          const when = clashing.slice(0, 3).map((r) => fmtDateTime(r.starts_at)).join('; ');
          const more = clashing.length > 3 ? ` and ${clashing.length - 3} more` : '';
          clashNotice = `Added — just a heads-up: ${clashing.length === 1 ? 'this session runs' : `${clashing.length} sessions run`} at the same time as something already on your Wix calendar (${when}${more}). That's fine if you have the space and staff for both.`;
        }
      } catch {
        // Clash check is advisory only.
      }
    }

    const { error } = await supabase.from('activity_sessions').insert(rows);
    setSavingSess(false);
    if (error) {
      setSessError(error.message);
      return;
    }
    setSessNotice(clashNotice);
    setSessForm({
      date: '', time: '', duration: sessForm.duration, capacity: sessForm.capacity,
      weekdays: [], weeks: '1', customDates: [],
      teacher: sessForm.teacher, studio: sessForm.studio, location_id: sessForm.location_id, price: sessForm.price,
      policy: sessForm.policy,
    });
    setCustomDateDraft('');
    await loadSessions(scheduleFor.id);
    load(); // refresh the upcoming counts in the table
  }

  function startEditSess(s: Sess) {
    setEditingSessId(s.id);
    setSessEditError(null);
    // Read the stored instant back out as Singapore wall-clock time, which is
    // what the vendor typed in and what the list shows.
    const sgt = new Date(new Date(s.starts_at).toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
    const pad = (n: number) => String(n).padStart(2, '0');
    // Custom only when the session actually carries an override; each field
    // individually falls back to the activity's own current value so the
    // "Custom" panel never shows a blank/wrong-looking number.
    const hasOverride =
      s.allow_cancellation != null || s.cancellation_cutoff_hours != null ||
      s.cancellation_refund_mode != null || s.allow_rescheduling != null ||
      s.reschedule_cutoff_hours != null || s.booking_cutoff_minutes != null;
    setSessEditForm({
      date: `${sgt.getFullYear()}-${pad(sgt.getMonth() + 1)}-${pad(sgt.getDate())}`,
      time: `${pad(sgt.getHours())}:${pad(sgt.getMinutes())}`,
      duration: String(Math.round((new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000) || 45),
      capacity: s.capacity != null ? String(s.capacity) : '',
      teacher: s.teacher_name ?? '',
      studio: s.studio ?? '',
      location_id: s.location_id ?? '',
      price: s.price != null ? String(s.price) : '',
      policy: {
        mode: hasOverride ? 'custom' : 'inherit',
        allow_cancellation: s.allow_cancellation ?? scheduleFor?.allow_cancellation ?? true,
        cancellation_cutoff_hours: String(s.cancellation_cutoff_hours ?? scheduleFor?.cancellation_cutoff_hours ?? 24),
        cancellation_refund_mode: s.cancellation_refund_mode ?? scheduleFor?.cancellation_refund_mode ?? 'refund',
        allow_rescheduling: s.allow_rescheduling ?? scheduleFor?.allow_rescheduling ?? true,
        reschedule_cutoff_hours: String(s.reschedule_cutoff_hours ?? scheduleFor?.reschedule_cutoff_hours ?? 24),
        booking_cutoff_minutes: String(s.booking_cutoff_minutes ?? scheduleFor?.booking_cutoff_minutes ?? 15),
      },
    });
  }

  async function saveSessEdit(id: string) {
    if (!scheduleFor) return;
    setSessEditError(null);

    // A Wix-synced session's own schedule (date/time/capacity/venue/etc) is
    // Wix's — /api/wix/slots owns and reconciles it, so this path only ever
    // touches the 5 booking-policy columns, which are BabyBrain-side only.
    if (scheduleIsWix) {
      setSavingSessEdit(true);
      const { error } = await supabase
        .from('activity_sessions')
        .update(sessPolicyPayload(sessEditForm.policy))
        .eq('id', id);
      setSavingSessEdit(false);
      if (error) {
        setSessEditError(error.message);
        return;
      }
      setEditingSessId(null);
      await loadSessions(scheduleFor.id);
      return;
    }

    if (!sessEditForm.date || !sessEditForm.time) {
      setSessEditError('Pick a date and start time.');
      return;
    }
    // Capacity is mandatory here for the same reason it is on the add form:
    // a blank one used to mean unlimited bookings.
    if (!sessEditForm.capacity || Number(sessEditForm.capacity) < 1) {
      setSessEditError('Set a capacity for this session.');
      return;
    }
    const booked = sessions.find((s) => s.id === id)?.booked ?? 0;
    if (Number(sessEditForm.capacity) < booked) {
      setSessEditError(`${booked} ${booked > 1 ? 'seats are' : 'seat is'} already booked, so capacity can't go below ${booked}. Families on the waitlist don't count.`);
      return;
    }
    if (!Number.isFinite(Number(sessEditForm.duration)) || Number(sessEditForm.duration) < 15) {
      setSessEditError('Duration must be at least 15 minutes.');
      return;
    }
    const cutoffErrEdit = sessEditForm.policy.mode === 'inherit' ? null : cutoffTooLong(sessEditForm.policy.booking_cutoff_minutes);
    if (cutoffErrEdit) { setSessEditError(cutoffErrEdit); return; }
    const durationMins = Number(sessEditForm.duration);
    // Same SGT pinning as addSessions().
    const starts = new Date(`${sessEditForm.date}T${sessEditForm.time}:00+08:00`);
    if (Number.isNaN(starts.getTime())) {
      setSessEditError('That date and time could not be read.');
      return;
    }
    setSavingSessEdit(true);
    const { error } = await supabase.from('activity_sessions').update({
      starts_at: starts.toISOString(),
      ends_at: new Date(starts.getTime() + durationMins * 60000).toISOString(),
      capacity: Number(sessEditForm.capacity),
      teacher_name: sessEditForm.teacher.trim() || null,
      studio: sessEditForm.studio.trim() || null,
      // Same as the venue that the activity carries -> store null (inherit),
      // so a later activity move carries these sessions with it (00112).
      location_id:
        sessEditForm.location_id && sessEditForm.location_id !== (scheduleFor.location_id ?? '')
          ? sessEditForm.location_id
          : null,
      // Same price as the activity's -> store null (inherit), so a later
      // activity price change carries this session with it.
      price: sessionPriceOverride(sessEditForm.price, venueBasePrice(sessEditForm.location_id), scheduleIsWixEvent),
      ...sessPolicyPayload(sessEditForm.policy),
    }).eq('id', id);
    setSavingSessEdit(false);
    if (error) {
      setSessEditError(error.message);
      return;
    }
    setEditingSessId(null);
    await loadSessions(scheduleFor.id);
    load(); // the table's "next session" column can have moved
  }

  /* Closes just this slot to new parent bookings. The activity-level switch
     (bookings_paused on the activity) still pauses every session at once;
     this one is independent of it, and vendors can still record a manual
     booking against a paused session. Works for a Wix occurrence as well —
     the flag sits on our own session row, the sync never rewrites it, and
     the Wix booking routes check it (isWixSessionPaused). */
  async function toggleSessionPause(s: Sess) {
    if (!scheduleFor) return;
    setTogglingSessId(s.id);
    const { error } = await supabase
      .from('activity_sessions')
      .update({ bookings_paused: !s.bookings_paused })
      .eq('id', s.id);
    setTogglingSessId(null);
    if (error) { toast.error('Could not update this session.', { description: error.message }); return; }
    toast.success(s.bookings_paused ? 'Bookings resumed for this session.' : 'Bookings paused for this session.');
    await loadSessions(scheduleFor.id);
  }

  async function removeSession(s: Sess) {
    if (!scheduleFor) return;
    const total = s.booked + s.waitlisted;
    // A session with bookings can't be deleted (bookings reference it), so it
    // is cancelled instead: parents' bookings are cancelled, emailed and
    // notified in the database (00154). An empty one is simply deleted.
    setRemovingSess(true);
    const { error } = total > 0
      ? await supabase.rpc('vendor_cancel_session', { p_session_id: s.id })
      : await supabase.from('activity_sessions').delete().eq('id', s.id);
    setRemovingSess(false);
    setRemoveSessTarget(null);
    if (error) { toast.error('Could not remove this session.', { description: error.message }); return; }
    toast.success(total > 0 ? 'Session cancelled — parents have been notified.' : 'Session removed.');
    await loadSessions(scheduleFor.id);
    load();
  }

  const hasLoadedRef = useRef(false);
  async function load() {
    if (!provider) return;
    // Stale-while-revalidate: a revisit paints the last list instantly and the
    // read below swaps in fresh data. A reload after an edit (list already on
    // screen) no longer blanks to the loader either — only a cold first load does.
    const cacheKey = `activities:${provider.id}`;
    const warm = cacheGet<ActivitiesSnapshot>(cacheKey);
    if (warm && !hasLoadedRef.current) {
      setActivities(warm.data.activities);
      setCategories(warm.data.categories);
      setLocations(warm.data.locations);
      setSessionCounts(warm.data.sessionCounts);
      setBookingTotals(warm.data.bookingTotals);
      setLoading(false);
    } else if (!hasLoadedRef.current) {
      setLoading(true);
    }
    const [{ data: acts }, { data: cats }, { data: locs }] = await Promise.all([
      supabase.from('activities').select('*').eq('provider_id', provider.id).order('updated_at', { ascending: false }),
      supabase.from('activity_categories').select('*').order('sort_order'),
      supabase.from('provider_locations').select('id, name, address, postal_code, latitude, longitude').eq('provider_id', provider.id).order('is_primary', { ascending: false }),
    ]);
    setActivities(acts ?? []);
    setCategories(cats ?? []);
    const locRows = (locs ?? []) as { id: string; name: string; address: string | null; postal_code: string | null; latitude: number | null; longitude: number | null }[];
    setLocations(locRows);


    // Upcoming session counts + total booking counts per activity.
    const ids = (acts ?? []).map((a) => a.id);
    if (ids.length) {
      const [{ data: sess }, { data: allSess }] = await Promise.all([
        supabase.from('activity_sessions').select('activity_id').in('activity_id', ids).neq('status', 'cancelled').gte('starts_at', new Date().toISOString()),
        supabase.from('activity_sessions').select('id, activity_id').in('activity_id', ids),
      ]);
      const counts: Record<string, number> = {};
      (sess ?? []).forEach((s) => { counts[s.activity_id] = (counts[s.activity_id] ?? 0) + 1; });
      setSessionCounts(counts);

      const actOfSession = new Map((allSess ?? []).map((s) => [s.id, s.activity_id]));
      const sessIds = [...actOfSession.keys()];
      const totals: Record<string, number> = {};
      if (sessIds.length) {
        const { data: bks } = await supabase
          .from('bookings')
          .select('session_id, status')
          .in('session_id', sessIds);
        (bks ?? []).forEach((b) => {
          if (b.status === 'cancelled') return;
          const actId = actOfSession.get(b.session_id);
          if (actId) totals[actId] = (totals[actId] ?? 0) + 1;
        });
      }
      setBookingTotals(totals);
      cacheSet(cacheKey, { activities: acts ?? [], categories: cats ?? [], locations: locRows, sessionCounts: counts, bookingTotals: totals });
    } else {
      setSessionCounts({});
      setBookingTotals({});
      cacheSet(cacheKey, { activities: acts ?? [], categories: cats ?? [], locations: locRows, sessionCounts: {}, bookingTotals: {} });
    }
    hasLoadedRef.current = true;
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [provider]);

  // Same action as Settings -> Integrate your Business's "Sync services"
  // button, surfaced here too so a vendor reviewing this list doesn't have
  // to leave it to pick up Wix-side changes (new services, price/capacity
  // edits, a service going missing). Runs the Bookings sync AND the Events
  // sync together — a vendor with only one app connected still gets a
  // correct combined result, since wix-events-sync degrades to a harmless
  // no-op (eventsAppNotInstalled: true) rather than erroring when the
  // Events & Tickets app isn't installed on their site.
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  // Only a server-authored message is fit to show a vendor; anything else is
  // this page's own bug and its text is browser jargon. Same fallback rule
  // SettingsPage's describeWixError uses.
  function describeSyncError(e: unknown, fallback: string): string {
    if (e instanceof ApiError) return e.message || fallback;
    console.error('[wix sync] unexpected error', e);
    return `${fallback}. If this keeps happening, contact support.`;
  }

  async function syncServices() {
    if (!provider) return;
    setSyncing(true);
    setSyncError(null);
    setSyncNotice(null);
    type SyncResult = { sync?: Partial<{
      created: number; updated: number; removed: number; revived: number;
      skipped: { name: string; reason: string }[];
    }> };
    // Both calls fire together (unlike Settings, which runs them one after
    // the other) — they're independent Wix apps, so there's no reason to
    // make a vendor wait twice. allSettled instead of Promise.all so one
    // call's failure can't swallow the other's — a vendor who imports only
    // Bookings services has no Events app installed at all (a real, common
    // case: the connected key's account has no Events & Tickets), and
    // that alone used to blank out a services sync that had already landed
    // and never refreshed the list.
    const [servicesOutcome, eventsOutcome] = await Promise.allSettled([
      apiPost<SyncResult>('/api/vendor/wix-services-sync', { provider_id: provider.id }),
      apiPost<SyncResult>('/api/vendor/wix-events-sync', { provider_id: provider.id }),
    ]);

    // Every count is read defensively. Adding them straight off the response
    // threw "Cannot read properties of undefined (reading 'created')" at a
    // vendor when a sync came back 2xx without its `sync` field — and by then
    // the sync had already run, so the only thing that actually failed was
    // the sentence describing it. Same guard as summarizeSync in
    // SettingsPage.
    const servicesSync = servicesOutcome.status === 'fulfilled' ? servicesOutcome.value?.sync : undefined;
    const eventsSync = eventsOutcome.status === 'fulfilled' ? eventsOutcome.value?.sync : undefined;
    const tally = (field: 'created' | 'updated' | 'revived' | 'removed') =>
      (servicesSync?.[field] ?? 0) + (eventsSync?.[field] ?? 0);
    const parts = [];
    if (tally('created')) parts.push(`${tally('created')} new`);
    if (tally('updated')) parts.push(`${tally('updated')} updated`);
    if (tally('revived')) parts.push(`${tally('revived')} restored`);
    if (tally('removed')) parts.push(`${tally('removed')} removed`);

    const lines: string[] = [];
    if (servicesOutcome.status === 'fulfilled' || eventsOutcome.status === 'fulfilled') {
      lines.push(`Synced from Wix: ${parts.length ? parts.join(', ') : 'nothing new'}.`);
      // Surfaces *why* a Wix service didn't come through (unsupported type,
      // no bookable staff, …) — dropped silently before this, even though
      // the sync response always carried it (SettingsPage's summarizeSync
      // has shown this same list all along).
      const skipped = servicesSync?.skipped ?? [];
      if (skipped.length) {
        lines.push(`${skipped.length} skipped — ${skipped.map((s) => `"${s.name}" (${s.reason})`).join('; ')}.`);
      }
    }
    if (servicesOutcome.status === 'rejected') {
      lines.push(`Services couldn't be synced — ${describeSyncError(servicesOutcome.reason, 'please try again')}`);
    }
    if (eventsOutcome.status === 'rejected') {
      lines.push(`Events couldn't be synced — ${describeSyncError(eventsOutcome.reason, 'please try again')}`);
    }

    if (servicesOutcome.status === 'rejected' && eventsOutcome.status === 'rejected') {
      setSyncError(lines.join(' '));
    } else {
      setSyncNotice(lines.join(' '));
      // At least one side actually wrote something — reflect it, same as the
      // all-succeeded path always did.
      await load();
    }
    setSyncing(false);
    window.setTimeout(() => { setSyncNotice(null); setSyncError(null); }, 5000);
  }

  // Either kind of Wix removal (deliberately unchecked in the import picker,
  // or vanished from the currently connected account) — neither can take new
  // bookings, and both should read as "Removed" rather than Live/Draft.
  const isRemoved = (a: Activity) => !!a.wix_removed_at || !!a.wix_missing_since;

  // A deliberately-removed activity (wix_removed_at) stays around, still
  // shown as "Removed", only until its last booked upcoming session is over
  // — the unbooked future sessions were already deleted at removal time, so
  // once sessionCounts hits 0 the only thing left for it is past history.
  // Hidden from the default (unfiltered) view for that reason, but the
  // "Removed" status filter below still reaches it — nothing that was ever
  // imported disappears from the page without a trace (QA: a vendor counting
  // "33 of 40 activities" with no way to find the other 7).
  const isFullyRemoved = (a: Activity) => !!a.wix_removed_at && (sessionCounts[a.id] ?? 0) === 0;

  const visible = useMemo(() => {
    let list = activities;
    if (fStatus !== 'Removed') list = list.filter((a) => !isFullyRemoved(a));
    list = list.filter((a) => a.title.toLowerCase().includes(search.toLowerCase()));
    if (fStatus) {
      list = list.filter((a) => {
        const s = isRemoved(a) ? 'Removed' : a.archived_at ? 'Archived' : a.is_published ? 'Live' : 'Draft';
        return s === fStatus;
      });
    }
    if (fLocation) list = list.filter((a) => a.location_id === fLocation);
    if (fActivity) list = list.filter((a) => String(a.id) === fActivity);
    if (fAge) {
      const [lo, hi] = fAge.split('-').map(Number); // months
      list = list.filter((a) => a.age_min_months <= hi && a.age_max_months >= lo);
    }
    if (sortBy === 'name') list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (sortBy === 'rating') list = [...list].sort((a, b) => Number(b.rating_avg) - Number(a.rating_avg));
    return list;
  }, [activities, sessionCounts, search, fStatus, fLocation, fActivity, fAge, sortBy]);

  // The "of N" a vendor should read as their real activity count — everything
  // ever imported minus the ones fully drained of even their own history
  // (see isFullyRemoved). Without this, activities.length kept counting dead
  // test imports forever and the footer never explained the gap.
  const removedHiddenCount = useMemo(() => activities.filter((a) => isFullyRemoved(a)).length, [activities, sessionCounts]);
  const visibleTotal = activities.length - removedHiddenCount;
  const categoryName = (id: number) => categories.find((c) => c.id === id)?.name ?? '—';

  // Themed placeholder per category so rows without photos still look distinct.
  const fallbackImage = (a: Activity) => {
    const name = categoryName(a.category_id).toLowerCase();
    const img = name.includes('art') ? 'activity-art.jpg'
      : name.includes('science') || name.includes('learn') || name.includes('stem') ? 'activity-stem.jpg'
      : name.includes('yoga') || name.includes('mind') ? 'activity-yoga.jpg'
      : name.includes('play') || name.includes('sensory') || name.includes('move') ? 'activity-play.jpg'
      : 'activity-music.jpg';
    return `${import.meta.env.BASE_URL}assets/${img}`;
  };

  /** Logo first (the default cover), then the catalogue. The dedicated
   *  Cover photo field (Settings) is deliberately not part of this. */
  const providerPhotoPool = (): string[] =>
    [provider?.logo_url, ...(provider?.gallery_urls ?? [])].filter((u): u is string => !!u);

  /** What a parent actually sees for this activity (00130) — its own cover
   *  photo when set to 'custom' with real uploads, else the provider's own
   *  photos, else the category placeholder above. Keeps this list's
   *  thumbnails honest about which photo is really live. */
  const resolveThumbnail = (a: Activity): string => {
    const own = (a.image_urls ?? []).filter(Boolean);
    if (a.image_source === 'custom' && own.length > 0) {
      return a.cover_image_url && own.includes(a.cover_image_url) ? a.cover_image_url : own[0];
    }
    const fromProfile = providerPhotoPool();
    if (fromProfile.length > 0) {
      return a.cover_image_url && fromProfile.includes(a.cover_image_url) ? a.cover_image_url : fromProfile[0];
    }
    return own[0] || fallbackImage(a);
  };

  /** The full ordered gallery behind resolveThumbnail's first pick — same
   *  source precedence (own custom photos, else the provider's pool, else the
   *  category placeholder) but every image, for the preview carousel. */
  const resolveGallery = (a: Activity): string[] => {
    const own = (a.image_urls ?? []).filter(Boolean);
    if (a.image_source === 'custom' && own.length > 0) return own;
    const fromProfile = providerPhotoPool();
    if (fromProfile.length > 0) return fromProfile;
    return own.length > 0 ? own : [fallbackImage(a)];
  };

  // Reads left to right as the life of an activity: live → still a draft →
  // actually on the calendar → the venues it all runs at.
  const stats = [
    { icon: CalendarCheck, label: 'Active activities', value: String(activities.filter((a) => a.is_published && !a.archived_at && !isRemoved(a)).length), sub: 'Live and published', color: 'text-pink-600', bg: 'bg-pink-100' },
    { icon: CalendarDays, label: 'Draft activities', value: String(activities.filter((a) => !a.is_published && !isRemoved(a)).length), sub: 'Not published yet', color: 'text-yellow-600', bg: 'bg-yellow-100' },
    // "Scheduled" = has at least one session still in the future, which is the
    // same count the Sessions column shows per row.
    { icon: CalendarClock, label: 'Activities scheduled', value: String(activities.filter((a) => !a.archived_at && !isFullyRemoved(a) && (sessionCounts[a.id] ?? 0) > 0).length), sub: 'With upcoming sessions', color: 'text-purple-600', bg: 'bg-purple-100' },
    { icon: MapPin, label: 'Locations', value: String(locations.length), sub: 'Venues added', color: 'text-blue-600', bg: 'bg-blue-100' },
  ];

  /* These three row actions used to re-run the whole page load() — refetching
     every activity, session and booking, and flipping `loading` — to reflect a
     single boolean flip on one row. That was the "lag": a menu pick froze the
     table for a second and hammered the database. They now patch the one row in
     place (nothing they change affects the session/booking counts) and only
     fall back to a full reload if the write actually fails. */
  async function archive(id: string) {
    setShowMenu(null);
    const archived_at = new Date().toISOString();
    setActivities((prev) => prev.map((a) => (a.id === id ? { ...a, archived_at, is_published: false } : a)));
    const { error } = await supabase.from('activities').update({ archived_at, is_published: false }).eq('id', id);
    if (error) load();
  }

  /** Un-archive: back to a Draft, so nothing goes live to parents until the
   *  vendor publishes it again (Publish still checks payouts). */
  async function restore(id: string) {
    setShowMenu(null);
    setActivities((prev) => prev.map((a) => (a.id === id ? { ...a, archived_at: null } : a)));
    const { error } = await supabase.from('activities').update({ archived_at: null }).eq('id', id);
    if (error) { toast.error('Could not restore this activity.', { description: error.message }); load(); }
    else toast.success('Restored as a draft. Publish it when you’re ready.');
  }

  function openCreate() {
    setEditingId(null);
    setCopyFrom(null);
    setShowSecondQ(false);
    setForm(emptyForm);
    setFormError(null);
    setShowDrawer(true);
  }

  function openEdit(a: Activity) {
    setShowMenu(null);
    setEditingId(a.id);
    setCopyFrom(null);
    setShowSecondQ(false);
    setForm(formFrom(a));
    setPriceOverridden((a.wix_locked_fields ?? []).includes('price'));
    setFormError(null);
    setShowDrawer(true);
    loadActivityLocations(a);
  }

  /** The activity's venues and their prices (00250) into the open form. Only the
   *  location fields are merged, so anything typed meanwhile is kept. */
  async function loadActivityLocations(a: Activity) {
    if (a.is_custom_location) return;
    const { data, error } = await supabase
      .from('activity_locations')
      .select('location_id, position, price, day_prices')
      .eq('activity_id', a.id)
      .order('position');
    if (error || !data) return;
    const primary = data.find((r) => r.location_id === a.location_id);
    const extras = data
      .filter((r) => r.location_id !== a.location_id)
      .map((r) => ({ location_id: r.location_id, price: r.price != null ? String(r.price) : '', day_prices: dayPricesFromJson(r.day_prices) }));
    setForm((f) => ({ ...f, primary_day_prices: dayPricesFromJson(primary?.day_prices), extra_locations: extras }));
  }

  /* "Duplicate" (client, 2026-10-21): a new activity pre-filled from an existing one — category,
     description, ages, price, venue, capacity, photos, booking rules, what to bring, confirmation
     note, the question for parents. Left out: the name (the vendor gives it a new one), and
     everything that belongs to the original only — its page address (a fresh one is made on
     save), sessions, bookings, reviews, any Wix link, and its published state (the copy is a
     draft). It goes through the normal create path, so nothing here can touch the original. */
  function openDuplicate(a: Activity) {
    setShowMenu(null);
    setEditingId(null);
    setCopyFrom(a.title);
    setShowSecondQ(false);
    setForm({ ...formFrom(a), title: '' });
    setPriceOverridden(false);
    setFormError(null);
    setShowDrawer(true);
    loadActivityLocations(a);
  }

  /** The drawer's fields from an activity — shared by Edit and Duplicate. */
  function formFrom(a: Activity) {
    return {
      title: a.title,
      category_id: String(a.category_id ?? ''),
      secondary_category_id: a.secondary_category_id != null ? String(a.secondary_category_id) : '',
      vendor_category: (a.vendor_category ?? '') as VendorCategory | '',
      description: a.description ?? '',
      age_min_months: String(a.age_min_months ?? ''),
      age_max_months: String(a.age_max_months ?? ''),
      price: a.price != null ? String(a.price) : '',
      location_id: a.location_id ?? '',
      is_custom_location: a.is_custom_location ?? false,
      custom_location_label: a.custom_location_label ?? '',
      // Filled in by loadActivityLocations once the rows arrive.
      primary_day_prices: {} as DayPrices,
      extra_locations: [] as ExtraLocation[],
      default_capacity: a.default_capacity != null ? String(a.default_capacity) : '',
      image_source: (a.image_source === 'custom' ? 'custom' : 'profile') as 'profile' | 'custom',
      image_urls: a.image_urls ?? [],
      cover_image_url: a.cover_image_url ?? '',
      allow_cancellation: a.allow_cancellation ?? true,
      allow_rescheduling: a.allow_rescheduling ?? true,
      cancellation_cutoff_hours: String(a.cancellation_cutoff_hours ?? 24),
      reschedule_cutoff_hours: String(a.reschedule_cutoff_hours ?? 24),
      cancellation_refund_mode: (a.cancellation_refund_mode ?? 'refund') as 'refund' | 'none',
      booking_cutoff_minutes: String(a.booking_cutoff_minutes ?? 15),
      info_request_enabled: a.info_request_enabled ?? false,
      info_request_prompt: a.info_request_prompt ?? '',
      info_request_prompt_2: a.info_request_prompt_2 ?? '',
      what_to_bring: a.what_to_bring ?? '',
      confirmation_message: a.confirmation_message ?? '',
    };
  }

  // 1.1: pause/resume parent bookings for one activity. Optimistic — see the
  // note on archive().
  async function togglePause(a: Activity) {
    setShowMenu(null);
    const bookings_paused = !a.bookings_paused;
    setActivities((prev) => prev.map((x) => (x.id === a.id ? { ...x, bookings_paused } : x)));
    const { error } = await supabase.from('activities').update({ bookings_paused }).eq('id', a.id);
    if (error) load();
  }

  const ACTIVITY_IMAGES_MAX = 10;
  // The stored photo currently open in the photo editor.
  const [cropUrl, setCropUrl] = useState<string | null>(null);
  // Photos picked but not yet through the editor (one at a time).
  const [photoQueue, setPhotoQueue] = useState<File[]>([]);
  const [photoTotal, setPhotoTotal] = useState(0);

  async function uploadOneImage(original: File, opts?: { edited?: boolean }): Promise<string | null> {
    if (!provider) return null;
    // Output of the photo editor is already sized and compressed; don't squeeze it twice.
    const file = opts?.edited ? original : await resizeImage(original);
    const path = `${provider.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]+/g, '_')}`;
    const { error } = await supabase.storage.from('activity-images').upload(path, file, { upsert: true, cacheControl: '2592000' });
    if (error) { setFormError(`Image upload failed: ${error.message}`); return null; }
    return supabase.storage.from('activity-images').getPublicUrl(path).data.publicUrl;
  }

  /** Appends one uploaded photo, within the 10-image cap. */
  async function addActivityImage(file: File, opts?: { edited?: boolean }) {
    const url = await uploadOneImage(file, opts);
    if (!url) throw new Error('The upload failed. Please try again.');
    setForm((f) => ({
      ...f,
      image_urls: [...f.image_urls, url].slice(0, ACTIVITY_IMAGES_MAX),
      // First upload for this class becomes its cover by default — better
      // than leaving the parent-facing hero blank until the vendor thinks
      // to pick one.
      cover_image_url: f.cover_image_url || url,
    }));
  }

  /**
   * Queues the picked photos for the photo editor (crop, resize, transparent
   * background…), one at a time. GIF/SVG can't be re-encoded and go up untouched.
   */
  async function uploadImages(files: FileList) {
    const room = ACTIVITY_IMAGES_MAX - form.image_urls.length;
    if (room <= 0) return;
    const oversized = Array.from(files).some((f) => f.size > 5 * 1024 * 1024);
    if (oversized) { setFormError('Each image must be under 5MB.'); return; }
    setFormError(null);
    const picked = Array.from(files).slice(0, room);
    const direct = picked.filter((f) => SKIP_EDITOR_TYPES.includes(f.type));
    const editable = picked.filter((f) => !SKIP_EDITOR_TYPES.includes(f.type));
    if (direct.length) {
      setUploading(true);
      for (const f of direct) { try { await addActivityImage(f); } catch { /* uploadOneImage already reported why */ } }
      setUploading(false);
    }
    setPhotoQueue(editable);
    setPhotoTotal(editable.length);
  }

  /** Swaps a photo for its edited version, keeping its place in the list and its cover status. */
  async function replaceActivityImage(oldUrl: string, file: File) {
    const url = await uploadOneImage(file, { edited: true });
    if (!url) throw new Error('The upload failed. Please try again.');
    setForm((f) => ({
      ...f,
      image_urls: f.image_urls.map((u) => (u === oldUrl ? url : u)),
      cover_image_url: f.cover_image_url === oldUrl ? url : f.cover_image_url,
    }));
  }

  function removeActivityImage(url: string) {
    setForm((f) => ({
      ...f,
      image_urls: f.image_urls.filter((u) => u !== url),
      cover_image_url: f.cover_image_url === url ? '' : f.cover_image_url,
    }));
  }

  /** Every image the "use my profile photos" mode's cover picker offers —
   *  see providerPhotoPool: the logo first, then the catalogue. */
  const profileImages = providerPhotoPool();

  const selectedCategoryIds = [form.category_id, form.secondary_category_id].filter(Boolean);

  // Another of this vendor's activities with the name being typed. Allowed,
  // but worth a word: parents tell the two apart by venue and times.
  const nameKey = form.title.trim().toLowerCase();
  const nameTwin = nameKey
    ? activities.find((a) => a.id !== editingId && !isFullyRemoved(a) && a.title.trim().toLowerCase() === nameKey) ?? null
    : null;

  async function saveActivity() {
    if (!provider) return;
    // Anything the form already flags as an error, said once and shown where
    // it lives: the banner, plus a jump to the section that needs fixing.
    const firstError = formIssues.find((i) => i.level === 'error');
    if (firstError) {
      setFormError(firstError.text);
      jumpToSection(firstError.section);
      return;
    }
    if (!form.title.trim() || !form.category_id) { setFormError('Name and at least one category are required.'); return; }
    // Two activities may share a name (client, 22 Oct: the same class runs at
    // different locations). The drawer says so under the name (nameTwin), it
    // no longer blocks the save.
    // Capacity comes from Wix for a linked activity (and is null for an
    // APPOINTMENT service, which is 1:1 by definition) — the field isn't shown
    // and isn't written, so demanding one here would be a dead end on a form
    // with nothing to fix.
    if (!isWixLinked && !termsToggle && (!form.default_capacity || Number(form.default_capacity) < 1)) {
      setFormError('Set a capacity for this activity.');
      return;
    }
    // Say so instead of quietly clamping an out-of-range age or cut-off on save.
    if (form.age_max_months && Number(form.age_max_months) > 132) { setFormError('Maximum age can be at most 132 months (11 years).'); return; }
    if (form.age_min_months && form.age_max_months && Number(form.age_min_months) > Number(form.age_max_months)) {
      setFormError("Minimum age can't be higher than the maximum age.");
      return;
    }
    const cutoffErr = cutoffTooLong(form.booking_cutoff_minutes);
    if (cutoffErr) { setFormError(cutoffErr); return; }
    setSaving(true);
    setFormError(null);
    // The activity's address/postal_code/lat/lng are denormalized from its
    // location so the parent app can show "where to go" without an extra
    // join — keep them in sync with whichever location the vendor picks.
    const loc = locations.find((l) => l.id === form.location_id);
    // Renaming a Wix-linked activity, or changing its photos, claims that field
    // (wix_locked_fields) so the next sync no longer puts Wix's name or single
    // cover photo back over it. Once claimed it stays claimed.
    const prevLocks = editingActivity?.wix_locked_fields ?? [];
    const sameList = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
    const titleClaimed = prevLocks.includes('title') || form.title.trim() !== (editingActivity?.title ?? '').trim();
    const secondQuestion = form.info_request_enabled ? form.info_request_prompt_2.trim() : '';
    const photosClaimed = prevLocks.includes('image_urls')
      || !sameList(form.image_urls, editingActivity?.image_urls ?? [])
      || form.image_source !== (editingActivity?.image_source === 'custom' ? 'custom' : 'profile');
    const fields = {
      title: form.title,
      description: form.description,
      category_id: Number(form.category_id),
      secondary_category_id: form.secondary_category_id ? Number(form.secondary_category_id) : null,
      vendor_category: (form.vendor_category || provider.vendor_category) as VendorCategory | undefined,
      age_min_months: Math.max(0, form.age_min_months ? Number(form.age_min_months) : 0),
      // BabyBrain lists activities for children up to 11, so an unstated upper
      // age can't default to adulthood — 216 was putting listings past the cap.
      age_max_months: Math.min(132, form.age_max_months ? Number(form.age_max_months) : 132),
      // Price, capacity and venue are Wix's for a linked activity and are
      // re-synced on every run, so writing them back from this form would only
      // survive to the next tick. Omitted entirely rather than round-tripped —
      // the drawer shows them read-only under "From Wix" instead.
      // A claimed price is written back and recorded in wix_locked_fields so
      // the sync skips it from here on. Releasing it drops the entry and the
      // next sync (<=5 min) restores Wix's number.
      ...(isWixLinked
        ? {
            wix_locked_fields: [
              ...prevLocks.filter((x) => x !== 'price' && x !== 'title' && x !== 'image_urls'),
              ...(priceOverridable && priceOverridden ? ['price'] : []),
              ...(titleClaimed ? ['title'] : []),
              ...(photosClaimed ? ['image_urls'] : []),
            ],
            ...(priceOverridable && priceOverridden
              ? { price: form.price ? Number(form.price) : null }
              : {}),
          }
        : {
            price: form.price ? Number(form.price) : null,
            location_id: form.is_custom_location ? null : form.location_id || null,
            is_custom_location: form.is_custom_location,
            custom_location_label: form.is_custom_location ? form.custom_location_label.trim() || null : null,
            // Left alone while terms are on and none was ever set: each slot
            // carries its own seats.
            ...(form.default_capacity ? { default_capacity: Number(form.default_capacity) } : {}),
            address: loc?.address ?? null,
            postal_code: loc?.postal_code ?? null,
            latitude: loc?.latitude ?? null,
            longitude: loc?.longitude ?? null,
          }),
      // image_urls is kept regardless of the current toggle — switching back
      // to "use my profile photos" shouldn't discard photos already
      // uploaded for this class, only stop showing them.
      image_urls: form.image_urls,
      image_source: form.image_source,
      cover_image_url: form.cover_image_url || null,
      // requires_medical_disclosure is owned by the provider-level rule under
      // Policy & consent management (migration 00117) — the drawer no longer
      // writes it, so editing a class here can't clear it.
      // Wix Events / Courses are always non-cancellable — force the flag off
      // regardless of any stale form value so the parent app and the
      // cancel_booking RPC both treat them as such.
      allow_cancellation: cancellationLocked ? false : form.allow_cancellation,
      allow_rescheduling: form.allow_rescheduling,
      // Only bites while cancellations are allowed; a locked (Wix Event/Course)
      // activity is non-cancellable, so the mode is moot — keep the default.
      cancellation_refund_mode: cancellationLocked ? 'refund' : form.cancellation_refund_mode,
      cancellation_cutoff_hours: hoursOrDefault(form.cancellation_cutoff_hours),
      reschedule_cutoff_hours: hoursOrDefault(form.reschedule_cutoff_hours),
      // 0 is meaningful here ("right up to the start time"), so an empty box
      // falls back to 15 rather than being coerced to 0 by `|| 15`.
      booking_cutoff_minutes: form.booking_cutoff_minutes === ''
        ? 15
        : Math.max(0, Math.min(20160, Number(form.booking_cutoff_minutes))),
      info_request_enabled: form.info_request_enabled,
      info_request_prompt: form.info_request_enabled ? (form.info_request_prompt.trim() || null) : null,
      // Written only when there is (or was) a second question, so saving an
      // activity still works on a database without 00252.
      ...(secondQuestion || editingActivity?.info_request_prompt_2
        ? { info_request_prompt_2: secondQuestion || null }
        : {}),
      what_to_bring: form.what_to_bring.trim() || null,
      confirmation_message: form.confirmation_message.trim() || null,
    };
    const { data: saved, error } = editingId
      ? await supabase.from('activities').update(fields).eq('id', editingId).select('id').single()
      : await supabase.from('activities').insert({
          ...fields,
          slug: `${form.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`,
          provider_id: provider.id,
          is_published: false, // saved as draft; publish from the row menu
        }).select('id').single();
    if (error) { setSaving(false); setFormError(error.message); return; }
    if (!isWixLinked && saved) {
      const locErr = await saveActivityLocations(saved.id);
      if (locErr) { setSaving(false); setFormError(`Activity saved, but its locations could not be saved: ${locErr}`); load(); return; }
    }
    setSaving(false);

    // Capacity is an activity-wide setting, so every save re-aligns this
    // activity's still-upcoming, non-cancelled sessions to it — otherwise the
    // parent app keeps showing the old spots left for classes already on the
    // schedule. A session already at that number (or below its own booking
    // count) is left alone; nothing is ever dropped below what's booked.
    // Only sessions still sitting at the OLD default follow it — a session
    // whose capacity was set individually under Manage schedule differs from
    // the old default and is never overwritten. Best-effort, so
    // a hiccup here never blocks the save that already went through.
    const newCap = Number(form.default_capacity);
    const oldCap = editingActivity?.default_capacity != null ? Number(editingActivity.default_capacity) : null;
    let cascadeError: string | null = null;
    if (editingId && !isWixLinked && Number.isFinite(newCap) && newCap >= 1) {
      try {
        const nowIso = new Date().toISOString();
        const { data: future } = await supabase
          .from('activity_sessions')
          .select('id, capacity')
          .eq('activity_id', editingId)
          .gte('starts_at', nowIso)
          .neq('status', 'cancelled');
        const rows = (future ?? []).filter((s) => oldCap == null || s.capacity === oldCap);
        if (rows.length) {
          const { data: bks } = await supabase
            .from('bookings')
            .select('session_id, status')
            .in('session_id', rows.map((s) => s.id));
          const booked: Record<string, number> = {};
          (bks ?? []).forEach((b) => {
            // Only a seat actually held counts as "booked" — the on_session_
            // capacity_increase trigger's own v_taken (00102) counts just
            // pending/confirmed, so a waitlisted row must not inflate the
            // floor here too, or the capacity this writes ends up higher
            // than the vendor typed (QA: "increased capacity, no email
            // sent" traced to this floor silently absorbing the increase).
            if (b.status === 'pending' || b.status === 'confirmed') {
              booked[b.session_id] = (booked[b.session_id] ?? 0) + 1;
            }
          });
          // One update per distinct target value (most sessions share it)
          // rather than a round-trip per session; skip the already-correct.
          const groups = new Map<number, string[]>();
          for (const s of rows) {
            const cap = Math.max(newCap, booked[s.id] ?? 0);
            if (cap === s.capacity) continue;
            groups.set(cap, [...(groups.get(cap) ?? []), s.id]);
          }
          const results = await Promise.all(
            [...groups].map(([cap, gids]) =>
              supabase.from('activity_sessions').update({ capacity: cap }).in('id', gids)
            )
          );
          // Used to go unchecked, so a refused write (RLS, a stale session
          // id) looked identical to success — the activity's default_capacity
          // saved, but the sessions it's supposed to cascade to (and the
          // on_session_capacity_increase trigger that emails the waitlist)
          // silently never ran.
          const failed = results.filter((r) => r.error);
          if (failed.length) {
            console.error('[ActivitiesPage] session capacity cascade failed', failed.map((r) => r.error));
            cascadeError = 'Activity saved, but some upcoming sessions could not be updated to the new capacity, so waitlisted families on those sessions were not emailed. Please try saving again, or update capacity per-session under Manage schedule.';
          }
        }
      } catch (e) {
        console.error('[ActivitiesPage] session capacity cascade threw', e);
        cascadeError = 'Activity saved, but upcoming sessions could not be re-synced to the new capacity, so waitlisted families were not emailed. Please try saving again, or update capacity per-session under Manage schedule.';
      }
    }

    // The "offer terms" switch is saved with the activity (activities.terms_enabled).
    if (termsOn && editingId && !isWixLinked) {
      try {
        await setTermsEnabled(editingId, termsToggle);
      } catch (e) {
        cascadeError = `Activity saved, but the term switch could not be changed: ${(e as { message?: string })?.message ?? 'please try again.'}`;
      }
    }

    if (cascadeError) {
      setFormError(cascadeError);
      load();
      return;
    }

    setShowDrawer(false);
    setEditingId(null);
    setForm(emptyForm);
    load();
  }

  /* Writes the activity's full set of venues (00250). The primary row already
     exists — the database adds it whenever activities.location_id is set — so
     this upserts every venue with its prices, then removes any the vendor took
     off. Returns an error message, or null. Wix-linked activities never get
     here: their one venue and price stay Wix's. */
  async function saveActivityLocations(activityId: string): Promise<string | null> {
    const primary = form.is_custom_location ? '' : form.location_id;
    const extras = form.is_custom_location ? [] : form.extra_locations.filter((x) => x.location_id && x.location_id !== primary);
    const rows = [
      ...(primary ? [{ activity_id: activityId, location_id: primary, position: 0, price: null, day_prices: dayPricesToJson(form.primary_day_prices) }] : []),
      ...extras.map((x, i) => ({
        activity_id: activityId,
        location_id: x.location_id,
        position: i + 1,
        price: x.price.trim() !== '' ? Number(x.price) : null,
        day_prices: dayPricesToJson(x.day_prices),
      })),
    ];
    if (rows.length) {
      const { error } = await supabase.from('activity_locations').upsert(rows, { onConflict: 'activity_id,location_id' });
      if (error) return error.message;
    }
    const keep = rows.map((r) => r.location_id);
    let del = supabase.from('activity_locations').delete().eq('activity_id', activityId);
    if (keep.length) del = del.not('location_id', 'in', `(${keep.join(',')})`);
    const { error } = await del;
    return error ? error.message : null;
  }

  // An activity with no area (its venue has no postal code) is published fine but cannot be found by the area
  // filter and cannot be placed on the map, so say so while the vendor can still do something about it.
  const NO_AREA_WARNING =
    'Published, but parents can\x27t find this by area yet: its venue has no postal code. Add one to the address in Wix (or to the venue under Locations), then sync.';
  const lacksArea = (a: Activity) => !a.region && !a.is_custom_location && (!!a.wix_event_id || !!a.wix_series_id || !!a.wix_service_id);

  async function togglePublish(a: Activity) {
    // Locked while Wix has lost track of this service (wrong/changed
    // account, or deleted on Wix) — reconnecting the right account, or the
    // service reappearing, is what clears this on the next sync.
    if (a.wix_missing_since) return;
    setShowMenu(null);
    const is_published = !a.is_published;
    // Going live requires a working payout destination — otherwise a paid
    // booking's money has nowhere of the vendor's own to land. Unpublishing
    // is always allowed regardless of payout status. A BabyBrain admin can
    // waive this per vendor (allow_manual_payouts) — BabyBrain then settles
    // their paid bookings manually until they connect Stripe.
    if (is_published && !canPublishWithoutStripe) {
      setSyncError('Set up payouts before publishing — go to Billing to connect Stripe.');
      return;
    }
    setActivities((prev) => prev.map((x) => (x.id === a.id ? { ...x, is_published, archived_at: null } : x)));
    const { error } = await supabase.from('activities').update({ is_published, archived_at: null }).eq('id', a.id);
    if (error) load();
    else if (is_published && lacksArea(a)) toast.warning(NO_AREA_WARNING, { duration: 10000 });
  }

  const inputCls = 'w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-pink-300';
  const [showFilters, setShowFilters] = useState(true);
  const activeFilterCount = [fStatus, fLocation, fAge, fActivity].filter(Boolean).length;
  // Mobile: full-width so the filter selects stack the same size; inline from sm up.
  const filterSelCls = 'w-full max-w-xs px-3 py-2 text-gray-700 sm:w-auto sm:max-w-none';

  /* Edit activity: what is wrong or thin, per section. Errors are things the
     save would reject (and now say where); warnings are gaps a parent would
     notice — no venue, no price, no photo — that the vendor may still choose
     to save. Computed from the form on every render; it's a handful of checks. */
  const formIssues: FormIssue[] = [];
  if (showDrawer) {
    const err = (section: string, text: string) => formIssues.push({ section, level: 'error', text });
    const warn = (section: string, text: string) => formIssues.push({ section, level: 'warn', text });
    if (!form.title.trim()) err('about', 'Add a name that parents will recognise.');
    if (!form.category_id) err('about', 'Choose at least one category so parents can find this activity.');
    if (form.title.trim() && !form.description.trim()) warn('about', 'A short description helps parents choose. It shows on the activity page.');
    const ageMin = form.age_min_months === '' ? null : Number(form.age_min_months);
    const ageMax = form.age_max_months === '' ? null : Number(form.age_max_months);
    if (ageMax != null && ageMax > 132) err('where', 'Maximum age can be at most 132 months (11 years).');
    if (ageMin != null && ageMin > 132) err('where', 'Minimum age can be at most 132 months (11 years).');
    if (ageMin != null && ageMax != null && ageMin > ageMax) err('where', "Minimum age can't be higher than the maximum age.");
    if (ageMin == null && ageMax == null) warn('where', 'No age range set. Parents will see the activity as suitable for every age up to 11.');
    if (!isWixLinked) {
      if (!termsToggle && (!form.default_capacity || Number(form.default_capacity) < 1)) err('where', 'Set how many children each session holds.');
      if (form.price !== '' && Number(form.price) < 0) err('where', "Price can't be negative.");
      if (form.price === '' && !termsToggle) warn('where', 'No price set. Parents will see "Price on enquiry" and can still book.');
      if (!form.is_custom_location && !form.location_id) warn('where', "No venue chosen. Parents won't see where to go.");
    }
    if (form.image_source === 'custom' && form.image_urls.length === 0) {
      warn('photos', 'No photos uploaded for this activity. Parents will see a placeholder.');
    }
    if (form.image_source === 'profile' && profileImages.length === 0) {
      warn('photos', 'You have no profile photos yet. Add some in Settings, or upload photos for this activity.');
    }
    const cutoffProblem = cutoffTooLong(form.booking_cutoff_minutes);
    if (cutoffProblem) err('rules', cutoffProblem);
    if (!form.allow_cancellation && !cancellationLocked) {
      warn('rules', 'Cancellations are off. Parents are told the booking is non-cancellable and the place cannot be handed back.');
    }
    if (form.info_request_enabled && !form.info_request_prompt.trim()) {
      err('parents', 'Say what you are asking parents for, or turn the question off. Parents cannot book without answering it.');
    }
  }
  const formErrorCount = formIssues.filter((i) => i.level === 'error').length;
  const formWarnCount = formIssues.length - formErrorCount;

  const jumpToSection = (id: string) => {
    setFormSection(id);
    document.getElementById(`form-sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  /** Highlights the section whose top edge is nearest the top of the scroller. */
  const onFormScroll = () => {
    const box = formScrollRef.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top + 24;
    let current = FORM_SECTIONS[0].id;
    for (const s of FORM_SECTIONS) {
      const el = document.getElementById(`form-sec-${s.id}`);
      if (el && el.getBoundingClientRect().top <= top) current = s.id;
    }
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) current = FORM_SECTIONS[FORM_SECTIONS.length - 1].id;
    setFormSection((prev) => (prev === current ? prev : current));
  };

  return (
    <div className="relative">
      {photoQueue[0] && (
        <PhotoEditorDialog
          key={`${photoQueue[0].name}-${photoQueue[0].size}-${photoTotal - photoQueue.length}`}
          source={photoQueue[0]}
          kind="photo"
          heading="Add activity photo"
          queueLabel={photoTotal > 1 ? `Photo ${photoTotal - photoQueue.length + 1} of ${photoTotal}` : undefined}
          onCancel={() => setPhotoQueue([])}
          onSave={async (f) => { await addActivityImage(f, { edited: true }); setPhotoQueue((q) => q.slice(1)); }}
          onUseOriginal={async () => { await addActivityImage(photoQueue[0]); setPhotoQueue((q) => q.slice(1)); }}
        />
      )}
      {cropUrl && (
        <PhotoEditorDialog
          source={cropUrl}
          kind="photo"
          heading="Edit activity photo"
          onCancel={() => setCropUrl(null)}
          onSave={async (f) => { await replaceActivityImage(cropUrl, f); setCropUrl(null); }}
        />
      )}
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-5 sm:px-8">
        <div className="w-full text-center sm:w-auto sm:text-left">
          <h1 className="text-2xl font-bold text-gray-900">Activities</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your activities, schedule and locations</p>
        </div>
      </div>

      <div className="px-4 pb-8 sm:px-8">
        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 mb-6 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', stat.bg)}>
                  <stat.icon className={cn('w-5 h-5', stat.color)} />
                </div>
              </div>
              <div className="text-2xl font-bold text-gray-900 mb-1">{stat.value}</div>
              <div className="text-sm font-medium text-gray-700">{stat.label}</div>
              <div className="text-xs text-gray-500">{stat.sub}</div>
            </div>
          ))}
        </div>

        {/* Tabs and Filters */}
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="flex flex-col gap-3 px-5 py-3 border-b border-gray-200 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            {/* Three sections: the activities themselves, the venues they run
                at, and the booking gates (medical disclosure + waivers &
                consents). Centred on a phone, where it sits above the toolbar. */}
            <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 sm:justify-start">
              {(['activities', 'locations', 'policies'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setPageTab(t);
                    const next = new URLSearchParams(searchParams);
                    if (t === 'activities') { next.delete('tab'); next.delete('new'); }
                    else next.set('tab', t);
                    setSearchParams(next, { replace: true });
                  }}
                  className={cn(
                    'text-sm font-medium pb-2 border-b-2',
                    pageTab === t ? 'text-[#FA4D8D] border-[#C90044]' : 'text-gray-500 border-transparent hover:text-gray-700'
                  )}
                >
                  {t === 'locations'
                    ? `Locations (${locations.length})`
                    : t === 'policies'
                      ? 'Policy & consent management'
                      : 'Activities'}
                </button>
              ))}
            </div>
            {/* Mobile: the two create buttons on one row, search on its own,
                then Sync services + Filters. Desktop: all inline, creates
                first so the actions sit left of the tools. */}
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="flex justify-center gap-3 sm:contents">
                <button
                  onClick={() => canManage && openCreate()}
                  disabled={!canManage}
                  className="flex items-center gap-2 px-4 py-2 bg-pink-50 border border-pink-200 text-[#FA4D8D] rounded-xl text-sm font-medium hover:bg-pink-100 transition-colors disabled:opacity-50 sm:order-1"
                >
                  <CalendarPlus className="w-4 h-4" />
                  New activity
                </button>
                <button
                  onClick={() => {
                    setPageTab('locations');
                    setOpenNewLocation(true);
                    const next = new URLSearchParams(searchParams);
                    next.set('tab', 'locations');
                    setSearchParams(next, { replace: true });
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-50 border border-blue-200 text-blue-700 rounded-xl text-sm font-medium hover:bg-blue-100 transition-colors sm:order-2"
                >
                  <MapPin className="w-4 h-4" />
                  New location
                </button>
              </div>
              <div className="relative w-full sm:order-4 sm:w-48">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search activities..."
                  className="w-full pl-10 pr-4 py-2 bg-gray-50 rounded-xl text-sm border-0 focus:outline-none focus:ring-2 focus:ring-pink-300"
                />
              </div>
              <div className="flex justify-center gap-3 sm:contents">
                {provider?.wix_site_id && (
                  <button
                    onClick={syncServices}
                    disabled={syncing}
                    title="Pull the latest services and events — prices, capacities, locations, images and removals — from your connected Wix account"
                    className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 sm:order-3"
                  >
                    <RefreshCw className={cn('w-4 h-4', syncing && 'animate-spin')} />
                    {syncing ? 'Syncing…' : 'Sync services'}
                  </button>
                )}
                <button
                  onClick={() => setShowFilters((v) => !v)}
                  aria-expanded={showFilters}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2 bg-white border rounded-xl text-sm hover:bg-gray-50 sm:order-5',
                    activeFilterCount ? 'border-[#C90044] text-[#FA4D8D]' : 'border-gray-200 text-gray-700'
                  )}
                >
                  <SlidersHorizontal className="w-4 h-4" />
                  Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
                </button>
                {activeFilterCount > 0 && (
                  <button
                    onClick={() => { setFStatus(''); setFLocation(''); setFAge(''); setFActivity(''); }}
                    className="px-3 py-2 text-sm font-medium text-gray-500 hover:text-[#FA4D8D] sm:order-6"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>

          {(syncNotice || syncError) && (
            <div className={cn('px-5 py-2.5 text-sm font-medium border-b border-gray-200', syncError ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700')}>
              {syncError ?? syncNotice}
            </div>
          )}

          {/* Filter bar — on mobile the selects stack full-width (so they're
              all the same size) and centre; on desktop they sit inline. */}
          {showFilters && pageTab === 'activities' && (
          <div className="flex flex-col items-center gap-3 px-5 py-3 border-b border-gray-200 sm:flex-row sm:flex-wrap sm:items-center">
            <SelectField value={fStatus} onChange={setFStatus} aria-label="Filter by status" className={filterSelCls}>
              <Opt value="">All statuses</Opt>
              {['Live', 'Draft', 'Archived', 'Removed'].map((s) => <Opt key={s} value={s}>{s}</Opt>)}
            </SelectField>
            <SelectField value={fLocation} onChange={setFLocation} aria-label="Filter by location" className={filterSelCls}>
              <Opt value="">All locations</Opt>
              {locations.map((l) => <Opt key={l.id} value={l.id}>{l.name}</Opt>)}
            </SelectField>
            <SelectField value={fAge} onChange={setFAge} aria-label="Filter by age group" className={filterSelCls}>
              <Opt value="">All age groups</Opt>
              <Opt value="0-18">0 – 18 months</Opt>
              <Opt value="18-36">18m – 3 years</Opt>
              <Opt value="36-60">3 – 5 years</Opt>
              <Opt value="60-216">5+ years</Opt>
            </SelectField>
            <SelectField value={fActivity} onChange={setFActivity} aria-label="Filter by activity" className={filterSelCls}>
              <Opt value="">All activities</Opt>
              {activities
                .filter((a) => !isFullyRemoved(a))
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((a) => <Opt key={a.id} value={String(a.id)}>{a.title}</Opt>)}
            </SelectField>
            <SelectField value={sortBy} onChange={(v) => setSortBy(v as typeof sortBy)} aria-label="Sort activities" className={cn(filterSelCls, 'sm:ml-auto')}>
              <Opt value="updated">Sort by: Recently updated</Opt>
              <Opt value="name">Sort by: Name</Opt>
              <Opt value="rating">Sort by: Rating</Opt>
            </SelectField>
          </div>
          )}

          {pageTab === 'policies' ? (
            <div className="p-5">
              <MedicalDisclosureCard
                canManage={canManage}
                activities={activities}
                mode={mdDraftMode}
                ids={mdDraftIds}
                setMode={setMdDraftMode}
                setIds={setMdDraftIds}
                dirty={mdDirty}
                saving={mdSaving}
                msg={mdMsg}
                onSave={saveMedicalDisclosure}
              />
              <div className="mt-6 border-t border-gray-200 pt-6">
                <PoliciesManager provider={provider} canManage={canManage} />
              </div>
            </div>
          ) : pageTab === 'locations' ? (
            <div className="p-5">
              <LocationsManager
                provider={provider}
                canManage={canManage}
                openOnMount={openNewLocation}
                onOpened={() => setOpenNewLocation(false)}
                /* Keep this page's own `locations` state (which the
                   create-activity modal's venue dropdown reads) in step when a
                   venue is added/edited/removed here, so a just-added venue is
                   selectable without a page reload. */
                onChanged={load}
              />
            </div>
          ) : (
          <>
          {/* Table (horizontal scroll below its natural width on small screens) */}
          <div className="overflow-x-auto">
          {/* Table Header */}
          <div className={cn(TABLE_COLS, 'px-5 py-3 bg-gray-50 text-xs font-medium text-gray-500')}>
            <div>Activity</div>
            <div>Category</div>
            <div>Location</div>
            <div>Age group</div>
            <div>Sessions</div>
            <div>Bookings</div>
            <div>Rating</div>
            <div>Status</div>
            <div>Updated</div>
            <div />
          </div>

          {/* Table Rows */}
          {loading && <RainbowLoader className="px-5 py-10" label="Loading activities" />}
          {!loading && visible.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-gray-400">No activities yet. Create your first one.</div>
          )}
          {visible.map((a) => {
            const status = isRemoved(a) ? 'Removed' : a.archived_at ? 'Archived' : a.is_published ? 'Live' : 'Draft';
            return (
              <div
                key={a.id}
                className={cn(TABLE_COLS, 'px-5 py-4 border-t border-gray-100 items-center hover:bg-gray-50 transition-colors')}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <img src={resolveThumbnail(a)} alt={a.title} className="w-12 h-12 flex-shrink-0 rounded-lg object-cover" />
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900 text-sm break-words">{a.title}</div>
                    <div className="text-xs text-gray-500 break-words">{a.vendor_category ?? ''}</div>
                  </div>
                </div>
                <div className="flex min-w-0 flex-col items-start gap-1 text-sm text-gray-700">
                  <span className="break-words">{categoryName(a.category_id)}</span>
                  {a.secondary_category_id != null && <span className="break-words">{categoryName(a.secondary_category_id)}</span>}
                </div>
                {/* QA: the table was missing location, so a multi-venue vendor
                    couldn't tell which of their sites a class runs at. */}
                <div className="min-w-0 text-sm text-gray-700 break-words">
                  {locations.find((l) => l.id === a.location_id)?.name ?? <span className="text-gray-400">—</span>}
                </div>
                <div className="min-w-0 text-sm text-gray-700">{ageLabel(a.age_min_months, a.age_max_months)}</div>
                <div className="text-sm text-gray-700">{sessionCounts[a.id] ?? 0}<br /><span className="text-xs text-gray-500">Upcoming</span></div>
                <div className="text-sm text-gray-700">{bookingTotals[a.id] ?? 0}<br /><span className="text-xs text-gray-500">Total</span></div>
                <div>
                  {a.rating_count > 0 ? (
                    <div className="flex items-center gap-1">
                      <Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" />
                      <span className="text-sm font-medium text-gray-900">{Number(a.rating_avg).toFixed(1)}</span>
                      <span className="text-xs text-gray-500">({a.rating_count})</span>
                    </div>
                  ) : (
                    <span className="text-sm text-gray-400">—</span>
                  )}
                </div>
                <div className="flex flex-col items-start gap-1">
                  <span className={cn(
                    'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full',
                    status === 'Live' ? 'bg-green-300 text-green-800'
                      : status === 'Draft' ? 'bg-yellow-300 text-yellow-800'
                      : status === 'Removed' ? 'bg-red-100 text-red-700'
                      : 'bg-gray-100 text-gray-600'
                  )} title={
                    a.wix_removed_at
                      ? "Unchecked in the Wix import picker — re-check it under Settings > Integrate your Business to bring it back. Already-booked sessions still run."
                      : a.wix_missing_since
                        ? "Not found on the currently connected Wix account — reconnect the right account, or re-add this service, to restore it."
                        : undefined
                  }>
                    <div className={cn('w-1.5 h-1.5 rounded-full', status === 'Live' ? 'bg-green-500' : status === 'Draft' ? 'bg-yellow-500' : status === 'Removed' ? 'bg-red-500' : 'bg-gray-400')} />
                    {status}
                  </span>
                  {a.bookings_paused && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-orange-300 text-orange-800">
                      <Pause className="w-3 h-3" /> Paused
                    </span>
                  )}
                </div>
                <div className="min-w-0 text-sm text-gray-500">{fmtDate(a.updated_at)}</div>
                {/* Radix rather than a hand-rolled absolute panel: the table
                    scrolls inside `overflow-x-auto`, which also clips
                    vertically, so an in-flow menu on the last rows was cut off
                    by the table's own edge. This portals the panel to the body
                    (escaping that clip), flips it above the trigger when there
                    isn't room below, and closes on outside click / Escape.

                    `modal={false}` is deliberate: the default modal mode locks
                    `document.body` with `pointer-events: none` and an app-wide
                    `aria-hidden` sweep for as long as the menu is open, then
                    relies on one shared teardown to undo it. With a menu per
                    row and several items that open a drawer in the same click,
                    that teardown could lose the race and leave the whole page
                    unclickable — the "three dots does nothing / page is stuck"
                    report. A lightweight row menu needs none of that. */}
                <div className="flex justify-end">
                  <DropdownMenu
                    modal={false}
                    open={showMenu === a.id}
                    onOpenChange={(open) => setShowMenu(open ? a.id : null)}
                  >
                    <DropdownMenuTrigger asChild>
                      <button aria-label="Activity actions" className="p-1.5 hover:bg-gray-100 rounded-lg">
                        <MoreVertical className="w-4 h-4 text-gray-400" />
                      </button>
                    </DropdownMenuTrigger>
                    {/* Rendered for every role. Preview is read-only and always
                        available; the managing actions are gated. Gating the
                        whole panel (the old behaviour) left a staff member
                        clicking the trigger and getting nothing back. */}
                    <DropdownMenuContent
                      align="end"
                      // Radix flips to the opposite side on its own when the
                      // preferred one doesn't fit; the collision padding just
                      // stops the panel sitting flush against the viewport.
                      collisionPadding={12}
                      className="w-44 rounded-xl border-gray-200 bg-white py-1 shadow-lg"
                    >
                      <DropdownMenuItem onSelect={() => openPreview(a)} className="gap-2 px-3 py-2 text-sm text-gray-700">
                        <Eye className="w-3.5 h-3.5" />
                        Preview
                      </DropdownMenuItem>
                      {canManage && (
                        <>
                          <DropdownMenuItem onSelect={() => openEdit(a)} className="gap-2 px-3 py-2 text-sm text-gray-700">
                            <Pencil className="w-3.5 h-3.5" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => openDuplicate(a)} className="gap-2 px-3 py-2 text-sm text-gray-700">
                            <Copy className="w-3.5 h-3.5" />
                            Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => openSchedule(a)} className="gap-2 px-3 py-2 text-sm text-gray-700">
                            <Clock className="w-3.5 h-3.5" />
                            Manage schedule
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => togglePublish(a)}
                            disabled={!!a.wix_missing_since || (!a.is_published && !canPublishWithoutStripe)}
                            title={
                              a.wix_missing_since
                                ? 'Locked until this service is found again on a connected Wix account'
                                : !a.is_published && !canPublishWithoutStripe
                                ? 'Set up payouts under Billing before publishing'
                                : undefined
                            }
                            className="gap-2 px-3 py-2 text-sm text-gray-700"
                          >
                            <CalendarCheck className="w-3.5 h-3.5" />
                            {a.is_published ? 'Unpublish' : 'Publish'}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => togglePause(a)} className="gap-2 px-3 py-2 text-sm text-gray-700">
                            {a.bookings_paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                            {a.bookings_paused ? 'Resume bookings' : 'Pause bookings'}
                          </DropdownMenuItem>
                          {a.archived_at ? (
                            <DropdownMenuItem onSelect={() => restore(a.id)} className="gap-2 px-3 py-2 text-sm text-gray-700">
                              <ArchiveRestore className="w-3.5 h-3.5" />
                              Restore
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onSelect={() => archive(a.id)} className="gap-2 px-3 py-2 text-sm text-gray-700">
                              <Trash2 className="w-3.5 h-3.5" />
                              Archive
                            </DropdownMenuItem>
                          )}
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })}
          </div>

          <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200">
            <span className="text-sm text-gray-500">
              Showing {visible.length} of {visibleTotal} activities
              {removedHiddenCount > 0 && fStatus !== 'Removed' && (
                // The rest aren't lost — they're de-listed imports with nothing
                // left but past history (see isFullyRemoved above). One click
                // switches the status filter to reveal them instead of leaving
                // a vendor to wonder where the gap between this count and their
                // Wix account went.
                <button
                  type="button"
                  onClick={() => setFStatus('Removed')}
                  className="ml-1 text-[#FA4D8D] hover:underline"
                >
                  · {removedHiddenCount} removed from Wix
                </button>
              )}
            </span>
          </div>
          </>
          )}
        </div>

      </div>

      {/* Create Activity Drawer */}
      {showDrawer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowDrawer(false); }}
        >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={editingId ? 'Edit activity' : copyFrom != null ? 'Duplicate activity' : 'Create activity'}
          className="flex h-[90vh] max-h-[860px] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
        >
          <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-6 py-4">
            <div className="min-w-0">
              <h3 className="text-xl font-bold text-gray-900">{editingId ? 'Edit activity' : copyFrom != null ? 'Duplicate activity' : 'Create activity'}</h3>
              {editingId && form.title.trim() && <p className="truncate text-sm text-gray-500">{form.title}</p>}
              {!editingId && copyFrom != null && <p className="truncate text-sm text-gray-500">Copy of {copyFrom}</p>}
            </div>
            <button onClick={() => setShowDrawer(false)} className="rounded-lg p-2 hover:bg-gray-100" aria-label="Close">
              <X className="h-5 w-5 text-gray-600" />
            </button>
          </div>

          {/* Section navigator: a left rail on wide screens, a scrolling chip
              row on phones. Each entry carries its section's colour and a mark
              for what still needs attention, so a long form can be jumped
              around instead of scrolled end to end. */}
          <nav className="flex gap-2 overflow-x-auto border-b border-gray-200 bg-gray-50 px-4 py-2 md:hidden" aria-label="Form sections">
            {FORM_SECTIONS.map((s) => {
              const active = formSection === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => jumpToSection(s.id)}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold',
                    active ? cn(TONES[s.tone].chip, 'ring-2', TONES[s.tone].ring) : 'bg-white text-gray-600 ring-1 ring-gray-200',
                  )}
                >
                  <s.icon className="h-4 w-4" /> {s.title}
                  <SectionStatus issues={formIssues.filter((i) => i.section === s.id)} />
                </button>
              );
            })}
          </nav>

          <div className="flex min-h-0 flex-1">
            <nav className="hidden w-60 shrink-0 space-y-1 overflow-y-auto border-r border-gray-200 bg-gray-50 p-3 md:block" aria-label="Form sections">
              {FORM_SECTIONS.map((s) => {
                const active = formSection === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => jumpToSection(s.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                      active ? 'bg-white shadow-sm ring-1 ring-gray-200' : 'hover:bg-white/70',
                    )}
                  >
                    <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', TONES[s.tone].chip)}>
                      <s.icon className="h-[18px] w-[18px]" />
                    </span>
                    <span className={cn('min-w-0 flex-1 text-[15px] leading-tight', active ? 'font-bold text-gray-900' : 'font-semibold text-gray-700')}>
                      {s.title}
                    </span>
                    <SectionStatus issues={formIssues.filter((i) => i.section === s.id)} />
                  </button>
                );
              })}
            </nav>

          <div
            ref={formScrollRef}
            onScroll={onFormScroll}
            className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-gray-50/60 p-4 sm:p-6"
          >
            {formError && (
              <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {formError}
              </div>
            )}

            {!editingId && copyFrom != null && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
                <p>
                  Copied from <span className="font-medium text-gray-900">{copyFrom}</span>. Give it a new name, check the
                  details, then save. It starts as a draft, hidden from parents until you publish it.
                </p>
                <p className="mt-1.5 text-xs text-gray-500">
                  Sessions aren't copied, so add a schedule after saving. Packs and waivers set to specific activities won't
                  include the copy until you add it to them.
                </p>
              </div>
            )}

            {/* Everything Wix owns, shown read-only and grouped, so it is
                obvious at a glance which half of this form is the vendor's to
                change. Before this the two were interleaved and a vendor could
                edit a price that the next sync (<=5 min) silently put back. */}
            {isWixLinked && (
              <div className="rounded-xl border border-purple-200 bg-purple-50/40 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700">Wix</span>
                    <span className="text-sm font-semibold text-gray-900">From Wix</span>
                  </div>
                  <button
                    type="button"
                    onClick={syncServices}
                    disabled={syncing}
                    className="flex items-center gap-1.5 rounded-lg border border-purple-200 bg-white px-2.5 py-1.5 text-xs font-medium text-purple-700 hover:bg-purple-50 disabled:opacity-50"
                  >
                    <RefreshCw className={cn('w-3.5 h-3.5', syncing && 'animate-spin')} />
                    {syncing ? 'Syncing…' : 'Sync now'}
                  </button>
                </div>
                <p className="text-xs text-gray-600">
                  Managed in Wix and refreshed automatically every few minutes. Editing these here wouldn&rsquo;t
                  stick — change them in Wix and they&rsquo;ll update here.
                </p>
                <dl className="space-y-2 border-t border-purple-100 pt-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-gray-500">Price</dt>
                    <dd className="text-right text-sm font-medium text-gray-900">
                      {wixPrice != null ? '$' + wixPrice : 'Not set in Wix'}
                      {priceOverridden && (
                        <span className="block text-[11px] font-normal text-amber-700">not in use — your price applies</span>
                      )}
                      {isWixEvent && <span className="block text-[11px] font-normal text-gray-500">cheapest ticket type</span>}
                    </dd>
                  </div>
                  {!hideCapacity && (
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-xs text-gray-500">Capacity</dt>
                      <dd className="text-sm font-medium text-gray-900">{editingActivity?.default_capacity ?? '—'}</dd>
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-gray-500">Venue</dt>
                    <dd className="text-right text-sm font-medium text-gray-900">
                      {locations.find((l) => l.id === editingActivity?.location_id)?.name ?? editingActivity?.address ?? 'Not set in Wix'}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-gray-500">Schedule</dt>
                    <dd className="text-sm font-medium text-gray-900">{isWixEvent ? 'The event date' : 'Live from Wix'}</dd>
                  </div>
                </dl>
                {editingActivity?.updated_at && (
                  <p className="text-[11px] text-gray-500">
                    Last synced{' '}
                    {new Date(editingActivity.updated_at).toLocaleString('en-SG', {
                      timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
                    })}
                  </p>
                )}
                {syncNotice && <p className="text-[11px] font-medium text-green-700">{syncNotice}</p>}
                {syncError && <p className="text-[11px] font-medium text-red-600">{syncError}</p>}
              </div>
            )}

            <SectionCard id="about" icon={Sparkles} tone="pink" title="About the activity" subtitle="The name, categories and description parents see first." issues={formIssues.filter((i) => i.section === 'about')}>
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800">Name <span className="text-[#FA4D8D]">*</span></label>
              <input type="text" placeholder="e.g. Music Explorers" className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              {nameTwin && (
                <p className="mt-1.5 text-xs text-gray-500">
                  You already have an activity called &ldquo;{nameTwin.title}&rdquo;. That&rsquo;s fine, for example the same class at another
                  venue: parents tell them apart by the venue and times on each listing.
                </p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800">
                Categories <span className="text-[#FA4D8D]">*</span>
                <span className="ml-1 font-normal text-gray-500">(choose up to 2)</span>
              </label>
              <MultiSelectField
                values={selectedCategoryIds}
                onChange={(v) => setForm({ ...form, category_id: v[0] ?? '', secondary_category_id: v[1] ?? '' })}
                max={2}
                chips
                placeholder="Select categories"
                aria-label="Categories"
                className={cn(inputCls, 'min-h-[40px] w-full')}
              >
                {categories.map((c) => <Opt key={c.id} value={String(c.id)}>{c.name}</Opt>)}
              </MultiSelectField>
              <p className="mt-1.5 text-xs text-gray-500">
                {selectedCategoryIds.length >= 2 ? 'Two selected. Untick one to swap.' : 'Pick at least one; a second is optional.'}
              </p>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800">Description</label>
              <textarea placeholder="Describe this activity..." rows={3} maxLength={500} className={cn(inputCls, 'resize-none')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              <div className="text-right text-xs text-gray-400 mt-1">{form.description.length}/500</div>
            </div>
            </SectionCard>

            <SectionCard id="where" icon={MapPin} tone="blue" title="Who, where and how much" subtitle="Age range, venue, price and how many children each session holds." issues={formIssues.filter((i) => i.section === 'where')}>
            {termsOn && !isWixLinked && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                <ToggleRow
                  title="Offer this activity as a term"
                  hint={termsToggle
                    ? 'On. Price and seats are set per term and group under Manage schedule → Terms, so they are locked below.'
                    : 'A term is a block of weekly sessions a parent enrols in once. Off keeps this activity to single sessions.'}
                  checked={termsToggle}
                  disabled={!editingId || (termsToggle && !!editingId && hasLiveTerm(allTerms, editingId))}
                  disabledReason={!editingId
                    ? 'Save the activity first, then turn terms on.'
                    : 'A published term is still running. Let it finish before turning terms off.'}
                  onChange={setTermsToggle}
                />
              </div>
            )}
            {priceOverridable && (
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-gray-800">Price (SGD per session)</label>
                {priceOverridden ? (
                  <>
                    <NumberInput
                      
                      min="0"
                      step="any"
                      placeholder="e.g. 45"
                      className={inputCls}
                      value={form.price}
                      onChange={(e) => setForm({ ...form, price: e.target.value })}
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Your price — the sync won&rsquo;t overwrite it.{' '}
                      {wixPrice != null && <>Wix charges ${wixPrice}. </>}
                      <button
                        type="button"
                        onClick={() => { setPriceOverridden(false); setForm({ ...form, price: wixPrice != null ? String(wixPrice) : '' }); }}
                        className="font-medium text-[#FA4D8D] hover:underline"
                      >
                        Follow Wix again
                      </button>
                    </p>
                  </>
                ) : (
                  <>
                    <NumberInput
                      
                      className={cn(inputCls, 'bg-gray-50 text-gray-500 cursor-not-allowed')}
                      value={wixPrice ?? ''}
                      disabled
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Following Wix.{' '}
                      <button type="button" onClick={() => setPriceOverridden(true)} className="font-medium text-[#FA4D8D] hover:underline">
                        Set your own price
                      </button>{' '}
                      to charge something different on BabyBrain.
                    </p>
                  </>
                )}
              </div>
            )}
            <AgeRangeField
              min={form.age_min_months}
              max={form.age_max_months}
              onChange={(lo, hi) => setForm((f) => ({ ...f, age_min_months: lo, age_max_months: hi }))}
              inputCls={inputCls}
            />
            {!isWixLinked && (
              <>
            <div>
              <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
                <ToggleRow
                  title="We travel to the customer"
                  hint="Private sessions at the family's home or a place they choose. No fixed venue is shown."
                  checked={form.is_custom_location}
                  onChange={(v) => setForm({ ...form, is_custom_location: v, location_id: v ? '' : form.location_id })}
                />
              </div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800">Venue</label>
              {form.is_custom_location ? (
                <>
                  <input
                    type="text"
                    maxLength={60}
                    placeholder="e.g. We travel to you"
                    className={inputCls}
                    value={form.custom_location_label}
                    onChange={(e) => setForm({ ...form, custom_location_label: e.target.value })}
                    aria-label="Custom location label"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Optional — shown to parents instead of "Custom". This always shows up on Explore no matter which area a parent searches, followed by "as defined by you".
                  </p>
                </>
              ) : (
                <>
              <ActivityLocationsField
                locations={locations}
                inputCls={inputCls}
                primaryId={form.location_id}
                onPrimaryId={(v) => setForm((f) => ({ ...f, location_id: v }))}
                price={form.price}
                onPrice={(v) => setForm((f) => ({ ...f, price: v }))}
                primaryDays={form.primary_day_prices}
                onPrimaryDays={(v) => setForm((f) => ({ ...f, primary_day_prices: v }))}
                extras={form.extra_locations}
                onExtras={(v) => setForm((f) => ({ ...f, extra_locations: v }))}
              />
              {locations.length === 0 ? (
                <p className="mt-1 text-xs text-gray-500">No locations yet — add one on the <button className="text-[#FA4D8D] font-medium hover:underline" onClick={() => { setPageTab('locations'); setOpenNewLocation(true); setShowDrawer(false); }}>Locations tab</button>.</p>
              ) : (
                /* QA 21/08: "if they do the same class in 3 different locations
                   they need to create it 3 times." Both this and the price below
                   are now the DEFAULT for new sessions — Manage schedule can
                   override either per session, so one activity covers every
                   venue and price. */
                <p className="mt-1.5 text-xs text-gray-500">
                  {form.extra_locations.length
                    ? 'Parents choose a location when they book. Add sessions for each location under Manage schedule.'
                    : 'Running this class somewhere else too? Add another location, each with its own price.'}
                </p>
              )}
                </>
              )}
            </div>
            {form.is_custom_location && (
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-gray-800">Price (SGD per session)</label>
                <NumberInput
                
                  min="0"
                  step="any"
                  placeholder="e.g. 45"
                  className={cn(inputCls, termsToggle && 'cursor-not-allowed bg-gray-100 text-gray-500')}
                  value={form.price}
                  disabled={termsToggle}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {termsToggle
                    ? (() => {
                        const hl = editingId ? termHeadline(allTerms, editingId) : null;
                        const range = editingId ? termPriceRange(allTerms, editingId) : null;
                        if (!hl) return 'Locked while terms are on. Add a term under Manage schedule → Terms and its price will show here.';
                        return `Locked while terms are on. Parents see "${headlineLabel(hl)}".${range ? ` Term prices: $${range.min}${range.max !== range.min ? ` to $${range.max}` : ''}.` : ''}`;
                      })()
                    : 'Default price. Individual sessions can be priced differently under Manage schedule.'}
                </p>
              </div>
            )}
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800">Capacity {!termsToggle && <span className="text-[#FA4D8D]">*</span>}</label>
              <NumberInput min="1" required={!termsToggle} placeholder="e.g. 12" className={cn(inputCls, termsToggle && 'cursor-not-allowed bg-gray-100 text-gray-500')} value={form.default_capacity} disabled={termsToggle} onChange={(e) => setForm({ ...form, default_capacity: e.target.value })} />
              <p className="mt-1 text-xs text-gray-500">{termsToggle ? 'Locked while terms are on. Each group sets its own seats.' : "Applies to upcoming sessions that haven't been set individually, and pre-fills new ones. Override a single session under Manage schedule."}</p>
            </div>
              </>
            )}
            </SectionCard>

            <SectionCard id="photos" icon={ImageUp} tone="purple" title="Photos" subtitle="Use your profile photos or upload some just for this activity." issues={formIssues.filter((i) => i.section === 'photos')}>
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800">Images</label>
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-1">
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, image_source: 'profile' }))}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                    form.image_source === 'profile' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  )}
                >
                  Use my profile photos
                </button>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, image_source: 'custom' }))}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                    form.image_source === 'custom' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  )}
                >
                  Upload for this activity
                </button>
              </div>

              {form.image_source === 'profile' ? (
                profileImages.length > 0 ? (
                  <div className="mt-2">
                    <p className="mb-1.5 text-xs text-gray-500">Parents will see your profile photos. Pick which one leads for this activity:</p>
                    <div className="flex flex-wrap gap-2">
                      {profileImages.map((url) => (
                        <button
                          key={url}
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, cover_image_url: url }))}
                          className={cn(
                            'relative h-16 w-16 shrink-0 overflow-hidden rounded-lg ring-2 ring-offset-1 transition',
                            (form.cover_image_url || profileImages[0]) === url ? 'ring-[#FA4D8D]' : 'ring-transparent hover:ring-gray-300'
                          )}
                        >
                          <img src={url} alt="" className="h-full w-full object-cover" />
                          {(form.cover_image_url || profileImages[0]) === url && (
                            <span className="absolute bottom-0.5 right-0.5 rounded-full bg-[#FA4D8D] px-1 py-0.5 text-[9px] font-bold leading-none text-white">Cover</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-gray-500">
                    You haven&rsquo;t added any profile photos yet — add some under{' '}
                    <a href="/vendor/#/settings" className="font-medium text-[#FA4D8D] hover:underline">Settings</a>, or switch to uploading photos just for this activity.
                  </p>
                )
              ) : (
                <div className="mt-2">
                  {form.image_urls.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {form.image_urls.map((url) => (
                        <div key={url} className="relative h-16 w-16 shrink-0">
                          <button
                            type="button"
                            onClick={() => setForm((f) => ({ ...f, cover_image_url: url }))}
                            className={cn(
                              'h-full w-full overflow-hidden rounded-lg ring-2 ring-offset-1 transition',
                              (form.cover_image_url || form.image_urls[0]) === url ? 'ring-[#FA4D8D]' : 'ring-transparent hover:ring-gray-300'
                            )}
                          >
                            <img src={url} alt="" className="h-full w-full object-cover" />
                          </button>
                          {(form.cover_image_url || form.image_urls[0]) === url && (
                            <span className="pointer-events-none absolute bottom-0.5 right-0.5 rounded-full bg-[#FA4D8D] px-1 py-0.5 text-[9px] font-bold leading-none text-white">Cover</span>
                          )}
                          <button
                            type="button"
                            aria-label="Edit photo"
                            title="Crop, adjust or resize this photo"
                            onClick={() => setCropUrl(url)}
                            className="absolute bottom-0.5 left-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
                          >
                            <Crop className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            aria-label="Remove photo"
                            onClick={() => removeActivityImage(url)}
                            className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {form.image_urls.length < ACTIVITY_IMAGES_MAX ? (
                    <label className={cn(
                      'flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-gray-200 px-4 py-6 cursor-pointer hover:border-pink-300 transition-colors',
                      uploading && 'opacity-60 pointer-events-none'
                    )}>
                      <ImageUp className="w-6 h-6 text-[#FA4D8D]" />
                      <span className="text-sm font-medium text-[#FA4D8D]">{uploading ? 'Uploading…' : 'Upload photos'}</span>
                      <span className="text-xs text-gray-500">PNG, JPG up to 5MB each — up to {ACTIVITY_IMAGES_MAX} ({form.image_urls.length}/{ACTIVITY_IMAGES_MAX})</span>
                      <input
                        type="file"
                        multiple
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(e) => { const fs = e.target.files; if (fs?.length) uploadImages(fs); }}
                      />
                    </label>
                  ) : (
                    <p className="text-xs text-gray-400">Up to {ACTIVITY_IMAGES_MAX} photos — remove one to add another.</p>
                  )}
                </div>
              )}
            </div>
            {/* Medical disclosure is set for all / certain classes at once under
                Activities → Policy & consent management, not per activity here. */}

            </SectionCard>

            {/* 2.2: cancellation & rescheduling policy for this class */}
            <SectionCard id="rules" icon={ShieldCheck} tone="amber" title="Booking rules" subtitle="When parents can book, cancel or reschedule, and what happens to their payment." issues={formIssues.filter((i) => i.section === 'rules')}>
            <div className="space-y-5">
              {cancellationLocked ? (
                /* Wix Events and Courses can't be cancelled through BabyBrain
                   — no toggle, and parents always see the non-cancellable
                   notice on the last booking step. */
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
                  <div className="text-sm font-medium text-gray-900">Cancellations not available</div>
                  <div className="text-xs text-gray-500">
                    {wixKind === 'EVENT' ? 'Ticketed Wix events' : 'Wix courses'} can&rsquo;t be cancelled once
                    booked — parents see a &ldquo;non-cancellable once booked&rdquo; notice at checkout.
                  </div>
                </div>
              ) : (
                <>
                  <ToggleRow
                    title="Allow cancellations"
                    hint="Parents can cancel their booking themselves."
                    checked={form.allow_cancellation}
                    onChange={(v) => setForm({ ...form, allow_cancellation: v })}
                  />
                  {form.allow_cancellation ? (
                    <div className="space-y-3">
                      <div>
                        <label className="mb-1 block text-[13px] font-semibold text-gray-700">Cancellation cut-off (hours before session)</label>
                        <NumberInput min="0" className={inputCls} value={form.cancellation_cutoff_hours} onChange={(e) => setForm({ ...form, cancellation_cutoff_hours: e.target.value })} />
                      </div>
                      <div>
                        <label className="mb-1 block text-[13px] font-semibold text-gray-700">When a booking is cancelled</label>
                        <SelectField
                          className={inputCls}
                          aria-label="When a booking is cancelled"
                          value={form.cancellation_refund_mode}
                          onChange={(v) => setForm({ ...form, cancellation_refund_mode: v as 'refund' | 'none' })}
                        >
                          <Opt value="refund">Refund as package credit / make-up token</Opt>
                          <Opt value="none">No refund</Opt>
                        </SelectField>
                        {form.cancellation_refund_mode === 'none' && (
                          <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                            Parents see &ldquo;Payment for this activity is non-refundable, if cancelled.&rdquo; at checkout.
                            Cancelling still frees the place, but no package credit or make-up token is returned.
                          </p>
                        )}
                      </div>
                    </div>
                  ) : (
                    /* Toggle off — mirror on the parent side is the checkout
                       disclaimer + a disabled cancel button after booking. */
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                      Parents will see a &ldquo;non-cancellable once booked&rdquo; notice on the last booking step and
                      can&rsquo;t cancel the booking themselves afterwards.
                    </div>
                  )}
                </>
              )}
              <div className="border-t border-gray-100 pt-5">
                <ToggleRow
                  title="Allow rescheduling"
                  hint="Parents can move their booking to another session."
                  checked={form.allow_rescheduling}
                  onChange={(v) => setForm({ ...form, allow_rescheduling: v })}
                />
              </div>
              {form.allow_rescheduling && (
                <div>
                  <label className="mb-1 block text-[13px] font-semibold text-gray-700">Rescheduling cut-off (hours before session)</label>
                  <NumberInput min="0" className={inputCls} value={form.reschedule_cutoff_hours} onChange={(e) => setForm({ ...form, reschedule_cutoff_hours: e.target.value })} />
                </div>
              )}

              {/* QA 21/08: "parents can currently make bookings up until a
                  minute before the class." 15 minutes is the default the
                  founder asked for; a vendor who needs longer to set up sets
                  their own. Enforced in the database, so it holds regardless
                  of what the parent app does. */}
              <div>
                <label className="mb-1 block text-[13px] font-semibold text-gray-700">Booking cut-off (before the session)</label>
                <DurationInput
                  className={inputCls}
                  aria-label="Booking cut-off"
                  value={form.booking_cutoff_minutes}
                  onChange={(v) => setForm({ ...form, booking_cutoff_minutes: v })}
                />
                <p className="mt-1 text-xs text-gray-500">{cutoffSentence(form.booking_cutoff_minutes)}</p>
              </div>
            </div>

            </SectionCard>

            {/* Bespoke information request (QA 21/08) */}
            <SectionCard id="parents" icon={MessageCircle} tone="teal" title="What parents are told" subtitle="Extra questions before booking, what to bring, and the note shown after they book." issues={formIssues.filter((i) => i.section === 'parents')}>
            <div className="space-y-5">
              <ToggleRow
                title="Ask parents for extra information"
                hint="For anything you need before the session, for example an address when you host at their condo."
                checked={form.info_request_enabled}
                onChange={(v) => setForm({ ...form, info_request_enabled: v })}
              />
              {(editingActivity?.wix_event_blockers?.length ?? 0) > 0 && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 space-y-1">
                  <p className="font-semibold">Parents can't book this event right now:</p>
                  {editingActivity!.wix_event_blockers.map((b) => (
                    <p key={b.code}>• {b.vendorMessage}</p>
                  ))}
                </div>
              )}
              {editingActivity && lacksArea(editingActivity) && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  This activity has no area: its venue has no postal code, so parents can't find it with the area filter and it can't be placed
                  on the map. Add a postal code to the address in Wix, then sync.
                </p>
              )}
              {(editingActivity?.wix_form_extra_fields?.length ?? 0) > 0 && (
                <p className="text-xs text-blue-800 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                  Parents are already asked your Wix registration form's own questions on the booking page
                  ({editingActivity!.wix_form_extra_fields.map((f) => `“${f}”`).join(', ')}) and their answers go straight to Wix — you
                  don't need to ask for them here. Use this only for something that isn't on your Wix form.
                </p>
              )}
              {isWixEvent && editingActivity && provider && (
                <WixFormHandling providerId={provider.id} activityId={editingActivity.id} />
              )}
              {form.info_request_enabled && (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-[13px] font-semibold text-gray-700">
                      {showSecondQ || form.info_request_prompt_2 ? 'First question' : 'What are you asking for?'}
                    </label>
                    <textarea
                      rows={2}
                      maxLength={300}
                      placeholder="e.g. Which condo is the session at, and the unit number?"
                      className={cn(inputCls, 'resize-none')}
                      value={form.info_request_prompt}
                      onChange={(e) => setForm({ ...form, info_request_prompt: e.target.value })}
                    />
                  </div>
                  {/* 00252: at most two questions. Both answers arrive together
                      on the booking, each under its question. */}
                  {showSecondQ || form.info_request_prompt_2 ? (
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <label className="text-xs font-medium text-gray-600 block">Second question</label>
                        <button
                          type="button"
                          onClick={() => { setShowSecondQ(false); setForm({ ...form, info_request_prompt_2: '' }); }}
                          className="text-xs font-medium text-gray-500 hover:text-red-600"
                        >
                          Remove
                        </button>
                      </div>
                      <textarea
                        rows={2}
                        maxLength={300}
                        placeholder="e.g. Any allergies we should know about?"
                        className={cn(inputCls, 'resize-none')}
                        value={form.info_request_prompt_2}
                        onChange={(e) => setForm({ ...form, info_request_prompt_2: e.target.value })}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowSecondQ(true)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#FA4D8D] hover:underline"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add a second question
                    </button>
                  )}
                  <p className="text-xs text-gray-500">
                    Parents can't book this activity without answering{form.info_request_prompt_2.trim() ? ' both' : ''}. You'll see the {form.info_request_prompt_2.trim() ? 'answers' : 'answer'} on the booking.
                  </p>
                </div>
              )}
            </div>

            {/* What parents see after booking (QA 24/08 + 28/08) */}
            <div className="space-y-5 border-t border-gray-100 pt-5">
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-gray-800">What to bring &amp; know</label>
                <textarea
                  rows={3}
                  maxLength={1000}
                  placeholder="e.g. Wear socks, bring a water bottle and a change of clothes. Arrive 10 minutes early."
                  className={cn(inputCls, 'resize-none')}
                  value={form.what_to_bring}
                  onChange={(e) => setForm({ ...form, what_to_bring: e.target.value })}
                />
                <p className="mt-1 text-xs text-gray-500">Shown on the activity page and after booking. Leave blank for our general guidance.</p>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-gray-800">Booking confirmation note</label>
                <textarea
                  rows={3}
                  maxLength={1000}
                  placeholder="e.g. Park in the basement and take lift lobby B to level 3."
                  className={cn(inputCls, 'resize-none')}
                  value={form.confirmation_message}
                  onChange={(e) => setForm({ ...form, confirmation_message: e.target.value })}
                />
                <p className="mt-1 text-xs text-gray-500">Shown on the confirmation screen once a parent has booked.</p>
              </div>
            </div>
            </SectionCard>
          </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-white px-6 py-4">
            <p
              className={cn(
                'flex items-center gap-2 text-sm font-bold',
                formErrorCount > 0 ? 'text-red-700' : formWarnCount > 0 ? 'text-amber-800' : 'text-green-700',
              )}
            >
              {formErrorCount > 0 ? (
                <><AlertTriangle className="h-4 w-4" /> {formErrorCount} required {formErrorCount === 1 ? 'item' : 'items'} to fix before saving</>
              ) : formWarnCount > 0 ? (
                <><AlertTriangle className="h-4 w-4" /> {formWarnCount} {formWarnCount === 1 ? 'suggestion' : 'suggestions'}: you can still save</>
              ) : (
                <><Check className="h-4 w-4" /> Everything looks complete</>
              )}
            </p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setShowDrawer(false)} className="h-11 rounded-xl border-2 border-gray-300 px-5 text-[15px] font-bold text-gray-700 hover:bg-gray-50">Cancel</Button>
              <Button onClick={saveActivity} disabled={saving} className="h-11 rounded-xl px-6 text-[15px] font-bold gradient-primary text-white hover:opacity-90">
                {saving ? 'Saving…' : 'Save activity'}
              </Button>
            </div>
          </div>
        </div>
        </div>
      )}

      {/* Parent-view preview. Deliberately a copy of the parent app's three
          screens (frontends/parent App.tsx's activity page, booking page and
          booking-confirmation page) rather than a vendor-styled summary — the
          point is to show exactly what a family sees at each step, so the
          palette, radii and Nunito face are the parent app's, not this one's.
          Everything is inert except the photo carousel (page 1) and a
          policy's "read the full document" link (page 2) — the two places a
          vendor actually needs to click something to check it. The header's
          arrows step between the three pages. */}
      {previewFor && (() => {
        const gallery = resolveGallery(previewFor);
        const photoAt = previewPhotoAt % gallery.length;
        const stepPhoto = (d: number) => setPreviewPhotoAt((i) => (i + d + gallery.length) % gallery.length);
        const nextSession = previewSessions[0] ?? null;
        const sessionsByDate: Record<string, PreviewSession[]> = {};
        previewSessions.forEach((s) => {
          const key = new Date(s.starts_at).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short' });
          (sessionsByDate[key] ||= []).push(s);
        });
        const dateKeys = Object.keys(sessionsByDate);
        const selectedDateKey = dateKeys[0] ?? null;
        const price = previewFor.price != null ? Number(previewFor.price) : null;
        const ageText = previewFor.age_min_months != null && previewFor.age_max_months != null ? ageLabel(previewFor.age_min_months, previewFor.age_max_months) : null;
        const pageLabels = ['Activity page', 'Booking page', 'Booking confirmation'];
        // Mirrors BookingPage.tsx's nonCancellable: Wix events/courses are always
        // non-cancellable regardless of the activity's own toggle.
        const previewNonCancellable = previewFor.wix_service_type === 'EVENT' || previewFor.wix_service_type === 'COURSE' || previewFor.allow_cancellation === false;

        // The activity's terms. The booking page offers every one that hasn't
        // ended (published first, then drafts, each by start date) under "Which
        // term?", and the rest of the page follows the one picked. A draft still
        // shows, flagged outside the replica, so a vendor can check it before
        // publishing. With only ended terms, the latest one is shown as before.
        const termRows = termsOn && termsEnabledMap[previewFor.id] ? allTerms.filter((t) => t.activityId === previewFor.id) : [];
        const firstDate = (t: (typeof termRows)[number]) => t.slots.map((s) => s.start).filter(Boolean).sort()[0] ?? '';
        const bookableTerms = termRows
          .filter((t) => termStatus(t).key !== 'ended')
          .sort((a, b) => Number(b.status === 'published') - Number(a.status === 'published') || firstDate(a).localeCompare(firstDate(b)));
        const previewTerm =
          bookableTerms.find((t) => t.id === previewTermId) ?? bookableTerms[0] ??
          termRows.find((t) => t.status === 'published') ?? termRows[0] ?? null;
        const pickerTerms = bookableTerms.map((t) => offeringFor(buildTermView(t, price, (id) => locations.find((l) => l.id === id)?.name, previewPlaces), t.id));
        const termView = previewTerm
          ? buildTermView(previewTerm, price, (id) => locations.find((l) => l.id === id)?.name, previewPlaces)
          : null;
        const termQuote = termView ? quoteFor(termView, previewSlotIdx, previewPassed) : null;
        const termOn = !!termView && !!termQuote;
        // The activity page's "Upcoming" block: every live term, the one-off
        // session (trial, else single), and the packs the terms accept.
        const liveTermRows = termOn ? allTerms.filter((t) => t.activityId === previewFor.id && termStatus(t).key !== 'ended') : [];
        const liveViews = liveTermRows.map((t) => buildTermView(t, price, (id) => locations.find((l) => l.id === id)?.name, previewPlaces));
        const offeringTerms = liveViews.map((v, i) => offeringFor(v, liveTermRows[i].id));
        const offeringOneOffs = oneOffFor(liveViews);
        const offeringPacks = liveViews.some((v) => v.packages)
          ? previewPackages.map((p) => ({ id: p.id, name: p.name, sessions: p.credits, price: `$${Math.round(p.price_cents / 100)}` }))
          : [];
        const previewHeadline = termsOn && termsEnabledMap[previewFor.id] ? termHeadline(allTerms, previewFor.id) : null;
        const offered = (m: BookMode) =>
          m === 'term' ||
          (m === 'trial' && !!termView?.trial && previewTrialUsed < termView.trialLimit) ||
          (m === 'single' && !!termView?.single && (!termView.trial || previewTrialUsed >= termView.trialLimit)) ||
          (m === 'package' && !!termView?.packages);
        const bookMode: BookMode = termOn && offered(previewMode) ? previewMode : 'term';
        const termMode = termOn && bookMode === 'term';
        // Trial, single or package: one of the term's groups, then one of its dates.
        const oneOffGroups = termView ? termView.slots.map((s) => ({ key: s.key, label: s.label, venue: s.venue, dates: s.dates })) : [];
        const oneOffOpen = oneOffGroups[Math.min(previewSlotIdx, oneOffGroups.length - 1)]?.dates.slice(previewPassed) ?? [];
        const oneOffDate = previewOneOffDate && oneOffOpen.includes(previewOneOffDate) ? previewOneOffDate : oneOffOpen[0] ?? null;
        // What the booking page totals to in each mode.
        const shownPrice: number | null = !termOn
          ? price
          : termMode ? termQuote!.payNow
          : bookMode === 'trial' ? termView!.trialPrice
          : bookMode === 'single' ? termView!.singlePrice
          : bookMode === 'package' ? (previewPackages[0] ? previewPackages[0].price_cents / 100 : null)
          : price;

        return (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/25 p-4 backdrop-blur-sm"
          onClick={() => setPreviewFor(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Parent view of ${previewFor.title}`}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-[#FFFCF8] shadow-2xl"
            style={{ fontFamily: "Nunito, 'Inter', -apple-system, sans-serif" }}
          >
            <div className="flex items-center justify-between border-b border-[#EBE3E5] bg-white px-5 py-3">
              <div className="flex items-center gap-2.5">
                <Eye className="h-4 w-4 flex-shrink-0 text-[#FA4D8D]" />
                <div>
                  <h3 className="text-sm font-bold text-[#111A4C]">Parent view — {pageLabels[previewPage]}</h3>
                  <p className="text-xs text-gray-500">How this looks to families on BabyBrain.sg</p>
                  {termOn && previewTerm?.status === 'draft' && (
                    <p className="text-xs font-semibold text-amber-700">This term is a draft. Families can't see it until you publish it.</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {termOn && previewPage === 1 && (
                  <label className="hidden items-center gap-2 text-xs font-semibold text-gray-500 sm:flex">
                    Show as if
                    <select
                      value={termQuote!.run}
                      onChange={(e) => setPreviewPassed(Number(e.target.value))}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-bold text-gray-700"
                      aria-label="Sessions already run"
                    >
                      {Array.from({ length: termQuote!.lastJoin + 1 }, (_, i) => (
                        <option key={i} value={i}>{i === 0 ? 'the term has not started' : `${i} ${i === 1 ? 'session has' : 'sessions have'} run`}</option>
                      ))}
                    </select>
                  </label>
                )}
                {termOn && previewPage === 1 && termView!.trial && (
                  <label className="hidden items-center gap-2 text-xs font-semibold text-gray-500 sm:flex">
                    Trials used
                    <select
                      value={previewTrialUsed}
                      onChange={(e) => setPreviewTrialUsed(Number(e.target.value))}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-bold text-gray-700"
                      aria-label="Trial sessions this child has used"
                    >
                      {Array.from({ length: termView!.trialLimit + 1 }, (_, i) => (
                        <option key={i} value={i}>{i} of {termView!.trialLimit}</option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="flex items-center gap-1 rounded-full bg-gray-100 p-1">
                  <button
                    type="button"
                    onClick={() => setPreviewPage((p) => Math.max(0, p - 1))}
                    disabled={previewPage === 0}
                    aria-label="Previous page"
                    className="rounded-full p-1.5 text-gray-600 hover:bg-white disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="px-1 text-xs font-bold text-gray-500">{previewPage + 1} / {PREVIEW_PAGE_COUNT}</span>
                  <button
                    type="button"
                    onClick={() => setPreviewPage((p) => Math.min(PREVIEW_PAGE_COUNT - 1, p + 1))}
                    disabled={previewPage === PREVIEW_PAGE_COUNT - 1}
                    aria-label="Next page"
                    className="rounded-full p-1.5 text-gray-600 hover:bg-white disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <button onClick={() => setPreviewFor(null)} aria-label="Close preview" className="rounded-lg p-1.5 hover:bg-gray-100">
                  <X className="h-4 w-4 text-gray-500" />
                </button>
              </div>
            </div>

            {/* pointer-events-none: nothing in the preview is clickable, save
                the photo carousel and a policy document link (both opt back
                in with pointer-events-auto below). The scroller keeps its
                pointer events — putting them on this element made it
                transparent to the wheel, so a long description or address
                could not be reached. The inert layer is inside it. */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="select-none p-5 text-[#111A4C]">
              {previewPage === 0 && (
              <div className="pointer-events-none">
              {!previewFor.is_published && (
                <p className="mb-4 rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                  Not published yet — families can&rsquo;t find this. This is how it would look once it is.
                </p>
              )}

              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
                <div className="flex flex-col gap-5">
                  <div className="grid gap-5 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
                    <div className="flex flex-col">
                      <span className="font-bold text-[#C7B1E6]">← Back to results</span>
                      <div className="flex flex-1 flex-col justify-center">
                        <h1 className="text-[29px] font-black leading-tight">{previewFor.title}</h1>
                        {provider?.business_name && (
                          <p className="mt-1.5 flex items-center gap-1.5 text-[14px] font-bold text-[#C7B1E6]">
                            <Store className="h-4 w-4" /> {provider.business_name}
                          </p>
                        )}
                        <div className="mt-4 flex flex-wrap gap-2">
                          {[previewFor.category_id, previewFor.secondary_category_id].filter((id): id is number => id != null).map((id) => (
                            <span key={id} className="inline-flex w-fit items-center gap-1 rounded-[9px] bg-[#FEEBF2] px-4 py-1.5 font-bold text-[#FA4D8D]">
                              <Music className="h-4 w-4" /> {categoryName(id)}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    {/* The one interactive piece of this whole preview — a vendor
                        needs to actually cycle their photos to check crops, not
                        just see the first one. No auto-advance timer, unlike the
                        real parent-facing carousel, so it never moves on its own
                        while a vendor is looking at it. */}
                    <div className="relative overflow-hidden rounded-[18px]">
                      <img
                        src={gallery[photoAt]}
                        alt={previewFor.title}
                        className={cn(
                          'h-[240px] w-full lg:h-[305px]',
                          gallery[photoAt] === provider?.logo_url ? 'object-contain bg-[#F3EDF0] p-8' : 'object-cover'
                        )}
                      />
                      {gallery.length > 1 && (
                        <div className="pointer-events-auto absolute right-3 top-3 flex gap-2">
                          <button
                            type="button"
                            onClick={() => stepPhoto(-1)}
                            aria-label="Previous photo"
                            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white transition hover:bg-black/55"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => stepPhoto(1)}
                            aria-label="Next photo"
                            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white transition hover:bg-black/55"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                      <span className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-1.5 rounded-[10px] bg-white/95 px-3 py-2 text-[13px] font-bold text-[#111A4C] shadow">
                        <ExternalLink className="h-3.5 w-3.5" /> {gallery.length > 1 ? `${photoAt + 1} / ${gallery.length}` : 'View photo'}
                      </span>
                    </div>
                  </div>

                  {previewFor.description && (
                    <section className="rounded-[16px] border border-[#EBE3E5] bg-white p-5">
                      <h2 className="mb-3 text-xl font-black">About</h2>
                      <p className="font-semibold text-[#34406f]">{previewFor.description}</p>
                    </section>
                  )}

                  <section className="rounded-[16px] border border-[#EBE3E5] bg-white p-5">
                    <h2 className="mb-3 text-xl font-black">{termOn ? 'Upcoming' : 'Upcoming sessions'}</h2>
                    {termOn ? (
                      <UpcomingOfferings terms={offeringTerms} oneOffs={offeringOneOffs} packs={offeringPacks} />
                    ) : previewSessions.length === 0 ? (
                      <p className="text-sm font-semibold text-[#68718f]">No upcoming sessions scheduled.</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {previewSessions.map((s) => (
                          <div key={s.id} className={cn('rounded-[10px] border px-3 py-2.5 text-sm font-bold', s.id === nextSession?.id ? 'border-[#FA4D8D] bg-[#FEEBF2] text-[#FA4D8D]' : 'border-[#DCD2D5] bg-white text-[#34406f]')}>
                            {fmtDateTime(s.starts_at)}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>

                <aside className="h-fit rounded-[18px] border border-[#EBE3E5] bg-white p-5">
                  {termOn && previewHeadline ? (
                    <p><strong className="text-[30px] text-[#C7B1E6]">{headlineParts(previewHeadline).prefix}{headlineParts(previewHeadline).amount}</strong> <span className="font-bold">{headlineParts(previewHeadline).unit}</span></p>
                  ) : price != null && price > 0 ? (
                    <p><strong className="text-[30px] text-[#C7B1E6]">${price}</strong> <span className="font-bold">/ session</span></p>
                  ) : (
                    <p><strong className="text-[30px] text-[#C7B1E6]">Free</strong></p>
                  )}

                  <span className="mt-4 flex w-full items-center justify-center gap-2 rounded-[11px] bg-gradient-to-r from-[#fa4d8d] to-[#ff6b9b] px-6 py-3 text-[15px] font-extrabold text-white" style={{ boxShadow: '0 8px 20px rgba(250,93,147,.32)' }}>
                    <CalendarDays className="h-4 w-4" /> Book
                  </span>
                  <span className="mt-3 flex w-full items-center justify-center gap-2 rounded-[11px] border border-[#A7D8F8] px-6 py-3 text-[15px] font-extrabold text-[#A7D8F8]">
                    <Mail className="h-4 w-4" /> Chat with provider
                  </span>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="flex flex-1 items-center justify-center gap-1.5 rounded-[11px] border border-[#A8E59A] px-3 py-2.5 text-[13px] font-extrabold text-[#A8E59A]">
                      <MessageCircle className="h-4 w-4" /> WhatsApp
                    </span>
                    <span className="flex flex-1 items-center justify-center gap-1.5 rounded-[11px] border border-[#A7D8F8] px-3 py-2.5 text-[13px] font-extrabold text-[#A7D8F8]">
                      <Mail className="h-4 w-4" /> Email
                    </span>
                  </div>
                  <span className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[11px] border border-[#C7B1E6] px-3 py-2.5 text-[13px] font-extrabold text-[#C7B1E6]">
                    <ExternalLink className="h-4 w-4" /> Website
                  </span>
                  <span className="mt-3 flex w-full items-center justify-center gap-2 rounded-[11px] border border-[#A7D8F8] px-6 py-3 text-[15px] font-extrabold text-[#A7D8F8]">
                    <Users className="h-4 w-4" /> Session group chat
                  </span>
                  <span className="mt-3 flex w-full items-center justify-center gap-2 rounded-[11px] bg-[#FEEBF2] px-6 py-3 text-[15px] font-extrabold text-[#FFC1D6]">
                    <Heart className="h-4 w-4" /> Save to favourites
                  </span>

                  <div className="mt-5 space-y-4 border-t border-[#F4EFF0] pt-4 text-sm font-semibold">
                    {/* Label and value stack rather than sharing a row: a full
                        address squeezed beside the label wrapped to a sliver. */}
                    <div>
                      <strong className="block">Location</strong>
                      <span className="mt-1 block break-words text-[#34406f]">
                        {previewLocation(previewFor) ?? 'No location set'}
                      </span>
                    </div>
                    <div>
                      <strong className="block">Duration</strong>
                      <span className="mt-1 block text-[#34406f]">
                        {previewDuration === 'loading'
                          ? 'Checking…'
                          : previewDuration
                            ? formatDuration(previewDuration)
                            : 'No sessions scheduled yet'}
                      </span>
                    </div>
                  </div>
                </aside>
              </div>
              </div>
              )}

              {previewPage === 1 && (
                <div className="mx-auto max-w-[1024px]">
                  <div className="pointer-events-none mb-5 flex gap-3 text-sm font-bold"><span>Home</span><span>›</span><span>Activities</span><span>›</span><span>{previewFor.title}</span><span>›</span><span className="text-[#FA4D8D]">Book</span></div>
                  <section className="rounded-[18px] border border-[#EBE3E5] bg-white shadow-sm">
                    <header className="pointer-events-none grid items-center gap-5 border-b border-[#F4EFF0] p-6 md:grid-cols-[90px_1fr]">
                      <span className="grid h-20 w-20 place-items-center rounded-full bg-[#FA4D8D] text-white"><CalendarDays className="h-10 w-10" /></span>
                      <div><h1 className="text-[28px] font-black">Book your session</h1><p className="text-lg font-semibold">Choose your preferred date, time &amp; package.</p></div>
                    </header>
                    <div className="grid gap-5 p-6 lg:grid-cols-[1fr_340px]">
                      <section className="pointer-events-none">
                        <div className="grid gap-5 md:grid-cols-[245px_1fr]">
                          <img src={resolveThumbnail(previewFor)} alt={previewFor.title} className="h-52 w-full rounded-[12px] bg-[#F3EDF0] object-contain" />
                          <div>
                            <h2 className="text-xl font-black">{previewFor.title}</h2>
                            {ageText && <p className="mt-2 font-semibold">{ageText}</p>}
                            <div className="mt-5 space-y-3 font-semibold text-[#4a5685]">
                              {previewLocation(previewFor) && <p className="flex gap-2"><MapPin className="h-5 w-5 shrink-0 text-[#C7B1E6]" /> {previewLocation(previewFor)}</p>}
                              {previewFor.category_id && <p className="flex gap-2"><Music className="h-5 w-5 text-[#C7B1E6]" /> {categoryName(previewFor.category_id)}</p>}
                            </div>
                          </div>
                        </div>

                        {termOn && (
                          // Interactive on purpose: a vendor has to be able to flip between
                          // the options to see each one, as a parent would.
                          <div className="pointer-events-auto mt-6 space-y-6 border-t border-[#F4EFF0] pt-5">
                            <TermPicker
                              terms={pickerTerms}
                              selected={previewTerm!.id}
                              onSelect={(id) => { setPreviewTermId(id); setPreviewSlotIdx(0); setPreviewPassed(0); setPreviewOneOffDate(null); }}
                            />
                            <BookModeChoice view={termView!} quote={termQuote!} mode={bookMode} onModeChange={setPreviewMode} trialUsed={previewTrialUsed} />
                            {termMode && (
                              <TermEnrolPanel view={termView!} slotIdx={previewSlotIdx} onSlotChange={setPreviewSlotIdx} quote={termQuote!} />
                            )}
                            {!termMode && (
                              <TermSessionPicker
                                groups={oneOffGroups}
                                groupIdx={previewSlotIdx}
                                onGroupChange={(i) => { setPreviewSlotIdx(i); setPreviewOneOffDate(null); }}
                                from={previewPassed}
                                selected={oneOffDate}
                                onSelect={setPreviewOneOffDate}
                              />
                            )}
                          </div>
                        )}

                        <div className="mt-6 space-y-6 border-t border-[#F4EFF0] pt-5">
                          {!termOn && (previewSessions.length === 0 ? (
                            <p className="rounded-[12px] bg-[#FFF5F8] p-4 font-semibold text-[#5a6690]">No upcoming sessions scheduled yet.</p>
                          ) : (
                            <>
                              <section>
                                <h3 className="mb-4 text-xl font-black">Choose a date</h3>
                                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                  {dateKeys.map((d) => {
                                    const [weekday, dayMonth] = d.split(', ');
                                    return (
                                      <div key={d} className={cn('rounded-[10px] border px-3 py-4 text-sm font-bold', d === selectedDateKey ? 'border-[#FA4D8D] bg-[#FEEBF2] text-[#FA4D8D]' : 'border-[#DCD2D5] bg-white')}>
                                        <span className="block whitespace-nowrap">{weekday},</span>
                                        <span className="block whitespace-nowrap">{dayMonth}</span>
                                        <span className="mt-2 block text-xs font-semibold text-[#697390]">{sessionsByDate[d].length} {sessionsByDate[d].length === 1 ? 'time' : 'times'}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </section>
                              <section>
                                <h3 className="mb-4 text-xl font-black">Choose a time</h3>
                                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                  {(selectedDateKey ? sessionsByDate[selectedDateKey] : []).map((s) => (
                                    <div key={s.id} className={cn('rounded-[10px] border px-3 py-4 font-bold', s.id === nextSession?.id ? 'border-[#FA4D8D] bg-[#FEEBF2] text-[#FA4D8D]' : 'border-[#DCD2D5] bg-white')}>
                                      <span className="block whitespace-nowrap">{new Date(s.starts_at).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' })}</span>
                                      <span className="mt-2 block text-xs font-semibold text-[#697390]">{s.capacity != null ? `${s.capacity} spots` : 'Available'}</span>
                                    </div>
                                  ))}
                                </div>
                              </section>
                            </>
                          ))}
                          {!termMode && (
                          <section>
                            <h3 className="mb-2 text-xl font-black">Number of tickets/passes</h3>
                            <div className="inline-grid grid-cols-3 overflow-hidden rounded-[10px] border border-[#DCD2D5] text-xl font-black">
                              <span className="grid h-12 w-12 place-items-center">-</span>
                              <span className="grid h-12 w-14 place-items-center">1</span>
                              <span className="grid h-12 w-12 place-items-center">+</span>
                            </div>
                          </section>
                          )}

                          {(previewPolicies.length > 0 || previewFor.info_request_enabled || previewFor.requires_medical_disclosure) && (
                            <section>
                              <h3 className="mb-2 text-xl font-black">Provider terms</h3>
                              <p className="mb-4 text-sm font-semibold text-[#59658d]">
                                {provider?.business_name?.trim() || 'This provider'} asks you to read and accept the following before the class.
                              </p>
                              <div className="space-y-3">
                                {previewPolicies.map((p) => (
                                  <div key={p.id} className="flex gap-3 rounded-[12px] border-2 border-[#DCD2D5] bg-white p-4">
                                    <span className="mt-1 h-4 w-4 shrink-0 rounded border-2 border-[#DCD2D5]" />
                                    <span className="min-w-0">
                                      <span className="block font-black">
                                        {p.title}
                                        {p.required ? <span className="ml-1 text-[#FA4D8D]">*</span> : (
                                          <span className="ml-2 rounded-full bg-[#F4EFF0] px-2 py-0.5 text-[10px] font-bold text-[#6D748D]">Optional</span>
                                        )}
                                      </span>
                                      {p.body && <span className="mt-1 block whitespace-pre-wrap text-sm font-semibold leading-6 text-[#4a5685]">{p.body}</span>}
                                      {p.document_url && (
                                        <a
                                          href={p.document_url}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="pointer-events-auto mt-1 inline-flex items-center gap-1 text-sm font-black text-[#A7D8F8] underline"
                                        >
                                          <ExternalLink className="h-3.5 w-3.5" /> Read the full document
                                        </a>
                                      )}
                                    </span>
                                  </div>
                                ))}
                                {previewFor.info_request_enabled && (
                                  <div className="rounded-[12px] border-2 border-[#DCD2D5] bg-white p-4">
                                    <p className="font-black">{previewFor.info_request_prompt?.trim() || 'The provider needs some extra information'} <span className="text-[#FA4D8D]">*</span></p>
                                    <div className="mt-2 h-16 w-full rounded-[10px] border border-[#FED7E4]" />
                                    {previewFor.info_request_prompt_2?.trim() && (
                                      <>
                                        <p className="mt-3 font-black">{previewFor.info_request_prompt_2.trim()} <span className="text-[#FA4D8D]">*</span></p>
                                        <div className="mt-2 h-16 w-full rounded-[10px] border border-[#FED7E4]" />
                                      </>
                                    )}
                                  </div>
                                )}
                                {previewFor.requires_medical_disclosure && (
                                  <div className="rounded-[12px] border-2 border-[#DCD2D5] bg-white p-4">
                                    <p className="font-black">Medical &amp; health disclosure <span className="text-[#FA4D8D]">*</span></p>
                                    <p className="mt-1 text-sm font-semibold text-[#59658d]">
                                      Anything the provider should know — allergies, conditions, medication. Write &ldquo;none&rdquo; if there is nothing to declare.
                                    </p>
                                    <div className="mt-2 h-16 w-full rounded-[10px] border border-[#FED7E4]" />
                                  </div>
                                )}
                              </div>
                            </section>
                          )}

                          {previewPackages.length > 0 && !termMode && (!termOn || termView!.packages) && (
                            <section className="pointer-events-none">
                              <h3 className="mb-2 text-xl font-black">Select package</h3>
                              <p className="mb-4 text-sm font-semibold text-[#59658d]">Pay for this session on its own, or use a multi-session pack.</p>
                              <div className="space-y-3">
                                {!(termOn && bookMode === 'package') && (
                                <div className="flex items-center justify-between gap-3 rounded-[12px] border-2 border-[#FA4D8D] bg-[#FEEBF2] p-4">
                                  <span className="font-black">{termOn && bookMode === 'trial' ? 'Trial session' : 'Single session'}</span>
                                  <span className="font-black text-[#FA4D8D]">{shownPrice != null ? `$${shownPrice.toFixed(2)}` : 'Price on enquiry'}</span>
                                </div>
                                )}
                                {previewPackages.map((p, pi) => (
                                  <div key={p.id} className={cn('flex items-center justify-between gap-3 rounded-[12px] border-2 p-4', termOn && bookMode === 'package' && pi === 0 ? 'border-[#FA4D8D] bg-[#FEEBF2]' : 'border-[#DCD2D5] bg-white')}>
                                    <div><span className="block font-black">{p.name}</span><span className="text-sm font-semibold text-[#59658d]">{p.credits} {p.credits === 1 ? "session" : "sessions"}</span></div>
                                    <span className="font-black">${(p.price_cents / 100).toFixed(0)}</span>
                                  </div>
                                ))}
                              </div>
                            </section>
                          )}
                        </div>
                      </section>

                      <aside className="pointer-events-none h-fit rounded-[16px] border border-[#EBE3E5] bg-white p-5">
                        <h2 className="text-xl font-black">Booking summary</h2>
                        <div className="mt-5 flex gap-4">
                          <img src={resolveThumbnail(previewFor)} alt="" className="h-24 w-28 rounded-[10px] bg-[#F3EDF0] object-contain" />
                          <div><h3 className="font-black">{previewFor.title}</h3>{ageText && <p className="mt-1 text-sm font-semibold">{ageText}</p>}</div>
                        </div>
                        <div className="mt-5 space-y-4 font-semibold text-[#3f4b78]">
                          <p className="flex gap-2"><CalendarDays className="h-5 w-5 shrink-0 text-[#C7B1E6]" /> {termMode ? `Term · ${termQuote!.slot.label} · ${termQuote!.left} sessions from ${sgDay(termQuote!.joining[0])}` : termOn && bookMode === 'package' ? `Package · ${previewPackages[0]?.name ?? 'Choose a package'}${oneOffDate ? ` · ${sgDay(oneOffDate)}` : ''}` : termOn ? (oneOffDate ? `${bookMode === 'trial' ? 'Trial session' : 'Single session'} · ${sgDay(oneOffDate)}, ${sgTime(oneOffDate)}` : 'Select a date') : nextSession ? fmtDateTime(nextSession.starts_at) : 'Select a date & time'}</p>
                          {previewLocation(previewFor) && <p className="flex gap-2"><MapPin className="h-5 w-5 shrink-0 text-[#C7B1E6]" /> {previewLocation(previewFor)}</p>}
                          <p className="flex gap-2"><Users className="h-5 w-5 shrink-0 text-[#C7B1E6]" /> {termMode ? '1 child' : '1 ticket'}{ageText ? `, ${ageText}` : ''}</p>
                        </div>
                        <div className="my-5 border-t border-[#F4EFF0]" />
                        <p className="flex justify-between text-lg font-black"><span>Total</span><span className="text-[#FA4D8D]">{shownPrice != null ? `$${shownPrice.toFixed(2)}` : 'Price on enquiry'}</span></p>
                      </aside>
                    </div>
                  </section>
                  <section className="pointer-events-none mt-5 grid items-center gap-5 rounded-[16px] border border-[#EBE3E5] bg-white p-6 md:grid-cols-[1fr_360px]">
                    <div className="flex items-center gap-5">
                      <span className="grid h-16 w-16 place-items-center rounded-full bg-[#FEEBF2] text-[#FA4D8D]"><Lock className="h-8 w-8" /></span>
                      <p><span className="block font-bold">Total amount</span><strong className="text-3xl">{shownPrice != null ? `$${shownPrice.toFixed(2)}` : '—'}</strong></p>
                    </div>
                    <span className="flex w-full items-center justify-center gap-2 rounded-[11px] bg-gradient-to-r from-[#fa4d8d] to-[#ff6b9b] px-6 py-3 text-[15px] font-extrabold text-white">
                      <Lock className="h-5 w-5" /> {termMode ? `Enrol for the term — $${termQuote!.payNow}` : termOn && bookMode === 'package' ? (shownPrice != null ? `Buy pack — $${shownPrice.toFixed(0)}` : 'Choose a package') : shownPrice != null && shownPrice > 0 ? `Pay $${shownPrice.toFixed(2)}` : 'Confirm booking'}
                    </span>
                    <div className="space-y-0.5 text-center md:col-span-2">
                      {previewNonCancellable && <p className="text-xs font-bold text-[#6D748D]">* This activity is non-cancellable once booked.</p>}
                      {!previewNonCancellable && previewFor.cancellation_refund_mode === 'none' && <p className="text-xs font-bold text-[#6D748D]">* Payment for this activity is non-refundable, if cancelled.</p>}
                      {shownPrice != null && shownPrice > 0 && <p className="text-xs font-semibold text-[#6D748D]">Secure and encrypted payment via Stripe</p>}
                    </div>
                  </section>
                </div>
              )}

              {previewPage === 2 && (
                <div className="pointer-events-none mx-auto max-w-[1024px]">
                  <div className="mb-5 flex gap-3 text-sm font-bold"><span>Home</span><span>›</span><span>Activities</span><span>›</span><span>Activity details</span><span>›</span><span className="text-[#FA4D8D]">Book</span></div>
                  <section className="grid items-center gap-5 rounded-[18px] border border-[#EBE3E5] bg-gradient-to-r from-[#FEEBF2] to-white p-8 md:grid-cols-[100px_1fr]">
                    <span className="grid h-20 w-20 place-items-center rounded-full bg-[#FA4D8D] text-white"><Check className="h-12 w-12" /></span>
                    <div><h1 className="text-[32px] font-black">Your session is booked!</h1><p className="mt-2 text-lg font-semibold">We can&rsquo;t wait to see your little one there.</p></div>
                  </section>
                  <section className="mt-5 grid gap-5 lg:grid-cols-[1fr_350px]">
                    <div className="space-y-5">
                      <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6">
                        <h2 className="text-xl font-black">Activity details</h2>
                        <div className="mt-5 grid gap-5 md:grid-cols-[245px_1fr]">
                          <img src={resolveThumbnail(previewFor)} alt="" className="h-52 w-full rounded-[12px] bg-[#F3EDF0] object-contain" />
                          <div>
                            <h3 className="text-xl font-black">{previewFor.title}</h3>
                            {nextSession && <div className="mt-5 space-y-3 font-semibold text-[#4a5685]"><p><CalendarDays className="mr-2 inline h-5 w-5 text-[#C7B1E6]" />{fmtDateTime(nextSession.starts_at)}</p></div>}
                            {previewLocation(previewFor) && <p className="mt-3 font-semibold text-[#4a5685]"><MapPin className="mr-2 inline h-5 w-5 text-[#C7B1E6]" />{previewLocation(previewFor)}</p>}
                          </div>
                        </div>
                        {previewFor.description?.trim() && (
                          <div className="mt-5 border-t border-[#F4EFF0] pt-5">
                            <h3 className="font-black">About this activity</h3>
                            <p className="mt-3 whitespace-pre-wrap font-semibold leading-7 text-[#3f4b78]">{previewFor.description.trim()}</p>
                          </div>
                        )}
                        {previewFor.confirmation_message?.trim() && (
                          <div className="mt-5 rounded-[12px] bg-[#F4F0FA] p-4">
                            <h3 className="font-black text-[#C7B1E6]">From &ldquo;{previewFor.title}&rdquo;</h3>
                            <p className="mt-2 whitespace-pre-wrap font-semibold leading-7 text-[#3f4b78]">{previewFor.confirmation_message.trim()}</p>
                          </div>
                        )}
                      </article>
                      <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6">
                        <h2 className="text-xl font-black">What to bring &amp; know</h2>
                        {previewFor.what_to_bring?.trim() ? (
                          <p className="mt-5 whitespace-pre-wrap font-semibold leading-7 text-[#3f4b78]">{previewFor.what_to_bring.trim()}</p>
                        ) : (
                          <div className="mt-5 grid gap-4 md:grid-cols-3">
                            {[['Arrive 10 mins early', 'Enable your child to get comfortable'], ['Dress comfortably', 'Allow for movement and potential mess'], ['Bring essentials', 'Socks, water and wipes encouraged']].map(([title, note]) => (
                              <div key={title} className="text-center">
                                <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#FEEBF2] text-[#FA4D8D]"><CalendarDays className="h-8 w-8" /></span>
                                <h3 className="mt-3 font-black">{title}</h3>
                                <p className="mt-2 text-sm font-semibold text-[#59658d]">{note}</p>
                              </div>
                            ))}
                          </div>
                        )}
                      </article>
                    </div>
                    <aside className="space-y-5">
                      <article className="rounded-[16px] border border-[#EBE3E5] bg-white p-6">
                        <h2 className="text-xl font-black">Booking summary</h2>
                        <div className="mt-5 space-y-4 font-semibold">
                          <p className="flex justify-between"><span>Activity</span><span className="text-right">{previewFor.title}</span></p>
                          {nextSession && <p className="flex justify-between"><span>When</span><span className="text-right">{fmtDateTime(nextSession.starts_at)}</span></p>}
                          {previewLocation(previewFor) && <p className="flex justify-between"><span>Where</span><span className="text-right">{previewLocation(previewFor)}</span></p>}
                          <p className="flex justify-between"><span>Status</span><strong className="text-[#4CAF7D]">Confirmed</strong></p>
                        </div>
                        <p className="mt-5 rounded-[12px] bg-[#F1FBEF] p-4 font-semibold text-[#4CAF7D]"><Check className="mr-2 inline h-5 w-5" /> Booking confirmed</p>
                        <span className="mt-5 flex w-full items-center justify-center gap-2 rounded-[11px] bg-gradient-to-r from-[#fa4d8d] to-[#ff6b9b] px-6 py-3 text-[15px] font-extrabold text-white">View my bookings</span>
                        <span className="mt-3 flex w-full items-center justify-center gap-2 rounded-[11px] border border-[#DCD2D5] px-6 py-3 text-[15px] font-extrabold text-[#34406f]"><CalendarDays className="h-4 w-4" /> Add to calendar</span>
                      </article>
                      <article className="rounded-[16px] bg-[#F4F0FA] p-6">
                        <h2 className="text-xl font-black text-[#C7B1E6]">Need help?</h2>
                        <p className="mt-3 font-semibold">Questions about this session? Message the provider directly.</p>
                        <span className="mt-4 flex w-full items-center justify-center gap-2 rounded-[11px] border border-[#DCD2D5] px-6 py-3 text-[15px] font-extrabold text-[#34406f]"><Mail className="h-4 w-4" /> Message the provider</span>
                      </article>
                    </aside>
                  </section>
                </div>
              )}
              </div>
            </div>

            <div className="border-t border-[#EBE3E5] bg-white px-5 py-2.5 text-center text-xs text-gray-500">
              {previewPage === 0 && 'Preview only — everything is inert except the photo carousel.'}
              {previewPage === 1 && "Preview only — everything is inert except a policy's document link."}
              {previewPage === 2 && 'Preview only — nothing here is clickable.'}
            </div>
          </div>
        </div>
        );
      })()}

      {/* Schedule Drawer — the bookable dates/times for one activity */}
      {scheduleFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setScheduleFor(null); }}
        >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Manage schedule: ${scheduleFor.title}`}
          className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
        >
          <div className="flex items-center justify-between p-5 border-b border-gray-200">
            <div>
              <h3 className="text-xl font-bold text-gray-900">Manage schedule</h3>
              <p className="mt-0.5 text-sm text-gray-500">{scheduleFor.title}</p>
            </div>
            <button onClick={() => setScheduleFor(null)} className="p-1.5 hover:bg-gray-100 rounded-lg" aria-label="Close">
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>

          {termsOn && !scheduleIsWix && (
            <div className="flex gap-2 border-b border-gray-200 px-5" role="tablist">
              {([['single', 'Single sessions'], ['terms', 'Terms']] as const).map(([k, label]) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={scheduleTab === k}
                  onClick={() => setScheduleTab(k)}
                  className={cn(
                    '-mb-px flex items-center gap-1.5 border-b-[3px] px-3 py-3 text-[15px] transition-colors',
                    scheduleTab === k ? 'border-[#FA4D8D] font-bold text-gray-900' : 'border-transparent font-semibold text-gray-500 hover:text-gray-800',
                    k === 'single' && singlesLocked && 'text-gray-400',
                    k === 'terms' && !termsEnabledMap[scheduleFor.id] && 'text-gray-400',
                  )}
                >
                  {label}
                  {((k === 'single' && singlesLocked) || (k === 'terms' && !termsEnabledMap[scheduleFor.id])) && <Lock className="h-3.5 w-3.5" aria-label="Frozen" />}
                </button>
              ))}
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {termsOn && !scheduleIsWix && scheduleTab === 'terms' ? (
              <>
                {!termsEnabledMap[scheduleFor.id] && (
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
                    <div className="flex items-start gap-3">
                      <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                      <div>
                        <p className="text-[15px] font-bold text-amber-950">Terms are switched off for this activity</p>
                        <p className="mt-0.5 text-[13px] text-amber-900">
                          Turn on "Offer this activity as a term" in Edit activity to build terms here.
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => { const a = scheduleFor; setScheduleFor(null); openEdit(a); }}
                      className="h-10 rounded-xl border-2 border-amber-400 px-4 text-sm font-bold text-amber-950 hover:bg-amber-100"
                    >
                      Open Edit activity
                    </Button>
                  </div>
                )}
                <div
                  className={cn(!termsEnabledMap[scheduleFor.id] && 'pointer-events-none select-none opacity-40 grayscale')}
                  aria-disabled={!termsEnabledMap[scheduleFor.id] ? true : undefined}
                  inert={!termsEnabledMap[scheduleFor.id] ? true : undefined}
                >
                  <TermsPanel
                    activityId={scheduleFor.id}
                    activityTitle={scheduleFor.title}
                    defaultPrice={scheduleFor.price ?? null}
                    defaultCapacity={scheduleFor.default_capacity ?? null}
                    defaultLocationId={scheduleFor.location_id ?? null}
                    locations={locations}
                  />
                </div>
              </>
            ) : (
            <>
            {/* A Wix-linked activity's dates come from Wix and are re-mirrored
                (and reconciled) on every availability fetch, so a session added
                or moved here is either swept away or becomes a slot Wix refuses
                to book. Read-only, with the one place that can change it named. */}
            {scheduleIsWix && (
              <div className="rounded-xl border border-purple-200 bg-purple-50/40 p-4">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700">Wix</span>
                  <span className="text-sm font-semibold text-gray-900">Schedule managed in Wix</span>
                </div>
                <p className="mt-2 text-xs text-gray-600">
                  {scheduleIsWixEvent
                    ? 'This is a Wix event — its date and ticket capacity come from Wix.'
                    : scheduleFor?.wix_service_type === 'COURSE'
                      ? 'This is a Wix course — one booking covers the whole run, and every session below comes from Wix.'
                      : 'These sessions mirror live availability on your Wix calendar.'}
                  {' '}Add, move or cancel them in Wix and they&rsquo;ll update here.
                </p>
              </div>
            )}
            {singlesLocked && !scheduleIsWix && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
                <div className="flex items-start gap-3">
                  <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                  <div>
                    <p className="text-[15px] font-bold text-amber-950">Single sessions are locked</p>
                    <p className="mt-0.5 text-[13px] text-amber-900">
                      This activity is offered as a term, so its sessions, including any trial or single sessions, are set up under Terms.
                      Existing sessions below can still be edited or cancelled. Turn off "Offer this activity as a term" in Edit activity to add sessions here.
                    </p>
                  </div>
                </div>
                <Button variant="outline" onClick={() => setScheduleTab('terms')} className="h-10 rounded-xl border-2 border-amber-400 px-4 text-sm font-bold text-amber-950 hover:bg-amber-100">
                  Open Terms
                </Button>
              </div>
            )}
            {!scheduleIsWix && (
            <div
              className={cn(singlesLocked && 'pointer-events-none select-none opacity-40 grayscale')}
              aria-disabled={singlesLocked ? true : undefined}
              inert={singlesLocked ? true : undefined}
            >
              <h4 className="mb-3 text-lg font-bold text-gray-900">Add sessions</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[13px] font-semibold text-gray-700">Start date</label>
                  <DatePicker
                    className={inputCls}
                    value={sessForm.date}
                    onChange={(v) =>
                      setSessForm((f) => {
                        // Seed the weekday toggles from the start date, but only
                        // while they still match the old start date (i.e. the
                        // vendor hasn't hand-picked their own set yet).
                        const untouched =
                          f.weekdays.length === 0 ||
                          (!!f.date && f.weekdays.length === 1 && f.weekdays[0] === dowOfYmd(f.date));
                        return { ...f, date: v, weekdays: untouched && v ? [dowOfYmd(v)] : f.weekdays };
                      })
                    }
                    aria-label="Session start date"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[13px] font-semibold text-gray-700">Start time</label>
                  <TimePicker className={cn(inputCls, 'w-full')} value={sessForm.time} onChange={(v) => setSessForm({ ...sessForm, time: v })} aria-label="Start time" />
                </div>
                <div>
                  <label className="mb-1 block text-[13px] font-semibold text-gray-700">Duration (mins)</label>
                  <NumberInput min="15" step="1" className={inputCls} value={sessForm.duration} onChange={(e) => setSessForm({ ...sessForm, duration: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1 block text-[13px] font-semibold text-gray-700">Capacity *</label>
                  <NumberInput min="1" required placeholder="e.g. 12" className={inputCls} value={sessForm.capacity} onChange={(e) => setSessForm({ ...sessForm, capacity: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1 block text-[13px] font-semibold text-gray-700">Teacher (leave blank if N/A)</label>
                  <input placeholder="e.g. Ms Tan" className={inputCls} value={sessForm.teacher} onChange={(e) => setSessForm({ ...sessForm, teacher: e.target.value })} aria-label="Session teacher" />
                </div>
                <div>
                  <label className="mb-1 block text-[13px] font-semibold text-gray-700">Studio / room (leave blank if N/A)</label>
                  <input placeholder="e.g. Room 2" className={inputCls} value={sessForm.studio} onChange={(e) => setSessForm({ ...sessForm, studio: e.target.value })} />
                </div>
                {/* Venue and price per session (QA 21/08) — this is what lets one
                    activity run at three locations, or cost different amounts at
                    each, instead of being created three times. */}
                <div>
                  <label className="mb-1 block text-[13px] font-semibold text-gray-700">Venue</label>
                  <SelectField
                    className={inputCls}
                    value={sessForm.location_id}
                    // Moving to a venue with its own price moves the pre-filled price with it,
                    // unless the vendor already typed a different one.
                    onChange={(v) => setSessForm((f) => ({
                      ...f,
                      location_id: v,
                      price: f.price === String(venueBasePrice(f.location_id) ?? '') ? String(venueBasePrice(v) ?? '') : f.price,
                    }))}
                    aria-label="Session venue"
                  >
                    <Opt value="">Same as the activity</Opt>
                    {scheduleVenues.map((l) => <Opt key={l.id} value={l.id}>{l.name}</Opt>)}
                  </SelectField>
                </div>
                <div>
                  <label className="mb-1 block text-[13px] font-semibold text-gray-700">Price (SGD)</label>
                  <NumberInput
                    
                    min="0"
                    step="any"
                    placeholder={
                      scheduleIsWixEvent
                        ? 'Set by Wix ticket types'
                        : venueBasePrice(sessForm.location_id) != null ? `Location price: ${venueBasePrice(sessForm.location_id)}` : 'Same as the activity'
                    }
                    className={cn(inputCls, scheduleIsWixEvent && 'bg-gray-50 text-gray-500 cursor-not-allowed')}
                    value={scheduleIsWixEvent ? '' : sessForm.price}
                    onChange={(e) => setSessForm({ ...sessForm, price: e.target.value })}
                    disabled={scheduleIsWixEvent}
                  />
                </div>
                {/* Recurrence — two independent controls (which weekdays, and
                    for how many weeks), plus a "Custom dates" escape hatch so a
                    term that doesn't fit a clean weekly pattern isn't forced
                    into one. */}
                <div className="col-span-2 space-y-3 rounded-xl bg-gray-50 p-3">
                  <div>
                    <label className="mb-1 block text-[13px] font-semibold text-gray-700">Repeat for</label>
                    <SelectField
                      className={inputCls}
                      value={sessForm.weeks}
                      onChange={(v) => setSessForm({ ...sessForm, weeks: v })}
                      aria-label="Repeat for"
                    >
                      <Opt value="1">Just the start date</Opt>
                      {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                        <Opt key={n} value={String(n)}>{n} weeks</Opt>
                      ))}
                      <Opt value="custom">Custom dates…</Opt>
                    </SelectField>
                  </div>

                  {sessForm.weeks !== 'custom' ? (
                    <div>
                      <label className="mb-1 block text-[13px] font-semibold text-gray-700">On these days</label>
                      <div className="flex gap-1">
                        {WEEKDAY_TOGGLES.map((d) => {
                          const on = sessForm.weekdays.includes(d.i);
                          return (
                            <button
                              type="button"
                              key={d.i}
                              title={d.name}
                              aria-pressed={on}
                              onClick={() =>
                                setSessForm((f) => ({
                                  ...f,
                                  weekdays: on
                                    ? f.weekdays.filter((x) => x !== d.i)
                                    : [...f.weekdays, d.i],
                                }))
                              }
                              className={cn(
                                'h-8 w-8 rounded-lg text-xs font-semibold transition-colors',
                                on
                                  ? 'bg-[#FA4D8D] text-white'
                                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-100'
                              )}
                            >
                              {d.label}
                            </button>
                          );
                        })}
                      </div>
                      <p className="mt-1 text-[11px] text-gray-400">
                        {sessForm.weekdays.length === 0
                          ? "None ticked — uses the start date's own day."
                          : 'First occurrence is on or after the start date.'}
                      </p>
                    </div>
                  ) : (
                    <div>
                      <label className="mb-1 block text-[13px] font-semibold text-gray-700">Dates</label>
                      <div className="flex gap-2">
                        <DatePicker
                          className={inputCls}
                          value={customDateDraft}
                          onChange={setCustomDateDraft}
                          aria-label="Add a session date"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const d = customDateDraft;
                            if (!d || d === sessForm.date || sessForm.customDates.includes(d)) return;
                            setSessForm((f) => ({ ...f, customDates: [...f.customDates, d].sort() }));
                            setCustomDateDraft('');
                          }}
                          disabled={!customDateDraft}
                          className="flex-shrink-0 rounded-xl border border-gray-200 px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                        >
                          Add
                        </button>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {sessForm.date && (
                          <span className="inline-flex items-center rounded-full bg-white border border-gray-200 px-2 py-0.5 text-xs text-gray-500">
                            {fmtYmd(sessForm.date)} (start)
                          </span>
                        )}
                        {sessForm.customDates.map((d) => (
                          <span key={d} className="inline-flex items-center gap-1 rounded-full bg-white border border-gray-200 px-2 py-0.5 text-xs text-gray-700">
                            {fmtYmd(d)}
                            <button
                              type="button"
                              aria-label={`Remove ${fmtYmd(d)}`}
                              onClick={() => setSessForm((f) => ({ ...f, customDates: f.customDates.filter((x) => x !== d) }))}
                              className="text-gray-400 hover:text-gray-700"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {plannedSessionDates.length > 0 && (
                    <p className="text-xs font-medium text-gray-600">
                      Adds {plannedSessionDates.length} session{plannedSessionDates.length > 1 ? 's' : ''}
                      {plannedSessionDates.length > 1 && `, ${fmtYmd(plannedSessionDates[0])} – ${fmtYmd(plannedSessionDates[plannedSessionDates.length - 1])}`}.
                    </p>
                  )}
                </div>
                <div className="col-span-2">
                  <SessionPolicyEditor policy={sessForm.policy} onChange={(p) => setSessForm({ ...sessForm, policy: p })} />
                </div>
              </div>
              {sessError && <p className="mt-2 text-xs font-medium text-red-600">{sessError}</p>}
              {sessNotice && !sessError && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">{sessNotice}</p>}
              <Button onClick={addSessions} disabled={savingSess} className="mt-3 w-full gradient-primary text-white rounded-xl hover:opacity-90">
                {savingSess ? 'Adding…' : 'Add to schedule'}
              </Button>
            </div>
            )}

            <div>
              <h4 className="mb-3 text-lg font-bold text-gray-900">
                Upcoming sessions{sessionsLoading ? '' : ` (${sessions.length + termClassRows.length})`}
                {termClassRows.length > 0 && (
                  <span className="ml-2 text-xs font-normal text-gray-500">{termClassRows.length} from terms</span>
                )}
              </h4>
              {sessionsLoading && (
                <LoadingRows label="Loading sessions…" />
              )}
              {!sessionsLoading && sessions.length === 0 && termClassRows.length === 0 && (
                <p className="text-sm text-gray-400">No upcoming sessions — parents can't book this activity until you add some.</p>
              )}
              <div className="space-y-2">
                {sessionItems.map((item) => item.term ? (
                  <div key={item.term.id} className="flex items-center justify-between gap-2 rounded-lg border border-teal-200 bg-teal-50/60 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-900">
                        {fmtDateTime(item.term.starts_at)}
                        <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold text-teal-800">
                          Term · session {item.term.sessionNo}/{item.term.sessionOf}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500">
                        {item.term.termName} · {item.term.termSeats} term{item.term.singleSeats > 0 ? ` + ${item.term.singleSeats} single` : ''} / {item.term.capacity} seats
                        {item.term.locationId && item.term.locationId !== scheduleFor?.location_id && (
                          <>{' · '}<span className="text-blue-700">{locations.find((l) => l.id === item.term!.locationId)?.name ?? 'Other venue'}</span></>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => setSkipTermTarget(item.term!)}
                      className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                      title="Skip this session for the term"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ) : ((s: Sess) => (
                  editingSessId === s.id ? (
                    <div key={s.id} className="rounded-lg border border-pink-300 bg-pink-50/30 px-3 py-2.5 space-y-2">
                      {/* A Wix-synced session's date/time/capacity/venue/price is
                          Wix's own — /api/wix/slots owns and reconciles it, so
                          this edit row is booking-policy-only for one (opened via
                          the dedicated policy button below, not Pencil). */}
                      {!scheduleIsWix && (
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Date</span>
                          <DatePicker className={inputCls} value={sessEditForm.date} onChange={(v) => setSessEditForm({ ...sessEditForm, date: v })} aria-label="Session date" />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Start time (SGT)</span>
                          <TimePicker className={cn(inputCls, 'w-full')} value={sessEditForm.time} onChange={(v) => setSessEditForm({ ...sessEditForm, time: v })} aria-label="Start time" />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Duration (mins)</span>
                          <NumberInput min="15" step="1" className={inputCls} value={sessEditForm.duration} onChange={(e) => setSessEditForm({ ...sessEditForm, duration: e.target.value })} />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Capacity</span>
                          <NumberInput min="1" className={inputCls} value={sessEditForm.capacity} onChange={(e) => setSessEditForm({ ...sessEditForm, capacity: e.target.value })} />
                          {(() => {
                            const cur = sessions.find((x) => x.id === s.id);
                            if (!cur || cur.waitlisted === 0) return null;
                            return (
                              <span className="mt-1 block text-xs text-gray-500">
                                {cur.booked} booked, {cur.waitlisted} on the waitlist. Each extra space you add invites every family on the waitlist to book. First come, first serve.
                              </span>
                            );
                          })()}
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Teacher</span>
                          <input placeholder="e.g. Ms Tan" className={inputCls} value={sessEditForm.teacher} onChange={(e) => setSessEditForm({ ...sessEditForm, teacher: e.target.value })} aria-label="Session teacher" />
                        </label>
                        <input placeholder="Studio (N/A if blank)" className={inputCls} value={sessEditForm.studio} onChange={(e) => setSessEditForm({ ...sessEditForm, studio: e.target.value })} />
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Venue</span>
                          <SelectField className={inputCls} value={sessEditForm.location_id} onChange={(v) => setSessEditForm({ ...sessEditForm, location_id: v })} aria-label="Session venue">
                            <Opt value="">Same as the activity</Opt>
                            {scheduleVenues.map((l) => <Opt key={l.id} value={l.id}>{l.name}</Opt>)}
                          </SelectField>
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Price (SGD)</span>
                          <NumberInput
                            
                            min="0"
                            step="any"
                            placeholder={
                              scheduleIsWixEvent
                                ? 'Set by Wix ticket types'
                                : venueBasePrice(sessEditForm.location_id) != null ? `Location price: ${venueBasePrice(sessEditForm.location_id)}` : 'Same as the activity'
                            }
                            className={cn(inputCls, scheduleIsWixEvent && 'bg-gray-50 text-gray-500 cursor-not-allowed')}
                            value={scheduleIsWixEvent ? '' : sessEditForm.price}
                            onChange={(e) => setSessEditForm({ ...sessEditForm, price: e.target.value })}
                            disabled={scheduleIsWixEvent}
                          />
                        </label>
                      </div>
                      )}
                      <SessionPolicyEditor policy={sessEditForm.policy} onChange={(p) => setSessEditForm({ ...sessEditForm, policy: p })} />
                      {sessEditError && <p className="text-xs font-medium text-red-600">{sessEditError}</p>}
                      {s.booked > 0 && (
                        <p className="text-xs text-gray-500">
                          {/* A date/time or venue move fires notify_session_rescheduled
                              (migrations 00044/00126) — an in-app notification plus the
                              session_rescheduled email (lib/emails/render.ts) — for every
                              live booking on this session. Capacity/teacher/studio/price
                              edits don't trigger it (the DB trigger only watches starts_at
                              and location_id), so this line only promises what actually
                              fires. */}
                          {s.booked} {s.booked > 1 ? 'have' : 'has'} booked this session — moving it automatically notifies them.
                        </p>
                      )}
                      <div className="flex gap-2">
                        <button onClick={() => saveSessEdit(s.id)} disabled={savingSessEdit} className="px-3 py-1.5 bg-[#FA4D8D] text-white rounded-lg text-xs font-medium disabled:opacity-50">
                          {savingSessEdit ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => setEditingSessId(null)} className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-medium text-gray-700">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div key={s.id} className={cn('flex items-center justify-between rounded-lg border px-3 py-2.5', s.bookings_paused ? 'border-amber-200 bg-amber-50/60' : 'border-gray-200')}>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-900">
                          {new Date(s.starts_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                          {s.bookings_paused && (
                            <span className="rounded px-1.5 py-0.5 text-xs font-medium text-amber-800 bg-amber-200">Bookings paused</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500">
                          {Math.round((new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000)} mins
                          {' · '}{s.capacity != null ? `${s.capacity} spots` : 'Unlimited'}
                          {' · '}{s.booked} booked{s.waitlisted > 0 ? ` · ${s.waitlisted} waitlisted` : ''}
                          {/* Only called out when it differs from the activity,
                              so the ordinary case stays quiet. */}
                          {s.location_id && s.location_id !== scheduleFor?.location_id && (
                            <>{' · '}<span className="text-blue-700">{locations.find((l) => l.id === s.location_id)?.name ?? 'Other venue'}</span></>
                          )}
                          {/* What it really costs (venue / weekday prices included), when that isn't the activity's own price. */}
                          {(() => {
                            const eff = sessEffectivePrice(s);
                            return eff != null && Number(eff) !== Number(scheduleFor?.price ?? NaN) ? (
                              <>{' · '}<span className="text-blue-700">{Number(eff) === 0 ? 'Free' : `SGD ${eff}`}</span></>
                            ) : null;
                          })()}
                        </div>
                        {(s.teacher_name || s.studio) && (
                          <div className="text-xs text-purple-700 mt-0.5 truncate">
                            {[s.teacher_name, s.studio].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-1">
                        {scheduleIsWix && (
                          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700">Wix</span>
                        )}
                        {/* Pause is a BabyBrain-side control that the sync never
                            overwrites, so it works on a Wix occurrence too — the
                            Wix booking routes honour it (isWixSessionPaused).
                            Editing / removing a Wix session stays Wix's job. */}
                        <button
                          onClick={() => toggleSessionPause(s)}
                          disabled={togglingSessId === s.id}
                          className={cn('p-1.5 rounded-lg disabled:opacity-50', s.bookings_paused ? 'text-amber-600 hover:bg-amber-100' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700')}
                          title={s.bookings_paused ? 'Resume bookings for this session' : 'Pause bookings for this session only'}
                        >
                          {s.bookings_paused ? <PlayCircle className="w-4 h-4" /> : <PauseCircle className="w-4 h-4" />}
                        </button>
                        {scheduleIsWix && (
                          // Wix owns this session's own schedule, but the
                          // cancel/reschedule cut-off enforced by BabyBrain is
                          // ours — so, unlike the full edit below, this stays
                          // available for a Wix-synced session too.
                          <button onClick={() => startEditSess(s)} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Booking policies for this session">
                            <ShieldCheck className="w-4 h-4" />
                          </button>
                        )}
                        {!scheduleIsWix && (
                          <>
                            <button onClick={() => startEditSess(s)} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Edit teacher / studio">
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button onClick={() => setRemoveSessTarget(s)} className="p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600" title={s.booked + s.waitlisted > 0 ? 'Cancel session' : 'Remove session'}>
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                ))(item.s))}
              </div>
            </div>
            </>
            )}
          </div>
        </div>
        </div>
      )}

      <ConfirmDialog
        open={!!skipTermTarget}
        onOpenChange={(open) => { if (!open) setSkipTermTarget(null); }}
        title="Skip this term session?"
        description={
          skipTermTarget
            ? `This session belongs to "${skipTermTarget.termName}". ${skipTermTarget.termSeats} enrolled ${skipTermTarget.termSeats === 1 ? 'child' : 'children'} would lose it, and the term would have ${skipTermTarget.sessionOf - 1} sessions for every family. Enrolled parents are told and offered a make-up. You can add the date back from the Terms tab.`
            : undefined
        }
        confirmLabel="Skip session"
        onConfirm={() => skipTermTarget && skipTermClass(skipTermTarget)}
      />

      <ConfirmDialog
        open={!!removeSessTarget}
        onOpenChange={(open) => { if (!open) setRemoveSessTarget(null); }}
        title={removeSessTarget && removeSessTarget.booked + removeSessTarget.waitlisted > 0 ? 'Cancel this session?' : 'Remove this session?'}
        description={
          removeSessTarget && removeSessTarget.booked + removeSessTarget.waitlisted > 0
            ? `This session has ${removeSessTarget.booked + removeSessTarget.waitlisted} booking${removeSessTarget.booked + removeSessTarget.waitlisted > 1 ? 's' : ''}${removeSessTarget.waitlisted ? ` (${removeSessTarget.waitlisted} on the waitlist)` : ''}. Cancelling it cancels those bookings, emails and notifies the parents, and issues their credit or make-up token.`
            : undefined
        }
        confirmLabel={removeSessTarget && removeSessTarget.booked + removeSessTarget.waitlisted > 0 ? 'Cancel session' : 'Remove'}
        loading={removingSess}
        onConfirm={() => removeSessTarget && removeSession(removeSessTarget)}
      />
    </div>
  );
}

/**
 * Activities → Policy & consent management → Medical disclosure.
 *
 * One provider-level control for the pre-booking health declaration: a master
 * toggle, then "all activities" or "certain activities" with a class picker.
 * The choice is stored on the provider (providers.medical_disclosure_mode /
 * _activity_ids, migration 00117) and a DB trigger mirrors it onto each
 * activity's requires_medical_disclosure flag, so the parent booking form and
 * the Wix checkout paths need no change and a class added later inherits an
 * "all" rule.
 */
function MedicalDisclosureCard({
  canManage, activities, mode, ids, setMode, setIds,
  dirty, saving, msg, onSave,
}: {
  canManage: boolean;
  activities: Activity[];
  mode: 'off' | 'all' | 'some';
  ids: string[];
  setMode: (m: 'off' | 'all' | 'some') => void;
  setIds: (ids: string[]) => void;
  dirty: boolean;
  saving: boolean;
  msg: { ok: boolean; text: string } | null;
  onSave: () => void;
}) {
  const named = activities
    .filter((a) => a.title)
    .sort((a, b) => a.title.localeCompare(b.title));

  return (
    <div className="rounded-xl border border-gray-200 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center shrink-0"><FileText className="w-5 h-5 text-amber-600" /></div>
          <div>
            <h3 className="font-semibold text-gray-900">Medical disclosure</h3>
            <p className="text-xs text-gray-500 mt-0.5 max-w-md">
              Parents must fill in a health declaration before this activity can be booked.
            </p>
          </div>
        </div>
        <Switch
          checked={mode !== 'off'}
          disabled={!canManage}
          onCheckedChange={(v) => setMode(v ? 'all' : 'off')}
          aria-label="Require a health declaration"
        />
      </div>

      {mode !== 'off' && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name="md-scope"
                className="h-4 w-4 accent-[#FA4D8D]"
                checked={mode === 'all'}
                disabled={!canManage}
                onChange={() => setMode('all')}
              />
              All activities
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name="md-scope"
                className="h-4 w-4 accent-[#FA4D8D]"
                checked={mode === 'some'}
                disabled={!canManage}
                onChange={() => setMode('some')}
              />
              Certain activities
            </label>
          </div>

          {mode === 'some' && (
            <div className="max-w-md">
              <MultiSelectField
                values={ids}
                onChange={setIds}
                disabled={!canManage}
                placeholder="Select activities"
                emptyMessage="No activities yet."
                aria-label="Activities that need a health declaration"
                className="w-full"
              >
                {named.map((a) => <Opt key={a.id} value={a.id}>{a.title}</Opt>)}
              </MultiSelectField>
              {ids.length === 0 && (
                <p className="mt-1 text-[11px] text-amber-600">Pick at least one activity, or switch to “All activities”.</p>
              )}
            </div>
          )}
        </div>
      )}

      {canManage && (
        <div className="mt-4 flex items-center gap-3">
          <Button
            onClick={onSave}
            disabled={saving || !dirty || (mode === 'some' && ids.length === 0)}
            className="gradient-primary text-white rounded-xl hover:opacity-90 px-5"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {msg && (
            <span className={cn('text-xs font-medium', msg.ok ? 'text-green-600' : 'text-red-600')}>{msg.text}</span>
          )}
        </div>
      )}
    </div>
  );
}
