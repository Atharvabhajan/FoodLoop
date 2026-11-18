'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { actorLabels, durationText, bucketLabels, type BoardListings, type BoardRescue, type BoardRescues } from '@/lib/board';
import { statusLabels, useLiveRefresh } from '@/lib/rescue';
import { foodCategoryLabels, urgencyLabels, type FoodCategory } from '@/lib/supply';
import { MapView, type MapMarker } from './MapView';
import { TimeLeft } from './SupplyParts';
import { FormError, Skeleton } from './ui';

type RescueScope = 'open' | 'delayed' | 'blocked' | 'none';
type Urg = '' | 'CRITICAL' | 'URGENT' | 'PRIORITY' | 'NORMAL';

/**
 * Operations map: open rescues and live unaccepted listings, with filters. Positions are the coarse (about 1 km) area points the
 * board API returns; the exact address and contacts are only on each rescue's own page, linked from every popup and list row.
 * Nothing here changes data.
 */
export function OpsMap() {
  const [rescues, setRescues] = useState<BoardRescue[] | null>(null);
  const [listings, setListings] = useState<BoardListings['listings'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<RescueScope>('open');
  const [urgency, setUrgency] = useState<Urg>('');
  const [showListings, setShowListings] = useState(true);
  const [showDest, setShowDest] = useState(true);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, d, l] = await Promise.all([
      api<BoardRescues>('/admin/board/rescues?state=active&pageSize=100&sort=attention'),
      api<BoardRescues>('/admin/board/rescues?state=delayed&pageSize=100&sort=attention'),
      api<BoardListings>('/admin/board/listings?scope=live&pageSize=100'),
    ]);
    if (a.ok && d.ok && l.ok) {
      setRescues([...d.data.rescues, ...a.data.rescues]);
      setListings(l.data.listings);
      setError(null);
    } else setError((!a.ok && a.error.message) || (!d.ok && d.error.message) || (!l.ok && l.error.message) || 'Could not load the map data.');
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), 30_000);

  const needle = q.trim().toLowerCase();
  const visibleRescues = useMemo(
    () =>
      (rescues ?? []).filter((r) => {
        if (scope === 'none') return false;
        if (scope === 'delayed' && r.state !== 'delayed') return false;
        if (scope === 'blocked' && !r.blocked) return false;
        return !needle || `${r.listing.title} ${r.provider.name} ${r.ngo.name}`.toLowerCase().includes(needle);
      }),
    [rescues, scope, needle],
  );
  const visibleListings = useMemo(
    () =>
      showListings
        ? (listings ?? []).filter((l) => (!urgency || l.urgency === urgency) && (!needle || `${l.title} ${l.provider.name}`.toLowerCase().includes(needle)))
        : [],
    [listings, showListings, urgency, needle],
  );

  const markers: MapMarker[] = [];
  for (const r of visibleRescues) {
    if (r.area.latitude !== null && r.area.longitude !== null) {
      markers.push({
        id: `r-${r.id}`,
        kind: 'pickup',
        latitude: r.area.latitude,
        longitude: r.area.longitude,
        label: r.listing.title,
        approximate: true,
        popup: {
          title: r.listing.title,
          lines: [
            `${r.provider.name} to ${r.ngo.name}`,
            `${bucketLabels[r.state].label}: ${statusLabels[r.status].label}`,
            `Next${r.stage.nextActor ? ` (${actorLabels[r.stage.nextActor]})` : ''}: ${r.stage.nextAction}`,
            ...(r.delay ? [`Delayed: ${r.delay.text}`] : []),
          ],
          href: r.links.rescue,
          hrefLabel: 'Open rescue, history and actions',
        },
      });
    }
    if (showDest && r.ngoArea.latitude !== null && r.ngoArea.longitude !== null) {
      markers.push({
        id: `n-${r.id}`,
        kind: 'ngo',
        latitude: r.ngoArea.latitude,
        longitude: r.ngoArea.longitude,
        label: `${r.ngo.name} (destination)`,
        approximate: true,
        popup: { title: r.ngo.name, lines: [`Destination for ${r.listing.title}`], href: r.links.rescue, hrefLabel: 'Open rescue' },
      });
    }
  }
  for (const l of visibleListings) {
    if (l.area.latitude === null || l.area.longitude === null) continue;
    markers.push({
      id: `l-${l.id}`,
      kind: l.urgency === 'CRITICAL' || l.urgency === 'URGENT' ? 'urgent' : 'listing',
      latitude: l.area.latitude,
      longitude: l.area.longitude,
      label: l.title,
      approximate: true,
      popup: {
        title: l.title,
        lines: [
          `${l.provider.name} · ${foodCategoryLabels[l.foodCategory as FoodCategory] ?? l.foodCategory} · ${l.servings} servings`,
          `${l.urgency ? urgencyLabels[l.urgency] : ''}${l.remainingMs !== null ? `, ${durationText(l.remainingMs)} left` : ''}`,
          `${l.matching.eligibleNgos} eligible NGO${l.matching.eligibleNgos === 1 ? '' : 's'}, ${l.matching.notifiedNgos} notified (not yet accepted)`,
        ],
      },
    });
  }

  const noPos = visibleRescues.filter((r) => r.area.latitude === null).length + visibleListings.filter((l) => l.area.latitude === null).length;
  const rows: { id: string; title: string; kind: string; detail: string; href?: string; deadline?: string }[] = [
    ...visibleRescues.map((r) => ({ id: `r-${r.id}`, title: r.listing.title, kind: `${bucketLabels[r.state].label} rescue`, detail: `${r.provider.name} → ${r.ngo.name} · ${r.delay ? r.delay.text : r.stage.nextAction}`, href: r.links.rescue, deadline: r.stage.deadline?.at })),
    ...visibleListings.map((l) => ({ id: `l-${l.id}`, title: l.title, kind: 'Unaccepted listing', detail: `${l.provider.name} · ${l.matching.eligibleNgos} eligible NGOs`, deadline: l.pickupDeadline })),
  ];

  const sel = 'rounded-lg border border-stone-300 bg-white px-2.5 py-2 text-sm hover:border-stone-400';
  return (
    <div>
      <form role="search" aria-label="Filter the map" onSubmit={(e) => e.preventDefault()} className="grid gap-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-card sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <label htmlFor="om-q" className="block text-sm font-semibold">Search</label>
          <input id="om-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Listing, provider or NGO" className={`${sel} mt-1 w-full`} />
        </div>
        <div>
          <label htmlFor="om-scope" className="block text-sm font-semibold">Rescues</label>
          <select id="om-scope" value={scope} onChange={(e) => setScope(e.target.value as RescueScope)} className={`${sel} mt-1 w-full`}>
            <option value="open">All open (active and delayed)</option>
            <option value="delayed">Delayed only</option>
            <option value="blocked">Blocked by an incident</option>
            <option value="none">Hide rescues</option>
          </select>
        </div>
        <div>
          <label htmlFor="om-urg" className="block text-sm font-semibold">Unaccepted listings</label>
          <select id="om-urg" value={showListings ? urgency : 'hide'} onChange={(e) => { if (e.target.value === 'hide') setShowListings(false); else { setShowListings(true); setUrgency(e.target.value as Urg); } }} className={`${sel} mt-1 w-full`}>
            <option value="">All live listings</option>
            <option value="CRITICAL">Critical only</option>
            <option value="URGENT">Urgent only</option>
            <option value="PRIORITY">Priority only</option>
            <option value="NORMAL">Normal only</option>
            <option value="hide">Hide listings</option>
          </select>
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm font-medium">
          <input type="checkbox" checked={showDest} onChange={(e) => setShowDest(e.target.checked)} /> Show NGO destinations
        </label>
      </form>

      <FormError message={error} />
      {!rescues && !error && <Skeleton className="mt-4 h-80 w-full" />}
      {rescues && listings && (
        <>
          <p className="mt-3 text-sm text-stone-700" role="status">
            Showing {visibleRescues.length} open rescue{visibleRescues.length === 1 ? '' : 's'} and {visibleListings.length} unaccepted listing{visibleListings.length === 1 ? '' : 's'}. Pins are approximate areas (about 1 km). {noPos > 0 ? `${noPos} item${noPos === 1 ? ' has' : 's have'} no map position and appear only in the list.` : ''}
          </p>
          <MapView title="Operations map" height={420} markers={markers} selectedId={selected} onSelect={(id) => setSelected(id)} />
          {rows.length === 0 ? (
            <p className="fl-appear mt-4 rounded-2xl border border-dashed border-stone-300 bg-white/70 p-6 text-center text-stone-700">Nothing matches these filters right now. Rescues and listings appear here live.</p>
          ) : (
            <ul className="mt-4 space-y-2" aria-label="Items on the map">
              {rows.map((r) => (
                <li key={r.id} className={`row-hover rounded-xl border bg-white p-3 text-sm shadow-card ${selected === r.id ? 'border-zest-400 ring-2 ring-zest-300' : 'border-stone-200'}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{r.title}</p>
                      <p className="text-xs font-semibold uppercase tracking-wide text-stone-600">{r.kind}</p>
                    </div>
                    {r.deadline && <span className="rounded-full border border-stone-400 bg-stone-50 px-2.5 py-0.5"><TimeLeft deadline={r.deadline} /></span>}
                  </div>
                  <p className="mt-1 text-stone-700">{r.detail}</p>
                  <p className="mt-2 flex flex-wrap gap-3">
                    <button type="button" onClick={() => { setSelected(null); setTimeout(() => setSelected(r.id), 0); }} className="font-semibold text-brand-700 underline">Show on map</button>
                    {r.href && <Link href={r.href} className="font-semibold text-brand-700 underline">Open rescue, history and actions</Link>}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
