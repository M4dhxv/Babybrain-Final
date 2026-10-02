'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, C, Skeleton, adminFetch, card, input, primaryBtn, sgTime, supabase, tabBtn, toast, peekCache } from '../_lib/core';

type VendorResult = { name: string; website: string; outcome: 'price_updated' | 'no_price' | 'no_wp'; price_updated: number };
type VendorRun = {
  id: string; trigger: 'cron' | 'manual'; status: 'running' | 'success' | 'error';
  triggered_by: string | null; checked: number; wp_sites: number; prices_updated: number;
  results: VendorResult[]; error: string | null; started_at: string; finished_at: string | null;
};

type AdminCategory = { slug: string; name: string };
type RecentProvider = {
  id: string; business_name: string; slug: string; vendor_category: string;
  region: string | null; status: string; is_claimed: boolean; is_auto_listed: boolean; created_at: string;
};
type NewVendorMeta = { categories: AdminCategory[]; vendorCategories: string[]; recent: RecentProvider[] };
type DraftLocation = { name: string; address: string; postal_code: string };
type DraftSession = {
  starts_at: string; duration_mins: string; capacity: string; teacher_name: string; studio: string;
};
type DraftActivity = {
  title: string; category_slug: string; description: string;
  age_min_months: string; age_max_months: string; price: string; is_published: boolean;
  image_urls: string; external_booking_url: string; requires_medical_disclosure: boolean;
  is_custom_location: boolean; custom_location_label: string;
  sessions: DraftSession[];
};
/** Images are entered as URLs, one per line. */
const splitUrls = (s: string) => s.split(/[\n,]/).map((u) => u.trim()).filter(Boolean);

/** Upload a file to the admin image bucket and hand back its public URL. */
async function uploadImage(file: File, folder: string): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const body = new FormData();
  body.append('file', file);
  body.append('folder', folder);
  const res = await fetch('/api/admin/upload', {
    method: 'POST',
    headers: session ? { Authorization: `Bearer ${session.access_token}` } : {},
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? 'Upload failed');
  return json.url as string;
}

/**
 * One image: paste a URL or upload a file — both end up as a URL, since that's
 * what the column stores either way. Shows a thumbnail once there's something
 * to show, so a broken link is obvious straight away.
 */
