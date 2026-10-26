'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { BreakdownTable, DistanceTime, EstimateNote, ScoreBadge } from '@/components/MatchParts';
import { Loading, Shell, StatusBadge, useRoleGuard } from '@/components/Shell';
import { TimeLeft, fmtDateTime } from '@/components/SupplyParts';
import { AcceptButton } from '@/components/AcceptFood';
import { FormError, Photo } from '@/components/ui';
import { MapView, type MapMarker } from '@/components/MapView';
import { distanceText, haversineKm } from '@/lib/geo';
import { api, type VerificationStatus } from '@/lib/api';
import {
  FOOD_CATEGORIES,
  dietaryTagLabels,
  stockPhoto,
  foodCategoryLabels,
  listingImageUrl,
  packagingLabels,
  type EstimateInfo,
  type FoodCategory,
  type PublicListing,
  type RecommendationState,
  urgencyLabels,
  type RecommendedListing,
} from '@/lib/supply';

type Tab = 'recommended' | 'all';

const stateHelp: Record<Exclude<RecommendationState, 'ACTIVE'>, { text: string; href: string; link: string }> = {
  NO_REQUIREMENT: { text: 'You have not set up your food needs yet, so there is nothing to match against.', href: '/ngo/requirements', link: 'Set up food needs' },
  PAUSED: { text: 'Intake is paused, so no recommendations are shown. Resume intake to see matching food again.', href: '/ngo/requirements', link: 'Go to food needs' },
  WINDOW_ENDED: { text: 'Your availability window has ended. Extend it to receive recommendations again.', href: '/ngo/requirements', link: 'Extend the window' },
  NO_COORDINATES: { text: 'Your organization has no map coordinates, so distances cannot be calculated. Add latitude and longitude to your profile.', href: '/organization', link: 'Open organization profile' },
};

function Meta({ l }: { l: PublicListing }) {
  return (
    <>
      <p className="mt-1 text-sm text-stone-700">{l.providerName} · {l.approximateArea.city} (approximate area)</p>
      <p className="mt-1 text-sm">
        {foodCategoryLabels[l.foodCategory]} · <strong>{l.servings} servings</strong>
        {l.estimatedKg ? ` (~${l.estimatedKg} kg)` : ''} · {packagingLabels[l.packaging]} · {l.transportRequired ? 'Transport needed' : 'Collect directly'}
      </p>
      {l.dietaryTags.length > 0 && <p className="mt-1 text-sm text-stone-700">{l.dietaryTags.map((t) => dietaryTagLabels[t] ?? t).join(', ')}</p>}
      {l.allergenNotes && <p className="mt-1 text-sm text-stone-700">Allergens: {l.allergenNotes}</p>}
      {l.description && <p className="mt-1 text-sm text-stone-700">{l.description}</p>}
      <p className="mt-2 text-xs text-stone-600">Prepared {fmtDateTime(l.preparedAt)} · Pickup {fmtDateTime(l.pickupStart)} to {fmtDateTime(l.pickupDeadline)}</p>
    </>
  );
}

function Card({ l, children, badge, selected, onShowOnMap }: { l: PublicListing; children?: React.ReactNode; badge?: React.ReactNode; selected?: boolean; onShowOnMap?: (id: string) => void }) {
  return (
    <li id={`listing-${l.id}`} className={`${selected ? 'ring-4 ring-saffron-300 ' : ''}lift overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-card sm:flex`}>
      <div className="relative overflow-hidden sm:w-56 sm:flex-none">
        {l.hasImage ? (
          <img src={listingImageUrl(l.id)} alt={`Photo of ${l.title}`} className="h-44 w-full object-cover sm:h-full" />
        ) : (
          <Photo name={stockPhoto(l.title, l.foodCategory)} className="h-44 w-full object-cover sm:h-full" decorative />
        )}
        {!l.hasImage && <span className="absolute bottom-2 left-2 rounded bg-stone-900/80 px-2 py-0.5 text-xs font-medium text-white">Illustrative photo</span>}
      </div>
      <div className="flex-1 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-lg font-semibold">{l.title}</h2>
          <div className="flex flex-wrap items-center gap-2">
            {badge}
            <span className="rounded-full border border-stone-400 bg-stone-50 px-2.5 py-0.5 text-sm"><TimeLeft deadline={l.pickupDeadline} urgency={l.urgency} /></span>
          </div>
        </div>
        <Meta l={l} />
        {onShowOnMap && l.approximateArea.latitude !== null && (
          <button type="button" onClick={() => onShowOnMap(l.id)} className="mt-2 inline-flex min-h-9 items-center rounded-lg border border-stone-300 bg-white px-3 py-1 text-sm font-semibold hover:bg-stone-100">Show on map</button>
        )}
        {children}
      </div>
    </li>
  );
}

