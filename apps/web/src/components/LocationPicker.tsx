'use client';

import { useState } from 'react';
import { nudge, parseCoords } from '@/lib/geo';
import { MapView, type MapCircle, type MapMarker } from './MapView';

/**
 * Choose a place three ways, all kept in sync: click the map or drag the pin, type the latitude and longitude, or (only when the
 * person presses the button, so the browser asks permission at that moment) use the device position. If the position is denied
 * or the map cannot load, the typed fields and nudge buttons still do everything.
 */
export function LocationPicker({
  idPrefix,
  latitude,
  longitude,
  onChange,
  disabled = false,
  errors = {},
  circles = [],
  markers = [],
  note,
  height = 300,
}: {
  idPrefix: string;
  latitude: string;
  longitude: string;
  onChange: (latitude: string, longitude: string) => void;
  disabled?: boolean;
  errors?: { latitude?: string; longitude?: string };
  circles?: MapCircle[];
  markers?: MapMarker[];
  note?: string;
  height?: number;
}) {
  const [geo, setGeo] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [locating, setLocating] = useState(false);
  const parsed = parseCoords(latitude, longitude);
  const value = parsed.ok ? { latitude: parsed.latitude, longitude: parsed.longitude } : null;
  const set = (la: number, lo: number) => onChange(String(la), String(lo));

  function useDevice() {
    setGeo(null);
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return setGeo({ kind: 'error', text: 'This browser cannot give its position. Click the map or type the coordinates instead.' });
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        set(Math.round(p.coords.latitude * 1e6) / 1e6, Math.round(p.coords.longitude * 1e6) / 1e6);
        setGeo({ kind: 'info', text: 'Position filled in from this device. Drag the pin if it is not exactly right.' });
      },
      (e) => {
        setLocating(false);
        setGeo({
          kind: 'error',
          text: e.code === e.PERMISSION_DENIED ? 'Location permission was denied, so nothing was read. Click the map or type the coordinates instead.' : 'Your position is unavailable right now. Click the map or type the coordinates instead.',
        });
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  const btn = 'inline-flex min-h-9 items-center rounded-lg border border-stone-300 bg-white px-3 py-1 text-sm font-semibold hover:bg-stone-100 disabled:opacity-50';
  const fieldCls = (err?: string) => `mt-1 block w-full rounded-lg border bg-white px-3 py-2.5 text-base shadow-sm ${err ? 'border-red-600 bg-red-50/40' : 'border-stone-300 hover:border-stone-400'}`;

  return (
    <div className="sm:col-span-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-latitude`} className="block text-sm font-semibold">Latitude</label>
          <input id={`${idPrefix}-latitude`} inputMode="decimal" value={latitude} disabled={disabled} onChange={(e) => onChange(e.target.value, longitude)} aria-invalid={errors.latitude ? true : undefined} aria-describedby={`${idPrefix}-loc-hint`} className={fieldCls(errors.latitude)} />
          {errors.latitude && <p className="mt-1 text-sm font-medium text-red-700">{errors.latitude}</p>}
        </div>
        <div>
          <label htmlFor={`${idPrefix}-longitude`} className="block text-sm font-semibold">Longitude</label>
          <input id={`${idPrefix}-longitude`} inputMode="decimal" value={longitude} disabled={disabled} onChange={(e) => onChange(latitude, e.target.value)} aria-invalid={errors.longitude ? true : undefined} aria-describedby={`${idPrefix}-loc-hint`} className={fieldCls(errors.longitude)} />
          {errors.longitude && <p className="mt-1 text-sm font-medium text-red-700">{errors.longitude}</p>}
        </div>
      </div>
      <p id={`${idPrefix}-loc-hint`} className="mt-1 text-xs text-stone-600">
        {note ?? 'Click the map, drag the pin, or type the coordinates. Needed for matching.'}
        {latitude.trim() !== '' && !parsed.ok ? ` ${parsed.error}` : ''}
      </p>
      {!disabled && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={useDevice} disabled={locating} className={btn}>{locating ? 'Asking your device…' : 'Use my current location'}</button>
          <span className="text-xs text-stone-600">Your browser asks for permission only when you press this.</span>
        </div>
      )}
      {geo && <p role="status" className={`fl-appear mt-2 rounded-lg border px-3 py-2 text-sm ${geo.kind === 'error' ? 'border-amber-400 bg-amber-50 text-amber-950' : 'border-stone-300 bg-stone-100 text-stone-900'}`}>{geo.text}</p>}
      <MapView
        title="Location map"
        height={height}
        circles={circles}
        markers={disabled && value ? [...markers, { id: 'sel', kind: 'selected', latitude: value.latitude, longitude: value.longitude, label: 'Location' }] : markers}
        picker={disabled ? undefined : { value, onChange: set }}
      />
      {!disabled && (
        <div role="group" aria-label="Move the pin by about 100 metres" className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-stone-700">Nudge the pin 100 m:</span>
          {([['North', 100, 0], ['South', -100, 0], ['West', 0, -100], ['East', 0, 100]] as const).map(([label, n, e]) => (
            <button key={label} type="button" disabled={!value} onClick={() => { if (!value) return; const p = nudge(value, n, e); set(p.latitude, p.longitude); }} className={btn}>{label}</button>
          ))}
          <button type="button" disabled={!latitude && !longitude} onClick={() => onChange('', '')} className={btn}>Clear location</button>
        </div>
      )}
    </div>
  );
}
