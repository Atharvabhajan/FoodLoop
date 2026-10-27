'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, type Organization, type User } from '@/lib/api';
import type { ImpactResponse } from '@/lib/impact';
import { useLiveRefresh, type RescueSummary } from '@/lib/rescue';
import type { Listing } from '@/lib/supply';
import { ListingExplorer } from './ListingExplorer';
import { StatusBadge } from './Shell';
import { ActivityList, Band, Kpi, KpiRow, Loadingish, Panel, RescueRow, firstName, greeting, linkCls, useNotes } from './ops';
import { CountUp } from './ui';

/** Provider workspace: listings are the main task, with a map of the pickup points and what needs the provider now. */
export function ProviderWorkspace({ user }: { user: User }) {
  const [org, setOrg] = useState<Organization | null>(null);
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [rescues, setRescues] = useState<RescueSummary[] | null>(null);
  const [impact, setImpact] = useState<ImpactResponse | null>(null);
  const notes = useNotes();

  const load = useCallback(async () => {
    const [o, l, r, i] = await Promise.all([
      api<{ organizations: Organization[] }>('/organizations'),
      api<{ listings: Listing[] }>('/listings?scope=active'),
      api<{ rescues: RescueSummary[] }>('/rescues?scope=active'),
      api<ImpactResponse>('/impact/me'),
    ]);
    if (o.ok) setOrg(o.data.organizations.find((x) => x.verificationStatus !== 'REJECTED') ?? null);
    if (l.ok) setListings(l.data.listings);
    if (r.ok) setRescues(r.data.rescues);
    if (i.ok) setImpact(i.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), 30_000);

  const live = (listings ?? []).filter((l) => l.status === 'AVAILABLE');
  const mine = (rescues ?? []).filter((r) => r.nextAction.party === 'provider');
  const servingsLive = live.reduce((n, l) => n + l.servings, 0);
  const verified = org?.verificationStatus === 'VERIFIED';

  return (
    <div>
      <Band
        photo="provider-kitchen"
        eyebrow={`${greeting()}, ${firstName(user.name)}`}
        title={org?.name ?? 'Your kitchen'}
        actions={
          <Link href="/provider/listings/new" className="inline-flex min-h-12 items-center rounded-xl bg-saffron-300 px-6 py-3 text-base font-bold text-stone-950 shadow-lift hover:bg-saffron-200">Post surplus food</Link>
        }
      >
        {org && <span className="rounded-full bg-white px-0.5"><StatusBadge status={org.verificationStatus} /></span>}
        {org && !verified && <Link href="/profile#organization" className="font-semibold text-saffron-200 underline">Finish verification to publish listings</Link>}
        {verified && <span className="text-stone-200">Verified: listings you publish reach nearby NGOs.</span>}
      </Band>

      <KpiRow label="Your numbers">
        <Kpi label="Live listings" value={listings ? <CountUp value={live.length} /> : '–'} note={listings ? `${(listings ?? []).length - live.length} draft${(listings ?? []).length - live.length === 1 ? '' : 's'}` : undefined} href="/provider/listings" />
        <Kpi label="Servings on offer" value={listings ? <CountUp value={servingsLive} /> : '–'} note="in live listings" />
        <Kpi label="Active rescues" value={rescues ? <CountUp value={rescues.length} /> : '–'} note={mine.length > 0 ? `${mine.length} waiting for you` : 'Nothing waiting for you'} tone={mine.length > 0 ? 'hot' : 'plain'} href="/provider/rescues" />
        <Kpi label="Servings delivered" value={impact ? <CountUp value={impact.metrics.servingsDelivered} /> : '–'} note={impact ? `${impact.metrics.completedRescues} completed rescues` : undefined} href="/provider/impact" />
      </KpiRow>

      {mine.length > 0 && (
        <section aria-labelledby="pw-attn" className="fl-appear mt-4 rounded-2xl border-2 border-paprika-500 bg-paprika-50 p-4 md:p-5">
          <h2 id="pw-attn" className="text-lg font-bold">Needs your attention</h2>
          <ul className="mt-3 grid gap-3 md:grid-cols-2">{mine.map((r) => <RescueRow key={r.id} r={r} role="provider" />)}</ul>
        </section>
      )}

      <ListingExplorer listings={listings} headingAction={<Link href="/provider/listings" className={linkCls}>Manage all</Link>} />

      <div className="stagger mt-6 grid gap-4 lg:grid-cols-2">
        <Panel title="Rescues in progress" id="pw-resc" action={<Link href="/provider/rescues" className={linkCls}>All rescues</Link>}>
          {!rescues ? <Loadingish /> : rescues.length === 0 ? <p className="mt-3 text-sm text-stone-700">No rescues yet. When an NGO accepts your food it appears here with the next step.</p> : <ul className="mt-3 space-y-3">{rescues.map((r) => <RescueRow key={r.id} r={r} role="provider" />)}</ul>}
        </Panel>
        <Panel title="Recent activity" id="pw-act" action={<Link href="/notifications" className={linkCls}>All notifications</Link>}>
          <ActivityList notes={notes} role="provider" />
        </Panel>
      </div>
    </div>
  );
}
