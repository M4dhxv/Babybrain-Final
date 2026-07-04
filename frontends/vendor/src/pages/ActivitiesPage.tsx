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

export default function ActivitiesPage() {
  const { provider, role } = useAuth();
  const canManage = role === 'owner' || role === 'manager';
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState('Activities');
  const [showDrawer, setShowDrawer] = useState(false);
  const [showMenu, setShowMenu] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [activities, setActivities] = useState<Activity[]>([]);
  const [categories, setCategories] = useState<ActivityCategory[]>([]);
  const [locationCount, setLocationCount] = useState(0);
  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  // Create-activity form
  const [form, setForm] = useState({
    title: '', category_id: '', vendor_category: '' as VendorCategory | '',
    description: '', age_min_months: '', age_max_months: '', price: '',
    requires_medical_disclosure: true,
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Class packs (multi-session packages sold to parents)
  type Pack = { id: string; name: string; credits: number; price_cents: number; active: boolean };
  const [packs, setPacks] = useState<Pack[]>([]);
  const [packForm, setPackForm] = useState({ name: '', credits: '', price: '' });
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
    });
    setPackForm({ name: '', credits: '', price: '' });
    setSavingPack(false);
    load();
  }
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
      supabase.from('provider_locations').select('id').eq('provider_id', provider.id),
      supabase.from('packages').select('id, name, credits, price_cents, active').eq('provider_id', provider.id).order('created_at', { ascending: false }),
    ]);
    setActivities(acts ?? []);
    setCategories(cats ?? []);
    setLocationCount((locs ?? []).length);
    setPacks((pks ?? []) as Pack[]);

    // Upcoming session counts per activity (single query, grouped client-side).
    const ids = (acts ?? []).map((a) => a.id);
    if (ids.length) {
      const { data: sess } = await supabase
        .from('activity_sessions')
        .select('activity_id')
        .in('activity_id', ids)
        .gte('starts_at', new Date().toISOString());
      const counts: Record<string, number> = {};
      (sess ?? []).forEach((s) => { counts[s.activity_id] = (counts[s.activity_id] ?? 0) + 1; });
      setSessionCounts(counts);
    } else {
      setSessionCounts({});
    }
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [provider]);

  const visible = useMemo(
    () => activities.filter((a) => a.title.toLowerCase().includes(search.toLowerCase())),
    [activities, search]
  );
  const categoryName = (id: number) => categories.find((c) => c.id === id)?.name ?? '—';

  const stats = [
    { icon: CalendarCheck, label: 'Active Activities', value: String(activities.filter((a) => a.is_published && !a.archived_at).length), sub: 'Live and published', color: 'text-pink-600', bg: 'bg-pink-100' },
    { icon: Package, label: 'Packages', value: '—', sub: 'Active packages', color: 'text-purple-600', bg: 'bg-purple-100' },
    { icon: MapPin, label: 'Locations', value: String(locationCount), sub: 'Venues added', color: 'text-blue-600', bg: 'bg-blue-100' },
    { icon: CalendarDays, label: 'Draft Activities', value: String(activities.filter((a) => !a.is_published).length), sub: 'Not published yet', color: 'text-yellow-600', bg: 'bg-yellow-100' },
  ];

  async function archive(id: string) {
    await supabase.from('activities').update({ archived_at: new Date().toISOString(), is_published: false }).eq('id', id);
    setShowMenu(null);
    load();
  }

  async function saveActivity() {
    if (!provider) return;
    if (!form.title || !form.category_id) { setFormError('Name and category are required.'); return; }
    setSaving(true);
    setFormError(null);
    const slug = `${form.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
    const { error } = await supabase.from('activities').insert({
      slug,
      title: form.title,
      description: form.description,
      category_id: Number(form.category_id),
      provider_id: provider.id,
      vendor_category: (form.vendor_category || provider.vendor_category) as VendorCategory | undefined,
      age_min_months: form.age_min_months ? Number(form.age_min_months) : 0,
      age_max_months: form.age_max_months ? Number(form.age_max_months) : 216,
      price: form.price ? Number(form.price) : null,
      requires_medical_disclosure: form.requires_medical_disclosure,
      is_published: false, // saved as draft; publish from the row menu
    });
    setSaving(false);
    if (error) { setFormError(error.message); return; }
    setShowDrawer(false);
    setForm({ title: '', category_id: '', vendor_category: '', description: '', age_min_months: '', age_max_months: '', price: '', requires_medical_disclosure: true });
    load();
  }

  async function togglePublish(a: Activity) {
    await supabase.from('activities').update({ is_published: !a.is_published, archived_at: null }).eq('id', a.id);
    setShowMenu(null);
    load();
  }

  const inputCls = 'w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-pink-200';

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
            onClick={() => canManage && setShowDrawer(true)}
            disabled={!canManage}
            className="flex items-center gap-2 px-5 py-2.5 bg-pink-50 text-[#E91E63] rounded-xl text-sm font-medium hover:bg-pink-100 transition-colors disabled:opacity-50"
          >
            <CalendarPlus className="w-4 h-4" />
            New Activity
          </button>
          <button onClick={() => canManage && setShowDrawer(true)} disabled={!canManage} className="flex items-center gap-2 px-5 py-2.5 bg-purple-50 text-purple-700 rounded-xl text-sm font-medium hover:bg-purple-100 transition-colors disabled:opacity-50">
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
                  onClick={() => setActiveTab(tab)}
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

          {/* Table Header */}
          <div className="grid grid-cols-[2fr_1fr_1fr_0.8fr_1fr_0.8fr_1fr_0.5fr] px-5 py-3 bg-gray-50 text-xs font-medium text-gray-500">
            <div>Activity</div>
            <div>Category</div>
            <div>Age Group</div>
            <div>Sessions</div>
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
                className="grid grid-cols-[2fr_1fr_1fr_0.8fr_1fr_0.8fr_1fr_0.5fr] px-5 py-4 border-t border-gray-100 items-center hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <img src={a.image_urls?.[0] || '/assets/activity-music.jpg'} alt={a.title} className="w-12 h-12 rounded-lg object-cover" />
                  <div>
                    <div className="font-medium text-gray-900 text-sm">{a.title}</div>
                    <div className="text-xs text-gray-500">{a.vendor_category ?? ''}</div>
                  </div>
                </div>
                <div className="text-sm text-gray-700">{categoryName(a.category_id)}</div>
                <div className="text-sm text-gray-700">{ageLabel(a.age_min_months, a.age_max_months)}</div>
                <div className="text-sm text-gray-700">{sessionCounts[a.id] ?? 0}<br /><span className="text-xs text-gray-500">Upcoming</span></div>
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
                <div>
                  <span className={cn(
                    'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full',
                    status === 'Live' ? 'bg-green-100 text-green-700' : status === 'Draft' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'
                  )}>
                    <div className={cn('w-1.5 h-1.5 rounded-full', status === 'Live' ? 'bg-green-500' : status === 'Draft' ? 'bg-yellow-500' : 'bg-gray-400')} />
                    {status}
                  </span>
                </div>
                <div className="text-sm text-gray-500">{fmtDate(a.updated_at)}</div>
                <div className="relative">
                  <button onClick={() => setShowMenu(showMenu === a.id ? null : a.id)} className="p-1.5 hover:bg-gray-100 rounded-lg">
                    <MoreVertical className="w-4 h-4 text-gray-400" />
                  </button>
                  {showMenu === a.id && canManage && (
                    <div className="absolute right-0 top-8 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-10">
                      <button onClick={() => togglePublish(a)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                        <CalendarCheck className="w-3.5 h-3.5" />
                        {a.is_published ? 'Unpublish' : 'Publish'}
                      </button>
                      <button onClick={() => archive(a.id)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                        <Pencil className="w-3.5 h-3.5" />
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
        <div className="mt-6 bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="font-semibold text-gray-900">Class packs</h2>
          <p className="text-sm text-gray-500 mt-0.5">Multi-session packs parents can buy; each booking uses one credit.</p>
          {packs.length > 0 && (
            <div className="mt-4 space-y-2">
              {packs.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
                  <div>
                    <span className="font-medium text-gray-900">{p.name}</span>
                    <span className="ml-2 text-sm text-gray-500">{p.credits} classes · ${(p.price_cents / 100).toFixed(0)}</span>
                  </div>
                  {canManage && (
                    <button onClick={() => togglePack(p)} className={cn('text-xs font-medium px-2.5 py-1 rounded-full', p.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500')}>
                      {p.active ? 'Active' : 'Inactive'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {canManage && (
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
              <button onClick={createPack} disabled={savingPack || !packForm.name.trim() || !packForm.credits} className="h-9 rounded-lg bg-[#E91E63] px-4 text-sm font-medium text-white disabled:opacity-50">
                {savingPack ? 'Adding…' : 'Add pack'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Create Activity Drawer */}
      {showDrawer && (
        <div className="fixed top-0 right-0 w-[28rem] h-full bg-white shadow-2xl border-l border-gray-200 z-50 flex flex-col">
          <div className="flex items-center justify-between p-5 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">Create Activity</h3>
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
              <textarea placeholder="Describe this activity..." rows={3} className={cn(inputCls, 'resize-none')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
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
              <label className="text-sm font-medium text-gray-900 mb-1.5 block">Price (SGD per session)</label>
              <input type="number" min="0" placeholder="e.g. 45" className={inputCls} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-gray-900">Require medical disclosure</div>
                <div className="text-xs text-gray-500">Parents complete a disclosure before booking</div>
              </div>
              <Switch checked={form.requires_medical_disclosure} onCheckedChange={(v) => setForm({ ...form, requires_medical_disclosure: v })} className="data-[state=checked]:bg-[#E91E63]" />
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
    </div>
  );
}
