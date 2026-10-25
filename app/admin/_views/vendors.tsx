'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, C, Skeleton, adminFetch, card, input, primaryBtn, sgTime, supabase, tabBtn, toast, peekCache } from '../_lib/core';
import { Select } from '../_lib/multiselect';
import PhotoEditor, { type PhotoKind } from './PhotoEditor';
import { VendorPerformance } from './vendorPerformance';

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
  /** Health signals for the directory filters; absent if the API didn't send them. */
  class_count?: number; live_count?: number; venue_count?: number; no_pin?: boolean;
};
type NewVendorMeta = { categories: AdminCategory[]; vendorCategories: string[]; recent: RecentProvider[] };
// `open` is UI-only (is this card expanded?) and is never sent to the API.
type DraftLocation = { name: string; address: string; postal_code: string; open?: boolean };
type DraftSession = {
  starts_at: string; duration_mins: string; capacity: string; teacher_name: string; studio: string;
};
type DraftActivity = {
  title: string; category_slug: string; description: string;
  age_min_months: string; age_max_months: string; price: string; is_published: boolean;
  image_urls: string; external_booking_url: string; requires_medical_disclosure: boolean;
  is_custom_location: boolean; custom_location_label: string;
  sessions: DraftSession[];
  open?: boolean;
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

/** Formats the canvas editor can't usefully re-encode (animation, vector) go up untouched. */
const SKIP_EDITOR = ['image/gif', 'image/svg+xml'];

/**
 * One image: paste a URL or upload a file — both end up as a URL, since that's
 * what the column stores either way. A picked file opens the photo editor first
 * (crop, resize, transparent background…); "Upload original" there skips it.
 * Shows a thumbnail once there's something to show, so a broken link is obvious
 * straight away, and clicking Edit re-opens the editor on what's already stored.
 */
function ImageField({
  label, value, folder, onChange, placeholder, kind,
}: {
  label: string; value: string; folder: string;
  onChange: (url: string) => void; placeholder?: string;
  /** Logos start with background removal; photos start untouched. */
  kind?: PhotoKind;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<File | string | null>(null);
  const id = `up-${label.replace(/\W+/g, '')}-${folder}`;
  const editorKind: PhotoKind = kind ?? (/logo/i.test(label) ? 'logo' : 'photo');

  async function sendUp(f: File) {
    const url = await uploadImage(f, folder);
    onChange(url);
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';           // so re-picking the same file still fires
    if (!f) return;
    setErr(null);
    if (SKIP_EDITOR.includes(f.type)) {
      setBusy(true);
      try { await sendUp(f); }
      catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
      finally { setBusy(false); }
      return;
    }
    setEditing(f);
  }

  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 5 }}>
        {label}
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={value} onChange={(e) => onChange(e.target.value)} style={input()}
          placeholder={placeholder ?? 'https://… or upload →'} />
        {value.trim() && (
          <button type="button" style={{ ...tabBtn(false), whiteSpace: 'nowrap' }}
            onClick={() => setEditing(value.trim())}>Edit</button>
        )}
        <label htmlFor={id} style={{ ...tabBtn(false), whiteSpace: 'nowrap', lineHeight: '22px', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Uploading…' : 'Upload'}
        </label>
        <input id={id} type="file" accept="image/*" onChange={pick} style={{ display: 'none' }} />
      </div>
      {err && <div style={{ color: C.pink, fontSize: 12, marginTop: 5 }}>{err}</div>}
      {value.trim() && (
        <img src={value} alt="" style={{ height: 40, marginTop: 6, borderRadius: 6, background: C.panel2 }} />
      )}
      {editing && (
        <PhotoEditor
          source={editing}
          kind={editorKind}
          heading={`${typeof editing === 'string' ? 'Edit' : 'Add'} ${label.toLowerCase()}`}
          onCancel={() => setEditing(null)}
          onSave={async (f) => { await sendUp(f); setEditing(null); }}
          onUseOriginal={typeof editing === 'string' ? undefined : async () => { await sendUp(editing); setEditing(null); }}
        />
      )}
    </div>
  );
}

/**
 * Several images for one class: a list of URLs plus an uploader that appends.
 * Picked files go through the photo editor one at a time ("Photo 2 of 4"), and
 * clicking a thumbnail re-opens the editor on that picture.
 */
function ImageListField({
  value, folder, onChange,
}: { value: string; folder: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [queue, setQueue] = useState<File[]>([]);
  const [queued, setQueued] = useState(0);
  const [reedit, setReedit] = useState<{ url: string; index: number } | null>(null);
  const id = `upl-${folder}`;
  const urls = splitUrls(value);
  // Each step of a queue appends to whatever the list is by then.
  const valueRef = useRef(value);
  valueRef.current = value;
  const append = (u: string) => onChange([...splitUrls(valueRef.current), u].join('\n'));

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!files.length) return;
    setErr(null);
    const editable = files.filter((f) => !SKIP_EDITOR.includes(f.type));
    const direct = files.filter((f) => SKIP_EDITOR.includes(f.type));
    if (direct.length) {
      setBusy(true);
      try { for (const f of direct) append(await uploadImage(f, folder)); }
      catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
      finally { setBusy(false); }
    }
    setQueue(editable);
    setQueued(editable.length);
  }

  const current = queue[0] ?? null;
  const next = () => setQueue((q) => q.slice(1));

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
            <img key={k} src={u} alt="" title="Click to edit this photo"
              onClick={() => setReedit({ url: u, index: k })}
              style={{ height: 38, borderRadius: 6, background: C.panel2, cursor: 'pointer' }} />
          ))}
        </div>
      )}
      {current && (
        <PhotoEditor
          key={`${current.name}-${current.size}-${queued - queue.length}`}
          source={current}
          kind="photo"
          heading="Add class photo"
          queueLabel={queued > 1 ? `Photo ${queued - queue.length + 1} of ${queued}` : undefined}
          onCancel={() => setQueue([])}
          onSave={async (f) => { append(await uploadImage(f, folder)); next(); }}
          onUseOriginal={async () => { append(await uploadImage(current, folder)); next(); }}
        />
      )}
      {reedit && (
        <PhotoEditor
          source={reedit.url}
          kind="photo"
          heading="Edit class photo"
          onCancel={() => setReedit(null)}
          onSave={async (f) => {
            const url = await uploadImage(f, folder);
            const list = splitUrls(valueRef.current);
            list[reedit.index] = url;
            onChange(list.join('\n'));
            setReedit(null);
          }}
        />
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
/** A session's own booking rules (migration 00133); all null = it follows the class. */
type SessionRules = {
  allow_cancellation: boolean | null; cancellation_cutoff_hours: number | null;
  cancellation_refund_mode: 'refund' | 'none' | null; allow_rescheduling: boolean | null;
  reschedule_cutoff_hours: number | null; booking_cutoff_minutes: number | null;
};
const NO_RULES: SessionRules = {
  allow_cancellation: null, cancellation_cutoff_hours: null, cancellation_refund_mode: null,
  allow_rescheduling: null, reschedule_cutoff_hours: null, booking_cutoff_minutes: null,
};
const hasOwnRules = (s: SessionRules) => s.allow_cancellation != null;
type EditSession = {
  id: string; starts_at: string; ends_at: string; capacity: number | null;
  teacher_name: string | null; studio: string | null;
  /** null = the class's own price / venue. */
  price: number | null; location_id: string | null;
  /** Set when Wix owns this session's date, time, capacity, venue and price. */
  wix_slot_key?: string | null;
  // Captured once from the pristine starts_at/ends_at when this row loads —
  // see the save-payload builder below for why this can't be recomputed from
  // current form state.
  duration_mins: number;
} & SessionRules;
type EditActivity = {
  id: string; title: string; slug: string; category_slug: string | null; category_name: string | null;
  age_min_months: number; age_max_months: number; price: number | null; is_published: boolean;
  description: string | null; external_booking_url: string | null;
  image_urls: string[]; requires_medical_disclosure: boolean; bookings_paused: boolean;
  location_id: string | null;
  is_custom_location: boolean; custom_location_label: string | null;
  secondary_category_slug: string | null;
  allow_cancellation: boolean; cancellation_cutoff_hours: number; cancellation_refund_mode: 'refund' | 'none';
  allow_rescheduling: boolean; reschedule_cutoff_hours: number; booking_cutoff_minutes: number;
  what_to_bring: string | null; confirmation_message: string | null;
  /** Wix kind when linked; an EVENT or COURSE is never cancellable by a parent. */
  wix_kind: string | null;
  sessions: EditSession[];
};
type EditPolicy = {
  id: string; title: string; body: string | null; document_url: string | null;
  required: boolean; active: boolean; activity_ids: string[] | null;
};
type EditPackage = {
  id: string; name: string; credits: number; price_cents: number; active: boolean;
  activity_ids: string[] | null; validity_days: number | null; expiry_date: string | null;
  allowed_weekday: number | null; allowed_start_time: string | null;
  starts_at: string | null; available_until: string | null; best_value: boolean; purchases: number;
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
  /** From a live Stripe check on load (see refreshStalePayouts). */
  stripe_connected?: boolean; stripe_state?: string | null; stripe_due_count?: number;
  locations: EditLocation[]; activities: EditActivity[];
  /** Saved on their own (each has its own Save), so kept out of the modal's unsaved-changes tracking. */
  policies?: EditPolicy[]; packages?: EditPackage[];
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
  // The add-business form is tucked behind a button; the page opens on the directory.
  const [showAdd, setShowAdd] = useState(false);
  // Optional business fields (WhatsApp, booking link, images, socials, UEN) sit under a fold.
  const [showMore, setShowMore] = useState(false);
  // Directory health filter: 'all' | 'claimed' | 'auto' | 'hand' | 'noarea' | 'noclasses' | 'nopin'
  const [filter, setFilter] = useState<string>('all');

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
  const FILTERS: { key: string; label: string; test: (p: RecentProvider) => boolean }[] = [
    { key: 'all', label: 'All', test: () => true },
    { key: 'claimed', label: 'Claimed', test: (p) => p.is_claimed },
    { key: 'auto', label: 'Auto-listed', test: (p) => !p.is_claimed && p.is_auto_listed },
    { key: 'hand', label: 'Added by hand', test: (p) => !p.is_claimed && !p.is_auto_listed },
    { key: 'noarea', label: 'No area', test: (p) => !p.region },
    // Only count a vendor as "no classes" when the API actually told us.
    { key: 'noclasses', label: 'No classes', test: (p) => p.class_count === 0 },
    { key: 'nopin', label: 'No map pin', test: (p) => p.no_pin === true },
  ];
  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const filteredVendors = !meta ? [] : meta.recent.filter((p) =>
    activeFilter.test(p) && (!q ||
      [p.business_name, p.slug, p.region ?? '', VENDOR_CATEGORY_LABELS[p.vendor_category] ?? p.vendor_category]
        .join(' ').toLowerCase().includes(q)));

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
    setOverridePayoutGate(false); setShowMore(false);
  }

  /** Expand one draft card and fold its siblings, so the form stays short. */
  const openOnly = <T extends { open?: boolean }>(list: T[], at: number): T[] =>
    list.map((x, j) => ({ ...x, open: j === at }));
  const toggleOpen = <T extends { open?: boolean }>(list: T[], at: number): T[] =>
    list.map((x, j) => (j === at ? { ...x, open: !x.open } : x));

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
      setShowAdd(false);
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
      <div style={{ ...card(), display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Vendors</div>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 4, maxWidth: 720 }}>
            Search the directory below and click a vendor to edit it, or add a new business by hand.
          </div>
        </div>
        <button type="button" onClick={() => setShowAdd((v) => !v)}
          style={showAdd ? tabBtn(false) : { ...primaryBtn(), whiteSpace: 'nowrap' }}>
          {showAdd ? 'Close' : '+ Add new business'}
        </button>
      </div>

      {done && !showAdd && (
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
          <button type="button" onClick={() => setEditingId(done.provider.id)}
            style={{ ...primaryBtn(), marginTop: 12 }}>
            Open editor — add sessions &amp; check details
          </button>
        </div>
      )}

      {showAdd && (
      <form onSubmit={submit}>
        <div style={{ ...card(), marginTop: 12 }}>
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
              <Select value={vendorCategory} onChange={(e) => setVendorCategory(e.target.value)} style={input()}>
                {(meta?.vendorCategories ?? Object.keys(VENDOR_CATEGORY_LABELS)).map((v) => (
                  <option key={v} value={v}>{VENDOR_CATEGORY_LABELS[v] ?? v}</option>
                ))}
              </Select>
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

          <button type="button" onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
            style={{ ...tabBtn(false), marginBottom: showMore ? 14 : 0, fontSize: 13 }}>
            {showMore ? '▾ Hide extra details' : '▸ More details'}
            <span style={{ color: C.muted, fontWeight: 600 }}> · WhatsApp, booking link, logo, cover, socials, UEN</span>
          </button>

          {showMore && (<>
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
          </>)}
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
            <button type="button"
              onClick={() => setLocations((p) => {
                const n = [...p, { name: '', address: '', postal_code: '' }];
                return openOnly(n, n.length - 1);
              })}
              style={{ ...tabBtn(false), whiteSpace: 'nowrap' }}>+ Add venue</button>
          </div>

          {locations.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No extra venues.</div>}
          {locations.map((l, i) => (
            <div key={i} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button type="button" aria-expanded={!!l.open}
                  onClick={() => setLocations((p) => toggleOpen(p, i))}
                  style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                    background: 'transparent', border: 'none', color: C.text, cursor: 'pointer', padding: 0 }}>
                  <span style={{ color: C.muted, fontSize: 12, width: 12, display: 'inline-block',
                    transform: l.open ? 'rotate(90deg)' : 'none' }}>▶</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {l.name || 'New venue'}
                    </span>
                    <span style={{ display: 'block', color: C.muted, fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[l.address, l.postal_code].filter(Boolean).join(' · ') || 'No address yet'}
                    </span>
                  </span>
                </button>
                <button type="button" title="Remove venue"
                  onClick={() => setLocations((p) => p.filter((_, j) => j !== i))}
                  style={{ ...tabBtn(false), color: C.pink, borderColor: C.border }}>✕</button>
              </div>
              {l.open && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 140px', gap: 10, alignItems: 'end', marginTop: 12 }}>
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
              </div>
              )}
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
              onClick={() => setActivities((p) => {
                const n: DraftActivity[] = [...p, {
                  title: '', category_slug: defaultCategory, description: '',
                  age_min_months: '', age_max_months: '', price: '', is_published: true,
                  image_urls: '', external_booking_url: '', requires_medical_disclosure: false,
                  is_custom_location: false, custom_location_label: '',
                  sessions: [],
                }];
                return openOnly(n, n.length - 1);
              })}
              style={{ ...tabBtn(false), whiteSpace: 'nowrap' }}>+ Add class</button>
          </div>

          {activities.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No classes yet.</div>}
          {activities.map((a, i) => (
            <div key={i} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button type="button" aria-expanded={!!a.open}
                  onClick={() => setActivities((p) => toggleOpen(p, i))}
                  style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                    background: 'transparent', border: 'none', color: C.text, cursor: 'pointer', padding: 0 }}>
                  <span style={{ color: C.muted, fontSize: 12, width: 12, display: 'inline-block',
                    transform: a.open ? 'rotate(90deg)' : 'none' }}>▶</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.title || 'New class'}
                    </span>
                    <span style={{ display: 'block', color: C.muted, fontSize: 12, marginTop: 2 }}>
                      {(meta?.categories ?? []).find((c) => c.slug === a.category_slug)?.name ?? 'No category'}
                      {` · ${a.price === '' ? 'on enquiry' : `S$${a.price}`}`}
                      {` · ${a.sessions.length} session${a.sessions.length === 1 ? '' : 's'}`}
                      {a.sessions.length === 0 && <span style={{ color: C.pink, fontWeight: 700 }}> · no sessions</span>}
                    </span>
                  </span>
                </button>
                <Badge tone={a.is_published ? 'green' : 'grey'}>{a.is_published ? 'Published' : 'Hidden'}</Badge>
                <button type="button" title="Remove class"
                  onClick={() => setActivities((p) => p.filter((_, j) => j !== i))}
                  style={{ ...tabBtn(false), color: C.pink, borderColor: C.border }}>✕</button>
              </div>

              {a.open && (<>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
                <div>
                  <label style={label('')}>Class name</label>
                  <input value={a.title} style={input()} placeholder="Outdoor Sensory Play"
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />
                </div>
                <div>
                  <label style={label('')}>Category</label>
                  <Select value={a.category_slug} style={input()}
                    onChange={(e) => setActivities((p) => p.map((x, j) => j === i ? { ...x, category_slug: e.target.value } : x))}>
                    {(meta?.categories ?? []).map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                  </Select>
                </div>
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
              </>)}
            </div>
          ))}
        </div>

        {err && <div style={{ ...card(), marginTop: 12, borderColor: C.pink, color: C.pink }}>{err}</div>}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: C.muted }}>
          <input type="checkbox" checked={overridePayoutGate}
            onChange={(e) => setOverridePayoutGate(e.target.checked)} />
          Let this vendor publish without Stripe — BabyBrain will settle their paid bookings manually until they connect Stripe (saved on the vendor, so their own portal lets them publish too)
        </label>

        <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
          <button type="submit" disabled={busy || !name.trim()}
            style={{ ...primaryBtn(), opacity: busy || !name.trim() ? 0.55 : 1 }}>
            {busy ? 'Adding…' : 'Add vendor'}
          </button>
          <button type="button" onClick={reset} style={tabBtn(false)}>Clear</button>
          <button type="button" onClick={() => setShowAdd(false)} style={tabBtn(false)}>Cancel</button>
          {busy && <span style={{ color: C.muted, fontSize: 13 }}>Looking up addresses…</span>}
        </div>
      </form>
      )}

      {/* ---- the directory: search, then click to edit ---- */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '26px 0 10px', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 800 }}>
          All vendors {meta ? <span style={{ color: C.muted, fontWeight: 600 }}>({filteredVendors.length} of {meta.recent.length})</span> : null}
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, area or type…" style={{ ...input(), maxWidth: 320 }} />
      </div>
      {meta && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {FILTERS.map((f) => {
            const n = meta.recent.filter(f.test).length;
            const on = f.key === activeFilter.key;
            return (
              <button key={f.key} type="button" onClick={() => { setFilter(f.key); setShownCount(60); }}
                aria-pressed={on}
                style={{ ...tabBtn(on), padding: '5px 12px', fontSize: 12 }}>
                {f.label} <span style={{ opacity: 0.7 }}>{n}</span>
              </button>
            );
          })}
        </div>
      )}
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
                  {p.class_count !== undefined && (
                    p.class_count === 0
                      ? <span style={{ color: C.pink, fontWeight: 700 }}> · no classes</span>
                      : ` · ${p.live_count ?? 0} of ${p.class_count} class${p.class_count === 1 ? '' : 'es'} live`
                  )}
                  {p.no_pin && <span style={{ color: C.pink, fontWeight: 700 }}> · no map pin</span>}
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
/**
 * Opens the vendor's own portal in a new tab, signed in as this admin with
 * manager access to that vendor (no expiry; see migration 00251). The tab is
 * opened before the request so a popup blocker doesn't eat it.
 */
