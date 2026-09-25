import { memo, useEffect, useRef, useState } from "react";
import {
  Button,
  Icon,
  PageShell,
  PlusFeatureDialog,
  phoneDigits,
  wixThumbUrl,
} from "../components/ui";
import { ActivityDetailSkeleton } from "../components/Skeletons";
import { useActivityDetail, useFavorite, usePlan, isPackOnSale } from "../lib/data";
import { supabase } from "../lib/supabase";
import { cacheFetch } from "../lib/queryCache";
import { goTo, getParam, scrollToWhenReady, rememberExploreUrl, exploreReturnHref } from "../lib/nav";
import { sgDateTime, sgDayRange, courseStrands, isMultiDay } from "../lib/schedule";
import { SessionSchedule } from "../components/SessionSchedule";
import { resolveActivityImages, providerLogoUrl, FALLBACK_LOGO_URL } from "../lib/activityMedia";
import { formatDuration } from "../lib/database.types";
import { EnquiryChat } from "../components/EnquiryChat";
import { ClassGroupChat } from "../components/ClassGroupChat";
import { useAuth } from "../auth/AuthProvider";

function PhotoLightbox({
  images,
  index,
  onClose,
  onIndex,
}: {
  images: string[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onIndex((index + 1) % images.length);
      if (e.key === "ArrowLeft") onIndex((index - 1 + images.length) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onClose, onIndex]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 p-4" onClick={onClose}>
      <div className="flex items-center justify-between text-white">
        <span className="text-sm font-bold">{index + 1} / {images.length}</span>
        <button type="button" onClick={onClose} aria-label="Close photos" className="rounded-full p-2 hover:bg-white/10">
          <Icon name="close" className="h-6 w-6" />
        </button>
      </div>
      <div
        className="flex flex-1 touch-pan-y items-center justify-center gap-4"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => {
          swipeStart.current = images.length > 1 && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
        }}
        onTouchEnd={(e) => {
          const s = swipeStart.current;
          swipeStart.current = null;
          if (!s) return;
          const dx = e.changedTouches[0].clientX - s.x;
          const dy = e.changedTouches[0].clientY - s.y;
          // A deliberate sideways swipe, not a tap or a vertical scroll.
          if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
          onIndex(dx < 0 ? (index + 1) % images.length : (index - 1 + images.length) % images.length);
        }}
      >
        {images.length > 1 && (
          <button
            type="button"
            aria-label="Previous photo"
            onClick={() => onIndex((index - 1 + images.length) % images.length)}
            className="shrink-0 rounded-full bg-white/10 p-3 text-white hover:bg-white/20"
          >
            ‹
          </button>
        )}
        <img src={images[index]} alt="" className="max-h-[75vh] max-w-full rounded-[14px] object-contain" />
        {images.length > 1 && (
          <button
            type="button"
            aria-label="Next photo"
            onClick={() => onIndex((index + 1) % images.length)}
            className="shrink-0 rounded-full bg-white/10 p-3 text-white hover:bg-white/20"
          >
            ›
          </button>
        )}
      </div>
      <div className="flex justify-center gap-2 overflow-x-auto pb-2" onClick={(e) => e.stopPropagation()}>
        {images.map((url, i) => (
          <button
            key={url}
            type="button"
            onClick={() => onIndex(i)}
            aria-label={`Photo ${i + 1}`}
            className={`overflow-hidden rounded-[8px] border-2 transition ${i === index ? "border-white" : "border-transparent opacity-60 hover:opacity-100"}`}
          >
            <img src={url} alt="" className="h-12 w-20 object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Inline hero carousel. Owns its own position/timer state so a slide change
 *  re-renders only this, not the whole activity page. All slides are decoded
 *  up front (not lazy) so a swipe or auto-advance never waits on a network
 *  fetch or decode mid-transition. */
/**
 * Landscape-logo detection by *content*, not provenance. A vendor's logo can
 * end up anywhere — the dedicated profile-picture field, or (as found in
 * QA: "Physio Down Under" got cropped in the hero) re-uploaded as one of the
 * activity's own custom photos, byte-identical to their logo_url but under a
 * different filename — so comparing URLs (providerLogoUrl) alone can't catch
 * every case. A logo/wordmark is reliably a mark over a large area of one
 * flat, uniform background color; a real photo essentially never is one
 * dominant color across more than half its area. Sampling a downscaled copy
 * of the image and measuring how much of it sits within a small color
 * distance of its single most common color (not the four corners' average —
 * tried that first, and it broke as soon as the mark's art reached one
 * corner, e.g. this exact logo) gives a cheap, general "is this a graphic,
 * not a photo" signal that works for any vendor without needing to know
 * where the image came from. Threshold picked empirically against this
 * provider's own logo/photo pairs: logos landed at 0.63–0.84, real photos at
 * 0.04–0.27 (portrait photos never reach here — the aspect-ratio check below
 * already catches those).
 */
function looksLikeGraphic(el: HTMLImageElement): boolean {
  try {
    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(el, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    // Quantize to 16 levels per channel so near-identical pixels (compression
    // noise, anti-aliasing) count as the same color, then find the mode.
    const counts = new Map<string, number>();
    for (let p = 0; p < size * size; p++) {
      const i = p * 4;
      const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let modeKey = "";
    let modeCount = 0;
    for (const [key, count] of counts) {
      if (count > modeCount) {
        modeKey = key;
        modeCount = count;
      }
    }
    const [mr, mg, mb] = modeKey.split(",").map((n) => Number(n) * 16 + 8);
    let close = 0;
    for (let p = 0; p < size * size; p++) {
      const i = p * 4;
      const dr = data[i] - mr;
      const dg = data[i + 1] - mg;
      const db = data[i + 2] - mb;
      if (dr * dr + dg * dg + db * db < 30 * 30 * 3) close++;
    }
    return close / (size * size) > 0.5;
  } catch {
    // A canvas tainted by a cross-origin image with no CORS headers throws
    // on getImageData — fall back to the aspect-ratio heuristic below rather
    // than guessing. Only ever called on the invisible probe image in
    // HeroSlide, never the one actually shown to the parent — see its own
    // comment for why that split matters.
    return false;
  }
}

/** One hero slide. A landscape photo fills the frame (anchored near the top so faces stay in);
 *  anything that isn't — a logo, a square or portrait picture, a very wide banner — is shown whole
 *  on a soft blurred copy of itself, so a vendor's logo is never cut off. `forceWhole` additionally
 *  covers a *landscape* logo (see providerLogoUrl in activityMedia.ts and looksLikeGraphic above,
 *  which between them catch a landscape logo whether or not it's the provider's own logo_url —
 *  aspect ratio alone can't tell a landscape logo from a landscape photo). */
function HeroSlide({ url, alt, priority, forceWhole }: { url: string; alt: string; priority: boolean; forceWhole?: boolean }) {
  const [ratio, setRatio] = useState<number | null>(null);
  const [isGraphic, setIsGraphic] = useState(false);
  // A Wix CDN response missing (or inconsistent about) CORS headers, a
  // throttled request, a since-deleted source file — none of that is under
  // this app's control, and this is the actual hero photo, not a card
  // thumbnail with 50 siblings to fall back on visually. `broken` guarantees
  // it degrades to the brand mark instead of a permanently blank hero.
  const [broken, setBroken] = useState(false);

  // Pixel-samples a separate, invisible copy purely to tell a logo/wordmark
  // from a photo (looksLikeGraphic) — never the visible <img> below. This
  // used to run `crossOrigin="anonymous"` on that visible image instead: a
  // request tagged `crossorigin` isn't just unreadable to canvas if the
  // response lacks a matching CORS header, per the spec it fails to load at
  // all, same as a broken URL. Wix's CDN answering that inconsistently (an
  // edge cache miss, a throttled anonymous fetch, a plain missing header on
  // some path) is exactly what "the hero image sometimes doesn't render"
  // looks like from here — this probe can fail freely instead, since its
  // only job is a cosmetic whole-vs-cropped decision that already falls back
  // to the aspect-ratio heuristic below when it can't tell.
  useEffect(() => {
    if (url === FALLBACK_LOGO_URL) return;
    let cancelled = false;
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.onload = () => {
      if (!cancelled) setIsGraphic(looksLikeGraphic(probe));
    };
    probe.src = wixThumbUrl(url, 64, 64);
    return () => {
      cancelled = true;
    };
  }, [url]);

  const measureRatio = (el: HTMLImageElement | null) => {
    if (!el || !el.naturalWidth || !el.naturalHeight) return;
    setRatio(el.naturalWidth / el.naturalHeight);
  };

  if (url === FALLBACK_LOGO_URL || broken) {
    return <img src={FALLBACK_LOGO_URL} alt={alt} width={860} height={305} decoding="async" loading="eager" className="h-[305px] w-full shrink-0 bg-[#F3EDF0] object-contain p-12" />;
  }
  const whole = forceWhole || isGraphic || (ratio != null && (ratio < 1.4 || ratio > 3.6));
  // The display box is 860x305 (see the grid column width this sits in); a
  // Wix original is routinely 1500px+, so this was downloading many times
  // the bytes it shows. `/v1/fit/` never crops, so measureRatio/looksLikeGraphic
  // still see the same aspect ratio. The blurred backdrop is scaled up and
  // blurred into mush regardless, so it gets a far smaller rendition.
  const heroSrc = wixThumbUrl(url, 1000, 360);
  return (
    <div className="relative h-[305px] w-full shrink-0 overflow-hidden bg-[#F3EDF0]">
      {whole && (
        <img src={wixThumbUrl(url, 64, 64)} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-2xl" />
      )}
      <img
        ref={(el) => { if (el?.complete) measureRatio(el); }}
        src={heroSrc}
        alt={alt}
        width={860}
        height={305}
        decoding="async"
        fetchPriority={priority ? "high" : "auto"}
        loading="eager"
        onLoad={(e) => measureRatio(e.currentTarget)}
        onError={() => setBroken(true)}
        className={`relative h-full w-full ${whole ? "object-contain" : "object-cover object-[center_15%]"}`}
      />
    </div>
  );
}

const HeroCarousel = memo(function HeroCarousel({
  images,
  logoUrl,
  title,
  resetKey,
  onOpen,
}: {
  images: string[];
  /** The vendor's own logo_url, if it's one of `images` — never cropped, whatever its shape. */
  logoUrl?: string | null;
  title: string;
  resetKey: string | undefined;
  onOpen: (index: number) => void;
}) {
  const [at, setAt] = useState(0);
  const [paused, setPaused] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const count = images.length;
  // `images` is a fresh array every parent render; key effects on content.
  const imagesKey = images.join("|");
  // Auto-advances survive hover/touch pauses, so the one lap is a total
  // across the visit, not restarted each time the pointer leaves.
  const ticks = useRef(0);
  useEffect(() => {
    setAt(0);
    ticks.current = 0;
  }, [resetKey]);
  // Makes exactly one full lap through the photos, then stops back on the
  // first rather than cycling forever.
  useEffect(() => {
    if (count <= 1 || paused || ticks.current >= count) return;
    const t = setInterval(() => {
      ticks.current += 1;
      setAt((i) => (i + 1) % count);
      if (ticks.current >= count) clearInterval(t);
    }, 3000);
    return () => clearInterval(t);
  }, [count, paused]);
  // Warm the decode cache for every slide so none paints late — at the same
  // resized rendition HeroSlide actually renders, not the full original.
  useEffect(() => {
    if (count <= 1) return;
    images.forEach((url) => {
      const img = new Image();
      img.src = wixThumbUrl(url, 1000, 360);
      img.decode?.().catch(() => {});
    });
  }, [imagesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = (d: number) => setAt((i) => (i + d + count) % count);
  return (
    <div
      className="relative overflow-hidden rounded-[18px]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={(e) => {
        if (count <= 1) return;
        touchStartX.current = e.touches[0].clientX;
        setPaused(true);
      }}
      onTouchEnd={(e) => {
        const startX = touchStartX.current;
        touchStartX.current = null;
        setPaused(false);
        if (startX == null || count <= 1) return;
        // A real swipe, not a tap that barely drifted — 40px is
        // comfortably past finger jitter on a phone.
        const deltaX = e.changedTouches[0].clientX - startX;
        if (deltaX <= -40) step(1);
        else if (deltaX >= 40) step(-1);
      }}
    >
      <div
        className="flex h-[305px] transition-transform duration-500 ease-out will-change-transform"
        style={{ transform: `translate3d(-${(at % count) * 100}%, 0, 0)` }}
      >
        {images.map((url, i) => (
          <HeroSlide key={url} url={url} alt={i === 0 ? title : ""} priority={i === 0} forceWhole={url === logoUrl} />
        ))}
      </div>
      {count > 1 && (
        <div className="absolute right-3 top-3 flex gap-2">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label="Previous photo"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white transition hover:bg-black/55"
          >
            <Icon name="chevron" className="h-4 w-4 rotate-180" />
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label="Next photo"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white transition hover:bg-black/55"
          >
            <Icon name="chevron" className="h-4 w-4" />
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => onOpen(at)}
        className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-white/95 px-3.5 py-2 text-[13px] font-bold text-baby-ink shadow-soft transition hover:bg-white"
      >
        <Icon name="open" className="h-3.5 w-3.5" />{" "}
        {count > 1 ? `${at + 1} / ${count}` : "View photo"}
      </button>
    </div>
  );
}, (a, b) => a.images.join("|") === b.images.join("|") && a.logoUrl === b.logoUrl && a.title === b.title && a.resetKey === b.resetKey && a.onOpen === b.onOpen);

/** A chat CTA that greys out — with the reason on hover — when messaging isn't
 *  available: either the parent is on Free, or the provider isn't integrated
 *  with BabyBrain so there's nothing to open. */
function ChatButton({
  icon,
  label,
  disabledReason,
  onOpen,
}: {
  icon: string;
  label: string;
  disabledReason: string | null;
  onOpen: () => void;
}) {
  if (disabledReason) {
    return (
      <span
        title={disabledReason}
        className="mt-3 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-[11px] border border-[#EBE3E5] bg-[#FAF7F7] px-6 py-3 text-[15px] font-extrabold leading-none text-[#6D7486]"
      >
        <Icon name={icon} className="h-4 w-4" /> {label} <Icon name="lock" className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <Button variant="blueOutline" className="mt-3 w-full" onClick={onOpen}>
      <Icon name={icon} className="h-4 w-4" /> {label}
    </Button>
  );
}

/** One of the direct-contact buttons (WhatsApp / Email / Website).
 *
 *  QA: "Inconsistencies on options on vendor page — Storytime Stretch doesn't
 *  have any of the comms buttons". Each button used to be rendered only when
 *  that provider happened to have that detail on file, so the panel changed
 *  shape from listing to listing. Every listing now shows the same three, and
 *  the ones we have no details for are visibly unavailable instead of absent. */
function ContactLink({
  icon,
  label,
  href,
  tone,
  unavailableReason,
}: {
  icon: string;
  label: string;
  href: string | null;
  tone: { border: string; text: string; hover: string };
  unavailableReason: string;
}) {
  // Three of these across the 295px rail needed 319px, so "Website" was being
  // clipped mid-word. A half-width floor makes them wrap two-up, with the odd
  // one growing to fill its own row.
  const base =
    "inline-flex min-w-[calc(50%-0.25rem)] flex-1 items-center justify-center gap-2 rounded-[11px] border bg-white px-3 py-2.5 text-[13px] font-extrabold leading-none transition";
  if (!href) {
    return (
      <span
        title={unavailableReason}
        className={`${base} cursor-not-allowed border-[#EBE3E5] bg-[#FAF7F7] text-[#6D7486]`}
      >
        <Icon name={icon} className="h-4 w-4" /> {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={`${base} ${tone.border} ${tone.text} ${tone.hover}`}
    >
      <Icon name={icon} className="h-4 w-4" /> {label}
    </a>
  );
}


export default function ActivityDetailPage() {
  const { activity, sessions, reviews, courseSpan, eventSoldOut, loading, sessionsLoading, reviewsLoading } = useActivityDetail(getParam("slug"));
  const fav = useFavorite(activity?.id);
  const { session } = useAuth();
  const { isPlus } = usePlan();
  const [enquiring, setEnquiring] = useState(false);
  const [groupChat, setGroupChat] = useState(false);
  /** Whether this parent holds a live booking on the activity — unlocks the class group chat. */
  const [hasBooking, setHasBooking] = useState(false);
  /** Shown when a free-plan parent taps "Save to favourites". */
  const [favUpgrade, setFavUpgrade] = useState(false);
  const [packs, setPacks] = useState<{ id: string; name: string; credits: number; price_cents: number; best_value: boolean }[]>([]);
  /** The pack tapped here; carried to the booking page as ?pack=, same idea as pickedSessionId below. */
  const [pickedPackId, setPickedPackId] = useState<string | null>(null);
  /** Index of the photo open in the lightbox, or null when it's closed. */
  const [galleryAt, setGalleryAt] = useState<number | null>(null);
  /** The session tapped in the schedule; carried to the booking page as ?session=. */
  const [pickedSessionId, setPickedSessionId] = useState<string | null>(null);

  /* The browser resolves the hash before Vite has mounted, and reviews arrive
     asynchronously after that, so #reviews (the post-activity check-in email's
     "leave a review" link — migration 00083) would land at the top of the page.
     Poll briefly for the target, then give up quietly. */
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    return scrollToWhenReady(id);
  }, []);

  /* The next session can carry its own venue (migration 00074) — resolve it
     so the sidebar's Location line reflects that session, not just the
     activity's default. Lazy: most classes run at one place. */
  const [nextVenue, setNextVenue] = useState<string | null>(null);
  useEffect(() => {
    const locId = sessions[0]?.location_id ?? null;
    if (!locId) { setNextVenue(null); return; }
    let cancelled = false;
    supabase
      .from("provider_locations")
      .select("name, address")
      .eq("id", locId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const row = data as { name: string | null; address: string | null } | null;
        setNextVenue(row ? [row.name, row.address].filter(Boolean).join(", ") : null);
      });
    return () => { cancelled = true; };
  }, [sessions]);

  useEffect(() => {
    if (!activity?.provider_id) return;
    const providerId = activity.provider_id;
    // Shared cache key with BookingPage's identical query (dashboard.tsx) —
    // Explore → listing → Book for the same provider fires this once, not twice.
    cacheFetch(`provider-packages:${providerId}`, 300_000, () =>
      supabase
        .from("packages")
        .select("id, name, credits, price_cents, activity_ids, starts_at, available_until, best_value")
        .eq("provider_id", providerId)
        .eq("active", true)
        .then(({ data }) => (data ?? []) as unknown as Array<{ id: string; name: string; credits: number; price_cents: number; activity_ids: string[] | null; starts_at: string | null; available_until: string | null; best_value: boolean }>)
    ).then((rows) => {
      setPacks(
        rows
          .filter((p) => !p.activity_ids || p.activity_ids.length === 0 || p.activity_ids.includes(activity.id))
          .filter(isPackOnSale),
      );
    });
  }, [activity?.provider_id, activity?.id]);

  // Hooks stay above the loading / not-found early returns below. This one
  // sat after them once, so the first render (loading) ran one hook fewer than
  // the loaded render and React threw "Rendered more hooks", blanking the page.
  useEffect(() => {
    if (!session || !activity?.id) { setHasBooking(false); return; }
    let live = true;
    supabase
      .from("bookings")
      .select("id, activity_sessions!inner(activity_id)")
      .eq("activity_sessions.activity_id", activity.id)
      .in("status", ["pending", "confirmed", "completed"])
      .limit(1)
      .then(({ data }) => { if (live) setHasBooking((data ?? []).length > 0); });
    return () => { live = false; };
  }, [session, activity?.id]);

  if (loading) {
    return (
      <PageShell active="/explore">
        <ActivityDetailSkeleton />
      </PageShell>
    );
  }
  if (!activity) {
    return (
      <PageShell active="/explore">
        <main className="mx-auto max-w-[1180px] px-6 py-16 text-center">
          <p className="text-xl font-black">Activity not found.</p>
          <a href={exploreReturnHref()} className="font-bold text-baby-pink">← Back to results</a>
        </main>
      </PageShell>
    );
  }
  /** Same URL as the "Book" CTA's href — reused by the "Book" link inline in the
   * selection-confirmation messages below, so tapping either takes the parent
   * to the same place. */
  const bookHref = `/book?slug=${activity.slug}${pickedSessionId ? `&session=${encodeURIComponent(pickedSessionId)}` : ""}${pickedPackId ? `&pack=${encodeURIComponent(pickedPackId)}` : ""}`;

  const next = sessions[0];
  const nextMins = next
    ? Math.round((new Date(next.ends_at).getTime() - new Date(next.starts_at).getTime()) / 60000)
    : null;
  // "Each session runs about N minutes" only makes sense for a single class; a
  // multi-day camp is one continuous occurrence and reads as days in the sidebar.
  const durationMins = next && !isMultiDay(next.starts_at, next.ends_at) ? nextMins : null;
  const multiDayNext = !!next && isMultiDay(next.starts_at, next.ends_at);
  // A course's run span — Wix's schedule bounds when known, else first/last
  // visible session (future-only, so it can understate a mid-run course).
  const courseRunRange =
    activity.wix_service_type === "COURSE" && sessions.length > 0
      ? sgDayRange(
          courseSpan?.start ?? sessions[0].starts_at,
          courseSpan?.end ??
            sessions.reduce(
              (m, s) => ((s.ends_at ?? s.starts_at) > m ? (s.ends_at ?? s.starts_at) : m),
              sessions[0].ends_at ?? sessions[0].starts_at
            )
        )
      : null;
  /* The sidebar summarises the next available class, so its price/venue are
     that session's when it overrides them (migration 00074), not the
     activity's defaults. Same session-first, activity-fallback resolution the
     booking page and booking trigger use. */
  const nextPrice = next?.price != null ? Number(next.price) : activity.price != null ? Number(activity.price) : null;
  // A private session at the customer's own home has no fixed address to
  // show here — unless this particular session was itself moved to a real
  // venue (nextVenue, a session-level override still allowed for one-off
  // exceptions), in which case that address wins as usual.
  const nextVenueAddress =
    nextVenue ??
    (activity.is_custom_location ? activity.custom_location_label?.trim() || "Custom" : activity.address) ??
    null;
  // Falls back to the provider's own cover/logo/gallery when this listing
  // has no photos of its own (or is explicitly set to borrow theirs) — see
  // activityMedia.ts. Recomputed on every load, so clearing an activity's
  // photos (or the provider's) shows up the next time this page is opened,
  // no separate sync step.
  const providerImages = resolveActivityImages(
    { image_urls: activity.image_urls, image_source: activity.image_source, cover_image_url: activity.cover_image_url },
    activity.provider_contact
  );
  const images = providerImages.length ? providerImages : [FALLBACK_LOGO_URL];
  // Whichever of the images above is the vendor's own logo (if any made the
  // cut) — never cropped in the hero, no matter its shape. See
  // providerLogoUrl in activityMedia.ts for why this is a URL comparison
  // rather than an aspect-ratio guess.
  const logoUrl = providerLogoUrl(activity.provider_contact);
  // Wix Events and Wix COURSEs have no BabyBrain waitlist (00107): a sold-out
  // event / a course with no dates left shows a disabled "Sold out" CTA
  // instead of sending the parent into a booking flow that can't complete.
  // Native and Wix CLASS activities keep the waitlist, so they are never
  // "sold out" here — a full slot still routes to Book.
  const soldOut =
    eventSoldOut || (activity.wix_service_type === "COURSE" && sessions.length === 0);

  // Messaging needs an integrated provider on Growth-and-above, and a Plus
  // subscription on the parent's side. Signed-out visitors still get a live
  // button — it sends them to log in.
  const chatBlockedReason = activity.external_booking_url
    ? "This provider takes bookings on their own site, so messaging isn't available here. Use the WhatsApp or email buttons to reach them."
    : !activity.provider_can_message
      ? "This provider hasn't enabled parent messaging yet. Use the WhatsApp or email buttons to reach them."
      : session && !isPlus
        ? "Messaging providers and other parents is a BabyBrain Plus feature."
        : null;
  const groupChatBlockedReason =
    chatBlockedReason ?? (session && !hasBooking
      ? "The class group chat unlocks once you've booked this class. You can still chat with the provider directly."
      : null);
  const requireLogin = (open: () => void) => () => {
    if (!session) goTo("/login");
    else open();
  };

  const whatsappNumber =
    activity.provider_contact?.whatsapp ?? activity.provider_contact?.contact_phone ?? null;
  // Scraped websites aren't consistently prefixed, and a bare "example.com"
  // href would resolve against our own origin.
  const rawWebsite = activity.provider_contact?.website?.trim() || null;
  const providerWebsite = rawWebsite
    ? /^https?:\/\//i.test(rawWebsite)
      ? rawWebsite
      : `https://${rawWebsite}`
    : null;

  return (
    <PageShell active="/explore">
      {galleryAt !== null && (
        <PhotoLightbox
          images={images}
          index={galleryAt}
          onClose={() => setGalleryAt(null)}
          onIndex={setGalleryAt}
        />
      )}
      {/* The booking rail is a page-level sidebar rather than a cell in the top
          row. It used to sit inside that row, so the row took the rail's full
          height and left a tall blank band under the title and hero before
          About started. On desktop it spans all three grid rows in column 2
          while the hero (row 1), About (row 2) and everything else (row 3)
          stack down column 1. On mobile the page is a plain flex column and
          `order` puts it right after About: hero, About, rail, then the
          sessions/packages/reviews block. */}
      <main className="mx-auto flex max-w-[1180px] flex-col gap-5 px-6 py-5 lg:grid lg:grid-cols-[1fr_295px] lg:items-start">
        <section className="order-1 grid min-w-0 grid-cols-1 gap-5 lg:order-none lg:col-start-1 lg:row-start-1 lg:grid-cols-[285px_1fr]">
          <div className="flex flex-col">
            <a href={exploreReturnHref()} className="font-bold text-baby-lilac">← Back to results</a>
            <div className="flex flex-1 flex-col justify-center">
              <h1 className="text-[29px] font-black">{activity.title}</h1>
              {activity.provider_name &&
                activity.provider_name.trim().toLowerCase() !== activity.title.trim().toLowerCase() && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-[14px] font-bold text-[#C7B1E6]">
                    <Icon name="store" className="h-4 w-4" /> {activity.provider_name}
                  </p>
                )}
              {activity.category_name && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {[activity.category_name, activity.category_name_2].filter((n): n is string => !!n).map((n) => (
                    <span key={n} className="inline-flex w-fit items-center gap-1 rounded-[9px] bg-[#FEEBF2] px-4 py-1.5 font-bold text-baby-cta"><Icon name="music" className="h-4 w-4" /> {n}</span>
                  ))}
                </div>
              )}
              {activity.rating_count > 0 && (
                <div className="mt-5 flex gap-5 font-bold"><span className="flex items-center gap-1"><Icon name="star" className="h-4 w-4 text-[#FFD77A]" /> {Number(activity.rating_avg).toFixed(1)} ({activity.rating_count})</span></div>
              )}
            </div>
          </div>
          <div>
            <HeroCarousel images={images} logoUrl={logoUrl} title={activity.title} resetKey={activity.id} onOpen={setGalleryAt} />
          </div>
        </section>

        {/* About sits on its own so on mobile it can come between the hero and
            the booking rail; on desktop it's just row 2 of column 1. */}
        <section className="order-2 rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card lg:order-none lg:col-start-1 lg:row-start-2">
          {/* Same idea as the images above: an activity with no "about" of
              its own borrows the provider's, rather than showing a blank
              section. */}
          <InfoBlock title="About" items={[activity.description?.trim() || activity.provider_contact?.description?.trim() || ""]} />
        </section>

        <div className="order-4 grid min-w-0 grid-cols-1 gap-5 lg:order-none lg:col-start-1 lg:row-start-3">
          {/* Per the mockup: Upcoming sessions and Packages sit side by side,
              then Reviews. With no packs to show, sessions takes the full
              width rather than leaving a half-empty row. */}
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <section className={`min-w-0 rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card${packs.length === 0 || activity.wix_service_type === "COURSE" ? " md:col-span-2" : ""}`}>
              <h2 className="mb-3 text-xl font-black">{activity.wix_service_type === "COURSE" ? "Course schedule" : "Upcoming sessions"}</h2>
              {activity.wix_service_type === "COURSE" && sessions.length > 0 ? (
                <>
                  <p className="mb-3 text-sm font-bold text-[#4a5685]">
                    Runs {courseRunRange} · one booking covers every session
                  </p>
                  <div className="space-y-2">
                    {courseStrands(sessions, courseSpan?.start).map((st) => (
                      <div key={st.key} className="rounded-[10px] border border-[#EBE3E5] px-3 py-2">
                        <p className="text-sm font-black text-[#34406f]">{st.label}</p>
                        <p className="mt-0.5 text-xs font-semibold text-[#68718f]">{st.range ? `${st.range} · ` : ""}{st.note}</p>
                      </div>
                    ))}
                  </div>
                </>
              ) : sessionsLoading ? (
                <div className="animate-pulse space-y-2">
                  <div className="h-14 rounded-[10px] bg-[#F4EFF0]" />
                  <div className="h-14 rounded-[10px] bg-[#F4EFF0]" />
                </div>
              ) : (
                sessions.length > 0 ? (
                  <SessionSchedule sessions={sessions} durationMins={durationMins} selectedId={pickedSessionId} onSelect={setPickedSessionId} bookHref={bookHref} />
                ) : (
                  <p className="text-sm font-semibold text-[#68718f]">No upcoming sessions scheduled.</p>
                )
              )}
            </section>

            {packs.length > 0 && activity.wix_service_type !== "COURSE" && (
              <section className="rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
                <h2 className="mb-3 text-xl font-black">Packages</h2>
                <div className="grid gap-3">
                  {packs.map((p) => {
                    const selected = pickedPackId === p.id;
                    return (
                      <div
                        key={p.id}
                        className={`flex items-center justify-between gap-3 rounded-[12px] border p-4 ${selected ? "border-[#A7D8F8] bg-[#EDF7FD]" : "border-[#EBE3E5]"}`}
                      >
                        <div>
                          <h3 className="font-black">{p.name}</h3>
                          <p className="text-sm font-semibold text-[#59658d]">{p.credits} classes · ${(p.price_cents / 100).toFixed(0)}</p>
                        </div>
                        {/* Picking a pack here no longer buys it — that used
                            to skip choosing a class/time and the provider's
                            terms entirely. It's carried to the booking page
                            (?pack=, same idea as pickedSessionId) where the
                            purchase actually goes through once a slot's
                            picked and terms are accepted. */}
                        {selected ? (
                          // Once picked, this isn't a call to action any more
                          // — the row's own blue border/tint already says
                          // "this one's chosen" — so the button steps back
                          // instead of staying the same loud pink CTA as
                          // "Select" (QA: the two read as identical at a
                          // glance). Same footprint as the button below, so
                          // nothing shifts when it flips between states.
                          // Matches the booking page's own selected-package
                          // badge (dashboard.tsx) rather than the pink CTA.
                          <span
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-[11px] border border-palette-blue bg-white px-4 py-2.5 text-[13px] font-extrabold text-palette-blueInk"
                          >
                            <Icon name="check" className="h-3.5 w-3.5" strokeWidth={3} /> Selected
                          </span>
                        ) : (
                          <Button
                            type="button"
                            variant="pink"
                            size="sm"
                            onClick={() => setPickedPackId(p.id)}
                          >
                            Select
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {pickedPackId && (
                  <p role="status" className="mt-3 flex items-center justify-between gap-3 rounded-[10px] bg-palette-pinkTint px-3 py-2 text-sm font-bold text-[#34406f]">
                    <span>Click on <a href={bookHref} className="underline underline-offset-2 hover:text-baby-cta">Book</a> to proceed with this purchase.</span>
                    <button type="button" onClick={() => setPickedPackId(null)} className="text-xs font-black text-[#68718f] underline underline-offset-2 hover:text-baby-cta">
                      Clear
                    </button>
                  </p>
                )}
              </section>
            )}
          </div>

          {/* `id` so the post-activity check-in email's "leave a review" link
              (/activity?slug=…#reviews, migration 00083) lands on the form. */}
          <section id="reviews" className="rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
            <h2 className="mb-3 text-xl font-black">Reviews ({activity.rating_count})</h2>
            <ReviewForm activityId={activity.id} />
            {reviewsLoading ? (
              <div className="animate-pulse space-y-3">
                <div className="h-10 rounded-[10px] bg-[#F4EFF0]" />
                <div className="h-10 rounded-[10px] bg-[#F4EFF0]" />
              </div>
            ) : (
              <>
                {reviews.map((r) => (
                  <div key={r.id} className="mb-3 border-b border-[#F4EFF0] pb-3">
                    <div className="flex gap-0.5 text-[#FFD77A]">{Array.from({ length: r.rating }).map((_, i) => <Icon key={i} name="star" className="h-3.5 w-3.5 fill-current" />)}</div>
                    {r.comment && <p className="mt-1 font-semibold text-[#34406f]">{r.comment}</p>}
                    <p className="mt-1 text-xs font-semibold text-[#6D748D]">A BabyBrain parent</p>
                    {r.provider_response && (
                      <div className="mt-2 rounded-[10px] bg-[#FFF5F8] p-3">
                        <p className="text-xs font-black text-baby-pink">Response from the provider</p>
                        <p className="mt-1 text-sm font-semibold text-[#34406f]">{r.provider_response}</p>
                      </div>
                    )}
                  </div>
                ))}
                {reviews.length === 0 && <p className="text-sm font-semibold text-[#68718f]">No reviews yet — be the first!</p>}
              </>
            )}
          </section>
        </div>
        <aside className="order-3 h-fit rounded-[18px] border border-[#EBE3E5] bg-white p-5 shadow-card lg:order-none lg:col-start-2 lg:row-span-3 lg:row-start-1">
            {nextPrice != null ? (
              nextPrice <= 0 ? (
                <p><strong className="text-[30px] text-baby-lilac">Free</strong></p>
              ) : (
                <p><strong className="text-[30px] text-baby-lilac">${nextPrice}</strong> <span className="font-bold">/ class</span></p>
              )
            ) : sessionsLoading ? (
              <div className="h-[30px] w-24 animate-pulse rounded-[6px] bg-[#F4EFF0]" />
            ) : (
              <>
                <p className="text-xl font-black text-baby-lilac">Price on enquiry</p>
                <p className="mt-1 text-sm font-semibold text-[#68718f]">
                  {activity.external_booking_url ? "See pricing on the provider's booking page." : "Contact the provider for pricing."}
                </p>
              </>
            )}
            {activity.external_booking_url ? (
              <a
                href={activity.external_booking_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[11px] bg-gradient-to-r from-[#fa4d8d] to-[#ff6b9b] px-6 py-3 text-[15px] font-extrabold text-white shadow-pink transition hover:brightness-105"
              >
                <Icon name="calendar" className="h-4 w-4" /> Book on provider's site
              </a>
            ) : sessionsLoading ? (
              <button
                type="button"
                disabled
                className="mt-4 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-[11px] border border-[#EBE3E5] bg-[#FAF7F7] px-6 py-3 text-[15px] font-extrabold leading-none text-[#6D7486]"
              >
                <Icon name="calendar" className="h-4 w-4" /> Checking availability…
              </button>
            ) : soldOut ? (
              <button
                type="button"
                disabled
                className="mt-4 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-[11px] border border-[#EBE3E5] bg-[#FAF7F7] px-6 py-3 text-[15px] font-extrabold leading-none text-[#6D7486]"
              >
                <Icon name="calendar" className="h-4 w-4" /> {activity.wix_service_type === "EVENT" ? "Sold out" : "Currently full"}
              </button>
            ) : (
              <Button
                href={bookHref}
                variant="pink"
                className="mt-4 w-full"
              ><Icon name="calendar" className="h-4 w-4" /> Book</Button>
            )}
            {/* Messaging is a Plus feature and needs an integrated provider:
                a listing that books on the provider's own site has no chat to
                open. The button is always present so the panel keeps the same
                shape — it greys out with the reason rather than disappearing. */}
            <ChatButton
              icon="mail"
              label="Chat with provider"
              disabledReason={
                activity.provider_id
                  ? chatBlockedReason
                  : "We don't have this provider on BabyBrain yet, so there's no chat to open."
              }
              onOpen={requireLogin(() => setEnquiring(true))}
            />
            {/* 1.4: direct click-through contact — the same three every time. */}
            <div className="mt-3 flex flex-wrap gap-2">
              <ContactLink
                icon="whatsapp"
                label="WhatsApp"
                href={
                  whatsappNumber
                    ? `https://wa.me/${phoneDigits(whatsappNumber)}`
                    : null
                }
                tone={{ border: "border-[#A8E59A]", text: "text-[#A8E59A]", hover: "hover:bg-[#F1FBEF]" }}
                unavailableReason="We don't have a WhatsApp number for this provider."
              />
              <ContactLink
                icon="mail"
                label="Email"
                href={
                  activity.provider_contact?.contact_email
                    ? `mailto:${activity.provider_contact.contact_email}?subject=${encodeURIComponent(`Enquiry about ${activity.title}`)}`
                    : null
                }
                tone={{ border: "border-[#A7D8F8]", text: "text-[#A7D8F8]", hover: "hover:bg-[#EDF7FD]" }}
                unavailableReason="We don't have an email address for this provider."
              />
              <ContactLink
                icon="open"
                label="Website"
                href={providerWebsite}
                tone={{ border: "border-[#C7B1E6]", text: "text-[#C7B1E6]", hover: "hover:bg-[#F4F0FA]" }}
                unavailableReason="We don't have a website for this provider."
              />
            </div>
            <ChatButton
              icon="people"
              label="Class group chat"
              disabledReason={groupChatBlockedReason}
              onOpen={requireLogin(() => setGroupChat(true))}
            />
            <Button
              variant="soft"
              type="button"
              onClick={() => fav.toggle().then((ok) => { if (!ok) setFavUpgrade(true); })}
              className="mt-3 w-full text-baby-pink"
            >
              <Icon name="heart" className="h-4 w-4" /> {fav.saved ? "Saved to favourites" : "Save to favourites"}
            </Button>
            {favUpgrade && <PlusFeatureDialog onClose={() => setFavUpgrade(false)} />}
            {enquiring && activity.provider_id && (
              <EnquiryChat
                providerId={activity.provider_id}
                providerName={activity.provider_name ?? activity.title}
                onClose={() => setEnquiring(false)}
              />
            )}
            {groupChat && (
              <ClassGroupChat
                activityId={activity.id}
                activityTitle={activity.title}
                onClose={() => setGroupChat(false)}
              />
            )}
            {/* QA: "Location on vendor pages at the bottom of the far right box
                is misaligned". These were floated spans, so a wrapping address
                dropped out of line with the label beside it. Flex rows keep the
                label and value on the same baseline however long the value. */}
            <div className="mt-5 space-y-4 border-t border-[#F4EFF0] pt-4 text-sm font-semibold">
              {nextVenueAddress && (
                <p className="flex items-start justify-between gap-3">
                  <strong className="shrink-0">Location</strong>
                  <span className="text-right">{nextVenueAddress}</span>
                </p>
              )}
              {next && (
                <p className="flex items-start justify-between gap-3">
                  <strong className="shrink-0">{activity.wix_service_type === "COURSE" ? "Runs" : "Next available class"}</strong>
                  <span className="text-right">
                    {activity.wix_service_type === "COURSE" && courseRunRange ? courseRunRange : sgDateTime(next.starts_at)}
                  </span>
                </p>
              )}
              {next?.capacity != null && (
                <p className="flex items-start justify-between gap-3">
                  <strong className="shrink-0">Spaces available</strong>
                  <span className="text-right text-[#A7D8F8]">{next.capacity > 0 ? `${next.capacity} spots` : "Sold out"}</span>
                </p>
              )}
              {/* A weekly course's sessions have no single "duration" worth showing, but a
                  multi-day camp's length in days is exactly what a parent wants. */}
              {nextMins != null && (activity.wix_service_type !== "COURSE" || multiDayNext) && formatDuration(nextMins) && (
                <p className="flex items-start justify-between gap-3">
                  <strong className="shrink-0">Duration</strong>
                  <span className="text-right">{formatDuration(nextMins)}</span>
                </p>
              )}
            </div>
        </aside>
      </main>
    </PageShell>
  );
}


function ReviewForm({ activityId }: { activityId: string }) {
  const { session } = useAuth();
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session) {
    return (
      <p className="mb-4 rounded-[10px] bg-[#EDF7FD] px-4 py-3 text-sm font-semibold text-[#59658d]">
        <a href="/login" className="font-black text-baby-pink">Log in</a> to leave a review.
      </p>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) return setError("Pick a star rating first.");
    setBusy(true);
    setError(null);
    // QA: "Should be able to leave a review even if haven't been booked onto a
    // class on the platform as may have been another time" — the
    // booked-and-attended requirement is gone from the RLS policy too.
    const { error } = await supabase.from("reviews").upsert(
      { user_id: session!.user.id, activity_id: activityId, rating, comment: comment.trim() || null },
      { onConflict: "user_id,activity_id" }
    );
    setBusy(false);
    if (error) return setError(error.message);
    window.location.reload();
  }

  return (
    <form onSubmit={submit} className="mb-5 rounded-[12px] border border-[#EBE3E5] bg-[#EDF7FD] p-4">
      <p className="mb-2 font-black">Write a review</p>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            onClick={() => setRating(n)}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
          >
            <Icon name="star" className={`h-7 w-7 ${(hover || rating) >= n ? "text-[#FFD77A] fill-current" : "text-[#DCD2D5]"}`} />
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={3}
        placeholder="Share how the class went (optional)"
        className="mt-3 w-full rounded-[10px] border border-[#FED7E4] px-3 py-2 text-sm font-semibold"
      />
      {error && <p className="mt-2 text-sm font-bold text-[#FFC1D6]">{error}</p>}
      <Button type="submit" variant="pink" className="mt-3">{busy ? "Posting…" : "Submit review"}</Button>
    </form>
  );
}

function InfoBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <article>
      <h3 className="mb-4 text-xl font-black text-baby-lilac">{title}</h3>
      <div className="space-y-2 text-sm font-semibold leading-5 text-[#3e4976]">
        {items.map((item) => <p key={item}>{item}</p>)}
      </div>
    </article>
  );
}

/** Best-effort synchronous check for a stored Supabase session, so the root
 *  route can tell a returning parent (wait on a loader) from a genuine visitor
 *  (show the marketing page straight away) before auth has resolved.
 *  Checks this app's own storage key only — see the comment on
 *  AUTH_STORAGE_KEY in lib/supabase.ts for why a broader `sb-*-auth-token`
 *  scan used to also pick up a vendor-only session on the same origin. */
