'use client';

import 'leaflet/dist/leaflet.css';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CENTER } from '@/lib/geo';

export type MarkerKind = 'pickup' | 'ngo' | 'runner' | 'listing' | 'urgent' | 'org' | 'selected';

export interface MapMarker {
  id: string;
  kind: MarkerKind;
  latitude: number;
  longitude: number;
  label: string;
  /** Popup content. Built with DOM text nodes, never as HTML. */
  popup?: { title: string; lines?: string[]; href?: string; hrefLabel?: string };
  approximate?: boolean;
  /** Draw the label next to the marker without needing a click. */
  showLabel?: boolean;
}

export interface MapCircle {
  latitude: number;
  longitude: number;
  radiusKm: number;
  label: string;
}

const legend: Record<MarkerKind, { color: string; label: string }> = {
  pickup: { color: '#067858', label: 'Pickup (food)' },
  listing: { color: '#067858', label: 'Live listing' },
  urgent: { color: '#c25200', label: 'Urgent listing' },
  ngo: { color: '#14201b', label: 'NGO / destination' },
  org: { color: '#14201b', label: 'Organization' },
  runner: { color: '#3a56d4', label: 'Runner' },
  selected: { color: '#3a56d4', label: 'Selected location' },
};

const glyph: Record<MarkerKind, string> = { pickup: 'P', listing: 'F', urgent: '!', ngo: 'N', org: 'O', runner: 'R', selected: '+' };

function popupNode(m: MapMarker, open: (href: string) => void): HTMLElement {
  const root = document.createElement('div');
  root.style.minWidth = '9rem';
  const t = document.createElement('strong');
  t.textContent = m.popup?.title ?? m.label;
  root.appendChild(t);
  for (const line of m.popup?.lines ?? []) {
    const p = document.createElement('div');
    p.textContent = line;
    p.style.marginTop = '2px';
    root.appendChild(p);
  }
  if (m.approximate) {
    const p = document.createElement('div');
    p.textContent = 'Approximate area only. The exact address is shared after the rescue is confirmed.';
    p.style.cssText = 'margin-top:4px;font-size:12px;color:#47544d';
    root.appendChild(p);
  }
  const href = m.popup?.href;
  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = m.popup?.hrefLabel ?? 'Open';
    a.style.cssText = 'display:inline-block;margin-top:6px;font-weight:600;color:#065f47;text-decoration:underline';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      open(href);
    });
    root.appendChild(a);
  }
  return root;
}

/**
 * The one interactive map of the app (Leaflet + OpenStreetMap tiles, no extra dependency).
 *
 *  - markers with popups, optional radius circles, zoom buttons, "fit all" and (with a picker) "recentre";
 *  - `picker`: the user clicks the map or drags the pin to choose a place; the parent owns the value, so typed
 *    coordinates move the pin too;
 *  - a legend of what is on the map, and a visible state when tiles cannot load (offline): the markers, circles and the
 *    parent's text/inputs keep working, so the map is never the only way to do something.
 * Distances shown by callers are straight-line estimates, never road routes.
 */