function ImageField({
  label, value, folder, onChange, placeholder,
}: {
  label: string; value: string; folder: string;
  onChange: (url: string) => void; placeholder?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = `up-${label.replace(/\W+/g, '')}-${folder}`;

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';           // so re-picking the same file still fires
    if (!f) return;
    setBusy(true); setErr(null);
    try { onChange(await uploadImage(f, folder)); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 5 }}>
        {label}
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={value} onChange={(e) => onChange(e.target.value)} style={input()}
          placeholder={placeholder ?? 'https://… or upload →'} />
        <label htmlFor={id} style={{ ...tabBtn(false), whiteSpace: 'nowrap', lineHeight: '22px', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Uploading…' : 'Upload'}
        </label>
        <input id={id} type="file" accept="image/*" onChange={pick} style={{ display: 'none' }} />
      </div>
      {err && <div style={{ color: C.pink, fontSize: 12, marginTop: 5 }}>{err}</div>}
      {value.trim() && (
        <img src={value} alt="" style={{ height: 40, marginTop: 6, borderRadius: 6, background: C.panel2 }} />
      )}
    </div>
  );
}

/** Several images for one class: a list of URLs plus an uploader that appends. */
function ImageListField({
  value, folder, onChange,
}: { value: string; folder: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = `upl-${folder}`;
  const urls = splitUrls(value);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true); setErr(null);
    try {
      const added: string[] = [];
      for (const f of files) added.push(await uploadImage(f, folder));
      onChange([...urls, ...added].join('\n'));
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
        <label style={{ fontSize: 12, fontWeight: 800, color: C.muted }}>
          Images <span style={{ fontWeight: 600 }}>· paste URLs, one per line, or upload</span>
        </label>
        <label htmlFor={id} style={{ ...tabBtn(false), padding: '4px 9px', fontSize: 12, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Uploading…' : '+ Upload'}
        </label>
        <input id={id} type="file" accept="image/*" multiple onChange={pick} style={{ display: 'none' }} />
      </div>
      <textarea value={value} rows={2} style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
        placeholder="https://…/photo.jpg" onChange={(e) => onChange(e.target.value)} />
      {err && <div style={{ color: C.pink, fontSize: 12, marginTop: 5 }}>{err}</div>}
      {urls.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {urls.slice(0, 6).map((u, k) => (
            <img key={k} src={u} alt="" style={{ height: 38, borderRadius: 6, background: C.panel2 }} />
          ))}
        </div>
      )}
    </div>
  );
}
const blankSession = (): DraftSession =>
  ({ starts_at: '', duration_mins: '60', capacity: '', teacher_name: '', studio: '' });
type CreatedVendor = {
  provider: { id: string; slug: string; business_name: string; region: string | null };
  locations: number; activities: number; geocoded: number; warnings: string[];
};
type EditLocation = {
  id: string; name: string; address: string | null; postal_code: string | null;
  region: string | null; is_primary: boolean; latitude: number | null; longitude: number | null;
  /** Set when this venue is mirrored from the vendor's Wix site. */
  wix_location_id?: string | null;
};
type EditSession = {
  id: string; starts_at: string; ends_at: string; capacity: number | null;
  teacher_name: string | null; studio: string | null;
  // Captured once from the pristine starts_at/ends_at when this row loads —
  // see the save-payload builder below for why this can't be recomputed from
  // current form state.
  duration_mins: number;
};
type EditActivity = {
  id: string; title: string; slug: string; category_slug: string | null; category_name: string | null;
  age_min_months: number; age_max_months: number; price: number | null; is_published: boolean;
  description: string | null; external_booking_url: string | null;
  image_urls: string[]; requires_medical_disclosure: boolean; bookings_paused: boolean;
  location_id: string | null;
  is_custom_location: boolean; custom_location_label: string | null;
  sessions: EditSession[];
};
type ProviderDetail = {
  id: string; business_name: string; slug: string | null; description: string | null;
  vendor_category: string | null; contact_email: string | null; contact_phone: string | null;
  whatsapp: string | null; website: string | null; address: string | null; postal_code: string | null;
  region: string | null; status: string; is_claimed: boolean; is_auto_listed: boolean;
  latitude: number | null; longitude: number | null;
  logo_url: string | null; cover_image_url: string | null; uen: string | null;
  social: { instagram?: string | null; facebook?: string | null; tiktok?: string | null } | null;
  payouts_enabled: boolean; allow_manual_payouts: boolean;
  locations: EditLocation[]; activities: EditActivity[];
};
type SaveResult = {
  provider: { id: string; business_name: string; slug: string | null; region: string | null };
  locationsChanged: number; activitiesChanged: number; sessionsChanged: number;
  regeocoded: boolean; warnings: string[];
};

const VENDOR_CATEGORY_LABELS: Record<string, string> = {
  'baby-toddler-classes': 'Baby & toddler classes',
  playspaces: 'Playspace',
  'camps-holiday': 'Holiday camps',
  'community-events': 'Community events',
  'mum-bub-exercise': 'Parent & child exercise',
  other: 'Other',
};


/**
 * Add a vendor to the directory by hand — the business, its venues and its
 * classes — without touching SQL. Everything the parent app needs to show a
 * listing properly is on this one form; venues are geocoded server-side so the
 * new vendor appears on the Explore map and under its area filter immediately.
 */
export default function AddVendorView() {
  const [meta, setMeta] = useState<NewVendorMeta | null>(() => peekCache<NewVendorMeta>('/api/admin/providers') ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<CreatedVendor | null>(null);

  // business
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [vendorCategory, setVendorCategory] = useState('baby-toddler-classes');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [bookingUrl, setBookingUrl] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [address, setAddress] = useState('');
  const [postal, setPostal] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [uen, setUen] = useState('');
  const [instagram, setInstagram] = useState('');
  const [facebook, setFacebook] = useState('');
  const [tiktok, setTiktok] = useState('');

  const [locations, setLocations] = useState<DraftLocation[]>([]);
  const [activities, setActivities] = useState<DraftActivity[]>([]);
  // A new vendor never has payouts set up yet — publishing a class that
  // checks out through BabyBrain (no external booking link) needs this
  // ticked, or the create call is rejected. See admin-create-provider.ts.
  const [overridePayoutGate, setOverridePayoutGate] = useState(false);

  // directory list: search + which vendor is open in the editor
  const [search, setSearch] = useState('');
  const [shownCount, setShownCount] = useState(60);
  const [editingId, setEditingId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('edit'));

  const load = useCallback(async () => {
    try { setMeta(await adminFetch<NewVendorMeta>('/api/admin/providers')); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const q = search.trim().toLowerCase();
  const filteredVendors = !meta ? [] : !q ? meta.recent : meta.recent.filter((p) =>
    [p.business_name, p.slug, p.region ?? '', VENDOR_CATEGORY_LABELS[p.vendor_category] ?? p.vendor_category]
      .join(' ').toLowerCase().includes(q));

  // The slug is derived from the name until the founder edits it herself.
  const autoSlug = name.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
  const effectiveSlug = slugTouched ? slug : autoSlug;

  const defaultCategory = meta?.categories[0]?.slug ?? 'music';

  function reset() {
    setName(''); setSlug(''); setSlugTouched(false); setVendorCategory('baby-toddler-classes');
    setDescription(''); setWebsite(''); setBookingUrl(''); setEmail(''); setPhone('');
    setWhatsapp(''); setAddress(''); setPostal(''); setLocations([]); setActivities([]);
    setLogoUrl(''); setCoverUrl(''); setUen(''); setInstagram(''); setFacebook(''); setTiktok('');
    setOverridePayoutGate(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setDone(null);
    try {
      const payload = {
        business_name: name,
        slug: effectiveSlug,
        description,
        vendor_category: vendorCategory,
        contact_email: email,
        contact_phone: phone,
        whatsapp,
        website,
        booking_url: bookingUrl,
        address,
        postal_code: postal,
        logo_url: logoUrl,
        cover_image_url: coverUrl,
        uen,
        social: { instagram, facebook, tiktok },
        locations: locations.map((l) => ({ name: l.name, address: l.address, postal_code: l.postal_code })),
        activities: activities
          .filter((a) => a.title.trim())
          .map((a) => ({
            title: a.title,
            category_slug: a.category_slug,
            description: a.description,
            age_min_months: a.age_min_months === '' ? null : Number(a.age_min_months),
            age_max_months: a.age_max_months === '' ? null : Number(a.age_max_months),
            price: a.price === '' ? null : Number(a.price),
            is_published: a.is_published,
            image_urls: splitUrls(a.image_urls),
            external_booking_url: a.external_booking_url,
            requires_medical_disclosure: a.requires_medical_disclosure,
            is_custom_location: a.is_custom_location,
            custom_location_label: a.is_custom_location ? a.custom_location_label : null,
            sessions: a.sessions
              .filter((s) => s.starts_at.trim())
              .map((s) => ({
                starts_at: s.starts_at,
                duration_mins: s.duration_mins === '' ? null : Number(s.duration_mins),
                capacity: s.capacity === '' ? null : Number(s.capacity),
                teacher_name: s.teacher_name,
                studio: s.studio,
              })),
          })),
        overridePayoutGate,
      };
      const r = await adminFetch<CreatedVendor>('/api/admin/providers', {
        method: 'POST', body: JSON.stringify(payload),
      });
      setDone(r);
      toast('Vendor created');
      reset();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  }

  const label = (t: string): React.CSSProperties => ({ fontSize: 12, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 5 });
  const field = { marginBottom: 12 };
  const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };

  return (
    <div>
      <form onSubmit={submit}>
        <div style={card()}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Add a vendor to the directory</div>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 4, maxWidth: 720 }}>
            Creates the business, its venues and its classes in one go. Addresses are looked up
            automatically so the vendor shows on the Explore map and under the right area filter.
            The listing is unclaimed, so the vendor can claim it later, and the weekly crawler will
            never overwrite what you type here.
          </div>
        </div>

        {/* ---- business ---- */}
        <div style={{ ...card(), marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 14 }}>Business</div>

          <div style={grid2}>
            <div style={field}>
              <label style={label('')}>Business name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} style={input()} placeholder="Little Blue Chair" required />
            </div>
            <div style={field}>
              <label style={label('')}>Page address (slug)</label>
              <input value={effectiveSlug}
                onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }}
                style={input()} placeholder="little-blue-chair" />
            </div>
          </div>

          <div style={grid2}>
            <div style={field}>
              <label style={label('')}>Business type *</label>
              <select value={vendorCategory} onChange={(e) => setVendorCategory(e.target.value)} style={input()}>
                {(meta?.vendorCategories ?? Object.keys(VENDOR_CATEGORY_LABELS)).map((v) => (
                  <option key={v} value={v}>{VENDOR_CATEGORY_LABELS[v] ?? v}</option>
                ))}
              </select>
            </div>
            <div style={field}>
              <label style={label('')}>Website</label>
              <input value={website} onChange={(e) => setWebsite(e.target.value)} style={input()} placeholder="https://…" />
            </div>
          </div>

          <div style={field}>
            <label style={label('')}>Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              rows={3} style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="What they do, in a sentence or two — this is what parents read on the listing." />
          </div>

          <div style={grid2}>
            <div style={field}>
              <label style={label('')}>Address</label>
              <input value={address} onChange={(e) => setAddress(e.target.value)} style={input()} placeholder="25E Lor Liput, Singapore" />
            </div>
            <div style={field}>
              <label style={label('')}>Postal code <span style={{ color: C.blue }}>· drives the map pin &amp; area</span></label>
              <input value={postal} onChange={(e) => setPostal(e.target.value)} style={input()} placeholder="277736" />
            </div>
          </div>

          <div style={grid2}>
            <div style={field}>
              <label style={label('')}>Contact email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} style={input()} placeholder="hello@…" />
            </div>
            <div style={field}>
              <label style={label('')}>Phone</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} style={input()} placeholder="8123 4567" />
            </div>
          </div>

          <div style={grid2}>
            <div style={field}>
              <label style={label('')}>WhatsApp</label>
              <input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} style={input()} placeholder="+65…" />
            </div>
            <div style={field}>
              <label style={label('')}>Booking link</label>
              <input value={bookingUrl} onChange={(e) => setBookingUrl(e.target.value)} style={input()}
                placeholder="Leave blank to send parents to the website" />
            </div>
          </div>

          <div style={grid2}>
            <div style={field}>
              <ImageField label="Logo" value={logoUrl} folder={effectiveSlug || 'new-vendor'} onChange={setLogoUrl} />
            </div>
            <div style={field}>
              <ImageField label="Cover image" value={coverUrl} folder={effectiveSlug || 'new-vendor'} onChange={setCoverUrl} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
            <div style={field}>
              <label style={label('')}>Instagram</label>
              <input value={instagram} onChange={(e) => setInstagram(e.target.value)} style={input()} placeholder="@handle or URL" />
            </div>
            <div style={field}>
              <label style={label('')}>Facebook</label>
              <input value={facebook} onChange={(e) => setFacebook(e.target.value)} style={input()} />
            </div>
            <div style={field}>
              <label style={label('')}>TikTok</label>
              <input value={tiktok} onChange={(e) => setTiktok(e.target.value)} style={input()} />
            </div>
            <div style={field}>
              <label style={label('')}>UEN</label>
              <input value={uen} onChange={(e) => setUen(e.target.value)} style={input()} placeholder="business reg. no." />
            </div>
          </div>
        </div>

        {/* ---- venues ---- */}
        <div style={{ ...card(), marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 800 }}>Venues</div>
              <div style={{ color: C.muted, fontSize: 13, marginTop: 3 }}>
                One per place they teach — each gets its own pin. Skip this if they only use the address above.
              </div>
            </div>
            <button type="button" onClick={() => setLocations((p) => [...p, { name: '', address: '', postal_code: '' }])}
              style={{ ...tabBtn(false), whiteSpace: 'nowrap' }}>+ Add venue</button>
          </div>

          {locations.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No extra venues.</div>}
          {locations.map((l, i) => (
            <div key={i} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 140px 40px', gap: 10, alignItems: 'end' }}>
                <div>
                  <label style={label('')}>Venue name</label>
                  <input value={l.name} style={input()} placeholder="East Coast studio"
                    onChange={(e) => setLocations((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                </div>
                <div>
                  <label style={label('')}>Address</label>
                  <input value={l.address} style={input()}
                    onChange={(e) => setLocations((p) => p.map((x, j) => j === i ? { ...x, address: e.target.value } : x))} />
                </div>
                <div>
                  <label style={label('')}>Postal code</label>
                  <input value={l.postal_code} style={input()}
                    onChange={(e) => setLocations((p) => p.map((x, j) => j === i ? { ...x, postal_code: e.target.value } : x))} />
                </div>
                <button type="button" title="Remove venue"
                  onClick={() => setLocations((p) => p.filter((_, j) => j !== i))}
                  style={{ ...tabBtn(false), color: C.pink, borderColor: C.border, height: 42 }}>✕</button>
              </div>
            </div>
          ))}
        </div>

        {/* ---- classes ---- */}
        <div style={{ ...card(), marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 800 }}>Classes</div>
              <div style={{ color: C.muted, fontSize: 13, marginTop: 3 }}>
                What parents can browse and book. A vendor with no classes won&rsquo;t appear in search results.
              </div>
            </div>
            <button type="button"
              onClick={() => setActivities((p) => [...p, {
                title: '', category_slug: defaultCategory, description: '',
                age_min_months: '', age_max_months: '', price: '', is_published: true,
                image_urls: '', external_booking_url: '', requires_medical_disclosure: false,
                is_custom_location: false, custom_location_label: '',
                sessions: [],
              }])}
              style={{ ...tabBtn(false), whiteSpace: 'nowrap' }}>+ Add class</button>
          </div>

          {activities.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No classes yet.</div>}
          {activities.map((a, i) => (
            <div key={i} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 40px', gap: 10, alignItems: 'end' }}>
                <div>
                  <label style={label('')}>Class name</label>
                  <input value={a.title} style={input()} placeholder="Outdoor Sensory Play"
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />
                </div>
                <div>
                  <label style={label('')}>Category</label>
                  <select value={a.category_slug} style={input()}
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, category_slug: e.target.value } : x))}>
                    {(meta?.categories ?? []).map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                  </select>
                </div>
                <button type="button" title="Remove class"
                  onClick={() => setActivities((p) => p.filter((_, j) => j !== i))}
                  style={{ ...tabBtn(false), color: C.pink, borderColor: C.border, height: 42 }}>✕</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginTop: 10 }}>
                <div>
                  <label style={label('')}>Age from (months)</label>
                  <input value={a.age_min_months} inputMode="numeric" style={input()} placeholder="0"
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, age_min_months: e.target.value.replace(/\D/g, '') } : x))} />
                </div>
                <div>
                  <label style={label('')}>Age to (months)</label>
                  <input value={a.age_max_months} inputMode="numeric" style={input()} placeholder="132"
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, age_max_months: e.target.value.replace(/\D/g, '') } : x))} />
                </div>
                <div>
                  <label style={label('')}>Price (SGD)</label>
                  <input value={a.price} inputMode="decimal" style={input()} placeholder="blank = on enquiry"
                    // Strip anything but digits/dot, then collapse any dot
                    // after the first one — "12.3.4" used to pass straight
                    // through, becoming NaN at submit, which JSON.stringify
                    // silently turns into null: the vendor saved fine but
                    // its price silently became "on enquiry" with no error.
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, price: e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') } : x))} />
                </div>
                <div>
                  <label style={label('')}>Visible to parents</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42, fontSize: 14 }}>
                    <input type="checkbox" checked={a.is_published}
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, is_published: e.target.checked } : x))} />
                    {a.is_published ? 'Published' : 'Hidden'}
                  </label>
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <label style={label('')}>Description</label>
                <input value={a.description} style={input()} placeholder="Falls back to the business description if blank"
                  onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                <ImageListField
                  value={a.image_urls}
                  folder={`${effectiveSlug || 'new-vendor'}-class-${i}`}
                  onChange={(v) => setActivities((p) => p.map((x, j) => j === i ? { ...x, image_urls: v } : x))}
                />
                <div>
                  <label style={label('')}>Booking link for this class</label>
                  <input value={a.external_booking_url} style={input()}
                    placeholder="blank = use the business booking link"
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, external_booking_url: e.target.value } : x))} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13 }}>
                    <input type="checkbox" checked={a.requires_medical_disclosure}
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, requires_medical_disclosure: e.target.checked } : x))} />
                    Ask for a medical disclosure before booking
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13 }}>
                    <input type="checkbox" checked={a.is_custom_location}
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, is_custom_location: e.target.checked } : x))} />
                    Private session at the customer&rsquo;s home (no fixed venue)
                  </label>
                  {a.is_custom_location && (
                    <input value={a.custom_location_label} style={{ ...input(), marginTop: 6 }}
                      placeholder='Shown to parents instead of "Custom", e.g. "We travel to you"'
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, custom_location_label: e.target.value } : x))} />
                  )}
                </div>
              </div>

              {/* Schedule. Without a session a class shows "Schedule TBC" and
                  can't be booked — most of the catalogue is in that state. */}
              <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: C.muted }}>
                    SESSIONS {a.sessions.length === 0 && <span style={{ color: C.pink }}>· none yet — shows &ldquo;Schedule TBC&rdquo; and can&rsquo;t be booked</span>}
                  </span>
                  <button type="button" style={{ ...tabBtn(false), padding: '5px 10px', fontSize: 12 }}
                    onClick={() => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: [...x.sessions, blankSession()] } : x))}>
                    + Session
                  </button>
                </div>
                {a.sessions.map((s, si) => (
                  <div key={si} style={{ display: 'grid', gridTemplateColumns: '1.4fr 80px 80px 1fr 1fr 34px', gap: 8, marginBottom: 8 }}>
                    <input type="datetime-local" value={s.starts_at} style={input()}
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, starts_at: e.target.value } : y) } : x))} />
                    <input value={s.duration_mins} inputMode="numeric" style={input()} placeholder="mins"
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, duration_mins: e.target.value.replace(/\D/g, '') } : y) } : x))} />
                    <input value={s.capacity} inputMode="numeric" style={input()} placeholder="cap"
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, capacity: e.target.value.replace(/\D/g, '') } : y) } : x))} />
                    <input value={s.teacher_name} style={input()} placeholder="teacher"
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, teacher_name: e.target.value } : y) } : x))} />
                    <input value={s.studio} style={input()} placeholder="room"
                      onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, studio: e.target.value } : y) } : x))} />
                    <button type="button" style={{ ...tabBtn(false), color: C.pink, padding: 0 }}
                      onClick={() => setActivities((p) => p.map((x, j) => j === i ? { ...x, sessions: x.sessions.filter((_, k) => k !== si) } : x))}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {err && <div style={{ ...card(), marginTop: 12, borderColor: C.pink, color: C.pink }}>{err}</div>}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: C.muted }}>
          <input type="checkbox" checked={overridePayoutGate}
            onChange={(e) => setOverridePayoutGate(e.target.checked)} />
          Let this vendor publish without Stripe — BabyBrain will settle their paid bookings manually until they connect Stripe (saved on the vendor, so their own portal lets them publish too)
        </label>

        {done && (
          <div style={{ ...card(), marginTop: 12, borderColor: C.green }}>
            <div style={{ color: C.green, fontWeight: 800 }}>
              {done.provider.business_name} added — {done.activities} class{done.activities === 1 ? '' : 'es'},{' '}
              {done.locations} venue{done.locations === 1 ? '' : 's'}
              {done.provider.region ? `, ${done.provider.region}` : ''}.
            </div>
            <div style={{ color: C.muted, fontSize: 13, marginTop: 6 }}>
              {done.geocoded} address{done.geocoded === 1 ? '' : 'es'} placed on the map. Find it at{' '}
              <a href={`/explore?q=${encodeURIComponent(done.provider.business_name)}`}
                target="_blank" rel="noreferrer" style={{ color: C.blue }}>
                Explore &rarr; {done.provider.business_name}
              </a>
            </div>
            {done.warnings.map((w, i) => (
              <div key={i} style={{ color: C.pink, fontSize: 13, marginTop: 6 }}>⚠ {w}</div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
          <button type="submit" disabled={busy || !name.trim()}
            style={{ ...primaryBtn(), opacity: busy || !name.trim() ? 0.55 : 1 }}>
            {busy ? 'Adding…' : 'Add vendor'}
          </button>
          <button type="button" onClick={reset} style={tabBtn(false)}>Clear</button>
          {busy && <span style={{ color: C.muted, fontSize: 13 }}>Looking up addresses…</span>}
        </div>
      </form>

      {/* ---- the directory: search, then click to edit ---- */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '26px 0 10px', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 800 }}>
          All vendors {meta ? <span style={{ color: C.muted, fontWeight: 600 }}>({filteredVendors.length} of {meta.recent.length})</span> : null}
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, area or type…" style={{ ...input(), maxWidth: 320 }} />
      </div>
      {!meta ? <Skeleton /> : (
        <div style={{ ...card(), padding: 0, overflow: 'hidden' }}>
          {filteredVendors.length === 0 && (
            <div style={{ padding: 16, color: C.muted, fontSize: 14 }}>No vendor matches that.</div>
          )}
          {filteredVendors.slice(0, shownCount).map((p, i) => (
            <button key={p.id} type="button" onClick={() => setEditingId(p.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', width: '100%',
                textAlign: 'left', background: 'transparent', color: C.text, cursor: 'pointer',
                border: 'none', borderTop: i ? `1px solid ${C.border}` : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.business_name}
                </div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
                  {VENDOR_CATEGORY_LABELS[p.vendor_category] ?? p.vendor_category}
                  {p.region ? ` · ${p.region}` : ' · no area'}
                  {` · ${new Date(p.created_at).toLocaleDateString('en-SG')}`}
                </div>
              </div>
              <Badge tone={p.is_claimed ? 'green' : 'grey'}>
                {p.is_claimed ? 'Claimed' : p.is_auto_listed ? 'Auto-listed' : 'Added by hand'}
              </Badge>
              <span style={{ color: C.blue, fontWeight: 800, fontSize: 13 }}>Edit</span>
            </button>
          ))}
          {filteredVendors.length > shownCount && (
            <div style={{ padding: '10px 14px', color: C.muted, fontSize: 12, borderTop: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <span>Showing {shownCount} of {filteredVendors.length} — search to narrow it down, or</span>
              <button type="button" style={{ ...tabBtn(false), padding: '4px 12px', fontSize: 12 }} onClick={() => setShownCount((n) => n + 60)}>Show 60 more</button>
            </div>
          )}
        </div>
      )}

      {editingId && (
        <EditVendorModal
          id={editingId}
          categories={meta?.categories ?? []}
          vendorCategories={meta?.vendorCategories ?? Object.keys(VENDOR_CATEGORY_LABELS)}
          onClose={() => setEditingId(null)}
          onSaved={async () => { setEditingId(null); await load(); }}
        />
      )}
    </div>
  );
}

/** Full editor for one vendor: the business, its venues and its classes.
 *  Saves patch-style, so an untouched section is left exactly as it was. */
function EditVendorModal({
  id, categories, vendorCategories, onClose, onSaved,
}: {
  id: string;
  categories: AdminCategory[];
  vendorCategories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<ProviderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string[] | null>(null);
  // ids marked for removal — applied on save, so a misclick is undoable
  const [dropLoc, setDropLoc] = useState<string[]>([]);
  const [dropAct, setDropAct] = useState<string[]>([]);
  // Existing sessions removed in the UI. New (unsaved) ones just vanish from
  // the array, but a saved one has to be sent back with _delete.
  const [dropSess, setDropSess] = useState<{ actId: string; sessId: string }[]>([]);
  const [newLocs, setNewLocs] = useState<DraftLocation[]>([]);
  useEffect(() => {
    adminFetch<ProviderDetail>(`/api/admin/providers/${id}`)
      .then((p) =>
        setD({
          ...p,
          activities: p.activities.map((a) => ({
            ...a,
            sessions: a.sessions.map((s) => ({
              ...s,
              // Fixed at load time from the session's real, pristine
              // starts_at/ends_at. The form only lets the admin edit
              // starts_at (there's no end-time/duration field), so this must
              // survive that edit unchanged rather than being rederived from
              // it later — see the save-payload builder below.
              duration_mins: Math.max(5, Math.round(
                (new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000
              )),
            })),
          })),
        })
      )
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [id]);

  const set = <K extends keyof ProviderDetail>(k: K, v: ProviderDetail[K]) =>
    setD((p) => (p ? { ...p, [k]: v } : p));

  async function save() {
    if (!d) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await adminFetch<SaveResult>(`/api/admin/providers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          provider: {
            business_name: d.business_name,
            slug: d.slug ?? undefined,
            description: d.description,
            vendor_category: d.vendor_category,
            contact_email: d.contact_email,
            contact_phone: d.contact_phone,
            whatsapp: d.whatsapp,
            website: d.website,
            address: d.address,
            postal_code: d.postal_code,
            status: d.status,
            logo_url: d.logo_url,
            cover_image_url: d.cover_image_url,
            uen: d.uen,
            social: d.social ?? {},
            // Saved on the vendor (migration 00200) so their own portal lets
            // them publish too, not just this save.
            allow_manual_payouts: d.allow_manual_payouts,
          },
          locations: [
            ...d.locations.map((l) => ({
              id: l.id, name: l.name, address: l.address, postal_code: l.postal_code,
              is_primary: l.is_primary, _delete: dropLoc.includes(l.id),
            })),
            ...newLocs.filter((l) => l.name.trim() || l.address.trim())
              .map((l) => ({ name: l.name, address: l.address, postal_code: l.postal_code })),
          ],
          activities: d.activities.map((a) => ({
            id: a.id, title: a.title, category_slug: a.category_slug ?? undefined,
            description: a.description, age_min_months: a.age_min_months,
            age_max_months: a.age_max_months, price: a.price, is_published: a.is_published,
            image_urls: a.image_urls.map((u) => u.trim()).filter(Boolean),
            external_booking_url: a.external_booking_url,
            requires_medical_disclosure: a.requires_medical_disclosure,
            bookings_paused: a.bookings_paused,
            location_id: a.is_custom_location ? null : a.location_id,
            is_custom_location: a.is_custom_location,
            custom_location_label: a.is_custom_location ? a.custom_location_label : null,
            sessions: [
              ...a.sessions
                .filter((s) => s.starts_at.trim())
                .map((s) => ({
                  ...(s.id ? { id: s.id } : {}),
                  starts_at: s.starts_at,
                  // The form only ever edits starts_at (no end-time/duration
                  // field exists), so this has to be the value fixed at load
                  // time from the session's real, pristine starts_at/ends_at
                  // — recomputing from CURRENT starts_at against the still-
                  // pristine ends_at (the old code here) silently corrupted
                  // the length of any rescheduled session: moving a 60-min
                  // class's start later shrank it toward the clamp floor,
                  // moving it earlier ballooned it.
                  duration_mins: s.duration_mins,
                  capacity: s.capacity,
                  teacher_name: s.teacher_name,
                  studio: s.studio,
                })),
              // only the ones that belonged to this class
              ...dropSess.filter((x) => x.actId === a.id).map((x) => ({ id: x.sessId, _delete: true })),
            ],
            _delete: dropAct.includes(a.id),
          })),
        }),
      });
      setNote([
        `Saved — ${r.locationsChanged} venue${r.locationsChanged === 1 ? '' : 's'}, ${r.activitiesChanged} class${r.activitiesChanged === 1 ? '' : 'es'}, ${r.sessionsChanged} session${r.sessionsChanged === 1 ? '' : 's'}${r.regeocoded ? ', map pin moved' : ''}${r.provider.region ? `, ${r.provider.region}` : ''}.`,
        ...r.warnings,
      ]);
      toast('Vendor saved');
      setTimeout(onSaved, 1200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  }

  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 5 };
  const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.55)', overflow: 'auto', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ ...card(), maxWidth: 860, margin: '0 auto', padding: 20 }}>
        {!d ? (
          <p style={{ color: C.muted }}>{err ?? 'Loading…'}</p>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>{d.business_name}</div>
                <div style={{ color: C.muted, fontSize: 13, marginTop: 3 }}>
                  {d.is_claimed
                    ? 'This vendor has claimed their page — they can see and change what you edit here.'
                    : d.is_auto_listed ? 'Auto-listed by the crawler; the weekly refresh may overwrite prices.'
                    : 'Added by hand; the crawler leaves it alone.'}
                </div>
              </div>
              <button type="button" onClick={onClose} style={tabBtn(false)}>Close</button>
            </div>

            {/* business */}
            <div style={{ fontWeight: 800, margin: '4px 0 10px' }}>Business</div>
            <div style={grid2}>
              <div>
                <label style={lbl}>Business name</label>
                <input value={d.business_name} style={input()} onChange={(e) => set('business_name', e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Page address (slug)</label>
                <input value={d.slug ?? ''} style={input()} onChange={(e) => set('slug', e.target.value)} />
              </div>
            </div>
            <div style={grid2}>
              <div>
                <label style={lbl}>Business type</label>
                <select value={d.vendor_category ?? 'other'} style={input()}
                  onChange={(e) => set('vendor_category', e.target.value)}>
                  {vendorCategories.map((v) => <option key={v} value={v}>{VENDOR_CATEGORY_LABELS[v] ?? v}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Listing status</label>
                <select value={d.status} style={input()} onChange={(e) => set('status', e.target.value)}>
                  {['active', 'draft', 'pending', 'suspended'].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Description</label>
              <textarea value={d.description ?? ''} rows={3}
                style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
                onChange={(e) => set('description', e.target.value)} />
            </div>
            <div style={grid2}>
              <div>
                <label style={lbl}>Address</label>
                <input value={d.address ?? ''} style={input()} onChange={(e) => set('address', e.target.value)} />
              </div>
              <div>
                <label style={lbl}>
                  Postal code <span style={{ color: C.blue }}>· {d.region ? `currently ${d.region}` : 'no area yet'}</span>
                </label>
                <input value={d.postal_code ?? ''} style={input()} onChange={(e) => set('postal_code', e.target.value)} />
              </div>
            </div>
            <div style={grid2}>
              <div>
                <label style={lbl}>Website</label>
                <input value={d.website ?? ''} style={input()} onChange={(e) => set('website', e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Contact email</label>
                <input value={d.contact_email ?? ''} style={input()} onChange={(e) => set('contact_email', e.target.value)} />
              </div>
            </div>
            <div style={grid2}>
              <div>
                <label style={lbl}>Phone</label>
                <input value={d.contact_phone ?? ''} style={input()} onChange={(e) => set('contact_phone', e.target.value)} />
              </div>
              <div>
                <label style={lbl}>WhatsApp</label>
                <input value={d.whatsapp ?? ''} style={input()} onChange={(e) => set('whatsapp', e.target.value)} />
              </div>
            </div>

            <div style={grid2}>
              <ImageField label="Logo" value={d.logo_url ?? ''} folder={d.slug ?? d.id}
                onChange={(u) => set('logo_url', u)} />
              <ImageField label="Cover image" value={d.cover_image_url ?? ''} folder={d.slug ?? d.id}
                onChange={(u) => set('cover_image_url', u)} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={lbl}>Instagram</label>
                <input value={d.social?.instagram ?? ''} style={input()}
                  onChange={(e) => set('social', { ...(d.social ?? {}), instagram: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>Facebook</label>
                <input value={d.social?.facebook ?? ''} style={input()}
                  onChange={(e) => set('social', { ...(d.social ?? {}), facebook: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>TikTok</label>
                <input value={d.social?.tiktok ?? ''} style={input()}
                  onChange={(e) => set('social', { ...(d.social ?? {}), tiktok: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>UEN</label>
                <input value={d.uen ?? ''} style={input()} onChange={(e) => set('uen', e.target.value)} />
              </div>
            </div>

            {/* venues */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 10px' }}>
              <div style={{ fontWeight: 800 }}>Venues <span style={{ color: C.muted, fontWeight: 600, fontSize: 13 }}>({d.locations.length})</span></div>
              <button type="button" style={tabBtn(false)}
                onClick={() => setNewLocs((p) => [...p, { name: '', address: '', postal_code: '' }])}>+ Add venue</button>
            </div>
            {d.locations.map((l) => {
              const gone = dropLoc.includes(l.id);
              return (
                <div key={l.id} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10, opacity: gone ? 0.45 : 1 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 130px 80px', gap: 10, alignItems: 'end' }}>
                    <div>
                      <label style={lbl}>Name{l.is_primary ? ' · primary' : ''}</label>
                      <input value={l.name} style={input()} disabled={gone}
                        onChange={(e) => set('locations', d.locations.map((x) => x.id === l.id ? { ...x, name: e.target.value } : x))} />
                    </div>
                    <div>
                      <label style={lbl}>Address</label>
                      <input value={l.address ?? ''} style={input()} disabled={gone}
                        onChange={(e) => set('locations', d.locations.map((x) => x.id === l.id ? { ...x, address: e.target.value } : x))} />
                    </div>
                    <div>
                      <label style={lbl}>Postal {l.latitude ? '· pinned' : '· NO PIN'}</label>
                      <input value={l.postal_code ?? ''} style={input()} disabled={gone}
                        onChange={(e) => set('locations', d.locations.map((x) => x.id === l.id ? { ...x, postal_code: e.target.value } : x))} />
                    </div>
                    <button type="button" style={{ ...tabBtn(false), color: gone ? C.blue : C.pink, height: 42 }}
                      onClick={() => setDropLoc((p) => gone ? p.filter((x) => x !== l.id) : [...p, l.id])}>
                      {gone ? 'Undo' : 'Remove'}
                    </button>
                  </div>
                  {l.wix_location_id && (
                    <div style={{ marginTop: 8, color: C.pink, fontSize: 12, fontWeight: 700 }}>
                      Linked to this vendor&apos;s Wix site. An address you change here is kept (the Wix sync will not put Wix&apos;s back), but Wix itself still shows the old one.
                    </div>
                  )}
                </div>
              );
            })}
            {newLocs.map((l, i) => (
              <div key={`new-${i}`} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10, border: `1px dashed ${C.blue}` }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 130px 80px', gap: 10, alignItems: 'end' }}>
                  <div>
                    <label style={lbl}>New venue name</label>
                    <input value={l.name} style={input()}
                      onChange={(e) => setNewLocs((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                  </div>
                  <div>
                    <label style={lbl}>Address</label>
                    <input value={l.address} style={input()}
                      onChange={(e) => setNewLocs((p) => p.map((x, j) => j === i ? { ...x, address: e.target.value } : x))} />
                  </div>
                  <div>
                    <label style={lbl}>Postal code</label>
                    <input value={l.postal_code} style={input()}
                      onChange={(e) => setNewLocs((p) => p.map((x, j) => j === i ? { ...x, postal_code: e.target.value } : x))} />
                  </div>
                  <button type="button" style={{ ...tabBtn(false), color: C.pink, height: 42 }}
                    onClick={() => setNewLocs((p) => p.filter((_, j) => j !== i))}>Remove</button>
                </div>
              </div>
            ))}

            {/* classes */}
            <div style={{ fontWeight: 800, margin: '18px 0 10px' }}>
              Classes <span style={{ color: C.muted, fontWeight: 600, fontSize: 13 }}>
                ({d.activities.filter((a) => a.is_published).length} live of {d.activities.length})
              </span>
            </div>
            {d.activities.length === 0 && (
              <div style={{ color: C.muted, fontSize: 13, marginBottom: 10 }}>
                No classes — this vendor won&rsquo;t appear in search results.
              </div>
            )}
            {d.activities.map((a) => {
              const gone = dropAct.includes(a.id);
              return (
                <div key={a.id} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10, opacity: gone ? 0.45 : 1 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 190px 80px', gap: 10, alignItems: 'end' }}>
                    <div>
                      <label style={lbl}>Class name</label>
                      <input value={a.title} style={input()} disabled={gone}
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, title: e.target.value } : x))} />
                    </div>
                    <div>
                      <label style={lbl}>Category</label>
                      <select value={a.category_slug ?? ''} style={input()} disabled={gone}
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, category_slug: e.target.value } : x))}>
                        {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                      </select>
                    </div>
                    <button type="button" style={{ ...tabBtn(false), color: gone ? C.blue : C.pink, height: 42 }}
                      onClick={() => setDropAct((p) => gone ? p.filter((x) => x !== a.id) : [...p, a.id])}>
                      {gone ? 'Undo' : 'Delete'}
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 150px', gap: 10, marginTop: 10 }}>
                    <div>
                      <label style={lbl}>Age from (months)</label>
                      <input value={String(a.age_min_months)} inputMode="numeric" style={input()} disabled={gone}
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, age_min_months: Number(e.target.value.replace(/\D/g, '') || 0) } : x))} />
                    </div>
                    <div>
                      <label style={lbl}>Age to (months)</label>
                      <input value={String(a.age_max_months)} inputMode="numeric" style={input()} disabled={gone}
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, age_max_months: Number(e.target.value.replace(/\D/g, '') || 0) } : x))} />
                    </div>
                    <div>
                      <label style={lbl}>Price (SGD)</label>
                      <input value={a.price == null ? '' : String(a.price)} inputMode="decimal" style={input()} disabled={gone}
                        placeholder="on enquiry"
                        onChange={(e) => { const v = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
                          set('activities', d.activities.map((x) => x.id === a.id ? { ...x, price: v === '' ? null : Number(v) } : x)); }} />
                    </div>
                    <div>
                      <label style={lbl}>Visible to parents</label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42, fontSize: 14 }}>
                        <input type="checkbox" checked={a.is_published} disabled={gone}
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, is_published: e.target.checked } : x))} />
                        {a.is_published ? 'Published' : 'Hidden'}
                      </label>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                    <ImageListField
                      value={a.image_urls.join('\n')}
                      folder={`${d.slug ?? d.id}-${a.slug}`}
                      onChange={(v) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, image_urls: v.split('\n') } : x))}
                    />
                    <div>
                      <label style={lbl}>Booking link for this class</label>
                      <input value={a.external_booking_url ?? ''} style={input()} disabled={gone}
                        placeholder="blank = books through BabyBrain"
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, external_booking_url: e.target.value } : x))} />
                      <div style={{ display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                          <input type="checkbox" checked={a.requires_medical_disclosure} disabled={gone}
                            onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, requires_medical_disclosure: e.target.checked } : x))} />
                          Medical disclosure
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                          <input type="checkbox" checked={a.bookings_paused} disabled={gone}
                            onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, bookings_paused: e.target.checked } : x))} />
                          Bookings paused
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                          <input type="checkbox" checked={a.is_custom_location} disabled={gone}
                            onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id
                              ? { ...x, is_custom_location: e.target.checked, location_id: e.target.checked ? null : x.location_id }
                              : x))} />
                          Private session at customer&rsquo;s home
                        </label>
                      </div>
                      {/* Exactly one of the two: a fixed venue from this
                          provider's own list, or (Private session ticked)
                          the free-text label shown to parents instead. */}
                      <label style={{ ...lbl, marginTop: 8, display: 'block' }}>Location</label>
                      {a.is_custom_location ? (
                        <input value={a.custom_location_label ?? ''} style={{ ...input(), marginTop: 8 }} disabled={gone}
                          placeholder='Shown to parents instead of "Custom", e.g. "We travel to you"'
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, custom_location_label: e.target.value } : x))} />
                      ) : (
                        <select value={a.location_id ?? ''} style={{ ...input(), marginTop: 8 }} disabled={gone}
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, location_id: e.target.value || null } : x))}>
                          <option value="">No fixed venue</option>
                          {d.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                      )}
                    </div>
                  </div>

                  {/* schedule */}
                  <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: C.muted }}>
                        SESSIONS ({a.sessions.length})
                        {a.sessions.length === 0 && <span style={{ color: C.pink }}> · none — shows &ldquo;Schedule TBC&rdquo; and can&rsquo;t be booked</span>}
                      </span>
                      <button type="button" disabled={gone} style={{ ...tabBtn(false), padding: '5px 10px', fontSize: 12 }}
                        onClick={() => set('activities', d.activities.map((x) => x.id === a.id
                          ? { ...x, sessions: [...x.sessions, { id: '', starts_at: '', ends_at: '', duration_mins: 60, capacity: null, teacher_name: '', studio: '' }] } : x))}>
                        + Session
                      </button>
                    </div>
                    {a.sessions.map((s, si) => (
                      <div key={s.id || `new-${si}`} style={{ display: 'grid', gridTemplateColumns: '1.4fr 80px 1fr 1fr 34px', gap: 8, marginBottom: 8 }}>
                        <input type="datetime-local" value={s.starts_at} style={input()} disabled={gone}
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, starts_at: e.target.value } : y) } : x))} />
                        <input value={s.capacity == null ? '' : String(s.capacity)} inputMode="numeric" style={input()} placeholder="cap" disabled={gone}
                          onChange={(e) => { const v = e.target.value.replace(/\D/g, '');
                            set('activities', d.activities.map((x) => x.id === a.id ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, capacity: v === '' ? null : Number(v) } : y) } : x)); }} />
                        <input value={s.teacher_name ?? ''} style={input()} placeholder="teacher" disabled={gone}
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, teacher_name: e.target.value } : y) } : x))} />
                        <input value={s.studio ?? ''} style={input()} placeholder="room" disabled={gone}
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, sessions: x.sessions.map((y, k) => k === si ? { ...y, studio: e.target.value } : y) } : x))} />
                        <button type="button" style={{ ...tabBtn(false), color: C.pink, padding: 0 }} disabled={gone}
                          onClick={() => {
                            if (s.id) setDropSess((p) => [...p, { actId: a.id, sessId: s.id }]);
                            set('activities', d.activities.map((x) => x.id === a.id ? { ...x, sessions: x.sessions.filter((_, k) => k !== si) } : x));
                          }}>✕</button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {err && <div style={{ ...card(), marginTop: 12, borderColor: C.pink, color: C.pink }}>{err}</div>}
            {note && (
              <div style={{ ...card(), marginTop: 12, borderColor: C.green }}>
                <div style={{ color: C.green, fontWeight: 800 }}>{note[0]}</div>
                {note.slice(1).map((w, i) => <div key={i} style={{ color: C.pink, fontSize: 13, marginTop: 6 }}>⚠ {w}</div>)}
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, fontSize: 13, color: C.muted }}>
              <input type="checkbox" style={{ marginTop: 2 }}
                checked={d.allow_manual_payouts || d.payouts_enabled}
                disabled={d.payouts_enabled}
                onChange={(e) => set('allow_manual_payouts', e.target.checked)} />
              <span>
                Let this vendor publish without Stripe — BabyBrain settles their paid bookings manually until they connect Stripe.
                {' '}
                {d.payouts_enabled
                  ? 'Not needed: their Stripe payouts are already on.'
                  : 'Saved on the vendor: it also lets them publish from their own portal, not just in this save.'}
              </span>
            </label>


            <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
              <button type="button" onClick={save} disabled={busy}
                style={{ ...primaryBtn(), opacity: busy ? 0.55 : 1 }}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" onClick={onClose} style={tabBtn(false)}>Cancel</button>
              {(dropLoc.length > 0 || dropAct.length > 0 || dropSess.length > 0) && (
                <span style={{ color: C.pink, fontSize: 13, fontWeight: 700 }}>
                  {dropLoc.length + dropAct.length + dropSess.length} item
                  {dropLoc.length + dropAct.length + dropSess.length === 1 ? '' : 's'} will be removed on save
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}


const OUTCOME: Record<VendorResult['outcome'], { label: string; color: string }> = {
  price_updated: { label: 'Price updated', color: C.green },
  no_price: { label: 'Crawled · no price', color: C.muted },
  no_wp: { label: 'Unreachable / no content', color: C.pink },
};

export function VendorsView() {
  const [runs, setRuns] = useState<VendorRun[] | null>(() => peekCache<{ runs: VendorRun[] }>('/api/admin/vendors/runs')?.runs ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch<{ runs: VendorRun[] }>('/api/admin/vendors/runs');
      setRuns(r.runs);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runNow() {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await adminFetch<{ checked: number; wp_sites: number; prices_updated: number; no_wp: number }>(
        '/api/admin/vendors/refresh', { method: 'POST' });
      setNote(`Done — checked ${r.checked}, ${r.prices_updated} price${r.prices_updated === 1 ? '' : 's'} updated, ${r.no_wp} unreachable.`);
      toast('Price refresh finished');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div style={{ ...card(), display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Vendor directory refresh</div>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 4, maxWidth: 640 }}>
            Crawls each vendor&rsquo;s public site (via Apify when a key is set, otherwise the WordPress
            REST API) and fills in a detected price for auto-listed, unclaimed directory vendors. Runs
            automatically every Monday; you can also run a batch now. Each run processes the
            least-recently-synced vendors, so click a few times to work through the whole list. Claimed
            vendors are never touched.
          </div>
        </div>
        <button onClick={runNow} disabled={busy} style={{ ...primaryBtn(), opacity: busy ? 0.6 : 1, whiteSpace: 'nowrap' }}>
          {busy ? 'Running…' : 'Run refresh now'}
        </button>
      </div>

      {note && <div style={{ ...card(), marginTop: 12, borderColor: C.green, color: C.green }}>{note}</div>}
      {err && <div style={{ ...card(), marginTop: 12, borderColor: C.pink, color: C.pink }}>{err}</div>}

      <div style={{ fontWeight: 800, margin: '22px 0 10px' }}>Run history</div>
      {runs === null && <Skeleton rows={4} />}
      {runs?.length === 0 && <p style={{ color: C.muted }}>No runs yet — trigger one above.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(runs ?? []).map((run) => {
          const statusColor = run.status === 'success' ? C.green : run.status === 'error' ? C.pink : C.muted;
          const noWp = Math.max(0, run.checked - run.wp_sites);
          const isOpen = open === run.id;
          return (
            <div key={run.id} style={card()}>
              <button onClick={() => setOpen(isOpen ? null : run.id)}
                style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 12, background: 'none',
                  border: 'none', color: C.text, cursor: 'pointer', textAlign: 'left', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5,
                  color: statusColor, border: `1px solid ${statusColor}`, borderRadius: 6, padding: '2px 7px' }}>{run.status}</span>
                <span style={{ fontSize: 11, color: C.blue }}>{run.trigger === 'manual' ? 'Manual' : 'Weekly cron'}</span>
                <span style={{ fontWeight: 700 }}>{sgTime(run.started_at)}</span>
                <span style={{ color: C.muted, fontSize: 13, marginLeft: 'auto' }}>
                  {run.checked} checked · <span style={{ color: C.green }}>{run.prices_updated} priced</span> · {noWp} unreachable
                </span>
                <span style={{ color: C.muted }}>{isOpen ? '▾' : '▸'}</span>
              </button>

              {isOpen && (
                <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                  <div style={{ color: C.muted, fontSize: 12, marginBottom: 10 }}>
                    {run.triggered_by ? `Triggered by ${run.triggered_by}. ` : ''}
                    Finished {sgTime(run.finished_at)} · {run.wp_sites} site{run.wp_sites === 1 ? '' : 's'} reachable.
                  </div>
                  {run.error && <div style={{ color: C.pink, fontSize: 13, marginBottom: 10 }}>Error: {run.error}</div>}
                  {run.results.length === 0 ? (
                    <p style={{ color: C.muted, fontSize: 13 }}>No vendors in this batch.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {run.results.map((r, i) => {
                        const o = OUTCOME[r.outcome] ?? OUTCOME.no_price;
                        return (
                          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13,
                            padding: '5px 0', borderBottom: `1px solid ${C.border}` }}>
                            <span style={{ fontWeight: 700, minWidth: 160 }}>{r.name}</span>
                            <span style={{ color: o.color, minWidth: 210 }}>
                              {o.label}{r.price_updated ? ` (${r.price_updated})` : ''}
                            </span>
                            <a href={r.website} target="_blank" rel="noreferrer"
                              style={{ color: C.muted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r.website.replace(/^https?:\/\//, '')}
                            </a>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

