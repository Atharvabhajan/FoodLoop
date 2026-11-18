'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FoodExplorer, type ExplorerOrg, type FeedListing } from '@/components/FoodExplorer';
import { Loading, Shell, StatusBadge, useRoleGuard } from '@/components/Shell';
import { linkCls } from '@/components/ops';
import { FormError, SuccessNote } from '@/components/ui';
import { api, type VerificationStatus } from '@/lib/api';
import { useLiveRefresh } from '@/lib/rescue';
import { FOOD_CATEGORIES, foodCategoryLabels, type EstimateInfo, type FoodCategory, type PublicListing, type RecommendationState, type RecommendedListing } from '@/lib/supply';

type Tab = 'recommended' | 'all';

const stateHelp: Record<Exclude<RecommendationState, 'ACTIVE'>, { title: string; text: string; href: string; link: string }> = {
  NO_REQUIREMENT: { title: 'Set up your food needs', text: 'There is nothing to match against yet. You can still browse all live listings.', href: '/profile#needs', link: 'Set food needs' },
  PAUSED: { title: 'Intake is paused', text: 'No recommendations are shown while intake is paused.', href: '/profile#needs', link: 'Open needs and capacity' },
  WINDOW_ENDED: { title: 'Your availability window ended', text: 'Extend it to receive recommendations again.', href: '/profile#needs', link: 'Extend the window' },
  NO_COORDINATES: { title: 'Your organization has no map location', text: 'Distances cannot be calculated without one.', href: '/profile#organization', link: 'Set the location' },
};