export function MapView({
  markers,
  circles = [],
  title,
  height = 320,
  picker,
  selectedId,
  highlightId,
  onSelect,
  showLegend = true,
  popups = true,
  recenterTo,
}: {
  markers: MapMarker[];
  circles?: MapCircle[];
  title: string;
  height?: number;
  picker?: { value: { latitude: number; longitude: number } | null; onChange: (latitude: number, longitude: number) => void };
  selectedId?: string | null;
  /** Draw this marker bigger with a lime ring (selection from a list or the map). */
  highlightId?: string | null;
  onSelect?: (id: string) => void;
  showLegend?: boolean;
  /** Open a popup when a marker is clicked. Off when the page shows its own detail panel. */
  popups?: boolean;
  /** Adds a "Recentre" button that returns the view to this point. */
  recenterTo?: { latitude: number; longitude: number; label: string } | null;
}) {
  const router = useRouter();
  const el = useRef<HTMLDivElement>(null);
  const leaflet = useRef<typeof import('leaflet') | null>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const layer = useRef<import('leaflet').LayerGroup | null>(null);
  const pin = useRef<import('leaflet').Marker | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const byId = useRef(new Map<string, import('leaflet').CircleMarker>());
  const pickerCb = useRef(picker?.onChange);
  pickerCb.current = picker?.onChange;
  const circleCount = useRef(0);
  circleCount.current = circles.length;
  const selectCb = useRef(onSelect);
  selectCb.current = onSelect;
  const [ready, setReady] = useState(false);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [offline, setOffline] = useState(false);

  const open = useCallback(
    (href: string) => {
      if (href.startsWith('#')) document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else router.push(href);
    },
    [router],
  );
  const openRef = useRef(open);
  openRef.current = open;

  const fit = useCallback(() => {
    const L = leaflet.current;
    const map = mapRef.current;
    if (!L || !map) return;
    const b = L.latLngBounds([]);
    for (const m of markers) b.extend([m.latitude, m.longitude]);
    for (const c of circles) b.extend(L.latLng(c.latitude, c.longitude).toBounds(c.radiusKm * 2000));
    if (picker?.value) b.extend([picker.value.latitude, picker.value.longitude]);
    if (b.isValid()) map.fitBounds(b, { padding: [36, 36], maxZoom: 15 });
  }, [markers, circles, picker?.value]);

  // create the map once
  useEffect(() => {
    let disposed = false;
    setOffline(typeof navigator !== 'undefined' && navigator.onLine === false);
    void import('leaflet').then((L) => {
      if (disposed || !el.current) return;
      leaflet.current = L;
      const map = L.map(el.current, { scrollWheelZoom: false, attributionControl: true });
      mapRef.current = map;
      const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      });
      let errors = 0;
      tiles.on('tileerror', () => {
        errors += 1;
        if (errors >= 3) setTilesFailed(true);
      });
      tiles.on('tileload', () => {
        errors = 0;
        setTilesFailed(false);
      });
      tiles.addTo(map);
      layer.current = L.layerGroup().addTo(map);
      map.setView([DEFAULT_CENTER.latitude, DEFAULT_CENTER.longitude], 11);
      // Wheel zoom only after the map has been clicked, so the page can still scroll past it.
      map.on('click', (e: import('leaflet').LeafletMouseEvent) => {
        map.scrollWheelZoom.enable();
        if (pickerCb.current) pickerCb.current(Math.round(e.latlng.lat * 1e6) / 1e6, Math.round(e.latlng.lng * 1e6) / 1e6);
      });
      map.on('blur', () => map.scrollWheelZoom.disable());
      // a map inside a hidden tab or a resized panel needs to be told its new size
      const ro = new ResizeObserver(() => map.invalidateSize());
      ro.observe(el.current);
      roRef.current = ro;
      setReady(true);
    });
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      disposed = true;
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      roRef.current?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      leaflet.current = null;
      layer.current = null;
      pin.current = null;
      byId.current.clear();
      setReady(false);
    };
  }, []);

  // markers and circles
  const markerKey = JSON.stringify([markers, circles]);
  useEffect(() => {
    const L = leaflet.current;
    const g = layer.current;
    const map = mapRef.current;
    if (!ready || !L || !g || !map) return;
    g.clearLayers();
    byId.current.clear();
    for (const c of circles) {
      L.circle([c.latitude, c.longitude], { radius: c.radiusKm * 1000, color: '#067858', weight: 2, dashArray: '6 6', fillColor: '#12a079', fillOpacity: 0.07 })
        .bindTooltip(c.label, { sticky: true })
        .addTo(g);
    }
    for (const m of markers) {
      const cm = L.circleMarker([m.latitude, m.longitude], { radius: m.kind === 'selected' ? 11 : 9, color: '#ffffff', weight: 2, fillColor: legend[m.kind].color, fillOpacity: 1 }).addTo(g);
      if (popups) cm.bindPopup(popupNode(m, (h) => openRef.current(h)));
      cm.bindTooltip(`${glyph[m.kind]}: ${m.label}${m.approximate ? ' (approximate area)' : ''}`, { permanent: !!m.showLabel, direction: 'top', offset: [0, -8] });
      cm.on('click', () => selectCb.current?.(m.id));
      byId.current.set(m.id, cm);
    }
    const b = L.latLngBounds([]);
    for (const m of markers) b.extend([m.latitude, m.longitude]);
    for (const c of circles) b.extend(L.latLng(c.latitude, c.longitude).toBounds(c.radiusKm * 2000));
    if (picker?.value) b.extend([picker.value.latitude, picker.value.longitude]);
    if (b.isValid()) {
      if (markers.length + (picker?.value ? 1 : 0) === 1 && circles.length === 0) {
        const only = markers[0] ?? { latitude: picker!.value!.latitude, longitude: picker!.value!.longitude };
        map.setView([only.latitude, only.longitude], 14);
      } else map.fitBounds(b, { padding: [36, 36], maxZoom: 15 });
    }
  }, [ready, markerKey]);

  // the highlighted marker is drawn larger with a lime ring
  useEffect(() => {
    for (const [id, cm] of byId.current) {
      const on = id === highlightId;
      cm.setStyle(on ? { radius: 14, weight: 5, color: '#b2df24' } : { radius: 9, weight: 2, color: '#ffffff' });
      if (on) cm.bringToFront();
    }
  }, [highlightId, ready, markerKey]);

  // selecting from a list opens that marker's popup
  useEffect(() => {
    if (!selectedId) return;
    const cm = byId.current.get(selectedId);
    if (cm && mapRef.current) {
      mapRef.current.panTo(cm.getLatLng());
      if (popups) cm.openPopup();
    }
  }, [selectedId]);

  // the draggable pin of a picker follows the parent's value
  const pv = picker?.value;
  useEffect(() => {
    const L = leaflet.current;
    const map = mapRef.current;
    if (!ready || !L || !map || !picker) return;
    if (!pv) {
      pin.current?.remove();
      pin.current = null;
      return;
    }
    if (!pin.current) {
      const icon = L.divIcon({
        className: '',
        html: '<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#067858;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>',
        iconSize: [26, 26],
        iconAnchor: [13, 26],
      });
      const m = L.marker([pv.latitude, pv.longitude], { draggable: true, icon, title: 'Selected location. Drag to move it.', keyboard: true }).addTo(map);
      m.on('dragend', () => {
        const p = m.getLatLng();
        pickerCb.current?.(Math.round(p.lat * 1e6) / 1e6, Math.round(p.lng * 1e6) / 1e6);
      });
      pin.current = m;
      // with a radius circle the whole circle stays in view; otherwise zoom in on the pin
      if (circleCount.current === 0) map.setView([pv.latitude, pv.longitude], Math.max(map.getZoom(), 14));
    } else {
      const cur = pin.current.getLatLng();
      if (Math.abs(cur.lat - pv.latitude) > 1e-7 || Math.abs(cur.lng - pv.longitude) > 1e-7) {
        pin.current.setLatLng([pv.latitude, pv.longitude]);
        if (!map.getBounds().contains([pv.latitude, pv.longitude])) map.panTo([pv.latitude, pv.longitude]);
      }
    }
  }, [ready, pv?.latitude, pv?.longitude, !!picker]);

  const kinds = Array.from(new Set(markers.map((m) => m.kind)));
  return (
    <figure className="mt-3" aria-label={title}>
      <div className="relative">
        <div
          ref={el}
          role="application"
          aria-label={`${title}. ${picker ? 'Click the map or drag the pin to choose a place; you can also type coordinates in the fields.' : 'Use the buttons or the list for the same information.'}`}
          style={{ height }}
          className="z-0 w-full overflow-hidden rounded-xl border border-stone-300 bg-stone-100"
        />
        {(tilesFailed || offline) && (
          <p role="status" className="fl-appear absolute inset-x-2 top-2 z-[500] rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-950 shadow">
            {offline ? 'You appear to be offline.' : 'Map tiles could not be loaded.'} The background is missing, but markers, distances and the list below still work{picker ? ', and you can type the address and coordinates instead of clicking' : ''}.
          </p>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={fit} disabled={markers.length === 0 && circles.length === 0 && !picker?.value} className="inline-flex min-h-9 items-center rounded-lg border border-stone-300 bg-white px-3 py-1 text-sm font-semibold hover:bg-stone-100 disabled:opacity-50">
          Fit all markers
        </button>
        {recenterTo && (
          <button type="button" onClick={() => mapRef.current?.setView([recenterTo.latitude, recenterTo.longitude], 13)} className="inline-flex min-h-9 items-center rounded-lg border border-stone-300 bg-white px-3 py-1 text-sm font-semibold hover:bg-stone-100">
            Recentre on {recenterTo.label}
          </button>
        )}
        {picker?.value && (
          <button type="button" onClick={() => mapRef.current?.setView([picker.value!.latitude, picker.value!.longitude], 16)} className="inline-flex min-h-9 items-center rounded-lg border border-stone-300 bg-white px-3 py-1 text-sm font-semibold hover:bg-stone-100">
            Recentre on the pin
          </button>
        )}
        {showLegend && (kinds.length > 0 || circles.length > 0) && (
          <ul aria-label="Map legend" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-700">
            {kinds.map((k) => (
              <li key={k} className="flex items-center gap-1">
                <span aria-hidden className="inline-block h-3 w-3 rounded-full border border-white shadow ring-1 ring-stone-300" style={{ background: legend[k].color }} />
                <strong>{glyph[k]}</strong> {legend[k].label}
              </li>
            ))}
            {circles.length > 0 && (
              <li className="flex items-center gap-1">
                <span aria-hidden className="inline-block h-3 w-3 rounded-full border-2 border-dashed border-brand-600" /> Service radius
              </li>
            )}
          </ul>
        )}
      </div>
      <p className="mt-1 text-xs text-stone-600">Distances on this map are straight-line estimates, not road routes. Map data &copy; OpenStreetMap contributors.</p>
    </figure>
  );
}
