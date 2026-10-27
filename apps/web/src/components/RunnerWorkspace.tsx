'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, type User } from '@/lib/api';
import type { ImpactResponse } from '@/lib/impact';
import { useLiveRefresh, vehicleLabels, type RescueSummary, type RescueView } from '@/lib/rescue';
import { RescueStatusBadge } from './RescueParts';
import { AvailableJobs } from './RunnerPages';
import { RescueMapSection } from './RunnerParts';
import { StageTrack } from './StageTrack';
import { TimeLeft } from './SupplyParts';
import { ActivityList, Band, Kpi, KpiRow, Loadingish, Panel, firstName, greeting, linkCls, useNotes } from './ops';
import { CountUp, FormError, SuccessNote } from './ui';

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

/** Runner workspace: the assigned rescue and its next action first, then open jobs. Mobile-first. */
export function RunnerWorkspace({ user }: { user: User }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [rescues, setRescues] = useState<RescueSummary[] | null>(null);
  const [view, setView] = useState<RescueView | null>(null);
  const [jobs, setJobs] = useState<number | null>(null);
  const [impact, setImpact] = useState<ImpactResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notes = useNotes();

  const load = useCallback(async () => {
    const [p, r, j, i] = await Promise.all([
      api<{ profile: Profile }>('/runner/profile'),
      api<{ rescues: RescueSummary[] }>('/rescues?scope=active'),
      api<{ jobs: unknown[] }>('/rescues/available-runs'),
      api<ImpactResponse>('/impact/me'),
    ]);
    if (p.ok) setProfile(p.data.profile);
    if (r.ok) {
      setRescues(r.data.rescues);
      const first = r.data.rescues[0];
      if (first) {
        const v = await api<{ rescue: RescueView }>(`/rescues/${first.id}`);
        if (v.ok) setView(v.data.rescue);
      } else setView(null);
    }
    if (j.ok) setJobs(j.data.jobs.length);
    if (i.ok) setImpact(i.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), 30_000);

  async function toggle() {
    if (!profile) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const next = profile.availabilityStatus === 'AVAILABLE' ? 'OFFLINE' : 'AVAILABLE';
    const res = await api<{ profile: Profile }>('/runner/profile', {
      method: 'PUT',
      body: JSON.stringify({ availabilityStatus: next, vehicleType: profile.vehicleType, capacityKg: profile.capacityKg, radiusKm: profile.radiusKm, latitude: profile.latitude, longitude: profile.longitude }),
    });
    setBusy(false);
    if (res.ok) {
      setProfile(res.data.profile);
      setNotice(next === 'AVAILABLE' ? 'You are available: matching jobs will appear below.' : 'You are offline: no new jobs will be offered.');
    } else setError(res.error.fields.availabilityStatus ?? res.error.message);
  }

  const active = rescues?.[0] ?? null;
  const available = profile?.availabilityStatus === 'AVAILABLE';

  return (
    <div>
      <Band
        photo="volunteer-handoff"
        eyebrow={`${greeting()}, ${firstName(user.name)}`}
        title={active ? 'You are carrying a rescue' : available ? 'You are available for jobs' : 'You are offline'}
        actions={
          profile && (
            <button type="button" onClick={() => void toggle()} disabled={busy} aria-pressed={available} className={`inline-flex min-h-12 items-center rounded-xl px-5 py-3 text-base font-bold shadow-lift disabled:opacity-60 ${available ? 'border-2 border-white/60 text-white hover:bg-white/10' : 'bg-saffron-300 text-stone-950 hover:bg-saffron-200'}`}>
              {available ? 'Go offline' : 'Go available'}
            </button>
          )
        }
      >
        {profile?.vehicleType && <span className="text-stone-200">{vehicleLabels[profile.vehicleType] ?? profile.vehicleType}{profile.capacityKg ? ` · up to ${profile.capacityKg} kg` : ''}{profile.radiusKm ? ` · ${profile.radiusKm} km radius` : ''}</span>}
        {profile && !profile.complete && <Link href="/profile#transport" className="font-semibold text-saffron-200 underline">Finish your transport profile to receive jobs</Link>}
      </Band>
      <div className="mt-3 space-y-2">
        {notice && <SuccessNote>{notice}</SuccessNote>}
        <FormError message={error} />
      </div>

      <KpiRow label="Your numbers">
        <Kpi label="Active rescue" value={rescues ? <CountUp value={rescues.length} /> : '–'} note={active ? active.nextAction.text : 'Nothing assigned'} tone={active ? 'hot' : 'plain'} href="/runner/rescues" />
        <Kpi label="Open jobs for you" value={jobs === null ? '–' : <CountUp value={jobs} />} note={available ? 'within your radius and capacity' : 'go available to see them'} />
        <Kpi label="Deliveries completed" value={impact ? <CountUp value={impact.metrics.completedRescues} /> : '–'} href="/runner/impact" />
        <Kpi label="Servings carried" value={impact ? <CountUp value={impact.metrics.servingsDelivered} /> : '–'} />
      </KpiRow>

      {active && (
        <section aria-labelledby="rw-active" className="fl-appear mt-4 rounded-2xl border-2 border-paprika-500 bg-white p-4 shadow-card md:p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 id="rw-active" className="text-xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>{active.listingTitle}</h2>
            <RescueStatusBadge status={active.status} />
          </div>
          <p className="mt-1 text-sm text-stone-700">{active.providerName} → {active.ngoName} · {active.servingsOffered} servings{active.deadlines.pickupBy && active.status === 'PICKUP_ASSIGNED' ? <> · pick up before <TimeLeft deadline={active.deadlines.pickupBy} /></> : null}</p>
          <StageTrack status={active.status} />
          <div className="mt-3 rounded-xl bg-paprika-50 p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-paprika-800">{active.nextAction.party === 'runner' ? 'Your next step' : `Waiting for ${active.nextAction.party ?? 'the system'}`}</p>
            <p className="mt-0.5 text-base font-semibold">{active.nextAction.text}</p>
            <Link href={`/runner/rescues/${active.id}`} className="mt-3 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-paprika-600 px-5 py-3 text-base font-bold text-white hover:bg-paprika-700 sm:w-auto">Open the rescue and act</Link>
          </div>
          {view && <RescueMapSection r={view} role="runner" refreshKey={0} />}
        </section>
      )}

      <Panel title="Jobs you can take" id="rw-jobs" className="mt-4" action={<Link href="/runner/jobs" className={linkCls}>Full job list</Link>}>
        {profile && !available ? <p className="mt-3 text-sm text-stone-700">You are offline, so no jobs are offered. Press <strong>Go available</strong> at the top when you can take one.</p> : <AvailableJobs />}
      </Panel>

      <div className="mt-4">
        <Panel title="Recent activity" id="rw-act" action={<Link href="/notifications" className={linkCls}>All notifications</Link>}>
          {!notes ? <Loadingish /> : <ActivityList notes={notes} role="runner" />}
        </Panel>
      </div>
    </div>
  );
}
