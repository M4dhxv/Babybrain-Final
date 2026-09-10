import { useEffect, useState } from 'react';
import { ChevronDown, FileText, ImageUp, Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import type { ProviderPolicy } from '@/lib/database.types';

/**
 * Waivers, consents and disclosures the vendor writes themselves.
 *
 * QA (11/08): the "require medical disclosure" switch on an activity changed
 * nothing on the parent's side, and the founder noted it "won't always be
 * medical disclosures — each vendor will have their own consents, waivers,
 * disclosures they want accepted so need a way to make this bespoke".
 *
 * Each entry is either provider-wide or pinned to one class, carries the
 * wording parents read (and optionally a document they can open), and is
 * either required — a tick-box that blocks the booking until it's ticked,
 * enforced by a database trigger, not just the UI — or informational.
 *
 * Lives under Activities → Policy & consent management (next to the medical
 * disclosure control); it used to be a standalone Settings tab.
 */
export function PoliciesManager({
  provider, canManage,
}: {
  provider: { id: string } | null; canManage: boolean;
}) {
  const [policies, setPolicies] = useState<ProviderPolicy[]>([]);
  const [activities, setActivities] = useState<{ id: string; title: string }[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const emptyForm = { title: '', body: '', document_url: '', required: true, activity_ids: [] as string[] };
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [activityPickerOpen, setActivityPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!provider) return;
    const [{ data: rows }, { data: acts }] = await Promise.all([
      supabase
        .from('provider_policies')
        .select('*')
        .eq('provider_id', provider.id)
        .order('sort_order')
        .order('created_at'),
      supabase.from('activities').select('id, title').eq('provider_id', provider.id).order('title'),
    ]);
    setPolicies((rows ?? []) as ProviderPolicy[]);
    setActivities((acts ?? []) as { id: string; title: string }[]);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [provider]);

  async function uploadDocument(file: File) {
    if (!provider) return;
    setUploading(true);
    setError(null);
    const path = `${provider.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]+/g, '_')}`;
    const { error: err } = await supabase.storage.from('provider-policies').upload(path, file, { upsert: true });
    setUploading(false);
    if (err) { setError(`Upload failed: ${err.message}`); return; }
    const { data } = supabase.storage.from('provider-policies').getPublicUrl(path);
    setForm((f) => ({ ...f, document_url: data.publicUrl }));
  }

  async function save() {
    if (!provider) return;
    if (!form.title.trim()) { setError('Give it a title parents will recognise.'); return; }
    setSaving(true);
    setError(null);
    const fields = {
      title: form.title.trim(),
      body: form.body.trim(),
      document_url: form.document_url.trim() || null,
      required: form.required,
      // Empty selection = provider-wide (applies to every class).
      activity_ids: form.activity_ids.length ? form.activity_ids : null,
    };
    const { error: err } = editingId
      ? await supabase.from('provider_policies').update(fields).eq('id', editingId)
      : await supabase.from('provider_policies').insert({ provider_id: provider.id, ...fields });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setForm(emptyForm);
    setShowForm(false);
    setEditingId(null);
    setActivityPickerOpen(false);
    load();
  }

  function startEdit(p: ProviderPolicy) {
    setEditingId(p.id);
    setShowForm(true);
    setError(null);
    setActivityPickerOpen(false);
    setForm({
      title: p.title,
      body: p.body ?? '',
      document_url: p.document_url ?? '',
      required: p.required,
      activity_ids: p.activity_ids ?? [],
    });
  }

  /* Deactivating rather than deleting: a policy that has already gated
     bookings is part of their record, and the acceptance rows point at it. */
  async function setActive(id: string, active: boolean) {
    await supabase.from('provider_policies').update({ active }).eq('id', id);
    load();
  }

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-pink-300';

  return (
    <>
      <div className="mb-5 flex flex-col items-center gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-col items-center gap-2 text-center sm:flex-row sm:items-center sm:gap-3 sm:text-left">
          <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center"><FileText className="w-5 h-5 text-amber-600" /></div>
          <div>
            <h3 className="font-semibold text-gray-900">Waivers &amp; consents</h3>
            <p className="text-xs text-gray-500">Parents accept these before their booking is confirmed</p>
          </div>
        </div>
        {canManage && !showForm && (
          <Button onClick={() => { setShowForm(true); setEditingId(null); setForm(emptyForm); setActivityPickerOpen(false); }} className="gradient-primary text-white rounded-xl hover:opacity-90">
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        )}
      </div>

      {policies.length === 0 && !showForm && (
        <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-600">
          Nothing added yet. Add a waiver, photo consent, health declaration or house rules and every parent must
          tick it before they can book.
        </p>
      )}

      <div className="space-y-3">
        {policies.map((p) => (
          <div key={p.id} className={cn('rounded-xl border p-4', p.active ? 'border-gray-200' : 'border-dashed border-gray-300 bg-gray-50 opacity-70')}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 text-center sm:text-left">
                <p className="font-medium text-gray-900">
                  {p.title}
                  <span className={cn('mx-auto mt-1 block w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold sm:mx-0 sm:ml-2 sm:mt-0 sm:inline', p.required ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600')}>
                    {p.required ? 'Required to book' : 'Optional'}
                  </span>
                  {!p.active && <span className="mx-auto mt-1 block w-fit rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold text-gray-600 sm:mx-0 sm:ml-2 sm:mt-0 sm:inline">Off</span>}
                </p>
                {canManage && (
                  <div className="mt-3 flex justify-center gap-2 sm:hidden">
                    <Button variant="outline" size="sm" className="rounded-lg" onClick={() => startEdit(p)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="outline" size="sm" className="rounded-lg" onClick={() => setActive(p.id, !p.active)}>
                      {p.active ? 'Turn off' : 'Turn on'}
                    </Button>
                  </div>
                )}
                <p className="mt-3 text-xs text-gray-500 sm:mt-1">
                  {!p.activity_ids || p.activity_ids.length === 0
                    ? 'All of your activities'
                    : p.activity_ids.length <= 2
                      ? `Only for ${p.activity_ids
                          .map((id) => activities.find((a) => a.id === id)?.title ?? 'one activity')
                          .join(' & ')}`
                      : `Only for ${p.activity_ids.length} activities`}
                </p>
                {p.body && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-600">{p.body}</p>}
                {p.document_url && (
                  <a href={p.document_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm font-medium text-[#FA4D8D] underline">
                    View uploaded document
                  </a>
                )}
              </div>
              {canManage && (
                <div className="hidden shrink-0 gap-2 sm:flex">
                  <Button variant="outline" size="sm" className="rounded-lg" onClick={() => startEdit(p)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="outline" size="sm" className="rounded-lg" onClick={() => setActive(p.id, !p.active)}>
                    {p.active ? 'Turn off' : 'Turn on'}
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {showForm && canManage && (
        <div className="mt-5 rounded-xl border border-gray-200 p-4">
          {error && <p className="mb-3 text-sm font-medium text-red-600">{error}</p>}
          <div className="space-y-3 mb-4">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Title</label>
              <input className={inputCls} placeholder="e.g. Liability waiver" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">What parents read</label>
              <textarea rows={4} className={inputCls} placeholder="The wording a parent ticks to accept." value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Applies to</label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setActivityPickerOpen((v) => !v)}
                  className={cn(inputCls, 'flex items-center justify-between gap-2 text-left')}
                  aria-label="Applies to"
                >
                  <span className="truncate">
                    {form.activity_ids.length === 0
                      ? 'All of my activities'
                      : form.activity_ids.length <= 2
                        ? form.activity_ids.map((id) => activities.find((a) => a.id === id)?.title ?? '').join(' & ')
                        : `${form.activity_ids.length} activities selected`}
                  </span>
                  <ChevronDown className="h-4 w-4 flex-shrink-0 text-gray-400" />
                </button>
                {activityPickerOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setActivityPickerOpen(false)} />
                    <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[#FA4D8D]"
                          checked={form.activity_ids.length === 0}
                          onChange={() => setForm({ ...form, activity_ids: [] })}
                        />
                        All of my activities
                      </label>
                      {activities.length > 0 && <div className="my-1 border-t border-gray-100" />}
                      {activities.map((a) => (
                        <label key={a.id} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[#FA4D8D]"
                            checked={form.activity_ids.includes(a.id)}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                activity_ids: e.target.checked
                                  ? [...form.activity_ids, a.id]
                                  : form.activity_ids.filter((id) => id !== a.id),
                              })
                            }
                          />
                          <span className="truncate">{a.title}</span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <p className="mt-1 text-[11px] text-gray-400">Leave as “All of my activities”, or tick the specific classes this applies to.</p>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Document (optional)</label>
              <div className="flex items-center gap-3">
                <label className="cursor-pointer rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  <ImageUp className="mr-1 inline w-4 h-4" />
                  {uploading ? 'Uploading…' : 'Upload PDF'}
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadDocument(f); }}
                  />
                </label>
                {form.document_url && (
                  <a href={form.document_url} target="_blank" rel="noreferrer" className="text-sm font-medium text-[#FA4D8D] underline">Uploaded ✓</a>
                )}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} className="h-4 w-4 accent-[#FA4D8D]" />
              Parents must accept this before they can book
            </label>
          </div>
          <div className="flex gap-2">
            <Button onClick={save} disabled={saving || !form.title.trim()} className="gradient-primary text-white rounded-xl hover:opacity-90 px-5">
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add'}
            </Button>
            <Button variant="outline" onClick={() => { setShowForm(false); setEditingId(null); setError(null); setActivityPickerOpen(false); }} className="rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50">Cancel</Button>
          </div>
        </div>
      )}
    </>
  );
}
