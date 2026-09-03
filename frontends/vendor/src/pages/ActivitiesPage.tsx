import { useEffect, useMemo, useState } from 'react';
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
  Clock,
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RainbowLoader } from '@/components/ui/rainbow-loader';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import LocationsManager from '@/components/LocationsManager';
import type { Activity, ActivityCategory, VendorCategory } from '@/lib/database.types';


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
const rangesOverlap = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && aEnd > bStart;

const emptyForm = {
  title: '', category_id: '', vendor_category: '' as VendorCategory | '',
  description: '', age_min_months: '', age_max_months: '', price: '',
  location_id: '', default_capacity: '', image_url: '', requires_medical_disclosure: true,
  allow_cancellation: true, allow_rescheduling: true,
  cancellation_cutoff_hours: '24', reschedule_cutoff_hours: '24',
  // 00074 — booking cut-off, the bespoke information request, and the copy
  // parents see once they've booked.
  booking_cutoff_minutes: '15',
  info_request_enabled: false, info_request_prompt: '',
  what_to_bring: '', confirmation_message: '',
};

export default function ActivitiesPage() {
  const { provider, role } = useAuth();
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
  const [pageTab, setPageTab] = useState<'activities' | 'locations'>('activities');
  const [openNewLocation, setOpenNewLocation] = useState(false);

  /* Deep-linkable: Settings forwards its retired ?tab=locations here, and the
     dashboard's "Add a location" adds &new=location to open the form straight
     away. Driven off the router's params rather than read once at mount, so
     arriving from another page while already on /activities still switches. */
  useEffect(() => {
    if (searchParams.get('tab') === 'locations') {
      setPageTab('locations');
      if (searchParams.get('new') === 'location') setOpenNewLocation(true);
    }
  }, [searchParams]);

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
  const [form, setForm] = useState(emptyForm);
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
  const isWixLinked = !!(editingActivity?.wix_service_id || editingActivity?.wix_event_id);
  const isWixEvent = wixKind === 'EVENT';
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
    id: string; starts_at: string; ends_at: string; capacity: number | null; booked: number;
    location_id: string | null; price: number | null;
    teacher_name: string | null; studio: string | null;
  };
  const [scheduleFor, setScheduleFor] = useState<Activity | null>(null);
  const [sessions, setSessions] = useState<Sess[]>([]);
  // Same story as the edit drawer's price field: a Wix Event's price comes
  // from its ticket types and is re-synced every run, so the per-session
  // price boxes in here are read-only for one.
  const scheduleIsWixEvent = scheduleFor?.wix_service_type === 'EVENT';
  // Sessions for ANY Wix-linked activity are Wix's: /api/wix/slots mirrors
  // live availability into activity_sessions and reconciles away anything
  // that no longer matches. A hand-added session here is either swept or
  // becomes a slot Wix will refuse to book, so the whole schedule is
  // read-only for them.
  const scheduleIsWix = !!(scheduleFor?.wix_service_id || scheduleFor?.wix_event_id);
  /* QA 21/08: location and price move to the schedule, so the same class at
     three venues (or three prices) is ONE activity. Blank inherits the
     activity's own value. */
  const [sessForm, setSessForm] = useState({ date: '', time: '', duration: '45', capacity: '', repeat: '1', teacher: '', studio: '', location_id: '', price: '' });
  const [savingSess, setSavingSess] = useState(false);
  const [sessError, setSessError] = useState<string | null>(null);

  // Per-session teacher/studio can also be set after the fact (a substitute
  // teacher, or a room reassignment) without recreating the session.
  const [editingSessId, setEditingSessId] = useState<string | null>(null);
  /* QA 21/08: "under activities, manage schedule when you click edit upcoming
     sessions, it only allows you to add teacher and studio details — it should
     allow you to edit all the details." Date, start time, duration and capacity
     are now editable too; changing any of them rewrites starts_at/ends_at. */
  const [sessEditForm, setSessEditForm] = useState({ date: '', time: '', duration: '45', capacity: '', teacher: '', studio: '', location_id: '', price: '' });
  const [sessEditError, setSessEditError] = useState<string | null>(null);
  const [savingSessEdit, setSavingSessEdit] = useState(false);

  /* Parent-view preview. Vendors kept publishing blind and then opening the
     public site in another tab to check; this shows the same information
     without leaving the table. Read-only — the CTAs are rendered inert. */
  const [previewFor, setPreviewFor] = useState<Activity | null>(null);
  const [previewDuration, setPreviewDuration] = useState<number | 'loading' | null>('loading');

  function openPreview(a: Activity) {
    setShowMenu(null);
    setPreviewFor(a);
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

  async function openSchedule(a: Activity) {
    setShowMenu(null);
    setScheduleFor(a);
    setSessError(null);
    // Pre-fill from the activity's default capacity so a vendor adding
    // sessions doesn't have to retype the same number every time.
    setSessForm((f) => ({
      ...f,
      capacity: a.default_capacity != null ? String(a.default_capacity) : f.capacity,
      // Start from the activity's own venue/price so the common case (all
      // sessions the same) is still one click.
      location_id: a.location_id ?? '',
      price: a.price != null ? String(a.price) : '',
    }));
    await loadSessions(a.id);
  }

  async function loadSessions(activityId: string) {
    const { data: sess } = await supabase
      .from('activity_sessions')
      .select('id, starts_at, ends_at, capacity, teacher_name, studio, location_id, price')
      .eq('activity_id', activityId)
      .gte('starts_at', new Date().toISOString())
      .order('starts_at');
    const rows = sess ?? [];
    // Booked count per session so deleting a session with bookings warns first.
    const counts: Record<string, number> = {};
    if (rows.length) {
      const { data: bks } = await supabase
        .from('bookings')
        .select('session_id, status')
        .in('session_id', rows.map((s) => s.id));
      (bks ?? []).forEach((b) => {
        if (b.status !== 'cancelled') counts[b.session_id] = (counts[b.session_id] ?? 0) + 1;
      });
    }
    setSessions(rows.map((s) => ({ ...s, booked: counts[s.id] ?? 0 })));
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
    setSavingSess(true);
    setSessError(null);
    const durationMins = Math.max(15, Number(sessForm.duration) || 45);
    const weeks = Math.min(12, Math.max(1, Number(sessForm.repeat) || 1));
    // Times are entered as Singapore time (the platform's timezone), not the
    // browser's — pin the offset so a vendor travelling abroad still gets SGT.
    const first = new Date(`${sessForm.date}T${sessForm.time}:00+08:00`);
    const rows = Array.from({ length: weeks }).map((_, i) => {
      const starts = new Date(first.getTime() + i * 7 * 864e5);
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
        // Blank inherits the activity's venue/price (migration 00074).
        location_id: sessForm.location_id || null,
        // A Wix Event's price is Wix's — never override it per session.
        price: scheduleIsWixEvent || sessForm.price === '' ? null : Math.max(0, Number(sessForm.price)),
      };
    });
    // A Wix-connected vendor's real-world time is already spoken for by
    // anything on their Wix calendar — check every proposed slot (the
    // weekly-repeat loop can produce several) against everything Wix has
    // them committed to before saving any of them.
    if (provider?.wix_site_id) {
      try {
        const { ranges } = await apiGet<{ ranges: { start: string; end: string }[] }>(`/api/wix/busy?providerId=${provider.id}`);
        for (const row of rows) {
          const start = new Date(row.starts_at);
          const end = new Date(row.ends_at);
          const clash = ranges.find((r) => rangesOverlap(start, end, new Date(r.start), new Date(r.end)));
          if (clash) {
            setSavingSess(false);
            setSessError(
              `That clashes with something already on your Wix calendar (${fmtDateTime(clash.start)}–${new Date(clash.end).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' })}). Pick a different time, or update it in Wix first.`
            );
            return;
          }
        }
      } catch {
        setSavingSess(false);
        setSessError("Couldn't check your Wix calendar for clashes — try again in a moment.");
        return;
      }
    }

    const { error } = await supabase.from('activity_sessions').insert(rows);
    setSavingSess(false);
    if (error) {
      setSessError(error.message);
      return;
    }
    setSessForm({ date: '', time: '', duration: sessForm.duration, capacity: sessForm.capacity, repeat: '1', teacher: sessForm.teacher, studio: sessForm.studio, location_id: sessForm.location_id, price: sessForm.price });
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
    setSessEditForm({
      date: `${sgt.getFullYear()}-${pad(sgt.getMonth() + 1)}-${pad(sgt.getDate())}`,
      time: `${pad(sgt.getHours())}:${pad(sgt.getMinutes())}`,
      duration: String(Math.round((new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000) || 45),
      capacity: s.capacity != null ? String(s.capacity) : '',
      teacher: s.teacher_name ?? '',
      studio: s.studio ?? '',
      location_id: s.location_id ?? '',
      price: s.price != null ? String(s.price) : '',
    });
  }

  async function saveSessEdit(id: string) {
    if (!scheduleFor) return;
    setSessEditError(null);
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
      setSessEditError(`This session already has ${booked} booking${booked > 1 ? 's' : ''} — capacity can't be lower than that.`);
      return;
    }
    const durationMins = Math.max(15, Number(sessEditForm.duration) || 45);
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
      location_id: sessEditForm.location_id || null,
      // A Wix Event's price is Wix's — never override it per session.
      price: scheduleIsWixEvent || sessEditForm.price === '' ? null : Math.max(0, Number(sessEditForm.price)),
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

  async function removeSession(s: Sess) {
    if (!scheduleFor) return;
    const warn = s.booked > 0
      ? `This session has ${s.booked} booking${s.booked > 1 ? 's' : ''}. Deleting it removes those bookings too. Continue?`
      : 'Remove this session?';
    if (!window.confirm(warn)) return;
    await supabase.from('activity_sessions').delete().eq('id', s.id);
    await loadSessions(scheduleFor.id);
    load();
  }

  async function load() {
    if (!provider) return;
    setLoading(true);
    const [{ data: acts }, { data: cats }, { data: locs }] = await Promise.all([
      supabase.from('activities').select('*').eq('provider_id', provider.id).order('updated_at', { ascending: false }),
      supabase.from('activity_categories').select('*').order('sort_order'),
      supabase.from('provider_locations').select('id, name, address, postal_code, latitude, longitude').eq('provider_id', provider.id).order('is_primary', { ascending: false }),
    ]);
    setActivities(acts ?? []);
    setCategories(cats ?? []);
    setLocations((locs ?? []) as { id: string; name: string; address: string | null; postal_code: string | null; latitude: number | null; longitude: number | null }[]);

    // Upcoming session counts + total booking counts per activity.
    const ids = (acts ?? []).map((a) => a.id);
    if (ids.length) {
      const [{ data: sess }, { data: allSess }] = await Promise.all([
        supabase.from('activity_sessions').select('activity_id').in('activity_id', ids).gte('starts_at', new Date().toISOString()),
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
    } else {
      setSessionCounts({});
      setBookingTotals({});
    }
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
  async function syncServices() {
    if (!provider) return;
    setSyncing(true);
    setSyncError(null);
    setSyncNotice(null);
    try {
      const [servicesRes, eventsRes] = await Promise.all([
        apiPost<{ sync: { created: number; updated: number; skipped: { name: string; reason: string }[]; removed: number; revived: number } }>(
          '/api/vendor/wix-services-sync',
          { provider_id: provider.id }
        ),
        apiPost<{ sync: { created: number; updated: number; removed: number; revived: number; ticketPricingSkipped: string[]; eventsAppNotInstalled: boolean } }>(
          '/api/vendor/wix-events-sync',
          { provider_id: provider.id }
        ),
      ]);
      const created = servicesRes.sync.created + eventsRes.sync.created;
      const updated = servicesRes.sync.updated + eventsRes.sync.updated;
      const revived = servicesRes.sync.revived + eventsRes.sync.revived;
      const removed = servicesRes.sync.removed + eventsRes.sync.removed;
      const parts = [];
      if (created) parts.push(`${created} new`);
      if (updated) parts.push(`${updated} updated`);
      if (revived) parts.push(`${revived} restored`);
      if (removed) parts.push(`${removed} removed`);
      setSyncNotice(`Synced from Wix: ${parts.length ? parts.join(', ') : 'nothing new'}.`);
      await load();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Could not sync services');
    } finally {
      setSyncing(false);
      window.setTimeout(() => { setSyncNotice(null); setSyncError(null); }, 5000);
    }
  }

  // Activities removed from the Wix import picker stay around (unpublished)
  // only until their last booked upcoming session is over — the unbooked
  // future sessions were already deleted at removal time, so once
  // sessionCounts hits 0 the only thing left for it is past history.
  const isFullyRemoved = (a: Activity) => !!a.wix_removed_at && (sessionCounts[a.id] ?? 0) === 0;

  const visible = useMemo(() => {
    let list = activities
      .filter((a) => !isFullyRemoved(a))
      .filter((a) => a.title.toLowerCase().includes(search.toLowerCase()));
    if (fStatus) {
      list = list.filter((a) => {
        const s = a.wix_missing_since ? 'Removed' : a.archived_at ? 'Archived' : a.is_published ? 'Live' : 'Draft';
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

  // Reads left to right as the life of an activity: live → still a draft →
  // actually on the calendar → the venues it all runs at.
  const stats = [
    { icon: CalendarCheck, label: 'Active activities', value: String(activities.filter((a) => a.is_published && !a.archived_at).length), sub: 'Live and published', color: 'text-pink-600', bg: 'bg-pink-100' },
    { icon: CalendarDays, label: 'Draft activities', value: String(activities.filter((a) => !a.is_published && !isFullyRemoved(a) && !a.wix_missing_since).length), sub: 'Not published yet', color: 'text-yellow-600', bg: 'bg-yellow-100' },
    // "Scheduled" = has at least one session still in the future, which is the
    // same count the Sessions column shows per row.
    { icon: CalendarClock, label: 'Activities scheduled', value: String(activities.filter((a) => !a.archived_at && !isFullyRemoved(a) && (sessionCounts[a.id] ?? 0) > 0).length), sub: 'With upcoming sessions', color: 'text-purple-600', bg: 'bg-purple-100' },
    { icon: MapPin, label: 'Locations', value: String(locations.length), sub: 'Venues added', color: 'text-blue-600', bg: 'bg-blue-100' },
  ];

  async function archive(id: string) {
    await supabase.from('activities').update({ archived_at: new Date().toISOString(), is_published: false }).eq('id', id);
    setShowMenu(null);
    load();
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
    setShowDrawer(true);
  }

  function openEdit(a: Activity) {
    setShowMenu(null);
    setEditingId(a.id);
    setForm({
      title: a.title,
      category_id: String(a.category_id ?? ''),
      vendor_category: (a.vendor_category ?? '') as VendorCategory | '',
      description: a.description ?? '',
      age_min_months: String(a.age_min_months ?? ''),
      age_max_months: String(a.age_max_months ?? ''),
      price: a.price != null ? String(a.price) : '',
      location_id: a.location_id ?? '',
      default_capacity: a.default_capacity != null ? String(a.default_capacity) : '',
      image_url: a.image_urls?.[0] ?? '',
      requires_medical_disclosure: a.requires_medical_disclosure ?? true,
      allow_cancellation: a.allow_cancellation ?? true,
      allow_rescheduling: a.allow_rescheduling ?? true,
      cancellation_cutoff_hours: String(a.cancellation_cutoff_hours ?? 24),
      reschedule_cutoff_hours: String(a.reschedule_cutoff_hours ?? 24),
      booking_cutoff_minutes: String(a.booking_cutoff_minutes ?? 15),
      info_request_enabled: a.info_request_enabled ?? false,
      info_request_prompt: a.info_request_prompt ?? '',
      what_to_bring: a.what_to_bring ?? '',
      confirmation_message: a.confirmation_message ?? '',
    });
    setPriceOverridden((a.wix_locked_fields ?? []).includes('price'));
    setFormError(null);
    setShowDrawer(true);
  }

  // 1.1: pause/resume parent bookings for one activity.
  async function togglePause(a: Activity) {
    await supabase.from('activities').update({ bookings_paused: !a.bookings_paused }).eq('id', a.id);
    setShowMenu(null);
    load();
  }

  async function uploadImage(file: File) {
    if (!provider) return;
    setUploading(true);
    setFormError(null);
    const path = `${provider.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]+/g, '_')}`;
    const { error } = await supabase.storage.from('activity-images').upload(path, file, { upsert: true });
    setUploading(false);
    if (error) { setFormError(`Image upload failed: ${error.message}`); return; }
    const { data } = supabase.storage.from('activity-images').getPublicUrl(path);
    setForm((f) => ({ ...f, image_url: data.publicUrl }));
  }

  async function saveActivity() {
    if (!provider) return;
    if (!form.title || !form.category_id) { setFormError('Name and category are required.'); return; }
    // Capacity comes from Wix for a linked activity (and is null for an
    // APPOINTMENT service, which is 1:1 by definition) — the field isn't shown
    // and isn't written, so demanding one here would be a dead end on a form
    // with nothing to fix.
    if (!isWixLinked && (!form.default_capacity || Number(form.default_capacity) < 1)) {
      setFormError('Set a capacity for this activity.');
      return;
    }
    setSaving(true);
    setFormError(null);
    // The activity's address/postal_code/lat/lng are denormalized from its
    // location so the parent app can show "where to go" without an extra
    // join — keep them in sync with whichever location the vendor picks.
    const loc = locations.find((l) => l.id === form.location_id);
    const fields = {
      title: form.title,
      description: form.description,
      category_id: Number(form.category_id),
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
              ...(editingActivity?.wix_locked_fields ?? []).filter((x) => x !== 'price'),
              ...(priceOverridable && priceOverridden ? ['price'] : []),
            ],
            ...(priceOverridable && priceOverridden
              ? { price: form.price ? Number(form.price) : null }
              : {}),
          }
        : {
            price: form.price ? Number(form.price) : null,
            location_id: form.location_id || null,
            default_capacity: Number(form.default_capacity),
            address: loc?.address ?? null,
            postal_code: loc?.postal_code ?? null,
            latitude: loc?.latitude ?? null,
            longitude: loc?.longitude ?? null,
          }),
      image_urls: form.image_url ? [form.image_url] : [],
      requires_medical_disclosure: form.requires_medical_disclosure,
      allow_cancellation: form.allow_cancellation,
      allow_rescheduling: form.allow_rescheduling,
      cancellation_cutoff_hours: Math.max(0, Number(form.cancellation_cutoff_hours) || 24),
      reschedule_cutoff_hours: Math.max(0, Number(form.reschedule_cutoff_hours) || 24),
      // 0 is meaningful here ("right up to the start time"), so an empty box
      // falls back to 15 rather than being coerced to 0 by `|| 15`.
      booking_cutoff_minutes: form.booking_cutoff_minutes === ''
        ? 15
        : Math.max(0, Math.min(20160, Number(form.booking_cutoff_minutes))),
      info_request_enabled: form.info_request_enabled,
      info_request_prompt: form.info_request_enabled ? (form.info_request_prompt.trim() || null) : null,
      what_to_bring: form.what_to_bring.trim() || null,
      confirmation_message: form.confirmation_message.trim() || null,
    };
    const { error } = editingId
      ? await supabase.from('activities').update(fields).eq('id', editingId)
      : await supabase.from('activities').insert({
          ...fields,
          slug: `${form.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`,
          provider_id: provider.id,
          is_published: false, // saved as draft; publish from the row menu
        });
    setSaving(false);
    if (error) { setFormError(error.message); return; }
    setShowDrawer(false);
    setEditingId(null);
    setForm(emptyForm);
    load();
  }

  async function togglePublish(a: Activity) {
    // Locked while Wix has lost track of this service (wrong/changed
    // account, or deleted on Wix) — reconnecting the right account, or the
    // service reappearing, is what clears this on the next sync.
    if (a.wix_missing_since) return;
    await supabase.from('activities').update({ is_published: !a.is_published, archived_at: null }).eq('id', a.id);
    setShowMenu(null);
    load();
  }

  const inputCls = 'w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-pink-300';
  const [showFilters, setShowFilters] = useState(true);
  const activeFilterCount = [fStatus, fLocation, fAge, fActivity].filter(Boolean).length;
  const filterCls = 'px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-pink-300';
  // Mobile: full-width selects with centred text and a custom chevron held
  // a little off the right edge (the native one sits flush). Reverts to the
  // OS control from sm up.
  const filterMobileCls =
    "w-full max-w-xs text-center appearance-none bg-no-repeat bg-[length:14px] bg-[right_0.9rem_center] pl-9 pr-9 " +
    "bg-[url(\"data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='14'%20height='14'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='%239ca3af'%20stroke-width='2.5'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='m6%209%206%206%206-6'/%3E%3C/svg%3E\")] " +
    "sm:w-auto sm:max-w-none sm:text-left sm:appearance-auto sm:bg-none sm:pl-3 sm:pr-3";

  return (
    <div className="relative">
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
            {/* Two sections now: the activities themselves and the venues they
                run at. Centred on a phone, where it sits above the toolbar. */}
            <div className="flex justify-center gap-6 sm:justify-start">
              {(['activities', 'locations'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setPageTab(t);
                    const next = new URLSearchParams(searchParams);
                    if (t === 'locations') next.set('tab', 'locations');
                    else { next.delete('tab'); next.delete('new'); }
                    setSearchParams(next, { replace: true });
                  }}
                  className={cn(
                    'text-sm font-medium pb-2 border-b-2 capitalize',
                    pageTab === t ? 'text-[#FA4D8D] border-[#C90044]' : 'text-gray-500 border-transparent hover:text-gray-700'
                  )}
                >
                  {t === 'locations' ? `Locations (${locations.length})` : 'Activities'}
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
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className={cn(filterCls, filterMobileCls)}>
              <option value="">All statuses</option>
              {['Live', 'Draft', 'Archived', 'Removed'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={fLocation} onChange={(e) => setFLocation(e.target.value)} className={cn(filterCls, filterMobileCls)}>
              <option value="">All locations</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <select value={fAge} onChange={(e) => setFAge(e.target.value)} className={cn(filterCls, filterMobileCls)}>
              <option value="">All age groups</option>
              <option value="0-18">0 – 18 months</option>
              <option value="18-36">18m – 3 years</option>
              <option value="36-60">3 – 5 years</option>
              <option value="60-216">5+ years</option>
            </select>
            <select value={fActivity} onChange={(e) => setFActivity(e.target.value)} className={cn(filterCls, filterMobileCls)}>
              <option value="">All activities</option>
              {activities
                .filter((a) => !isFullyRemoved(a))
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((a) => <option key={a.id} value={String(a.id)}>{a.title}</option>)}
            </select>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} className={cn(filterCls, filterMobileCls, 'sm:ml-auto')}>
              <option value="updated">Sort by: Recently updated</option>
              <option value="name">Sort by: Name</option>
              <option value="rating">Sort by: Rating</option>
            </select>
          </div>
          )}

          {pageTab === 'locations' ? (
            <div className="p-5">
              <LocationsManager
                provider={provider}
                canManage={canManage}
                openOnMount={openNewLocation}
                onOpened={() => setOpenNewLocation(false)}
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
            const status = a.wix_missing_since ? 'Removed' : a.archived_at ? 'Archived' : a.is_published ? 'Live' : 'Draft';
            return (
              <div
                key={a.id}
                className={cn(TABLE_COLS, 'px-5 py-4 border-t border-gray-100 items-center hover:bg-gray-50 transition-colors')}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <img src={a.image_urls?.[0] || fallbackImage(a)} alt={a.title} className="w-12 h-12 flex-shrink-0 rounded-lg object-cover" />
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900 text-sm break-words">{a.title}</div>
                    <div className="text-xs text-gray-500 break-words">{a.vendor_category ?? ''}</div>
                  </div>
                </div>
                <div className="min-w-0 text-sm text-gray-700 break-words">{categoryName(a.category_id)}</div>
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
                  )} title={status === 'Removed' ? "Not found on the currently connected Wix account — reconnect the right account, or re-add this service, to restore it." : undefined}>
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
                    isn't room below, and closes on outside click / Escape —
                    the old one only closed by hitting the same three dots. */}
                <div className="flex justify-end">
                  <DropdownMenu
                    open={showMenu === a.id}
                    onOpenChange={(open) => setShowMenu(open ? a.id : null)}
                  >
                    <DropdownMenuTrigger asChild>
                      <button className="p-1.5 hover:bg-gray-100 rounded-lg">
                        <MoreVertical className="w-4 h-4 text-gray-400" />
                      </button>
                    </DropdownMenuTrigger>
                    {canManage && (
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
                        <DropdownMenuItem onSelect={() => openEdit(a)} className="gap-2 px-3 py-2 text-sm text-gray-700">
                          <Pencil className="w-3.5 h-3.5" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openSchedule(a)} className="gap-2 px-3 py-2 text-sm text-gray-700">
                          <Clock className="w-3.5 h-3.5" />
                          Manage schedule
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => togglePublish(a)}
                          disabled={!!a.wix_missing_since}
                          title={a.wix_missing_since ? 'Locked until this service is found again on a connected Wix account' : undefined}
                          className="gap-2 px-3 py-2 text-sm text-gray-700"
                        >
                          <CalendarCheck className="w-3.5 h-3.5" />
                          {a.is_published ? 'Unpublish' : 'Publish'}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => togglePause(a)} className="gap-2 px-3 py-2 text-sm text-gray-700">
                          {a.bookings_paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                          {a.bookings_paused ? 'Resume bookings' : 'Pause bookings'}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => archive(a.id)} className="gap-2 px-3 py-2 text-sm text-gray-700">
                          <Trash2 className="w-3.5 h-3.5" />
                          Archive
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    )}
                  </DropdownMenu>
                </div>
              </div>
            );
          })}
          </div>

          <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200">
            <span className="text-sm text-gray-500">Showing {visible.length} of {activities.length} activities</span>
          </div>
          </>
          )}
        </div>

      </div>

      {/* Create Activity Drawer */}
      {showDrawer && (
        <div className="fixed top-0 right-0 w-full max-w-[28rem] h-full bg-white shadow-2xl border-l border-gray-200 z-50 flex flex-col">
          <div className="flex items-center justify-between p-5 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">{editingId ? 'Edit activity' : 'Create activity'}</h3>
            <button onClick={() => setShowDrawer(false)} className="p-1.5 hover:bg-gray-100 rounded-lg">
              <X className="w-4 h-4 text-gray-600" />
            </button>
          </div>

          <div className="flex-1 overflow-auto p-5 space-y-5">
            {formError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div>}

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

            {isWixLinked && (
              <div className="border-t border-gray-100 pt-4 text-sm font-semibold text-gray-900">Your BabyBrain details</div>
            )}
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Name <span className="text-[#FA4D8D]">*</span></label>
              <input type="text" placeholder="e.g. Music Explorers" className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Category <span className="text-[#FA4D8D]">*</span></label>
              <select className={inputCls} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
                <option value="">Select category</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Description</label>
              <textarea placeholder="Describe this activity..." rows={3} maxLength={500} className={cn(inputCls, 'resize-none')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              <div className="text-right text-xs text-gray-400 mt-1">{form.description.length}/500</div>
            </div>
            {priceOverridable && (
              <div>
                <label className="text-sm font-medium text-gray-900 mb-1.5 block">Price (SGD per session)</label>
                {priceOverridden ? (
                  <>
                    <input
                      type="number"
                      min="0"
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
                    <input
                      type="number"
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
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Age range (months)</label>
              <div className="flex items-center gap-3">
                <input type="number" min="0" placeholder="Min" className={inputCls} value={form.age_min_months} onChange={(e) => setForm({ ...form, age_min_months: e.target.value })} />
                <span className="text-gray-400">—</span>
                <input type="number" min="0" placeholder="Max" className={inputCls} value={form.age_max_months} onChange={(e) => setForm({ ...form, age_max_months: e.target.value })} />
              </div>
            </div>
            {!isWixLinked && (
              <>
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Location</label>
              <select className={inputCls} value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
                <option value="">Select a location</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              {locations.length === 0 ? (
                <p className="mt-1 text-xs text-gray-500">No locations yet — add one on the <button className="text-[#FA4D8D] font-medium hover:underline" onClick={() => { setPageTab('locations'); setOpenNewLocation(true); setShowDrawer(false); }}>Locations tab</button>.</p>
              ) : (
                /* QA 21/08: "if they do the same class in 3 different locations
                   they need to create it 3 times." Both this and the price below
                   are now the DEFAULT for new sessions — Manage schedule can
                   override either per session, so one activity covers every
                   venue and price. */
                <p className="mt-1 text-xs text-gray-500">Default venue. Any session can be moved to another one under Manage schedule.</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Price (SGD per session)</label>
              <input
                type="number"
                min="0"
                placeholder="e.g. 45"
                className={inputCls}
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
              <p className="mt-1 text-xs text-gray-500">Default price. Individual sessions can be priced differently under Manage schedule.</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Capacity <span className="text-[#FA4D8D]">*</span></label>
              <input type="number" min="1" required placeholder="e.g. 12" className={inputCls} value={form.default_capacity} onChange={(e) => setForm({ ...form, default_capacity: e.target.value })} />
              <p className="mt-1 text-xs text-gray-500">Pre-fills the capacity when you add new sessions for this activity.</p>
            </div>
              </>
            )}
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Activity image</label>
              <label className={cn(
                'flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-gray-200 px-4 py-6 cursor-pointer hover:border-pink-300 transition-colors',
                uploading && 'opacity-60 pointer-events-none'
              )}>
                {form.image_url ? (
                  <img src={form.image_url} alt="Activity" className="h-24 w-full rounded-lg object-cover" />
                ) : (
                  <>
                    <ImageUp className="w-6 h-6 text-[#FA4D8D]" />
                    <span className="text-sm font-medium text-[#FA4D8D]">{uploading ? 'Uploading…' : 'Upload image'}</span>
                    <span className="text-xs text-gray-500">PNG, JPG up to 5MB</span>
                  </>
                )}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (f.size > 5 * 1024 * 1024) { setFormError('Image must be under 5MB.'); return; }
                    uploadImage(f);
                  }}
                />
              </label>
              {form.image_url && (
                <button onClick={() => setForm({ ...form, image_url: '' })} className="mt-1.5 text-xs text-gray-500 hover:text-red-600">Remove image</button>
              )}
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-gray-900">Require medical disclosure</div>
                <div className="text-xs text-gray-500">
                  Parents must fill in a health declaration before this activity can be booked. For your own
                  waivers and consents, use Settings → Waivers &amp; Consents.
                </div>
              </div>
              <Switch checked={form.requires_medical_disclosure} onCheckedChange={(v) => setForm({ ...form, requires_medical_disclosure: v })} className="data-[state=checked]:bg-[#C90044]" />
            </div>

            {/* 2.2: cancellation & rescheduling policy for this class */}
            <div className="rounded-xl border border-gray-200 p-4 space-y-4">
              <div className="text-sm font-semibold text-gray-900">Booking policies</div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-900">Allow cancellations</div>
                  <div className="text-xs text-gray-500">Parents can cancel their booking themselves</div>
                </div>
                <Switch checked={form.allow_cancellation} onCheckedChange={(v) => setForm({ ...form, allow_cancellation: v })} className="data-[state=checked]:bg-[#C90044]" />
              </div>
              {form.allow_cancellation && (
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Cancellation cut-off (hours before session)</label>
                  <input type="number" min="0" className={inputCls} value={form.cancellation_cutoff_hours} onChange={(e) => setForm({ ...form, cancellation_cutoff_hours: e.target.value })} />
                </div>
              )}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-900">Allow rescheduling</div>
                  <div className="text-xs text-gray-500">Parents can move their booking to another session</div>
                </div>
                <Switch checked={form.allow_rescheduling} onCheckedChange={(v) => setForm({ ...form, allow_rescheduling: v })} className="data-[state=checked]:bg-[#C90044]" />
              </div>
              {form.allow_rescheduling && (
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Rescheduling cut-off (hours before session)</label>
                  <input type="number" min="0" className={inputCls} value={form.reschedule_cutoff_hours} onChange={(e) => setForm({ ...form, reschedule_cutoff_hours: e.target.value })} />
                </div>
              )}

              {/* QA 21/08: "parents can currently make bookings up until a
                  minute before the class." 15 minutes is the default the
                  founder asked for; a vendor who needs longer to set up sets
                  their own. Enforced in the database, so it holds regardless
                  of what the parent app does. */}
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Booking cut-off (minutes before session)</label>
                <input
                  type="number"
                  min="0"
                  max="20160"
                  className={inputCls}
                  value={form.booking_cutoff_minutes}
                  onChange={(e) => setForm({ ...form, booking_cutoff_minutes: e.target.value })}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {form.booking_cutoff_minutes === '0'
                    ? 'Parents can book right up to the start time.'
                    : `Parents can't book within ${form.booking_cutoff_minutes || '15'} minutes of the class starting.`}
                </p>
              </div>
            </div>

            {/* Bespoke information request (QA 21/08) */}
            <div className="space-y-4 pt-2 border-t border-gray-100">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-900">Ask parents for extra information</div>
                  <div className="text-xs text-gray-500">For anything you need before the class — e.g. an address when you host at their condo</div>
                </div>
                <Switch checked={form.info_request_enabled} onCheckedChange={(v) => setForm({ ...form, info_request_enabled: v })} className="data-[state=checked]:bg-[#C90044]" />
              </div>
              {form.info_request_enabled && (
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">What are you asking for?</label>
                  <textarea
                    rows={2}
                    maxLength={300}
                    placeholder="e.g. Which condo is the class at, and the unit number?"
                    className={cn(inputCls, 'resize-none')}
                    value={form.info_request_prompt}
                    onChange={(e) => setForm({ ...form, info_request_prompt: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-gray-500">Parents can't book this activity without answering. You'll see the answer on the booking.</p>
                </div>
              )}
            </div>

            {/* What parents see after booking (QA 24/08 + 28/08) */}
            <div className="space-y-4 pt-2 border-t border-gray-100">
              <div>
                <label className="text-sm font-medium text-gray-900 mb-1.5 block">What to bring &amp; know</label>
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
                <label className="text-sm font-medium text-gray-900 mb-1.5 block">Booking confirmation note</label>
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
          </div>

          <div className="p-5 border-t border-gray-200 flex gap-3">
            <Button variant="outline" onClick={() => setShowDrawer(false)} className="flex-1 rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50">Cancel</Button>
            <Button onClick={saveActivity} disabled={saving} className="flex-1 gradient-primary text-white rounded-xl hover:opacity-90">
              {saving ? 'Saving…' : 'Save activity'}
            </Button>
          </div>
        </div>
      )}

      {/* Parent-view preview. Deliberately a copy of the parent activity page
          (frontends/parent App.tsx) rather than a vendor-styled summary — the
          point is to show exactly what a family sees, so the palette, radii
          and Nunito face are the parent app's, not this one's. Everything is
          inert; the sessions and reviews blocks are left out. */}
      {previewFor && (
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
                  <h3 className="text-sm font-bold text-[#111A4C]">Parent view</h3>
                  <p className="text-xs text-gray-500">How this looks to families on BabyBrain.sg</p>
                </div>
              </div>
              <button onClick={() => setPreviewFor(null)} aria-label="Close preview" className="rounded-lg p-1.5 hover:bg-gray-100">
                <X className="h-4 w-4 text-gray-500" />
              </button>
            </div>

            {/* pointer-events-none: nothing in the preview is clickable. */}
            {/* The scroller keeps its pointer events — putting them on this
                element made it transparent to the wheel, so a long description
                or address could not be reached. The inert layer is inside it. */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="pointer-events-none select-none p-5 text-[#111A4C]">
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
                        <span className="mt-4 inline-flex w-fit items-center gap-1 rounded-[9px] bg-[#FEEBF2] px-4 py-1.5 font-bold text-[#FA4D8D]">
                          <Music className="h-4 w-4" /> {categoryName(previewFor.category_id)}
                        </span>
                      </div>
                    </div>
                    <div className="relative">
                      <img
                        src={previewFor.image_urls?.[0] || fallbackImage(previewFor)}
                        alt={previewFor.title}
                        className="h-[240px] w-full rounded-[18px] object-cover lg:h-[305px]"
                      />
                      <span className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-[10px] bg-white/95 px-3 py-2 text-[13px] font-bold text-[#111A4C] shadow">
                        <ExternalLink className="h-3.5 w-3.5" /> View photo
                      </span>
                    </div>
                  </div>

                  {previewFor.description && (
                    <section className="rounded-[16px] border border-[#EBE3E5] bg-white p-5">
                      <h2 className="mb-3 text-xl font-black">About</h2>
                      <p className="font-semibold text-[#34406f]">{previewFor.description}</p>
                    </section>
                  )}
                </div>

                <aside className="h-fit rounded-[18px] border border-[#EBE3E5] bg-white p-5">
                  {previewFor.price != null && Number(previewFor.price) > 0 ? (
                    <p><strong className="text-[30px] text-[#C7B1E6]">${Number(previewFor.price)}</strong> <span className="font-bold">/ class</span></p>
                  ) : (
                    <p><strong className="text-[30px] text-[#C7B1E6]">Free</strong></p>
                  )}

                  <span className="mt-4 flex w-full items-center justify-center gap-2 rounded-[11px] bg-gradient-to-r from-[#fa4d8d] to-[#ff6b9b] px-6 py-3 text-[15px] font-extrabold text-white" style={{ boxShadow: '0 8px 20px rgba(250,93,147,.32)' }}>
                    <CalendarDays className="h-4 w-4" /> Book a class
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
                    <Users className="h-4 w-4" /> Class group chat
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
            </div>

            <div className="border-t border-[#EBE3E5] bg-white px-5 py-2.5 text-center text-xs text-gray-500">
              Preview only — nothing here is clickable.
            </div>
          </div>
        </div>
      )}

      {/* Schedule Drawer — the bookable dates/times for one activity */}
      {scheduleFor && (
        <div className="fixed top-0 right-0 w-full max-w-[28rem] h-full bg-white shadow-2xl border-l border-gray-200 z-50 flex flex-col">
          <div className="flex items-center justify-between p-5 border-b border-gray-200">
            <div>
              <h3 className="font-semibold text-gray-900">Schedule</h3>
              <p className="text-xs text-gray-500 mt-0.5">{scheduleFor.title}</p>
            </div>
            <button onClick={() => setScheduleFor(null)} className="p-1.5 hover:bg-gray-100 rounded-lg">
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
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
            {!scheduleIsWix && (
            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-2">Add sessions</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Date</label>
                  <input type="date" className={inputCls} value={sessForm.date} onChange={(e) => setSessForm({ ...sessForm, date: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Start time</label>
                  <input type="time" className={inputCls} value={sessForm.time} onChange={(e) => setSessForm({ ...sessForm, time: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Duration (mins)</label>
                  <input type="number" min="15" step="15" className={inputCls} value={sessForm.duration} onChange={(e) => setSessForm({ ...sessForm, duration: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Capacity *</label>
                  <input type="number" min="1" required placeholder="e.g. 12" className={inputCls} value={sessForm.capacity} onChange={(e) => setSessForm({ ...sessForm, capacity: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Teacher (leave blank if N/A)</label>
                  <input placeholder="e.g. Ms Sarah" className={inputCls} value={sessForm.teacher} onChange={(e) => setSessForm({ ...sessForm, teacher: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Studio / room (leave blank if N/A)</label>
                  <input placeholder="e.g. Room 2" className={inputCls} value={sessForm.studio} onChange={(e) => setSessForm({ ...sessForm, studio: e.target.value })} />
                </div>
                {/* Venue and price per session (QA 21/08) — this is what lets one
                    activity run at three locations, or cost different amounts at
                    each, instead of being created three times. */}
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Venue</label>
                  <select className={inputCls} value={sessForm.location_id} onChange={(e) => setSessForm({ ...sessForm, location_id: e.target.value })}>
                    <option value="">Same as the activity</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Price (SGD)</label>
                  <input
                    type="number"
                    min="0"
                    placeholder={
                      scheduleIsWixEvent
                        ? 'Set by Wix ticket types'
                        : scheduleFor?.price != null ? `Activity price: ${scheduleFor.price}` : 'Same as the activity'
                    }
                    className={cn(inputCls, scheduleIsWixEvent && 'bg-gray-50 text-gray-500 cursor-not-allowed')}
                    value={scheduleIsWixEvent ? '' : sessForm.price}
                    onChange={(e) => setSessForm({ ...sessForm, price: e.target.value })}
                    disabled={scheduleIsWixEvent}
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Repeat weekly</label>
                  <select className={inputCls} value={sessForm.repeat} onChange={(e) => setSessForm({ ...sessForm, repeat: e.target.value })}>
                    {[1, 2, 4, 6, 8, 12].map((n) => (
                      <option key={n} value={n}>{n === 1 ? 'Just this session' : `${n} weeks (same day & time)`}</option>
                    ))}
                  </select>
                </div>
              </div>
              {sessError && <p className="mt-2 text-xs font-medium text-red-600">{sessError}</p>}
              <Button onClick={addSessions} disabled={savingSess} className="mt-3 w-full gradient-primary text-white rounded-xl hover:opacity-90">
                {savingSess ? 'Adding…' : 'Add to schedule'}
              </Button>
            </div>
            )}

            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-2">Upcoming sessions ({sessions.length})</h4>
              {sessions.length === 0 && (
                <p className="text-sm text-gray-400">No upcoming sessions — parents can't book this activity until you add some.</p>
              )}
              <div className="space-y-2">
                {sessions.map((s) => (
                  editingSessId === s.id ? (
                    <div key={s.id} className="rounded-lg border border-pink-300 bg-pink-50/30 px-3 py-2.5 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Date</span>
                          <input type="date" className={inputCls} value={sessEditForm.date} onChange={(e) => setSessEditForm({ ...sessEditForm, date: e.target.value })} />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Start time (SGT)</span>
                          <input type="time" className={inputCls} value={sessEditForm.time} onChange={(e) => setSessEditForm({ ...sessEditForm, time: e.target.value })} />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Duration (mins)</span>
                          <input type="number" min="15" step="5" className={inputCls} value={sessEditForm.duration} onChange={(e) => setSessEditForm({ ...sessEditForm, duration: e.target.value })} />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Capacity</span>
                          <input type="number" min="1" className={inputCls} value={sessEditForm.capacity} onChange={(e) => setSessEditForm({ ...sessEditForm, capacity: e.target.value })} />
                        </label>
                        <input placeholder="Teacher (N/A if blank)" className={inputCls} value={sessEditForm.teacher} onChange={(e) => setSessEditForm({ ...sessEditForm, teacher: e.target.value })} />
                        <input placeholder="Studio (N/A if blank)" className={inputCls} value={sessEditForm.studio} onChange={(e) => setSessEditForm({ ...sessEditForm, studio: e.target.value })} />
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Venue</span>
                          <select className={inputCls} value={sessEditForm.location_id} onChange={(e) => setSessEditForm({ ...sessEditForm, location_id: e.target.value })}>
                            <option value="">Same as the activity</option>
                            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                          </select>
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500">Price (SGD)</span>
                          <input
                            type="number"
                            min="0"
                            placeholder={
                              scheduleIsWixEvent
                                ? 'Set by Wix ticket types'
                                : scheduleFor?.price != null ? `Activity price: ${scheduleFor.price}` : 'Same as the activity'
                            }
                            className={cn(inputCls, scheduleIsWixEvent && 'bg-gray-50 text-gray-500 cursor-not-allowed')}
                            value={scheduleIsWixEvent ? '' : sessEditForm.price}
                            onChange={(e) => setSessEditForm({ ...sessEditForm, price: e.target.value })}
                            disabled={scheduleIsWixEvent}
                          />
                        </label>
                      </div>
                      {sessEditError && <p className="text-xs font-medium text-red-600">{sessEditError}</p>}
                      {s.booked > 0 && (
                        <p className="text-xs text-gray-500">
                          {s.booked} family{s.booked > 1 ? ' families have' : ' has'} booked this session — moving it doesn't notify them automatically.
                        </p>
                      )}
                      <div className="flex gap-2">
                        <button onClick={() => saveSessEdit(s.id)} disabled={savingSessEdit} className="px-3 py-1.5 bg-[#C90044] text-white rounded-lg text-xs font-medium disabled:opacity-50">
                          {savingSessEdit ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => setEditingSessId(null)} className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-medium text-gray-700">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div key={s.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900">
                          {new Date(s.starts_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                        </div>
                        <div className="text-xs text-gray-500">
                          {Math.round((new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000)} mins
                          {' · '}{s.capacity != null ? `${s.capacity} spots` : 'Unlimited'}
                          {' · '}{s.booked} booked
                          {/* Only called out when it differs from the activity,
                              so the ordinary case stays quiet. */}
                          {s.location_id && s.location_id !== scheduleFor?.location_id && (
                            <>{' · '}<span className="text-blue-700">{locations.find((l) => l.id === s.location_id)?.name ?? 'Other venue'}</span></>
                          )}
                          {s.price != null && Number(s.price) !== Number(scheduleFor?.price ?? NaN) && (
                            <>{' · '}<span className="text-blue-700">{Number(s.price) === 0 ? 'Free' : `SGD ${s.price}`}</span></>
                          )}
                        </div>
                        {(s.teacher_name || s.studio) && (
                          <div className="text-xs text-purple-700 mt-0.5 truncate">
                            {[s.teacher_name, s.studio].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </div>
                      {scheduleIsWix ? (
                        <span className="flex-shrink-0 rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700">Wix</span>
                      ) : (
                        <div className="flex flex-shrink-0 items-center gap-1">
                          <button onClick={() => startEditSess(s)} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Edit teacher / studio">
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button onClick={() => removeSession(s)} className="p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600" title="Remove session">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  )
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
