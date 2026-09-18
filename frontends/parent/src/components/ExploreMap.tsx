import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LiveActivity } from "../lib/useActivities";
import { formatDuration, regionLabel } from "../lib/database.types";

// Singapore centre, and the area the map may be panned over.
const SG_CENTER: [number, number] = [1.3521, 103.8198];
/**
 * Deliberately the island box (lat 1.15-1.48, lng 103.55-104.15) plus a
 * margin, rather than the box itself.
 *
 * `maxBounds` hard-clamps *every* pan Leaflet makes — including the automatic
 * one that brings a popup into view. Held to the tight box, the map at zoom 11
 * is already against its limit, so that pan was refused: a popup opening near
 * the top of the map stayed overhanging and its first entries were sliced off
 * by the map's edge, title and all. Verified by removing maxBounds entirely,
 * at which point the same popup landed fully inside the map.
 *
 * The margin is roughly one popup's worth of latitude at zoom 11 (~0.2°, about
 * 280px) so that pan has somewhere to go, which still keeps the map on
 * Singapore rather than letting it drift off into open sea.
 */
const SG_MAX_BOUNDS: L.LatLngBoundsExpression = [
  [0.95, 103.4],
  [1.68, 104.3],
];

// Brand-pink teardrop pin (a DivIcon avoids Leaflet's bundler-broken PNG icons).
const pinIcon = L.divIcon({
  className: "",
  html:
    '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#FFC1D6;border:2px solid #fff;box-shadow:0 1px 4px rgba(17,26,76,.35);transform:rotate(-45deg)"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 22],
  popupAnchor: [0, -20],
});

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** Interactive Explore map: one pin per provider location, its popup lists the
 *  activities at that spot. Tiles are Esri's Light Gray Canvas, which needs no
 *  API key — see the tile-layer comment below for why CARTO Positron had to go.
 *
 *  `regions` is the Explore page's area filter. It has to reach the map,
 *  because the list filter keeps an activity when ANY of its provider's venues
 *  sits in the chosen area — so a multi-venue business (Kindermusik teaches
 *  west, east and north) survives a filter on "East" and then contributed a pin
 *  at every one of its venues. Filtering on East drew pins right across the
 *  island. Pins are now restricted to the venues actually in the chosen areas. */
