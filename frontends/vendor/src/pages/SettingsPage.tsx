import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  User, MapPin, Users, Shield, Store, Pencil, FileText, ImageUp, Globe, Mail, Phone, MessageCircle, Hash,
  CheckCircle, Clock, CreditCard, MessageSquare, Star, HelpCircle, Plus, Trash2, X, Save,
  Plug, Eye, EyeOff, ExternalLink, RefreshCw, LogOut, Calendar,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { apiPost, apiGet, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import type { ProviderLocation, ProviderPolicy, VendorCategory } from '@/lib/database.types';

const settingsTabs = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'locations', label: 'Locations', icon: MapPin },
  { id: 'team', label: 'Team', icon: Users },
  // QA: "each vendor will have their own consents, waivers, disclosures they
  // want accepted so need a way to make this bespoke" + "there needs to be an
  // option to toggle on and upload the relevant material".
  { id: 'policies', label: 'Waivers & Consents', icon: FileText },
  { id: 'compliance', label: 'Compliance', icon: Shield },
  { id: 'integrations', label: 'Integrate your Business', icon: Plug },
];

const VENDOR_CATEGORIES: { value: VendorCategory; label: string }[] = [
  { value: 'baby-toddler-classes', label: 'Baby & Toddler Classes' },
  { value: 'playspaces', label: 'Playspaces' },
  { value: 'camps-holiday', label: 'Camps & Holiday Programmes' },
  { value: 'community-events', label: 'Community Events' },
  { value: 'mum-bub-exercise', label: 'Parent & Child Exercise' },
  { value: 'other', label: 'Other' },
];

// Compliance acceptances aren't modelled as a table in the MVP backend — kept static.
const complianceItems = [
  { icon: FileText, label: 'Vendor Terms', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true },
  { icon: Clock, label: 'PDPA Acknowledgement', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true },
  { icon: Store, label: 'Child Photo Consent Warranty', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true },
  { icon: Shield, label: 'Review Policy', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true },
  { icon: CreditCard, label: 'Refund Policy', status: 'Edit', statusColor: 'text-blue-600', bg: 'bg-blue-100', accepted: false },
  { icon: MessageSquare, label: 'Messaging Rules', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true },
  { icon: Star, label: 'Featured Placement Disclosure', status: 'N/A until Boost', statusColor: 'text-gray-500', bg: 'bg-gray-100', accepted: false },
];

type Member = { id: string; user_id: string; role: string; invited_email: string | null; status: string };

const emptyProfileForm = {
  business_name: '', vendor_category: '' as VendorCategory | '', description: '',
  logo_url: '', contact_phone: '', contact_email: '', whatsapp: '', website: '',
  address: '', postal_code: '', uen: '',
};