function FeedMap({ listings, org, radiusKm, selectedId, onSelect, distances }: { listings: PublicListing[]; org: { latitude: number; longitude: number; name: string } | null; radiusKm: number | null; selectedId: string | null; onSelect: (id: string) => void; distances?: Map<string, number | null> }) {
  const markers: MapMarker[] = [];
  for (const l of listings) {
    const { latitude, longitude, city } = l.approximateArea;
    if (latitude === null || longitude === null) continue;
    const km = distances?.get(l.id) ?? (org ? haversineKm(org, { latitude, longitude }) : null);
    const rec = l as Partial<RecommendedListing>;
    markers.push({
      id: l.id,
      kind: l.urgency === 'CRITICAL' || l.urgency === 'URGENT' ? 'urgent' : 'listing',
      latitude,
      longitude,
      label: l.title,
      approximate: true,
      popup: {
        title: l.title,
        lines: [
          `${l.providerName} · ${city}`,
          `${l.servings} servings · ${urgencyLabels[l.urgency]}`,
          ...(km !== null && km !== undefined ? [`About ${distanceText(km)} away (straight-line estimate)`] : []),
          ...(rec.match ? [`Match ${Math.round(rec.match.score ?? 0)} / 100`, ...rec.match.reasons.slice(0, 2)] : []),
        ],
        href: `#listing-${l.id}`,
        hrefLabel: 'Jump to this listing',
      },
    });
  }
  if (org) markers.push({ id: 'org', kind: 'org', latitude: org.latitude, longitude: org.longitude, label: org.name, popup: { title: org.name, lines: ['Your organization'] } });
  return (
    <div className="mt-4">
      <MapView
        title="Map of live food near you"
        height={340}
        markers={markers}
        circles={org && radiusKm ? [{ latitude: org.latitude, longitude: org.longitude, radiusKm, label: `Your service radius: ${radiusKm} km` }] : []}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      {listings.length > 0 && markers.filter((m) => m.id !== 'org').length === 0 && <p className="mt-1 text-sm text-stone-700">These listings have no map position, so only the list is available.</p>}
      <p className="mt-1 text-xs text-stone-600">Food pins show only the approximate area (about 1 km). Exact addresses and contacts are shared after a rescue is confirmed.</p>
    </div>
  );
}

