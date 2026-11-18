'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ListingExplorer } from '@/components/ListingExplorer';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { FormError } from '@/components/ui';
import { api } from '@/lib/api';
import type { Listing } from '@/lib/supply';

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
    <Shell
      user={user}
      title="Your listings"
      eyebrow="Surplus food"
      subtitle="Everything you have posted. Live listings are visible to verified NGOs nearby (approximate area only); drafts are private until you publish them."
      actions={<Link href="/provider/listings/new" className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-5 py-2 text-sm font-bold text-white shadow-sm hover:bg-brand-700">Post surplus food</Link>}
      below={
        <div role="tablist" aria-label="Listing filter" className="inline-flex rounded-xl border border-stone-300 bg-white p-0.5">
          {(['active', 'past'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={scope === s} onClick={() => setScope(s)} className={`min-h-10 rounded-lg px-4 py-1.5 text-sm font-semibold ${scope === s ? 'bg-brand-600 text-white' : 'hover:bg-stone-100'}`}>
              {s === 'active' ? 'Active and drafts' : 'Past'}
            </button>
          ))}
        </div>
      }
    >
      <FormError message={error} />
      <ListingExplorer key={scope} listings={error ? [] : items} heading={scope === 'active' ? 'Active and drafts' : 'Cancelled, expired and collected'} />
    </Shell>
  );
}
