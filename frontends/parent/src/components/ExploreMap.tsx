import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LiveActivity } from "../lib/useActivities";
import { formatDuration, regionLabel } from "../lib/database.types";

// MapLibre zoom levels count 512px tiles, so each is one lower than the
// Leaflet / raster level showing the same area (Leaflet 11 = MapLibre 10).

// Singapore centre [lng, lat], and the area the map may be panned over.
const SG_CENTER: [number, number] = [103.8198, 1.3521];
const SG_ZOOM = 10;
/**
 * Deliberately the island box (lat 1.15-1.48, lng 103.55-104.15) plus a
 * margin, rather than the box itself: held to the tight box, the whole-island
 * view is already against its limit and a popup opening near an edge has
 * nowhere to sit. The margin still keeps the map on Singapore rather than
 * letting it drift off into open sea.
 */
const SG_MAX_BOUNDS: [[number, number], [number, number]] = [
  [103.4, 0.95],
  [104.3, 1.68],
];

/** OpenFreeMap's "positron" vector style: free, no API key, OpenStreetMap data.
 *  Vector tiles are drawn on the device, so labels and lines stay sharp at any
 *  zoom and on any screen, and zooming past the deepest tile (14) redraws the
 *  same shapes larger. There is no "Map data not available" placeholder tile to
 *  run into, which the old raster source served past zoom 16. */
const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

type Style = maplibregl.StyleSpecification;

/** Shown for the moment before the real style arrives, so the map is never an
 *  empty box: the site's own cream, which is also the land colour below. */
const BLANK_STYLE: Style = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#FAF6F1" } }],
};

/** If OpenFreeMap cannot be reached at all, fall back to the previous raster
 *  map rather than leaving the pins on a blank card. `maxzoom: 16` is the
 *  deepest level this source really has (17+ is its "Map data not available"
 *  placeholder), so it is never asked for more; MapLibre stretches level 16
 *  when the parent zooms further. */
const FALLBACK_STYLE: Style = {
  version: 8,
  sources: {
    esri: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 16,
      attribution:
        'Tiles &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
    },
    esriLabels: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 16,
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#FAF6F1" } },
    { id: "esri", type: "raster", source: "esri" },
    { id: "esriLabels", type: "raster", source: "esriLabels" },
  ],
};

/** Recolour the stock grey style onto the site palette. Keyed on each layer's
 *  type and data layer rather than its id, so an upstream rename of a layer
 *  leaves it in its stock grey instead of breaking the map. */
function brandStyle(style: Style): Style {
  // Two sets of dotted lines are dropped, because across an island this small
  // they read as a web of stray lines over the pins (QA's "extra lines"):
  // the district boundaries, and the dashes drawn on top of each rail line
  // (the plain rail line underneath stays, a shade quieter).
  const dotted = (layer: Style["layers"][number]) =>
    layer.type === "line" &&
    ((layer["source-layer"] === "boundary" && !!layer.paint && "line-dasharray" in layer.paint) ||
      /^railway.*dashline$/.test(layer.id));
  const kept = style.layers.filter((layer) => !dotted(layer));
  const layers = kept.map((layer) => {
    const src = "source-layer" in layer ? layer["source-layer"] : undefined;
    const paint: Record<string, unknown> = { ...((layer.paint as Record<string, unknown>) ?? {}) };
    if (layer.type === "background") paint["background-color"] = "#FAF6F1";
    else if (layer.type === "fill" && src === "water") paint["fill-color"] = "#A7D8F8";
    else if (layer.type === "line" && src === "waterway") paint["line-color"] = "#A7D8F8";
    else if (layer.type === "fill" && (src === "park" || src === "landcover")) paint["fill-color"] = "#DFF3D9";
    else if (layer.type === "line" && layer.id.startsWith("railway")) paint["line-color"] = "#E6DEE0";
    else if (layer.type === "fill" && src === "landuse") paint["fill-color"] = "#F6F1EC";
    else if (layer.type === "fill" && src === "building") {
      paint["fill-color"] = "#F1EBEC";
      paint["fill-outline-color"] = "#E6DEE0";
    } else if (layer.type === "symbol") {
      // Place names in the site's ink; road and water names a step quieter.
      paint["text-color"] = src === "place" ? "#3f4b78" : src === "water_name" || src === "waterway" ? "#4E86B0" : "#6D748A";
      paint["text-halo-color"] = "rgba(255,252,248,0.9)";
    }
    return { ...layer, paint } as typeof layer;
  });
  return { ...style, layers };
}

