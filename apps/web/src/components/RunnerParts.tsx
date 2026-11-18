'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { incidentCategoryLabels, severityLabels, type IncidentItem, type RescueRole, type RescueView } from '@/lib/rescue';
import { fmtDateTime } from './SupplyParts';
import { RescueMap, type MapPoint } from './RescueMap';
import { FormError } from './ui';

const btn = 'inline-flex min-h-12 w-full items-center justify-center rounded-lg px-5 py-3 text-base font-semibold disabled:opacity-60 sm:w-auto';

interface SharedLocation {
  location: { latitude: number; longitude: number; ageSeconds: number; recordedAt: string } | null;
  reason?: string;
}

const reasonText: Record<string, string> = {
  NO_LOCATION_SHARED: 'The runner has not shared a position yet.',
  LOCATION_STALE: 'The last shared position is too old to show.',
  NOT_TRACKING: 'Position sharing is only active while the food is being collected or delivered.',
  NO_RUNNER: 'This rescue has no runner.',
};

/* --------------------------------- map + position --------------------------------- */

/**
 * Pickup, NGO and the runner's last shared position. Which of them the viewer sees is decided by the server:
 * parties see approximate areas until the hand-off stage; the runner sees exact places only while holding the job.
 */
export function RescueMapSection({ r, role, refreshKey, mine }: { r: RescueView; role: RescueRole; refreshKey: number; mine?: SharedPoint | null }) {
  const [shared, setShared] = useState<SharedLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watching = r.trackingActive && role !== 'runner';

  useEffect(() => {
    if (!watching) {
      setShared(null);
      return;
    }
    let cancelled = false;
    void api<SharedLocation>(`/rescues/${r.id}/location`).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setShared(res.data);
        setError(null);
      } else setError(res.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [watching, r.id, refreshKey]);

  const points: MapPoint[] = [];
  const pickup = r.listing.exactPickup ?? r.listing.approximateArea;
  if (pickup.latitude !== null && pickup.longitude !== null) {
    points.push({ label: `Pickup, ${pickup.city}`, latitude: pickup.latitude, longitude: pickup.longitude, kind: 'pickup', approximate: !r.listing.exactPickup });
  }
  const dest = r.ngo.destination ?? r.ngo.approximateArea;
  if (dest.latitude !== null && dest.longitude !== null) {
    points.push({ label: `${r.ngo.name}${dest.city ? `, ${dest.city}` : ''}`, latitude: dest.latitude, longitude: dest.longitude, kind: 'ngo', approximate: !r.ngo.destination });
  }
  if (shared?.location) points.push({ label: `Runner (updated ${shared.location.ageSeconds < 90 ? `${shared.location.ageSeconds} s` : `${Math.round(shared.location.ageSeconds / 60)} min`} ago)`, latitude: shared.location.latitude, longitude: shared.location.longitude, kind: 'runner' });
  if (role === 'runner' && mine) points.push({ label: 'You (shared position)', latitude: mine.latitude, longitude: mine.longitude, kind: 'runner' });
  if (points.length === 0) return null;

  return (
    <section aria-labelledby="map-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <h2 id="map-h" className="text-lg font-semibold">Map</h2>
      {r.transportMode === 'RUNNER' && watching && shared && !shared.location && shared.reason && <p className="mt-1 text-sm text-stone-700">{reasonText[shared.reason] ?? 'No position to show.'}</p>}
      <FormError message={error} />
      <RescueMap points={points} title="Pickup, destination and runner position" />
    </section>
  );
}

/* --------------------------------- runner card --------------------------------- */

export function RunnerSection({ r, role }: { r: RescueView; role: RescueRole }) {
  if (r.transportMode !== 'RUNNER' && role !== 'runner') return null;
  return (
    <section aria-labelledby="run-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <h2 id="run-h" className="text-lg font-semibold">Transport</h2>
      {r.transportMode === 'NGO_PICKUP' ? (
        <p className="mt-2 text-sm">The NGO collects this food itself.</p>
      ) : r.runner ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-stone-600">Runner</dt><dd>{r.runner.name}</dd>
          <dt className="text-stone-600">Assignment</dt><dd>{r.runner.assignmentStatus === 'ACTIVE' ? 'Active' : r.runner.assignmentStatus.toLowerCase()}</dd>
          {role !== 'runner' && (<><dt className="text-stone-600">Phone</dt><dd>{r.runner.phone ?? (['PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DELIVERED'].includes(r.status) ? 'Not provided by the runner' : 'Shared once the food is moving')}</dd></>)}
        </dl>
      ) : (
        <p className="mt-2 text-sm">{r.status === 'AWAITING_RUNNER' ? 'Looking for a nearby runner who can carry this load in time.' : 'No runner is assigned.'}</p>
      )}
      {role === 'runner' && r.ngo.destination && (
        <p className="mt-2 text-sm"><strong>Deliver to:</strong> {r.ngo.name}, {r.ngo.destination.addressLine}, {r.ngo.destination.city}</p>
      )}
    </section>
  );
}

