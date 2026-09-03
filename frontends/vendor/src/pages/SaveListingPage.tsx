import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Pencil,
  Store,
  Baby,
  MapPin,
  Clock,
  DollarSign,
  Globe,
  Phone,
  Mail,
  MessageCircle,
  Hash,
  FileText,
  CalendarCheck,
  CalendarDays,
  Shield,
  Lock,
  Bell,
  Heart,
  Star,
  User,
  Sparkles,
  ExternalLink,
  Smartphone,
  Monitor,
  X,
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { BrandLogo, BrandStacked } from '@/components/BrandLogo';
import { VENDOR_CATEGORIES, categoryLabel } from '@/lib/categories';
import { VENDOR_TERMS, type ComplianceDocument } from '@/lib/complianceTerms';
import { formatAgeRange, regionLabel } from '@/lib/database.types';
import type { Database, VendorCategory } from '@/lib/database.types';

type ProviderUpdate = Database['public']['Tables']['providers']['Update'];

/** The profile as it is edited here — the same columns Settings → Profile owns. */
interface ProfileDraft {
  business_name: string;
  vendor_category: string;
  description: string;
  logo_url: string;
  contact_phone: string;
  contact_email: string;
  whatsapp: string;
  website: string;
  address: string;
  postal_code: string;
  uen: string;
}

const EMPTY_PROFILE: ProfileDraft = {
  business_name: '', vendor_category: '', description: '', logo_url: '',
  contact_phone: '', contact_email: '', whatsapp: '', website: '',
  address: '', postal_code: '', uen: '',
};

/* The summary is the vendor's profile, not a separate set of fields: the same
   rows Settings → Profile shows, editable in place so nobody has to leave the
   review to fix a phone number. `identity` covers the name + category pair in
   the header card; the rest are one column each. */
type FieldKey =
  | 'identity' | 'description' | 'contact_phone' | 'contact_email'
  | 'whatsapp' | 'website' | 'address' | 'uen';

interface SummaryField {
  key: FieldKey;
  icon: typeof Store;
  label: string;
  hint?: string;
}

const SUMMARY_SECTIONS: { title: string; fields: SummaryField[] }[] = [
  {
    title: 'About',
    fields: [{ key: 'description', icon: FileText, label: 'Business description', hint: 'The blurb parents read on your listing.' }],
  },
  {
    title: 'Contact',
    fields: [
      { key: 'contact_phone', icon: Phone, label: 'Phone' },
      { key: 'contact_email', icon: Mail, label: 'Email' },
      { key: 'whatsapp', icon: MessageCircle, label: 'WhatsApp' },
      { key: 'website', icon: Globe, label: 'Website' },
    ],
  },
  {
    title: 'Location & registration',
    fields: [
      { key: 'address', icon: MapPin, label: 'Address' },
      { key: 'uen', icon: Hash, label: 'UEN' },
    ],
  },
];

interface VenueRow {
  name: string;
  address: string;
  hours: string;
}

/** The aggregates over activities — no single column to set, so each pencil
 *  deep-links to the editor that actually owns it. */
interface GlanceRow {
  icon: typeof Store;
  label: string;
  value: string;
  to: string;
}

/** Exactly the fields the parent app's ActivityCard prints. */
interface PreviewCard {
  title: string;
  providerName: string | null;
  category: string;
  image: string;
  age: string;
  place: string;
  date: string;
  time: string;
  price: string | null;
  rating: string;
  duration: string;
  instantBook: boolean;
  /** Where the details came from, so the caption can say so honestly. */
  source: 'published' | 'draft' | 'profile';
}

/* The rows render before (and whether or not) there is anything to count, so
   the section keeps its shape instead of collapsing to just the venues box. */
const EMPTY_GLANCE: GlanceRow[] = [
  { icon: CalendarCheck, label: 'Published activities', value: 'None published yet', to: '/activities' },
  { icon: Baby, label: 'Age range', value: 'Not set', to: '/activities' },
  { icon: DollarSign, label: 'Pricing', value: 'Not set', to: '/activities' },
];

const EMPTY_CARD: PreviewCard = {
  title: 'Your business name',
  providerName: null,
  category: 'Your category',
  image: `${import.meta.env.BASE_URL}assets/activity-play.jpg`,
  age: 'Ages you set on your activities',
  place: 'Your selected location',
  date: '',
  time: '',
  price: null,
  rating: '',
  duration: '',
  instantBook: false,
  source: 'profile',
};

const whyMatters = [
  { icon: Heart, text: 'Ensures accurate information for parents' },
  { icon: Shield, text: 'Builds trust and credibility for your business' },
  { icon: Heart, text: 'Helps parents discover and connect with you' },
  { icon: Bell, text: 'Keep your schedule and programmes up to date' },
];

