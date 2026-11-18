'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { niceBody } from '@/components/ops';
import { EmptyState, FormError } from '@/components/ui';
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

  const action = (n: Note): { href: string; label: string } | null => {
    if (!n.actionable) return null;
    if (n.type === 'RUNNER_JOB' || n.type === 'LISTING_RUNNER_ALERT') return { href: '/runner/jobs', label: 'View available jobs' };
    if (n.type === 'ESCALATION_ADMIN') return { href: '/admin/board', label: 'Open the operations board' };
    if (n.type === 'RESCUE_UPDATE' && n.entityId) return { href: `/${role}/rescues/${n.entityId}`, label: 'Open rescue' };
    return { href: '/ngo/listings', label: 'View recommendation' };
  };
  const icon = (n: Note) => (n.type === 'RESCUE_UPDATE' ? '▶' : n.type === 'ESCALATION_ADMIN' ? '!' : n.type.includes('RUNNER') ? '◎' : '●');
  const dayOf = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const y = new Date(Date.now() - 86_400_000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  };
  const groups: { day: string; items: Note[] }[] = [];
  for (const n of shown) {
    const day = dayOf(n.createdAt);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(n);
    else groups.push({ day, items: [n] });
  }
  const filters = (
    <div role="group" aria-label="Filter notifications" className="inline-flex flex-wrap rounded-xl border border-stone-300 bg-white p-0.5">
      {([['all', 'All'], ['action', 'Needs action'], ['food', 'Food and jobs'], ['rescue', 'Rescue updates']] as const).map(([k, label]) => (
        <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={`min-h-10 rounded-lg px-3.5 py-1.5 text-sm font-semibold ${filter === k ? 'bg-brand-600 text-white' : 'hover:bg-stone-100'}`}>
          {label}
          {k === 'action' && items ? ` (${items.filter((n) => n.actionable).length})` : ''}
        </button>
      ))}
    </div>
  );

  return (
    <Shell user={user} title="Notifications" eyebrow="Inbox" subtitle="Matches, jobs and rescue updates. Items that still need you link straight to the right page." below={items && items.length > 0 ? filters : undefined}>
      <FormError message={error} />
      {!items && !error && <Loading label="Loading notifications…" />}
      {items && items.length === 0 && <EmptyState title="No notifications yet" photo="volunteers-serving">New matches, jobs and rescue updates will appear here.</EmptyState>}
      {items && items.length > 0 && shown.length === 0 && <p className="fl-appear rounded-2xl border border-dashed border-stone-300 bg-white/70 p-6 text-center text-stone-700">Nothing in this view.</p>}
      <div className="max-w-4xl space-y-6">
        {groups.map((g) => (
          <section key={g.day} aria-label={g.day}>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-stone-600">{g.day}</h2>
            <ul className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-card">
              {g.items.map((n) => {
                const a = action(n);
                return (
                  <li key={n.id} className={`row-hover flex gap-3 border-t border-stone-200 p-4 first:border-t-0 ${a ? '' : 'opacity-80'}`}>
                    <span aria-hidden className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${a ? 'bg-brand-600 text-white' : 'bg-stone-200 text-stone-700'}`}>{icon(n)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="font-semibold">{n.title}</p>
                        <p className="text-xs text-stone-600">{new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                      </div>
                      <p className="mt-0.5 text-sm text-stone-800">{niceBody(n.body)}</p>
                      {a ? (
                        <Link href={a.href} className="mt-2 inline-flex min-h-9 items-center rounded-lg border border-brand-600 px-3 py-1 text-sm font-semibold text-brand-700 hover:bg-brand-50">{a.label}</Link>
                      ) : (
                        <p className="mt-1 text-xs text-stone-600">No longer actionable: this {n.type === 'LISTING_MATCH' ? 'listing is no longer available to you' : n.type === 'RUNNER_JOB' ? 'job has been taken or has closed' : n.type === 'LISTING_RUNNER_ALERT' || n.type === 'ESCALATION_ADMIN' ? 'listing has been accepted or has closed' : 'rescue has finished'}.</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Shell>
  );
}
