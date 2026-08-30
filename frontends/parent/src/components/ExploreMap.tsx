import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LiveActivity } from "../lib/useActivities";
import { formatDuration, regionLabel } from "../lib/database.types";

// Singapore centre + a bounding box to keep the map on-country.
const SG_CENTER: [number, number] = [1.3521, 103.8198];
const SG_BOUNDS: L.LatLngBoundsExpression = [
  [1.15, 103.55],
  [1.48, 104.15],
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

  // Create the map once.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const map = L.map(containerRef.current, {
      center: SG_CENTER,
      zoom: 11,
      minZoom: 10,
      maxBounds: SG_BOUNDS,
      scrollWheelZoom: false,
      attributionControl: true,
    });
    // Esri's Light Gray Canvas, not CARTO Positron. CARTO moved their
    // basemaps behind an API key and now stamps "API KEY REQUIRED" across
    // every unkeyed tile — while still answering HTTP 200 with a valid PNG,
    // so nothing threw and no console error appeared; the watermark was
    // simply baked into the image and shipped straight to users.
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
      attribution:
        'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
    }).addTo(map);
    esri("World_Light_Gray_Reference").addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
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
      L.marker([g.lat, g.lng], { icon: pinIcon }).bindPopup(html).addTo(layer);
    }

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    } else {
      map.setView(SG_CENTER, 11);
    }
  }, [pinsKey]);

  return <div ref={containerRef} className="h-[395px] w-full" style={{ zIndex: 0 }} />;
}
