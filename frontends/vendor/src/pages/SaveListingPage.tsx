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
  Link,
  Phone,
  Shield,
  Lock,
  Bell,
  CheckCircle,
  Smartphone,
  Monitor,
  Heart,
  Star,
  MessageCircle,
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { BrandLogo, BrandIcon } from '@/components/BrandLogo';
import { VENDOR_CATEGORIES } from '@/lib/categories';
import { VENDOR_TERMS, type ComplianceDocument } from '@/lib/complianceTerms';
import type { VendorCategory } from '@/lib/database.types';

interface ListingRow {
  icon: typeof Store;
  label: string;
  value: string;
  color: string;
  bg: string;
}

interface VenueRow {
  name: string;
  address: string;
  hours: string;
}

/** Raw provider fields the inline editors write straight back to `providers`. */
interface ProviderDraft {
  business_name: string;
  vendor_category: string;
  website: string;
  whatsapp: string;
  contact_phone: string;
  contact_email: string;
}

// Rows whose pencil edits the value in place (a single `providers` column).
// Age range, Pricing and Venues are aggregates over activities/locations —
// there's no one field to set here, so their pencils deep-link to the real
// editor instead.
const EDITABLE = new Set(['Business name', 'Category', 'Booking link', 'Contact']);

const whyMatters = [
  { icon: Heart, text: 'Ensures accurate information for parents' },
  { icon: Shield, text: 'Builds trust and credibility for your business' },
  { icon: Heart, text: 'Helps parents discover and connect with you' },
  { icon: Bell, text: 'Keep your schedule and programmes up to date' },
];