async function openVendorPortal(providerId: string) {
  const tab = window.open('about:blank', '_blank');
  try {
    const { url } = await adminFetch<{ url: string }>(`/api/admin/providers/${providerId}/portal-access`, { method: 'POST' });
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (e) {
    tab?.close();
    toast(e instanceof Error ? e.message : 'Could not open the vendor portal', 'error');
  }
}

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
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string[] | null>(null);
  // ids marked for removal — applied on save, so a misclick is undoable
  const [dropLoc, setDropLoc] = useState<string[]>([]);
  const [dropAct, setDropAct] = useState<string[]>([]);
  // Existing sessions removed in the UI. New (unsaved) ones just vanish from
  // the array, but a saved one has to be sent back with _delete.
  const [dropSess, setDropSess] = useState<{ actId: string; sessId: string }[]>([]);
  const [newLocs, setNewLocs] = useState<DraftLocation[]>([]);
  // Class ids currently expanded; empty = every class collapsed.
  const [openActs, setOpenActs] = useState<string[]>([]);
  // JSON of everything editable as it was when loaded (or last saved), so we
  // can tell whether closing the modal would throw work away.
  const baseline = useRef<string | null>(null);
  // Waivers and packs: each saves straight away with its own button, so they live
  // outside `d` and never count as unsaved changes to the rest of the form.
  const [extras, setExtras] = useState<{ policies: EditPolicy[]; packages: EditPackage[] } | null>(null);
  const reloadExtras = useCallback(() => {
    adminFetch<ProviderDetail>(`/api/admin/providers/${id}`)
      .then((p) => setExtras({ policies: p.policies ?? [], packages: p.packages ?? [] }))
      .catch((e) => toast(e instanceof Error ? e.message : String(e), 'error'));
  }, [id]);
  useEffect(() => {
    adminFetch<ProviderDetail>(`/api/admin/providers/${id}`)
      .then(({ policies, packages, ...p }) => {
        setExtras({ policies: policies ?? [], packages: packages ?? [] });
        const loaded: ProviderDetail = {
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
        };
        baseline.current = JSON.stringify([loaded, [], [], [], []]);
        setD(loaded);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [id]);

  const dirty = d !== null && baseline.current !== null
    && JSON.stringify([d, newLocs, dropLoc, dropAct, dropSess]) !== baseline.current;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  function requestClose() {
    if (dirtyRef.current && !window.confirm('You have unsaved changes. Discard them and close?')) return;
    onClose();
  }

  // Also guard a tab close / refresh while edits are unsaved.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const set = <K extends keyof ProviderDetail>(k: K, v: ProviderDetail[K]) =>
    setD((p) => (p ? { ...p, [k]: v } : p));

  /* What the save sends, per row, in the shape the API takes. Only rows (and, for the business,
     fields) that differ from what was loaded are sent: the save used to resend every class and
     every session — thousands of one-at-a-time writes for a large vendor, which ran past the
     request's time limit and left edits half-applied. */
  const providerFields = (p: ProviderDetail) => ({
    business_name: p.business_name,
    slug: p.slug ?? undefined,
    description: p.description,
    vendor_category: p.vendor_category,
    contact_email: p.contact_email,
    contact_phone: p.contact_phone,
    whatsapp: p.whatsapp,
    website: p.website,
    address: p.address,
    postal_code: p.postal_code,
    status: p.status,
    logo_url: p.logo_url,
    cover_image_url: p.cover_image_url,
    uen: p.uen,
    social: p.social ?? {},
    // Saved on the vendor (migration 00200) so their own portal lets
    // them publish too, not just this save.
    allow_manual_payouts: p.allow_manual_payouts,
  });
  const locationFields = (l: EditLocation) =>
    ({ name: l.name, address: l.address, postal_code: l.postal_code, is_primary: l.is_primary });
  const activityFields = (a: EditActivity) => ({
    title: a.title, category_slug: a.category_slug ?? undefined,
    description: a.description, age_min_months: a.age_min_months,
    age_max_months: a.age_max_months, price: a.price, is_published: a.is_published,
    image_urls: a.image_urls.map((u) => u.trim()).filter(Boolean),
    external_booking_url: a.external_booking_url,
    requires_medical_disclosure: a.requires_medical_disclosure,
    bookings_paused: a.bookings_paused,
    location_id: a.is_custom_location ? null : a.location_id,
    is_custom_location: a.is_custom_location,
    custom_location_label: a.is_custom_location ? a.custom_location_label : null,
    secondary_category_slug: a.secondary_category_slug ?? null,
    allow_cancellation: a.allow_cancellation,
    cancellation_cutoff_hours: a.cancellation_cutoff_hours,
    cancellation_refund_mode: a.cancellation_refund_mode,
    allow_rescheduling: a.allow_rescheduling,
    reschedule_cutoff_hours: a.reschedule_cutoff_hours,
    booking_cutoff_minutes: a.booking_cutoff_minutes,
    what_to_bring: a.what_to_bring,
    confirmation_message: a.confirmation_message,
  });
  const sessionFields = (s: EditSession) => ({
    starts_at: s.starts_at,
    // The form only ever edits starts_at (no end-time/duration field exists), so this has to be
    // the value fixed at load time from the session's real, pristine starts_at/ends_at —
    // recomputing from CURRENT starts_at against the still-pristine ends_at (older code here)
    // silently changed the length of any rescheduled session.
    duration_mins: s.duration_mins,
    capacity: s.capacity,
    teacher_name: s.teacher_name,
    studio: s.studio,
    price: s.price,
    location_id: s.location_id || null,
    rules: {
      allow_cancellation: s.allow_cancellation, cancellation_cutoff_hours: s.cancellation_cutoff_hours,
      cancellation_refund_mode: s.cancellation_refund_mode, allow_rescheduling: s.allow_rescheduling,
      reschedule_cutoff_hours: s.reschedule_cutoff_hours, booking_cutoff_minutes: s.booking_cutoff_minutes,
    },
  });
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  /** Only what changed since the form was loaded (or last saved); null when nothing did. */
  function changes(cur: ProviderDetail) {
    const orig = (baseline.current ? JSON.parse(baseline.current)[0] : null) as ProviderDetail | null;
    const was = orig ? providerFields(orig) : null;
    const now = providerFields(cur);
    const provider = Object.fromEntries(
      Object.entries(now).filter(([k, v]) => !was || !same(v, (was as Record<string, unknown>)[k]))
    );
    const locations = [
      ...cur.locations.flatMap((l): Record<string, unknown>[] => {
        if (dropLoc.includes(l.id)) return [{ id: l.id, _delete: true }];
        const o = orig?.locations.find((x) => x.id === l.id);
        return o && same(locationFields(o), locationFields(l)) ? [] : [{ id: l.id, ...locationFields(l) }];
      }),
      ...newLocs.filter((l) => l.name.trim() || l.address.trim())
        .map((l) => ({ name: l.name, address: l.address, postal_code: l.postal_code })),
    ];
    const activities = cur.activities.flatMap((a): Record<string, unknown>[] => {
      if (dropAct.includes(a.id)) return [{ id: a.id, _delete: true }];
      const o = orig?.activities.find((x) => x.id === a.id);
      const sessions = [
        ...a.sessions.filter((s) => s.starts_at.trim()).flatMap((s) => {
          if (!s.id) return [sessionFields(s)];
          const os = o?.sessions.find((x) => x.id === s.id);
          return os && same(sessionFields(os), sessionFields(s)) ? [] : [{ id: s.id, ...sessionFields(s) }];
        }),
        // only the ones that belonged to this class
        ...dropSess.filter((x) => x.actId === a.id).map((x) => ({ id: x.sessId, _delete: true })),
      ];
      const fieldsChanged = !o || !same(activityFields(o), activityFields(a));
      if (!fieldsChanged && sessions.length === 0) return [];
      return [{ id: a.id, ...(fieldsChanged ? activityFields(a) : {}), ...(sessions.length ? { sessions } : {}) }];
    });
    if (!Object.keys(provider).length && !locations.length && !activities.length) return null;
    return {
      ...(Object.keys(provider).length ? { provider } : {}),
      ...(locations.length ? { locations } : {}),
      ...(activities.length ? { activities } : {}),
    };
  }

  async function save() {
    if (!d || saved) return;
    const body = changes(d);
    if (!body) { toast('Nothing has changed'); return; }
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await adminFetch<SaveResult>(`/api/admin/providers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setNote([
        `Saved — ${r.locationsChanged} venue${r.locationsChanged === 1 ? '' : 's'}, ${r.activitiesChanged} class${r.activitiesChanged === 1 ? '' : 'es'}, ${r.sessionsChanged} session${r.sessionsChanged === 1 ? '' : 's'}${r.regeocoded ? ', map pin moved' : ''}${r.provider.region ? `, ${r.provider.region}` : ''}.`,
        ...r.warnings,
      ]);
      toast('Vendor saved');
      // What's on screen is now what's saved, so closing shouldn't nag.
      baseline.current = JSON.stringify([d, newLocs, dropLoc, dropAct, dropSess]);
      // Locked until the editor closes: a second click in this window used to send the new
      // sessions and venues again and create duplicates.
      setSaved(true);
      setTimeout(onSaved, 1200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  }

  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 5 };
  const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 };

  return (
    <div onClick={requestClose}
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
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button type="button" onClick={() => openVendorPortal(id)} style={primaryBtn()}
                  title="Work in this vendor's own portal as a manager. You stay out of their team, emails and notifications.">
                  Open vendor portal
                </button>
                <button type="button" onClick={requestClose} style={tabBtn(false)}>Close</button>
              </div>
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
                <Select value={d.vendor_category ?? 'other'} style={input()}
                  onChange={(e) => set('vendor_category', e.target.value)}>
                  {vendorCategories.map((v) => <option key={v} value={v}>{VENDOR_CATEGORY_LABELS[v] ?? v}</option>)}
                </Select>
              </div>
              <div>
                <label style={lbl}>Listing status</label>
                <Select value={d.status} style={input()} onChange={(e) => set('status', e.target.value)}>
                  {['active', 'draft', 'pending', 'suspended'].map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, margin: '18px 0 10px' }}>
              <div style={{ fontWeight: 800 }}>
                Classes <span style={{ color: C.muted, fontWeight: 600, fontSize: 13 }}>
                  ({d.activities.filter((a) => a.is_published).length} live of {d.activities.length})
                </span>
              </div>
              {d.activities.length > 1 && (
                <button type="button" style={{ ...tabBtn(false), padding: '5px 10px', fontSize: 12 }}
                  onClick={() => setOpenActs(openActs.length === d.activities.length ? [] : d.activities.map((a) => a.id))}>
                  {openActs.length === d.activities.length ? 'Collapse all' : 'Expand all'}
                </button>
              )}
            </div>
            {d.activities.length === 0 && (
              <div style={{ color: C.muted, fontSize: 13, marginBottom: 10 }}>
                No classes — this vendor won&rsquo;t appear in search results.
              </div>
            )}
            {d.activities.map((a) => {
              const gone = dropAct.includes(a.id);
              const isOpen = openActs.includes(a.id);
              const upd = (patch: Partial<EditActivity>) =>
                set('activities', d.activities.map((x) => x.id === a.id ? { ...x, ...patch } : x));
              // Same rule as the vendor portal: a Wix event or course can't be cancelled by a parent.
              const cancelLocked = a.wix_kind === 'EVENT' || a.wix_kind === 'COURSE';
              return (
                <div key={a.id} style={{ background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10, opacity: gone ? 0.45 : 1 }}>
                  {/* Collapsed by default: one summary row per class, click to expand. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button type="button" aria-expanded={isOpen}
                      onClick={() => setOpenActs((p) => isOpen ? p.filter((x) => x !== a.id) : [...p, a.id])}
                      style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                        background: 'transparent', border: 'none', color: C.text, cursor: 'pointer', padding: 0 }}>
                      <span style={{ color: C.muted, fontSize: 12, width: 12, display: 'inline-block',
                        transform: isOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {a.title || 'Untitled class'}
                        </span>
                        <span style={{ display: 'block', color: C.muted, fontSize: 12, marginTop: 2 }}>
                          {a.category_name ?? a.category_slug ?? 'No category'}
                          {` · ${a.price == null ? 'on enquiry' : `S$${a.price}`}`}
                          {` · ${a.sessions.length} session${a.sessions.length === 1 ? '' : 's'}`}
                          {/* Problems a parent would hit, visible without expanding. */}
                          {a.sessions.length === 0 && <span style={{ color: C.pink, fontWeight: 700 }}> · no sessions (Schedule TBC)</span>}
                          {!a.is_custom_location && !a.location_id && <span style={{ color: C.pink, fontWeight: 700 }}> · no venue</span>}
                          {a.bookings_paused && <span style={{ color: C.pink, fontWeight: 700 }}> · bookings paused</span>}
                        </span>
                      </span>
                    </button>
                    <Badge tone={a.is_published ? 'green' : 'grey'}>{a.is_published ? 'Published' : 'Hidden'}</Badge>
                    <button type="button" style={{ ...tabBtn(false), color: gone ? C.blue : C.pink }}
                      onClick={() => setDropAct((p) => gone ? p.filter((x) => x !== a.id) : [...p, a.id])}>
                      {gone ? 'Undo' : 'Delete'}
                    </button>
                  </div>

                  {isOpen && (<>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px 180px', gap: 10, alignItems: 'end', marginTop: 12 }}>
                    <div>
                      <label style={lbl}>Class name</label>
                      <input value={a.title} style={input()} disabled={gone}
                        onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, title: e.target.value } : x))} />
                    </div>
                    <div>
                      <label style={lbl}>Category</label>
                      <Select value={a.category_slug ?? ''} style={input()} disabled={gone}
                        onChange={(e) => upd({
                          category_slug: e.target.value,
                          // A second category the same as the main one means nothing; drop it.
                          secondary_category_slug: a.secondary_category_slug === e.target.value ? null : a.secondary_category_slug,
                        })}>
                        {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                      </Select>
                    </div>
                    <div>
                      <label style={lbl}>Also listed under</label>
                      <Select value={a.secondary_category_slug ?? ''} style={input()} disabled={gone}
                        onChange={(e) => upd({ secondary_category_slug: e.target.value || null })}>
                        <option value="">No second category</option>
                        {categories.filter((c) => c.slug !== a.category_slug).map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                      </Select>
                    </div>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <label style={lbl}>Description</label>
                    <textarea value={a.description ?? ''} rows={4} disabled={gone}
                      placeholder="What happens in the class. Blank falls back to the business description."
                      style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
                      onChange={(e) => upd({ description: e.target.value })} />
                    {a.wix_kind && (
                      <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>
                        Linked to Wix: a description changed here is kept, and the Wix sync stops replacing it.
                      </div>
                    )}
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
                        <Select value={a.location_id ?? ''} style={{ ...input(), marginTop: 8 }} disabled={gone}
                          onChange={(e) => set('activities', d.activities.map((x) => x.id === a.id ? { ...x, location_id: e.target.value || null } : x))}>
                          <option value="">No fixed venue</option>
                          {d.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </Select>
                      )}
                    </div>
                  </div>

                  {/* booking rules — same columns and defaults as the vendor portal's drawer */}
                  <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: C.muted }}>BOOKING RULES</span>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 8 }}>
                      <div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, marginBottom: 6 }}>
                          <input type="checkbox" checked={!cancelLocked && a.allow_cancellation} disabled={gone || cancelLocked}
                            onChange={(e) => upd({ allow_cancellation: e.target.checked })} />
                          Parents can cancel
                        </label>
                        {cancelLocked ? (
                          <div style={{ color: C.muted, fontSize: 12 }}>Wix {a.wix_kind === 'EVENT' ? 'events' : 'courses'} can&rsquo;t be cancelled online.</div>
                        ) : a.allow_cancellation && (<>
                          <label style={lbl}>Up to (hours before)</label>
                          <input value={String(a.cancellation_cutoff_hours)} inputMode="numeric" style={input()} disabled={gone}
                            onChange={(e) => upd({ cancellation_cutoff_hours: Number(e.target.value.replace(/\D/g, '') || 0) })} />
                          <label style={{ ...lbl, marginTop: 8 }}>On cancelling</label>
                          <Select value={a.cancellation_refund_mode} style={input()} disabled={gone}
                            onChange={(e) => upd({ cancellation_refund_mode: e.target.value as 'refund' | 'none' })}>
                            <option value="refund">Refund as package credit / make-up token</option>
                            <option value="none">No refund (shown as non-refundable at checkout)</option>
                          </Select>
                        </>)}
                      </div>
                      <div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, marginBottom: 6 }}>
                          <input type="checkbox" checked={a.allow_rescheduling} disabled={gone}
                            onChange={(e) => upd({ allow_rescheduling: e.target.checked })} />
                          Parents can reschedule
                        </label>
                        {a.allow_rescheduling && (<>
                          <label style={lbl}>Up to (hours before)</label>
                          <input value={String(a.reschedule_cutoff_hours)} inputMode="numeric" style={input()} disabled={gone}
                            onChange={(e) => upd({ reschedule_cutoff_hours: Number(e.target.value.replace(/\D/g, '') || 0) })} />
                        </>)}
                      </div>
                      <div>
                        <label style={lbl}>Booking closes (minutes before start)</label>
                        <input value={String(a.booking_cutoff_minutes)} inputMode="numeric" style={input()} disabled={gone}
                          onChange={(e) => upd({ booking_cutoff_minutes: Number(e.target.value.replace(/\D/g, '') || 0) })} />
                        <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>0 = right up to the start. At most 20160 (14 days).</div>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                      <div>
                        <label style={lbl}>What to bring &amp; know</label>
                        <textarea value={a.what_to_bring ?? ''} rows={3} disabled={gone}
                          placeholder="Shown on the class page, e.g. grip socks, arrive 10 minutes early"
                          style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
                          onChange={(e) => upd({ what_to_bring: e.target.value })} />
                      </div>
                      <div>
                        <label style={lbl}>Booking confirmation note</label>
                        <textarea value={a.confirmation_message ?? ''} rows={3} disabled={gone}
                          placeholder="Added to the parent's booking confirmation"
                          style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
                          onChange={(e) => upd({ confirmation_message: e.target.value })} />
                      </div>
                    </div>
                  </div>

                  {/* schedule — same options as the vendor portal's Manage schedule */}
                  <SessionsEditor
                    activity={a}
                    venues={d.locations}
                    disabled={gone}
                    onChange={(sessions) => upd({ sessions })}
                    onRemoveSaved={(sessId) => setDropSess((p) => [...p, { actId: a.id, sessId }])}
                  />
                  </>)}
                </div>
              );
            })}

            {extras && (<>
              <PoliciesSection providerId={id} slug={d.slug ?? d.id} policies={extras.policies}
                activities={d.activities} onChanged={reloadExtras} />
              <PackagesSection providerId={id} packages={extras.packages}
                activities={d.activities} onChanged={reloadExtras} />
            </>)}

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
                  : d.stripe_connected
                    ? `Stripe is connected, but Stripe hasn't switched their payouts on yet (${d.stripe_state === 'incomplete'
                        ? 'their Stripe sign-up isn’t finished'
                        : d.stripe_due_count ? `Stripe still needs ${d.stripe_due_count} item${d.stripe_due_count === 1 ? '' : 's'} from them` : 'Stripe is still verifying them'}). Saved on the vendor: it also lets them publish from their own portal.`
                    : 'They haven’t connected Stripe. Saved on the vendor: it also lets them publish from their own portal, not just in this save.'}
              </span>
            </label>


            {/* Pinned to the bottom of the screen so Save is always in reach,
                however far down the classes you've scrolled. */}
            <div style={{
              position: 'sticky', bottom: 0, zIndex: 2, display: 'flex', gap: 10, alignItems: 'center',
              flexWrap: 'wrap', marginTop: 16, marginLeft: -20, marginRight: -20, marginBottom: -20,
              padding: '12px 20px', background: C.panel, borderTop: `1px solid ${C.border}`,
              borderRadius: '0 0 14px 14px',
            }}>
              <button type="button" onClick={save} disabled={busy || saved}
                style={{ ...primaryBtn(), opacity: busy || saved ? 0.55 : 1 }}>
                {busy ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
              </button>
              <button type="button" onClick={requestClose} style={tabBtn(false)}>Cancel</button>
              {dirty && !busy && (
                <span style={{ color: C.muted, fontSize: 13, fontWeight: 700 }}>Unsaved changes</span>
              )}
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


/* ------------------------------------------------------------------------------------------------
 * A class's sessions in the vendor editor, with the same options as the vendor portal's Manage
 * schedule: one-off or recurring adds, and per-session price, venue, length and booking rules.
 * Everything lands in the editor's draft and is written by its Save (only what changed is sent).
 * --------------------------------------------------------------------------------------------- */

/** Long schedules (one swim school has ~1,800 upcoming sessions) show this many until asked. */
const SESSIONS_SHOWN = 30;
/** Guardrail on one recurring add — same as the vendor portal. */
const MAX_SESSIONS_PER_ADD = 100;
/** Monday-first weekday toggles; i is 0 = Sunday … 6 = Saturday. */
const WEEKDAY_TOGGLES = [
  { i: 1, label: 'Mon' }, { i: 2, label: 'Tue' }, { i: 3, label: 'Wed' }, { i: 4, label: 'Thu' },
  { i: 5, label: 'Fri' }, { i: 6, label: 'Sat' }, { i: 0, label: 'Sun' },
];
/* yyyy-mm-dd helpers on UTC, so the Singapore calendar day picked is the day used (as in the portal). */
const dowOfYmd = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const shiftYmd = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const p = (x: number) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
};
/** Every date a recurrence lands on — the vendor portal's plannedDates, unchanged. */
function plannedDates(f: { date: string; weeks: string; weekdays: number[]; customDates: string[] }): string[] {
  if (!f.date) return [];
  if (f.weeks === 'custom') return [...new Set([f.date, ...f.customDates].filter(Boolean))].sort();
  const nWeeks = Math.min(12, Math.max(1, Number(f.weeks) || 1));
  const baseDow = dowOfYmd(f.date);
  const days = f.weekdays.length ? f.weekdays : [baseDow];
  const out = new Set<string>();
  for (let w = 0; w < nWeeks; w++) for (const wd of days) out.add(shiftYmd(f.date, w * 7 + ((wd - baseDow + 7) % 7)));
  return [...out].sort();
}
const fmtYmd = (ymd: string) => new Date(`${ymd}T00:00:00+08:00`)
  .toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short' });

type AddForm = {
  date: string; time: string; duration: string; capacity: string; weeks: string; weekdays: number[];
  customDates: string[]; customDraft: string; teacher: string; studio: string; location_id: string; price: string;
};

function SessionsEditor({ activity: a, venues, disabled, onChange, onRemoveSaved }: {
  activity: EditActivity; venues: EditLocation[]; disabled: boolean;
  onChange: (sessions: EditSession[]) => void; onRemoveSaved: (sessId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [add, setAdd] = useState<AddForm | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const isWixClass = a.wix_kind != null;
  const classVenue = venues.find((v) => v.id === a.location_id)?.name ?? 'no fixed venue';
  const sessions = a.sessions;
  const shown = showAll ? sessions : sessions.slice(0, SESSIONS_SHOWN);
  const small: React.CSSProperties = { fontSize: 11, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 3 };
  const btn: React.CSSProperties = { ...tabBtn(false), padding: '5px 10px', fontSize: 12 };

  const edit = (si: number, patch: Partial<EditSession>) =>
    onChange(sessions.map((y, k) => (k === si ? { ...y, ...patch } : y)));
  /** Blank, or the class's own price, is stored as null so a later class price change carries over. */
  const priceValue = (raw: string): number | null => {
    if (raw.trim() === '') return null;
    const n = Math.max(0, Number(raw));
    return a.price != null && n === Number(a.price) ? null : n;
  };

  const planned = add ? plannedDates(add) : [];
  function addSessions() {
    if (!add) return;
    if (!add.date || !add.time) return setAddErr('Pick the first date and a start time.');
    if (!(Number(add.capacity) >= 1)) return setAddErr('Set a capacity for these sessions.');
    if (!(Number(add.duration) >= 15)) return setAddErr('Duration must be at least 15 minutes.');
    if (!planned.length) return setAddErr(add.weeks === 'custom' ? 'Add at least one date.' : 'Pick at least one day of the week.');
    if (planned.length > MAX_SESSIONS_PER_ADD) {
      return setAddErr(`That's ${planned.length} sessions in one go. Trim the days or weeks, or add them in a couple of batches.`);
    }
    const drafts: EditSession[] = planned.map((ymd) => ({
      id: '', starts_at: `${ymd}T${add.time}`, ends_at: '', duration_mins: Number(add.duration),
      capacity: Number(add.capacity), teacher_name: add.teacher.trim() || null, studio: add.studio.trim() || null,
      price: priceValue(add.price),
      location_id: add.location_id && add.location_id !== (a.location_id ?? '') ? add.location_id : null,
      ...NO_RULES,
    }));
    onChange([...sessions, ...drafts].sort((x, y) => (x.starts_at || '9').localeCompare(y.starts_at || '9')));
    setShowAll(true);
    setAdd({ ...add, date: '', customDates: [], customDraft: '' });
    setAddErr(null);
  }

  return (
    <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: C.muted }}>
          UPCOMING SESSIONS ({sessions.length})
          {sessions.length === 0 && <span style={{ color: C.pink }}> · none — shows &ldquo;Schedule TBC&rdquo; and can&rsquo;t be booked</span>}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button type="button" disabled={disabled} style={btn}
            onClick={() => { onChange([...sessions, { id: '', starts_at: '', ends_at: '', duration_mins: 60, capacity: null, teacher_name: '', studio: '', price: null, location_id: null, ...NO_RULES }]); setShowAll(true); }}>
            + One session
          </button>
          <button type="button" disabled={disabled || !!add} style={btn}
            onClick={() => { setAddErr(null); setAdd({ date: '', time: '', duration: '45', capacity: '', weeks: '4', weekdays: [], customDates: [], customDraft: '', teacher: '', studio: '', location_id: '', price: '' }); }}>
            + Repeat weekly…
          </button>
        </span>
      </div>
      {isWixClass && (
        <div style={{ color: C.muted, fontSize: 12, marginBottom: 8 }}>
          Linked to Wix: a Wix session&rsquo;s date, time, capacity, venue and price come from Wix, so only its booking rules can be changed here.
        </div>
      )}

      {add && (
        <div style={{ border: `1px dashed ${C.blue}`, borderRadius: 10, padding: 10, marginBottom: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 90px 90px', gap: 8 }}>
            <div><span style={small}>First date</span>
              <input type="date" value={add.date} style={input()}
                onChange={(e) => { const v = e.target.value; setAdd({ ...add, date: v, weekdays: add.weekdays.length ? add.weekdays : v ? [dowOfYmd(v)] : [] }); }} /></div>
            <div><span style={small}>Start time</span>
              <input type="time" value={add.time} style={input()} onChange={(e) => setAdd({ ...add, time: e.target.value })} /></div>
            <div><span style={small}>Minutes</span>
              <input value={add.duration} inputMode="numeric" style={input()} onChange={(e) => setAdd({ ...add, duration: e.target.value.replace(/\D/g, '') })} /></div>
            <div><span style={small}>Capacity</span>
              <input value={add.capacity} inputMode="numeric" style={input()} onChange={(e) => setAdd({ ...add, capacity: e.target.value.replace(/\D/g, '') })} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, marginTop: 8, alignItems: 'end' }}>
            <div><span style={small}>Repeat for</span>
              <Select value={add.weeks} style={input()} onChange={(e) => setAdd({ ...add, weeks: e.target.value })}>
                <option value="1">Just this week</option>
                {[2, 3, 4, 5, 6, 8, 10, 12].map((n) => <option key={n} value={String(n)}>{n} weeks</option>)}
                <option value="custom">Custom dates</option>
              </Select></div>
            {add.weeks === 'custom' ? (
              <div><span style={small}>More dates</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input type="date" value={add.customDraft} style={{ ...input(), width: 170 }} onChange={(e) => setAdd({ ...add, customDraft: e.target.value })} />
                  <button type="button" style={btn} disabled={!add.customDraft}
                    onClick={() => setAdd({ ...add, customDates: [...new Set([...add.customDates, add.customDraft])], customDraft: '' })}>Add date</button>
                  {add.customDates.map((d) => (
                    <button key={d} type="button" style={{ ...btn, color: C.pink }} title="Remove"
                      onClick={() => setAdd({ ...add, customDates: add.customDates.filter((x) => x !== d) })}>{fmtYmd(d)} ✕</button>
                  ))}
                </div></div>
            ) : (
              <div><span style={small}>On</span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {WEEKDAY_TOGGLES.map((w) => {
                    const on = add.weekdays.includes(w.i);
                    return (
                      <button key={w.i} type="button" aria-pressed={on}
                        style={{ ...tabBtn(on), padding: '6px 9px', fontSize: 12 }}
                        onClick={() => setAdd({ ...add, weekdays: on ? add.weekdays.filter((x) => x !== w.i) : [...add.weekdays, w.i] })}>
                        {w.label}
                      </button>
                    );
                  })}
                </div></div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr 110px', gap: 8, marginTop: 8 }}>
            <div><span style={small}>Teacher</span>
              <input value={add.teacher} style={input()} onChange={(e) => setAdd({ ...add, teacher: e.target.value })} /></div>
            <div><span style={small}>Room</span>
              <input value={add.studio} style={input()} onChange={(e) => setAdd({ ...add, studio: e.target.value })} /></div>
            <div><span style={small}>Venue</span>
              <Select value={add.location_id} style={input()} onChange={(e) => setAdd({ ...add, location_id: e.target.value })}>
                <option value="">Class venue ({classVenue})</option>
                {venues.filter((v) => v.id !== a.location_id).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select></div>
            <div><span style={small}>Price (SGD)</span>
              <input value={add.price} inputMode="decimal" style={input()} placeholder={a.price != null ? `class: ${a.price}` : 'class price'}
                onChange={(e) => setAdd({ ...add, price: e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') })} /></div>
          </div>
          <div style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>
            {planned.length
              ? `Adds ${planned.length} session${planned.length === 1 ? '' : 's'}: ${planned.slice(0, 4).map(fmtYmd).join(', ')}${planned.length > 4 ? ` … ${fmtYmd(planned[planned.length - 1])}` : ''}`
              : 'Pick the first date to see which days it adds.'}
          </div>
          {addErr && <div style={{ color: C.pink, fontSize: 13, marginTop: 6 }}>{addErr}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" style={{ ...primaryBtn(), padding: '7px 12px', fontSize: 13 }} onClick={addSessions}>Add to schedule</button>
            <button type="button" style={btn} onClick={() => { setAdd(null); setAddErr(null); }}>Done</button>
          </div>
          <div style={{ color: C.muted, fontSize: 11, marginTop: 6 }}>Added sessions are saved with &ldquo;Save changes&rdquo;.</div>
        </div>
      )}

      {shown.map((s, si) => {
        const wix = !!s.wix_slot_key;
        const own = hasOwnRules(s);
        return (
          <div key={s.id || `new-${si}`} style={{ borderBottom: `1px solid ${C.border}`, padding: '8px 0' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 70px 70px 90px 1.3fr 34px', gap: 6 }}>
              <input type="datetime-local" value={s.starts_at} style={input()} disabled={disabled || wix} aria-label="Starts"
                onChange={(e) => edit(si, { starts_at: e.target.value })} />
              <input value={String(s.duration_mins)} inputMode="numeric" style={input()} disabled={disabled || wix} title="Minutes" aria-label="Minutes"
                onChange={(e) => edit(si, { duration_mins: Number(e.target.value.replace(/\D/g, '') || 0) })} />
              <input value={s.capacity == null ? '' : String(s.capacity)} inputMode="numeric" style={input()} placeholder="cap" disabled={disabled || wix} aria-label="Capacity"
                onChange={(e) => { const v = e.target.value.replace(/\D/g, ''); edit(si, { capacity: v === '' ? null : Number(v) }); }} />
              <input value={s.price == null ? '' : String(s.price)} inputMode="decimal" style={input()} disabled={disabled || wix} aria-label="Price"
                placeholder={a.price != null ? `S$${a.price}` : 'price'} title="Blank = the class price"
                onChange={(e) => { const v = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'); edit(si, { price: priceValue(v) }); }} />
              <Select value={s.location_id ?? ''} style={input()} disabled={disabled || wix} aria-label="Venue"
                onChange={(e) => edit(si, { location_id: e.target.value && e.target.value !== (a.location_id ?? '') ? e.target.value : null })}>
                <option value="">Class venue</option>
                {venues.filter((v) => v.id !== a.location_id).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
              <button type="button" style={{ ...tabBtn(false), color: C.pink, padding: 0 }} disabled={disabled} aria-label="Remove session"
                onClick={() => { if (s.id) onRemoveSaved(s.id); onChange(sessions.filter((_, k) => k !== si)); }}>✕</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.6fr', gap: 6, marginTop: 6, alignItems: 'center' }}>
              <input value={s.teacher_name ?? ''} style={input()} placeholder="teacher" disabled={disabled || wix} aria-label="Teacher"
                onChange={(e) => edit(si, { teacher_name: e.target.value })} />
              <input value={s.studio ?? ''} style={input()} placeholder="room" disabled={disabled || wix} aria-label="Room"
                onChange={(e) => edit(si, { studio: e.target.value })} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: own ? C.text : C.muted }}>
                <input type="checkbox" checked={own} disabled={disabled}
                  onChange={(e) => edit(si, e.target.checked ? {
                    allow_cancellation: a.allow_cancellation, cancellation_cutoff_hours: a.cancellation_cutoff_hours,
                    cancellation_refund_mode: a.cancellation_refund_mode, allow_rescheduling: a.allow_rescheduling,
                    reschedule_cutoff_hours: a.reschedule_cutoff_hours, booking_cutoff_minutes: a.booking_cutoff_minutes,
                  } : NO_RULES)} />
                {own ? 'Own booking rules' : 'Booking rules: as the class'}
                {wix && <Badge tone="blue">From Wix</Badge>}
              </label>
            </div>
            {own && (() => {
              const num: React.CSSProperties = { ...input(), width: 64, padding: '6px 8px', display: 'inline-block' };
              const grp: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12 };
              return (
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, padding: 8, borderRadius: 8, background: C.bg }}>
                  <div style={grp}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <input type="checkbox" checked={!!s.allow_cancellation} disabled={disabled}
                        onChange={(e) => edit(si, { allow_cancellation: e.target.checked })} /> Can cancel
                    </label>
                    {s.allow_cancellation && (<>
                      up to
                      <input value={String(s.cancellation_cutoff_hours ?? 0)} inputMode="numeric" style={num} disabled={disabled} aria-label="Cancel up to hours before"
                        onChange={(e) => edit(si, { cancellation_cutoff_hours: Number(e.target.value.replace(/\D/g, '') || 0) })} />
                      h before,
                      <Select value={s.cancellation_refund_mode ?? 'refund'} style={{ ...input(), width: 'auto', padding: '6px 8px' }} disabled={disabled} aria-label="On cancelling"
                        onChange={(e) => edit(si, { cancellation_refund_mode: e.target.value as 'refund' | 'none' })}>
                        <option value="refund">refund as credit / token</option>
                        <option value="none">no refund</option>
                      </Select>
                    </>)}
                  </div>
                  <div style={grp}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <input type="checkbox" checked={!!s.allow_rescheduling} disabled={disabled}
                        onChange={(e) => edit(si, { allow_rescheduling: e.target.checked })} /> Can reschedule
                    </label>
                    {s.allow_rescheduling && (<>
                      up to
                      <input value={String(s.reschedule_cutoff_hours ?? 0)} inputMode="numeric" style={num} disabled={disabled} aria-label="Reschedule up to hours before"
                        onChange={(e) => edit(si, { reschedule_cutoff_hours: Number(e.target.value.replace(/\D/g, '') || 0) })} />
                      h before
                    </>)}
                  </div>
                  <div style={grp}>
                    Booking closes
                    <input value={String(s.booking_cutoff_minutes ?? 0)} inputMode="numeric" style={num} disabled={disabled} aria-label="Booking closes minutes before"
                      onChange={(e) => edit(si, { booking_cutoff_minutes: Number(e.target.value.replace(/\D/g, '') || 0) })} />
                    min before
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })}
      {sessions.length > SESSIONS_SHOWN && (
        <button type="button" style={{ ...btn, marginTop: 8 }} onClick={() => setShowAll((v) => !v)}>
          {showAll ? `Show the first ${SESSIONS_SHOWN} only` : `Show all ${sessions.length} sessions`}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Waivers & consents and class packs, inside the vendor editor. Same rows and rules as the vendor
 * portal's own screens (PoliciesManager, PackagesPage); each item saves on its own button.
 * --------------------------------------------------------------------------------------------- */

const sectionHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, margin: '22px 0 10px' };
const itemBox: React.CSSProperties = { background: C.panel2, borderRadius: 10, padding: 12, marginBottom: 10 };
const smallLbl: React.CSSProperties = { fontSize: 12, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 5 };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Wix kinds a pack can't be spent on (the portal leaves them out of its picker too). */
const PACK_INELIGIBLE = new Set(['EVENT', 'COURSE', 'APPOINTMENT']);

/** UTC ISO -> "YYYY-MM-DDTHH:mm" Singapore wall-clock, for datetime-local inputs. */
const isoToSg = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(0, 16) : '');
const sgWhen = (iso: string) => new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Tick-list of the vendor's classes; none ticked = every class. */
function ClassPicker({ classes, value, onChange, allLabel }: {
  classes: { id: string; title: string }[]; value: string[]; onChange: (v: string[]) => void; allLabel: string;
}) {
  return (
    <div style={{ ...input(), padding: 10, maxHeight: 180, overflow: 'auto' }}>
      <div style={{ color: value.length ? C.muted : C.green, fontSize: 12, fontWeight: 800, marginBottom: 6 }}>
        {value.length ? `${value.length} selected` : allLabel}
      </div>
      {classes.map((c) => (
        <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, padding: '3px 0' }}>
          <input type="checkbox" checked={value.includes(c.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))} />
          {c.title || 'Untitled class'}
        </label>
      ))}
      {classes.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No classes to choose from.</div>}
    </div>
  );
}

type PolicyForm = { id: string | null; title: string; body: string; document_url: string; required: boolean; activity_ids: string[] };

function PoliciesSection({ providerId, slug, policies, activities, onChanged }: {
  providerId: string; slug: string; policies: EditPolicy[];
  activities: EditActivity[]; onChanged: () => void;
}) {
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const titleOf = (id: string) => activities.find((a) => a.id === id)?.title ?? 'a removed class';

  async function upload(file: File) {
    setUploading(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const body = new FormData();
      body.append('file', file); body.append('folder', `policies-${slug}`); body.append('kind', 'policy');
      const res = await fetch('/api/admin/upload', {
        method: 'POST', headers: session ? { Authorization: `Bearer ${session.access_token}` } : {}, body,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? 'Upload failed');
      setForm((f) => (f ? { ...f, document_url: json.url as string } : f));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setUploading(false); }
  }

  async function save() {
    if (!form) return;
    if (!form.title.trim()) { setErr('Give it a title parents will recognise.'); return; }
    setBusy(true); setErr(null);
    try {
      const fields = { title: form.title, body: form.body, document_url: form.document_url, required: form.required, activity_ids: form.activity_ids };
      await adminFetch(`/api/admin/providers/${providerId}/policies`, {
        method: form.id ? 'PATCH' : 'POST',
        body: JSON.stringify(form.id ? { policyId: form.id, ...fields } : fields),
      });
      toast(form.id ? 'Policy saved' : 'Policy added');
      setForm(null);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function setActive(p: EditPolicy, active: boolean) {
    try {
      await adminFetch(`/api/admin/providers/${providerId}/policies`, { method: 'PATCH', body: JSON.stringify({ policyId: p.id, active }) });
      toast(active ? `"${p.title}" turned on` : `"${p.title}" turned off`);
      onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  }

  return (
    <>
      <div style={sectionHead}>
        <div style={{ fontWeight: 800 }}>
          Waivers &amp; consents <span style={{ color: C.muted, fontWeight: 600, fontSize: 13 }}>({policies.length}) · parents accept these before booking · saves on its own</span>
        </div>
        <button type="button" style={tabBtn(false)} disabled={!!form}
          onClick={() => { setErr(null); setForm({ id: null, title: '', body: '', document_url: '', required: true, activity_ids: [] }); }}>
          + Add
        </button>
      </div>
      {policies.length === 0 && !form && <div style={{ color: C.muted, fontSize: 13, marginBottom: 10 }}>None yet.</div>}
      {policies.map((p) => (form?.id === p.id ? null : (
        <div key={p.id} style={{ ...itemBox, opacity: p.active ? 1 : 0.55 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>
                {p.title}{' '}
                <Badge tone={p.required ? 'pink' : 'grey'}>{p.required ? 'Required to book' : 'Optional'}</Badge>{' '}
                {!p.active && <Badge tone="grey">Off</Badge>}
              </div>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>
                {!p.activity_ids?.length ? 'All classes'
                  : p.activity_ids.length <= 2 ? `Only for ${p.activity_ids.map(titleOf).join(' & ')}` : `Only for ${p.activity_ids.length} classes`}
                {p.document_url && <> · <a href={p.document_url} target="_blank" rel="noreferrer" style={{ color: C.blue }}>document</a></>}
              </div>
              {p.body && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap' }}>{p.body}</div>}
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button type="button" style={{ ...tabBtn(false), padding: '5px 10px', fontSize: 12 }} disabled={!!form}
                onClick={() => { setErr(null); setForm({ id: p.id, title: p.title, body: p.body ?? '', document_url: p.document_url ?? '', required: p.required, activity_ids: p.activity_ids ?? [] }); }}>
                Edit
              </button>
              <button type="button" style={{ ...tabBtn(false), padding: '5px 10px', fontSize: 12 }} onClick={() => setActive(p, !p.active)}>
                {p.active ? 'Turn off' : 'Turn on'}
              </button>
            </div>
          </div>
        </div>
      )))}
      {form && (
        <div style={{ ...itemBox, border: `1px dashed ${C.blue}` }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={smallLbl}>Title</label>
              <input value={form.title} style={input()} placeholder="e.g. Liability waiver" onChange={(e) => setForm({ ...form, title: e.target.value })} />
              <label style={{ ...smallLbl, marginTop: 10 }}>What parents read</label>
              <textarea value={form.body} rows={5} style={{ ...input(), resize: 'vertical', fontFamily: 'inherit' }}
                placeholder="The wording a parent ticks to accept." onChange={(e) => setForm({ ...form, body: e.target.value })} />
              <label style={{ ...smallLbl, marginTop: 10 }}>Document (optional)</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ ...tabBtn(false), padding: '6px 12px', fontSize: 13 }}>
                  {uploading ? 'Uploading…' : 'Upload PDF'}
                  <input type="file" accept="application/pdf,image/*" style={{ display: 'none' }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
                </label>
                {form.document_url && <>
                  <a href={form.document_url} target="_blank" rel="noreferrer" style={{ color: C.blue, fontSize: 13 }}>Open</a>
                  <button type="button" style={{ ...tabBtn(false), padding: '4px 8px', fontSize: 12, color: C.pink }}
                    onClick={() => setForm({ ...form, document_url: '' })}>Remove</button>
                </>}
              </div>
            </div>
            <div>
              <label style={smallLbl}>Applies to</label>
              <ClassPicker classes={activities} value={form.activity_ids} allLabel="All of their classes"
                onChange={(v) => setForm({ ...form, activity_ids: v })} />
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 13, marginTop: 10 }}>
                <input type="checkbox" checked={form.required} style={{ marginTop: 2 }} onChange={(e) => setForm({ ...form, required: e.target.checked })} />
                <span>Parents must accept this before they can book<br />
                  <span style={{ color: C.muted, fontSize: 12 }}>Off: parents see it but can book without ticking.</span></span>
              </label>
            </div>
          </div>
          {err && <div style={{ color: C.pink, fontSize: 13, marginTop: 8 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={save} disabled={busy || uploading} style={{ ...primaryBtn(), padding: '8px 14px', opacity: busy ? 0.55 : 1 }}>
              {busy ? 'Saving…' : form.id ? 'Save policy' : 'Add policy'}
            </button>
            <button type="button" style={tabBtn(false)} onClick={() => { setForm(null); setErr(null); }}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

type PackForm = {
  id: string | null; name: string; credits: string; price: string; best_value: boolean;
  expiry_mode: 'none' | 'days' | 'date'; validity_days: string; expiry_date: string;
  activity_ids: string[]; allowed_weekday: string; allowed_start_time: string;
  starts_at: string; available_until: string;
};
const blankPack = (): PackForm => ({
  id: null, name: '', credits: '', price: '', best_value: false, expiry_mode: 'none', validity_days: '', expiry_date: '',
  activity_ids: [], allowed_weekday: '', allowed_start_time: '', starts_at: '', available_until: '',
});
/** Same order of checks as the portal: paused, not on sale yet, sale window over, on sale. */
function packStatus(p: EditPackage): { label: string; tone: 'green' | 'blue' | 'pink' | 'grey' } {
  if (!p.active) return { label: 'Paused', tone: 'grey' };
  const now = Date.now();
  if (p.starts_at && new Date(p.starts_at).getTime() > now) return { label: 'Upcoming', tone: 'blue' };
  if (p.available_until && new Date(p.available_until).getTime() <= now) return { label: 'Expired', tone: 'pink' };
  return { label: 'Active', tone: 'green' };
}

function PackagesSection({ providerId, packages, activities, onChanged }: {
  providerId: string; packages: EditPackage[]; activities: EditActivity[]; onChanged: () => void;
}) {
  const [form, setForm] = useState<PackForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const eligible = activities.filter((a) => !PACK_INELIGIBLE.has(a.wix_kind ?? ''));
  const titleOf = (id: string) => activities.find((a) => a.id === id)?.title ?? 'a removed class';

  function summary(p: EditPackage) {
    const parts: string[] = [];
    if (p.starts_at) parts.push(`on sale from ${sgWhen(p.starts_at)}`);
    if (p.available_until) parts.push(`until ${sgWhen(p.available_until)}`);
    if (p.activity_ids?.length) parts.push(p.activity_ids.length <= 2 ? p.activity_ids.map(titleOf).join(' & ') : `${p.activity_ids.length} classes`);
    else parts.push('any class');
    if (p.allowed_weekday != null) parts.push(`${WEEKDAYS[p.allowed_weekday]}${p.allowed_start_time ? ` ${p.allowed_start_time.slice(0, 5)}` : ''} only`);
    else if (p.allowed_start_time) parts.push(`${p.allowed_start_time.slice(0, 5)} slot only`);
    if (p.validity_days) parts.push(`credits last ${p.validity_days} days`);
    else if (p.expiry_date) parts.push(`credits expire ${p.expiry_date}`);
    return parts.join(' · ');
  }

  function edit(p: EditPackage) {
    setErr(null);
    setForm({
      id: p.id, name: p.name, credits: String(p.credits), price: String(p.price_cents / 100), best_value: p.best_value,
      expiry_mode: p.expiry_date ? 'date' : p.validity_days != null ? 'days' : 'none',
      validity_days: p.validity_days != null ? String(p.validity_days) : '', expiry_date: p.expiry_date ?? '',
      // A class that can no longer take packs (it became a Wix event/course/appointment) is dropped, as in the portal.
      activity_ids: (p.activity_ids ?? []).filter((id) => eligible.some((a) => a.id === id)),
      allowed_weekday: p.allowed_weekday != null ? String(p.allowed_weekday) : '',
      allowed_start_time: p.allowed_start_time?.slice(0, 5) ?? '',
      starts_at: isoToSg(p.starts_at), available_until: isoToSg(p.available_until),
    });
  }

  async function save() {
    if (!form) return;
    // An existing pack limited only to classes that can't take packs any more would silently become "any class".
    const original = form.id ? packages.find((p) => p.id === form.id) : null;
    if (original?.activity_ids?.length && form.activity_ids.length === 0) {
      setErr('This pack was limited to classes that no longer take packs (Wix events, courses or appointments). Choose which classes it applies to now.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      const fields = {
        name: form.name, credits: Number(form.credits), price: form.price === '' ? 0 : Number(form.price),
        best_value: form.best_value, expiry_mode: form.expiry_mode,
        validity_days: form.validity_days === '' ? null : Number(form.validity_days), expiry_date: form.expiry_date || null,
        activity_ids: form.activity_ids,
        allowed_weekday: form.allowed_weekday === '' ? null : Number(form.allowed_weekday),
        allowed_start_time: form.allowed_start_time || null,
        starts_at: form.starts_at || null, available_until: form.available_until || null,
      };
      await adminFetch(`/api/admin/providers/${providerId}/packages`, {
        method: form.id ? 'PATCH' : 'POST',
        body: JSON.stringify(form.id ? { packageId: form.id, ...fields } : fields),
      });
      toast(form.id ? 'Pack saved' : 'Pack added');
      setForm(null);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function setActive(p: EditPackage, active: boolean) {
    try {
      await adminFetch(`/api/admin/providers/${providerId}/packages`, { method: 'PATCH', body: JSON.stringify({ packageId: p.id, active }) });
      toast(active ? `"${p.name}" resumed` : `"${p.name}" paused`);
      onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  }

  async function remove(p: EditPackage) {
    if (!window.confirm(`Delete "${p.name}"? This can't be undone.`)) return;
    try {
      await adminFetch(`/api/admin/providers/${providerId}/packages?packageId=${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      toast(`Deleted "${p.name}"`);
      onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  }

  return (
    <>
      <div style={sectionHead}>
        <div style={{ fontWeight: 800 }}>
          Packages <span style={{ color: C.muted, fontWeight: 600, fontSize: 13 }}>({packages.length}) · class packs parents buy up front · saves on its own</span>
        </div>
        <button type="button" style={tabBtn(false)} disabled={!!form} onClick={() => { setErr(null); setForm(blankPack()); }}>+ Add pack</button>
      </div>
      {packages.length === 0 && !form && <div style={{ color: C.muted, fontSize: 13, marginBottom: 10 }}>None yet.</div>}
      {packages.map((p) => {
        if (form?.id === p.id) return null;
        const st = packStatus(p);
        return (
          <div key={p.id} style={{ ...itemBox, opacity: p.active ? 1 : 0.6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>
                  {p.name}{' '}
                  <span style={{ color: C.muted, fontWeight: 600, fontSize: 13 }}>
                    {p.credits} session{p.credits === 1 ? '' : 's'} · S${(p.price_cents / 100).toFixed(2).replace(/\.00$/, '')}
                  </span>{' '}
                  <Badge tone={st.tone}>{st.label}</Badge>{' '}
                  {p.best_value && <Badge tone="amber">Best value</Badge>}
                </div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>
                  {summary(p)}{p.purchases ? ` · bought ${p.purchases} time${p.purchases === 1 ? '' : 's'}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button type="button" style={{ ...tabBtn(false), padding: '5px 10px', fontSize: 12 }} disabled={!!form} onClick={() => edit(p)}>Edit</button>
                <button type="button" style={{ ...tabBtn(false), padding: '5px 10px', fontSize: 12 }} onClick={() => setActive(p, !p.active)}>
                  {p.active ? 'Pause' : 'Resume'}
                </button>
                {p.purchases === 0 && (
                  <button type="button" style={{ ...tabBtn(false), padding: '5px 10px', fontSize: 12, color: C.pink }} onClick={() => remove(p)}>Delete</button>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {form && (
        <div style={{ ...itemBox, border: `1px dashed ${C.blue}` }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 120px', gap: 10 }}>
            <div>
              <label style={smallLbl}>Pack name</label>
              <input value={form.name} style={input()} placeholder="e.g. 10-class pack" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label style={smallLbl}>Sessions</label>
              <input value={form.credits} inputMode="numeric" style={input()} onChange={(e) => setForm({ ...form, credits: e.target.value.replace(/\D/g, '') })} />
            </div>
            <div>
              <label style={smallLbl}>Price (SGD)</label>
              <input value={form.price} inputMode="decimal" style={input()}
                onChange={(e) => setForm({ ...form, price: e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') })} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            <div>
              <label style={smallLbl}>Applies to</label>
              <ClassPicker classes={eligible} value={form.activity_ids} allLabel="Any of their classes"
                onChange={(v) => setForm({ ...form, activity_ids: v })} />
              {eligible.length < activities.length && (
                <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Wix events, courses and appointments can&rsquo;t take packs, so they aren&rsquo;t listed.</div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, marginTop: 10 }}>
                <input type="checkbox" checked={form.best_value} onChange={(e) => setForm({ ...form, best_value: e.target.checked })} />
                Mark as &ldquo;Best value&rdquo;
              </label>
            </div>
            <div>
              <label style={smallLbl}>Credits expire</label>
              <Select value={form.expiry_mode} style={input()}
                onChange={(e) => setForm({ ...form, expiry_mode: e.target.value as PackForm['expiry_mode'], validity_days: '', expiry_date: '' })}>
                <option value="none">Never</option>
                <option value="days">A number of days after buying</option>
                <option value="date">On a fixed date</option>
              </Select>
              {form.expiry_mode === 'days' && (
                <input value={form.validity_days} inputMode="numeric" style={{ ...input(), marginTop: 8 }} placeholder="days, e.g. 90"
                  onChange={(e) => setForm({ ...form, validity_days: e.target.value.replace(/\D/g, '') })} />
              )}
              {form.expiry_mode === 'date' && (
                <input type="date" value={form.expiry_date} style={{ ...input(), marginTop: 8 }} onChange={(e) => setForm({ ...form, expiry_date: e.target.value })} />
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8, marginTop: 10 }}>
                <div>
                  <label style={smallLbl}>Only on</label>
                  <Select value={form.allowed_weekday} style={input()} onChange={(e) => setForm({ ...form, allowed_weekday: e.target.value })}>
                    <option value="">Any day</option>
                    {WEEKDAYS.map((w, i) => <option key={w} value={String(i)}>{w}</option>)}
                  </Select>
                </div>
                <div>
                  <label style={smallLbl}>At</label>
                  <input type="time" value={form.allowed_start_time} style={input()} onChange={(e) => setForm({ ...form, allowed_start_time: e.target.value })} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                <div>
                  <label style={smallLbl}>On sale from</label>
                  <input type="datetime-local" value={form.starts_at} style={input()} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
                </div>
                <div>
                  <label style={smallLbl}>On sale until</label>
                  <input type="datetime-local" value={form.available_until} style={input()} onChange={(e) => setForm({ ...form, available_until: e.target.value })} />
                </div>
              </div>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>
                Sale dates decide when parents can buy it. Expiry is separate: how long each parent&rsquo;s credits stay valid.
              </div>
            </div>
          </div>
          {err && <div style={{ color: C.pink, fontSize: 13, marginTop: 8 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={save} disabled={busy} style={{ ...primaryBtn(), padding: '8px 14px', opacity: busy ? 0.55 : 1 }}>
              {busy ? 'Saving…' : form.id ? 'Save pack' : 'Add pack'}
            </button>
            <button type="button" style={tabBtn(false)} onClick={() => { setForm(null); setErr(null); }}>Cancel</button>
          </div>
        </div>
      )}
    </>
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
      <VendorPerformance />
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

