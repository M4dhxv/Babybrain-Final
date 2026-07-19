import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarPlus,
  Package,
  MapPin,
  CalendarDays,
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import type { Activity, ActivityCategory, VendorCategory } from '@/lib/database.types';

const tabs = ['Activities', 'Packages', 'Locations'];

const ageLabel = (min: number, max: number) => {
  const f = (m: number) => (m < 24 ? `${m}m` : `${Math.round((m / 12) * 10) / 10}y`);
  return `${f(min)} – ${f(max)}`;
};
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });

const emptyForm = {
  title: '', category_id: '', vendor_category: '' as VendorCategory | '',
  description: '', age_min_months: '', age_max_months: '', price: '',
  location_id: '', image_url: '', requires_medical_disclosure: true,
  allow_cancellation: true, allow_rescheduling: true,
  cancellation_cutoff_hours: '24', reschedule_cutoff_hours: '24',
};

export default function ActivitiesPage() {
  const { provider, role } = useAuth();
  const canManage = role === 'owner' || role === 'manager';
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState('Activities');
  const [showDrawer, setShowDrawer] = useState(false);

  // "New Package" and the Packages tab both jump to the class-packs form below.
  function goToPackages() {
    if (!canManage) return;
    setActiveTab('Packages');
    requestAnimationFrame(() => {
      const el = document.getElementById('class-packs');
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el?.querySelector<HTMLInputElement>('input')?.focus();
    });
  }
  function onTab(tab: string) {
    if (tab === 'Locations') { navigate('/settings'); return; }
    if (tab === 'Packages') { goToPackages(); return; }
    setActiveTab(tab);
  }
  const [showMenu, setShowMenu] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [activities, setActivities] = useState<Activity[]>([]);
  const [categories, setCategories] = useState<ActivityCategory[]>([]);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({});
  const [bookingTotals, setBookingTotals] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  // Filter bar (mirrors the design: Status / Location / Age / Category / Sort)
  const [fStatus, setFStatus] = useState('');
  const [fLocation, setFLocation] = useState('');
  const [fAge, setFAge] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'name' | 'rating'>('updated');

  // Create/Edit-activity form (editingId set = editing an existing activity)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Schedule manager (sessions = the bookable dates/times of an activity)
  type Sess = { id: string; starts_at: string; ends_at: string; capacity: number | null; booked: number };
  const [scheduleFor, setScheduleFor] = useState<Activity | null>(null);
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [sessForm, setSessForm] = useState({ date: '', time: '', duration: '45', capacity: '', repeat: '1' });
  const [savingSess, setSavingSess] = useState(false);
  const [sessError, setSessError] = useState<string | null>(null);

  async function openSchedule(a: Activity) {
    setShowMenu(null);
    setScheduleFor(a);
    setSessError(null);
    await loadSessions(a.id);
  }

  async function loadSessions(activityId: string) {
    const { data: sess } = await supabase
      .from('activity_sessions')
      .select('id, starts_at, ends_at, capacity')
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
      };
    });
    const { error } = await supabase.from('activity_sessions').insert(rows);
    setSavingSess(false);
    if (error) {
      setSessError(error.message);
      return;
    }
    setSessForm({ date: '', time: '', duration: sessForm.duration, capacity: sessForm.capacity, repeat: '1' });
    await loadSessions(scheduleFor.id);
    load(); // refresh the upcoming counts in the table
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

  // Class packs (multi-session packages sold to parents)
  type Pack = {
    id: string; name: string; credits: number; price_cents: number; active: boolean;
    activity_id: string | null; validity_days: number | null;
    allowed_weekday: number | null; allowed_start_time: string | null;
  };
  const [packs, setPacks] = useState<Pack[]>([]);
  const [packForm, setPackForm] = useState({
    name: '', credits: '', price: '', validity_days: '',
    activity_id: '', allowed_weekday: '', allowed_start_time: '',
  });
  const [savingPack, setSavingPack] = useState(false);

  async function createPack() {
    if (!provider) return;
    const credits = Number(packForm.credits);
    const price = Number(packForm.price);
    if (!packForm.name.trim() || !credits || credits < 1) return;
    setSavingPack(true);
    await supabase.from('packages').insert({
      provider_id: provider.id,
      name: packForm.name.trim(),
      credits,
      price_cents: Math.round((price || 0) * 100),
      // 1.2: optional expiry window + restriction to one class / weekly slot
      validity_days: packForm.validity_days ? Number(packForm.validity_days) : null,
      activity_id: packForm.activity_id || null,
      allowed_weekday: packForm.allowed_weekday !== '' ? Number(packForm.allowed_weekday) : null,
      allowed_start_time: packForm.allowed_start_time || null,
    });
    setPackForm({ name: '', credits: '', price: '', validity_days: '', activity_id: '', allowed_weekday: '', allowed_start_time: '' });
    setSavingPack(false);
    load();
  }

  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const packRestriction = (p: Pack) => {
    const parts: string[] = [];
    if (p.activity_id) parts.push(activities.find((a) => a.id === p.activity_id)?.title ?? 'One class');
    if (p.allowed_weekday != null) {
      const t = p.allowed_start_time ? ` ${p.allowed_start_time.slice(0, 5)}` : '';
      parts.push(`${WEEKDAY_NAMES[p.allowed_weekday]}${t} only`);
    } else if (p.allowed_start_time) {
      parts.push(`${p.allowed_start_time.slice(0, 5)} slot only`);
    }
    if (p.validity_days) parts.push(`expires ${p.validity_days}d after purchase`);
    return parts.join(' · ');
  };
  async function togglePack(p: Pack) {
    await supabase.from('packages').update({ active: !p.active }).eq('id', p.id);
    load();
  }

  async function load() {
    if (!provider) return;
    setLoading(true);
    const [{ data: acts }, { data: cats }, { data: locs }, { data: pks }] = await Promise.all([
      supabase.from('activities').select('*').eq('provider_id', provider.id).order('updated_at', { ascending: false }),
      supabase.from('activity_categories').select('*').order('sort_order'),
      supabase.from('provider_locations').select('id, name').eq('provider_id', provider.id).order('is_primary', { ascending: false }),
      supabase.from('packages').select('id, name, credits, price_cents, active, activity_id, validity_days, allowed_weekday, allowed_start_time').eq('provider_id', provider.id).order('created_at', { ascending: false }),
    ]);
    setActivities(acts ?? []);
    setCategories(cats ?? []);
    setLocations((locs ?? []) as { id: string; name: string }[]);
    setPacks((pks ?? []) as Pack[]);

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

  const visible = useMemo(() => {
    let list = activities.filter((a) => a.title.toLowerCase().includes(search.toLowerCase()));
    if (fStatus) {
      list = list.filter((a) => {
        const s = a.archived_at ? 'Archived' : a.is_published ? 'Live' : 'Draft';
        return s === fStatus;
      });
    }
    if (fLocation) list = list.filter((a) => a.location_id === fLocation);
    if (fCategory) list = list.filter((a) => String(a.category_id) === fCategory);
    if (fAge) {
      const [lo, hi] = fAge.split('-').map(Number); // months
      list = list.filter((a) => a.age_min_months <= hi && a.age_max_months >= lo);
    }
    if (sortBy === 'name') list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (sortBy === 'rating') list = [...list].sort((a, b) => Number(b.rating_avg) - Number(a.rating_avg));
    return list;
  }, [activities, search, fStatus, fLocation, fCategory, fAge, sortBy]);
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

  const stats = [
    { icon: CalendarCheck, label: 'Active Activities', value: String(activities.filter((a) => a.is_published && !a.archived_at).length), sub: 'Live and published', color: 'text-pink-600', bg: 'bg-pink-100' },
    { icon: Package, label: 'Packages', value: String(packs.filter((p) => p.active).length), sub: 'Active packages', color: 'text-purple-600', bg: 'bg-purple-100' },
    { icon: MapPin, label: 'Locations', value: String(locations.length), sub: 'Venues added', color: 'text-blue-600', bg: 'bg-blue-100' },
    { icon: CalendarDays, label: 'Draft Activities', value: String(activities.filter((a) => !a.is_published).length), sub: 'Not published yet', color: 'text-yellow-600', bg: 'bg-yellow-100' },
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
      image_url: a.image_urls?.[0] ?? '',
      requires_medical_disclosure: a.requires_medical_disclosure ?? true,
      allow_cancellation: a.allow_cancellation ?? true,
      allow_rescheduling: a.allow_rescheduling ?? true,
      cancellation_cutoff_hours: String(a.cancellation_cutoff_hours ?? 24),
      reschedule_cutoff_hours: String(a.reschedule_cutoff_hours ?? 24),
    });
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
    setSaving(true);
    setFormError(null);
    const fields = {
      title: form.title,
      description: form.description,
      category_id: Number(form.category_id),
      vendor_category: (form.vendor_category || provider.vendor_category) as VendorCategory | undefined,
      age_min_months: form.age_min_months ? Number(form.age_min_months) : 0,
      age_max_months: form.age_max_months ? Number(form.age_max_months) : 216,
      price: form.price ? Number(form.price) : null,
      location_id: form.location_id || null,
      image_urls: form.image_url ? [form.image_url] : [],
      requires_medical_disclosure: form.requires_medical_disclosure,
      allow_cancellation: form.allow_cancellation,
      allow_rescheduling: form.allow_rescheduling,
      cancellation_cutoff_hours: Math.max(0, Number(form.cancellation_cutoff_hours) || 24),
      reschedule_cutoff_hours: Math.max(0, Number(form.reschedule_cutoff_hours) || 24),
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
    await supabase.from('activities').update({ is_published: !a.is_published, archived_at: null }).eq('id', a.id);
    setShowMenu(null);
    load();
  }

  const inputCls = 'w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-pink-200';
  const filterCls = 'px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-pink-200';

  return (
    <div className="relative">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-8 py-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Activities</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your classes, packages and locations.</p>
        </div>
      </div>

      <div className="px-8 pb-8">
        {/* Action Buttons */}
        <div className="flex justify-center gap-4 mb-6">
          <button
            onClick={() => canManage && openCreate()}
            disabled={!canManage}
            className="flex items-center gap-2 px-5 py-2.5 bg-pink-50 text-[#E91E63] rounded-xl text-sm font-medium hover:bg-pink-100 transition-colors disabled:opacity-50"
          >
            <CalendarPlus className="w-4 h-4" />
            New Activity
          </button>
          <button onClick={goToPackages} disabled={!canManage} className="flex items-center gap-2 px-5 py-2.5 bg-purple-50 text-purple-700 rounded-xl text-sm font-medium hover:bg-purple-100 transition-colors disabled:opacity-50">
            <Package className="w-4 h-4" />
            New Package
          </button>
          <button onClick={() => navigate('/settings')} className="flex items-center gap-2 px-5 py-2.5 bg-blue-50 text-blue-700 rounded-xl text-sm font-medium hover:bg-blue-100 transition-colors">
            <MapPin className="w-4 h-4" />
            New Location
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
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
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
            <div className="flex gap-6">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  onClick={() => onTab(tab)}
                  className={cn(
                    'text-sm font-medium pb-2 border-b-2 transition-colors',
                    activeTab === tab ? 'text-[#E91E63] border-[#E91E63]' : 'text-gray-500 border-transparent hover:text-gray-700'
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search activities..."
                  className="pl-10 pr-4 py-2 bg-gray-50 rounded-xl text-sm border-0 focus:outline-none focus:ring-2 focus:ring-pink-200 w-48"
                />
              </div>
              <button className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50">
                <SlidersHorizontal className="w-4 h-4" />
                Filters
              </button>
            </div>
          </div>

          {/* Filter bar */}
          <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-200">
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className={filterCls}>
              <option value="">All Status</option>
              {['Live', 'Draft', 'Archived'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={fLocation} onChange={(e) => setFLocation(e.target.value)} className={filterCls}>
              <option value="">All Locations</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <select value={fAge} onChange={(e) => setFAge(e.target.value)} className={filterCls}>
              <option value="">All Age Groups</option>
              <option value="0-18">0 – 18 months</option>
              <option value="18-36">18m – 3 years</option>
              <option value="36-60">3 – 5 years</option>
              <option value="60-216">5+ years</option>
            </select>
            <select value={fCategory} onChange={(e) => setFCategory(e.target.value)} className={filterCls}>
              <option value="">All Categories</option>
              {categories.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
            </select>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} className={cn(filterCls, 'ml-auto')}>
              <option value="updated">Sort by: Recently updated</option>
              <option value="name">Sort by: Name</option>
              <option value="rating">Sort by: Rating</option>
            </select>
          </div>

          {/* Table Header */}
          <div className="grid grid-cols-[2fr_1fr_1fr_0.7fr_0.7fr_1fr_0.8fr_1fr_0.4fr] px-5 py-3 bg-gray-50 text-xs font-medium text-gray-500">
            <div>Activity</div>
            <div>Category</div>
            <div>Age Group</div>
            <div>Sessions</div>
            <div>Bookings</div>
            <div>Rating</div>
            <div>Status</div>
            <div>Updated</div>
            <div />
          </div>

          {/* Table Rows */}
          {loading && <div className="px-5 py-10 text-center text-sm text-gray-400">Loading activities…</div>}
          {!loading && visible.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-gray-400">No activities yet. Create your first one.</div>
          )}
          {visible.map((a) => {
            const status = a.archived_at ? 'Archived' : a.is_published ? 'Live' : 'Draft';
            return (
              <div
                key={a.id}
                className="grid grid-cols-[2fr_1fr_1fr_0.7fr_0.7fr_1fr_0.8fr_1fr_0.4fr] px-5 py-4 border-t border-gray-100 items-center hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <img src={a.image_urls?.[0] || fallbackImage(a)} alt={a.title} className="w-12 h-12 rounded-lg object-cover" />
                  <div>
                    <div className="font-medium text-gray-900 text-sm">{a.title}</div>
                    <div className="text-xs text-gray-500">{a.vendor_category ?? ''}</div>
                  </div>
                </div>
                <div className="text-sm text-gray-700">{categoryName(a.category_id)}</div>
                <div className="text-sm text-gray-700">{ageLabel(a.age_min_months, a.age_max_months)}</div>
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
                    status === 'Live' ? 'bg-green-100 text-green-700' : status === 'Draft' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'
                  )}>
                    <div className={cn('w-1.5 h-1.5 rounded-full', status === 'Live' ? 'bg-green-500' : status === 'Draft' ? 'bg-yellow-500' : 'bg-gray-400')} />
                    {status}
                  </span>
                  {a.bookings_paused && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-orange-100 text-orange-700">
                      <Pause className="w-3 h-3" /> Paused
                    </span>
                  )}
                </div>
                <div className="text-sm text-gray-500">{fmtDate(a.updated_at)}</div>
                <div className="relative">
                  <button onClick={() => setShowMenu(showMenu === a.id ? null : a.id)} className="p-1.5 hover:bg-gray-100 rounded-lg">
                    <MoreVertical className="w-4 h-4 text-gray-400" />
                  </button>
                  {showMenu === a.id && canManage && (
                    <div className="absolute right-0 top-8 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-10">
                      <button onClick={() => openEdit(a)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                        <Pencil className="w-3.5 h-3.5" />
                        Edit
                      </button>
                      <button onClick={() => openSchedule(a)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                        <Clock className="w-3.5 h-3.5" />
                        Manage schedule
                      </button>
                      <button onClick={() => togglePublish(a)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                        <CalendarCheck className="w-3.5 h-3.5" />
                        {a.is_published ? 'Unpublish' : 'Publish'}
                      </button>
                      <button onClick={() => togglePause(a)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                        {a.bookings_paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                        {a.bookings_paused ? 'Resume bookings' : 'Pause bookings'}
                      </button>
                      <button onClick={() => archive(a.id)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                        <Trash2 className="w-3.5 h-3.5" />
                        Archive
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200">
            <span className="text-sm text-gray-500">Showing {visible.length} of {activities.length} activities</span>
          </div>
        </div>

        {/* Class Packs */}
        <div id="class-packs" className={cn('mt-6 bg-white rounded-xl border p-5 transition-colors', activeTab === 'Packages' ? 'border-purple-300 ring-2 ring-purple-100' : 'border-gray-200')}>
          <h2 className="font-semibold text-gray-900">Class packs</h2>
          <p className="text-sm text-gray-500 mt-0.5">Multi-session packs parents can buy; each booking uses one credit.</p>
          <p className="text-xs text-gray-500 mt-1.5">
            Make-up tokens are separate: issue one from <button onClick={() => navigate('/bookings')} className="font-medium text-[#E91E63] hover:underline">Bookings</button> — select a child's booking → "Issue make-up token". Parents redeem them when rebooking.
          </p>
          {packs.length > 0 && (
            <div className="mt-4 space-y-2">
              {packs.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
                  <div className="min-w-0">
                    <span className="font-medium text-gray-900">{p.name}</span>
                    <span className="ml-2 text-sm text-gray-500">{p.credits} classes · ${(p.price_cents / 100).toFixed(0)}</span>
                    {packRestriction(p) && (
                      <div className="mt-0.5 text-xs text-purple-700">{packRestriction(p)}</div>
                    )}
                  </div>
                  {canManage && (
                    <button onClick={() => togglePack(p)} className={cn('text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0', p.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500')}>
                      {p.active ? 'Active' : 'Inactive'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {canManage && (
            <>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Pack name</label>
                  <input value={packForm.name} onChange={(e) => setPackForm({ ...packForm, name: e.target.value })} placeholder="10-class pack" className="h-9 rounded-lg border border-gray-300 px-3 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Classes</label>
                  <input type="number" value={packForm.credits} onChange={(e) => setPackForm({ ...packForm, credits: e.target.value })} placeholder="10" className="h-9 w-24 rounded-lg border border-gray-300 px-3 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Price (SGD)</label>
                  <input type="number" value={packForm.price} onChange={(e) => setPackForm({ ...packForm, price: e.target.value })} placeholder="180" className="h-9 w-28 rounded-lg border border-gray-300 px-3 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Valid for (days)</label>
                  <input type="number" min="1" value={packForm.validity_days} onChange={(e) => setPackForm({ ...packForm, validity_days: e.target.value })} placeholder="No expiry" className="h-9 w-28 rounded-lg border border-gray-300 px-3 text-sm" />
                </div>
                <button onClick={createPack} disabled={savingPack || !packForm.name.trim() || !packForm.credits} className="h-9 rounded-lg bg-[#E91E63] px-4 text-sm font-medium text-white disabled:opacity-50">
                  {savingPack ? 'Adding…' : 'Add pack'}
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Restrict to class (optional)</label>
                  <select value={packForm.activity_id} onChange={(e) => setPackForm({ ...packForm, activity_id: e.target.value })} className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm">
                    <option value="">Any of my classes</option>
                    {activities.filter((a) => !a.archived_at).map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Restrict to weekly slot (optional)</label>
                  <div className="flex gap-2">
                    <select value={packForm.allowed_weekday} onChange={(e) => setPackForm({ ...packForm, allowed_weekday: e.target.value })} className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm">
                      <option value="">Any day</option>
                      {WEEKDAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </select>
                    <input type="time" value={packForm.allowed_start_time} onChange={(e) => setPackForm({ ...packForm, allowed_start_time: e.target.value })} className="h-9 rounded-lg border border-gray-300 px-3 text-sm" title="Session start time (SGT); leave blank for any time" />
                  </div>
                </div>
              </div>
              <p className="mt-2 text-xs text-gray-500">Restricted packs can only be redeemed against matching sessions — e.g. a 4-class pack limited to the Monday 4:00 pm class.</p>
            </>
          )}
        </div>
      </div>

      {/* Create Activity Drawer */}
      {showDrawer && (
        <div className="fixed top-0 right-0 w-[28rem] h-full bg-white shadow-2xl border-l border-gray-200 z-50 flex flex-col">
          <div className="flex items-center justify-between p-5 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">{editingId ? 'Edit Activity' : 'Create Activity'}</h3>
            <button onClick={() => setShowDrawer(false)} className="p-1.5 hover:bg-gray-100 rounded-lg">
              <X className="w-4 h-4 text-gray-600" />
            </button>
          </div>

          <div className="flex-1 overflow-auto p-5 space-y-5">
            {formError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div>}
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Name <span className="text-[#E91E63]">*</span></label>
              <input type="text" placeholder="e.g. Music Explorers" className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Category <span className="text-[#E91E63]">*</span></label>
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
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Age range (months)</label>
              <div className="flex items-center gap-3">
                <input type="number" min="0" placeholder="Min" className={inputCls} value={form.age_min_months} onChange={(e) => setForm({ ...form, age_min_months: e.target.value })} />
                <span className="text-gray-400">—</span>
                <input type="number" min="0" placeholder="Max" className={inputCls} value={form.age_max_months} onChange={(e) => setForm({ ...form, age_max_months: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Location</label>
              <select className={inputCls} value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
                <option value="">Select a location</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              {locations.length === 0 && (
                <p className="mt-1 text-xs text-gray-500">No locations yet — add one in <button className="text-[#E91E63] font-medium hover:underline" onClick={() => navigate('/settings')}>Settings</button>.</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Price (SGD per session)</label>
              <input type="number" min="0" placeholder="e.g. 45" className={inputCls} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Activity Image</label>
              <label className={cn(
                'flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-gray-200 px-4 py-6 cursor-pointer hover:border-pink-300 transition-colors',
                uploading && 'opacity-60 pointer-events-none'
              )}>
                {form.image_url ? (
                  <img src={form.image_url} alt="Activity" className="h-24 w-full rounded-lg object-cover" />
                ) : (
                  <>
                    <ImageUp className="w-6 h-6 text-[#E91E63]" />
                    <span className="text-sm font-medium text-[#E91E63]">{uploading ? 'Uploading…' : 'Upload image'}</span>
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
                <div className="text-xs text-gray-500">Parents must complete disclosures and consents before booking</div>
              </div>
              <Switch checked={form.requires_medical_disclosure} onCheckedChange={(v) => setForm({ ...form, requires_medical_disclosure: v })} className="data-[state=checked]:bg-[#E91E63]" />
            </div>

            {/* 2.2: cancellation & rescheduling policy for this class */}
            <div className="rounded-xl border border-gray-200 p-4 space-y-4">
              <div className="text-sm font-semibold text-gray-900">Booking policies</div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-900">Allow cancellations</div>
                  <div className="text-xs text-gray-500">Parents can cancel their booking themselves</div>
                </div>
                <Switch checked={form.allow_cancellation} onCheckedChange={(v) => setForm({ ...form, allow_cancellation: v })} className="data-[state=checked]:bg-[#E91E63]" />
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
                <Switch checked={form.allow_rescheduling} onCheckedChange={(v) => setForm({ ...form, allow_rescheduling: v })} className="data-[state=checked]:bg-[#E91E63]" />
              </div>
              {form.allow_rescheduling && (
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Rescheduling cut-off (hours before session)</label>
                  <input type="number" min="0" className={inputCls} value={form.reschedule_cutoff_hours} onChange={(e) => setForm({ ...form, reschedule_cutoff_hours: e.target.value })} />
                </div>
              )}
            </div>
          </div>

          <div className="p-5 border-t border-gray-200 flex gap-3">
            <Button variant="outline" onClick={() => setShowDrawer(false)} className="flex-1 rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50">Cancel</Button>
            <Button onClick={saveActivity} disabled={saving} className="flex-1 gradient-primary text-white rounded-xl hover:opacity-90">
              {saving ? 'Saving…' : 'Save Activity'}
            </Button>
          </div>
        </div>
      )}

      {/* Schedule Drawer — the bookable dates/times for one activity */}
      {scheduleFor && (
        <div className="fixed top-0 right-0 w-[28rem] h-full bg-white shadow-2xl border-l border-gray-200 z-50 flex flex-col">
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
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Capacity (blank = unlimited)</label>
                  <input type="number" min="1" placeholder="e.g. 12" className={inputCls} value={sessForm.capacity} onChange={(e) => setSessForm({ ...sessForm, capacity: e.target.value })} />
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

            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-2">Upcoming sessions ({sessions.length})</h4>
              {sessions.length === 0 && (
                <p className="text-sm text-gray-400">No upcoming sessions — parents can't book this activity until you add some.</p>
              )}
              <div className="space-y-2">
                {sessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2.5">
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {new Date(s.starts_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                      </div>
                      <div className="text-xs text-gray-500">
                        {Math.round((new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000)} mins
                        {' · '}{s.capacity != null ? `${s.capacity} spots` : 'Unlimited'}
                        {' · '}{s.booked} booked
                      </div>
                    </div>
                    <button onClick={() => removeSession(s)} className="p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600" title="Remove session">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
