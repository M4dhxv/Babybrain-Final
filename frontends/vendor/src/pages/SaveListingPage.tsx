import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { SelectField, Opt } from '@/components/ui/select-field';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { cn } from '@/lib/utils';
import { BrandLogo, BrandStacked } from '@/components/BrandLogo';
import { VENDOR_CATEGORIES, categoryLabel } from '@/lib/categories';
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

/** One editable summary row: label, current value, pencil, inline editor.
 *  Hoisted to module scope — defined inside SaveListingPage, it was a new
 *  function identity on every render, so React remounted the <Input> on
 *  every keystroke (losing focus after the first character typed). */
function FieldRow({
  field,
  value,
  isEditing,
  draft,
  setDraft,
  fieldError,
  fieldBusy,
  onStartEdit,
  onSave,
  onCancel,
}: {
  field: SummaryField;
  value: string;
  isEditing: boolean;
  draft: Record<string, string>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  fieldError: string | null;
  fieldBusy: boolean;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
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
              <Button size="sm" onClick={onSave} disabled={fieldBusy} className="gradient-primary h-7 rounded-lg text-xs text-white hover:opacity-90">
                {fieldBusy ? 'Saving…' : 'Save'}
              </Button>
              <Button size="sm" variant="outline" onClick={onCancel} className="h-7 rounded-lg border-gray-300 text-xs">
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
        <button type="button" aria-label={`Edit ${field.label}`} onClick={onStartEdit} className="flex-shrink-0">
          <Pencil className="h-4 w-4 cursor-pointer text-gray-400 hover:text-[#FA4D8D]" />
        </button>
      )}
    </div>
  );
}

