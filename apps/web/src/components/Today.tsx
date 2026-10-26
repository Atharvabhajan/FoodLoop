'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type Role } from '@/lib/api';
import type { BoardListings, BoardRescues } from '@/lib/board';
import { useLiveRefresh, type RescueSummary } from '@/lib/rescue';
import { foodCategoryLabels, type Listing, type RecommendedListing } from '@/lib/supply';
import { RescueStatusBadge } from './RescueParts';
import { StageTrack } from './StageTrack';
import { TimeLeft, fmtDateTime } from './SupplyParts';
import { Skeleton } from './ui';

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

interface Data {
  rescues: RescueSummary[] | null;
  listings: Listing[] | null;
  recommended: RecommendedListing[] | null;
  jobs: number | null;
  board: BoardRescues['counts'] | null;
  noEligible: number | null;
  unaccepted: BoardListings['listings'] | null;
  pending: number | null;
  notes: Note[] | null;
}

const empty: Data = { rescues: null, listings: null, recommended: null, jobs: null, board: null, noEligible: null, unaccepted: null, pending: null, notes: null };

function noteHref(n: Note, role: Role): string | null {
  if (n.type === 'RUNNER_JOB' || n.type === 'LISTING_RUNNER_ALERT') return '/runner/jobs';
  if (n.type === 'ESCALATION_ADMIN') return '/admin/board';
  if (n.type === 'LISTING_MATCH') return role === 'ngo' ? '/ngo/listings' : null;
  if (n.entityType === 'RESCUE' && n.entityId) return `/${role}/rescues/${n.entityId}`;
  if (n.type === 'RESCUE_UPDATE' && n.entityId) return `/${role}/rescues/${n.entityId}`;
  return null;
}

