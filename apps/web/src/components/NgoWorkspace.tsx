'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, type User } from '@/lib/api';
import type { ImpactResponse } from '@/lib/impact';
import { useLiveRefresh, type RescueSummary } from '@/lib/rescue';
import { type EstimateInfo, type RecommendationState, type RecommendedListing, type Requirement } from '@/lib/supply';
import { FoodExplorer } from './FoodExplorer';
import { StatusBadge } from './Shell';
import { fmtDateTime } from './SupplyParts';
import { ActivityList, Band, Kpi, KpiRow, Loadingish, Panel, RescueRow, firstName, greeting, linkCls, useNotes } from './ops';
import { CountUp, FormError, SuccessNote } from './ui';
import type { VerificationStatus } from '@/lib/api';

interface OrgInfo {
  id: string;
  name: string;
  verificationStatus: VerificationStatus;
  latitude: number | null;
  longitude: number | null;
}

const urgentSet = new Set(['URGENT', 'CRITICAL']);

const stateHelp: Record<Exclude<RecommendationState, 'ACTIVE'>, { title: string; text: string; href: string; link: string }> = {
  NO_REQUIREMENT: { title: 'Set up your food needs', text: 'Tell FoodLoop what you can receive so live food can be matched to you.', href: '/profile#needs', link: 'Set food needs' },
  PAUSED: { title: 'Intake is paused', text: 'You will not be offered food until you resume intake.', href: '/profile#needs', link: 'Open needs and capacity' },
  WINDOW_ENDED: { title: 'Your availability window ended', text: 'Extend it to receive recommendations again.', href: '/profile#needs', link: 'Extend the window' },
  NO_COORDINATES: { title: 'Your organization has no map location', text: 'Distances cannot be calculated without a location.', href: '/profile#organization', link: 'Set the location' },
};

