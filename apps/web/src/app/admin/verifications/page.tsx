'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatDate } from '@/components/OrgParts';
import { Loading, Shell, StatusBadge, useRoleGuard } from '@/components/Shell';
import { FormError } from '@/components/ui';
import { api, type Organization, type VerificationStatus } from '@/lib/api';

type QueueItem = Organization & { documentCount: number };
type Filter = VerificationStatus | 'ALL';

const filters: { value: Filter; label: string }[] = [
  { value: 'UNDER_REVIEW', label: 'Pending review' },
  { value: 'RESUBMISSION_REQUESTED', label: 'Resubmission required' },
  { value: 'VERIFIED', label: 'Verified' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'UNSUBMITTED', label: 'Drafts' },
  { value: 'ALL', label: 'All' },
];

export default function VerificationQueuePage() {
  const user = useRoleGuard(['admin']);
  const [filter, setFilter] = useState<Filter>('UNDER_REVIEW');
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    api<{ organizations: QueueItem[] }>(`/admin/verifications?status=${filter}`).then((res) => {
      if (cancelled) return;
      if (res.ok) setItems(res.data.organizations);
      else setError(res.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [user, filter]);

  if (!user) return <Loading label="Restoring your session…" />;

  return (
    <Shell user={user} title="Organization verification queue">
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label htmlFor="status-filter" className="text-sm font-medium">Show</label>
        <select id="status-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm">
          {filters.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>

      <div className="mt-4"><FormError message={error} /></div>
      {!items && !error && <Loading label="Loading applications…" />}
      {items && items.length === 0 && (
        <p className="mt-4 rounded-md border border-dashed border-stone-300 p-6 text-center text-stone-700">
          {filter === 'UNDER_REVIEW' ? 'No applications are waiting for review.' : 'No organizations match this filter.'}
        </p>
      )}
      {items && items.length > 0 && (
        <ul className="mt-4 space-y-3">
          {items.map((o) => (
            <li key={o.id}>
              <Link href={`/admin/verifications/${o.id}`} className="block rounded-2xl border border-stone-200 bg-white shadow-card p-4 hover:border-paprika-600">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-lg font-semibold">{o.name}</span>
                  <StatusBadge status={o.verificationStatus} />
                </div>
                <p className="mt-1 text-sm text-stone-700">
                  {o.type === 'PROVIDER' ? 'Food provider' : 'NGO'} · {o.city ?? 'City not set'} · {o.documentCount} document{o.documentCount === 1 ? '' : 's'}
                </p>
                <p className="text-sm text-stone-600">
                  {o.submittedAt ? `Submitted ${formatDate(o.submittedAt)} (submission ${o.submissionNumber})` : `Created ${formatDate(o.createdAt)}, not submitted`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