/** Same five fields Settings → Profile scores, so both pages agree on "complete". */
const completion = (p: ProfileDraft) => {
  const fields = [p.business_name, p.contact_phone, p.contact_email, p.website, p.description];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100);
};

/* ---- The parent app's own formatting, copied so the preview reads identically ---- */

/** Matches formatDuration in the parent app. */
const formatDuration = (mins: number | null | undefined): string => {
  if (!mins || mins <= 0) return '';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

const sgDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short' }) : '';
const sgTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' }) : '';

/** Cards lead with the area; the address tail is the fallback, minus the
 *  postcode. Empty when there is nothing to go on, so the caller can choose
 *  between the parent app's own "Singapore" and a placeholder. */
const placeLabel = (region: string | null, address: string | null) => {
  const area = regionLabel(region);
  if (area) return area;
  const tail = (address ?? '').split(',').map((s) => s.trim()).pop() ?? '';
  return tail.replace(/\b\d{6}\b/g, '').replace(/[,\s]+$/, '').trim();
};

/** "From $32" — the parent card's price line. */
const priceLabel = (price: number | null): string | null => {
  if (price == null) return null;
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return 'Free';
  return `From $${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
};

/** Themed placeholder per category, matching the Activities page. */
const fallbackImage = (category: string) => {
  const name = category.toLowerCase();
  const img = name.includes('art') ? 'activity-art.jpg'
    : name.includes('science') || name.includes('learn') || name.includes('stem') ? 'activity-stem.jpg'
    : name.includes('yoga') || name.includes('mind') ? 'activity-yoga.jpg'
    : name.includes('play') || name.includes('sensory') || name.includes('move') ? 'activity-play.jpg'
    : 'activity-music.jpg';
  return `${import.meta.env.BASE_URL}assets/${img}`;
};

export default function SaveListingPage() {
  const navigate = useNavigate();
  const { provider: activeProvider, refreshProvider } = useAuth();
  const providerId = activeProvider?.id ?? null;
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [agreedVendor, setAgreedVendor] = useState(false);
  const [prov, setProv] = useState<ProfileDraft>(EMPTY_PROFILE);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [glance, setGlance] = useState<GlanceRow[]>(EMPTY_GLANCE);
  // Never null: the card is the shape of the real listing, so an empty
  // profile still shows the shape rather than an empty phone.
  const [card, setCard] = useState<PreviewCard>(EMPTY_CARD);

  // Inline edit state — one field at a time.
  const [editKey, setEditKey] = useState<FieldKey | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [fieldBusy, setFieldBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Terms viewer + Save.
  const [viewingDoc, setViewingDoc] = useState<ComplianceDocument | null>(null);
  const [savingListing, setSavingListing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canSave = agreedVendor;

  // Both previews carry the same footnote — it says where the details came
  // from, so nobody mistakes a draft for something families can already find.
  const previewNote =
    card.source === 'published'
      ? 'Preview only — nothing here is clickable.'
      : card.source === 'draft'
        ? 'From your draft activity — publish it and this is exactly what families will find.'
        : 'Add an activity and its photo, ages, schedule and price fill in here.';

  // Renders the business we actually hold; re-run after every inline save so
  // the summary and the preview reflect the change without a full reload.
  const load = useCallback(async () => {
    if (!providerId) return;
    const [{ data: provider }, { data: acts }, { data: locs }, { data: cats }] = await Promise.all([
      supabase
        .from('providers')
        .select('business_name, vendor_category, description, logo_url, cover_image_url, address, postal_code, website, contact_email, contact_phone, whatsapp, uen')
        .eq('id', providerId)
        .maybeSingle(),
      // Drafts come back too: during onboarding a vendor often has an
      // activity built but not published yet, and the preview should show
      // their real details rather than placeholder text. Published first, so
      // the preview leads with something families can actually find.
      supabase
        .from('activities')
        .select('id, title, price, age_min_months, age_max_months, address, region, image_urls, category_id, rating_avg, rating_count, external_booking_url, is_published, created_at')
        .eq('provider_id', providerId)
        .is('archived_at', null)
        .order('is_published', { ascending: false })
        .order('created_at'),
      supabase
        .from('provider_locations')
        .select('name, address, postal_code, operating_hours')
        .eq('provider_id', providerId),
      supabase.from('activity_categories').select('id, name'),
    ]);

    const profile: ProfileDraft = {
      business_name: provider?.business_name ?? '',
      vendor_category: provider?.vendor_category ?? '',
      description: provider?.description ?? '',
      logo_url: provider?.logo_url ?? '',
      contact_phone: provider?.contact_phone ?? '',
      contact_email: provider?.contact_email ?? '',
      whatsapp: provider?.whatsapp ?? '',
      website: provider?.website ?? '',
      address: provider?.address ?? '',
      postal_code: provider?.postal_code ?? '',
      uen: provider?.uen ?? '',
    };
    setProv(profile);

    const activities = acts ?? [];
    const published = activities.filter((a) => a.is_published);
    // A vendor mid-onboarding has drafts and nothing live; showing their real
    // ages and prices beats "Not set", so fall back to the drafts.
    const counted = published.length ? published : activities;
    const ageMin = counted.length ? Math.min(...counted.map((a) => a.age_min_months)) : null;
    const ageMax = counted.length ? Math.max(...counted.map((a) => a.age_max_months)) : null;
    const prices = counted.map((a) => Number(a.price)).filter((n) => Number.isFinite(n) && n > 0);

    setGlance([
      {
        icon: CalendarCheck,
        label: 'Published activities',
        value: published.length ? `${published.length} live on BabyBrain` : 'None published yet',
        to: '/activities',
      },
      {
        icon: Baby,
        label: 'Age range',
        value: ageMin != null && ageMax != null ? formatAgeRange(ageMin, ageMax) : 'Not set',
        to: '/activities',
      },
      {
        icon: DollarSign,
        label: 'Pricing',
        value: prices.length ? `From $${Math.min(...prices).toFixed(0)} per session` : 'Not set',
        to: '/activities',
      },
    ]);

    const venueRows: VenueRow[] = (locs ?? []).map((l) => {
      const hours = l.operating_hours as Record<string, [string, string][]> | null;
      const summary = hours
        ? Object.entries(hours)
            .map(([day, ranges]) => `${day[0].toUpperCase()}${day.slice(1)}: ${(ranges ?? []).map((r) => r.join(' – ')).join(', ')}`)
            .join('\n')
        : '';
      return {
        name: l.name,
        address: [l.address, l.postal_code].filter(Boolean).join(', '),
        hours: summary || 'Hours not set',
      };
    });
    setVenues(venueRows);

    // The preview card mirrors the parent app's search result for this
    // business. Every field is filled from something the vendor really has —
    // their leading activity first, then the profile and venues behind it —
    // so placeholder wording only ever shows for a detail that is genuinely
    // still empty.
    const catName = (id: number) => (cats ?? []).find((c) => c.id === id)?.name ?? '';
    const lead = activities[0];
    let nextSessionAt: string | null = null;
    let durationMins: number | null = null;
    if (lead) {
      const { data: sess } = await supabase
        .from('activity_sessions')
        .select('starts_at, ends_at')
        .eq('activity_id', lead.id)
        .gte('starts_at', new Date().toISOString())
        .order('starts_at')
        .limit(1);
      const next = sess?.[0];
      nextSessionAt = next?.starts_at ?? null;
      if (next?.starts_at && next.ends_at) {
        durationMins = Math.round((new Date(next.ends_at).getTime() - new Date(next.starts_at).getTime()) / 60000);
      }
    }

    const businessName = profile.business_name.trim();
    const cardTitle = lead?.title?.trim() || businessName || 'Your business name';
    // The activity's own category, else the one set on the profile.
    const category =
      (lead ? catName(lead.category_id) : '')
      || (profile.vendor_category ? categoryLabel(profile.vendor_category) : '')
      || 'Your category';
    const cardAge =
      lead ? formatAgeRange(lead.age_min_months, lead.age_max_months)
        : ageMin != null && ageMax != null ? formatAgeRange(ageMin, ageMax)
        : 'Ages you set on your activities';
    const cheapest = prices.length ? Math.min(...prices) : null;

    setCard({
      title: cardTitle,
      // The parent card drops the provider line when it just repeats the title.
      providerName: businessName && businessName.toLowerCase() !== cardTitle.toLowerCase() ? businessName : null,
      category,
      // The activity's photo, else the cover image on the profile, else a
      // placeholder themed to the category.
      image: lead?.image_urls?.[0] || provider?.cover_image_url || fallbackImage(category),
      age: cardAge,
      // The location the vendor has actually chosen: the activity's own area
      // first, then the profile address, then the first venue they added.
      place:
        placeLabel(lead?.region ?? null, lead?.address || profile.address || venueRows[0]?.address || null)
        || (lead ? 'Singapore' : 'Your selected location'),
      date: sgDate(nextSessionAt),
      time: sgTime(nextSessionAt),
      price: lead ? priceLabel(lead.price) : cheapest != null ? `From $${cheapest.toFixed(0)}` : null,
      rating: lead && lead.rating_count > 0 ? `${Number(lead.rating_avg).toFixed(1)} (${lead.rating_count})` : '',
      duration: formatDuration(durationMins),
      instantBook: lead ? !lead.external_booking_url : false,
      source: !lead ? 'profile' : lead.is_published ? 'published' : 'draft',
    });
  }, [providerId]);

  useEffect(() => {
    void (async () => { await load(); })();
  }, [load]);

  // Esc closes the desktop pop-up, like every other overlay in the portal.
  useEffect(() => {
    if (!desktopOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDesktopOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [desktopOpen]);

  /** What the read-only row prints for each field. */
  function fieldValue(key: FieldKey): string {
    if (key === 'address') return [prov.address, prov.postal_code].filter(Boolean).join(', ');
    if (key === 'identity') return prov.business_name;
    return (prov[key as keyof ProfileDraft] as string) ?? '';
  }

  function startEdit(key: FieldKey) {
    setFieldError(null);
    if (key === 'identity') setDraft({ business_name: prov.business_name, vendor_category: prov.vendor_category });
    else if (key === 'address') setDraft({ address: prov.address, postal_code: prov.postal_code });
    else setDraft({ [key]: (prov[key as keyof ProfileDraft] as string) ?? '' });
    setEditKey(key);
  }

  async function saveField() {
    if (!providerId || !editKey) return;
    setFieldError(null);

    let patch: ProviderUpdate;
    if (editKey === 'identity') {
      if (!draft.business_name?.trim()) return setFieldError('Business name can’t be empty.');
      patch = {
        business_name: draft.business_name.trim(),
        vendor_category: (draft.vendor_category || null) as VendorCategory | null,
      };
    } else if (editKey === 'address') {
      patch = { address: draft.address?.trim() || null, postal_code: draft.postal_code?.trim() || null };
    } else if (editKey === 'description') {
      // NOT NULL on the row — an emptied description is '', never null.
      patch = { description: draft.description?.trim() ?? '' };
    } else {
      // The remaining keys are all nullable text columns on `providers`; a
      // computed key widens to an index signature, hence the cast.
      patch = { [editKey]: draft[editKey]?.trim() || null } as ProviderUpdate;
    }

    setFieldBusy(true);
    const { error } = await supabase.from('providers').update(patch).eq('id', providerId);
    setFieldBusy(false);
    if (error) return setFieldError(error.message);
    setEditKey(null);
    await load();
    await refreshProvider();
  }

  async function handleSave() {
    if (!providerId || !canSave || savingListing) return;
    setSavingListing(true);
    setSaveError(null);
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('providers')
      .update({ vendor_terms_accepted_at: now })
      .eq('id', providerId);
    setSavingListing(false);
    if (error) return setSaveError(error.message);
    await refreshProvider();
    // Land on the profile that now exists, not the portal home.
    navigate('/settings');
  }

  /** One editable summary row: label, current value, pencil, inline editor. */
  function FieldRow({ field }: { field: SummaryField }) {
    const isEditing = editKey === field.key;
    const value = fieldValue(field.key);
    return (
      <div className="flex items-start gap-3 rounded-xl bg-gray-50 p-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white">
          <field.icon className="h-4 w-4 text-gray-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 text-xs text-gray-500">{field.label}</div>
          {isEditing ? (
            <div className="space-y-2">
              {field.key === 'description' ? (
                <Textarea
                  rows={4}
                  value={draft.description ?? ''}
                  onChange={(e) => setDraft({ description: e.target.value })}
                  placeholder="What you do, who it's for, what makes it special."
                  className="resize-none rounded-lg border-gray-300 text-sm"
                />
              ) : field.key === 'address' ? (
                <>
                  <Input
                    value={draft.address ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
                    placeholder="Street address"
                    className="rounded-lg border-gray-300 text-sm"
                  />
                  <Input
                    value={draft.postal_code ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, postal_code: e.target.value }))}
                    placeholder="Postal code"
                    className="rounded-lg border-gray-300 text-sm"
                  />
                </>
              ) : (
                <Input
                  value={draft[field.key] ?? ''}
                  onChange={(e) => setDraft({ [field.key]: e.target.value })}
                  placeholder={field.key === 'website' ? 'https://…' : field.label}
                  className="rounded-lg border-gray-300 text-sm"
                />
              )}
              {fieldError && <p className="text-xs text-red-500">{fieldError}</p>}
              <div className="flex gap-2">
                <Button size="sm" onClick={saveField} disabled={fieldBusy} className="gradient-primary h-7 rounded-lg text-xs text-white hover:opacity-90">
                  {fieldBusy ? 'Saving…' : 'Save'}
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setEditKey(null); setFieldError(null); }} className="h-7 rounded-lg border-gray-300 text-xs">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className={cn('whitespace-pre-line text-sm', value ? 'text-gray-900' : 'text-gray-400')}>
              {value || 'Not set'}
            </div>
          )}
          {field.hint && !isEditing && <p className="mt-1 text-[11px] text-gray-400">{field.hint}</p>}
        </div>
        {!isEditing && (
          <button type="button" aria-label={`Edit ${field.label}`} onClick={() => startEdit(field.key)} className="flex-shrink-0">
            <Pencil className="h-4 w-4 cursor-pointer text-gray-400 hover:text-[#FA4D8D]" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-100 px-8 py-4">
        <div className="flex cursor-pointer items-center gap-2" onClick={() => navigate('/')}>
          <BrandLogo className="h-10" />
        </div>
        <Button variant="outline" onClick={() => navigate('/dashboard')} className="gap-2 rounded-lg border-gray-300 text-gray-700 hover:bg-gray-50">
          <ArrowLeft className="h-4 w-4" />
          Save &amp; exit
        </Button>
      </header>

      {/* Content */}
      <div className="mx-auto max-w-6xl px-8 py-8">
        {/* Title */}
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-3xl font-bold text-[#111A4C]">Review your listing</h1>
          <p className="text-gray-600">Check the accuracy of your details, make any adjustments required and save.</p>
        </div>

        {/* flex-wrap so the desktop preview can drop onto a full-width row
            of its own instead of crushing the summary beside it. */}
        <div className="flex flex-wrap items-start gap-8">
          {/* Left Sidebar */}
          <div className="w-56 flex-shrink-0">
            {/* The supplied stacked lockup, not a re-typeset copy of it — the
                wordmark has its own face and per-letter colours, so a web-font
                rebuild reads as the wrong logo. */}
            <div className="mb-6 flex justify-center">
              <BrandStacked className="h-32" />
            </div>
            <h3 className="mb-2 text-center text-lg font-bold text-[#111A4C]">Almost there! <span className="text-lg">🚀</span></h3>
            <p className="mb-6 text-center text-sm text-gray-600">Review the information about your business, edit anything you wish and save.</p>

            <div className="rounded-xl bg-pink-50 p-4">
              <h4 className="mb-3 text-sm font-semibold text-[#FA4D8D]">Why it matters</h4>
              <div className="space-y-3">
                {whyMatters.map((item, idx) => (
                  <div key={idx} className="flex gap-2">
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-white">
                      <item.icon className="h-3 w-3 text-[#FA4D8D]" />
                    </div>
                    <span className="text-xs text-gray-700">{item.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Center — the profile summary */}
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900">Summary of your listing</h3>
            <p className="mb-4 mt-1 text-xs text-gray-500">
              These are the details on your profile. Edit anything here and it saves straight away.
            </p>

            {/* Identity — logo, name, category and how complete the profile is */}
            <div className="rounded-xl border border-gray-200 p-4">
              <div className="flex items-start gap-4">
                <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-pink-100">
                  {prov.logo_url
                    ? <img src={prov.logo_url} alt="" className="h-full w-full object-cover" />
                    : <Store className="h-7 w-7 text-[#FA4D8D]" />}
                </div>
                <div className="min-w-0 flex-1">
                  {editKey === 'identity' ? (
                    <div className="space-y-2">
                      <Input
                        value={draft.business_name ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, business_name: e.target.value }))}
                        placeholder="Business name"
                        className="rounded-lg border-gray-300 text-sm"
                      />
                      <select
                        value={draft.vendor_category ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, vendor_category: e.target.value }))}
                        className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm"
                      >
                        <option value="">Select a category</option>
                        {VENDOR_CATEGORIES.map((c) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                      {fieldError && <p className="text-xs text-red-500">{fieldError}</p>}
                      <div className="flex gap-2">
                        <Button size="sm" onClick={saveField} disabled={fieldBusy} className="gradient-primary h-7 rounded-lg text-xs text-white hover:opacity-90">
                          {fieldBusy ? 'Saving…' : 'Save'}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => { setEditKey(null); setFieldError(null); }} className="h-7 rounded-lg border-gray-300 text-xs">
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <h4 className="truncate text-lg font-bold text-gray-900">{prov.business_name || 'Your business'}</h4>
                      <p className="text-sm text-gray-500">{prov.vendor_category ? categoryLabel(prov.vendor_category) : 'No category yet'}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <Progress value={completion(prov)} className="h-2 w-32" />
                        <span className="text-xs font-semibold text-gray-500">{completion(prov)}% complete</span>
                      </div>
                    </>
                  )}
                </div>
                {editKey !== 'identity' && (
                  <button type="button" aria-label="Edit business name and category" onClick={() => startEdit('identity')} className="flex-shrink-0">
                    <Pencil className="h-4 w-4 cursor-pointer text-gray-400 hover:text-[#FA4D8D]" />
                  </button>
                )}
              </div>
            </div>

            {SUMMARY_SECTIONS.map((section) => (
              <div key={section.title} className="mt-5">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">{section.title}</h4>
                <div className="space-y-2">
                  {section.fields.map((f) => <FieldRow key={f.key} field={f} />)}
                </div>
              </div>
            ))}

            {/* Programmes — aggregates over activities and locations, so each
                pencil opens the editor that owns them rather than editing here. */}
            <div className="mt-5">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Your programmes</h4>
              <div className="space-y-2">
                {glance.map((row) => (
                  <div key={row.label} className="flex items-start gap-3 rounded-xl bg-gray-50 p-3">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white">
                      <row.icon className="h-4 w-4 text-gray-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-0.5 text-xs text-gray-500">{row.label}</div>
                      <div className="text-sm text-gray-900">{row.value}</div>
                    </div>
                    <button type="button" aria-label={`Edit ${row.label}`} onClick={() => navigate(row.to)} className="flex-shrink-0">
                      <Pencil className="h-4 w-4 cursor-pointer text-gray-400 hover:text-[#FA4D8D]" />
                    </button>
                  </div>
                ))}

                {/* Venues & schedules — supports multiple locations */}
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white">
                        <MapPin className="h-4 w-4 text-gray-500" />
                      </div>
                      <div className="text-xs text-gray-500">
                        Venues &amp; schedules
                        {venues.length > 1 && (
                          <span className="ml-1 font-medium text-[#FA4D8D]">· {venues.length} locations detected</span>
                        )}
                      </div>
                    </div>
                    <button type="button" aria-label="Edit venues &amp; schedules" onClick={() => navigate('/activities?tab=locations')} className="flex-shrink-0">
                      <Pencil className="h-4 w-4 cursor-pointer text-gray-400 hover:text-[#FA4D8D]" />
                    </button>
                  </div>
                  <div className="space-y-2">
                    {venues.map((v, i) => (
                      <div key={i} className="rounded-lg border border-gray-100 bg-white p-3">
                        <div className="text-sm font-semibold text-gray-900">{v.name}</div>
                        <div className="mt-1 flex items-start gap-1.5 text-xs text-gray-600">
                          <MapPin className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
                          <span>{v.address}</span>
                        </div>
                        <div className="mt-1 flex items-start gap-1.5 text-xs text-gray-600">
                          <Clock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
                          <span className="whitespace-pre-line">{v.hours}</span>
                        </div>
                      </div>
                    ))}
                    {venues.length === 0 && <p className="text-sm text-gray-400">No venues added yet.</p>}
                  </div>
                  <p className="mt-2 text-[11px] text-gray-400">
                    Different activities can run at different venues &amp; times — add a venue for each location so parents see the right schedule.
                  </p>
                </div>
              </div>
            </div>

            {/* Required to publish */}
            <div className="mt-6 rounded-xl border border-gray-200 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Shield className="h-5 w-5 text-[#FA4D8D]" />
                <h4 className="font-semibold text-gray-900">Required to publish</h4>
              </div>
              <div className="flex items-start gap-3">
                <Checkbox
                  id="vendor-terms"
                  checked={agreedVendor}
                  onCheckedChange={(c) => setAgreedVendor(c === true)}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <label htmlFor="vendor-terms" className="cursor-pointer text-sm text-gray-700">
                    You hereby acknowledge that you have read our Terms of Service, Terms of Use and Privacy Policy and confirm that you are in agreement with and legally bound by such terms, as modified from time to time.
                  </label>
                  <a href="/terms" target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11px] text-gray-400 underline hover:text-gray-600">
                    Full site terms &amp; privacy
                  </a>
                </div>
                <button
                  type="button"
                  onClick={() => setViewingDoc(VENDOR_TERMS)}
                  className="flex-shrink-0 text-xs text-[#FA4D8D] hover:underline"
                >
                  View terms
                </button>
              </div>
            </div>
          </div>

          {/* Right — the parent app's own listing card, on a phone; the
              desktop view opens as a pop-up over the page so switching never
              moves the vendor away from the summary they are reviewing.

              Both are copies of real parent components (ActivityCard and
              ActivityRow in frontends/parent components/ui.tsx), down to their
              palette, radii and Nunito face: a vendor-styled approximation
              showed fields and buttons (Call, Map) families never see. */}
          <div className="w-80 flex-shrink-0">
            <h3 className="font-semibold text-gray-900">Preview on BabyBrain.sg</h3>
            <p className="mb-3 mt-1 text-xs text-gray-500">This is how parents will see your business.</p>

            <div className="mb-4 flex gap-2">
              <button
                type="button"
                onClick={() => setDesktopOpen(false)}
                className={cn(
                  'flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  desktopOpen ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-gray-900 text-white'
                )}
              >
                <Smartphone className="h-3 w-3" />
                Mobile
              </button>
              <button
                type="button"
                onClick={() => setDesktopOpen(true)}
                className={cn(
                  'flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  desktopOpen ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                )}
              >
                <Monitor className="h-3 w-3" />
                Desktop
              </button>
            </div>

            {/* Phone frame — the vertical ActivityCard, as it appears on the
                parent app's home, matches and favourites rails. */}
            <div className="mx-auto w-[300px] rounded-[1.8rem] bg-gray-800 p-1.5 shadow-xl">
              <div
                className="overflow-hidden rounded-[1.4rem] bg-[#FFFCF8] p-3"
                style={{ fontFamily: "Nunito, 'Inter', -apple-system, sans-serif" }}
              >
                <article
                  className="overflow-hidden rounded-[14px] border border-[#EBE3E5] bg-white"
                  style={{ boxShadow: '0 1px 2px rgba(17,26,76,0.04), 0 6px 16px rgba(17,26,76,0.06)' }}
                >
                  <div className="relative h-[108px]">
                    <img src={card.image} alt="" className="h-full w-full object-cover" />
                    <span className="absolute left-3 top-3 rounded-full bg-white/95 px-3 py-1 text-xs font-bold text-[#A7D8F8]">
                      {card.category}
                    </span>
                    {card.instantBook && (
                      <span className="absolute bottom-3 left-3 flex items-center gap-1 rounded-full bg-[#F1FBEF] px-2.5 py-1 text-[11px] font-bold text-[#A8E59A]">
                        <Sparkles className="h-3 w-3" /> Instant book
                      </span>
                    )}
                    <span className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full bg-white text-[#FFC1D6] shadow">
                      <Heart className="h-[18px] w-[18px]" />
                    </span>
                  </div>
                  <div className="p-3.5">
                    <h3 className="mb-0.5 text-[15px] font-black leading-tight text-[#111A4C]">{card.title}</h3>
                    {card.providerName && (
                      <p className="mb-2 flex items-center gap-1.5 text-[11.5px] font-bold text-[#A7D8F8]">
                        <Store className="h-3.5 w-3.5" /> {card.providerName}
                      </p>
                    )}
                    <div className="space-y-1 text-[11.5px] font-semibold text-[#4a5685]">
                      <p className="flex items-center gap-1.5"><User className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.age}</p>
                      <p className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.place}</p>
                      <p className="flex items-center gap-1.5">
                        <CalendarDays className="h-3.5 w-3.5 text-[#A7D8F8]" />
                        {card.date ? `${card.date} · ${card.time}` : 'Schedule TBC'}
                      </p>
                      {card.price && <p className="font-black text-[#A7D8F8]">{card.price}</p>}
                      {(card.rating || card.duration) && (
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {card.rating && (
                            <span className="flex items-center gap-1.5"><Star className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.rating}</span>
                          )}
                          {card.duration && (
                            <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.duration}</span>
                          )}
                        </p>
                      )}
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-[#F4EFF0] pt-3">
                      <span className="text-sm font-extrabold text-[#A7D8F8]">View details</span>
                      <ExternalLink className="h-5 w-5 text-[#A7D8F8]" />
                    </div>
                  </div>
                </article>
              </div>
            </div>

            <p className="mt-3 text-center text-[11px] text-gray-400">{previewNote}</p>
          </div>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-gray-200 bg-white px-8 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <Button
            variant="outline"
            onClick={() => navigate('/claim-business')}
            className="gap-2 rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Lock className="h-4 w-4" />
            Your information is secure
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button
              onClick={handleSave}
              disabled={!canSave || savingListing}
              className="gradient-primary gap-2 rounded-xl px-8 text-white hover:opacity-90 disabled:opacity-50"
            >
              {savingListing ? 'Saving…' : 'Save'}
              <Send className="h-4 w-4" />
            </Button>
            {/* One message slot, always taking its line — hidden rather than
                removed. Dropping it out of the layout changed the bar's height,
                so ticking the box shunted Back, the lock line and Save. Now
                only the button's own colour changes. */}
            <p
              className={cn(
                'text-[11px]',
                saveError ? 'text-red-500' : 'text-gray-400',
                !saveError && canSave && 'invisible'
              )}
            >
              {saveError || 'Tick the Vendor Terms to continue.'}
            </p>
          </div>
        </div>
      </div>

      <div className="h-20" />

      {/* Desktop view — a pop-up over the page, so the vendor never loses
          their place in the summary. The window holds the horizontal
          ActivityRow, which is how Explore lists results on a wide screen. */}
      {desktopOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/25 p-4 backdrop-blur-sm"
          onClick={() => setDesktopOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Desktop preview of your listing"
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
              <div className="flex items-center gap-2.5">
                <Monitor className="h-4 w-4 flex-shrink-0 text-[#FA4D8D]" />
                <div>
                  <h3 className="text-sm font-bold text-[#111A4C]">Desktop view</h3>
                  <p className="text-xs text-gray-500">This is how parents will see your business on a desktop.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDesktopOpen(false)}
                aria-label="Close desktop preview"
                className="rounded-lg p-1.5 hover:bg-gray-100"
              >
                <X className="h-4 w-4 text-gray-500" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 p-5">
              <div className="overflow-hidden rounded-xl border border-gray-200 shadow-xl">
                <div className="flex items-center gap-1.5 border-b border-gray-200 bg-gray-100 px-3 py-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                  <span className="h-2.5 w-2.5 rounded-full bg-yellow-400" />
                  <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
                  <div className="ml-3 flex-1 truncate rounded border border-gray-200 bg-white px-2 py-0.5 text-[10px] text-gray-400">
                    babybrain.sg/explore
                  </div>
                </div>
                <div
                  className="bg-[#FFFCF8] p-4"
                  style={{ fontFamily: "Nunito, 'Inter', -apple-system, sans-serif" }}
                >
                  <article
                    className="grid grid-cols-[170px_1fr] overflow-hidden rounded-[12px] border border-[#EBE3E5] bg-white xl:grid-cols-[220px_1fr]"
                    style={{ boxShadow: '0 1px 2px rgba(17,26,76,0.04), 0 6px 16px rgba(17,26,76,0.06)' }}
                  >
                    <div className="relative">
                      <img src={card.image} alt="" className="h-full min-h-[100px] w-full object-cover" />
                      <span className="absolute left-3 top-3 rounded-full bg-white/95 px-3 py-1 text-xs font-bold text-[#A7D8F8]">
                        {card.category}
                      </span>
                      {card.instantBook && (
                        <span className="absolute bottom-3 left-3 flex items-center gap-1 rounded-full bg-[#F1FBEF] px-2.5 py-1 text-[11px] font-bold text-[#A8E59A]">
                          <Sparkles className="h-3 w-3" /> Instant book
                        </span>
                      )}
                    </div>
                    <div className="relative p-4">
                      <span className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-white text-[#FFC1D6] shadow">
                        <Heart className="h-[18px] w-[18px]" />
                      </span>
                      <h3 className="mb-0.5 text-[16px] font-black text-[#111A4C]">{card.title}</h3>
                      {card.providerName && (
                        <p className="mb-2 flex items-center gap-1.5 text-[11.5px] font-bold text-[#A7D8F8]">
                          <Store className="h-3.5 w-3.5" /> {card.providerName}
                        </p>
                      )}
                      <div className="grid grid-cols-2 gap-y-1.5 pr-10 text-[11.5px] font-semibold text-[#52608b]">
                        <p className="flex items-center gap-1"><User className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.age}</p>
                        <p className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.place}</p>
                        <p className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.date || 'Schedule TBC'}</p>
                        <p>{card.time}</p>
                        {card.duration && (
                          <p className="flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.duration}</p>
                        )}
                        {card.price && <p className="font-black text-[#A7D8F8]">{card.price}</p>}
                        {card.rating && (
                          <p className="flex items-center gap-1"><Star className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.rating}</p>
                        )}
                      </div>
                    </div>
                  </article>
                </div>
              </div>
            </div>

            <div className="border-t border-gray-200 px-5 py-2.5 text-center text-xs text-gray-500">{previewNote}</div>
          </div>
        </div>
      )}
      <Sheet open={!!viewingDoc} onOpenChange={(open) => { if (!open) setViewingDoc(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          {viewingDoc && (
            <>
              <SheetHeader>
                <SheetTitle>{viewingDoc.title}</SheetTitle>
                <SheetDescription>{viewingDoc.summary}</SheetDescription>
              </SheetHeader>
              <div className="space-y-5 px-4 pb-6">
                {viewingDoc.sections.map((s) => (
                  <div key={s.heading} className="rounded-xl border-2 border-gray-300 bg-white p-4 shadow-sm">
                    <h4 className="mb-1 text-sm font-semibold text-gray-900">{s.heading}</h4>
                    <p className="text-sm leading-relaxed text-gray-600">{s.body}</p>
                  </div>
                ))}
                <a href="/terms" target="_blank" rel="noreferrer" className="inline-block text-xs text-[#FA4D8D] underline">
                  Read the full BabyBrain site terms &amp; privacy policy
                </a>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
