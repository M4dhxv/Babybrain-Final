import { useEffect, useRef } from "react";
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
    '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#D9004A;border:2px solid #fff;box-shadow:0 1px 4px rgba(17,26,76,.35);transform:rotate(-45deg)"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 22],
  popupAnchor: [0, -20],
});

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** Interactive Explore map: one pin per provider location, its popup lists the
 *  activities at that spot. Tiles are CARTO Positron (free, no API key). */
export function ExploreMap({ activities }: { activities: LiveActivity[] }) {
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
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Re-plot pins whenever the (filtered) activity list changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    // Group by rounded coordinate so co-located classes share a pin. A listing
    // contributes one pin per venue its provider runs, so multi-location
    // businesses (Kindermusik in the west, east and north; Lucy Sparkles across
    // nine venues) appear everywhere they actually teach — not just at their
    // registered address.
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

    for (const a of activities) {
      if (a.venues && a.venues.length > 0) {
        for (const v of a.venues) {
          addPin(v.lat, v.lng, a.providerName ?? v.name, a);
        }
      } else if (a.lat != null && a.lng != null) {
        addPin(a.lat, a.lng, a.providerName ?? null, a);
      }
    }

    const bounds: [number, number][] = [];
    for (const g of byLoc.values()) {
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
            `<span style="display:block;color:#0E6FAF;font-weight:700">${esc(a.title)}</span>` +
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
  }, [activities]);

  return <div ref={containerRef} className="h-[395px] w-full" style={{ zIndex: 0 }} />;
}
