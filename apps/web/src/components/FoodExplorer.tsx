'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { distanceText, haversineKm } from '@/lib/geo';
import {
  dietaryTagLabels,
  foodCategoryLabels,
  packagingLabels,
  urgencyLabels,
  type EstimateInfo,
  type MatchInfo,
  type PublicListing,
} from '@/lib/supply';
import { AcceptButton } from './AcceptFood';
import { BreakdownTable, EstimateNote, ScoreBadge } from './MatchParts';
import { MapView, type MapMarker } from './MapView';
import { TimeLeft, fmtDateTime } from './SupplyParts';
import { Loadingish, ViewSwitch, linkCls } from './ops';
import { FoodPhoto } from './FoodPhoto';

export type FeedListing = PublicListing & { match?: MatchInfo };
export interface ExplorerOrg {
  latitude: number;
  longitude: number;
  name: string;
}

const urgentSet = new Set(['URGENT', 'CRITICAL']);
const urgencyCls: Record<string, string> = {
  NORMAL: 'border-stone-400 bg-stone-50 text-stone-800',
  PRIORITY: 'border-zest-600 bg-zest-100 text-stone-900',
  URGENT: 'border-orange-600 bg-orange-50 text-orange-900',
  CRITICAL: 'border-red-700 bg-red-50 text-red-900',
};