export function NgoWorkspace({ user }: { user: User }) {
  const [org, setOrg] = useState<OrgInfo | null | undefined>(undefined);
  const [req, setReq] = useState<Requirement | null | undefined>(undefined);
  const [rec, setRec] = useState<{ state: RecommendationState; listings: RecommendedListing[]; estimate: EstimateInfo } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [rescues, setRescues] = useState<RescueSummary[] | null>(null);
  const [impact, setImpact] = useState<ImpactResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notes = useNotes();

  const load = useCallback(async () => {
    const [o, r, l, s, i] = await Promise.all([
      api<{ organizations: (OrgInfo & { type: string })[] }>('/organizations'),
      api<{ requirement: Requirement | null }>('/ngo-requirements/current'),
      api<{ state: RecommendationState; listings: RecommendedListing[]; estimate: EstimateInfo }>('/listings/recommended'),
      api<{ rescues: RescueSummary[] }>('/rescues?scope=active'),
      api<ImpactResponse>('/impact/me'),
    ]);
    if (o.ok) setOrg(o.data.organizations.find((x) => x.type === 'NGO' && x.verificationStatus !== 'REJECTED') ?? null);
    setReq(r.ok ? r.data.requirement : null);
    if (l.ok) {
      setRec(l.data);
      setBlocked(null);
    } else if (l.error.code === 'ORGANIZATION_NOT_VERIFIED' || l.error.code === 'ORGANIZATION_REQUIRED') setBlocked(l.error.code);
    else setError(l.error.message);
    if (s.ok) setRescues(s.data.rescues);
    if (i.ok) setImpact(i.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), 30_000);

  async function setIntake(enable: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await api(`/ngo-requirements/current/${enable ? 'resume' : 'pause'}`, { method: 'POST' });
    setBusy(false);
    if (res.ok) {
      setNotice(enable ? 'Intake resumed. New matches will appear here.' : 'Intake paused. Your profile is kept.');
      await load();
    } else setError(res.error.message);
  }

  const listings = rec?.state === 'ACTIVE' ? rec.listings : [];
  const here = org && org.latitude !== null && org.longitude !== null ? { latitude: org.latitude, longitude: org.longitude, name: org.name } : null;
  const radiusKm = req?.serviceRadiusKm ?? null;

  const capacity = req?.capacityServings ?? null;
  const committed = (rescues ?? []).reduce((n, r) => n + r.servingsOffered, 0);
  const available = capacity !== null ? Math.max(0, capacity - committed) : null;
  const urgentCount = listings.filter((l) => urgentSet.has(l.urgency)).length;
  const verified = org?.verificationStatus === 'VERIFIED';
  const intake = !req ? 'Needs not set' : !req.intakeEnabled ? 'Intake paused' : !req.active ? 'Window ended' : 'Receiving food';
  const intakeCls = !req ? 'bg-stone-200 text-stone-900' : req.acceptingNow ? 'bg-saffron-300 text-stone-950' : 'bg-stone-200 text-stone-900';

  return (
    <div>
      <Band
        photo="volunteers-serving"
        eyebrow={`${greeting()}, ${firstName(user.name)}`}
        title={org?.name ?? 'Your organization'}
        actions={
          <>
            {req && (req.intakeEnabled ? (
              <button type="button" onClick={() => void setIntake(false)} disabled={busy} className="inline-flex min-h-11 items-center rounded-lg border border-white/50 px-4 py-2 text-sm font-semibold hover:bg-white/10 disabled:opacity-60">Pause intake</button>
            ) : (
              <button type="button" onClick={() => void setIntake(true)} disabled={busy} className="inline-flex min-h-11 items-center rounded-lg bg-saffron-300 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-saffron-200 disabled:opacity-60">Resume intake</button>
            ))}
            <Link href="/profile#needs" className="inline-flex min-h-11 items-center rounded-lg bg-paprika-600 px-4 py-2 text-sm font-semibold text-white hover:bg-paprika-500">Needs and capacity</Link>
          </>
        }
      >
        {org && <span className="rounded-full bg-white px-1 py-0.5"><StatusBadge status={org.verificationStatus} /></span>}
        {org && verified && <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${intakeCls}`}>{intake}</span>}
        {org && !verified && <Link href="/profile#organization" className="font-semibold text-saffron-200 underline">Finish verification to see live food</Link>}
        {req && <span className="text-stone-200">Radius {req.serviceRadiusKm} km · available until {fmtDateTime(req.availableTo)}</span>}
      </Band>

      <KpiRow label="Your numbers">
        <Kpi label="Active rescues" value={rescues ? <CountUp value={rescues.length} /> : '–'} note={rescues && rescues.length > 0 ? `${rescues.filter((r) => r.nextAction.party === 'ngo').length} waiting for you` : 'Nothing in progress'} href="/ngo/rescues" />
        <Kpi label="Servings received" value={impact ? <CountUp value={impact.metrics.servingsDelivered} /> : '–'} note={impact ? `${impact.metrics.completedRescues} completed rescues` : undefined} href="/ngo/impact" />
        <Kpi label="Available capacity" value={available === null ? '–' : <CountUp value={available} />} note={capacity === null ? 'Set your capacity' : `of ${capacity} servings · ${committed} committed`} href="/profile#needs" />
        <Kpi label="Urgent nearby" value={rec ? <CountUp value={urgentCount} /> : '–'} note="urgent or critical listings" tone={urgentCount > 0 ? 'hot' : 'plain'} />
      </KpiRow>

      <div className="mt-3 space-y-2">
        {notice && <SuccessNote>{notice}</SuccessNote>}
        <FormError message={error} />
      </div>

      {blocked && (
        <div role="status" className="fl-appear mt-4 rounded-2xl border-2 border-amber-500 bg-amber-50 p-5 text-amber-950">
          <p className="text-lg font-bold">{blocked === 'ORGANIZATION_REQUIRED' ? 'Create your organization profile' : 'Your organization is not verified yet'}</p>
          <p className="mt-1 text-sm">Only verified NGOs see live food. Complete or check your application on the profile page.</p>
          <Link href="/profile#organization" className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-paprika-600 px-4 py-2 text-sm font-semibold text-white">Open organization profile</Link>
        </div>
      )}

      {!blocked && rec && rec.state !== 'ACTIVE' && (
        <div role="status" className="fl-appear mt-4 rounded-2xl border-2 border-saffron-300 bg-saffron-50 p-5">
          <p className="text-lg font-bold">{stateHelp[rec.state].title}</p>
          <p className="mt-1 text-sm text-stone-800">{stateHelp[rec.state].text}</p>
          <Link href={stateHelp[rec.state].href} className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-paprika-600 px-4 py-2 text-sm font-semibold text-white">{stateHelp[rec.state].link}</Link>
        </div>
      )}

      {!blocked && (
        <FoodExplorer
          listings={listings}
          org={here}
          radiusKm={radiusKm}
          estimate={rec?.state === 'ACTIVE' ? rec.estimate : null}
          onStale={() => void load()}
          loading={!rec}
          headingAction={<Link href="/ngo/listings" className={linkCls}>Full feed</Link>}
        />
      )}

      <div className="stagger mt-6 grid gap-4 lg:grid-cols-2">
        <Panel title="Your active rescues" id="nw-resc" action={<Link href="/ngo/rescues" className={linkCls}>All rescues</Link>}>
          {!rescues ? <Loadingish /> : rescues.length === 0 ? <p className="mt-3 text-sm text-stone-700">No rescues in progress. Accept a listing above to start one.</p> : <ul className="mt-3 space-y-3">{[...rescues].sort((a, b) => Number(b.nextAction.party === 'ngo') - Number(a.nextAction.party === 'ngo')).map((r) => <RescueRow key={r.id} r={r} role="ngo" />)}</ul>}
        </Panel>
        <Panel title="Recent activity" id="nw-act" action={<Link href="/notifications" className={linkCls}>All notifications</Link>}>
          <ActivityList notes={notes} role="ngo" />
        </Panel>
      </div>
    </div>
  );
}
