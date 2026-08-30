import { useEffect, useState } from 'react';
import { MapPin, Pencil, Plus, RefreshCw, Save, Store, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RainbowLoader } from '@/components/ui/rainbow-loader';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import type { ProviderLocation } from '@/lib/database.types';

/**
 * Live locations list + add/remove/edit form.
 *
 * QA 28/08: "It doesn't make sense to have locations in settings and weird
 * redirecting from activities to there — can location move to sit under the
 * 'activities' tab." Lifted out of SettingsPage so Activities can own it,
 * rather than bouncing the vendor to Settings and back.
 */
export default function LocationsManager({
  provider, canManage, openOnMount, onOpened,
}: {
  provider: { id: string } | null; canManage: boolean;
  openOnMount?: boolean; onOpened?: () => void;
}) {
  const [locations, setLocations] = useState<ProviderLocation[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', address: '', postal_code: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Locations could be added and removed but never edited — a typo in the
     address meant delete-and-recreate, which also loses is_primary. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', address: '', postal_code: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // "Fetch from Wix" — pulls the vendor's real Wix business address(es)
  // instead of retyping one. Independent of whether Wix is even connected;
  // the fetch call itself reports that (409) with a friendly message.
  const [showWixPicker, setShowWixPicker] = useState(false);
  const [wixLocations, setWixLocations] = useState<
    { id: string; name: string; address: string | null; postalCode: string | null; alreadyImported: boolean }[] | null
  >(null);
  const [wixLoading, setWixLoading] = useState(false);
  const [wixError, setWixError] = useState<string | null>(null);
  const [wixSelected, setWixSelected] = useState<Set<string>>(new Set());
  const [wixImporting, setWixImporting] = useState(false);
  const [wixNotice, setWixNotice] = useState<string | null>(null);

  async function loadWixLocations() {
    if (!provider) return;
    setWixLoading(true);
    setWixError(null);
    setWixNotice(null);
    try {
      const res = await apiGet<{ locations: typeof wixLocations }>(`/api/vendor/wix-locations?providerId=${provider.id}`);
      setWixLocations(res.locations);
      setWixSelected(new Set());
    } catch (e) {
      setWixError(
        e instanceof ApiError && e.status === 409
          ? 'Connect your Wix account below first, then fetch your locations from it.'
          : e instanceof Error ? e.message : 'Could not reach Wix'
      );
    } finally {
      setWixLoading(false);
    }
  }

  function openWixPicker() {
    setShowWixPicker(true);
    if (!wixLocations) loadWixLocations();
  }

  function toggleWixSelected(id: string) {
    setWixNotice(null);
    setWixSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function importWixLocations() {
    if (!provider || wixSelected.size === 0) return;
    setWixImporting(true);
    setWixError(null);
    setWixNotice(null);
    try {
      const res = await apiPost<{ imported: number }>('/api/vendor/wix-locations-import', {
        provider_id: provider.id,
        location_ids: Array.from(wixSelected),
      });
      setWixNotice(res.imported > 0 ? `Added ${res.imported} location${res.imported === 1 ? '' : 's'} from Wix.` : 'Nothing new to add.');
      await Promise.all([loadWixLocations(), load()]);
    } catch (e) {
      setWixError(e instanceof Error ? e.message : 'Could not import from Wix');
    } finally {
      setWixImporting(false);
    }
  }

  async function load() {
    if (!provider) return;
    const { data } = await supabase
      .from('provider_locations')
      .select('*')
      .eq('provider_id', provider.id)
      .order('is_primary', { ascending: false });
    setLocations(data ?? []);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [provider]);

  // Dashboard's "Add a Location" shortcut deep-links with ?new=location.
  useEffect(() => {
    if (!openOnMount || !canManage) return;
    setShowForm(true);
    onOpened?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOnMount, canManage]);

  async function addLocation() {
    if (!provider || !form.name.trim()) { setError('A location name is required.'); return; }
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.from('provider_locations').insert({
      provider_id: provider.id,
      name: form.name.trim(),
      address: form.address.trim() || null,
      postal_code: form.postal_code.trim() || null,
      is_primary: locations.length === 0, // first location becomes the main branch
    });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setForm({ name: '', address: '', postal_code: '' });
    setShowForm(false);
    load();
  }

  async function removeLocation(id: string) {
    if (!window.confirm('Remove this location?')) return;
    await supabase.from('provider_locations').delete().eq('id', id);
    load();
  }

  function startEdit(loc: ProviderLocation) {
    setEditingId(loc.id);
    setEditError(null);
    setEditForm({ name: loc.name ?? '', address: loc.address ?? '', postal_code: loc.postal_code ?? '' });
  }

  async function saveEdit(id: string) {
    if (!editForm.name.trim()) { setEditError('A location name is required.'); return; }
    setEditSaving(true);
    setEditError(null);
    const { error: err } = await supabase.from('provider_locations').update({
      name: editForm.name.trim(),
      address: editForm.address.trim() || null,
      postal_code: editForm.postal_code.trim() || null,
    }).eq('id', id);
    setEditSaving(false);
    if (err) { setEditError(err.message); return; }
    setEditingId(null);
    load();
  }

  async function setPrimary(id: string) {
    if (!provider) return;
    // Only one row may be primary, so clear the rest first.
    await supabase.from('provider_locations').update({ is_primary: false }).eq('provider_id', provider.id);
    await supabase.from('provider_locations').update({ is_primary: true }).eq('id', id);
    load();
  }

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-pink-300';

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center"><MapPin className="w-5 h-5 text-purple-600" /></div>
          <div>
            <h3 className="font-semibold text-gray-900">Locations</h3>
            <p className="text-xs text-gray-500">{locations.length} active location{locations.length === 1 ? '' : 's'}</p>
          </div>
        </div>
        {canManage && !showForm && (
          <div className="flex items-center gap-2">
            <button onClick={openWixPicker} className="flex items-center gap-1 px-3 py-1.5 border border-gray-200 text-gray-700 rounded-lg text-xs font-medium hover:bg-gray-50">
              <RefreshCw className={cn('w-3.5 h-3.5', wixLoading && 'animate-spin')} /> Fetch from Wix
            </button>
            <button onClick={() => setShowForm(true)} className="flex items-center gap-1 px-3 py-1.5 bg-pink-50 text-[#FA4D8D] rounded-lg text-xs font-medium hover:bg-pink-100">
              <Plus className="w-3.5 h-3.5" /> Add location
            </button>
          </div>
        )}
      </div>

      {showWixPicker && canManage && (
        <div className="mb-4 rounded-xl border border-gray-200 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-semibold text-gray-900">Fetch from Wix</h4>
              <p className="text-xs text-gray-500">Import a business address already on file with your connected Wix account.</p>
            </div>
            <button onClick={() => setShowWixPicker(false)} className="p-1 rounded-lg text-gray-400 hover:bg-gray-100"><X className="w-4 h-4" /></button>
          </div>

          {wixError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{wixError}</div>}
          {wixNotice && <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{wixNotice}</div>}
          {wixLoading && <RainbowLoader className="py-4" label="Loading Wix locations" />}

          {!wixLoading && wixLocations && wixLocations.length === 0 && !wixError && (
            <p className="text-sm text-gray-400">No business locations found on this Wix account.</p>
          )}

          {!wixLoading && wixLocations && wixLocations.length > 0 && (
            <>
              <div className="space-y-2">
                {wixLocations.map((l) => (
                  <label
                    key={l.id}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-xl border',
                      l.alreadyImported
                        ? 'bg-green-50 border-green-100'
                        : 'bg-gray-50 border-gray-100 cursor-pointer hover:bg-gray-100'
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 flex-shrink-0 rounded border-gray-300 text-pink-500 focus:ring-pink-300"
                      checked={wixSelected.has(l.id)}
                      disabled={l.alreadyImported}
                      onChange={() => toggleWixSelected(l.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-800 truncate">{l.name}</div>
                      <div className="text-xs text-gray-400 truncate">{l.address ?? 'No address on file'}</div>
                    </div>
                    {l.alreadyImported && <span className="flex-shrink-0 text-xs font-semibold text-green-700">Added</span>}
                  </label>
                ))}
              </div>
              <Button
                onClick={importWixLocations}
                disabled={wixImporting || wixSelected.size === 0}
                className="gradient-primary text-white rounded-xl hover:opacity-90 gap-2"
              >
                <Save className="w-4 h-4" /> {wixImporting ? 'Adding…' : `Add ${wixSelected.size || ''} location${wixSelected.size === 1 ? '' : 's'}`}
              </Button>
            </>
          )}
        </div>
      )}

      <div className="space-y-3 mb-4">
        {locations.map((loc) => (
          editingId === loc.id ? (
            <div key={loc.id} className="rounded-xl border border-pink-300 bg-pink-50/30 p-3 space-y-2">
              {editError && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{editError}</div>}
              <input className={inputCls} placeholder="Location name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input className={inputCls} placeholder="Address" value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} />
                <input className={inputCls} placeholder="Postal code" value={editForm.postal_code} onChange={(e) => setEditForm({ ...editForm, postal_code: e.target.value })} />
              </div>
              <div className="flex gap-2">
                <button onClick={() => saveEdit(loc.id)} disabled={editSaving} className="px-3 py-1.5 bg-[#C90044] text-white rounded-lg text-xs font-medium disabled:opacity-50">
                  {editSaving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={() => setEditingId(null)} className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-medium text-gray-700">Cancel</button>
              </div>
            </div>
          ) : (
          <div key={loc.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-pink-100 text-[#FA4D8D]"><Store className="w-5 h-5" /></div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-gray-900 text-sm">{loc.name}</div>
              <div className="text-xs text-gray-500 truncate">
                {loc.is_primary ? 'Main branch' : 'Branch'}{loc.address ? ` · ${loc.address}` : ''}
              </div>
            </div>
            {canManage && (
              <div className="flex items-center gap-1">
                {!loc.is_primary && (
                  <button onClick={() => setPrimary(loc.id)} className="px-2 py-1 rounded-lg text-[11px] font-medium text-gray-500 hover:bg-gray-200" title="Set as main branch">
                    Set main
                  </button>
                )}
                <button onClick={() => startEdit(loc)} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-200 hover:text-gray-700" title="Edit location">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => removeLocation(loc.id)} className="p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600" title="Remove location">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
          )
        ))}
        {locations.length === 0 && !showForm && <div className="text-sm text-gray-400">No locations added yet.</div>}
      </div>

      {canManage && showForm && (
        <div className="rounded-xl border border-gray-200 p-4 space-y-3">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Location name <span className="text-[#FA4D8D]">*</span></label>
            <input className={inputCls} placeholder="e.g. Suntec City Studio" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Address</label>
              <input className={inputCls} placeholder="Street & unit" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Postal code</label>
              <input className={inputCls} placeholder="e.g. 038983" value={form.postal_code} onChange={(e) => setForm({ ...form, postal_code: e.target.value })} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={addLocation} disabled={saving || !form.name.trim()} className="gradient-primary text-white rounded-xl hover:opacity-90 px-5">
              {saving ? 'Saving…' : 'Save location'}
            </Button>
            <Button variant="outline" onClick={() => { setShowForm(false); setError(null); }} className="rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50">Cancel</Button>
          </div>
        </div>
      )}
    </>
  );
}