export function UrgencyChip({ u }: { u: string }) {
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${urgencyCls[u] ?? urgencyCls.NORMAL}`}>{urgencyLabels[u as keyof typeof urgencyLabels] ?? u}</span>;
}

const kmOf = (l: FeedListing, org: ExplorerOrg | null): number | null => {
  if (l.match?.estimatedDistanceKm != null) return l.match.estimatedDistanceKm;
  const { latitude, longitude } = l.approximateArea;
  if (!org || latitude === null || longitude === null) return null;
  return Math.round(haversineKm(org, { latitude, longitude }) * 10) / 10;
};

function Detail({ l, org, onStale, onBack }: { l: FeedListing; org: ExplorerOrg | null; onStale: () => void; onBack: () => void }) {
  const km = kmOf(l, org);
  return (
    <section aria-label={`Details for ${l.title}`} className="fl-appear overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-card">
      <div className="h-44 sm:h-52"><FoodPhoto l={l} className="h-full w-full object-cover" /></div>
      <div className="p-4 md:p-5">
        <button type="button" onClick={onBack} className="mb-2 inline-flex min-h-9 items-center rounded-lg border border-stone-300 px-3 py-1 text-sm font-semibold hover:bg-stone-100 lg:hidden">← Back to the list</button>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>{l.title}</h3>
            <p className="text-sm text-stone-700">{l.providerName} · {l.approximateArea.city} (approximate area)</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {l.match && <ScoreBadge score={l.match.score} rank={l.match.rankAmongCandidates} />}
            <UrgencyChip u={l.urgency} />
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div><dt className="text-xs text-stone-600">Food</dt><dd className="font-semibold">{foodCategoryLabels[l.foodCategory]}</dd></div>
          <div><dt className="text-xs text-stone-600">Servings</dt><dd className="font-semibold">{l.servings}{l.estimatedKg ? ` (~${l.estimatedKg} kg)` : ''}</dd></div>
          <div><dt className="text-xs text-stone-600">Pickup deadline</dt><dd className="font-semibold"><TimeLeft deadline={l.pickupDeadline} urgency={l.urgency} /><span className="block text-xs font-normal text-stone-600">{fmtDateTime(l.pickupDeadline)}</span></dd></div>
          <div><dt className="text-xs text-stone-600">Pickup window opens</dt><dd className="font-semibold">{fmtDateTime(l.pickupStart)}</dd></div>
          <div><dt className="text-xs text-stone-600">Distance (straight line, estimate)</dt><dd className="font-semibold">{km !== null ? `about ${distanceText(km)}` : 'not available'}{l.match?.estimatedTravelMinutes != null ? ` · ~${l.match.estimatedTravelMinutes} min` : ''}</dd></div>
          <div><dt className="text-xs text-stone-600">Packaging · transport</dt><dd className="font-semibold">{packagingLabels[l.packaging]} · {l.transportRequired ? 'transport needed' : 'collect directly'}</dd></div>
          <div className="col-span-2"><dt className="text-xs text-stone-600">Prepared</dt><dd>{fmtDateTime(l.preparedAt)}</dd></div>
          {l.dietaryTags.length > 0 && <div className="col-span-2"><dt className="text-xs text-stone-600">Dietary</dt><dd>{l.dietaryTags.map((t) => dietaryTagLabels[t] ?? t).join(', ')}</dd></div>}
          {l.allergenNotes && <div className="col-span-2"><dt className="text-xs text-stone-600">Allergens</dt><dd>{l.allergenNotes}</dd></div>}
          {l.description && <div className="col-span-2"><dt className="text-xs text-stone-600">Notes from the provider</dt><dd>{l.description}</dd></div>}
        </dl>
        {l.match ? (
          <>
            <h4 className="mt-4 text-sm font-bold">Why it matches you</h4>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-stone-800">{l.match.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            <BreakdownTable breakdown={l.match.breakdown} />
          </>
        ) : (
          <p className="mt-4 text-sm text-stone-700">This listing is shown from the full live feed. It may be outside your needs or radius; accepting still checks your eligibility.</p>
        )}
        <p className="mt-3 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-700">The exact pickup address and contacts are shared after the provider confirms the hand-off. The pin shows only the approximate area (about 1 km).</p>
        <AcceptButton listing={l} onStale={onStale} stretch />
      </div>
    </section>
  );
}

/**
 * Live food list beside an interactive map, with a detail panel. Selecting a row or a pin highlights both and opens the
 * details; on a phone the list and the map/details are two tabs. Used by the NGO dashboard and the Live food page.
 */
export function FoodExplorer({
  listings,
  org,
  radiusKm,
  estimate,
  onStale,
  heading = 'Live food near you',
  headingAction,
  toolbar,
  loading = false,
  emptyText = 'No live listings match your needs right now. New food appears here automatically.',
}: {
  listings: FeedListing[];
  org: ExplorerOrg | null;
  radiusKm: number | null;
  estimate?: EstimateInfo | null;
  onStale: () => void;
  heading?: string;
  headingAction?: ReactNode;
  toolbar?: ReactNode;
  loading?: boolean;
  emptyText?: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'map'>('list');
  const [q, setQ] = useState('');
  const [urg, setUrg] = useState(false);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return listings.filter((l) => (!urg || urgentSet.has(l.urgency)) && (!needle || `${l.title} ${l.providerName} ${foodCategoryLabels[l.foodCategory]}`.toLowerCase().includes(needle)));
  }, [listings, q, urg]);
  const current = listings.find((l) => l.id === selected) ?? null;
  // On a wide screen the first listing is selected so the map highlight and the detail panel are never empty.
  useEffect(() => {
    if ((selected === null || !listings.some((l) => l.id === selected)) && shown.length > 0 && typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches) setSelected(shown[0]!.id);
  }, [shown, selected, listings]);

  const markers: MapMarker[] = [];
  for (const l of shown) {
    const { latitude, longitude } = l.approximateArea;
    if (latitude === null || longitude === null) continue;
    const km = kmOf(l, org);
    markers.push({ id: l.id, kind: urgentSet.has(l.urgency) ? 'urgent' : 'listing', latitude, longitude, label: l.title, approximate: true, popup: { title: l.title, lines: [`${l.servings} servings · ${urgencyLabels[l.urgency]}`, ...(km !== null ? [`About ${distanceText(km)} (straight line)`] : [])] } });
  }
  if (org) markers.push({ id: 'org', kind: 'org', latitude: org.latitude, longitude: org.longitude, label: org.name, popup: { title: org.name, lines: ['Your organization'] } });

  return (
    <>
      <ViewSwitch value={view} onChange={setView} labels={[`Food list (${shown.length})`, 'Map and details']} />
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(340px,0.9fr)_minmax(0,1.5fr)]">
        <section aria-labelledby="fx-h" className={`${view === 'list' ? 'block' : 'hidden'} lg:block`}>
          <div className="flex flex-wrap items-end gap-2">
            <h2 id="fx-h" className="mr-auto text-lg font-bold">{heading}</h2>
            {headingAction}
          </div>
          <form role="search" aria-label="Filter live food" onSubmit={(e) => e.preventDefault()} className="mt-2 flex flex-wrap items-center gap-2">
            <label htmlFor="fx-q" className="sr-only">Search live food</label>
            <input id="fx-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search food or provider" className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm hover:border-stone-400" />
            <button type="button" aria-pressed={urg} onClick={() => setUrg((u) => !u)} className={`min-h-10 rounded-lg border px-3 py-1.5 text-sm font-semibold ${urg ? 'border-brand-600 bg-brand-600 text-white' : 'border-stone-300 bg-white hover:bg-stone-100'}`}>Urgent only</button>
            {toolbar}
          </form>
          {loading && <Loadingish />}
          {!loading && shown.length === 0 && (
            <p className="fl-appear mt-3 rounded-2xl border border-dashed border-stone-300 bg-white/70 p-5 text-center text-sm text-stone-700">{listings.length === 0 ? emptyText : 'Nothing matches this search.'}</p>
          )}
          <ul className="mt-3 space-y-3 lg:max-h-[46rem] lg:overflow-y-auto lg:pr-1">
            {shown.map((l) => {
              const km = kmOf(l, org);
              return (
                <li key={l.id} id={`listing-${l.id}`} className={`lift flex overflow-hidden rounded-2xl border-2 bg-white shadow-card ${selected === l.id ? 'border-zest-400 ring-2 ring-zest-300' : 'border-stone-200'}`}>
                  <button type="button" onClick={() => { setSelected(l.id); setView('map'); }} aria-pressed={selected === l.id} aria-label={`Show details and map position for ${l.title}`} className="flex min-w-0 flex-1 text-left">
                    <span className="block w-24 shrink-0 sm:w-28"><FoodPhoto l={l} className="h-full min-h-28 w-full object-cover" /></span>
                    <span className="block min-w-0 flex-1 p-3">
                      <span className="flex flex-wrap items-start justify-between gap-1">
                        <span className="font-bold">{l.title}</span>
                        <UrgencyChip u={l.urgency} />
                      </span>
                      <span className="mt-0.5 block text-xs text-stone-700">{foodCategoryLabels[l.foodCategory]} · {l.servings} servings · {l.providerName}</span>
                      <span className="mt-1 block text-xs text-stone-800">
                        <TimeLeft deadline={l.pickupDeadline} urgency={l.urgency} />
                        {km !== null ? ` · about ${distanceText(km)}` : ''}
                        {l.match ? ` · match ${Math.round(l.match.score ?? 0)}/100` : ''}
                      </span>
                      {l.match?.reasons[0] && <span className="mt-1 block text-xs text-stone-600">{l.match.reasons[0]}</span>}
                    </span>
                  </button>
                  <div className="flex items-center pr-3"><AcceptButton listing={l} onStale={onStale} label="Accept" ariaLabel="Accept this food" /></div>
                </li>
              );
            })}
          </ul>
          {estimate && <div className="mt-2"><EstimateNote estimate={estimate} /></div>}
        </section>

        <div className={`${view === 'map' ? 'block' : 'hidden'} space-y-4 lg:block`}>
          <section aria-label="Map of live food" className="rounded-2xl border border-stone-200 bg-white p-3 shadow-card">
            <MapView
              title="Live food near your organization"
              height={380}
              markers={markers}
              circles={org && radiusKm ? [{ latitude: org.latitude, longitude: org.longitude, radiusKm, label: `Your service radius: ${radiusKm} km` }] : []}
              selectedId={selected}
              highlightId={selected}
              onSelect={(id) => { if (id !== 'org') { setSelected(id); document.getElementById(`listing-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }}
              popups={false}
              recenterTo={org ? { latitude: org.latitude, longitude: org.longitude, label: 'my organization' } : null}
            />
            {!org && <p className="mt-2 text-sm text-stone-700">Your organization has no map location yet. <Link href="/profile#organization" className={linkCls}>Set it</Link> to see distances and your radius.</p>}
            <p className="mt-1 text-xs text-stone-600">Food pins are approximate areas (about 1 km). Click a pin or a listing to see it here.</p>
          </section>
          {current ? (
            <Detail l={current} org={org} onStale={onStale} onBack={() => setView('list')} />
          ) : (
            <p className="rounded-2xl border border-dashed border-stone-300 bg-white/70 p-5 text-center text-sm text-stone-700">Select a listing or a map pin to see the food, the match reasons and the Accept action.</p>
          )}
        </div>
      </div>
    </>
  );
}