export default function SettingsPage() {
  const { provider, role, session, refreshProvider, signOut } = useAuth();
  const canManage = role === 'owner' || role === 'manager';

  /* Deep-linkable: "Add a Location" on the dashboard and the Locations tab in
     Activities both land here and should highlight Locations, not Profile. */
  const [searchParams, setSearchParams] = useSearchParams();
  const wanted = (searchParams.get('tab') || '').toLowerCase();
  const [activeTab, setActiveTab] = useState(
    settingsTabs.some((t) => t.id === wanted) ? wanted : 'profile'
  );
  useEffect(() => {
    if (settingsTabs.some((t) => t.id === wanted) && wanted !== activeTab) setActiveTab(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  const selectTab = (id: string) => {
    setActiveTab(id);
    setSearchParams(id === 'profile' ? {} : { tab: id }, { replace: true });
  };

  // "Add a Location" (dashboard) deep-links with ?new=location so the
  // add-location form opens immediately instead of just landing on the tab.
  const wantsNewLocation = searchParams.get('new') === 'location';

  const [team, setTeam] = useState<Member[]>([]);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [form, setForm] = useState(emptyProfileForm);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'manager' | 'staff'>('staff');
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const isOwner = role === 'owner';

  useEffect(() => {
    if (!provider) return;
    setForm({
      business_name: provider.business_name ?? '',
      vendor_category: (provider.vendor_category ?? '') as VendorCategory | '',
      description: provider.description ?? '',
      logo_url: provider.logo_url ?? '',
      contact_phone: provider.contact_phone ?? '',
      contact_email: provider.contact_email ?? '',
      whatsapp: provider.whatsapp ?? '',
      website: provider.website ?? '',
      address: provider.address ?? '',
      postal_code: provider.postal_code ?? '',
      uen: provider.uen ?? '',
    });
    supabase.from('provider_members').select('id, user_id, role, invited_email, status').eq('provider_id', provider.id)
      .then(({ data }) => setTeam((data as Member[]) ?? []));
  }, [provider]);

  async function uploadLogo(file: File) {
    if (!provider) return;
    setUploadingLogo(true);
    setProfileError(null);
    const path = `${provider.id}/logo-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]+/g, '_')}`;
    const { error } = await supabase.storage.from('activity-images').upload(path, file, { upsert: true });
    setUploadingLogo(false);
    if (error) { setProfileError(`Logo upload failed: ${error.message}`); return; }
    const { data } = supabase.storage.from('activity-images').getPublicUrl(path);
    setForm((f) => ({ ...f, logo_url: data.publicUrl }));
  }

  async function saveProfile() {
    if (!provider) return;
    setSaving(true);
    setSaved(false);
    setProfileError(null);
    const { error } = await supabase.from('providers').update({
      business_name: form.business_name,
      vendor_category: form.vendor_category || null,
      description: form.description,
      logo_url: form.logo_url || null,
      contact_phone: form.contact_phone || null,
      contact_email: form.contact_email || null,
      whatsapp: form.whatsapp || null,
      website: form.website || null,
      address: form.address || null,
      postal_code: form.postal_code || null,
      uen: form.uen || null,
    }).eq('id', provider.id);
    setSaving(false);
    if (error) { setProfileError(error.message); return; }
    setSaved(true);
    setIsEditingProfile(false);
    await refreshProvider();
    window.setTimeout(() => setSaved(false), 4000);
  }

  function cancelEditProfile() {
    if (provider) {
      setForm({
        business_name: provider.business_name ?? '',
        vendor_category: (provider.vendor_category ?? '') as VendorCategory | '',
        description: provider.description ?? '',
        logo_url: provider.logo_url ?? '',
        contact_phone: provider.contact_phone ?? '',
        contact_email: provider.contact_email ?? '',
        whatsapp: provider.whatsapp ?? '',
        website: provider.website ?? '',
        address: provider.address ?? '',
        postal_code: provider.postal_code ?? '',
        uen: provider.uen ?? '',
      });
    }
    setProfileError(null);
    setIsEditingProfile(false);
  }

  async function inviteMember() {
    if (!provider || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteMsg(null);
    try {
      const res = await apiPost<{ ok: boolean; linked: boolean }>('/api/vendor/staff/invite', {
        provider_id: provider.id,
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setInviteMsg({
        ok: true,
        text: res.linked
          ? 'Added to your team — they already have an account.'
          : 'Invite sent. They join automatically when they sign up with this email.',
      });
      setInviteEmail('');
      const { data } = await supabase
        .from('provider_members')
        .select('id, user_id, role, invited_email, status')
        .eq('provider_id', provider.id);
      setTeam((data as Member[]) ?? []);
    } catch (e) {
      setInviteMsg({ ok: false, text: e instanceof Error ? e.message : 'Invite failed' });
    } finally {
      setInviting(false);
    }
  }

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-pink-300';
  const categoryLabel = VENDOR_CATEGORIES.find((c) => c.value === form.vendor_category)?.label;

  return (
    <div className="relative">
      <div className="flex items-center justify-between px-8 py-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your business profile, locations, team and compliance.</p>
        </div>
        <Button
          variant="outline"
          onClick={() => signOut()}
          className="gap-2 rounded-full border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </Button>
      </div>

      <div className="px-8 pb-8">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6 w-fit">
          {settingsTabs.map((tab) => (
            <button key={tab.id} onClick={() => selectTab(tab.id)}
              className={cn('flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
                activeTab === tab.id ? 'bg-white text-[#C90044] shadow-sm' : 'text-gray-600 hover:text-gray-900')}>
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Profile — everything that shows on the public listing, in one
            detailed page. View mode by default; the pencil switches to edit. */}
        {activeTab === 'profile' && (
          <div className="max-w-3xl bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-start justify-between mb-6">
              <div className="flex items-center gap-4">
                <div className="relative w-20 h-20 rounded-2xl bg-pink-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                  {form.logo_url ? <img src={form.logo_url} alt="" className="w-full h-full object-cover" /> : <Store className="w-9 h-9 text-[#C90044]" />}
                  {isEditingProfile && (
                    <label className={cn('absolute inset-0 flex items-center justify-center bg-black/40 text-white cursor-pointer', uploadingLogo && 'opacity-70 pointer-events-none')}>
                      <ImageUp className="w-5 h-5" />
                      <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); }} />
                    </label>
                  )}
                </div>
                <div>
                  <h3 className="text-xl font-bold text-gray-900">{form.business_name || 'Your business'}</h3>
                  {categoryLabel && <p className="text-sm text-gray-500">{categoryLabel}</p>}
                  <div className="flex items-center gap-2 mt-1.5">
                    <Progress value={completion(form)} className="w-32 h-2" />
                    <span className="text-xs font-semibold text-gray-500">{completion(form)}% complete</span>
                  </div>
                </div>
              </div>
              {canManage && !isEditingProfile && (
                <button onClick={() => setIsEditingProfile(true)} title="Edit profile" className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
              )}
            </div>

            {profileError && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{profileError}</div>}

            {!isEditingProfile ? (
              <div className="space-y-6">
                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">About</h4>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{form.description || <span className="text-gray-400">No description yet.</span>}</p>
                </section>
                <section className="grid grid-cols-2 gap-4">
                  <ReadField icon={Phone} label="Phone" value={form.contact_phone} />
                  <ReadField icon={Mail} label="Email" value={form.contact_email} />
                  <ReadField icon={MessageCircle} label="WhatsApp" value={form.whatsapp} />
                  <ReadField icon={Globe} label="Website" value={form.website} />
                </section>
                <section className="grid grid-cols-2 gap-4">
                  <ReadField icon={MapPin} label="Address" value={form.address} />
                  <ReadField icon={Hash} label="UEN" value={form.uen} />
                </section>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Business Name</label>
                    <input className={inputCls} value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Category</label>
                    <select className={inputCls} value={form.vendor_category} onChange={(e) => setForm({ ...form, vendor_category: e.target.value as VendorCategory })}>
                      <option value="">Select a category</option>
                      {VENDOR_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Business Description</label>
                  <textarea rows={3} className={cn(inputCls, 'resize-none')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Phone Number</label>
                    <input className={inputCls} value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Email</label>
                    <input className={inputCls} value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">WhatsApp</label>
                    <input className={inputCls} value={form.whatsapp} onChange={(e) => setForm({ ...form, whatsapp: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Website</label>
                    <input className={inputCls} value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Address</label>
                    <input className={inputCls} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">UEN</label>
                    <input className={inputCls} value={form.uen} onChange={(e) => setForm({ ...form, uen: e.target.value })} />
                  </div>
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <Button onClick={saveProfile} disabled={saving} className="gradient-primary text-white rounded-xl hover:opacity-90 px-6 gap-2">
                    <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save Changes'}
                  </Button>
                  <Button variant="outline" onClick={cancelEditProfile} className="rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50 gap-2">
                    <X className="w-4 h-4" /> Cancel
                  </Button>
                </div>
              </div>
            )}
            {saved && <p className="mt-3 text-sm font-medium text-green-600">Saved ✓</p>}
          </div>
        )}

        {activeTab === 'locations' && (
          <div className="max-w-2xl bg-white rounded-xl border border-gray-200 p-6">
            <LocationsManager provider={provider} canManage={canManage} openOnMount={wantsNewLocation} onOpened={() => setSearchParams({ tab: 'locations' }, { replace: true })} />
          </div>
        )}

        {activeTab === 'policies' && (
          <div className="max-w-2xl bg-white rounded-xl border border-gray-200 p-6">
            <PoliciesManager provider={provider} canManage={canManage} />
          </div>
        )}

        {activeTab === 'team' && (
          <div className="max-w-2xl bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center"><Users className="w-5 h-5 text-green-600" /></div>
              <div>
                <h3 className="font-semibold text-gray-900">Team Members</h3>
                <p className="text-xs text-gray-500">{team.length} Team Member{team.length === 1 ? '' : 's'}</p>
              </div>
            </div>
            <div className="space-y-3 mb-5">
              {team.map((m) => {
                const isYou = m.user_id === session?.user.id;
                const label = isYou ? 'You' : m.invited_email ?? 'Member';
                return (
                  <div key={m.id} className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold bg-green-300 text-green-800">
                      {(label[0] ?? '?').toUpperCase()}
                    </div>
                    <div className="flex-1"><div className="text-sm font-medium text-gray-900 truncate">{label}</div></div>
                    <span className={cn('px-2 py-0.5 text-xs rounded-full capitalize',
                      m.role === 'owner' ? 'bg-green-300 text-green-800' : m.role === 'manager' ? 'bg-purple-300 text-purple-800' : 'bg-blue-300 text-blue-800')}>
                      {m.role}
                    </span>
                  </div>
                );
              })}
              {team.length === 0 && <div className="text-sm text-gray-400">No team members yet.</div>}
            </div>
            {isOwner ? (
              <div className="border-t border-gray-100 pt-4">
                <label className="text-xs font-medium text-gray-500 mb-2 block">Invite a team member</label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="email"
                    placeholder="name@email.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-green-300"
                  />
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as 'manager' | 'staff')}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white">
                    <option value="staff">Staff</option>
                    <option value="manager">Manager</option>
                  </select>
                  <button
                    onClick={inviteMember}
                    disabled={inviting || !inviteEmail.trim()}
                    className="flex items-center justify-center gap-1 px-4 py-2 bg-green-600 rounded-xl text-xs font-medium text-white disabled:opacity-50">
                    <Users className="w-3 h-3" /> {inviting ? 'Inviting…' : 'Invite'}
                  </button>
                </div>
                {inviteMsg && (
                  <p className={cn('text-xs mt-2', inviteMsg.ok ? 'text-green-600' : 'text-red-600')}>{inviteMsg.text}</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-gray-400 text-center">Only the business owner can invite team members.</p>
            )}
          </div>
        )}

        {activeTab === 'compliance' && (
          <div className="max-w-2xl bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center"><Shield className="w-5 h-5 text-purple-600" /></div>
              <div>
                <h3 className="font-semibold text-gray-900">Compliance</h3>
                <p className="text-xs text-gray-500">Keep your profile compliant and up to date.</p>
              </div>
            </div>
            <div className="space-y-3">
              {complianceItems.map((item, idx) => (
                <div key={idx} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                  <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', item.bg)}><item.icon className={cn('w-4 h-4', item.statusColor)} /></div>
                  <div className="flex-1"><div className="text-sm font-medium text-gray-900">{item.label}</div></div>
                  {item.accepted ? (
                    <span className="flex items-center gap-1 px-2 py-1 bg-green-300 text-green-800 text-xs rounded-full"><CheckCircle className="w-3 h-3" />Accepted</span>
                  ) : item.status === 'Edit' ? (
                    <button className="flex items-center gap-1 px-3 py-1.5 border border-blue-300 rounded-lg text-xs text-blue-600 hover:bg-blue-50"><Pencil className="w-3 h-3" />Edit</button>
                  ) : (
                    <span className="flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-500 text-xs rounded-full"><HelpCircle className="w-3 h-3" />{item.status}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'integrations' && (
          <div className="max-w-2xl bg-white rounded-xl border border-gray-200 p-6">
            <WixIntegrationManager provider={provider} canManage={canManage} />
          </div>
        )}
      </div>
    </div>
  );
}

type WixStatus = {
  connected: boolean;
  wix_site_id?: string;
  wix_api_key_preview?: string;
  updated_at?: string;
};

type WixServiceOption = {
  id: string;
  name: string;
  type: string;
  importable: boolean;
  reason: string | null;
  alreadyImported: boolean;
};

/** Settings -> Integrate your Business. A vendor connects their own Wix
 *  account (API key + site ID) so their Schedule calendar, availability and
 *  bookings sync against their own Wix Bookings data instead of a shared
 *  one. The key is never sent to the browser on page load — only a masked
 *  preview — and the eye button fetches the full value on demand via a
 *  separate, explicitly-called route. */
function WixIntegrationManager({
  provider, canManage,
}: {
  provider: { id: string } | null; canManage: boolean;
}) {
  const [status, setStatus] = useState<WixStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [siteId, setSiteId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [eventsSyncing, setEventsSyncing] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventsNotice, setEventsNotice] = useState<string | null>(null);

  // "Import specific activities" — lets a vendor pick which Wix services
  // become activities, instead of "Sync services" bringing in everything.
  // `selectedIds` is the live checkbox state; `baselineIds` is what was
  // actually imported as of the last load — the diff between the two is
  // what "Save" sends and what drives the "you have unsaved changes" notice.
  const [wixServices, setWixServices] = useState<WixServiceOption[] | null>(null);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [baselineIds, setBaselineIds] = useState<Set<string>>(new Set());
  const [importSaving, setImportSaving] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  // A 401 here almost always means the browser's session has quietly
  // expired (long-lived tab, refresh token aged out) — "Not authenticated"
  // on its own reads like a permissions bug, so point the vendor at the fix
  // (sign out/in) and an escape hatch if that doesn't clear it up.
  function describeWixError(e: unknown, fallback: string): string {
    if (e instanceof ApiError && e.status === 401) {
      return 'Your session has expired. Please sign out and sign back in — if this keeps happening, contact support.';
    }
    return e instanceof Error ? e.message : fallback;
  }

  function summarizeSync(sync: { created: number; updated: number; skipped: { name: string; reason: string }[]; removed?: number; revived?: number; unlinked?: number }) {
    const parts = [];
    if (sync.created) parts.push(`${sync.created} new`);
    if (sync.updated) parts.push(`${sync.updated} updated`);
    if (sync.revived) parts.push(`${sync.revived} restored`);
    if (sync.removed) parts.push(`${sync.removed} removed`);
    if (sync.unlinked) parts.push(`${sync.unlinked} unlinked`);
    if (!sync.created && !sync.updated && !sync.removed && !sync.revived && !sync.unlinked) parts.push('nothing new');
    let text = `Synced from Wix: ${parts.join(', ')}.`;
    if (sync.skipped.length) {
      text += ` ${sync.skipped.length} skipped — ${sync.skipped.map((s) => `"${s.name}" (${s.reason})`).join('; ')}.`;
    }
    return text;
  }

  async function load() {
    if (!provider) return;
    setLoading(true);
    try {
      const s = await apiGet<WixStatus>(`/api/vendor/wix-integration?providerId=${provider.id}`);
      setStatus(s);
      setEditing(!s.connected);
      setSiteId(s.wix_site_id ?? '');
      setRevealedKey(null);
    } catch (e) {
      setError(describeWixError(e, 'Could not load Wix integration status'));
      // Status is unknown, not necessarily "connected" — still let a manager
      // attempt to (re)connect rather than leaving them with a dead end.
      setEditing(true);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [provider]);

  async function save() {
    if (!provider || !siteId.trim() || !apiKey.trim()) {
      setError('Both the API key and site ID are required.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiPost<{ sync: { created: number; updated: number; skipped: { name: string; reason: string }[]; removed: number; revived: number } }>(
        '/api/vendor/wix-integration',
        { provider_id: provider.id, wix_site_id: siteId.trim(), wix_api_key: apiKey.trim() }
      );
      setApiKey('');
      setShowKey(false);
      setNotice(`Wix account connected. ${summarizeSync(res.sync)}`);
      await load();
    } catch (e) {
      setError(describeWixError(e, 'Could not save these credentials'));
    } finally {
      setSaving(false);
    }
  }

  async function syncServices() {
    if (!provider) return;
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiPost<{ sync: { created: number; updated: number; skipped: { name: string; reason: string }[]; removed: number; revived: number } }>(
        '/api/vendor/wix-services-sync',
        { provider_id: provider.id }
      );
      setNotice(summarizeSync(res.sync));
    } catch (e) {
      setError(describeWixError(e, 'Could not sync services'));
    } finally {
      setSyncing(false);
    }
  }

  // Wix Events & Tickets — a separate app/API from Bookings (see
  // lib/wix/events-sync.ts), so this is deliberately a second, independent
  // sync action rather than folded into "Sync services" above: a vendor
  // connected for Bookings only won't have the Events app installed at all,
  // and this call just reports that back rather than erroring.
  function summarizeEventSync(sync: { created: number; updated: number; removed: number; revived: number; ticketPricingSkipped: string[]; eventsAppNotInstalled: boolean }) {
    if (sync.eventsAppNotInstalled) {
      return 'This Wix account doesn’t have the Events & Tickets app installed, so there’s nothing to sync yet.';
    }
    const parts = [];
    if (sync.created) parts.push(`${sync.created} new`);
    if (sync.updated) parts.push(`${sync.updated} updated`);
    if (sync.revived) parts.push(`${sync.revived} restored`);
    if (sync.removed) parts.push(`${sync.removed} removed`);
    if (!sync.created && !sync.updated && !sync.removed && !sync.revived) parts.push('nothing new');
    let text = `Synced from Wix Events: ${parts.join(', ')}.`;
    if (sync.ticketPricingSkipped.length) {
      text += ` Ticket pricing couldn’t be read for: ${sync.ticketPricingSkipped.join(', ')}.`;
    }
    return text;
  }

  async function syncEvents() {
    if (!provider) return;
    setEventsSyncing(true);
    setEventsError(null);
    setEventsNotice(null);
    try {
      const res = await apiPost<{ sync: { created: number; updated: number; removed: number; revived: number; ticketPricingSkipped: string[]; eventsAppNotInstalled: boolean } }>(
        '/api/vendor/wix-events-sync',
        { provider_id: provider.id }
      );
      setEventsNotice(summarizeEventSync(res.sync));
    } catch (e) {
      setEventsError(describeWixError(e, 'Could not sync events'));
    } finally {
      setEventsSyncing(false);
    }
  }

  async function toggleReveal() {
    if (revealedKey) { setRevealedKey(null); return; }
    if (!provider) return;
    setRevealing(true);
    setError(null);
    try {
      const { wix_api_key } = await apiGet<{ wix_api_key: string }>(`/api/vendor/wix-integration/reveal?providerId=${provider.id}`);
      setRevealedKey(wix_api_key);
    } catch (e) {
      setError(describeWixError(e, 'Could not reveal the key'));
    } finally {
      setRevealing(false);
    }
  }

  async function loadServices() {
    if (!provider) return;
    setServicesLoading(true);
    setImportError(null);
    try {
      const res = await apiGet<{ services: WixServiceOption[] }>(`/api/vendor/wix-services?providerId=${provider.id}`);
      setWixServices(res.services);
      const imported = new Set(res.services.filter((s) => s.alreadyImported).map((s) => s.id));
      setSelectedIds(imported);
      setBaselineIds(imported);
    } catch (e) {
      setImportError(describeWixError(e, 'Could not load Wix services'));
    } finally {
      setServicesLoading(false);
    }
  }
  useEffect(() => {
    // Independent of the credentials card's `editing` state — this box
    // loads and stays visible purely off whether Wix is connected, so
    // clicking "Change key" doesn't yank it away.
    if (status?.connected) loadServices();
    // eslint-disable-next-line
  }, [status?.connected]);

  function toggleSelected(id: string) {
    setImportNotice(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const hasSelectionChanges =
    selectedIds.size !== baselineIds.size || [...selectedIds].some((id) => !baselineIds.has(id));

  async function saveImport() {
    if (!provider || !hasSelectionChanges) return;
    setImportSaving(true);
    setImportError(null);
    setImportNotice(null);
    try {
      const res = await apiPost<{ sync: { created: number; updated: number; skipped: { name: string; reason: string }[]; removed: number; revived: number; unlinked: number } }>(
        '/api/vendor/wix-services-import',
        { provider_id: provider.id, service_ids: Array.from(selectedIds) }
      );
      setImportNotice(summarizeSync(res.sync));
      await loadServices();
    } catch (e) {
      setImportError(describeWixError(e, 'Could not import the selected activities'));
    } finally {
      setImportSaving(false);
    }
  }

  // Credential fields get a visibly heavier border than an ordinary text
  // input — these hold a secret and a site identifier, not "just a field".
  const inputCls = 'w-full px-3.5 py-2.5 border-2 border-indigo-200 bg-indigo-50/30 rounded-lg text-sm font-mono shadow-sm transition-colors focus:outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100';
  const readOnlyCls = 'w-full px-3.5 py-2.5 border-2 border-gray-200 bg-gray-50 rounded-lg text-sm font-mono text-gray-700';

  return (
    <>
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center"><Plug className="w-5 h-5 text-indigo-600" /></div>
        <div>
          <h3 className="font-semibold text-gray-900">WIX Integration</h3>
          <p className="text-xs text-gray-500">Connect your own Wix Bookings account to sync availability and bookings.</p>
        </div>
      </div>

      {loading && <div className="mt-5 text-sm text-gray-400">Loading…</div>}

      {!loading && (
        <div className="mt-5">
          {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {notice && <div className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div>}

          {status?.connected && !editing && (
            <div className="rounded-xl border border-gray-200 p-4 space-y-4">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">
                  <CheckCircle className="w-3.5 h-3.5" /> Connected
                </span>
                {status.updated_at && (
                  <span className="text-xs text-gray-400">since {new Date(status.updated_at).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' })}</span>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Site ID</label>
                <div className={readOnlyCls}>{status.wix_site_id}</div>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">API Key</label>
                <div className="flex items-center gap-2">
                  <div className={cn(readOnlyCls, 'flex-1 truncate')}>
                    {revealedKey ?? status.wix_api_key_preview}
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      onClick={toggleReveal}
                      disabled={revealing}
                      title={revealedKey ? 'Hide key' : 'Show full key'}
                      className="flex-shrink-0 grid h-9 w-9 place-items-center rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {revealedKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  )}
                </div>
              </div>
              {canManage && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button onClick={syncServices} disabled={syncing} className="gradient-primary text-white rounded-xl hover:opacity-90 gap-2">
                    <RefreshCw className={cn('w-3.5 h-3.5', syncing && 'animate-spin')} /> {syncing ? 'Syncing…' : 'Sync services'}
                  </Button>
                  <Button variant="outline" onClick={() => { setEditing(true); setRevealedKey(null); }} className="rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50 gap-2">
                    <Pencil className="w-3.5 h-3.5" /> Change key
                  </Button>
                </div>
              )}
              <p className="text-xs text-gray-400">
                Every service, class and appointment on this Wix account becomes an activity here — new ones land
                unpublished until you fill in a category, age range and price.
              </p>
              <a
                href="https://support.wix.com/en/article/about-api-keys"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-[#C90044] hover:underline"
              >
                More on Wix API keys <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}

          {status?.connected && canManage && (
            <div className="mt-5 rounded-xl border border-gray-200 p-4 space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-gray-900">Import specific activities</h4>
                <p className="text-xs text-gray-500">Choose which Wix services should become activities on BabyBrain, then save.</p>
              </div>

              {importError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{importError}</div>}
              {importNotice && <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{importNotice}</div>}
              {!importNotice && hasSelectionChanges && (
                <div className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
                  The changes will reflect on Activities page
                </div>
              )}

              {servicesLoading && <div className="text-sm text-gray-400">Loading Wix services…</div>}

              {!servicesLoading && wixServices && wixServices.length === 0 && (
                <p className="text-sm text-gray-400">No services found on this Wix account.</p>
              )}

              {!servicesLoading && wixServices && wixServices.length > 0 && (
                <>
                  <div className="space-y-2 max-h-72 overflow-y-auto">
                    {wixServices.map((s) => (
                      <label
                        key={s.id}
                        className={cn(
                          'flex items-center gap-3 p-3 rounded-xl border',
                          s.alreadyImported
                            ? 'bg-green-50 border-green-100'
                            : s.importable
                              ? 'bg-gray-50 border-gray-100 cursor-pointer hover:bg-gray-100'
                              : 'bg-gray-50 border-gray-100 opacity-60 cursor-not-allowed'
                        )}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 flex-shrink-0 rounded border-gray-300 text-pink-500 focus:ring-pink-300"
                          checked={selectedIds.has(s.id)}
                          disabled={!s.importable}
                          onChange={() => toggleSelected(s.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-800 truncate">{s.name}</div>
                          <div className="text-xs text-gray-400">{s.type}{s.reason ? ` — ${s.reason}` : ''}</div>
                        </div>
                        {s.alreadyImported && (
                          <span className="flex-shrink-0 text-xs font-semibold text-green-700">Imported</span>
                        )}
                      </label>
                    ))}
                  </div>

                  <Button
                    onClick={saveImport}
                    disabled={importSaving || !hasSelectionChanges}
                    className="gradient-primary text-white rounded-xl hover:opacity-90 gap-2"
                  >
                    <Save className="w-4 h-4" /> {importSaving ? 'Saving…' : 'Save'}
                  </Button>
                </>
              )}
            </div>
          )}

          {status?.connected && canManage && (
            <div className="mt-5 rounded-xl border border-gray-200 p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center flex-shrink-0"><Calendar className="w-5 h-5 text-indigo-600" /></div>
                <div>
                  <h4 className="text-sm font-semibold text-gray-900">Wix Events &amp; Tickets</h4>
                  <p className="text-xs text-gray-500">A separate Wix app from Bookings — one-off events with ticket types become activities here too.</p>
                </div>
              </div>

              {eventsError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{eventsError}</div>}
              {eventsNotice && <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{eventsNotice}</div>}

              <Button onClick={syncEvents} disabled={eventsSyncing} className="gradient-primary text-white rounded-xl hover:opacity-90 gap-2">
                <RefreshCw className={cn('w-3.5 h-3.5', eventsSyncing && 'animate-spin')} /> {eventsSyncing ? 'Syncing…' : 'Sync Wix Events'}
              </Button>
              <p className="text-xs text-gray-400">
                Every upcoming event on this Wix account (with the Events &amp; Tickets app installed) becomes an
                activity here — new ones land unpublished until you fill in a category and age range, same as
                imported services.
              </p>
            </div>
          )}

          {!status?.connected && !canManage && (
            <p className="text-sm text-gray-400">This business hasn't connected a Wix account yet. Ask an owner or manager to set it up.</p>
          )}

          {editing && canManage && (
            <div className="rounded-xl border border-gray-200 p-4 space-y-5">
              <div>
                <label className="text-sm font-semibold text-gray-800 mb-1.5 block">Wix API Key</label>
                <div className="flex items-center gap-2">
                  <input
                    type={showKey ? 'text' : 'password'}
                    className={cn(inputCls, 'flex-1')}
                    placeholder="IST.eyJra..."
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    title={showKey ? 'Hide' : 'Show'}
                    className="flex-shrink-0 grid h-9 w-9 place-items-center rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                  >
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-gray-500">
                  In your Wix dashboard: <strong>Settings → API Keys</strong> → Generate API Key. Give it Bookings
                  permissions (read + write), then copy the key immediately — Wix only shows it once.
                </p>
              </div>

              <div>
                <label className="text-sm font-semibold text-gray-800 mb-1.5 block">Wix Site ID</label>
                <input
                  type="text"
                  className={inputCls}
                  placeholder="e.g. a240b75d-88bb-414a-bf15-01f112022e66"
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  autoComplete="off"
                />
                <p className="mt-1.5 text-xs text-gray-500">
                  Open your Wix dashboard and look at the browser's address bar — it follows this pattern:
                </p>
                <p className="mt-1 rounded-lg bg-gray-50 px-2.5 py-1.5 text-xs font-mono text-gray-700">
                  wix.com/dashboard/<span className="font-bold text-[#C90044]">SITE_ID</span>/home
                </p>
                <p className="mt-1.5 text-xs text-gray-500">
                  Copy just the <span className="font-bold text-[#C90044]">SITE_ID</span> part — the segment between{' '}
                  <span className="font-mono">/dashboard/</span> and <span className="font-mono">/home</span> — and
                  paste it above.
                </p>
              </div>

              <div className="flex gap-2 pt-1">
                <Button onClick={save} disabled={saving || !siteId.trim() || !apiKey.trim()} className="gradient-primary text-white rounded-xl hover:opacity-90 px-5 gap-2">
                  <Save className="w-4 h-4" /> {saving ? 'Connecting…' : 'Save & connect'}
                </Button>
                {status?.connected && (
                  <Button variant="outline" onClick={() => { setEditing(false); setApiKey(''); setError(null); }} className="rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50">
                    Cancel
                  </Button>
                )}
              </div>

              <a
                href="https://support.wix.com/en/article/about-api-keys"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-[#C90044] hover:underline"
              >
                More on Wix API keys <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ReadField({ icon: Icon, label, value }: { icon: typeof MapPin; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400" />
      <div className="min-w-0">
        <div className="text-xs text-gray-400">{label}</div>
        <div className="text-sm text-gray-900 truncate">{value || <span className="text-gray-400">Not set</span>}</div>
      </div>
    </div>
  );
}

function completion(f: { business_name: string; contact_phone: string; contact_email: string; website: string; description: string }) {
  const fields = [f.business_name, f.contact_phone, f.contact_email, f.website, f.description];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100);
}

/** Live locations list + add/remove/edit form, shared by the Locations tab. */
function LocationsManager({
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
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center"><MapPin className="w-5 h-5 text-purple-600" /></div>
          <div>
            <h3 className="font-semibold text-gray-900">Locations</h3>
            <p className="text-xs text-gray-500">{locations.length} Active Location{locations.length === 1 ? '' : 's'}</p>
          </div>
        </div>
        {canManage && !showForm && (
          <div className="flex items-center gap-2">
            <button onClick={openWixPicker} className="flex items-center gap-1 px-3 py-1.5 border border-gray-200 text-gray-700 rounded-lg text-xs font-medium hover:bg-gray-50">
              <RefreshCw className="w-3.5 h-3.5" /> Fetch from Wix
            </button>
            <button onClick={() => setShowForm(true)} className="flex items-center gap-1 px-3 py-1.5 bg-pink-50 text-[#C90044] rounded-lg text-xs font-medium hover:bg-pink-100">
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
          {wixLoading && <div className="text-sm text-gray-400">Loading Wix locations…</div>}

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
              <div className="grid grid-cols-2 gap-2">
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
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-pink-100 text-[#C90044]"><Store className="w-5 h-5" /></div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-gray-900 text-sm">{loc.name}</div>
              <div className="text-xs text-gray-500 truncate">
                {loc.is_primary ? 'Main Branch' : 'Branch'}{loc.address ? ` · ${loc.address}` : ''}
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
            <label className="text-xs text-gray-500 mb-1 block">Location name <span className="text-[#C90044]">*</span></label>
            <input className={inputCls} placeholder="e.g. Suntec City Studio" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
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
 */
function PoliciesManager({
  provider, canManage,
}: {
  provider: { id: string } | null; canManage: boolean;
}) {
  const [policies, setPolicies] = useState<ProviderPolicy[]>([]);
  const [activities, setActivities] = useState<{ id: string; title: string }[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const emptyForm = { title: '', body: '', document_url: '', required: true, activity_id: '' };
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
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
      activity_id: form.activity_id || null,
    };
    const { error: err } = editingId
      ? await supabase.from('provider_policies').update(fields).eq('id', editingId)
      : await supabase.from('provider_policies').insert({ provider_id: provider.id, ...fields });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setForm(emptyForm);
    setShowForm(false);
    setEditingId(null);
    load();
  }

  function startEdit(p: ProviderPolicy) {
    setEditingId(p.id);
    setShowForm(true);
    setError(null);
    setForm({
      title: p.title,
      body: p.body ?? '',
      document_url: p.document_url ?? '',
      required: p.required,
      activity_id: p.activity_id ?? '',
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
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center"><FileText className="w-5 h-5 text-amber-600" /></div>
          <div>
            <h3 className="font-semibold text-gray-900">Waivers &amp; Consents</h3>
            <p className="text-xs text-gray-500">Parents accept these before their booking is confirmed</p>
          </div>
        </div>
        {canManage && !showForm && (
          <Button onClick={() => { setShowForm(true); setEditingId(null); setForm(emptyForm); }} className="gradient-primary text-white rounded-xl hover:opacity-90">
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
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-gray-900">
                  {p.title}
                  <span className={cn('ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold', p.required ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600')}>
                    {p.required ? 'Required to book' : 'Optional'}
                  </span>
                  {!p.active && <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold text-gray-600">Off</span>}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  {p.activity_id
                    ? `Only for ${activities.find((a) => a.id === p.activity_id)?.title ?? 'one activity'}`
                    : 'All of your activities'}
                </p>
                {p.body && <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{p.body}</p>}
                {p.document_url && (
                  <a href={p.document_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm font-medium text-[#C90044] underline">
                    View uploaded document
                  </a>
                )}
              </div>
              {canManage && (
                <div className="flex shrink-0 gap-2">
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
              <select className={inputCls} value={form.activity_id} onChange={(e) => setForm({ ...form, activity_id: e.target.value })}>
                <option value="">All of my activities</option>
                {activities.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
              </select>
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
                  <a href={form.document_url} target="_blank" rel="noreferrer" className="text-sm font-medium text-[#C90044] underline">Uploaded ✓</a>
                )}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} className="h-4 w-4 accent-[#C90044]" />
              Parents must accept this before they can book
            </label>
          </div>
          <div className="flex gap-2">
            <Button onClick={save} disabled={saving || !form.title.trim()} className="gradient-primary text-white rounded-xl hover:opacity-90 px-5">
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add'}
            </Button>
            <Button variant="outline" onClick={() => { setShowForm(false); setEditingId(null); setError(null); }} className="rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50">Cancel</Button>
          </div>
        </div>
      )}
    </>
  );
}