/* --------------------------------- runner: share position --------------------------------- */

/**
 * Position sharing is opt-in per session and only offered while the runner holds the job and is collecting or
 * delivering. Updates go out at most every 15 s; the server rounds them to about 100 m and keeps only the latest.
 */
export type SharedPoint = { latitude: number; longitude: number; at: number };

export function ShareLocation({ rescueId, onPosition }: { rescueId: string; onPosition?: (p: SharedPoint | null) => void }) {
  const [on, setOn] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState({ latitude: '', longitude: '' });
  const last = useRef(0);
  const watchId = useRef<number | null>(null);

  const send = useCallback(
    async (latitude: number, longitude: number) => {
      const res = await api(`/rescues/${rescueId}/location`, { method: 'POST', body: JSON.stringify({ latitude, longitude }) });
      if (res.ok) {
        setMessage(`Shared at ${new Date().toLocaleTimeString()}.`);
        setError(null);
        onPosition?.({ latitude, longitude, at: Date.now() });
      } else if (res.error.status !== 429) {
        setError(res.error.message);
        if (res.error.code === 'TRACKING_NOT_ACTIVE') stop();
      }
    },
    [rescueId, onPosition],
  );

  /** Stop watching the device and ask the server to delete the stored point now (it is also deleted when this stage ends). */
  function stop(announce = true) {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setOn(false);
    onPosition?.(null);
    void api(`/rescues/${rescueId}/location`, { method: 'DELETE' });
    if (announce) setMessage('Sharing stopped. Your last shared position was removed.');
  }
  useEffect(() => () => {
    // leaving the page or the stage ending: stop the device watch and remove the stored point
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
      void api(`/rescues/${rescueId}/location`, { method: 'DELETE' });
    }
  }, []);

  function start() {
    setError(null);
    if (!('geolocation' in navigator)) return setError('This device cannot share its position. You can enter it by hand below.');
    watchId.current = navigator.geolocation.watchPosition(
      (p) => {
        if (Date.now() - last.current < 15_000) return;
        last.current = Date.now();
        void send(p.coords.latitude, p.coords.longitude);
      },
      (e) => {
        setError(e.code === e.PERMISSION_DENIED ? 'Location permission was denied. Delivery can continue without it; you can also enter a position by hand.' : 'Your position is unavailable right now.');
        stop();
      },
      { enableHighAccuracy: false, maximumAge: 10_000, timeout: 20_000 },
    );
    setOn(true);
  }

  function submitManual(e: FormEvent) {
    e.preventDefault();
    const lat = Number(manual.latitude);
    const lng = Number(manual.longitude);
    if (!manual.latitude || !manual.longitude || Number.isNaN(lat) || Number.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return setError('Enter a valid latitude (-90 to 90) and longitude (-180 to 180).');
    void send(lat, lng);
  }

  return (
    <section aria-labelledby="loc-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <h2 id="loc-h" className="text-lg font-semibold">Share my position (optional)</h2>
      <p className="mt-1 text-sm text-stone-700">
        The provider, the NGO and FoodLoop admins can see your latest position (rounded to about 100 m) while you are collecting or delivering. Only the latest point is kept, and it is deleted when this stage ends. Sharing is never required.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        {!on ? (
          <button onClick={start} className={`${btn} border border-brand-600 text-brand-700`}>Start sharing</button>
        ) : (
          <button onClick={() => stop()} className={`${btn} border border-stone-400`}>Stop sharing</button>
        )}
      </div>
      <form onSubmit={submitManual} className="mt-3 flex flex-wrap items-end gap-2" noValidate>
        <div>
          <label htmlFor="mlat" className="block text-xs font-medium">Latitude</label>
          <input id="mlat" inputMode="decimal" value={manual.latitude} onChange={(e) => setManual({ ...manual, latitude: e.target.value })} className="mt-1 w-28 rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label htmlFor="mlng" className="block text-xs font-medium">Longitude</label>
          <input id="mlng" inputMode="decimal" value={manual.longitude} onChange={(e) => setManual({ ...manual, longitude: e.target.value })} className="mt-1 w-28 rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
        </div>
        <button type="submit" className={`${btn} border border-stone-300`}>Send this position</button>
      </form>
      {on && (
        <div role="status" className="fl-appear sticky bottom-3 z-30 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-brand-600 bg-brand-50 px-4 py-3 text-sm font-semibold text-brand-900 shadow-lift">
          <span><span aria-hidden>● </span>Sharing is ON: the provider, the NGO and admins can see your position (about 100 m).</span>
          <button onClick={() => stop()} className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700">Stop sharing</button>
        </div>
      )}
      {message && <p role="status" className="mt-1 text-sm text-stone-700">{message}</p>}
      <FormError message={error} />
    </section>
  );
}