export default function LiveFoodPage() {
  const user = useRoleGuard(['ngo']);
  const [tab, setTab] = useState<Tab>('recommended');
  const [category, setCategory] = useState<FoodCategory | ''>('');
  const [all, setAll] = useState<PublicListing[] | null>(null);
  const [rec, setRec] = useState<{ state: RecommendationState; listings: RecommendedListing[]; estimate: EstimateInfo } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<VerificationStatus | 'NONE' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [org, setOrg] = useState<{ latitude: number; longitude: number; name: string } | null>(null);
  const [radiusKm, setRadiusKm] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const fail = useCallback((res: { error: { code: string; message: string; details: Record<string, unknown> } }) => {
    if (res.error.code === 'ORGANIZATION_NOT_VERIFIED') setBlocked((res.error.details.verificationStatus as VerificationStatus) ?? 'UNSUBMITTED');
    else if (res.error.code === 'ORGANIZATION_REQUIRED') setBlocked('NONE');
    else setError(res.error.code === 'SPATIAL_UNAVAILABLE' ? 'Recommendations are temporarily unavailable because map support is not ready on the server. You can still browse all live listings.' : res.error.message);
  }, []);

  const loadRec = useCallback(async () => {
    const res = await api<{ state: RecommendationState; listings: RecommendedListing[]; estimate: EstimateInfo }>('/listings/recommended');
    if (res.ok) setRec(res.data);
    else fail(res);
  }, [fail]);

  useEffect(() => {
    if (!user) return;
    setError(null);
    setBlocked(null);
    if (tab === 'recommended') {
      setRec(null);
      void loadRec();
    } else {
      setAll(null);
      let cancelled = false;
      api<{ listings: PublicListing[] }>(`/listings/feed${category ? `?category=${category}` : ''}`).then((res) => {
        if (cancelled) return;
        if (res.ok) setAll(res.data.listings);
        else fail(res);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [user, tab, category, loadRec, fail]);

  async function refresh() {
    setBusy(true);
    setNotice(null);
    setError(null);
    const res = await api<{ listingsRecomputed: number }>('/listings/recommended/refresh', { method: 'POST' });
    setBusy(false);
    if (res.ok) {
      setNotice('Recommendations refreshed.');
      await loadRec();
    } else fail(res);
  }

  useEffect(() => {
    if (!user) return;
    void api<{ organizations: { type: string; name: string; latitude: number | null; longitude: number | null; verificationStatus: string }[] }>('/organizations').then((r) => {
      const o = r.ok ? r.data.organizations.find((x) => x.type === 'NGO' && x.verificationStatus === 'VERIFIED') : undefined;
      setOrg(o && o.latitude !== null && o.longitude !== null ? { latitude: o.latitude, longitude: o.longitude, name: o.name } : null);
    });
    void api<{ requirement: { serviceRadiusKm: number } | null }>('/ngo-requirements/current').then((r) => setRadiusKm(r.ok ? (r.data.requirement?.serviceRadiusKm ?? null) : null));
  }, [user]);
  const showOnMap = (id: string) => {
    setSelected(null);
    setTimeout(() => setSelected(id), 0);
    document.getElementById('feed-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const pickFromMap = (id: string) => {
    if (id === 'org') return;
    setSelected(id);
    document.getElementById(`listing-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  if (!user) return <Loading label="Restoring your session…" />;

  return (
    <Shell user={user} title="Live surplus food">
      <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Accept a recommended listing to reserve it; the provider then confirms the hand-off. Exact pickup addresses stay hidden until the provider confirms.
      </p>

      {blocked && (
        <div role="status" className="mt-4 rounded-md border border-amber-500 bg-amber-50 p-4 text-sm text-amber-950">
          {blocked !== 'NONE' && <p className="flex flex-wrap items-center gap-2 font-semibold">Your organization is not verified yet: <StatusBadge status={blocked} /></p>}
          <p className="mt-1">Only verified NGOs can see live listings. <Link href="/organization" className="font-medium underline">Go to your organization page</Link>.</p>
        </div>
      )}

      {!blocked && (
        <>
          <div role="tablist" aria-label="Listing view" className="mt-4 inline-flex rounded-md border border-stone-300 bg-white p-0.5">
            {([['recommended', 'Recommended for you'], ['all', 'All live listings']] as const).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded px-4 py-1.5 text-sm font-medium ${tab === k ? 'bg-paprika-600 text-white' : 'hover:bg-stone-100'}`}>{label}</button>
            ))}
          </div>
          <div className="mt-4"><FormError message={error} /></div>
          {notice && <p role="status" className="mt-2 text-sm font-medium text-green-800">✓ {notice}</p>}

          {tab === 'recommended' && (
            <>
              {!rec && !error && <Loading label="Loading recommendations…" />}
              {rec && rec.state !== 'ACTIVE' && (
                <div role="status" className="mt-2 rounded-md border border-stone-300 bg-white p-4 text-sm">
                  <p className="font-semibold">{rec.state === 'PAUSED' ? 'Intake paused' : rec.state === 'WINDOW_ENDED' ? 'Availability window ended' : rec.state === 'NO_COORDINATES' ? 'Location missing' : 'Food needs not set up'}</p>
                  <p className="mt-1">{stateHelp[rec.state].text}</p>
                  <Link href={stateHelp[rec.state].href} className="mt-2 inline-block font-medium text-paprika-700 underline">{stateHelp[rec.state].link}</Link>
                </div>
              )}
              {rec && rec.state === 'ACTIVE' && (
                <>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-stone-700">Ranked by distance, time feasibility, quantity fit, need and reliability.</p>
                    <button onClick={() => void refresh()} disabled={busy} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-paprika-600 px-4 py-1.5 text-sm font-semibold text-paprika-700 hover:bg-paprika-50 disabled:opacity-60">{busy ? 'Refreshing…' : 'Refresh recommendations'}</button>
                  </div>
                  <EstimateNote estimate={rec.estimate} />
                  <div id="feed-map"><FeedMap listings={rec.listings} org={org} radiusKm={radiusKm} selectedId={selected} onSelect={pickFromMap} distances={new Map(rec.listings.map((l) => [l.id, l.match.estimatedDistanceKm]))} /></div>
                  {rec.listings.length === 0 ? (
                    <p className="mt-4 rounded-md border border-dashed border-stone-300 p-6 text-center text-stone-700">
                      No live listings match your needs right now. Matching checks your categories, dietary needs, capacity, service radius, availability window and the time left to collect. Try refreshing, or browse all live listings.
                    </p>
                  ) : (
                    <ol className="mt-4 space-y-4">
                      {rec.listings.map((l, i) => (
                        <Card key={l.id} l={l} selected={selected === l.id} onShowOnMap={showOnMap} badge={<ScoreBadge score={l.match.score} rank={i + 1} />}>
                          <DistanceTime km={l.match.estimatedDistanceKm} travelMinutes={l.match.estimatedTravelMinutes} marginMinutes={l.match.estimatedMarginMinutes} />
                          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-stone-800">
                            {l.match.reasons.map((r) => <li key={r}>{r}</li>)}
                          </ul>
                          <BreakdownTable breakdown={l.match.breakdown} />
                          <AcceptButton listing={l} onStale={() => void loadRec()} />
                        </Card>
                      ))}
                    </ol>
                  )}
                </>
              )}
            </>
          )}

          {tab === 'all' && (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <label htmlFor="cat" className="text-sm font-medium">Category</label>
                <select id="cat" value={category} onChange={(e) => setCategory(e.target.value as FoodCategory | '')} className="rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm">
                  <option value="">All categories</option>
                  {FOOD_CATEGORIES.map((c) => <option key={c} value={c}>{foodCategoryLabels[c]}</option>)}
                </select>
              </div>
              {!all && !error && <Loading label="Loading live listings…" />}
              {all && all.length === 0 && (
                <p className="mt-4 rounded-md border border-dashed border-stone-300 p-6 text-center text-stone-700">
                  No live listings right now{category ? ' in this category' : ''}. Expired and cancelled listings are never shown.
                </p>
              )}
              {all && all.length > 0 && <div id="feed-map"><FeedMap listings={all} org={org} radiusKm={radiusKm} selectedId={selected} onSelect={pickFromMap} /></div>}
              {all && all.length > 0 && <ul className="mt-4 space-y-4">{all.map((l) => <Card key={l.id} l={l} selected={selected === l.id} onShowOnMap={showOnMap} />)}</ul>}
            </>
          )}
        </>
      )}
    </Shell>
  );
}
