import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityRow,
  Button,
  DateInput,
  Footer,
  Icon,
  PageShell,
  SearchBox,
  Spinner,
} from "../components/ui";
import { SelectField, Opt } from "../components/SelectField";
import { ActivityRowListSkeleton } from "../components/Skeletons";
import { AGE_BANDS, categories } from "../data/content";
import { useActivities, useActivityPins, useFacetCounts } from "../lib/useActivities";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { RainbowLoader } from "../components/RainbowLoader";
import { goTo, getParam, rememberExploreUrl } from "../lib/nav";
import { lazyRoute } from "../lib/lazyRoute";
import { Chip, REGION_FILTERS } from "./prefChips";

/** Trails `value` by `delay`ms of no further change — for gating an
 *  expensive derived computation (a filter/sort recompute here) behind a
 *  fast-changing input (a drag slider) without holding back the input's own
 *  on-screen value, which should stay instant. */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// leaflet (the Explore map only) stays out of the entry bundle — loaded the
// first time the map is shown.
const ExploreMap = lazyRoute(
  () => import("../components/ExploreMap").then((m) => ({ default: m.ExploreMap })),
  "ExploreMap"
);

/** Same centroids as `sg_region()` in migration 00032, for parents who deny
 *  (or don't have) precise geolocation — picking an area beats no sort at all. */
const REGION_CENTROIDS: Record<string, { lat: number; lng: number }> = {
  central: { lat: 1.300, lng: 103.830 },
  east: { lat: 1.335, lng: 103.940 },
  "north-east": { lat: 1.385, lng: 103.895 },
  north: { lat: 1.430, lng: 103.820 },
  west: { lat: 1.335, lng: 103.720 },
  sentosa: { lat: 1.2494, lng: 103.8303 },
};
const PRICE_MAX = 200; // slider ceiling; at the ceiling the price filter is "Any".
const timeLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;

const LEAD_KEY = "bb_lead_captured";


/** One-time email-capture modal shown when a visitor starts exploring. Skipped
 *  for signed-in users (we already have their email) and once dismissed or
 *  submitted (remembered in localStorage). Leads land in the `leads` table. */