/* --------------------------------- incidents --------------------------------- */

export function SeverityBadge({ severity }: { severity: string }) {
  const s = severityLabels[severity] ?? severityLabels.LOW!;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${s.cls}`}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

export function IncidentList({ incidents }: { incidents: IncidentItem[] }) {
  return (
    <ul className="mt-3 space-y-3">
      {incidents.map((i) => (
        <li key={i.id} className={`rounded-md border p-3 text-sm ${i.status === 'OPEN' ? (i.blocking ? 'border-red-400 bg-red-50' : 'border-amber-400 bg-amber-50') : 'border-stone-200'}`}>
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {incidentCategoryLabels[i.category] ?? i.category}
            <SeverityBadge severity={i.severity} />
            <span className="text-xs font-normal text-stone-700">{i.status === 'OPEN' ? (i.blocking ? 'Open · pauses the rescue' : 'Open') : 'Resolved'}</span>
          </p>
          <p className="mt-1">{i.description}</p>
          <p className="mt-1 text-xs text-stone-600">Reported by the {i.reporterRole} · {fmtDateTime(i.createdAt)}{i.evidenceCount > 0 ? ` · ${i.evidenceCount} photo${i.evidenceCount === 1 ? '' : 's'}` : ''}</p>
          {i.status === 'RESOLVED' && <p className="mt-1">Resolution: {i.resolutionNote}</p>}
        </li>
      ))}
    </ul>
  );
}

const categories = Object.keys(incidentCategoryLabels);
const severities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export function IncidentReportForm({ rescueId, onDone, onCancel }: { rescueId: string; onDone: (message: string) => void; onCancel: () => void }) {
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    const res = await api<{ incident: { id: string } }>(`/rescues/${rescueId}/incidents`, { method: 'POST', body: JSON.stringify({ category, severity, description }) });
    if (!res.ok) {
      setBusy(false);
      setFields(res.error.fields);
      return setError(res.error.message);
    }
    let note = 'Incident reported. FoodLoop admins have been told.';
    if (file) {
      const body = new FormData();
      body.append('file', file);
      const up = await api(`/rescues/${rescueId}/incidents/${res.data.incident.id}/evidence`, { method: 'POST', body });
      if (!up.ok) note = `Incident reported, but the photo was not added: ${up.error.message}`;
    }
    setBusy(false);
    onDone(note);
  }

  const input = 'mt-1 block w-full rounded-md border px-3 py-2';
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="mt-3 grid max-w-lg gap-3 rounded-lg border border-stone-300 p-3">
      <p className="text-sm text-stone-700">Do not include phone numbers, addresses or other personal details. Serious or food-safety reports pause the rescue until an admin reviews them.</p>
      <div>
        <label htmlFor="icat" className="block text-sm font-medium">What went wrong?</label>
        <select id="icat" value={category} onChange={(e) => setCategory(e.target.value)} aria-invalid={fields.category ? true : undefined} className={`${input} ${fields.category ? 'border-red-600' : 'border-stone-300'}`}>
          <option value="">Choose…</option>
          {categories.map((c) => <option key={c} value={c}>{incidentCategoryLabels[c]}</option>)}
        </select>
        {fields.category && <p className="mt-1 text-sm text-red-700">{fields.category}</p>}
      </div>
      <div>
        <label htmlFor="isev" className="block text-sm font-medium">How serious is it?</label>
        <select id="isev" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-invalid={fields.severity ? true : undefined} className={`${input} ${fields.severity ? 'border-red-600' : 'border-stone-300'}`}>
          <option value="">Choose…</option>
          {severities.map((s) => <option key={s} value={s}>{severityLabels[s]!.label}</option>)}
        </select>
        {fields.severity && <p className="mt-1 text-sm text-red-700">{fields.severity}</p>}
      </div>
      <div>
        <label htmlFor="idesc" className="block text-sm font-medium">Describe the problem</label>
        <textarea id="idesc" rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} aria-invalid={fields.description ? true : undefined} className={`${input} ${fields.description ? 'border-red-600' : 'border-stone-300'}`} />
        {fields.description && <p className="mt-1 text-sm text-red-700">{fields.description}</p>}
      </div>
      <div>
        <label htmlFor="iphoto" className="block text-sm font-medium">Photo (optional, PNG or JPEG up to 3 MB)</label>
        <input id="iphoto" type="file" accept="image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block text-sm" />
      </div>
      <FormError message={error} />
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className={`${btn} bg-red-700 text-white hover:bg-red-800`}>{busy ? 'Sending…' : 'Report incident'}</button>
        <button type="button" onClick={onCancel} className={`${btn} border border-stone-300`}>Back</button>
      </div>
    </form>
  );
}
