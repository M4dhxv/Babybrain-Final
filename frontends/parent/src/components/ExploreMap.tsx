import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LiveActivity } from "../lib/useActivities";

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
    '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#FA5D93;border:2px solid #fff;box-shadow:0 1px 4px rgba(17,26,76,.35);transform:rotate(-45deg)"></div>',
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

    // Group activities by rounded coordinate so co-located classes share a pin.
    const byLoc = new Map<string, { lat: number; lng: number; items: LiveActivity[] }>();
    for (const a of activities) {
      if (a.lat == null || a.lng == null) continue;
      const key = `${a.lat.toFixed(5)},${a.lng.toFixed(5)}`;
      const g = byLoc.get(key) ?? { lat: a.lat, lng: a.lng, items: [] };
      g.items.push(a);
      byLoc.set(key, g);
    }

    const bounds: [number, number][] = [];
    for (const g of byLoc.values()) {
      bounds.push([g.lat, g.lng]);
      const name = g.items[0].providerName;
      const rows = g.items
        .slice(0, 8)
        .map(
          (a) =>
            `<a href="/activity?slug=${encodeURIComponent(a.slug)}" style="display:block;color:#4597F7;font-weight:700;text-decoration:none;margin:2px 0">${esc(a.title)}</a>`
        )
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
