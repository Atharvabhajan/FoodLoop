'use client';

import { MapView, type MapMarker } from './MapView';

export interface MapPoint {
  label: string;
  latitude: number;
  longitude: number;
  kind: 'pickup' | 'ngo' | 'runner';
  /** True when the position is deliberately coarse (area, not an address). */
  approximate?: boolean;
}

const shapes: Record<MapPoint['kind'], string> = { pickup: 'P', ngo: 'N', runner: 'R' };

/**
 * Map of a rescue: pickup, NGO and (when shared) the runner. Positions arrive already rounded or withheld by the server;
 * this component only draws what it is given. It is an interactive map (zoom, fit, legend, popups) with a text list of the
 * same places, so it is never the only way to read a position, and a visible message when tiles cannot load.
 */
export function RescueMap({ points, title }: { points: MapPoint[]; title: string }) {
  if (points.length === 0) return null;
  const markers: MapMarker[] = points.map((p) => ({
    id: `${p.kind}-${p.label}`,
    kind: p.kind,
    latitude: p.latitude,
    longitude: p.longitude,
    label: p.label,
    approximate: p.approximate,
    showLabel: true,
    popup: { title: p.label, lines: [`${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`] },
  }));
  return (
    <div>
      <MapView title={title} markers={markers} height={300} />
      <ul className="mt-2 space-y-0.5 text-sm text-stone-700">
        {points.map((p) => (
          <li key={`${p.kind}-${p.label}`}>
            <strong>{shapes[p.kind]}</strong> · {p.label}: {p.latitude.toFixed(3)}, {p.longitude.toFixed(3)}
            {p.approximate ? ' (approximate area)' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
