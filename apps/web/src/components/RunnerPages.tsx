'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useLiveRefresh, vehicleLabels } from '@/lib/rescue';
import { stockPhoto, foodCategoryLabels, packagingLabels, type FoodCategory, type Packaging } from '@/lib/supply';
import { Loading } from './Shell';
import { TimeLeft, fmtDateTime } from './SupplyParts';
import { FormError, Photo } from './ui';
import { LocationPicker } from './LocationPicker';
import { parseCoords } from '@/lib/geo';

const btn = 'inline-flex min-h-12 w-full items-center justify-center rounded-lg px-5 py-3 text-base font-semibold disabled:opacity-60 sm:w-auto';

/* --------------------------------- available jobs --------------------------------- */

interface Job {
  rescueId: string;
  listingTitle: string;
  foodCategory: string;
  servings: number;
  estimatedKg: number | null;
  loadKg: number;
  packaging: string;
  pickupStart: string;
  pickupDeadline: string;
  searchEndsAt: string;
  urgency: string;
  providerName: string;
  ngoName: string;
  pickupArea: { city: string };
  destinationArea: { city: string | null };
  estimates: { runnerToPickupKm: number; pickupToNgoKm: number; runnerToPickupMinutes: number; marginMinutes: number; note: string };
}

export function AvailableJobs() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ jobs: Job[] }>('/rescues/available-runs');
    if (res.ok) {
      setJobs(res.data.jobs);
      setError(null);
    } else setError(res.error.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), 20_000);

  async function claim(id: string) {
    setClaiming(id);
    setClaimError(null);
    const res = await api(`/rescues/${id}/assign-self`, { method: 'POST', body: JSON.stringify({}) });
    setClaiming(null);
    if (res.ok) return router.push(`/runner/rescues/${id}`);
    setClaimError(res.error.message);
    await load(); // whoever won the race, the list should reflect it now
  }

  return (
    <div>
      <p className="sr-only">Only jobs you could actually do are listed: within your travel radius, light enough for your capacity, and reachable before the pickup window closes. Estimates are straight-line distances, not routes.</p>
      <div className="mt-3"><FormError message={error} /></div>
      {claimError && <div className="mt-3" role="alert"><p className="rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">{claimError}</p></div>}
      {!jobs && !error && <Loading label="Looking for jobs near you…" />}
      {jobs && jobs.length === 0 && (
        <div className="fl-appear mt-3 rounded-2xl border border-dashed border-stone-300 bg-white/70 p-6 text-center text-stone-700">
          <p className="font-semibold">No jobs for you right now.</p>
          <p className="mt-1 text-sm">Make sure you are set to Available with a vehicle, capacity, radius and base location in <Link href="/profile#transport" className="font-medium text-paprika-700 underline">your profile</Link>. New jobs appear here automatically.</p>
        </div>
      )}
      {jobs && jobs.length > 0 && (
        <ul className="stagger mt-3 grid gap-4 md:grid-cols-2">
          {jobs.map((j) => (
            <li key={j.rescueId} className="lift overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-card"><Photo name={stockPhoto(j.listingTitle, j.foodCategory as FoodCategory)} decorative className="h-28 w-full object-cover" /><div className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="text-lg font-semibold">{j.listingTitle}</h2>
                <span className="rounded-full border border-stone-400 bg-stone-50 px-2.5 py-0.5 text-sm"><TimeLeft deadline={j.pickupDeadline} urgency={j.urgency as never} /></span>
              </div>
              <p className="mt-1 text-sm text-stone-700">
                {foodCategoryLabels[j.foodCategory as FoodCategory] ?? j.foodCategory} · {j.servings} servings (about {j.loadKg} kg) · {packagingLabels[j.packaging as Packaging] ?? j.packaging}
              </p>
              <p className="mt-1 text-sm">
                <strong>{j.providerName}</strong> ({j.pickupArea.city}) → <strong>{j.ngoName}</strong>{j.destinationArea.city ? ` (${j.destinationArea.city})` : ''}
              </p>
              <p className="mt-1 text-sm text-stone-700">
                About {j.estimates.runnerToPickupKm} km to the pickup (~{j.estimates.runnerToPickupMinutes} min), then {j.estimates.pickupToNgoKm} km to the NGO. Pickup window {fmtDateTime(j.pickupStart)} to {fmtDateTime(j.pickupDeadline)}.
              </p>
              <p className="mt-1 text-xs text-stone-600">Exact addresses and contacts are shared after you accept and the provider hand-off begins. This request closes <TimeLeft deadline={j.searchEndsAt} />.</p>
              <button onClick={() => void claim(j.rescueId)} disabled={claiming !== null} className={`${btn} mt-3 bg-paprika-600 text-white hover:bg-paprika-700`}>
                {claiming === j.rescueId ? 'Accepting…' : 'Accept this job'}
              </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------- profile --------------------------------- */

interface Profile {
  availabilityStatus: 'OFFLINE' | 'AVAILABLE';
  vehicleType: string | null;
  capacityKg: number | null;
  radiusKm: number | null;
  latitude: number | null;
  longitude: number | null;
  busy: boolean;
  complete: boolean;
}

export function RunnerProfileForm() {
  const [p, setP] = useState<Profile | null>(null);
  const [note, setNote] = useState('');
  const [form, setForm] = useState({ available: false, vehicleType: '', capacityKg: '', radiusKm: '', latitude: '', longitude: '' });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const apply = (profile: Profile) => {
    setP(profile);
    setForm({
      available: profile.availabilityStatus === 'AVAILABLE',
      vehicleType: profile.vehicleType ?? '',
      capacityKg: profile.capacityKg?.toString() ?? '',
      radiusKm: profile.radiusKm?.toString() ?? '',
      latitude: profile.latitude?.toString() ?? '',
      longitude: profile.longitude?.toString() ?? '',
    });
  };
  useEffect(() => {
    void api<{ profile: Profile; precisionNote: string }>('/runner/profile').then((res) => {
      if (res.ok) {
        apply(res.data.profile);
        setNote(res.data.precisionNote);
      } else setError(res.error.message);
    });
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    setSaved(false);
    const num = (v: string) => (v.trim() === '' ? null : Number(v));
    const res = await api<{ profile: Profile }>('/runner/profile', {
      method: 'PUT',
      body: JSON.stringify({
        availabilityStatus: form.available ? 'AVAILABLE' : 'OFFLINE',
        vehicleType: form.vehicleType || null,
        capacityKg: num(form.capacityKg),
        radiusKm: num(form.radiusKm),
        latitude: num(form.latitude),
        longitude: num(form.longitude),
      }),
    });
    setBusy(false);
    if (res.ok) {
      apply(res.data.profile);
      setSaved(true);
    } else {
      setFields(res.error.fields);
      setError(res.error.message);
    }
  }

  if (!p && !error) return <Loading label="Loading your profile…" />;
  const baseOk = parseCoords(form.latitude, form.longitude);
  const radiusNum = Number(form.radiusKm);
  const radiusCircle = baseOk.ok && radiusNum > 0 && radiusNum <= 100 ? [{ latitude: baseOk.latitude, longitude: baseOk.longitude, radiusKm: radiusNum, label: `Your operating radius: ${radiusNum} km (straight line)` }] : [];
  const input = (k: string) => `mt-1 block w-full rounded-md border px-3 py-2 ${fields[k] ? 'border-red-600' : 'border-stone-300'}`;
  return (
    <form onSubmit={(e) => void save(e)} noValidate className="mt-4 grid max-w-3xl gap-4 rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      {saved && <p role="status" className="rounded-md border border-green-600 bg-green-50 px-3 py-2 text-sm font-medium text-green-900">✓ Profile saved.</p>}
      {p?.busy && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">You are currently carrying out a rescue, so you will not be offered new jobs until it ends.</p>}
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={form.available} onChange={(e) => setForm({ ...form, available: e.target.checked })} />
        I am available for rescue jobs
      </label>
      <div>
        <label htmlFor="veh" className="block text-sm font-medium">How do you travel?</label>
        <select id="veh" value={form.vehicleType} onChange={(e) => setForm({ ...form, vehicleType: e.target.value })} aria-invalid={fields.vehicleType ? true : undefined} className={input('vehicleType')}>
          <option value="">Choose…</option>
          {Object.entries(vehicleLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {fields.vehicleType && <p className="mt-1 text-sm text-red-700">{fields.vehicleType}</p>}
      </div>
      <div>
        <label htmlFor="cap" className="block text-sm font-medium">How much can you carry (kg)?</label>
        <input id="cap" inputMode="decimal" value={form.capacityKg} onChange={(e) => setForm({ ...form, capacityKg: e.target.value })} aria-invalid={fields.capacityKg ? true : undefined} className={input('capacityKg')} />
        {fields.capacityKg && <p className="mt-1 text-sm text-red-700">{fields.capacityKg}</p>}
      </div>
      <div>
        <label htmlFor="rad" className="block text-sm font-medium">How far will you travel (km)?</label>
        <input id="rad" inputMode="decimal" value={form.radiusKm} onChange={(e) => setForm({ ...form, radiusKm: e.target.value })} aria-invalid={fields.radiusKm ? true : undefined} className={input('radiusKm')} />
        {fields.radiusKm && <p className="mt-1 text-sm text-red-700">{fields.radiusKm}</p>}
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-semibold">Base area and operating radius</legend>
        <LocationPicker
          idPrefix="rb"
          latitude={form.latitude}
          longitude={form.longitude}
          onChange={(la, lo) => setForm((f) => ({ ...f, latitude: la, longitude: lo }))}
          errors={{ latitude: fields.latitude, longitude: fields.longitude }}
          circles={radiusCircle}
          note={note || 'Your base location is stored rounded to about 1 km and is used only to decide which jobs you are offered. It is never shown to anyone else. The dashed circle is the distance you said you will travel.'}
        />
      </fieldset>
      <FormError message={error} />
      <button type="submit" disabled={busy} className={`${btn} bg-paprika-600 text-white hover:bg-paprika-700`}>{busy ? 'Saving…' : 'Save profile'}</button>
    </form>
  );
}