export function ExploreMap({
  activities,
  regions = [],
}: {
  activities: LiveActivity[];
  regions?: string[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const [showHint, setShowHint] = useState(false);

  // Create the map once.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const el = containerRef.current;
    // On touch screens one finger belongs to the page (scrolling); the map only
    // moves with two. Leaflet's pinch handler also pans by the fingers' midpoint,
    // so disabling one-finger drag leaves two-finger pan + zoom intact, and its
    // CSS drops to `touch-action: pan-x pan-y` so the browser scrolls the page.
    const touchOnly = window.matchMedia("(pointer: coarse)").matches;
    const map = L.map(el, {
      dragging: !touchOnly,
      center: SG_CENTER,
      zoom: 11,
      minZoom: 10,
      maxBounds: SG_MAX_BOUNDS,
      scrollWheelZoom: false,
      attributionControl: true,
    });
    // Back to Esri's Light Gray Canvas — not CARTO Positron (moved behind an
    // API key and now stamps "API KEY REQUIRED" across every unkeyed tile,
    // still HTTP 200 with a valid PNG so nothing throws), and not World Topo
    // Map either: Topo Map does carry real land/water colour, but it's a
    // full topographic reference map — building outlines, every minor street,
    // contour and admin-boundary line, dozens of overlapping street-name
    // labels shrunk to fit. Fine full-screen, unusable crammed into a 395px
    // widget: QA's "extra lines" and "text unclear when zoomed" were exactly
    // this. Canvas is purpose-built for a small embedded map instead —
    // decluttered road set and label placement at every zoom, so this also
    // fixes the blur (Canvas is well-hinted at each native zoom; Topo Map's
    // dense small text wasn't).
    //
    // The tradeoff: Canvas's land is perfectly neutral grey — R=G=B exactly,
    // confirmed by sampling actual tile pixels — so there's no hue there for
    // any filter to bring out, and a hue-rotate large enough to invent one
    // (this app's first attempt) rotates every pixel by the same amount
    // regardless of its source colour, landing land and water on the same
    // green-cyan smear since they only differed by lightness to begin with.
    // Water, though, does carry a genuine (very faint) blue cast in the
    // source tile — see the saturate-only filter below, which amplifies only
    // that real difference rather than inventing one. Land stays clean and
    // near-white rather than green; that's the ceiling this tile source has.
    //
    // Split into base + labels because this style serves place names as a
    // separate transparent overlay. maxNativeZoom stops at the deepest level
    // the service actually has (18) while maxZoom lets the map keep zooming —
    // Leaflet upscales the last real tile instead of going blank.
    const esri = (service: string, opts: L.TileLayerOptions = {}) =>
      L.tileLayer(
        `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${service}/MapServer/tile/{z}/{y}/{x}`,
        { maxNativeZoom: 18, maxZoom: 19, ...opts }
      );
    esri("World_Light_Gray_Base", {
      // Every data provider Esri requires is still credited; "Esri" simply
      // isn't repeated twice. The map is only 395px tall, so on a phone the
      // longer form wrapped onto a second line and ate a visible slice of it.
      attribution:
        'Tiles &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
    }).addTo(map);
    esri("World_Light_Gray_Reference").addTo(map);
    // saturate() amplifies whatever colour is already there rather than
    // inventing any — neutral (0-saturation) land is mathematically
    // untouched by any multiplier, while water's faint inherent tint (it
    // actually leans indigo, not pure blue, before amplifying) becomes a
    // visible pale blue. The small hue-rotate alongside only fine-tunes that
    // now-amplified water colour off indigo and towards blue; on a still-
    // neutral pixel a hue-rotate of any size is a no-op (rotating zero
    // chroma yields zero chroma), so land stays exactly as neutral as
    // saturate() left it — this is safe in a way the very first attempt's
    // sepia()-then-hue-rotate wasn't, because sepia() is what manufactured a
    // rotatable hue out of land's true neutral in the first place. Scoped to
    // the tile pane only — markers, popups and the zoom control live in
    // their own Leaflet panes.
    const tilePane = map.getPane("tilePane");
    if (tilePane) {
      tilePane.style.filter = "saturate(500%) hue-rotate(-35deg)";
    }
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Show the hint when a single finger actually tries to drag the map (taps on
    // pins and controls are left alone), and clear it as soon as a second lands.
    let hideTimer: number | undefined;
    let startX = 0;
    let startY = 0;
    let armed = false;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        armed = false;
        window.clearTimeout(hideTimer);
        setShowHint(false);
        return;
      }
      const t = e.target as HTMLElement;
      armed = !t.closest(".leaflet-control, .leaflet-popup, .leaflet-marker-icon");
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed || e.touches.length !== 1) return;
      if (Math.hypot(e.touches[0].clientX - startX, e.touches[0].clientY - startY) < 8) return;
      setShowHint(true);
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setShowHint(false), 1500);
    };
    if (touchOnly) {
      el.addEventListener("touchstart", onStart, { passive: true });
      el.addEventListener("touchmove", onMove, { passive: true });
    }
    return () => {
      window.clearTimeout(hideTimer);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  /** One entry per distinct venue coordinate, with the activities taught there.
   *
   *  Grouped by rounded coordinate so co-located classes share a pin. A listing
   *  contributes one pin per venue its provider runs, so multi-location
   *  businesses (Kindermusik in the west, east and north; Lucy Sparkles across
   *  nine venues) appear everywhere they actually teach — not just at their
   *  registered address. */
  const pins = useMemo(() => {
    const byLoc = new Map<
      string,
      { lat: number; lng: number; label: string | null; items: LiveActivity[] }
    >();
    const addPin = (lat: number, lng: number, label: string | null, a: LiveActivity) => {
      const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      const g = byLoc.get(key) ?? { lat, lng, label, items: [] };
      // Don't list the same class twice at one pin.
      if (!g.items.some((x) => x.id === a.id)) g.items.push(a);
      byLoc.set(key, g);
    };

    const inFilter = (r: string | null | undefined) =>
      regions.length === 0 || (!!r && regions.includes(r));

    for (const a of activities) {
      if (a.venues && a.venues.length > 0) {
        // Only the venues in the chosen areas get a pin. A venue with no region
        // recorded is dropped while a filter is on rather than guessed at —
        // showing it would put an unplaceable pin back on the map.
        const venues = a.venues.filter((v) => inFilter(v.region));
        for (const v of venues) {
          addPin(v.lat, v.lng, a.providerName ?? v.name, a);
        }
      } else if (a.lat != null && a.lng != null && inFilter(a.region)) {
        addPin(a.lat, a.lng, a.providerName ?? null, a);
      }
    }
    return [...byLoc.values()];
  }, [activities, regions]);

  /** Fingerprint of what's actually on the map — the effect below is keyed on
   *  this string, never on `pins`/`activities` themselves.
   *
   *  Explore builds its list as `[...filtered].sort(...)` inline on every
   *  render, so `activities` arrives with a fresh array identity each time even
   *  when nothing about it changed. Keyed on that, the replot effect re-ran
   *  constantly and its `fitBounds` snapped the map back to the whole-island
   *  view — so any unrelated re-render (typing in search, a background refetch,
   *  toggling anything on the page) threw away whatever the user had zoomed or
   *  panned to, which made the map feel stuck at its default zoom. Comparing
   *  content instead means the view is only re-fitted when the pins genuinely
   *  differ, e.g. when a filter changes what's shown. */
  const pinsKey = useMemo(
    () =>
      pins
        .map((g) => `${g.lat.toFixed(5)},${g.lng.toFixed(5)}:${g.items.map((i) => i.id).join(".")}`)
        .sort()
        .join("|"),
    [pins]
  );

  // Read the latest pins from inside the content-keyed effect without making
  // their (per-render) identity a dependency of it.
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  // Re-plot pins and re-fit the view — only when the pin content actually changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    const bounds: [number, number][] = [];
    for (const g of pinsRef.current) {
      bounds.push([g.lat, g.lng]);
      const name = g.label ?? g.items[0].providerName;
      // QA: "You shouldn't have to click on pop out before seeing price",
      // "Can't see duration on activity pop outs", and the location should read
      // as an area rather than a postcode. Each row now carries price, duration
      // and area under the title.
      const rows = g.items
        .slice(0, 8)
        .map((a) => {
          const bits = [
            a.price != null
              ? Number(a.price) > 0
                ? `From $${Number(a.price) % 1 === 0 ? Number(a.price).toFixed(0) : Number(a.price).toFixed(2)}`
                : "Free"
              : null,
            formatDuration(a.durationMins),
            regionLabel(a.region) || null,
          ].filter(Boolean);
          return (
            `<a href="/activity?slug=${encodeURIComponent(a.slug)}" style="display:block;text-decoration:none;margin:6px 0">` +
            `<span style="display:block;color:#A7D8F8;font-weight:700">${esc(a.title)}</span>` +
            (bits.length
              ? `<span style="display:block;color:#59658d;font-weight:600;font-size:11.5px">${esc(bits.join(" · "))}</span>`
              : "") +
            `</a>`
          );
        })
        .join("");
      const html =
        `<div style="min-width:150px;font-family:inherit">` +
        (name ? `<div style="font-weight:800;color:#111A4C;margin-bottom:4px">${esc(name)}</div>` : "") +
        rows +
        (g.items.length > 8 ? `<div style="color:#68718f;font-size:12px">+${g.items.length - 8} more</div>` : "") +
        `</div>`;
      // Caps the popup so it can never be taller than the 395px map — eight
      // activities with long titles would otherwise run to roughly 600px,
      // which no amount of panning can fit. Works together with the margin on
      // SG_MAX_BOUNDS: this keeps the popup small enough to fit, that lets
      // Leaflet pan it fully into view.
      //
      // Leaflet's own `maxHeight` rather than CSS overflow, because it also
      // stops scroll events inside the popup being swallowed by the map
      // underneath, which plain `overflow-y: auto` would not. Nothing is
      // hidden — anything past the cap is a scroll away.
      L.marker([g.lat, g.lng], { icon: pinIcon }).bindPopup(html, { maxHeight: 240 }).addTo(layer);
    }

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    } else {
      map.setView(SG_CENTER, 11);
    }
  }, [pinsKey]);

  return (
    <div className="relative h-[395px] w-full" style={{ zIndex: 0 }}>
      <div ref={containerRef} className="h-full w-full" />
      <div
        aria-hidden={!showHint}
        className={`pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center bg-white/55 transition-opacity duration-200 ${
          showHint ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="w-[170px] rounded-[14px] border border-[#FEE9D7] bg-white px-4 py-4 text-center text-[#44507b]">
          <svg
            width="40"
            height="40"
            viewBox="0 0 40 40"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto text-[#FA4D8D]"
          >
            <circle cx="14" cy="26" r="5" fill="currentColor" stroke="none" />
            <circle cx="26" cy="14" r="5" fill="currentColor" stroke="none" />
            <path d="M31 9l5-5M30 4h6v6M9 31l-5 5M4 30v6h6" />
          </svg>
          <div className="mt-1 text-sm font-black">Use two fingers</div>
          <div className="mt-0.5 text-xs font-semibold">One finger scrolls the page</div>
        </div>
      </div>
    </div>
  );
}
