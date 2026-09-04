import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { User, MapPin, Users, Shield, Store, Pencil, FileText, ImageUp, Globe, Mail, Phone, MessageCircle, Hash, CheckCircle, CreditCard, MessageSquare, HelpCircle, Plus, X, Save, Plug, Eye, EyeOff, RefreshCw, LogOut, Copy, Check, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WixApiKeyHelp, WixApiKeyHelpTrigger } from '@/components/WixApiKeyHelp';
import { RainbowLoader } from '@/components/ui/rainbow-loader';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { apiPost, apiGet, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import type { ProviderPolicy, VendorCategory } from '@/lib/database.types';
import { VENDOR_TERMS, BOOKING_MESSAGING_TERMS, type ComplianceDocument } from '@/lib/complianceTerms';
import { VENDOR_CATEGORIES } from '@/lib/categories';

const settingsTabs = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'team', label: 'Team', icon: Users },
  // QA: "each vendor will have their own consents, waivers, disclosures they
  // want accepted so need a way to make this bespoke" + "there needs to be an
  // option to toggle on and upload the relevant material".
  { id: 'policies', label: 'Waivers & consents', icon: FileText },
  { id: 'compliance', label: 'Compliance', icon: Shield },
  { id: 'integrations', label: 'Integrate your business', icon: Plug },
];

// Lists only what the vendor actually agreed to at sign-up (the two "Required
// to publish" / "Required for bookings" boxes on Save-your-listing) plus the
// Refund Policy they maintain themselves — no placeholder rows.
//   'view'          → opens the exact agreement text in a right-hand Sheet,
//                     which itself carries a "Read in details" link to the
//                     full published page (DOC_URL below).
//   'edit-policies' → the vendor's own Refund Policy under Waivers & Consents
// The acceptance timestamps exist (providers.vendor_terms_accepted_at /
// booking_messaging_terms_accepted_at) but this tab still shows a flat
// "Accepted" rather than the real date.
// TODO: surface the real accepted-on date from the provider row.
type ComplianceItem = {
  icon: typeof FileText;
  label: string;
  status: string;
  statusColor: string;
  bg: string;
  accepted: boolean;
  kind: 'view' | 'edit-policies';
  doc: ComplianceDocument | null;
};
const complianceItems: ComplianceItem[] = [
  { icon: FileText, label: 'Vendor Terms', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true, kind: 'view', doc: VENDOR_TERMS },
  { icon: MessageSquare, label: 'Booking & Messaging Terms', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true, kind: 'view', doc: BOOKING_MESSAGING_TERMS },
  { icon: CreditCard, label: 'Refund Policy', status: 'Edit', statusColor: 'text-blue-600', bg: 'bg-blue-100', accepted: false, kind: 'edit-policies', doc: null },
];

// Where "Read in details" in each agreement's Sheet points. Both live on the
// single published Terms & Conditions page today; split when dedicated pages exist.
const DOC_URL: Record<ComplianceDocument['key'], string> = {
  vendor_terms: '/terms',
  booking_messaging_terms: '/terms',
};

type Member = { id: string; user_id: string; role: string; invited_email: string | null; status: string };

/* QA 21/08: "under settings, edit profile, there is nowhere to edit
   photos/videos. Display photo will be the logo. More photos/videos will be on
   the profile." logo_url was the only image anywhere in here — cover_image_url
   existed on the row but was never editable, and there was nowhere at all for
   extra photos or video. */
const emptyProfileForm = {
  business_name: '', vendor_category: '' as VendorCategory | '', description: '',
  logo_url: '', cover_image_url: '', contact_phone: '', contact_email: '', whatsapp: '', website: '',
  address: '', postal_code: '', uen: '',
  gallery_urls: [] as string[], video_urls: [] as string[],
};