export default function SaveListingPage() {
  const navigate = useNavigate();
  const { provider: activeProvider, providerResolved, session, refreshProvider } = useAuth();
  const providerId = activeProvider?.id ?? null;
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [prov, setProv] = useState<ProfileDraft>(EMPTY_PROFILE);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [glance, setGlance] = useState<GlanceRow[]>(EMPTY_GLANCE);
  // Never null: the card is the shape of the real listing, so an empty
  // profile still shows the shape rather than an empty phone.
  const [card, setCard] = useState<PreviewCard>(EMPTY_CARD);

  /* The desktop mockup is sized to its own content instead of a guessed
     constant — a fixed width either wasted a lot of space after a short
     title or clipped/wrapped a long one. `desktopFrameWidth` starts at a
     sane fallback and is recomputed below from the actual rendered title,
     provider name and info-grid items, so it always ends right after the
     longest of them regardless of what this vendor's listing says. */
  const [desktopFrameWidth, setDesktopFrameWidth] = useState(600);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const providerRef = useRef<HTMLParagraphElement>(null);
  const infoGridRef = useRef<HTMLDivElement>(null);

  // useLayoutEffect, not useEffect: this measures the just-rendered DOM and
  // writes the result straight back into layout (the frame's width), so it
  // has to happen before the browser paints — otherwise switching to
  // Desktop would flash at the fallback width for a frame first.
  useLayoutEffect(() => {
    if (!desktopOpen) return;
    // The image column follows the same xl: breakpoint as the mockup's own
    // Tailwind classes (170px below 1280px viewport width, 220px at/above).
    const imageCol = window.innerWidth >= 1280 ? 220 : 170;
    // Reads each element's true single-line width via Range rather than
    // getBoundingClientRect() on the element itself — a block/flex element
    // with no explicit width reports its filled CELL width, not its text's
    // width. That measurement is only trustworthy because these elements
    // are whitespace-nowrap: read while already wrapped (e.g. right after
    // a narrower title shrank the frame), it'd report the widest *line*,
    // not the width needed to stop wrapping — permanently undersizing the
    // frame from then on.
    const measure = (el: Element | null) => {
      if (!el) return 0;
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    };
    const titleWidth = measure(titleRef.current);
    const providerWidth = measure(providerRef.current);
    const infoItemWidths = infoGridRef.current
      ? Array.from(infoGridRef.current.children).map(measure)
      : [];
    const maxInfoItem = infoItemWidths.length ? Math.max(...infoItemWidths) : 0;
    // Each candidate is "the content" plus however much of the pane's own
    // p-4/pr-10 padding and the heart button actually sit in its way — the
    // title runs under the top-right heart icon, the two-column info grid
    // stops at pr-10 well short of it, so their clearances differ.
    const paneWidth = Math.max(
      titleWidth + 76, // p-4 left (16) + clearing the heart button (52) + a little air
      providerWidth + 32, // p-4 both sides (16 + 16)
      maxInfoItem * 2 + 56 // p-4 left (16) + pr-10 (40), columns split the rest evenly
    );
    const next = Math.round(imageCol + paneWidth + 32); // the card's own p-4 wrapper (16 + 16)
    setDesktopFrameWidth(Math.max(480, Math.min(880, next)));
  }, [desktopOpen, card]);

  // Inline edit state — one field at a time.
  const [editKey, setEditKey] = useState<FieldKey | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [fieldBusy, setFieldBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

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
    if (!editKey) return;
    // Don't fail silently while the business membership is still resolving —
    // tell the vendor to retry rather than leaving the editor open and inert.
    if (!providerId) return setFieldError('Still loading your business — wait a moment and try again.');
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

  function handleSave() {
    if (!providerId) return;
    // Consent is captured earlier, on /claim-business — nothing left to write
    // here. Land on the profile that now exists, not the portal home.
    navigate('/settings');
  }

  // The whole page edits `providers` rows for `providerId`. Coming here straight
  // from the claim flow, the membership lookup that resolves `providerId` can
  // still be in flight for a beat — render a wait state rather than a page whose
  // pencils open editors that can't save.
  if (!providerId) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-8 text-center">
        <BrandLogo className="h-10" />
        {!session ? (
          <>
            <p className="text-gray-600">Sign in to review and publish your listing.</p>
            <Button onClick={() => navigate('/login')} className="gradient-primary rounded-xl px-8 text-white hover:opacity-90">
              Log in
            </Button>
          </>
        ) : !providerResolved ? (
          <p className="text-gray-500">Loading your business…</p>
        ) : (
          <>
            <p className="text-gray-600">We couldn’t find a business on this account yet.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => navigate('/claim-business')} className="rounded-xl border-gray-300">
                Claim your business
              </Button>
              <Button onClick={() => navigate('/dashboard')} className="gradient-primary rounded-xl px-6 text-white hover:opacity-90">
                Go to dashboard
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    // overflow-x-hidden: the desktop preview below deliberately overflows
    // its column to the right. Without this, that turned into a page-level
    // horizontal scrollbar that appeared/disappeared switching Mobile ↔
    // Desktop, and the fixed bottom bar visibly jumped by the scrollbar's
    // height each time — clip it instead of scrolling to it.
    <div className="min-h-screen overflow-x-hidden bg-white">
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
                      <SelectField
                        value={draft.vendor_category ?? ''}
                        onChange={(v) => setDraft((d) => ({ ...d, vendor_category: v as VendorCategory }))}
                        placeholder="Select a category"
                        aria-label="Business category"
                        className="w-full px-2 py-1.5"
                      >
                        <Opt value="">Select a category</Opt>
                        {VENDOR_CATEGORIES.map((c) => (
                          <Opt key={c.value} value={c.value}>{c.label}</Opt>
                        ))}
                      </SelectField>
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
                  {section.fields.map((f) => (
                    <FieldRow
                      key={f.key}
                      field={f}
                      value={fieldValue(f.key)}
                      isEditing={editKey === f.key}
                      draft={draft}
                      setDraft={setDraft}
                      fieldError={fieldError}
                      fieldBusy={fieldBusy}
                      onStartEdit={() => startEdit(f.key)}
                      onSave={saveField}
                      onCancel={() => { setEditKey(null); setFieldError(null); }}
                    />
                  ))}
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
          </div>

          {/* Right — the parent app's own listing card. Mobile is the
              vertical ActivityCard from the home/matches/favourites rails;
              Desktop is the horizontal ActivityRow Explore uses on a wide
              screen, in its own browser-window mockup — it used to open that
              in a pop-up over the page, but that moved the vendor away from
              the summary they were reviewing. It now renders right here
              instead, in the same spot the phone frame occupies — this
              column's own width never changes, so the sidebar and summary
              beside it never move or resize either way. Only the mockup
              inside it is wider than the column (desktopFrameWidth, sized
              to the actual title/provider/details below rather than the
              column's 320px) and, since nothing here clips, it simply
              overflows into the page's own right-hand margin instead of
              being squeezed down to the phone's size. The page itself is
              overflow-x-hidden (see the top-level div) so that overflow can
              never turn into a horizontal scrollbar — without that, the
              bottom bar (position: fixed) visibly jumped up and down by the
              scrollbar's height every time the scrollbar appeared or
              disappeared switching modes.

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

            {desktopOpen ? (
              /* Same browser-window mockup that used to fill the pop-up,
                 unchanged — wider than its column on purpose, so it
                 overflows rightward from the same top-left spot the phone
                 frame starts at, rather than being shrunk to fit inside it.
                 The width itself (desktopFrameWidth, computed above) isn't
                 a guessed constant: a fixed number either left a lot of
                 dead space after a short title or clipped/wrapped a long
                 one, so it's measured from the title, provider name and
                 info-grid actually being rendered below. */
              <div
                style={{ width: desktopFrameWidth }}
                className="overflow-hidden rounded-xl border border-gray-200 shadow-xl"
              >
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
                      <h3 ref={titleRef} className="mb-0.5 whitespace-nowrap text-[16px] font-black text-[#111A4C]">{card.title}</h3>
                      {card.providerName && (
                        <p ref={providerRef} className="mb-2 flex items-center gap-1.5 whitespace-nowrap text-[11.5px] font-bold text-[#A7D8F8]">
                          <Store className="h-3.5 w-3.5" /> {card.providerName}
                        </p>
                      )}
                      <div ref={infoGridRef} className="grid grid-cols-2 gap-y-1.5 pr-10 text-[11.5px] font-semibold text-[#52608b]">
                        <p className="flex items-center gap-1 whitespace-nowrap"><User className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.age}</p>
                        <p className="flex items-center gap-1 whitespace-nowrap"><MapPin className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.place}</p>
                        <p className="flex items-center gap-1 whitespace-nowrap"><CalendarDays className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.date || 'Schedule TBC'}</p>
                        <p className="whitespace-nowrap">{card.time}</p>
                        {card.duration && (
                          <p className="flex items-center gap-1 whitespace-nowrap"><Clock className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.duration}</p>
                        )}
                        {card.price && <p className="whitespace-nowrap font-black text-[#A7D8F8]">{card.price}</p>}
                        {card.rating && (
                          <p className="flex items-center gap-1 whitespace-nowrap"><Star className="h-3.5 w-3.5 text-[#A7D8F8]" /> {card.rating}</p>
                        )}
                      </div>
                    </div>
                  </article>
                </div>
              </div>
            ) : (
              /* Phone frame — the vertical ActivityCard, as it appears on the
                 parent app's home, matches and favourites rails. */
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
            )}

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
          <Button
            onClick={handleSave}
            className="gradient-primary gap-2 rounded-xl px-8 text-white hover:opacity-90"
          >
            Save
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="h-20" />
    </div>
  );
}
