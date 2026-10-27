'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, type Organization, type User } from '@/lib/api';
import type { BoardListings, BoardRescue, BoardRescues } from '@/lib/board';
import { useLiveRefresh } from '@/lib/rescue';
import { formatDate } from './OrgParts';
import { OpsMap } from './OpsMap';
import { TimeLeft } from './SupplyParts';
import { ActivityList, Band, Kpi, KpiRow, Loadingish, Panel, ViewSwitch, firstName, greeting, linkCls, useNotes } from './ops';
import { CountUp } from './ui';

interface IncidentRow {
  id: string;
  rescueId: string;
  category: string;
  severity: string;
  blocking: boolean;
  createdAt: string;
  description: string;
}

/** Admin workspace: what needs attention (delayed or blocked rescues, incidents, verification) beside the live operations map. */
export function AdminWorkspace({ user }: { user: User }) {
  const [counts, setCounts] = useState<BoardRescues['counts'] | null>(null);
  const [attention, setAttention] = useState<BoardRescue[] | null>(null);
  const [incidents, setIncidents] = useState<IncidentRow[] | null>(null);
  const [pending, setPending] = useState<(Organization & { documentCount: number })[] | null>(null);
  const [noEligible, setNoEligible] = useState<number | null>(null);
  const [view, setView] = useState<'list' | 'map'>('list');
  const notes = useNotes();

  const load = useCallback(async () => {
    const [d, i, v, l] = await Promise.all([
      api<BoardRescues>('/admin/board/rescues?state=delayed&pageSize=8&sort=attention'),
      api<{ incidents: IncidentRow[] }>('/incidents?status=OPEN'),
      api<{ organizations: (Organization & { documentCount: number })[] }>('/admin/verifications'),
      api<BoardListings>('/admin/board/listings?scope=live&pageSize=1'),
    ]);
    if (d.ok) {
      setCounts(d.data.counts);
      setAttention(d.data.rescues);
    }
    if (i.ok) setIncidents(i.data.incidents);
    if (v.ok) setPending(v.data.organizations);
    if (l.ok) setNoEligible(l.data.counts.noEligibleNgo);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), 30_000);

  const hot = (counts?.delayed ?? 0) + (counts?.needsAdmin ?? 0) > 0;

  return (
    <div>
      <Band photo="hero-handover" eyebrow={`${greeting()}, ${firstName(user.name)}`} title="Live operations" actions={<Link href="/admin/board" className="inline-flex min-h-11 items-center rounded-lg bg-saffron-300 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-saffron-200">Full operations board</Link>}>
        <span className="text-stone-200">{!counts ? 'Loading the board…' : hot ? 'Some rescues need attention.' : 'Everything is on schedule.'}</span>
      </Band>

      <KpiRow label="Operations numbers">
        <Kpi label="Delayed rescues" value={counts ? <CountUp value={counts.delayed} /> : '–'} note="behind schedule or blocked" tone={(counts?.delayed ?? 0) > 0 ? 'hot' : 'plain'} href="/admin/board" />
        <Kpi label="Open incidents" value={incidents ? <CountUp value={incidents.length} /> : '–'} note={incidents ? `${incidents.filter((x) => x.blocking).length} blocking` : undefined} tone={(incidents?.length ?? 0) > 0 ? 'hot' : 'plain'} href="/admin/incidents" />
        <Kpi label="Verification queue" value={pending ? <CountUp value={pending.length} /> : '–'} note="applications waiting" href="/admin/verifications" />
        <Kpi label="Food with no eligible NGO" value={noEligible === null ? '–' : <CountUp value={noEligible} />} note="live listings" tone={(noEligible ?? 0) > 0 ? 'hot' : 'plain'} />
      </KpiRow>

      <ViewSwitch value={view} onChange={setView} labels={['Needs attention', 'Live map']} />
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.6fr)]">
        <div className={`${view === 'list' ? 'block' : 'hidden'} space-y-4 lg:block`}>
          <Panel title="Delayed or blocked rescues" id="aw-delay" action={<Link href="/admin/board" className={linkCls}>Board</Link>}>
            {!attention ? <Loadingish /> : attention.length === 0 ? <p className="mt-3 text-sm text-stone-700">No delayed or blocked rescues.</p> : (
              <ul className="mt-3 space-y-2">
                {attention.map((r) => (
                  <li key={r.id} className="lift rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm">
                    <Link href={r.links.rescue} className="font-bold underline-offset-2 hover:underline">{r.listing.title}</Link>
                    <p className="text-stone-800">{r.provider.name} → {r.ngo.name}</p>
                    <p className="mt-1">{r.delay ? r.delay.text : r.stage.nextAction}</p>
                    {r.stage.deadline && <p className="mt-1 text-xs text-stone-700">{r.stage.deadline.label}: <TimeLeft deadline={r.stage.deadline.at} /></p>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Open incidents" id="aw-inc" action={<Link href="/admin/incidents" className={linkCls}>All incidents</Link>}>
            {!incidents ? <Loadingish /> : incidents.length === 0 ? <p className="mt-3 text-sm text-stone-700">No open incidents.</p> : (
              <ul className="mt-3 space-y-2">
                {incidents.slice(0, 5).map((i) => (
                  <li key={i.id} className="row-hover rounded-xl border border-stone-200 p-3 text-sm">
                    <Link href={`/admin/incidents/${i.id}`} className="font-semibold underline-offset-2 hover:underline">{i.category.replace(/_/g, ' ').toLowerCase()}</Link>
                    <span className="ml-2 rounded-full border border-orange-600 bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-900">{i.severity.toLowerCase()}{i.blocking ? ' · blocking' : ''}</span>
                    <p className="mt-1 line-clamp-2 text-stone-700">{i.description}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Verification needing review" id="aw-ver" action={<Link href="/admin/verifications" className={linkCls}>Queue</Link>}>
            {!pending ? <Loadingish /> : pending.length === 0 ? <p className="mt-3 text-sm text-stone-700">No applications are waiting.</p> : (
              <ul className="mt-3 space-y-2">
                {pending.slice(0, 5).map((o) => (
                  <li key={o.id} className="row-hover rounded-xl border border-stone-200 p-3 text-sm">
                    <Link href={`/admin/verifications/${o.id}`} className="font-semibold underline-offset-2 hover:underline">{o.name}</Link>
                    <p className="text-stone-700">{o.type === 'NGO' ? 'NGO' : 'Food provider'} · {o.submittedAt ? `submitted ${formatDate(o.submittedAt)}` : 'not submitted'} · {o.documentCount} document{o.documentCount === 1 ? '' : 's'}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className={`${view === 'map' ? 'block' : 'hidden'} lg:block`}>
          <OpsMap />
        </div>
      </div>

      <div className="mt-4">
        <Panel title="Recent activity" id="aw-act" action={<Link href="/notifications" className={linkCls}>All notifications</Link>}>
          <ActivityList notes={notes} role="admin" />
        </Panel>
      </div>
    </div>
  );
}