export default function SettingsPage() {
  const { provider, role, session, refreshProvider, signOut } = useAuth();
  const canManage = role === 'owner' || role === 'manager';

  /* Deep-linkable: "Add a Location" on the dashboard and the Locations tab in
     Activities both land here and should highlight Locations, not Profile. */
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
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

  /* Locations moved to the Activities page (QA 28/08 — "it doesn't make sense
     to have locations in settings and weird redirecting from activities to
     there"). Old links and bookmarks are forwarded rather than 404'd, keeping
     the ?new=location deep-link that opens the add form straight away. */
  useEffect(() => {
    if (searchParams.get('tab') === 'locations') {
      const wantsNew = searchParams.get('new') === 'location';
      navigate(`/activities?tab=locations${wantsNew ? '&new=location' : ''}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const [viewingDoc, setViewingDoc] = useState<ComplianceDocument | null>(null);
  const [team, setTeam] = useState<Member[]>([]);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [form, setForm] = useState(emptyProfileForm);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [uploadingGallery, setUploadingGallery] = useState(false);
  const [videoInput, setVideoInput] = useState('');
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
      cover_image_url: provider.cover_image_url ?? '',
      contact_phone: provider.contact_phone ?? '',
      contact_email: provider.contact_email ?? '',
      whatsapp: provider.whatsapp ?? '',
      website: provider.website ?? '',
      address: provider.address ?? '',
      postal_code: provider.postal_code ?? '',
      uen: provider.uen ?? '',
      gallery_urls: provider.gallery_urls ?? [],
      video_urls: provider.video_urls ?? [],
    });
    supabase.from('provider_members').select('id, user_id, role, invited_email, status').eq('provider_id', provider.id)
      .then(({ data }) => setTeam((data as Member[]) ?? []));

    /* Deep link from "Save your listing" and its pencils (`/settings?edit=1`):
       open the profile editor straight away rather than dropping the vendor on
       a read-only view with a small "Edit" button to hunt for. Handled here so
       it waits for `provider` (hence `role`) to load; the flag is then stripped
       so Cancel returns to view mode and a reload doesn't re-arm it. */
    if (searchParams.get('edit') === '1') {
      setActiveTab('profile');
      if (role === 'owner' || role === 'manager') setIsEditingProfile(true);
      const next = new URLSearchParams(searchParams);
      next.delete('edit');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  /** Uploads one image and returns its public URL, or null after reporting why. */
  async function uploadImage(file: File, kind: string): Promise<string | null> {
    if (!provider) return null;
    setProfileError(null);
    const path = `${provider.id}/${kind}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]+/g, '_')}`;
    const { error } = await supabase.storage.from('activity-images').upload(path, file, { upsert: true });
    if (error) { setProfileError(`Upload failed: ${error.message}`); return null; }
    return supabase.storage.from('activity-images').getPublicUrl(path).data.publicUrl;
  }

  async function uploadLogo(file: File) {
    setUploadingLogo(true);
    const url = await uploadImage(file, 'logo');
    setUploadingLogo(false);
    if (url) setForm((f) => ({ ...f, logo_url: url }));
  }

  async function uploadCover(file: File) {
    setUploadingCover(true);
    const url = await uploadImage(file, 'cover');
    setUploadingCover(false);
    if (url) setForm((f) => ({ ...f, cover_image_url: url }));
  }

  async function uploadGallery(files: FileList) {
    setUploadingGallery(true);
    const urls: string[] = [];
    for (const file of Array.from(files).slice(0, 12)) {
      const url = await uploadImage(file, 'photo');
      if (url) urls.push(url);
    }
    setUploadingGallery(false);
    if (urls.length) setForm((f) => ({ ...f, gallery_urls: [...f.gallery_urls, ...urls].slice(0, 24) }));
  }

  /* Accepts a YouTube/Vimeo/direct link. Validated as a URL so a typo doesn't
     end up rendered as a broken embed on the public profile. */
  function addVideo() {
    const raw = videoInput.trim();
    if (!raw) return;
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      new URL(withScheme);
    } catch {
      setProfileError('That video link doesn\'t look like a URL.');
      return;
    }
    setProfileError(null);
    setForm((f) => ({ ...f, video_urls: [...f.video_urls, withScheme].slice(0, 12) }));
    setVideoInput('');
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
      cover_image_url: form.cover_image_url || null,
      gallery_urls: form.gallery_urls,
      video_urls: form.video_urls,
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
        cover_image_url: provider.cover_image_url ?? '',
        contact_phone: provider.contact_phone ?? '',
        contact_email: provider.contact_email ?? '',
        whatsapp: provider.whatsapp ?? '',
        website: provider.website ?? '',
        address: provider.address ?? '',
        postal_code: provider.postal_code ?? '',
        uen: provider.uen ?? '',
        gallery_urls: provider.gallery_urls ?? [],
        video_urls: provider.video_urls ?? [],
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
      <div className="flex flex-col items-center gap-3 px-4 py-5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-8">
        <div className="w-full text-center sm:w-auto sm:text-left">
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

      <div className="px-4 pb-8 sm:px-8">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6 overflow-x-auto">
          {settingsTabs.map((tab) => (
            <button key={tab.id} onClick={() => selectTab(tab.id)}
              className={cn('flex shrink-0 items-center gap-2 whitespace-nowrap px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
                activeTab === tab.id ? 'bg-white text-[#FA4D8D] shadow-sm' : 'text-gray-600 hover:text-gray-900')}>
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
                  {form.logo_url ? <img src={form.logo_url} alt="" className="w-full h-full object-cover" /> : <Store className="w-9 h-9 text-[#FA4D8D]" />}
                  {isEditingProfile && (
                    <label className={cn('absolute inset-0 flex items-center justify-center bg-black/40 text-white cursor-pointer', uploadingLogo && 'opacity-70 pointer-events-none')}>
                      <ImageUp className="w-5 h-5" />
                      <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); }} />
                    </label>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl font-bold text-gray-900">{form.business_name || 'Your business'}</h3>
                    {canManage && !isEditingProfile && (
                      <button
                        onClick={() => setIsEditingProfile(true)}
                        title="Edit profile"
                        aria-label="Edit profile"
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 sm:hidden"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {categoryLabel && <p className="text-sm text-gray-500">{categoryLabel}</p>}
                  <div className="flex items-center gap-2 mt-1.5">
                    <Progress value={completion(form)} className="w-32 h-2" />
                    <span className="text-xs font-semibold text-gray-500">{completion(form)}% complete</span>
                  </div>
                </div>
              </div>
              {canManage && !isEditingProfile && (
                <button onClick={() => setIsEditingProfile(true)} title="Edit profile" className="hidden items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:flex">
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
                <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ReadField icon={Phone} label="Phone" value={form.contact_phone} />
                  <ReadField icon={Mail} label="Email" value={form.contact_email} />
                  <ReadField icon={MessageCircle} label="WhatsApp" value={form.whatsapp} />
                  <ReadField icon={Globe} label="Website" value={form.website} />
                </section>
                <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ReadField icon={MapPin} label="Address" value={form.address} />
                  <ReadField icon={Hash} label="UEN" value={form.uen} />
                </section>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Business name</label>
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
                  <label className="text-xs text-gray-500 mb-1 block">Business description</label>
                  <textarea rows={3} className={cn(inputCls, 'resize-none')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Phone number</label>
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
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Address</label>
                    <input className={inputCls} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">UEN</label>
                    <input className={inputCls} value={form.uen} onChange={(e) => setForm({ ...form, uen: e.target.value })} />
                  </div>
                </div>
                {/* Photos & videos (QA 21/08). The logo above is the display
                    photo; everything here is the rest of the public profile. */}
                <div className="space-y-4 border-t border-gray-100 pt-4">
                  <div>
                    <h4 className="text-sm font-semibold text-gray-900">Photos &amp; videos</h4>
                    <p className="text-xs text-gray-500">Your logo above is the display photo. These appear on your public profile.</p>
                  </div>

                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Cover photo</label>
                    <div className="flex items-center gap-3">
                      <div className="relative h-20 w-36 shrink-0 overflow-hidden rounded-xl bg-gray-100">
                        {form.cover_image_url
                          ? <img src={form.cover_image_url} alt="" className="h-full w-full object-cover" />
                          : <div className="grid h-full w-full place-items-center text-xs text-gray-400">None</div>}
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className={cn('inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50', uploadingCover && 'pointer-events-none opacity-60')}>
                          <ImageUp className="h-3.5 w-3.5" /> {uploadingCover ? 'Uploading…' : form.cover_image_url ? 'Replace' : 'Upload'}
                          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCover(f); }} />
                        </label>
                        {form.cover_image_url && (
                          <button type="button" onClick={() => setForm({ ...form, cover_image_url: '' })} className="text-left text-xs font-medium text-red-600 hover:underline">Remove</button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">More photos ({form.gallery_urls.length})</label>
                    {form.gallery_urls.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-2">
                        {form.gallery_urls.map((url, i) => (
                          <div key={`${url}-${i}`} className="relative h-20 w-20 overflow-hidden rounded-lg bg-gray-100">
                            <img src={url} alt="" className="h-full w-full object-cover" />
                            <button
                              type="button"
                              aria-label="Remove photo"
                              onClick={() => setForm({ ...form, gallery_urls: form.gallery_urls.filter((_, j) => j !== i) })}
                              className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <label className={cn('inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50', uploadingGallery && 'pointer-events-none opacity-60')}>
                      <Plus className="h-3.5 w-3.5" /> {uploadingGallery ? 'Uploading…' : 'Add photos'}
                      <input type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const fs = e.target.files; if (fs?.length) uploadGallery(fs); }} />
                    </label>
                  </div>

                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Videos ({form.video_urls.length})</label>
                    {form.video_urls.length > 0 && (
                      <ul className="mb-2 space-y-1.5">
                        {form.video_urls.map((url, i) => (
                          <li key={`${url}-${i}`} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2">
                            <span className="min-w-0 flex-1 truncate text-xs text-gray-700">{url}</span>
                            <button
                              type="button"
                              aria-label="Remove video"
                              onClick={() => setForm({ ...form, video_urls: form.video_urls.filter((_, j) => j !== i) })}
                              className="text-xs font-medium text-red-600 hover:underline"
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        className={inputCls}
                        placeholder="Paste a YouTube, Vimeo or video link"
                        value={videoInput}
                        onChange={(e) => setVideoInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addVideo(); } }}
                      />
                      <Button type="button" variant="outline" onClick={addVideo} className="shrink-0 rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50">
                        Add
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <Button onClick={saveProfile} disabled={saving} className="gradient-primary text-white rounded-xl hover:opacity-90 px-6 gap-2">
                    <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save changes'}
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
                <h3 className="font-semibold text-gray-900">Team members</h3>
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
            <div className="mb-5 flex flex-col items-center gap-2 text-center sm:flex-row sm:items-center sm:gap-3 sm:text-left">
              <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center"><Shield className="w-5 h-5 text-purple-600" /></div>
              <div>
                <h3 className="font-semibold text-gray-900">Compliance</h3>
                <p className="text-xs text-gray-500">Ensure your profile is compliant and up to date.</p>
              </div>
            </div>
            <div className="space-y-3">
              {complianceItems.map((item, idx) => {
                const clickable = item.kind === 'view' || item.kind === 'edit-policies';
                const onClick = () => {
                  if (item.kind === 'view' && item.doc) setViewingDoc(item.doc);
                  else if (item.kind === 'edit-policies') selectTab('policies');
                };
                return (
                  <div
                    key={idx}
                    onClick={clickable ? onClick : undefined}
                    className={cn('flex items-center gap-3 p-3 bg-gray-50 rounded-xl', clickable && 'cursor-pointer hover:bg-gray-100')}
                  >
                    <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', item.bg)}><item.icon className={cn('w-4 h-4', item.statusColor)} /></div>
                    <div className="flex-1"><div className="text-sm font-medium text-gray-900">{item.label}</div></div>
                    {item.accepted ? (
                      <span className="flex items-center gap-1 px-2 py-1 bg-green-300 text-green-800 text-xs rounded-full"><CheckCircle className="w-3 h-3" />Accepted</span>
                    ) : item.status === 'Edit' ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); selectTab('policies'); }}
                        className="flex items-center gap-1 px-3 py-1.5 border border-blue-300 rounded-lg text-xs text-blue-600 hover:bg-blue-50"
                      >
                        <Pencil className="w-3 h-3" />Edit
                      </button>
                    ) : (
                      <span className="flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-500 text-xs rounded-full"><HelpCircle className="w-3 h-3" />{item.status}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <Sheet open={!!viewingDoc} onOpenChange={(open) => { if (!open) setViewingDoc(null); }}>
          <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
            {viewingDoc && (
              <>
                <SheetHeader>
                  <SheetTitle>{viewingDoc.title}</SheetTitle>
                  <SheetDescription>{viewingDoc.summary}</SheetDescription>
                </SheetHeader>
                <div className="px-4 pb-6 space-y-5">
                  <a
                    href={DOC_URL[viewingDoc.key]}
                    target="_blank"
                    rel="noreferrer"
                    className="-mt-2 inline-flex items-center gap-1 text-sm font-semibold text-[#FA4D8D] hover:underline"
                  >
                    Read in details
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <p className="text-xs text-gray-400">
                    This is the agreement you accepted when setting up your listing — shown here exactly as it was presented then.
                  </p>
                  {viewingDoc.sections.map((s) => (
                    <div key={s.heading} className="rounded-xl border-2 border-gray-300 bg-white p-4 shadow-sm">
                      <h4 className="text-sm font-semibold text-gray-900 mb-1">{s.heading}</h4>
                      <p className="text-sm text-gray-600 leading-relaxed">{s.body}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>

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

type WixEventOption = {
  id: string;
  name: string;
  startDate: string;
  alreadyImported: boolean;
};

/** Small inline "copy to clipboard" control — swaps to a tick for ~1.5s. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context / denied) — no-op */
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

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
  // A background reload (a tab switch triggers a Supabase token refresh,
  // which hands this component a fresh `provider` object) must not wipe what
  // the vendor is part-way through pasting into the connect form. Once they
  // touch either field, load() leaves the inputs and `editing` alone until
  // the next successful save.
  const touched = useRef(false);
  const markTouched = () => { touched.current = true; };
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // "Import specific events" — same shape as the services picker above, one
  // Wix app over (Events & Tickets, not Bookings).
  const [wixEvents, setWixEvents] = useState<WixEventOption[] | null>(null);
  const [eventsListLoading, setEventsListLoading] = useState(false);
  const [selectedEventIds, setSelectedEventIds] = useState<Set<string>>(new Set());
  const [baselineEventIds, setBaselineEventIds] = useState<Set<string>>(new Set());
  const [eventImportSaving, setEventImportSaving] = useState(false);
  const [eventImportError, setEventImportError] = useState<string | null>(null);
  const [eventImportNotice, setEventImportNotice] = useState<string | null>(null);
  const [eventsAppNotInstalled, setEventsAppNotInstalled] = useState(false);

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
  //
  // Only an ApiError's message is ever shown. Those are written for a vendor
  // to read — the server's own `error` field (describeWixApiError's "check
  // both were copied from the same site", say) or apiPost's network-failure
  // wording. Anything else reaching here is a bug in this page, and its
  // message is browser text: a vendor was shown "Cannot read properties of
  // undefined (reading 'created')" on the integrations tab, which reads as
  // "your Wix connection is broken" when nothing about it was. Those get the
  // caller's own fallback, and the real error goes to the console where it
  // is actually useful.
  function describeWixError(e: unknown, fallback: string): string {
    if (e instanceof ApiError) {
      if (e.status === 401) {
        return 'Your session has expired. Please sign out and sign back in — if this keeps happening, contact support.';
      }
      return e.message || fallback;
    }
    console.error('[wix integration] unexpected error', e);
    return `${fallback}. If this keeps happening, contact support.`;
  }

  /** Reading a count straight off the response threw
   *  "Cannot read properties of undefined (reading 'created')" at a vendor,
   *  in the integrations card's error box, when a sync call came back 2xx
   *  without its `sync` field. The sync had already run at that point — only
   *  the sentence describing it blew up — so this must never be the thing
   *  that turns a completed sync into a failure. Every field is treated as
   *  optional and a missing summary degrades to "couldn't be summarised"
   *  rather than throwing. Same for summarizeEventSync below. */
  type SyncSummary = Partial<{
    created: number; updated: number; removed: number; revived: number; unlinked: number;
    skipped: { name: string; reason: string }[];
  }>;

  function summarizeSync(sync: SyncSummary | null | undefined) {
    if (!sync) return 'Synced from Wix — the result couldn’t be summarised, so check your activities below.';
    const parts = [];
    if (sync.created) parts.push(`${sync.created} new`);
    if (sync.updated) parts.push(`${sync.updated} updated`);
    if (sync.revived) parts.push(`${sync.revived} restored`);
    if (sync.removed) parts.push(`${sync.removed} removed`);
    if (sync.unlinked) parts.push(`${sync.unlinked} unlinked`);
    if (!sync.created && !sync.updated && !sync.removed && !sync.revived && !sync.unlinked) parts.push('nothing new');
    let text = `Synced from Wix: ${parts.join(', ')}.`;
    const skipped = sync.skipped ?? [];
    if (skipped.length) {
      text += ` ${skipped.length} skipped — ${skipped.map((s) => `"${s.name}" (${s.reason})`).join('; ')}.`;
    }
    return text;
  }

  async function load() {
    if (!provider) return;
    setLoading(true);
    // Cleared on every reload. This was the one writer of `error` that never
    // reset it, so a failure from any other action — a sync, a reveal —
    // stayed pinned to the integrations card indefinitely: through a
    // remount, through "Change key", through a *successful* reconnect. It is
    // why a vendor sat looking at a sync error while re-entering their
    // credentials, with the button that produced it not even on screen (it
    // only renders when connected and not editing). A stale message there
    // reads as "this connection is still broken" long after it isn't.
    setError(null);
    try {
      const s = await apiGet<WixStatus>(`/api/vendor/wix-integration?providerId=${provider.id}`);
      setStatus(s);
      setRevealedKey(null);
      // Never yank the form out from under a vendor mid-paste (see `touched`).
      if (!touched.current) {
        setEditing(!s.connected);
        setSiteId(s.wix_site_id ?? '');
      }
    } catch (e) {
      setError(describeWixError(e, 'Could not load Wix integration status'));
      // Status is unknown, not necessarily "connected" — still let a manager
      // attempt to (re)connect rather than leaving them with a dead end.
      if (!touched.current) setEditing(true);
    } finally {
      setLoading(false);
    }
  }
  // Keyed on the id, not the object: a token refresh re-creates the provider
  // object (same id) and must not re-trigger a reload that clears the inputs.
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [provider?.id]);

  async function save() {
    // Tolerate a messy paste before it ever reaches Wix: pull the UUID out
    // of a pasted dashboard URL, drop whitespace/newlines and a stray
    // "Bearer " from the key. The server re-does this, but cleaning the
    // fields here means the vendor sees exactly what will be stored.
    const cleanSite = (siteId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? siteId.trim()).toLowerCase();
    const cleanKey = apiKey.replace(/^\s*bearer\s+/i, '').replace(/\s+/g, '');
    if (cleanSite !== siteId) setSiteId(cleanSite);
    if (cleanKey !== apiKey) setApiKey(cleanKey);
    if (!provider || !cleanSite || !cleanKey) {
      setError('Both the API key and site ID are required.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost<{ ok: true }>(
        '/api/vendor/wix-integration',
        { provider_id: provider.id, wix_site_id: cleanSite, wix_api_key: cleanKey }
      );
      setApiKey('');
      setShowKey(false);
      setNotice('Wix account connected. Now choose which services and events to import, using the sections below.');
      // Saved — let load() re-seed the form from the stored value.
      touched.current = false;
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
      const res = await apiPost<{ sync?: SyncSummary }>(
        '/api/vendor/wix-services-sync',
        { provider_id: provider.id }
      );
      // The route returns `{ ok: true, sync }` on every success, so a missing
      // `sync` means something other than the route answered — and that is
      // exactly the case that used to throw here. Log the whole body: the
      // shape of whatever did answer is the one piece of evidence needed to
      // explain it, and it was being thrown away.
      if (!res?.sync) console.error('[wix sync] services response had no `sync` field', res);
      // Events are a second Wix app and a second call, but a vendor thinks of
      // this as one "pull everything in from Wix" button, so it fires both.
      // Events failing shouldn't discard the services result that already
      // landed, hence the inner catch: it's reported alongside, not thrown.
      let eventsLine: string;
      try {
        const ev = await apiPost<{ sync?: EventSyncSummary }>(
          '/api/vendor/wix-events-sync',
          { provider_id: provider.id }
        );
        if (!ev?.sync) console.error('[wix sync] events response had no `sync` field', ev);
        eventsLine = summarizeEventSync(ev.sync);
        await loadWixEvents(); // picker (if open) shouldn't show stale checkboxes after a blanket sync
      } catch (e) {
        eventsLine = `Events couldn’t be synced — ${describeWixError(e, 'please try again')}`;
      }
      setNotice(`${summarizeSync(res.sync)} ${eventsLine}`);
    } catch (e) {
      setError(describeWixError(e, 'Could not sync services'));
    } finally {
      setSyncing(false);
    }
  }

  // Wix Events & Tickets — a separate app/API from Bookings (see
  // lib/wix/events-sync.ts), so it stays a second call even though "Sync
  // services" above fires both: a vendor connected for Bookings only won't
  // have the Events app installed at all, and that call reports it back
  // rather than erroring, which is why this reads as a normal outcome.
  type EventSyncSummary = Partial<{
    created: number; updated: number; removed: number; revived: number;
    ticketPricingSkipped: string[]; eventsAppNotInstalled: boolean;
  }>;

  function summarizeEventSync(sync: EventSyncSummary | null | undefined) {
    if (!sync) return 'Synced from Wix Events — the result couldn’t be summarised.';
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
    const skipped = sync.ticketPricingSkipped ?? [];
    if (skipped.length) {
      text += ` Ticket pricing couldn’t be read for: ${skipped.join(', ')}.`;
    }
    return text;
  }

  async function loadWixEvents() {
    if (!provider) return;
    setEventsListLoading(true);
    setEventImportError(null);
    try {
      const res = await apiGet<{ events: WixEventOption[]; eventsAppNotInstalled: boolean }>(`/api/vendor/wix-events?providerId=${provider.id}`);
      setWixEvents(res.events);
      setEventsAppNotInstalled(res.eventsAppNotInstalled);
      const imported = new Set(res.events.filter((e) => e.alreadyImported).map((e) => e.id));
      setSelectedEventIds(imported);
      setBaselineEventIds(imported);
    } catch (e) {
      setEventImportError(describeWixError(e, 'Could not load Wix events'));
    } finally {
      setEventsListLoading(false);
    }
  }

  function toggleEventSelected(id: string) {
    setEventImportNotice(null);
    setSelectedEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const hasEventSelectionChanges =
    selectedEventIds.size !== baselineEventIds.size || [...selectedEventIds].some((id) => !baselineEventIds.has(id));

  async function saveEventImport() {
    if (!provider || !hasEventSelectionChanges) return;
    setEventImportSaving(true);
    setEventImportError(null);
    setEventImportNotice(null);
    try {
      const res = await apiPost<{
        sync?: EventSyncSummary;
        protectedEvents?: { wixEventId: string; title: string }[];
      }>('/api/vendor/wix-events-import', { provider_id: provider.id, event_ids: Array.from(selectedEventIds) });
      let notice = summarizeEventSync(res.sync);
      const blocked = res.protectedEvents ?? [];
      if (blocked.length > 0) {
        const n = blocked.length;
        notice += ` ${blocked.map((p) => `"${p.title}"`).join(', ')} already ${n > 1 ? 'have' : 'has'} bookings, so ${n > 1 ? 'they stay' : 'it stays'} listed — contact support to remove ${n > 1 ? 'them' : 'it'}.`;
      }
      setEventImportNotice(notice);
      await loadWixEvents(); // re-checks anything that was protected, since it's still really linked
    } catch (e) {
      setEventImportError(describeWixError(e, 'Could not import the selected events'));
    } finally {
      setEventImportSaving(false);
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

  useEffect(() => {
    if (status?.connected) loadWixEvents();
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
      const res = await apiPost<{
        sync?: SyncSummary;
        protectedServices?: { wixServiceId: string; title: string }[];
      }>(
        '/api/vendor/wix-services-import',
        { provider_id: provider.id, service_ids: Array.from(selectedIds) }
      );
      let notice = summarizeSync(res.sync);
      // An activity a family has actually booked can't be unlinked — say so,
      // rather than letting the box quietly re-tick itself on reload. Same
      // wording as the events picker's own protected message.
      if (res.protectedServices?.length) {
        const n = res.protectedServices.length;
        notice += ` ${res.protectedServices.map((p) => `"${p.title}"`).join(', ')} already ${n > 1 ? 'have' : 'has'} bookings, so ${n > 1 ? 'they stay' : 'it stays'} listed — contact support to remove ${n > 1 ? 'them' : 'it'}.`;
      }
      setImportNotice(notice);
      await loadServices(); // re-ticks anything that was protected, since it's still really linked
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
      {/* Wix is the only integration built so far, so a vendor on any other
          platform otherwise has no signal that asking for theirs is an option
          — this points them at support rather than leaving them at a dead end. */}
      <p className="mb-4 rounded-lg bg-gray-50 px-3 py-2.5 text-xs text-gray-600">
        Don't see your platform here?{' '}
        <Link to="/contact" className="font-medium text-[#FA4D8D] hover:underline">Contact us</Link>{' '}
        to request the integration to be built.
      </p>

      <div className="mb-1 flex flex-col items-center gap-2 text-center sm:flex-row sm:items-center sm:gap-3 sm:text-left">
        <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center"><Plug className="w-5 h-5 text-indigo-600" /></div>
        <div>
          <h3 className="font-semibold text-gray-900">Wix integration</h3>
          <p className="text-xs text-gray-500">Connect your own Wix account to sync availability.</p>
        </div>
      </div>

      {loading && <RainbowLoader className="mt-5 py-4" label="Loading settings" />}

      {!loading && (
        <div className="mt-5">
          {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {notice && <div className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div>}

          {status?.connected && !editing && (
            <WixApiKeyHelp>
            <div className="rounded-xl border border-gray-200 p-4 space-y-4">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">
                  <CheckCircle className="w-3.5 h-3.5" /> Connected
                </span>
                {status.updated_at && (
                  <span className="text-xs text-gray-400">since {new Date(status.updated_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                )}
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className="text-xs text-gray-500">Site ID</label>
                  {status.wix_site_id && <CopyButton value={status.wix_site_id} label="Site ID" />}
                </div>
                <div className={readOnlyCls}>{status.wix_site_id}</div>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className="text-xs text-gray-500">API Key</label>
                  {revealedKey && <CopyButton value={revealedKey} label="API Key" />}
                </div>
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
                Nothing is imported automatically. Pick the services and events you want on BabyBrain from the
                sections below — they land unpublished so you can review and edit them before they go live.
                “Sync services” only refreshes what you’ve already imported.
              </p>
              <WixApiKeyHelpTrigger />
            </div>
            </WixApiKeyHelp>
          )}

          {status?.connected && canManage && (
            <div className="mt-5 rounded-xl border border-gray-200 p-4 space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-gray-900">Import specific activities</h4>
              </div>

              {importError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{importError}</div>}
              {importNotice && <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{importNotice}</div>}
              {!importNotice && hasSelectionChanges && (
                <div className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
                  The changes will reflect on Activities page
                </div>
              )}

              {servicesLoading && <RainbowLoader className="py-4" label="Loading Wix services" />}

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

                  <p className="text-xs text-gray-500">
                    Choose which of your activities you would like to display through BabyBrain and click save.
                  </p>

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

          {status?.connected && canManage && !eventsAppNotInstalled && (
            <div className="mt-5 rounded-xl border border-gray-200 p-4 space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-gray-900">Import specific events</h4>
              </div>

              {eventImportError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{eventImportError}</div>}
              {eventImportNotice && <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{eventImportNotice}</div>}
              {!eventImportNotice && hasEventSelectionChanges && (
                <div className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
                  The changes will reflect on Activities page
                </div>
              )}

              {eventsListLoading && <RainbowLoader className="py-4" label="Loading Wix events" />}

              {!eventsListLoading && wixEvents && wixEvents.length === 0 && (
                <p className="text-sm text-gray-400">No upcoming events found on this Wix account.</p>
              )}

              {!eventsListLoading && wixEvents && wixEvents.length > 0 && (
                <>
                  <div className="space-y-2 max-h-72 overflow-y-auto">
                    {wixEvents.map((e) => (
                      <label
                        key={e.id}
                        className={cn(
                          'flex items-center gap-3 p-3 rounded-xl border cursor-pointer',
                          e.alreadyImported ? 'bg-green-50 border-green-100' : 'bg-gray-50 border-gray-100 hover:bg-gray-100'
                        )}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 flex-shrink-0 rounded border-gray-300 text-pink-500 focus:ring-pink-300"
                          checked={selectedEventIds.has(e.id)}
                          onChange={() => toggleEventSelected(e.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-800 truncate">{e.name}</div>
                          <div className="text-xs text-gray-400">
                            {new Date(e.startDate).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' })}
                          </div>
                        </div>
                        {e.alreadyImported && (
                          <span className="flex-shrink-0 text-xs font-semibold text-green-700">Imported</span>
                        )}
                      </label>
                    ))}
                  </div>

                  <p className="text-xs text-gray-500">
                    Choose which of your events you would like to display through BabyBrain and click save.
                  </p>

                  <Button
                    onClick={saveEventImport}
                    disabled={eventImportSaving || !hasEventSelectionChanges}
                    className="gradient-primary text-white rounded-xl hover:opacity-90 gap-2"
                  >
                    <Save className="w-4 h-4" /> {eventImportSaving ? 'Saving…' : 'Save'}
                  </Button>
                </>
              )}
            </div>
          )}

          {!status?.connected && !canManage && (
            <p className="text-sm text-gray-400">This business hasn't connected a Wix account yet. Ask an owner or manager to set it up.</p>
          )}

          {editing && canManage && (
            <WixApiKeyHelp>
            <div className="rounded-xl border border-gray-200 p-4 space-y-5">
              <div>
                <label className="text-sm font-semibold text-gray-800 mb-1.5 block">Wix API Key</label>
                {/* Instructions sit above the field: the vendor has to go and
                    fetch the key before there is anything to type here. */}
                <p className="mb-2 text-xs text-gray-500">
                  In your Wix dashboard: <strong>Settings → Development &amp; Integrations → Headless Settings → Manage API Key → Generate API Key → All site permissions → Generate Key</strong>. Copy this key immediately — Wix only shows it once.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type={showKey ? 'text' : 'password'}
                    className={cn(inputCls, 'flex-1')}
                    placeholder="IST.eyJra..."
                    value={apiKey}
                    onChange={(e) => { markTouched(); setApiKey(e.target.value); }}
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
              </div>

              <div>
                <label className="text-sm font-semibold text-gray-800 mb-1.5 block">Wix Site ID</label>
                {/* Same as the API key above: tell them where to find it before
                    they reach the field they are meant to fill in. */}
                <p className="text-xs text-gray-500">
                  Open your Wix dashboard and look at the browser's address bar — it follows this pattern:
                </p>
                <p className="mt-1 rounded-lg bg-gray-50 px-2.5 py-1.5 text-xs font-mono text-gray-700">
                  wix.com/dashboard/<span className="font-bold text-[#FA4D8D]">SITE_ID</span>/home
                </p>
                <p className="mt-1.5 mb-2 text-xs text-gray-500">
                  Copy just the <span className="font-bold text-[#FA4D8D]">SITE_ID</span> part — the segment between{' '}
                  <span className="font-mono">/dashboard/</span> and <span className="font-mono">/home</span> — and
                  paste it below.
                </p>
                <input
                  type="text"
                  className={inputCls}
                  placeholder="e.g. a240b75d-88bb-414a-bf15-01f112022e66"
                  value={siteId}
                  onChange={(e) => { markTouched(); setSiteId(e.target.value); }}
                  autoComplete="off"
                />
              </div>

              <div className="flex gap-2 pt-1">
                <Button onClick={save} disabled={saving || !siteId.trim() || !apiKey.trim()} className="gradient-primary text-white rounded-xl hover:opacity-90 px-5 gap-2">
                  <Save className="w-4 h-4" /> {saving ? 'Connecting…' : 'Save & connect'}
                </Button>
                {status?.connected && (
                  <Button variant="outline" onClick={() => { touched.current = false; setEditing(false); setApiKey(''); setSiteId(status.wix_site_id ?? ''); setError(null); }} className="rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50">
                    Cancel
                  </Button>
                )}
              </div>

              <WixApiKeyHelpTrigger />
            </div>
            </WixApiKeyHelp>
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
      <div className="mb-5 flex flex-col items-center gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-col items-center gap-2 text-center sm:flex-row sm:items-center sm:gap-3 sm:text-left">
          <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center"><FileText className="w-5 h-5 text-amber-600" /></div>
          <div>
            <h3 className="font-semibold text-gray-900">Waivers &amp; consents</h3>
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
                  {p.activity_id
                    ? `Only for ${activities.find((a) => a.id === p.activity_id)?.title ?? 'one activity'}`
                    : 'All of your activities'}
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
                  <a href={form.document_url} target="_blank" rel="noreferrer" className="text-sm font-medium text-[#FA4D8D] underline">Uploaded ✓</a>
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