export default function SaveListingPage() {
  const navigate = useNavigate();
  const { provider: activeProvider, refreshProvider } = useAuth();
  const providerId = activeProvider?.id ?? null;
  const [previewMode, setPreviewMode] = useState<'mobile' | 'desktop'>('mobile');
  const [agreedVendor, setAgreedVendor] = useState(false);
  const [listingData, setListingData] = useState<ListingRow[]>([]);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [prov, setProv] = useState<ProviderDraft | null>(null);

  // Inline edit state — one row at a time.
  const [editLabel, setEditLabel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [fieldBusy, setFieldBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Terms viewer + Save.
  const [viewingDoc, setViewingDoc] = useState<ComplianceDocument | null>(null);
  const [savingListing, setSavingListing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canSave = agreedVendor;

  // Values for the "Preview on BabyBrain.sg" panel — real data where we have
  // it, so the phone and desktop previews both reflect the actual listing
  // (and the earlier inline edits).
  const rowValue = (label: string) => listingData.find((r) => r.label === label)?.value ?? '';
  const previewName = prov?.business_name?.trim() || 'Your business name';
  const previewCategory = rowValue('Category') && rowValue('Category') !== 'Not set' ? rowValue('Category') : 'Your category';
  const previewArea = venues[0]?.address?.split(',')[0]?.trim() || 'Your venue';
  const previewPrice = rowValue('Pricing') && rowValue('Pricing') !== 'Not set' ? rowValue('Pricing') : null;
  const previewChips = [rowValue('Age range'), rowValue('Category')].filter((v) => v && v !== 'Not set') as string[];
  const previewInitials =
    previewName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || 'BB';
  const previewImg = `${import.meta.env.BASE_URL}assets/asset_2.jpg`;

  // Renders the business we actually hold; re-run after every inline save so
  // the summary and preview reflect the change without a full reload.
  const load = useCallback(async () => {
    if (!providerId) return;
    const [{ data: provider }, { data: acts }, { data: locs }] = await Promise.all([
      supabase
        .from('providers')
        .select('business_name, vendor_category, address, postal_code, website, contact_email, contact_phone, whatsapp')
        .eq('id', providerId)
        .maybeSingle(),
      supabase
        .from('activities')
        .select('age_min_months, age_max_months, price, external_booking_url')
        .eq('provider_id', providerId)
        .eq('is_published', true),
      supabase
        .from('provider_locations')
        .select('name, address, postal_code, operating_hours')
        .eq('provider_id', providerId),
    ]);

    const activities = acts ?? [];
    const ageMin = activities.length ? Math.min(...activities.map((a) => a.age_min_months)) : null;
    const ageMax = activities.length ? Math.max(...activities.map((a) => a.age_max_months)) : null;
    const prices = activities.map((a) => Number(a.price)).filter((n) => Number.isFinite(n) && n > 0);
    const bookingLink = activities.find((a) => a.external_booking_url)?.external_booking_url ?? provider?.website ?? null;
    const months = (m: number) => (m < 24 ? `${m} months` : `${Math.round(m / 12)} years`);

    setProv({
      business_name: provider?.business_name ?? '',
      vendor_category: provider?.vendor_category ?? '',
      website: provider?.website ?? '',
      whatsapp: provider?.whatsapp ?? '',
      contact_phone: provider?.contact_phone ?? '',
      contact_email: provider?.contact_email ?? '',
    });

    setListingData([
      { icon: Store, label: 'Business name', value: provider?.business_name ?? '—', color: 'text-purple-600', bg: 'bg-purple-100' },
      {
        icon: Baby,
        label: 'Category',
        value: VENDOR_CATEGORIES.find((c) => c.value === provider?.vendor_category)?.label ?? provider?.vendor_category ?? 'Not set',
        color: 'text-pink-600',
        bg: 'bg-pink-100',
      },
      {
        icon: Baby,
        label: 'Age range',
        value: ageMin != null && ageMax != null ? `${months(ageMin)} – ${months(ageMax)}` : 'Not set',
        color: 'text-green-600',
        bg: 'bg-green-100',
      },
      {
        icon: DollarSign,
        label: 'Pricing',
        value: prices.length
          ? `From $${Math.min(...prices).toFixed(0)} per session`
          : 'Not set',
        color: 'text-yellow-600',
        bg: 'bg-yellow-100',
      },
      { icon: Link, label: 'Booking link', value: bookingLink ?? 'Not set', color: 'text-green-600', bg: 'bg-green-100' },
      {
        icon: Phone,
        label: 'Contact',
        value: [
          provider?.whatsapp || provider?.contact_phone ? `WhatsApp: ${provider.whatsapp ?? provider.contact_phone}` : null,
          provider?.contact_email ? `Email: ${provider.contact_email}` : null,
        ].filter(Boolean).join('  •  ') || 'Not set',
        color: 'text-blue-600',
        bg: 'bg-blue-100',
      },
    ]);

    setVenues(
      (locs ?? []).map((l) => {
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
      })
    );
  }, [providerId]);

  useEffect(() => {
    void (async () => { await load(); })();
  }, [load]);

  function startEdit(label: string) {
    if (!prov) return;
    setFieldError(null);
    if (label === 'Business name') setDraft({ business_name: prov.business_name });
    else if (label === 'Category') setDraft({ vendor_category: prov.vendor_category });
    else if (label === 'Booking link') setDraft({ website: prov.website });
    else if (label === 'Contact') setDraft({ whatsapp: prov.whatsapp || prov.contact_phone, contact_email: prov.contact_email });
    setEditLabel(label);
  }

  async function saveField() {
    if (!providerId || !editLabel) return;
    setFieldError(null);
    const rows = supabase.from('providers');
    let error: { message: string } | null = null;
    if (editLabel === 'Business name') {
      if (!draft.business_name?.trim()) return setFieldError('Business name can’t be empty.');
      setFieldBusy(true);
      ({ error } = await rows.update({ business_name: draft.business_name.trim() }).eq('id', providerId));
    } else if (editLabel === 'Category') {
      setFieldBusy(true);
      ({ error } = await rows
        .update({ vendor_category: (draft.vendor_category || null) as VendorCategory | null })
        .eq('id', providerId));
    } else if (editLabel === 'Booking link') {
      setFieldBusy(true);
      ({ error } = await rows.update({ website: draft.website?.trim() || null }).eq('id', providerId));
    } else if (editLabel === 'Contact') {
      setFieldBusy(true);
      ({ error } = await rows
        .update({ whatsapp: draft.whatsapp?.trim() || null, contact_email: draft.contact_email?.trim() || null })
        .eq('id', providerId));
    } else {
      return;
    }
    setFieldBusy(false);
    if (error) return setFieldError(error.message);
    setEditLabel(null);
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

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/')}>
          <BrandLogo className="h-10" />

        </div>
        <Button variant="outline" onClick={() => navigate('/dashboard')} className="rounded-lg gap-2 border-gray-300 text-gray-700 hover:bg-gray-50">
          <ArrowLeft className="w-4 h-4" />
          Save & exit
        </Button>
      </header>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-8 py-8">
        {/* Title */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#111A4C] mb-2">Review your listing</h1>
          <p className="text-gray-600">Check the accuracy of your details, make any adjustments required and save.</p>
        </div>

        <div className="flex gap-8">
          {/* Left Sidebar */}
          <div className="w-56 flex-shrink-0">
            {/* Stacked lockup — the brain-icon mark over the wordmark, the
                word in the brand's own per-letter pastels. */}
            {/* logo-icon.png carries a lot of its own transparent padding, so
                the word is pulled up under it with a negative margin rather
                than relying on flex gap. */}
            <div className="-mt-4 mb-8 flex flex-col items-center">
              <BrandIcon className="h-40 w-40" />
              <span className="-mt-10 text-2xl font-extrabold tracking-tight">
                <span className="text-[#FFB0CE]">B</span>
                <span className="text-[#FFB0CE]">a</span>
                <span className="text-[#FFB278]">b</span>
                <span className="text-[#FFCB5E]">y</span>
                <span className="text-[#8FDD80]">B</span>
                <span className="text-[#7FCBF0]">r</span>
                <span className="text-[#7FCBF0]">a</span>
                <span className="text-[#B79FDE]">i</span>
                <span className="text-[#B79FDE]">n</span>
              </span>
            </div>
            <h3 className="mb-2 text-center text-lg font-bold text-[#111A4C]">Almost there! <span className="text-lg">🚀</span></h3>
            <p className="mb-6 text-center text-sm text-gray-600">Review the information about your business, edit anything you wish and save.</p>

            <div className="bg-pink-50 rounded-xl p-4">
              <h4 className="text-sm font-semibold text-[#FA4D8D] mb-3">Why it matters</h4>
              <div className="space-y-3">
                {whyMatters.map((item, idx) => (
                  <div key={idx} className="flex gap-2">
                    <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center flex-shrink-0">
                      <item.icon className="w-3 h-3 text-[#FA4D8D]" />
                    </div>
                    <span className="text-xs text-gray-700">{item.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Center - Summary */}
          <div className="flex-1">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Summary of your listing</h3>
            </div>

            <div className="space-y-3">
              {listingData.map((item, idx) => {
                const editable = EDITABLE.has(item.label);
                const isEditing = editLabel === item.label;
                return (
                  <div key={idx} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
                    <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', item.bg)}>
                      <item.icon className={cn('w-4 h-4', item.color)} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-500 mb-0.5">{item.label}</div>
                      {isEditing ? (
                        <div className="space-y-2">
                          {item.label === 'Category' ? (
                            <select
                              value={draft.vendor_category ?? ''}
                              onChange={(e) => setDraft({ vendor_category: e.target.value })}
                              className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm"
                            >
                              <option value="">Not set</option>
                              {VENDOR_CATEGORIES.map((c) => (
                                <option key={c.value} value={c.value}>{c.label}</option>
                              ))}
                            </select>
                          ) : item.label === 'Contact' ? (
                            <>
                              <Input
                                value={draft.whatsapp ?? ''}
                                onChange={(e) => setDraft((d) => ({ ...d, whatsapp: e.target.value }))}
                                placeholder="WhatsApp / phone"
                                className="rounded-lg border-gray-300 text-sm"
                              />
                              <Input
                                value={draft.contact_email ?? ''}
                                onChange={(e) => setDraft((d) => ({ ...d, contact_email: e.target.value }))}
                                placeholder="Email"
                                className="rounded-lg border-gray-300 text-sm"
                              />
                            </>
                          ) : (
                            <Input
                              value={draft[item.label === 'Booking link' ? 'website' : 'business_name'] ?? ''}
                              onChange={(e) =>
                                setDraft({ [item.label === 'Booking link' ? 'website' : 'business_name']: e.target.value })
                              }
                              placeholder={item.label === 'Booking link' ? 'https://…' : item.label}
                              className="rounded-lg border-gray-300 text-sm"
                            />
                          )}
                          {item.label === 'Booking link' && (
                            <p className="text-[11px] text-gray-400">
                              Your business booking/website link. An activity with its own link overrides this.
                            </p>
                          )}
                          {fieldError && <p className="text-xs text-red-500">{fieldError}</p>}
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={saveField}
                              disabled={fieldBusy}
                              className="h-7 gradient-primary rounded-lg text-xs text-white hover:opacity-90"
                            >
                              {fieldBusy ? 'Saving…' : 'Save'}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => { setEditLabel(null); setFieldError(null); }}
                              className="h-7 rounded-lg border-gray-300 text-xs"
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-sm text-gray-900 whitespace-pre-line">{item.value}</div>
                      )}
                    </div>
                    {!isEditing && (
                      <button
                        type="button"
                        aria-label={`Edit ${item.label}`}
                        onClick={() =>
                          editable
                            ? startEdit(item.label)
                            : navigate(item.label === 'Age range' || item.label === 'Pricing' ? '/activities' : '/settings?edit=1')
                        }
                        className="flex-shrink-0"
                      >
                        <Pencil className="w-4 h-4 text-gray-400 cursor-pointer hover:text-[#FA4D8D]" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Venues & schedules — supports multiple locations */}
            <div className="mt-3 p-3 bg-gray-50 rounded-xl">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center flex-shrink-0">
                    <MapPin className="w-4 h-4 text-green-600" />
                  </div>
                  <div className="text-xs text-gray-500">
                    Venues &amp; schedules
                    {venues.length > 1 && (
                      <span className="ml-1 text-[#FA4D8D] font-medium">· {venues.length} locations detected</span>
                    )}
                  </div>
                </div>
                <button type="button" aria-label="Edit venues & schedules" onClick={() => navigate('/activities?tab=locations')} className="flex-shrink-0">
                  <Pencil className="w-4 h-4 text-gray-400 cursor-pointer hover:text-gray-600" />
                </button>
              </div>
              <div className="space-y-2">
                {venues.map((v, i) => (
                  <div key={i} className="rounded-lg bg-white border border-gray-100 p-3">
                    <div className="text-sm font-semibold text-gray-900">{v.name}</div>
                    <div className="flex items-start gap-1.5 mt-1 text-xs text-gray-600">
                      <MapPin className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                      <span>{v.address}</span>
                    </div>
                    <div className="flex items-start gap-1.5 mt-1 text-xs text-gray-600">
                      <Clock className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                      <span className="whitespace-pre-line">{v.hours}</span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-2">
                Different activities can run at different venues &amp; times — add a venue for each location so parents see the right schedule.
              </p>
            </div>

            {/* Required to publish */}
            <div className="mt-6 p-4 border border-gray-200 rounded-xl">
              <div className="flex items-center gap-2 mb-3">
                <Shield className="w-5 h-5 text-[#FA4D8D]" />
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
                  <label htmlFor="vendor-terms" className="text-sm text-gray-700 cursor-pointer">
                    You hereby acknowledge that you have read our Terms of Service, Terms of Use and Privacy Policy and confirm that you are in agreement with and legally bound by such terms, as modified from time to time.
                  </label>
                  <p className="text-xs text-gray-500 mt-1">
                    Includes content ownership, child photo consent, PDPA obligations, review policy, platform rules and suspension & removal rights.
                  </p>
                  <a href="/terms" target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11px] text-gray-400 underline hover:text-gray-600">
                    Full site terms &amp; privacy
                  </a>
                </div>
                <button
                  type="button"
                  onClick={() => setViewingDoc(VENDOR_TERMS)}
                  className="text-xs text-[#FA4D8D] hover:underline flex-shrink-0"
                >
                  View terms
                </button>
              </div>
            </div>

          </div>

          {/* Right - Preview */}
          <div className={cn('flex-shrink-0 transition-[width] duration-300', previewMode === 'mobile' ? 'w-80' : 'w-full max-w-xl')}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Preview on BabyBrain.sg</h3>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              This is how parents will see your venue on {previewMode === 'mobile' ? 'a phone' : 'desktop'}.
            </p>

            {/* Mode Toggle */}
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setPreviewMode('mobile')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  previewMode === 'mobile' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                )}
              >
                <Smartphone className="w-3 h-3" />
                Mobile
              </button>
              <button
                onClick={() => setPreviewMode('desktop')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  previewMode === 'desktop' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                )}
              >
                <Monitor className="w-3 h-3" />
                Desktop
              </button>
            </div>

            {previewMode === 'mobile' ? (
              /* Phone frame — narrow, single column */
              <div className="mx-auto w-[300px] bg-gray-800 rounded-[1.8rem] p-1.5 shadow-xl">
                <div className="bg-white rounded-[1.4rem] overflow-hidden">
                  <div className="relative">
                    <img src={previewImg} alt="" className="w-full h-32 object-cover" />
                    <div className="absolute top-3 right-3 w-8 h-8 bg-white/90 rounded-full flex items-center justify-center">
                      <Heart className="w-4 h-4 text-gray-600" />
                    </div>
                    <div className="absolute -bottom-5 left-3 w-12 h-12 bg-white rounded-xl flex items-center justify-center shadow-md ring-2 ring-white">
                      <span className="text-xs font-bold text-[#FA4D8D]">{previewInitials}</span>
                    </div>
                  </div>
                  <div className="p-4 pt-7">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-bold text-gray-900 truncate">{previewName}</h4>
                      <CheckCircle className="w-4 h-4 text-blue-500 flex-shrink-0" />
                    </div>
                    <p className="text-xs text-gray-500 mb-3">{previewCategory}</p>
                    <div className="flex items-center gap-3 mb-3 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />
                        New
                      </span>
                      <span className="flex items-center gap-1 min-w-0">
                        <MapPin className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{previewArea}</span>
                      </span>
                      {previewPrice && <span className="flex-shrink-0">{previewPrice}</span>}
                    </div>
                    {previewChips.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-3">
                        {previewChips.map((tag) => (
                          <span key={tag} className="px-2 py-1 bg-purple-200 text-purple-800 text-xs rounded-full">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-2">
                      <button className="flex items-center justify-center gap-1 py-2 border border-green-300 rounded-lg text-xs text-green-700">
                        <MessageCircle className="w-3 h-3" />
                        WhatsApp
                      </button>
                      <button className="flex items-center justify-center gap-1 py-2 border border-gray-200 rounded-lg text-xs text-gray-700">
                        <Phone className="w-3 h-3" />
                        Call
                      </button>
                      <button className="flex items-center justify-center gap-1 py-2 border border-gray-200 rounded-lg text-xs text-gray-700">
                        <MapPin className="w-3 h-3" />
                        Map
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* Desktop — browser window, image beside a roomier detail column */
              <div className="rounded-xl border border-gray-200 shadow-xl overflow-hidden bg-white">
                <div className="flex items-center gap-1.5 bg-gray-100 px-3 py-2 border-b border-gray-200">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                  <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
                  <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
                  <div className="ml-3 flex-1 rounded bg-white border border-gray-200 px-2 py-0.5 text-[10px] text-gray-400 truncate">
                    babybrain.sg/venues
                  </div>
                </div>
                <div className="grid grid-cols-[minmax(0,260px)_1fr]">
                  <img src={previewImg} alt="" className="h-full w-full object-cover" />
                  <div className="p-5">
                    <div className="flex items-center gap-2">
                      <h4 className="text-lg font-bold text-gray-900">{previewName}</h4>
                      <CheckCircle className="w-4 h-4 text-blue-500 flex-shrink-0" />
                    </div>
                    <p className="text-sm text-gray-500 mt-0.5">{previewCategory}</p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-sm text-gray-500">
                      <span className="flex items-center gap-1">
                        <Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" />
                        New listing
                      </span>
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5" />
                        {previewArea}
                      </span>
                      {previewPrice && <span>{previewPrice}</span>}
                    </div>
                    {previewChips.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-3">
                        {previewChips.map((tag) => (
                          <span key={tag} className="px-2.5 py-1 bg-purple-200 text-purple-800 text-xs rounded-full">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 mt-4">
                      <button className="flex items-center gap-1.5 px-4 py-2 border border-green-300 rounded-lg text-sm text-green-700">
                        <MessageCircle className="w-4 h-4" />
                        WhatsApp
                      </button>
                      <button className="flex items-center gap-1.5 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-700">
                        <Phone className="w-4 h-4" />
                        Call
                      </button>
                      <button className="flex items-center gap-1.5 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-700">
                        <MapPin className="w-4 h-4" />
                        View on map
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-8 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <Button
            variant="outline"
            onClick={() => navigate('/claim-business')}
            className="rounded-xl gap-2 border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Button>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Lock className="w-4 h-4" />
            Your information is secure
          </div>
          <div className="flex flex-col items-end gap-1">
            {saveError && <p className="text-xs text-red-500">{saveError}</p>}
            <Button
              onClick={handleSave}
              disabled={!canSave || savingListing}
              className="gradient-primary text-white rounded-xl px-8 hover:opacity-90 gap-2 disabled:opacity-50"
            >
              {savingListing ? 'Saving…' : 'Save'}
              <Send className="w-4 h-4" />
            </Button>
            {!canSave && (
              <p className="text-[11px] text-gray-400">Tick the Vendor Terms to continue.</p>
            )}
          </div>
        </div>
      </div>

      <div className="h-20" />

      <Sheet open={!!viewingDoc} onOpenChange={(open) => { if (!open) setViewingDoc(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          {viewingDoc && (
            <>
              <SheetHeader>
                <SheetTitle>{viewingDoc.title}</SheetTitle>
                <SheetDescription>{viewingDoc.summary}</SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-6 space-y-5">
                {viewingDoc.sections.map((s) => (
                  <div key={s.heading} className="rounded-xl border-2 border-gray-300 bg-white p-4 shadow-sm">
                    <h4 className="text-sm font-semibold text-gray-900 mb-1">{s.heading}</h4>
                    <p className="text-sm text-gray-600 leading-relaxed">{s.body}</p>
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