function Card({ title, id, children, action }: { title: string; id: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-lg font-bold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const more = 'text-sm font-semibold text-paprika-700 underline underline-offset-2';

function RescueRow({ r, role }: { r: RescueSummary; role: Role }) {
  const mine = r.nextAction.party === role;
  return (
    <li className={`lift rounded-xl border-2 p-3 ${mine ? 'border-paprika-500 bg-paprika-50' : 'border-stone-200 bg-white'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link href={`/${role}/rescues/${r.id}`} className="font-semibold text-stone-900 underline-offset-2 hover:underline">{r.listingTitle}</Link>
        <RescueStatusBadge status={r.status} />
      </div>
      <p className="mt-1 text-sm text-stone-700">{r.providerName} → {r.ngoName} · {r.servingsOffered} servings</p>
      <StageTrack status={r.status} compact />
      <p className="mt-2 text-sm">
        <strong>{mine ? 'Your next step: ' : `Waiting for ${r.nextAction.party ?? 'the system'}: `}</strong>
        {r.nextAction.text}
      </p>
    </li>
  );
}

function Loadingish() {
  return <div className="mt-3 space-y-2" aria-hidden><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
}

/** What needs doing now, from the live API: tasks, active rescues, urgent items and recent activity. Nothing here is invented. */
export function Today({ role }: { role: Role }) {
  const [d, setD] = useState<Data>(empty);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const next: Data = { ...empty };
    const jobs: Promise<void>[] = [];
    const get = <T,>(path: string, set: (v: T) => void) => jobs.push(api<T>(path).then((r) => { if (r.ok) set(r.data); }));
    get<{ notifications: Note[] }>('/notifications', (v) => (next.notes = v.notifications));
    if (role !== 'admin') get<{ rescues: RescueSummary[] }>('/rescues?scope=active', (v) => (next.rescues = v.rescues));
    if (role === 'provider') get<{ listings: Listing[] }>('/listings?scope=active', (v) => (next.listings = v.listings));
    if (role === 'ngo') get<{ listings: RecommendedListing[] }>('/listings/recommended', (v) => (next.recommended = v.listings));
    if (role === 'runner') get<{ jobs: unknown[] }>('/rescues/available-runs', (v) => (next.jobs = v.jobs.length));
    if (role === 'admin') {
      get<BoardRescues>('/admin/board/rescues?pageSize=1', (v) => (next.board = v.counts));
      get<BoardListings>('/admin/board/listings?scope=live&pageSize=50', (v) => { next.noEligible = v.counts.noEligibleNgo; next.unaccepted = v.listings; });
      get<{ organizations: unknown[] }>('/admin/verifications', (v) => (next.pending = v.organizations.length));
    }
    await Promise.all(jobs);
    setD(next);
    setFailed(next.notes === null);
  }, [role]);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), 30_000);

  const notes = d.notes?.slice(0, 5) ?? null;
  const attention = (d.rescues ?? []).filter((r) => r.nextAction.party === role);
  const waiting = (d.rescues ?? []).filter((r) => r.nextAction.party !== role);

  return (
    <div className="stagger mt-6 grid gap-5 lg:grid-cols-2">
      {role === 'provider' && (
        <>
          <Card title="Needs your attention" id="t-attn" action={<Link href="/provider/rescues" className={more}>All rescues</Link>}>
            {!d.rescues ? <Loadingish /> : attention.length === 0 ? <p className="mt-3 text-sm text-stone-700">Nothing is waiting for you. When an NGO accepts your food you will be asked to confirm the hand-off here.</p> : <ul className="mt-3 space-y-3">{attention.map((r) => <RescueRow key={r.id} r={r} role={role} />)}</ul>}
          </Card>
          <Card title="Your live listings" id="t-list" action={<Link href="/provider/listings/new" className={more}>New listing</Link>}>
            {!d.listings ? <Loadingish /> : d.listings.length === 0 ? <p className="mt-3 text-sm text-stone-700">No live listings or drafts. Post surplus food to start a rescue.</p> : (
              <ul className="mt-3 space-y-2">
                {d.listings.slice(0, 5).map((l) => (
                  <li key={l.id} className="row-hover flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-200 p-3 text-sm">
                    <Link href={`/provider/listings/${l.id}`} className="font-semibold underline-offset-2 hover:underline">{l.title}</Link>
                    <span className="text-stone-700">{foodCategoryLabels[l.foodCategory]} · {l.servings} servings · {l.status === 'AVAILABLE' ? <TimeLeft deadline={l.pickupDeadline} urgency={l.urgency} /> : 'Draft'}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {role === 'ngo' && (
        <>
          <Card title="Food worth a look" id="t-feed" action={<Link href="/ngo/listings" className={more}>Open the live feed</Link>}>
            {!d.recommended ? <Loadingish /> : d.recommended.length === 0 ? <p className="mt-3 text-sm text-stone-700">Nothing matches your needs right now. Check your <Link href="/ngo/requirements" className={more}>needs and radius</Link>.</p> : (
              <ul className="mt-3 space-y-2">
                {d.recommended.slice(0, 3).map((l) => (
                  <li key={l.id} className="lift rounded-xl border border-stone-200 p-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <Link href="/ngo/listings" className="font-semibold underline-offset-2 hover:underline">{l.title}</Link>
                      <span className="rounded-full border border-stone-400 bg-stone-50 px-2.5 py-0.5"><TimeLeft deadline={l.pickupDeadline} urgency={l.urgency} /></span>
                    </div>
                    <p className="mt-1 text-stone-700">{l.providerName} · {l.servings} servings · match {Math.round(l.match.score ?? 0)}/100{l.match.estimatedDistanceKm !== null ? ` · about ${l.match.estimatedDistanceKm} km (straight line)` : ''}</p>
                    {l.match.reasons[0] && <p className="mt-1 text-stone-600">{l.match.reasons[0]}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Your active rescues" id="t-resc" action={<Link href="/ngo/rescues" className={more}>All rescues</Link>}>
            {!d.rescues ? <Loadingish /> : d.rescues.length === 0 ? <p className="mt-3 text-sm text-stone-700">No rescues in progress. Accept a listing from the feed to start one.</p> : <ul className="mt-3 space-y-3">{[...attention, ...waiting].map((r) => <RescueRow key={r.id} r={r} role={role} />)}</ul>}
          </Card>
        </>
      )}

      {role === 'runner' && (
        <>
          <Card title="Your active rescue" id="t-run" action={<Link href="/runner/rescues" className={more}>My rescues</Link>}>
            {!d.rescues ? <Loadingish /> : d.rescues.length === 0 ? <p className="mt-3 text-sm text-stone-700">You are not carrying anything right now.</p> : <ul className="mt-3 space-y-3">{d.rescues.map((r) => <RescueRow key={r.id} r={r} role={role} />)}</ul>}
          </Card>
          <Card title="Jobs near you" id="t-jobs" action={<Link href="/runner/jobs" className={more}>See jobs</Link>}>
            {d.jobs === null ? <Loadingish /> : (
              <p className="mt-3 text-sm text-stone-700">
                <span className="mr-2 text-3xl font-bold text-stone-900" style={{ fontFamily: 'var(--font-display)' }}>{d.jobs}</span>
                {d.jobs === 1 ? 'job you could do is open now.' : 'jobs you could do are open now.'} {d.jobs === 0 && <>Check that you are set to Available in <Link href="/runner/profile" className={more}>your availability</Link>.</>}
              </p>
            )}
          </Card>
        </>
      )}

      {role === 'admin' && (
        <>
          <Card title="Operations right now" id="t-ops" action={<Link href="/admin/board" className={more}>Open the board</Link>}>
            {!d.board ? <Loadingish /> : (
              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {([['Delayed', d.board.delayed, d.board.delayed > 0], ['Active', d.board.active, false], ['Blocked', d.board.blocked, d.board.blocked > 0], ['Need an admin', d.board.needsAdmin, d.board.needsAdmin > 0]] as const).map(([k, v, hot]) => (
                  <div key={k} className={`rounded-xl border-2 p-3 ${hot ? 'border-red-300 bg-red-50' : 'border-stone-200'}`}>
                    <dd className="text-3xl font-bold tabular-nums" style={{ fontFamily: 'var(--font-display)' }}>{v}</dd>
                    <dt className="text-sm text-stone-700">{k}</dt>
                  </div>
                ))}
              </dl>
            )}
            <p className="mt-3 text-sm text-stone-700">{d.pending === null ? '' : d.pending === 0 ? 'No verification applications are waiting.' : `${d.pending} verification application${d.pending === 1 ? '' : 's'} waiting.`} <Link href="/admin/verifications" className={more}>Verification queue</Link></p>
          </Card>
          <Card title="Unaccepted food" id="t-un" action={<Link href="/admin/board" className={more}>See on the map</Link>}>
            {!d.unaccepted ? <Loadingish /> : d.unaccepted.length === 0 ? <p className="mt-3 text-sm text-stone-700">Every live listing has been accepted or there are none live.</p> : (
              <>
                {d.noEligible ? <p role="note" className="mt-3 rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-950">{d.noEligible} live listing{d.noEligible === 1 ? ' has' : 's have'} no eligible NGO and may need a manual introduction.</p> : null}
                <ul className="mt-3 space-y-2">
                  {d.unaccepted.slice(0, 4).map((l) => (
                    <li key={l.id} className="row-hover flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-200 p-3 text-sm">
                      <span><strong>{l.title}</strong> · {l.provider.name} · {l.matching.eligibleNgos} eligible</span>
                      <span><TimeLeft deadline={l.pickupDeadline} urgency={l.urgency} /></span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        </>
      )}

      <Card title="Recent activity" id="t-act" action={<Link href="/notifications" className={more}>All notifications</Link>}>
        {failed && d.notes === null ? <p className="mt-3 text-sm text-red-700">Could not load recent activity.</p> : !notes ? <Loadingish /> : notes.length === 0 ? <p className="mt-3 text-sm text-stone-700">No activity yet.</p> : (
          <ol className="mt-3 space-y-3 border-l-2 border-stone-200 pl-4">
            {notes.map((n) => {
              const href = noteHref(n, role);
              return (
                <li key={n.id} className="text-sm">
                  <p className="font-semibold">{href ? <Link href={href} className="underline-offset-2 hover:underline">{n.title}</Link> : n.title}</p>
                  <p className="text-stone-700">{n.body}</p>
                  <p className="text-xs text-stone-600">{fmtDateTime(n.createdAt)}</p>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </div>
  );
}
