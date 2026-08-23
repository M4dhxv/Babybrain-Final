import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Package as PackageIcon, Pencil, Trash2, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const tabs = ['Packs', 'Purchases'];

type Pack = {
  id: string; name: string; credits: number; price_cents: number; active: boolean;
  activity_id: string | null; validity_days: number | null;
  allowed_weekday: number | null; allowed_start_time: string | null;
};
type Purchase = {
  purchase_id: string; package_name: string; buyer_name: string;
  credits_total: number; credits_remaining: number; status: string;
  created_at: string; expires_at: string | null;
};

const emptyPack = { name: '', credits: '', price: '', validity_days: '', activity_id: '', allowed_weekday: '', allowed_start_time: '' };
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });

export default function PackagesPage() {
  const { provider, role } = useAuth();
  const canManage = role === 'owner' || role === 'manager';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState('Packs');

  const [activities, setActivities] = useState<{ id: string; title: string }[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);

  const [packForm, setPackForm] = useState(emptyPack);
  const [savingPack, setSavingPack] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);
  const [packNotice, setPackNotice] = useState<string | null>(null);
  const [editingPackId, setEditingPackId] = useState<string | null>(null);

  async function load() {
    if (!provider) return;
    setLoading(true);
    const [{ data: acts }, { data: pks }, { data: purch }] = await Promise.all([
      supabase.from('activities').select('id, title').eq('provider_id', provider.id).is('archived_at', null),
      supabase.from('packages').select('id, name, credits, price_cents, active, activity_id, validity_days, allowed_weekday, allowed_start_time').eq('provider_id', provider.id).order('created_at', { ascending: false }),
      supabase.rpc('provider_package_purchases', { p_provider: provider.id }),
    ]);
    setActivities(acts ?? []);
    setPacks((pks ?? []) as Pack[]);
    setPurchases((purch ?? []) as Purchase[]);
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [provider]);

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

  const packRestriction = (p: Pack) => {
    const parts: string[] = [];
    if (p.activity_id) parts.push(activities.find((a) => a.id === p.activity_id)?.title ?? 'One activity');
    if (p.allowed_weekday != null) {
      const t = p.allowed_start_time ? ` ${p.allowed_start_time.slice(0, 5)}` : '';
      parts.push(`${WEEKDAY_NAMES[p.allowed_weekday]}${t} only`);
    } else if (p.allowed_start_time) {
      parts.push(`${p.allowed_start_time.slice(0, 5)} slot only`);
    }
    if (p.validity_days) parts.push(`expires ${p.validity_days}d after purchase`);
    return parts.join(' · ');
  };

  function editPack(p: Pack) {
    setEditingPackId(p.id);
    setPackError(null);
    setPackNotice(null);
    setPackForm({
      name: p.name,
      credits: String(p.credits),
      price: String(p.price_cents / 100),
      validity_days: p.validity_days != null ? String(p.validity_days) : '',
      activity_id: p.activity_id ?? '',
      allowed_weekday: p.allowed_weekday != null ? String(p.allowed_weekday) : '',
      allowed_start_time: p.allowed_start_time ?? '',
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

    setSavingPack(true);
    const fields = {
      name: packForm.name.trim(),
      credits,
      price_cents: Math.round((price || 0) * 100),
      validity_days: packForm.validity_days ? Number(packForm.validity_days) : null,
      activity_id: packForm.activity_id || null,
      allowed_weekday: packForm.allowed_weekday !== '' ? Number(packForm.allowed_weekday) : null,
      allowed_start_time: packForm.allowed_start_time || null,
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

  const statusBadge = (s: string) => cn(
    'inline-block px-2 py-0.5 text-xs rounded-full capitalize',
    s === 'active' ? 'bg-green-300 text-green-800' : s === 'used' ? 'bg-gray-100 text-gray-600' : 'bg-red-100 text-red-600'
  );

  return (
    <div className="relative">
      <div className="flex items-center justify-between px-8 py-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Packages</h1>
          <p className="text-sm text-gray-500 mt-1">Multi-session packs parents can buy, and who's bought them.</p>
        </div>
      </div>

      <div className="px-8 pb-8">
        <div className="flex gap-6 border-b border-gray-200 mb-6">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'flex items-center gap-2 text-sm font-medium pb-3 border-b-2 transition-colors',
                activeTab === tab ? 'text-[#C90044] border-[#C90044]' : 'text-gray-500 border-transparent hover:text-gray-700'
              )}
            >
              {tab === 'Packs' ? <PackageIcon className="w-4 h-4" /> : <Users className="w-4 h-4" />}
              {tab}{tab === 'Purchases' && purchases.length > 0 ? ` (${purchases.length})` : ''}
            </button>
          ))}
        </div>

        {loading && <div className="text-sm text-gray-400">Loading…</div>}

        {!loading && activeTab === 'Packs' && (
          <div id="pack-form" className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-xs text-gray-500 mb-4">
              Make-up tokens are separate: issue one from <button onClick={() => navigate('/bookings')} className="font-medium text-[#C90044] hover:underline">Bookings</button>, or see who holds one under <button onClick={() => navigate('/make-up-tokens')} className="font-medium text-[#C90044] hover:underline">Make-up Tokens</button>.
            </p>
            {packs.length > 0 && (
              <div className="space-y-2">
                {packs.map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
                    <div className="min-w-0">
                      <span className="font-medium text-gray-900">{p.name}</span>
                      <span className="ml-2 text-sm text-gray-500">{p.credits} classes · ${(p.price_cents / 100).toFixed(0)}</span>
                      {packRestriction(p) && <div className="mt-0.5 text-xs text-purple-700">{packRestriction(p)}</div>}
                    </div>
                    {canManage && (
                      <div className="flex flex-shrink-0 items-center gap-2">
                        <button onClick={() => togglePack(p)} className={cn('text-xs font-medium px-2.5 py-1 rounded-full', p.active ? 'bg-green-300 text-green-800' : 'bg-gray-100 text-gray-500')}>
                          {p.active ? 'Active' : 'Inactive'}
                        </button>
                        <button onClick={() => editPack(p)} title="Edit pack" className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => deletePack(p)} title="Delete pack" className="rounded-lg p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {packs.length === 0 && <div className="text-sm text-gray-400">No packs yet.</div>}

            {canManage && (
              <>
                <div className="mt-5 flex flex-wrap items-end gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Pack name</label>
                    <input id="pack-name-input" value={packForm.name} onChange={(e) => setPackForm({ ...packForm, name: e.target.value })} placeholder="10-class pack" className="h-9 rounded-lg border border-gray-300 px-3 text-sm" />
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
                  <button onClick={createPack} disabled={savingPack} className="h-9 rounded-lg bg-[#C90044] px-4 text-sm font-medium text-white disabled:opacity-50">
                    {savingPack ? 'Saving…' : editingPackId ? 'Save pack' : 'Add pack'}
                  </button>
                  {editingPackId && (
                    <button
                      onClick={() => { setEditingPackId(null); setPackForm(emptyPack); setPackError(null); setPackNotice(null); }}
                      className="h-9 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700"
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
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Restrict to activity (optional)</label>
                    <select value={packForm.activity_id} onChange={(e) => setPackForm({ ...packForm, activity_id: e.target.value })} className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm">
                      <option value="">Any of my activities</option>
                      {activities.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
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
        )}

        {!loading && activeTab === 'Purchases' && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="grid grid-cols-[1.4fr_1fr_0.8fr_0.8fr_1fr] px-5 py-3 bg-gray-50 text-xs font-medium text-gray-500">
              <div>Buyer</div><div>Pack</div><div>Credits</div><div>Status</div><div>Purchased / Expires</div>
            </div>
            {purchases.map((p) => (
              <div key={p.purchase_id} className="grid grid-cols-[1.4fr_1fr_0.8fr_0.8fr_1fr] px-5 py-3 border-t border-gray-100 items-center">
                <div className="text-sm font-medium text-gray-900">{p.buyer_name}</div>
                <div className="text-sm text-gray-700">{p.package_name}</div>
                <div className="text-sm text-gray-700">{p.credits_remaining}/{p.credits_total}</div>
                <div><span className={statusBadge(p.status)}>{p.status}</span></div>
                <div className="text-xs text-gray-500">{fmtDate(p.created_at)}{p.expires_at ? ` · expires ${fmtDate(p.expires_at)}` : ''}</div>
              </div>
            ))}
            {purchases.length === 0 && <div className="px-5 py-8 text-center text-sm text-gray-400">No one has bought a pack yet.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
