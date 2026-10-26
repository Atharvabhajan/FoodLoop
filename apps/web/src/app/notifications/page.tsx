'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { fmtDateTime } from '@/components/SupplyParts';
import { FormError } from '@/components/ui';
import { api } from '@/lib/api';
import { useLiveRefresh } from '@/lib/rescue';

interface Note {
  id: string;
  type: string;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
  actionable: boolean;
}

export default function NotificationsPage() {
  const user = useRoleGuard(['provider', 'ngo', 'admin', 'runner']);
  const [items, setItems] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'action' | 'food' | 'rescue'>('all');
  const load = useCallback(async () => {
    const res = await api<{ notifications: Note[] }>('/notifications');
    if (res.ok) {
      setItems(res.data.notifications);
      setError(null);
    } else setError(res.error.message);
  }, []);
  useEffect(() => {
    if (user) void load();
  }, [user, load]);
  useLiveRefresh(() => void load());

  if (!user) return <Loading label="Restoring your session…" />;
  const role = user.platformRole;
  const shown = (items ?? []).filter((n) => filter === 'all' || (filter === 'action' && n.actionable) || (filter === 'food' && /LISTING|RUNNER/.test(n.type)) || (filter === 'rescue' && n.type === 'RESCUE_UPDATE'));

  return (
    <Shell user={user} title="Notifications">
      <div className="mt-4"><FormError message={error} /></div>
      {!items && !error && <Loading label="Loading notifications…" />}
      {items && items.length === 0 && <p className="mt-4 rounded-md border border-dashed border-stone-300 p-6 text-center text-stone-700">No notifications yet.</p>}
      {items && items.length > 0 && (
        <div role="group" aria-label="Filter notifications" className="mt-4 flex flex-wrap gap-2">
          {([['all', 'All'], ['action', 'Needs action'], ['food', 'Food and jobs'], ['rescue', 'Rescue updates']] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${filter === k ? 'border-paprika-600 bg-paprika-600 text-white' : 'border-stone-300 bg-white hover:bg-stone-100'}`}>{label}</button>
          ))}
        </div>
      )}
      {items && items.length > 0 && shown.length === 0 && <p className="fl-appear mt-4 rounded-2xl border border-dashed border-stone-300 bg-white/70 p-6 text-center text-stone-700">Nothing in this view.</p>}
      {items && shown.length > 0 && (
        <ul className="mt-4 space-y-3">
          {shown.map((n) => (
            <li key={n.id} className="row-hover rounded-2xl border border-stone-200 bg-white shadow-card p-4">
              <p className="font-semibold">{n.title}</p>
              <p className="mt-1 text-sm text-stone-800">{n.body}</p>
              <p className="mt-1 text-xs text-stone-600">{fmtDateTime(n.createdAt)}</p>
              <p className="mt-2 text-sm">
                {n.actionable ? (
                  n.type === 'RUNNER_JOB' || n.type === 'LISTING_RUNNER_ALERT' ? (
                    <Link href="/runner/jobs" className="font-medium text-paprika-700 underline">View available jobs</Link>
                  ) : n.type === 'ESCALATION_ADMIN' ? (
                    <Link href="/admin/board" className="font-medium text-paprika-700 underline">Open the operations board</Link>
                  ) : n.type === 'RESCUE_UPDATE' && n.entityId ? (
                    <Link href={`/${role}/rescues/${n.entityId}`} className="font-medium text-paprika-700 underline">Open rescue</Link>
                  ) : (
                    <Link href="/ngo/listings" className="font-medium text-paprika-700 underline">View recommendation</Link>
                  )
                ) : (
                  <span className="text-stone-600">No longer actionable: this {n.type === 'LISTING_MATCH' ? 'listing is no longer available to you' : n.type === 'RUNNER_JOB' ? 'job has been taken or has closed' : n.type === 'LISTING_RUNNER_ALERT' || n.type === 'ESCALATION_ADMIN' ? 'listing has been accepted or has closed' : 'rescue has finished'}.</span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