export default function LiveFoodPage() {
  const user = useRoleGuard(['ngo']);
  const [tab, setTab] = useState<Tab>('recommended');
  const [category, setCategory] = useState<FoodCategory | ''>('');
  const [rec, setRec] = useState<{ state: RecommendationState; listings: RecommendedListing[]; estimate: EstimateInfo } | null>(null);
  const [all, setAll] = useState<PublicListing[] | null>(null);
  const [org, setOrg] = useState<ExplorerOrg | null>(null);
  const [radiusKm, setRadiusKm] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<VerificationStatus | 'NONE' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = useCallback((res: { error: { code: string; message: string; details: Record<string, unknown> } }) => {
    if (res.error.code === 'ORGANIZATION_NOT_VERIFIED') setBlocked((res.error.details.verificationStatus as VerificationStatus) ?? 'UNSUBMITTED');
    else if (res.error.code === 'ORGANIZATION_REQUIRED') setBlocked('NONE');
    else setError(res.error.code === 'SPATIAL_UNAVAILABLE' ? 'Recommendations are temporarily unavailable because map support is not ready on the server. You can still browse all live listings.' : res.error.message);
  }, []);

  const load = useCallback(async () => {
    const [r, a] = await Promise.all([
      api<{ state: RecommendationState; listings: RecommendedListing[]; estimate: EstimateInfo }>('/listings/recommended'),
      api<{ listings: PublicListing[] }>(`/listings/feed${category ? `?category=${category}` : ''}`),
    ]);
    if (r.ok) setRec(r.data);
    else fail(r);
    if (a.ok) setAll(a.data.listings);
    else fail(a);
  }, [category, fail]);
  useEffect(() => {
    if (!user) return;
    void load();
    void api<{ organizations: { type: string; name: string; latitude: number | null; longitude: number | null; verificationStatus: string }[] }>('/organizations').then((r) => {
      const o = r.ok ? r.data.organizations.find((x) => x.type === 'NGO' && x.verificationStatus !== 'REJECTED') : undefined;
      setOrg(o && o.latitude !== null && o.longitude !== null ? { latitude: o.latitude, longitude: o.longitude, name: o.name } : null);
    });
    void api<{ requirement: { serviceRadiusKm: number } | null }>('/ngo-requirements/current').then((r) => setRadiusKm(r.ok ? (r.data.requirement?.serviceRadiusKm ?? null) : null));
  }, [user, load]);
  useLiveRefresh(() => void load(), 30_000);

  async function refresh() {
    setBusy(true);
    setNotice(null);
    setError(null);
    const res = await api<{ listingsRecomputed: number }>('/listings/recommended/refresh', { method: 'POST' });
    setBusy(false);
    if (res.ok) {
      setNotice('Recommendations refreshed.');
      await load();
    } else fail(res);
  }

  if (!user) return <Loading label="Restoring your session…" />;

  const listings: FeedListing[] = tab === 'recommended' ? (rec?.state === 'ACTIVE' ? rec.listings : []) : (all ?? []);
  const tabs = (
    <div role="tablist" aria-label="Listing view" className="inline-flex rounded-xl border border-stone-300 bg-white p-0.5">
      {([['recommended', `Recommended for you${rec?.state === 'ACTIVE' ? ` (${rec.listings.length})` : ''}`], ['all', `All live listings${all ? ` (${all.length})` : ''}`]] as const).map(([k, label]) => (
        <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`min-h-10 rounded-lg px-4 py-1.5 text-sm font-semibold ${tab === k ? 'bg-brand-600 text-white' : 'hover:bg-stone-100'}`}>{label}</button>
      ))}
    </div>
  );

  return (
    <Shell
      user={user}
      title="Live surplus food"
      eyebrow="Find food"
      subtitle="Food near you that is still available. Pins and areas are approximate; the exact pickup address is shared once the provider confirms the hand-off."
      actions={tab === 'recommended' && rec?.state === 'ACTIVE' ? <button onClick={() => void refresh()} disabled={busy} className="inline-flex min-h-11 items-center rounded-lg border border-brand-600 bg-white px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-60">{busy ? 'Refreshing…' : 'Refresh recommendations'}</button> : undefined}
      below={!blocked ? tabs : undefined}
    >
      <div className="space-y-2">
        {notice && <SuccessNote>{notice}</SuccessNote>}
        <FormError message={error} />
      </div>

      {blocked && (
        <div role="status" className="fl-appear rounded-2xl border-2 border-amber-500 bg-amber-50 p-5 text-amber-950">
          {blocked !== 'NONE' && <p className="flex flex-wrap items-center gap-2 text-lg font-bold">Your organization is not verified yet <StatusBadge status={blocked} /></p>}
          <p className="mt-1 text-sm">Only verified NGOs can see live listings.</p>
          <Link href="/profile#organization" className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white">Open organization profile</Link>
        </div>
      )}

      {!blocked && tab === 'recommended' && rec && rec.state !== 'ACTIVE' && (
        <div role="status" className="fl-appear mb-4 rounded-2xl border-2 border-zest-300 bg-zest-50 p-5">
          <p className="text-lg font-bold">{stateHelp[rec.state].title}</p>
          <p className="mt-1 text-sm text-stone-800">{stateHelp[rec.state].text}</p>
          <p className="mt-3 flex flex-wrap gap-3">
            <Link href={stateHelp[rec.state].href} className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white">{stateHelp[rec.state].link}</Link>
            <button type="button" onClick={() => setTab('all')} className="inline-flex min-h-11 items-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold">Browse all live listings</button>
          </p>
        </div>
      )}

      {!blocked && (
        <FoodExplorer
          key={tab}
          listings={listings}
          org={org}
          radiusKm={radiusKm}
          estimate={tab === 'recommended' && rec?.state === 'ACTIVE' ? rec.estimate : null}
          onStale={() => void load()}
          loading={tab === 'recommended' ? !rec : !all}
          heading={tab === 'recommended' ? 'Ranked for your needs' : 'Everything live'}
          headingAction={<Link href="/profile#needs" className={linkCls}>Needs and radius</Link>}
          toolbar={
            tab === 'all' ? (
              <>
                <label htmlFor="cat" className="sr-only">Category</label>
                <select id="cat" value={category} onChange={(e) => setCategory(e.target.value as FoodCategory | '')} className="min-h-10 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm">
                  <option value="">All categories</option>
                  {FOOD_CATEGORIES.map((c) => <option key={c} value={c}>{foodCategoryLabels[c]}</option>)}
                </select>
              </>
            ) : undefined
          }
          emptyText={tab === 'recommended' ? 'No live listings match your needs right now. Matching checks categories, dietary needs, capacity, radius, availability and time left. Try "All live listings".' : `No live listings right now${category ? ' in this category' : ''}.`}
        />
      )}
    </Shell>
  );
}