function EmailCapturePopup() {
  const { session, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || session) return;
    if (localStorage.getItem(LEAD_KEY)) return;
    const t = setTimeout(() => setOpen(true), 1200);
    return () => clearTimeout(t);
  }, [loading, session]);

  function dismiss() {
    localStorage.setItem(LEAD_KEY, "dismissed");
    setOpen(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError("Please enter a valid email."); return; }
    setBusy(true); setError(null);
    const { error } = await supabase.from("leads").insert({ email, source: "explore-popup" });
    setBusy(false);
    if (error) { setError("Something went wrong — please try again."); return; }
    localStorage.setItem(LEAD_KEY, "submitted");
    setDone(true);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={dismiss}>
      <div className="w-full max-w-md rounded-[20px] bg-white p-7 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={dismiss} aria-label="Close" className="float-right -mr-1 -mt-1 text-[#6D7488] hover:text-[#3a4468]">
          <Icon name="close" className="h-5 w-5" />
        </button>
        {done ? (
          <div className="py-4 text-center">
            <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-[#F1FBEF] text-[#A8E59A]"><Icon name="check" className="h-8 w-8" /></div>
            <h2 className="text-xl font-black">You're in! 🎉</h2>
            <p className="mt-2 text-sm font-semibold text-[#59658d]">Enjoy discovering activities for your family.</p>
            <Button className="mt-5 w-full" onClick={dismiss}>Start exploring</Button>
          </div>
        ) : (
          <>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-[#FED7E4] px-3 py-1.5 text-xs font-bold text-baby-cta"><Icon name="heart" className="h-3.5 w-3.5" /> Made for your family</div>
            <h2 className="text-2xl font-black leading-tight">Explore activities for your little one</h2>
            <p className="mt-2 text-sm font-semibold leading-6 text-[#59658d]">Pop in your email to find classes, playspaces, holiday camps and more that meet your exact needs.</p>
            <form onSubmit={submit} className="mt-5 space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                autoFocus
                className="h-12 w-full rounded-[12px] border border-[#EBE3E5] px-4 font-semibold shadow-card focus:border-baby-pink focus:outline-none"
              />
              {error && <p className="text-sm font-semibold text-baby-pink">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy}>{busy ? "Saving…" : "Get started"}</Button>
            </form>
            <button type="button" onClick={dismiss} className="mt-3 w-full text-center text-xs font-bold text-[#6E748D] hover:text-[#59658d]">Maybe later</button>
          </>
        )}
      </div>
    </div>
  );
}

/** A row of multi-select filter chips with an "all" reset at the front. */
function ChipFilter({
  label,
  allLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  allLabel: string;
  options: { key: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div>
      {label && <p className="mb-1.5 text-xs font-bold text-[#68718f]">{label}</p>}
      <div className="flex flex-wrap gap-2">
        <Chip on={selected.length === 0} onClick={() => onChange([])}>{allLabel}</Chip>
        {options.map((o) => (
          <Chip
            key={o.key}
            on={selected.includes(o.key)}
            onClick={() =>
              onChange(
                selected.includes(o.key)
                  ? selected.filter((k) => k !== o.key)
                  : [...selected, o.key]
              )
            }
          >
            {o.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/* ---- Mobile filter sheets (Explore) ---------------------------------------
   Type, age and area used to be the same row of outlined pills. These give
   each its own shape, and show how many activities an option would return. */

const CATEGORY_ICON: Record<string, string> = {
  music: "catMusic",
  "sensory-play": "catArt",
  movement: "catSport",
  swimming: "catSwim",
  "early-learning": "catLearn",
  "parent-baby": "catBaby",
  playspaces: "catPlay",
  "community-events": "catEvent",
  "holiday-camps": "catCamp",
};

const optionOn = "border-baby-pink bg-[#FED7E4] text-baby-cta";
const optionOff = "border-[#DCD2D5] bg-white text-[#111A4C]";

/** Multi-select tiles, one per activity type. No selection means "all". */
function TypeTiles({
  options, selected, counts, onChange,
}: {
  options: { key: string; label: string }[];
  selected: string[];
  counts: Record<string, number> | undefined;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {options.map((o) => {
        const on = selected.includes(o.key);
        const n = counts ? counts[o.key] ?? 0 : undefined;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? selected.filter((k) => k !== o.key) : [...selected, o.key])}
            className={`flex min-h-[92px] flex-col items-center justify-center gap-1 rounded-[12px] border px-1.5 py-2 text-center text-[11px] font-bold leading-tight ${
              on ? "border-baby-pink bg-[#FEF1F6] text-baby-cta" : optionOff
            } ${!on && n === 0 ? "opacity-40" : ""}`}
          >
            <Icon name={CATEGORY_ICON[o.key] ?? "spark"} className={`h-6 w-6 ${on ? "text-baby-pink" : "text-[#8A90A2]"}`} strokeWidth={1.7} />
            <span>{o.label}</span>
            {n != null && <span className="text-[10px] font-semibold text-[#8A90A2]">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** What each area covers, taken from the postal sectors sg_region() maps to it
 *  (migration 00032) so the hints can't promise somewhere it doesn't. */
const AREA_HINTS: Record<string, string> = {
  central: "Raffles Place, Queenstown, Novena",
  east: "Geylang, Tampines, Pasir Ris, Changi",
  "north-east": "Hougang, Bishan, Ang Mo Kio, Punggol",
  north: "Woodlands, Yishun, Kranji",
  west: "Clementi, Jurong, Bukit Timah",
  sentosa: "Sentosa Island",
  custom: "as defined by you",
};

/** Private/at-home sessions with no fixed region (see migration 00175) get
 *  their own pseudo-area alongside the real ones — added here, not to
 *  REGION_FILTERS itself, since that list is shared with the onboarding/
 *  profile "preferred region" pickers, where "Custom location" makes no
 *  sense as a home-region preference. */
const AREA_FILTER_OPTIONS = [
  ...REGION_FILTERS.map(([k, l]) => ({ key: k, label: l })),
  { key: "custom", label: "Custom location" },
];

function AreaCards({
  options, selected, counts, onChange,
}: {
  options: { key: string; label: string }[];
  selected: string[];
  counts: Record<string, number> | undefined;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((o) => {
        const on = selected.includes(o.key);
        const n = counts ? counts[o.key] ?? 0 : undefined;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? selected.filter((k) => k !== o.key) : [...selected, o.key])}
            className={`rounded-[12px] border p-3 text-left ${on ? optionOn : optionOff} ${!on && n === 0 ? "opacity-40" : ""}`}
          >
            <span className="flex items-baseline justify-between gap-2 text-[13px] font-black">
              {o.label}
              {n != null && <span className="text-[12px] font-bold text-baby-pink">{n}</span>}
            </span>
            <span className="mt-0.5 block text-[11px] font-semibold leading-snug text-[#8A90A2]">{AREA_HINTS[o.key]}</span>
          </button>
        );
      })}
    </div>
  );
}

/* The age bands are five fixed steps (AGE_BANDS), so the track has six stops —
   the lower edge of each band plus the top — and a selection is a contiguous
   run of bands. Anything already picked that isn't contiguous (the desktop
   chips allow it) is shown as the span that covers it. */
const AGE_STOP_LABELS = ["0", "6m", "12m", "18m", "3y", "3y+"];
const AGE_FROM = ["0 months", "6 months", "12 months", "18 months", "3 years"];
const AGE_TO = ["", "6 months", "12 months", "18 months", "3 years"];
const AGE_SHORTCUTS: [string, number, number][] = [
  ["Newborn", 0, 1],
  ["Baby", 1, 3],
  ["Toddler", 3, 4],
  ["Over 3", 4, 5],
];

function ageRangeText(lo: number, hi: number) {
  if (lo === 0 && hi === 5) return "All ages";
  if (lo === 0) return `Up to ${AGE_TO[hi]}`;
  if (hi === 5) return `${AGE_FROM[lo]} and over`;
  return `${AGE_FROM[lo]} – ${AGE_TO[hi]}`;
}

function AgeTrack({ ages, onChange }: { ages: string[]; onChange: (next: string[]) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"lo" | "hi" | null>(null);
  const idx = ages.map((k) => AGE_BANDS.findIndex((b) => b.key === k)).filter((i) => i >= 0);
  const lo = idx.length ? Math.min(...idx) : 0;
  const hi = idx.length ? Math.max(...idx) + 1 : 5;
  const last = AGE_BANDS.length; // 5

  const commit = (nlo: number, nhi: number) =>
    onChange(nlo === 0 && nhi === last ? [] : AGE_BANDS.slice(nlo, nhi).map((b) => b.key));
  const stopAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * last);
  };
  const move = (thumb: "lo" | "hi", stop: number) => {
    if (thumb === "lo") commit(Math.min(stop, hi - 1), hi);
    else commit(lo, Math.max(stop, lo + 1));
  };
  const key = (thumb: "lo" | "hi") => (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    move(thumb, Math.min(last, Math.max(0, (thumb === "lo" ? lo : hi) + step)));
  };
  const pct = (i: number) => `${(i / last) * 100}%`;

  return (
    <div>
      <div className="mb-5 text-center">
        <div className="text-[11px] font-bold text-[#8A90A2]">Showing activities for</div>
        <div className="text-[17px] font-black text-[#111A4C]">{ageRangeText(lo, hi)}</div>
      </div>

      <div className="px-3">
        <div
          ref={trackRef}
          className="relative h-10 touch-none select-none"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const s = stopAt(e.clientX);
            dragging.current = s <= lo ? "lo" : s >= hi ? "hi" : Math.abs(s - lo) <= Math.abs(s - hi) ? "lo" : "hi";
            move(dragging.current, s);
          }}
          onPointerMove={(e) => { if (dragging.current) move(dragging.current, stopAt(e.clientX)); }}
          onPointerUp={() => { dragging.current = null; }}
          onPointerCancel={() => { dragging.current = null; }}
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[#EBE3E5]" />
          <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-baby-pink" style={{ left: pct(lo), width: `${((hi - lo) / last) * 100}%` }} />
          {AGE_STOP_LABELS.map((_, i) => (
            <span
              key={i}
              className={`absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${i >= lo && i <= hi ? "bg-white" : "bg-[#D9D0D4]"}`}
              style={{ left: pct(i) }}
            />
          ))}
          {(["lo", "hi"] as const).map((t) => (
            <span
              key={t}
              role="slider"
              tabIndex={0}
              aria-label={t === "lo" ? "Youngest age" : "Oldest age"}
              aria-valuemin={0}
              aria-valuemax={last}
              aria-valuenow={t === "lo" ? lo : hi}
              aria-valuetext={t === "lo" ? AGE_FROM[lo] : hi === last ? "and over" : AGE_TO[hi]}
              onKeyDown={key(t)}
              className="absolute top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-baby-pink bg-white shadow-card outline-none focus-visible:ring-2 focus-visible:ring-baby-pink/40"
              style={{ left: pct(t === "lo" ? lo : hi) }}
            />
          ))}
        </div>
        <div className="relative mt-1 h-4 text-[10px] font-bold text-[#8A90A2]">
          {AGE_STOP_LABELS.map((l, i) => (
            <span key={i} className="absolute -translate-x-1/2" style={{ left: pct(i) }}>{l}</span>
          ))}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {AGE_SHORTCUTS.map(([label, a, b]) => {
          const on = lo === a && hi === b && idx.length > 0;
          return (
            <button
              key={label}
              type="button"
              aria-pressed={on}
              onClick={() => (on ? onChange([]) : commit(a, b))}
              className={`rounded-full border px-3.5 py-2 text-xs font-bold ${on ? optionOn : optionOff}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* Time of day as named parts of the day over the existing hour range. Picking
   several stretches the range across them (Morning + Evening is the whole
   day), which is all a single from–to range can express. */
const TIME_BUCKETS = [
  { key: "morning", label: "Morning", min: 0, max: 11 },
  { key: "midday", label: "Midday", min: 12, max: 13 },
  { key: "afternoon", label: "Afternoon", min: 14, max: 16 },
  { key: "evening", label: "Evening", min: 17, max: 23 },
];

function toggleTimeBucket(i: number, range: [number, number], active: boolean): [number, number] {
  const covered = active
    ? TIME_BUCKETS.map((b, k) => (range[0] <= b.min && range[1] >= b.max ? k : -1)).filter((k) => k >= 0)
    : [];
  const next = covered.includes(i) ? covered.filter((k) => k !== i) : [...covered, i];
  if (!next.length) return [0, 23];
  return [TIME_BUCKETS[Math.min(...next)].min, TIME_BUCKETS[Math.max(...next)].max];
}

const sgDateKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });
const shiftDateKey = (key: string, days: number) => {
  const d = new Date(`${key}T00:00:00+08:00`);
  d.setDate(d.getDate() + days);
  return sgDateKey(d);
};
/** [from, to] for each quick date pick, in Singapore calendar days. */
function datePresets(): { key: string; label: string; from: string; to: string }[] {
  const today = sgDateKey(new Date());
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sun … 6 = Sat
  const sat = dow === 0 ? today : shiftDateKey(today, 6 - dow);
  return [
    { key: "today", label: "Today", from: today, to: today },
    { key: "weekend", label: "This weekend", from: dow === 0 ? today : sat, to: dow === 0 ? today : shiftDateKey(sat, 1) },
    { key: "week", label: "Next 7 days", from: today, to: shiftDateKey(today, 6) },
  ];
}


export default function ExplorePage() {
  // "Top rated" and "Most popular" read the same to parents, so popularity now
  // covers both; the other two sorts are the ones QA asked for.
  const [sort, setSort] = useState<"popular" | "distance" | "soonest" | "price_asc" | "price_desc">("popular");
  // Seed every filter from the query string — home-page tiles, header search
  // and category emails only ever set `cat`/`age` (still a single value
  // there), but this is also how a parent's own filter picks survive leaving
  // for an activity page and coming back: the sync effect below keeps the
  // address bar in step with every filter as it changes, so a fresh mount
  // (returning via "back to results" or the browser's own back button) reads
  // the same filters straight back out instead of resetting to nothing.
  const [categories_, setCategories] = useState<string[]>(() => {
    const c = getParam("cat");
    return c ? c.split(",").filter(Boolean) : [];
  });
  const [ages, setAges] = useState<string[]>(() => {
    const a = getParam("age");
    if (!a) return [];
    // Home tiles pass a band key; older emails pass ?age=<months>.
    return [...new Set(
      a.split(",").filter(Boolean).flatMap((v) => {
        if (AGE_BANDS.some((b) => b.key === v)) return [v];
        const band = AGE_BANDS.find((b) => Number(v) >= b.min && Number(v) <= b.max);
        return band ? [band.key] : [];
      })
    )];
  });
  const [regions, setRegions] = useState<string[]>(() => {
    const r = getParam("region");
    return r ? r.split(",").filter(Boolean) : [];
  });
  const [cats, setCats] = useState<{ slug: string; name: string }[]>([]);
  const [dateFrom, setDateFrom] = useState(() => getParam("from") || "");
  // Upper bound for the "Today / This weekend / Next 7 days" quick picks.
  // Empty means open-ended, which is all the desktop "Date from" box ever sets.
  const [dateTo, setDateTo] = useState(() => getParam("to") || "");
  const [pickingDate, setPickingDate] = useState(false);
  const [timeRange, setTimeRange] = useState<[number, number]>(() => {
    const min = getParam("timeMin");
    const max = getParam("timeMax");
    return [min ? Number(min) : 0, max ? Number(max) : 23];
  });
  const [maxPrice, setMaxPrice] = useState(() => {
    const p = getParam("price");
    return p ? Number(p) : PRICE_MAX;
  });
  const [showMore, setShowMore] = useState(false);
  const [mobileSheet, setMobileSheet] = useState<null | "type" | "age" | "area" | "sort">(null);
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  // Set only when `here` came from the "pick your area" fallback, not a real
  // fix. Distance-to-a-single-centroid interleaves border listings of the next
  // area with far-corner ones of your own; QA wants the whole area first, then
  // the next-closest. So with an area pick we rank by area before distance.
  const [herePickedArea, setHerePickedArea] = useState<string | null>(null);
  const query = getParam("q");
  // First page size for cards — the map and facet counts aren't paginated
  // (see useActivityPins/useFacetCounts), only the card list is.
  const PAGE = 50;

  const [minH, maxH] = timeRange;
  const priceActive = maxPrice < PRICE_MAX;
  const timeActive = minH > 0 || maxH < 23;
  const anyFilter =
    categories_.length > 0 || ages.length > 0 || regions.length > 0 ||
    !!dateFrom || !!dateTo || priceActive || timeActive;

  // The price/time sliders fire onChange continuously while dragging — the
  // label above each ("Up to $X" / a time range) tracks that live, but what
  // actually drives the fetched list is debounced so a drag doesn't fire a
  // request on every pixel of movement, only once motion settles.
  const debouncedMaxPrice = useDebouncedValue(maxPrice, 120);
  const debouncedTimeRange = useDebouncedValue(timeRange, 120);
  const [debouncedMinH, debouncedMaxH] = debouncedTimeRange;
  const debouncedPriceActive = debouncedMaxPrice < PRICE_MAX;
  const debouncedTimeActive = debouncedMinH > 0 || debouncedMaxH < 23;

  // AgeTrack keeps a multi-band pick collapsed to one contiguous span, so the
  // selected bands reduce to a single min/max range for the server filter.
  const selectedAgeBands = AGE_BANDS.filter((b) => ages.includes(b.key));
  const ageMinMonths = selectedAgeBands.length ? Math.min(...selectedAgeBands.map((b) => b.min)) : null;
  const ageMaxMonths = selectedAgeBands.length ? Math.max(...selectedAgeBands.map((b) => b.max)) : null;

  // Filtering, pagination and facet counts all happen server-side now (see
  // search_activities / matching_activities / search_activity_facets,
  // migration 00166) — this hook only ever holds the pages actually loaded,
  // not the whole catalog.
  const filterParams = {
    query: query || null,
    categories: categories_,
    ageMinMonths,
    ageMaxMonths,
    regions,
    maxPrice: debouncedPriceActive ? debouncedMaxPrice : null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    timeMin: debouncedTimeActive ? debouncedMinH : null,
    timeMax: debouncedTimeActive ? debouncedMaxH : null,
    sort:
      sort === "distance" ? "distance" as const
      : sort === "price_asc" ? "price_asc" as const
      : sort === "price_desc" ? "price_desc" as const
      : "popular" as const,
    limit: PAGE,
  };
  const { activities, total, loading, loadingMore, hasMore, loadMore } = useActivities(filterParams);
  // The map needs every matching pin, not just the loaded cards.
  const { activities: pinActivities, loading: pinsLoading } = useActivityPins(filterParams);
  const facetCounts = useFacetCounts(filterParams, !!mobileSheet);

  // The chosen sort wins outright. Instant-book listings used to be pinned
  // above everything regardless, so picking "Nearest" changed nothing and QA
  // saw a class 30 minutes away above ones within 10. Instant book now only
  // breaks ties, which still keeps it first under the default "Most popular".
  //
  // With no precise location (the "pick your area" fallback), rank by area
  // first — the whole chosen area, then the next-closest area, and so on —
  // then by point distance within an area. Sorting purely by distance to the
  // area's centre otherwise slots border listings of the neighbouring area
  // ahead of far-corner ones of your own (QA). This is display-order polish
  // on top of the server's own ordering, so it stays client-side — it only
  // needs to reorder what's already loaded, not the whole matching set.
  const shown = useMemo(() => {
    const areaOrder = sort === "distance" && herePickedArea ? regionsByProximity(herePickedArea) : null;
    return [...activities].sort((x, y) => {
      if (sort === "soonest") {
        const ax = x.nextSessionAt ? Date.parse(x.nextSessionAt) : Infinity;
        const ay = y.nextSessionAt ? Date.parse(y.nextSessionAt) : Infinity;
        if (ax !== ay) return ax - ay;
      }
      if (sort === "distance" && here) {
        if (areaOrder) {
          const rx = areaRank(x, areaOrder);
          const ry = areaRank(y, areaOrder);
          if (rx !== ry) return rx - ry;
        }
        const dx = distanceFrom(here, x);
        const dy = distanceFrom(here, y);
        if (dx !== dy) return dx - dy;
      }
      if (x.instantBook !== y.instantBook) return x.instantBook ? -1 : 1;
      return 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities, sort, herePickedArea, here]);

  function resetFilters() {
    setCategories([]); setAges([]); setRegions([]);
    setDateFrom(""); setDateTo(""); setPickingDate(false); setTimeRange([0, 23]); setMaxPrice(PRICE_MAX);
  }

  // Keeps the address bar (and, via rememberExploreUrl, the "back to
  // results" link on the activity page) in step with every filter — plain
  // history.replaceState rather than goTo, since this fires on every filter
  // tweak (including mid-drag on the price/time sliders) and goTo's
  // scroll-to-top would otherwise yank the page up on each one. Nothing else
  // needs to react to this URL, so it deliberately skips goTo's pushState
  // and location-change broadcast too.
  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (categories_.length) params.set("cat", categories_.join(","));
    if (ages.length) params.set("age", ages.join(","));
    if (regions.length) params.set("region", regions.join(","));
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    if (timeActive) { params.set("timeMin", String(minH)); params.set("timeMax", String(maxH)); }
    if (priceActive) params.set("price", String(maxPrice));
    if (sort !== "popular") params.set("sort", sort);
    const search = params.toString();
    const url = `${window.location.pathname}${search ? `?${search}` : ""}`;
    window.history.replaceState({}, "", url);
    rememberExploreUrl(search ? `?${search}` : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, categories_, ages, regions, dateFrom, dateTo, minH, maxH, timeActive, maxPrice, priceActive, sort]);

  useEffect(() => {
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
  }, []);

  // Sorting by distance needs a location; ask only when it's chosen. If the
  // browser won't give one (denied, or no geolocation at all), fall back to the
  // postcode the parent gave us, so "Nearest" still does something sensible.
  useEffect(() => {
    if (sort !== "distance" || here) return;
    let cancelled = false;
    const locateFromProfile = async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user || cancelled) return;
      const { data: p } = await supabase
        .from("parent_profiles")
        .select("latitude, longitude")
        .eq("id", data.user.id)
        .maybeSingle();
      if (!cancelled && p?.latitude != null && p?.longitude != null) {
        setHere({ lat: p.latitude, lng: p.longitude });
        setHerePickedArea(null);
      }
    };
    if (!navigator.geolocation) {
      void locateFromProfile();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setHerePickedArea(null);
      },
      () => void locateFromProfile(),
      { timeout: 8000 }
    );
    return () => {
      cancelled = true;
    };
  }, [sort, here]);

  const selectClass = "h-10 rounded-[10px] border border-[#EBE3E5] bg-white px-3 text-[13px] font-bold shadow-card focus:border-baby-pink focus:outline-none";
  // The map's own pin set — every match, not just the loaded cards.
  const pinned = pinActivities.filter((a) => a.venues.length > 0 || a.lat != null).length;

  return (
    <PageShell active="/explore">
      <EmailCapturePopup />
      <main className="mx-auto max-w-[1180px] px-4 pt-5 pb-24 sm:px-6 sm:py-5">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-[28px] font-black text-baby-green sm:text-[34px]">Explore activities <Icon name="search" className="inline h-6 w-6 text-baby-green" /></h1>
            {/* "Clear all filters" always sits on its own line right below
                the description, rather than joining it when the text is
                short (e.g. a search query) and only wrapping down when it's
                long (the default "Browse activities..." copy) — that made
                its position jump depending on which description was shown. */}
            <p className="mt-1 text-base font-semibold text-[#4a5680] sm:text-lg">
              {query ? <>Results for “{query}”. <a href="/explore" className="font-black text-baby-pink">Clear search</a></> : "Browse activities across Singapore."}
            </p>
            {anyFilter && (
              <button type="button" onClick={resetFilters} className="mt-1 text-sm font-black text-baby-pink hover:underline sm:text-base">
                Clear all filters
              </button>
            )}
          </div>
          <img src={`${import.meta.env.BASE_URL}assets/crops/explore-skyline.png`} alt="" className="hidden h-24 object-contain md:block lg:h-28" />
        </div>

        {/* Mobile/tablet search — desktop already has one in the header nav.
            Sticky just under the header so it's still reachable once the map
            and cards have scrolled past, without duplicating the hamburger's
            own search. */}
        <div className="sticky top-[74px] z-20 -mx-4 mb-4 bg-baby-paper px-4 py-2 sm:-mx-6 sm:px-6 lg:hidden">
          <SearchBox />
        </div>

        <div className="fixed inset-x-0 bottom-0 z-30 px-3 [transform:translateZ(0)] sm:hidden" style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
          <div className="mx-auto flex max-w-[420px] items-center gap-1 rounded-full border border-[#F0E4D8] bg-baby-paper p-1 shadow-[0_10px_24px_rgba(33,29,32,0.16)]">
            {(
              [
                { key: "type", label: "Type", icon: "target", active: categories_.length > 0 },
                { key: "age", label: "Age", icon: "people", active: ages.length > 0 },
                { key: "area", label: "Area", icon: "compass", active: regions.length > 0 },
                { key: "sort", label: "More", icon: "funnel", active: sort !== "popular" || priceActive || timeActive || !!dateFrom || !!dateTo },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setMobileSheet(t.key)}
                className="flex flex-1 flex-col items-center justify-center gap-0 py-0.5 text-[12px] font-bold leading-none"
              >
                <span className={t.active ? "grid h-[35px] w-[35px] place-items-center rounded-full bg-gradient-to-r from-[#fa4d8d] to-[#ff6b9b] shadow-pink" : "grid h-[35px] w-[35px] place-items-center"}>
                  <Icon name={t.icon} className={t.active ? "h-5 w-5 text-white" : "h-6 w-6 text-[#4a5680]"} />
                </span>
                <span className={`block leading-none ${t.active ? "text-baby-cta" : "text-[#4a5680]"}`}>{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        {mobileSheet && (
          <div className="fixed inset-0 z-40 sm:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setMobileSheet(null)} />
            <div className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-[20px] bg-white p-4 shadow-card" style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-base font-black">
                  {mobileSheet === "type" ? "Type of activity" : mobileSheet === "age" ? "Age" : mobileSheet === "area" ? "Area" : "Sort & more filters"}
                </h3>
                <div className="flex items-center gap-4">
                  {(mobileSheet === "type" ? categories_.length > 0
                    : mobileSheet === "age" ? ages.length > 0
                    : mobileSheet === "area" ? regions.length > 0
                    : sort !== "popular" || !!dateFrom || !!dateTo || priceActive || timeActive) && (
                    <button
                      type="button"
                      onClick={() => {
                        if (mobileSheet === "type") setCategories([]);
                        else if (mobileSheet === "age") setAges([]);
                        else if (mobileSheet === "area") setRegions([]);
                        else {
                          setSort("popular");
                          setDateFrom(""); setDateTo(""); setPickingDate(false);
                          setTimeRange([0, 23]); setMaxPrice(PRICE_MAX);
                        }
                      }}
                      className="text-xs font-bold text-baby-pink hover:underline"
                    >
                      {mobileSheet === "sort" ? "Reset" : "Clear"}
                    </button>
                  )}
                  <button type="button" onClick={() => setMobileSheet(null)} aria-label="Close">
                    <Icon name="close" className="h-5 w-5 text-[#4a5680]" />
                  </button>
                </div>
              </div>

              {mobileSheet === "type" && (
                <TypeTiles
                  options={cats.map((c) => ({ key: c.slug, label: c.name }))}
                  selected={categories_}
                  counts={facetCounts?.type}
                  onChange={setCategories}
                />
              )}
              {mobileSheet === "age" && <AgeTrack ages={ages} onChange={setAges} />}
              {mobileSheet === "area" && (
                <AreaCards
                  options={AREA_FILTER_OPTIONS}
                  selected={regions}
                  counts={facetCounts?.area}
                  onChange={setRegions}
                />
              )}
              {mobileSheet === "sort" && (
                <div className="space-y-5">
                  <div>
                    <p className="mb-2 text-xs font-bold text-[#68718f]">Sort by</p>
                    <div className="flex flex-wrap gap-2">
                      {([["popular", "Most popular"], ["distance", "Nearest"], ["soonest", "Starting soonest"], ["price_asc", "Price: low to high"], ["price_desc", "Price: high to low"]] as const).map(([v, l]) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={sort === v}
                          onClick={() => setSort(v)}
                          className={`rounded-full border px-3.5 py-2 text-xs font-bold ${sort === v ? optionOn : optionOff}`}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  {sort === "distance" && !here && (
                    <p className="flex flex-wrap items-center gap-2 rounded-[10px] bg-[#FFF5F8] px-3 py-2 text-xs font-semibold text-[#68718f]">
                      <span>Allow location access to sort by how near activities are to you, or</span>
                      <SelectField
                        value=""
                        placeholder="pick your area"
                        aria-label="Pick your area"
                        onChange={(v) => {
                          const centroid = REGION_CENTROIDS[v];
                          if (centroid) { setHere(centroid); setHerePickedArea(v); }
                        }}
                        className="h-7 px-2 text-xs font-bold text-[#4a5680]"
                      >
                        {REGION_FILTERS.map(([v, l]) => (
                          <Opt key={v} value={v}>{l}</Opt>
                        ))}
                      </SelectField>
                    </p>
                  )}
                  <div>
                    <p className="mb-2 text-xs font-bold text-[#68718f]">When</p>
                    <div className="flex flex-wrap gap-2">
                      {datePresets().map((p) => {
                        const on = dateFrom === p.from && dateTo === p.to;
                        return (
                          <button
                            key={p.key}
                            type="button"
                            aria-pressed={on}
                            onClick={() => {
                              setPickingDate(false);
                              if (on) { setDateFrom(""); setDateTo(""); }
                              else { setDateFrom(p.from); setDateTo(p.to); }
                            }}
                            className={`rounded-full border px-3.5 py-2 text-xs font-bold ${on ? optionOn : optionOff}`}
                          >
                            {p.label}
                          </button>
                        );
                      })}
                      {(() => {
                        const custom = (!!dateFrom || !!dateTo) && !datePresets().some((p) => dateFrom === p.from && dateTo === p.to);
                        const on = pickingDate || custom;
                        return (
                          <button
                            type="button"
                            aria-pressed={on}
                            onClick={() => {
                              if (on) { setPickingDate(false); setDateFrom(""); setDateTo(""); }
                              else { setDateFrom(""); setDateTo(""); setPickingDate(true); }
                            }}
                            className={`rounded-full border px-3.5 py-2 text-xs font-bold ${on ? optionOn : optionOff}`}
                          >
                            Pick a date
                          </button>
                        );
                      })()}
                    </div>
                    {(pickingDate || ((!!dateFrom || !!dateTo) && !datePresets().some((p) => dateFrom === p.from && dateTo === p.to))) && (
                      <label className="mt-2 flex flex-col gap-1">
                        <span className="text-xs font-bold text-[#68718f]">From this date onwards</span>
                        <DateInput value={dateFrom} onChange={(v) => { setDateFrom(v); setDateTo(""); }} className={`${selectClass} w-full`} />
                      </label>
                    )}
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-bold text-[#68718f]">Time of day</p>
                    <div className="flex flex-wrap gap-2">
                      {TIME_BUCKETS.map((b, i) => {
                        const on = timeActive && minH <= b.min && maxH >= b.max;
                        return (
                          <button
                            key={b.key}
                            type="button"
                            aria-pressed={on}
                            onClick={() => setTimeRange(toggleTimeBucket(i, timeRange, timeActive))}
                            className={`rounded-full border px-3.5 py-2 text-xs font-bold ${on ? optionOn : optionOff}`}
                          >
                            {b.label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-[11px] font-semibold text-[#8A90A2]">
                      Morning is before 12pm, midday 12–2pm, afternoon 2–5pm, evening after 5pm.
                    </p>
                  </div>

                  <label className="block">
                    <span className="flex justify-between text-xs font-bold text-[#68718f]">
                      <span>Price</span>
                      <span className="text-baby-pink">{priceActive ? `Up to $${maxPrice}` : "Any price"}</span>
                    </span>
                    <input type="range" min={0} max={PRICE_MAX} step={10} value={maxPrice} onChange={(e) => setMaxPrice(Number(e.target.value))} className="mt-2 h-2 w-full accent-baby-pink" />
                    <span className="mt-1 flex justify-between text-[10px] font-bold text-[#8A90A2]"><span>$0</span><span>${PRICE_MAX}+</span></span>
                  </label>
                </div>
              )}

              <button
                type="button"
                onClick={() => setMobileSheet(null)}
                disabled={loading}
                className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-gradient-to-r from-[#fa4d8d] to-[#ff6b9b] text-sm font-black text-white shadow-pink disabled:opacity-70"
              >
                {loading ? (
                  <>
                    <Spinner className="h-4 w-4" /> Counting results…
                  </>
                ) : (
                  `Show ${total} results`
                )}
              </button>
            </div>
          </div>
        )}

        <div className="hidden sm:mb-4 sm:block sm:space-y-3 sm:rounded-[16px] sm:border sm:border-[#EBE3E5] sm:bg-white sm:p-4 sm:shadow-card">
          <ChipFilter
            label="Type of activity"
            allLabel="All types of activity"
            options={cats.map((c) => ({ key: c.slug, label: c.name }))}
            selected={categories_}
            onChange={setCategories}
          />
          <ChipFilter
            label="Age"
            allLabel="All ages"
            options={AGE_BANDS.map((b) => ({ key: b.key, label: b.label }))}
            selected={ages}
            onChange={setAges}
          />
          <ChipFilter
            label="Area"
            allLabel="All areas"
            options={AREA_FILTER_OPTIONS}
            selected={regions}
            onChange={setRegions}
          />

          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-[#F4EFF0] pt-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-[#68718f]">Sort by</span>
              <SelectField value={sort} onChange={(v) => setSort(v as typeof sort)} aria-label="Sort by" className="h-10 w-full px-3 text-[13px] font-bold">
                <Opt value="popular">Most popular</Opt>
                <Opt value="distance">Nearest</Opt>
                <Opt value="soonest">Starting soonest</Opt>
                <Opt value="price_asc">Price: low to high</Opt>
                <Opt value="price_desc">Price: high to low</Opt>
              </SelectField>
            </label>
            <button
              type="button"
              onClick={() => setShowMore((v) => !v)}
              className="h-10 rounded-[10px] border border-[#EBE3E5] bg-white px-4 text-[13px] font-bold text-[#4a5680] hover:border-baby-pink"
            >
              {showMore ? "Fewer filters ▲" : "More filters ▾"}
            </button>
            {anyFilter && (
              <button type="button" onClick={resetFilters} className="h-10 text-xs font-bold text-baby-pink hover:underline">
                Reset filters
              </button>
            )}
          </div>

          {sort === "distance" && !here && (
            <p className="flex flex-wrap items-center gap-2 rounded-[10px] bg-[#FFF5F8] px-3 py-2 text-xs font-semibold text-[#68718f]">
              <span>Allow location access to sort by how near activities are to you, or</span>
              <SelectField
                value=""
                placeholder="pick your area"
                aria-label="Pick your area"
                onChange={(v) => {
                  const centroid = REGION_CENTROIDS[v];
                  if (centroid) { setHere(centroid); setHerePickedArea(v); }
                }}
                className="h-7 px-2 text-xs font-bold text-[#4a5680]"
              >
                {REGION_FILTERS.map(([v, l]) => (
                  <Opt key={v} value={v}>{l}</Opt>
                ))}
              </SelectField>
            </p>
          )}

          {showMore && (
            <div className="grid gap-3 border-t border-[#F4EFF0] pt-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-[#68718f]">Date from</span>
                <DateInput value={dateFrom} onChange={(v) => { setDateFrom(v); setDateTo(""); }} className={`${selectClass} w-full`} />
              </label>
              <label className="flex flex-col justify-center gap-1">
                <span className="flex justify-between text-xs font-bold text-[#68718f]"><span>Price</span><span className="text-baby-pink">{priceActive ? `Up to $${maxPrice}` : "Any"}</span></span>
                <input type="range" min={0} max={PRICE_MAX} step={10} value={maxPrice} onChange={(e) => setMaxPrice(Number(e.target.value))} className="mt-2 h-2 w-full accent-baby-pink" />
              </label>
              <label className="flex flex-col justify-center gap-1">
                <span className="flex justify-between text-xs font-bold text-[#68718f]"><span>Time</span><span className="text-baby-pink">{timeActive ? `${timeLabel(minH)}–${timeLabel(maxH)}` : "Any"}</span></span>
                <div className="mt-1 flex items-center gap-2">
                  <input type="range" min={0} max={23} value={minH} onChange={(e) => setTimeRange([Math.min(Number(e.target.value), maxH), maxH])} className="h-2 w-full accent-baby-pink" />
                  <input type="range" min={0} max={23} value={maxH} onChange={(e) => setTimeRange([minH, Math.max(Number(e.target.value), minH)])} className="h-2 w-full accent-baby-pink" />
                </div>
              </label>
            </div>
          )}
        </div>

        <div className="space-y-5">
          <section className="rounded-[16px] border border-[#EBE3E5] bg-white p-3 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-black text-baby-green">Explore on map</h2>
              {pinsLoading ? (
                <span className="flex items-center gap-1.5 text-xs font-bold text-[#68718f]">
                  <Spinner className="h-3.5 w-3.5" /> Updating…
                </span>
              ) : (
                <span className="text-xs font-bold text-[#68718f]">{pinned} of {pinActivities.length} pinned</span>
              )}
            </div>
            <div className="relative overflow-hidden rounded-[12px]">
              {pinsLoading ? (
                <div className="flex h-[395px] w-full items-center justify-center bg-[#F3EDF0]" aria-hidden="true">
                  <Spinner className="h-8 w-8 text-baby-pink" />
                </div>
              ) : (
                <Suspense
                  fallback={<div className="h-[395px] w-full animate-pulse bg-[#F3EDF0]" aria-hidden="true" />}
                >
                  <ExploreMap activities={pinActivities} regions={regions} />
                </Suspense>
              )}
            </div>
          </section>
          <section>
            {!loading && total === 0 ? (
              <div className="rounded-[12px] bg-[#FFF5F8] p-5 text-center font-bold text-black">
                <p>No activities match these filters — try widening your search.</p>
                <p className="mt-3">
                  We are looking for quality providers in this space, if there is a vendor you would like to see listed here please{" "}
                  <a href="/contact" className="font-black text-baby-cta hover:opacity-80">
                    let us know.
                    <Icon name="open" className="ml-0.5 inline h-3.5 w-3.5 align-[-0.125em]" />
                  </a>
                </p>
              </div>
            ) : (
              <>
                <div className="mb-3 flex items-center justify-between">
                  {loading
                    ? <RainbowLoader size="sm" className="justify-start" label="Loading activities" />
                    : <p className="text-sm font-black">{`${total} ${total === 1 ? "activity" : "activities"} found`}</p>}
                </div>
                {loading ? (
                  <ActivityRowListSkeleton count={6} />
                ) : (
                  <>
                    <div className="grid gap-2.5 xl:grid-cols-2">
                      {shown.map((activity) => (
                        <ActivityRow key={activity.id} activity={activity} />
                      ))}
                    </div>
                    {hasMore && (
                      <div className="mt-5 flex justify-center">
                        <button
                          type="button"
                          onClick={loadMore}
                          disabled={loadingMore}
                          className="rounded-[10px] border border-[#EBE3E5] bg-white px-6 py-2.5 text-sm font-black text-[#4a5680] shadow-card hover:border-baby-pink disabled:opacity-60"
                        >
                          {loadingMore ? "Loading…" : `Show more (${total - activities.length} left)`}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </main>
      <Footer clearDock />
    </PageShell>
  );
}

/** The areas ordered by how near their centre is to `from`'s — `from` itself
 *  first. Used to turn "Nearest" (with only an area, no fix) into "my area,
 *  then the next-closest area". */

function regionsByProximity(from: string): string[] {
  const o = REGION_CENTROIDS[from];
  if (!o) return [];
  const d2 = (r: string) =>
    (REGION_CENTROIDS[r].lat - o.lat) ** 2 + (REGION_CENTROIDS[r].lng - o.lng) ** 2;
  return Object.keys(REGION_CENTROIDS).sort((a, b) => d2(a) - d2(b));
}

/** An activity's rank in `order` — the position of whichever of its areas is
 *  closest to the picked one (0 = the picked area itself). No area → last. */
function areaRank(a: { areas: string[] }, order: string[]): number {
  if (!a.areas.length) return Infinity;
  return Math.min(
    ...a.areas.map((r) => {
      const i = order.indexOf(r);
      return i === -1 ? Infinity : i;
    })
  );
}

/** Rough great-circle distance (km) from a point to an activity's nearest venue. */
function distanceFrom(here: { lat: number; lng: number }, a: { venues: { lat: number; lng: number }[]; lat?: number; lng?: number }) {
  const points = a.venues.length ? a.venues : a.lat != null && a.lng != null ? [{ lat: a.lat, lng: a.lng }] : [];
  if (!points.length) return Infinity;
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  return Math.min(
    ...points.map((p) => {
      const dLat = rad(p.lat - here.lat);
      const dLng = rad(p.lng - here.lng);
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(here.lat)) * Math.cos(rad(p.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    })
  );
}

/** Full-screen photo viewer for an activity's gallery. Arrow keys and Escape
 *  work, and clicking the backdrop closes it. */