// Brand-pink teardrop pin (the CTA pink), white-edged with a soft shadow.
function pinElement(): HTMLElement {
  const el = document.createElement("div");
  el.className = "bb-map-pin";
  el.innerHTML =
    '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#FA4D8D;border:2px solid #fff;box-shadow:0 1px 4px rgba(17,26,76,.35);transform:rotate(-45deg)"></div>';
  el.style.cursor = "pointer";
  return el;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** Interactive Explore map: one pin per provider location, its popup lists the
 *  activities at that spot. Drawn by MapLibre from OpenFreeMap vector tiles,
 *  recoloured to the site palette (see STYLE_URL and brandStyle above).
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
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  // Where the map was before a pin was opened, so closing its card can zoom
  // back out to it. Null while no pin is open.
  const viewBeforePinRef = useRef<{ center: maplibregl.LngLat; zoom: number } | null>(null);
  const zoomOutTimerRef = useRef<number | undefined>(undefined);
  const replottingRef = useRef(false);
  const [showHint, setShowHint] = useState(false);

  // Create the map once.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const el = containerRef.current;
    // On touch screens one finger belongs to the page (scrolling); the map only
    // moves with two. MapLibre's cooperative gestures do exactly that, and leave
    // `touch-action: pan-x pan-y` on the canvas so the browser scrolls the page.
    // Its own "use two fingers" message is hidden in index.css in favour of the
    // branded hint below. A mouse keeps plain click-and-drag.
    const touchOnly = window.matchMedia("(pointer: coarse)").matches;
    const map = new maplibregl.Map({
      container: el,
      style: BLANK_STYLE,
      center: SG_CENTER,
      zoom: SG_ZOOM,
      minZoom: 9,
      // Street level. Vector tiles redraw sharply this far in; see STYLE_URL.
      maxZoom: 17,
      maxBounds: SG_MAX_BOUNDS,
      cooperativeGestures: touchOnly,
      // A flat, north-up map: no tilting or spinning it by accident.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
    });
    // The data credits sit behind the small "i" button, closed until tapped.
    // MapLibre opens a compact credit line on load by default, which covered a
    // strip of this short map; the credits are still one tap away.
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    // It opens itself the first time the style brings in credits to show, so
    // close it once, right after that (this listener runs after the control's
    // own). Once only: after that the button is the parent's to toggle.
    const credits = el.querySelector(".maplibregl-ctrl-attrib");
    const closeCredits = () => {
      if (!credits?.classList.contains("maplibregl-compact")) return;
      credits.classList.remove("maplibregl-compact-show");
      credits.removeAttribute("open");
      map.off("styledata", closeCredits);
      map.off("sourcedata", closeCredits);
    };
    map.on("styledata", closeCredits);
    map.on("sourcedata", closeCredits);
    // The wheel scrolls the page, not the map (zoom with the buttons or a pinch).
    map.scrollZoom.disable();
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;
    // A tap on the map itself (not a pin, not a card) closes the open card.
    map.on("click", (e) => {
      const target = e.originalEvent.target as HTMLElement | null;
      if (target?.closest(".bb-map-pin, .maplibregl-popup")) return;
      for (const m of markersRef.current) {
        const open = m.getPopup();
        if (open?.isOpen()) open.remove();
      }
    });

    let cancelled = false;
    fetch(STYLE_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`style ${r.status}`);
        return r.json() as Promise<Style>;
      })
      .then((style) => {
        if (!cancelled) map.setStyle(brandStyle(style));
      })
      .catch(() => {
        if (!cancelled) map.setStyle(FALLBACK_STYLE);
      });

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
      armed = !t.closest(".maplibregl-ctrl, .maplibregl-popup, .bb-map-pin");
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed || e.touches.length !== 1) return;
      if (Math.hypot(e.touches[0].clientX - startX, e.touches[0].clientY - startY) < 8) return;
      setShowHint(true);
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setShowHint(false), 600);
    };
    if (touchOnly) {
      el.addEventListener("touchstart", onStart, { passive: true });
      el.addEventListener("touchmove", onMove, { passive: true });
    }
    return () => {
      cancelled = true;
      window.clearTimeout(hideTimer);
      window.clearTimeout(zoomOutTimerRef.current);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
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
      // A custom-location activity ("we travel to you") has no venue a
      // parent could actually go to — the coordinate the server falls back
      // to for it is just the provider's own registered address (matching_
      // activities, migration 00175), which read as a real venue pin here
      // and misled parents into thinking that's where the session happens.
      if (a.isCustomLocation) continue;
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
    if (!map) return;
    // Removing a marker closes its card, which would otherwise count as the
    // parent closing it and zoom the map out mid-replot.
    replottingRef.current = true;
    window.clearTimeout(zoomOutTimerRef.current);
    viewBeforePinRef.current = null;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    replottingRef.current = false;

    const bounds = new maplibregl.LngLatBounds();
    for (const g of pinsRef.current) {
      bounds.extend([g.lng, g.lat]);
      // QA: "You shouldn't have to click on pop out before seeing price",
      // "Can't see duration on activity pop outs", and the location should read
      // as an area rather than a postcode. Each row now carries price, duration
      // and area under the title.
      const row = (a: LiveActivity) => {
          const bits = [
            a.price != null
              ? Number(a.price) > 0
                ? `From $${Number(a.price) % 1 === 0 ? Number(a.price).toFixed(0) : Number(a.price).toFixed(2)}`
                : "Free"
              : null,
            formatDuration(a.durationMins),
            a.isCustomLocation
              ? `${a.customLocationLabel?.trim() || "Custom"} (as defined by you)`
              : regionLabel(a.region) || null,
          ].filter(Boolean);
          return (
            `<a href="/activity?slug=${encodeURIComponent(a.slug)}${a.nextSessionAt ? `&at=${encodeURIComponent(a.nextSessionAt)}` : ""}" style="display:block;text-decoration:none;margin:6px 0">` +
            `<span style="display:block;color:#A7D8F8;font-weight:700">${esc(a.title)}</span>` +
            (bits.length
              ? `<span style="display:block;color:#59658d;font-weight:600;font-size:11.5px">${esc(bits.join(" · "))}</span>`
              : "") +
            `</a>`
          );
      };
      // Co-located classes share a pin even when they belong to DIFFERENT
      // providers (a mall or studio several businesses teach from). The popup
      // used to print one vendor name, the first activity's, above the whole
      // list, so every other vendor's class read as belonging to it. Group the
      // rows by provider instead, each under its own name, in first-seen order.
      // (An activity with no provider name falls back to the pin's venue name.)
      const sections = new Map<string, LiveActivity[]>();
      for (const a of g.items.slice(0, 8)) {
        const vendor = a.providerName?.trim() || g.label || "";
        const list = sections.get(vendor);
        if (list) list.push(a);
        else sections.set(vendor, [a]);
      }
      const body = [...sections]
        .map(([vendor, list], i) => {
          const heading = vendor
            ? `<div style="font-weight:800;color:#111A4C;margin:${i ? "10px 0 4px" : "0 0 4px"};${i ? "padding-top:8px;border-top:1px solid #EBE3E5" : ""}">${esc(vendor)}</div>`
            : "";
          return heading + list.map(row).join("");
        })
        .join("");
      // The cap keeps the popup shorter than the 395px map — eight activities
      // with long titles would otherwise run to roughly 600px. Nothing is
      // hidden: anything past the cap is a scroll away inside the popup.
      const html =
        `<div style="min-width:150px;max-height:240px;overflow-y:auto;overscroll-behavior:contain;font-family:inherit">` +
        body +
        (g.items.length > 8 ? `<div style="color:#68718f;font-size:12px">+${g.items.length - 8} more</div>` : "") +
        `</div>`;
      // focusAfterOpen off: it focused the first link, drawing a focus ring
      // on it as though the parent had tabbed there.
      const popup = new maplibregl.Popup({
        offset: 22,
        maxWidth: "260px",
        focusAfterOpen: false,
        // Closing on a map tap is handled once, for the whole map, in the
        // creation effect. The built-in version also fires for a tap on
        // ANOTHER pin, and closed that pin's card in the same tap that opened
        // it: the second pin never opened and the map zoomed back out.
        closeOnClick: false,
        // Always above the pin. Left to choose for itself, the card re-picks
        // its side on every frame of the zoom below as the pin crosses the
        // map, and flickers between them. The zoom parks the pin below centre,
        // so there is always room above it.
        anchor: "bottom",
      }).setHTML(html);
      // Opening a pin zooms in on it, with the pin held below centre so its
      // card (which opens upwards) has room. Closing the card, by its cross or
      // a tap on the map, zooms back out to where the parent was.
      popup.on("open", () => {
        window.clearTimeout(zoomOutTimerRef.current);
        // One card at a time: opening this one closes whichever was open.
        for (const m of markersRef.current) {
          const other = m.getPopup();
          if (other && other !== popup && other.isOpen()) other.remove();
        }
        if (!viewBeforePinRef.current) {
          viewBeforePinRef.current = { center: map.getCenter(), zoom: map.getZoom() };
        }
        map.easeTo({ center: [g.lng, g.lat], zoom: Math.max(map.getZoom(), 14), offset: [0, 110], duration: 650 });
      });
      popup.on("close", () => {
        if (replottingRef.current) return;
        // Deferred a beat, then only if no card is open by then: tapping
        // another pin opens that card and closes this one in the same tap (in
        // either order), and that is a move between pins, not a close. The
        // map should carry on to the new pin rather than zoom out.
        window.clearTimeout(zoomOutTimerRef.current);
        zoomOutTimerRef.current = window.setTimeout(() => {
          if (mapRef.current !== map) return;
          if (markersRef.current.some((m) => m.getPopup()?.isOpen())) return;
          const before = viewBeforePinRef.current;
          viewBeforePinRef.current = null;
          if (before) map.easeTo({ center: before.center, zoom: before.zoom, duration: 650 });
        }, 80);
      });
      markersRef.current.push(
        new maplibregl.Marker({ element: pinElement(), anchor: "bottom" })
          .setLngLat([g.lng, g.lat])
          .setPopup(popup)
          .addTo(map)
      );
    }

    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 30, maxZoom: 14, animate: false });
    } else {
      map.jumpTo({ center: SG_CENTER, zoom: SG_ZOOM });
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
