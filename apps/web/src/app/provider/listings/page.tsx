'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { ListingStatusBadge, TimeLeft, fmtDateTime } from '@/components/SupplyParts';
import { EmptyState, FormError, Photo } from '@/components/ui';
import { api } from '@/lib/api';
import { stockPhoto, foodCategoryLabels, type Listing } from '@/lib/supply';

type Scope = 'active' | 'past';

export default function ProviderListingsPage() {
  const user = useRoleGuard(['provider']);
  const [scope, setScope] = useState<Scope>('active');
  const [items, setItems] = useState<Listing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    api<{ listings: Listing[] }>(`/listings?scope=${scope}`).then((res) => {
      if (cancelled) return;
      if (res.ok) setItems(res.data.listings);
      else setError(res.error.code === 'ORGANIZATION_REQUIRED' ? 'Create your organization profile first.' : res.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [user, scope]);

  if (!user) return <Loading label="Restoring your session…" />;

  return (
    <Shell user={user} title="Your listings">
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Listing filter" className="inline-flex rounded-md border border-stone-300 bg-white p-0.5">
          {(['active', 'past'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={scope === s} onClick={() => setScope(s)} className={`rounded px-4 py-1.5 text-sm font-medium ${scope === s ? 'bg-paprika-600 text-white' : 'hover:bg-stone-100'}`}>
              {s === 'active' ? 'Active and drafts' : 'Past'}
            </button>
          ))}
        </div>
        <Link href="/provider/listings/new" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-paprika-600 px-4 py-2 text-sm font-semibold text-white hover:bg-paprika-700">
          New listing
        </Link>
      </div>

      <div className="mt-4"><FormError message={error} /></div>
      {!items && !error && <Loading label="Loading listings…" />}
      {items && items.length === 0 && (
        <EmptyState title={scope === 'active' ? 'No active listings yet' : 'No past listings yet'} photo="cooked-plate">
          {scope === 'active' ? 'No active listings or drafts yet. Create one to get started.' : 'No past listings yet. Cancelled and expired listings appear here.'}
        </EmptyState>
      )}
      {items && items.length > 0 && (
        <ul className="mt-4 space-y-3">
          {items.map((l) => (
            <li key={l.id}>
              <Link href={`/provider/listings/${l.id}`} className="lift flex overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-card">
                <Photo name={stockPhoto(l.title, l.foodCategory)} decorative className="hidden w-32 object-cover sm:block" />
                <div className="flex-1 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-lg font-semibold">{l.title}</span>
                  <ListingStatusBadge status={l.status} />
                </div>
                <p className="mt-1 text-sm text-stone-700">
                  {foodCategoryLabels[l.foodCategory]} · {l.servings} servings · {l.city}
                </p>
                <p className="text-sm text-stone-600">
                  {l.status === 'AVAILABLE' ? <TimeLeft deadline={l.pickupDeadline} urgency={l.urgency} /> : `Pickup deadline ${fmtDateTime(l.pickupDeadline)}`}
                  {l.status === 'CANCELLED' && l.cancellationReason ? ` · Reason: ${l.cancellationReason}` : ''}
                </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
