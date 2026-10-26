/** Straight-line (great-circle) distance in km. An estimate only: there is no road routing in FoodLoop. */
export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export const distanceText = (km: number) => (km < 1 ? `${Math.round(km * 10) * 100} m` : `${km.toFixed(1)} km`);

export function validCoords(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Parses two text fields. Returns an error message instead of a position when they are not usable. */
export function parseCoords(latText: string, lngText: string): { ok: true; latitude: number; longitude: number } | { ok: false; error: string } {
  if (!latText.trim() || !lngText.trim()) return { ok: false, error: 'Enter both latitude and longitude.' };
  const latitude = Number(latText);
  const longitude = Number(lngText);
  if (!validCoords(latitude, longitude)) return { ok: false, error: 'Latitude must be between -90 and 90 and longitude between -180 and 180.' };
  return { ok: true, latitude, longitude };
}

/** Move a position by metres north/east (used by the keyboard nudge buttons next to a map). */
export function nudge(p: { latitude: number; longitude: number }, northM: number, eastM: number) {
  const latitude = p.latitude + northM / 111_320;
  const longitude = p.longitude + eastM / (111_320 * Math.max(0.01, Math.cos((p.latitude * Math.PI) / 180)));
  return { latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6 };
}

/** Pune city centre: only the starting view of a map with nothing on it. Never saved as anyone's position. */
export const DEFAULT_CENTER = { latitude: 18.5204, longitude: 73.8567 };
