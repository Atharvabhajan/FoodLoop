'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { foodCategoryLabels, listingImageUrl, stockPhoto, type Listing } from '@/lib/supply';
import { MapView, type MapMarker } from './MapView';
import { ListingStatusBadge, TimeLeft } from './SupplyParts';
import { Loadingish, ViewSwitch, linkCls } from './ops';
import { Photo } from './ui';

type Filter = 'all' | 'live' | 'draft';

/** A provider's listings beside a map of their pickup points. Used on the dashboard and on the Listings page. */
export function ListingExplorer({ listings, heading = 'Your listings', headingAction }: { listings: Listing[] | null; heading?: string; headingAction?: ReactNode }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'map'>('list');

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (listings ?? []).filter((l) => (filter === 'all' || (filter === 'live' ? l.status === 'AVAILABLE' : l.status === 'DRAFT')) && (!needle || `${l.title} ${foodCategoryLabels[l.foodCategory]}`.toLowerCase().includes(needle)));
  }, [listings, filter, q]);
  const markers: MapMarker[] = shown.flatMap((l) =>
    l.latitude !== null && l.longitude !== null
      ? [{ id: l.id, kind: (l.urgency === 'URGENT' || l.urgency === 'CRITICAL' ? 'urgent' : 'pickup') as MapMarker['kind'], latitude: l.latitude, longitude: l.longitude, label: l.title, popup: { title: l.title, lines: [`${l.servings} servings`, l.status === 'AVAILABLE' ? 'Live' : 'Draft'], href: `/provider/listings/${l.id}`, hrefLabel: 'Open listing' } }]
      : [],
  );

  return (
    <>
      <ViewSwitch value={view} onChange={setView} labels={['Listings', 'Map']} />
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,1fr)]">
        <section aria-labelledby="pw-list" className={`${view === 'list' ? 'block' : 'hidden'} lg:block`}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="pw-list" className="mr-auto text-lg font-bold">{heading}</h2>
            {headingAction}
          </div>
          <form role="search" aria-label="Filter listings" onSubmit={(e) => e.preventDefault()} className="mt-2 flex flex-wrap items-center gap-2">
            <label htmlFor="pw-q" className="sr-only">Search listings</label>
            <input id="pw-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search listings" className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm hover:border-stone-400" />
            <div role="group" aria-label="Show" className="inline-flex rounded-lg border border-stone-300 bg-white p-0.5">
              {([['all', 'All'], ['live', 'Live'], ['draft', 'Drafts']] as const).map(([k, label]) => (
                <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={`min-h-9 rounded-md px-3 text-sm font-semibold ${filter === k ? 'bg-paprika-600 text-white' : 'hover:bg-stone-100'}`}>{label}</button>
              ))}
            </div>
          </form>
          {!listings && <Loadingish />}
          {listings && shown.length === 0 && (
            <div className="fl-appear mt-3 rounded-2xl border border-dashed border-stone-300 bg-white/70 p-6 text-center">
              <p className="font-semibold">{listings.length === 0 ? 'No listings yet' : 'Nothing matches'}</p>
              <p className="mt-1 text-sm text-stone-700">{listings.length === 0 ? 'Post surplus food in a minute and nearby NGOs are told.' : 'Try another filter or search.'}</p>
              {listings.length === 0 && <Link href="/provider/listings/new" className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-paprika-600 px-4 py-2 text-sm font-semibold text-white">Post surplus food</Link>}
            </div>
          )}
          <ul className="mt-3 space-y-3">
            {shown.map((l) => (
              <li key={l.id} className={`lift flex overflow-hidden rounded-2xl border-2 bg-white shadow-card ${selected === l.id ? 'border-saffron-400 ring-2 ring-saffron-300' : 'border-stone-200'}`}>
                <div className="relative hidden w-28 shrink-0 sm:block">
                  {l.hasImage ? (
                    <img src={listingImageUrl(l.id)} alt={`Photo of ${l.title}`} className="h-full w-full object-cover" />
                  ) : (
                    <>
                      <Photo name={stockPhoto(l.title, l.foodCategory)} decorative className="h-full w-full object-cover" />
                      <span className="absolute bottom-1 left-1 rounded bg-stone-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">Illustrative photo</span>
                    </>
                  )}
                </div>
                <div className="min-w-0 flex-1 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <Link href={`/provider/listings/${l.id}`} className="font-bold underline-offset-2 hover:underline">{l.title}</Link>
                    <ListingStatusBadge status={l.status} />
                  </div>
                  <p className="mt-0.5 text-sm text-stone-700">{foodCategoryLabels[l.foodCategory]} · {l.servings} servings · {l.city}</p>
                  <p className="mt-1 text-sm">{l.status === 'AVAILABLE' ? <>Pickup deadline: <TimeLeft deadline={l.pickupDeadline} urgency={l.urgency} /></> : 'Draft: not visible to NGOs yet'}</p>
                  <p className="mt-2 flex flex-wrap gap-3 text-sm">
                    <Link href={`/provider/listings/${l.id}`} className={linkCls}>{l.status === 'AVAILABLE' ? 'Matches and details' : 'Edit and publish'}</Link>
                    {l.latitude !== null && <button type="button" onClick={() => { setSelected(l.id); setView('map'); }} className={linkCls}>Show on map</button>}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <div className={`${view === 'map' ? 'block' : 'hidden'} lg:block`}>
          <section aria-label="Map of your pickup points" className="rounded-2xl border border-stone-200 bg-white p-3 shadow-card lg:sticky lg:top-28">
            <MapView title="Your pickup points" height={360} markers={markers} selectedId={selected} highlightId={selected} onSelect={(id) => setSelected(id)} />
            <p className="mt-1 text-xs text-stone-600">Only you and admins see these exact points. NGOs see an area rounded to about 1 km until a rescue is confirmed.</p>
          </section>
        </div>
      </div>
    </>
  );
}
