'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  actorLabels,
  bucketLabels,
  durationText,
  type Bucket,
  type BoardDetail,
  type BoardListing,
  type BoardListings,
  type BoardOptions,
  type BoardRescue,
  type BoardRescues,
  type EscalationHistory,
  type EscalationSummary,
  stepLabel,
  stepReasonLabels,
} from '@/lib/board';
import { statusLabels, useLiveRefresh } from '@/lib/rescue';
import { foodCategoryLabels, type FoodCategory } from '@/lib/supply';
import { Loading } from './Shell';
import { StageTrack } from './StageTrack';
import { OpsMap } from './OpsMap';
import { TimeLeft, fmtDateTime } from './SupplyParts';
import { FormError } from './ui';

/* ----------------------------------- shared bits ----------------------------------- */

function StateBadge({ state }: { state: Bucket }) {
  const b = bucketLabels[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-semibold ${b.cls}`}>
      <span aria-hidden>{b.icon}</span>
      {b.label}
    </span>
  );
}

function Pager({ page, onPage, onSize }: { page: { number: number; size: number; total: number; pages: number }; onPage: (n: number) => void; onSize: (n: number) => void }) {
  return (
    <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <p role="status">
        {page.total === 0 ? 'No results' : `Page ${page.number} of ${page.pages} · ${page.total} result${page.total === 1 ? '' : 's'}`}
      </p>
      <div className="flex items-center gap-2">
        <label htmlFor="ops-size" className="text-stone-700">Per page</label>
        <select id="ops-size" value={page.size} onChange={(e) => onSize(Number(e.target.value))} className="rounded-md border border-stone-300 px-2 py-1.5">
          {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <button type="button" disabled={page.number <= 1} onClick={() => onPage(page.number - 1)} className="rounded-md border border-stone-300 px-3 py-1.5 font-medium disabled:opacity-50">Previous</button>
        <button type="button" disabled={page.number >= page.pages} onClick={() => onPage(page.number + 1)} className="rounded-md border border-stone-300 px-3 py-1.5 font-medium disabled:opacity-50">Next</button>
      </div>
    </nav>
  );
}

/** Debounced value, so typing in the search box does not fire a request per keystroke. */
function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const input = 'mt-1 block w-full rounded-lg border border-stone-300 bg-white px-2.5 py-2 text-sm hover:border-stone-400';

/* ----------------------------------- rescues tab ----------------------------------- */

interface RescueFilters {
  state: Bucket | '';
  q: string;
  providerOrgId: string;
  ngoOrgId: string;
  runnerUserId: string;
  transportMode: '' | 'NGO_PICKUP' | 'RUNNER';
  from: string;
  to: string;
  olderThanMinutes: string;
  blocked: boolean;
  needsAdmin: boolean;
  sort: 'attention' | 'newest' | 'oldest';
}
const noRescueFilters: RescueFilters = { state: '', q: '', providerOrgId: '', ngoOrgId: '', runnerUserId: '', transportMode: '', from: '', to: '', olderThanMinutes: '', blocked: false, needsAdmin: false, sort: 'attention' };

function RescueCard({ r }: { r: BoardRescue }) {
  const open = r.state === 'active' || r.state === 'delayed';
  return (
    <li className={`lift row-hover rounded-2xl border border-l-8 bg-white p-4 shadow-card ${r.state === 'delayed' ? 'border-amber-300 border-l-amber-500' : r.needsAdmin || r.state === 'failed' ? 'border-red-200 border-l-red-600' : r.state === 'completed' ? 'border-stone-200 border-l-stone-900' : 'border-stone-200 border-l-paprika-500'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">{r.listing.title}</h3>
          <p className="text-sm text-stone-700">
            {r.provider.name} → {r.ngo.name} · {r.transportMode === 'RUNNER' ? `runner${r.runner ? `: ${r.runner.name}` : ''}` : 'NGO collects'} · {r.servings.delivered !== null ? `${r.servings.delivered} delivered of ${r.servings.offered}` : `${r.servings.offered} servings`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={r.state} />
          {r.needsAdmin && <span className="rounded-full border border-red-600 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-900">Needs an admin</span>}
          {r.openIncidents > 0 && <span className="rounded-full border border-orange-600 bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-900">{r.blocked ? 'Blocking incident' : `${r.openIncidents} open incident${r.openIncidents === 1 ? '' : 's'}`}</span>}
        </div>
      </div>

      <StageTrack status={r.status} compact />
      <p className="mt-2 text-sm"><strong>Stage:</strong> {statusLabels[r.status].label}</p>
      {open ? (
        <>
          <p className="mt-1 text-sm"><strong>Next{r.stage.nextActor ? ` (${actorLabels[r.stage.nextActor]})` : ''}:</strong> {r.stage.nextAction}</p>
          {r.stage.deadline && (
            <p className="mt-1 text-sm text-stone-700">
              {r.stage.deadline.label} {fmtDateTime(r.stage.deadline.at)} · <TimeLeft deadline={r.stage.deadline.at} />
              {r.stage.elapsedMs !== null && ` · in this stage for ${durationText(r.stage.elapsedMs)}`}
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 text-sm text-stone-700">
          {r.state === 'failed' && r.needsAdmin ? 'Delivery was not confirmed: an admin must record the outcome. ' : ''}
          Started {fmtDateTime(r.startedAt)}{r.closedAt ? ` · ended ${fmtDateTime(r.closedAt)}` : ''}
        </p>
      )}
      {r.delay && (
        <p role="note" className="mt-2 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>Why delayed:</strong> {r.delay.text} <span className="whitespace-nowrap">Overdue action: {r.delay.overdueAction}.</span>
        </p>
      )}
      <p className="mt-3 flex flex-wrap gap-4 text-sm">
        <Link href={r.links.rescue} className="font-medium text-paprika-700 underline">Open rescue, history and actions</Link>
        <Link href={`${r.links.rescue}#hist`} className="font-medium text-paprika-700 underline">Audit history</Link>
        {r.links.incidents && <Link href={r.links.incidents} className="font-medium text-paprika-700 underline">Incidents</Link>}
      </p>
    </li>
  );
}

function RescuesTab({ options }: { options: BoardOptions | null }) {
  const [f, setF] = useState<RescueFilters>(() => {
    try {
      const saved = sessionStorage.getItem('ops-board-filters');
      return saved ? { ...noRescueFilters, ...(JSON.parse(saved) as Partial<RescueFilters>) } : noRescueFilters;
    } catch {
      return noRescueFilters;
    }
  });
  const [pageNo, setPageNo] = useState(1);
  const [size, setSize] = useState(25);
  const [data, setData] = useState<BoardRescues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const q = useDebounced(f.q);

  useEffect(() => {
    try {
      sessionStorage.setItem('ops-board-filters', JSON.stringify(f));
    } catch {
      /* storage can be unavailable; filters simply are not remembered */
    }
  }, [f]);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (f.state) qs.set('state', f.state);
    if (q.trim()) qs.set('q', q.trim());
    if (f.providerOrgId) qs.set('providerOrgId', f.providerOrgId);
    if (f.ngoOrgId) qs.set('ngoOrgId', f.ngoOrgId);
    if (f.runnerUserId) qs.set('runnerUserId', f.runnerUserId);
    if (f.transportMode) qs.set('transportMode', f.transportMode);
    if (f.from) qs.set('from', f.from);
    if (f.to) qs.set('to', f.to);
    if (f.olderThanMinutes) qs.set('olderThanMinutes', f.olderThanMinutes);
    if (f.blocked) qs.set('blocked', 'true');
    if (f.needsAdmin) qs.set('needsAdmin', 'true');
    qs.set('sort', f.sort);
    qs.set('page', String(pageNo));
    qs.set('pageSize', String(size));
    const mine = ++latest.current; // only the newest request may update the page
    const res = await api<BoardRescues>(`/admin/board/rescues?${qs}`);
    if (mine !== latest.current) return;
    setLoading(false);
    if (res.ok) {
      setData(res.data);
      setError(null);
      setFields({});
    } else {
      setError(res.error.message);
      setFields(res.error.fields);
    }
  }, [f.state, q, f.providerOrgId, f.ngoOrgId, f.runnerUserId, f.transportMode, f.from, f.to, f.olderThanMinutes, f.blocked, f.needsAdmin, f.sort, pageNo, size]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), 15_000);

  const set = <K extends keyof RescueFilters>(k: K, v: RescueFilters[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setPageNo(1);
  };
  const clear = () => {
    setF(noRescueFilters);
    setPageNo(1);
  };
  const filtered = JSON.stringify(f) !== JSON.stringify(noRescueFilters);
  const c = data?.counts;
  const tabs: { id: Bucket | ''; label: string; n: number | undefined }[] = [
    { id: '', label: 'All', n: c?.total },
    { id: 'delayed', label: 'Delayed', n: c?.delayed },
    { id: 'active', label: 'Active', n: c?.active },
    { id: 'failed', label: 'Failed', n: c?.failed },
    { id: 'completed', label: 'Completed', n: c?.completed },
    { id: 'cancelled', label: 'Cancelled', n: c?.cancelled },
  ];

  return (
    <div>
      <div role="group" aria-label="Rescue state" className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tabs.map((t) => (
          <button key={t.label} type="button" aria-pressed={f.state === t.id} onClick={() => set('state', t.id)} className={`lift rounded-2xl border-2 p-3 text-left shadow-card ${f.state === t.id ? 'border-paprika-600 bg-paprika-50' : 'border-stone-200 bg-white'}`}>
            <span className="block text-sm font-medium text-stone-700">{t.id ? `${bucketLabels[t.id].icon} ` : ''}{t.label}</span>
            <span className="mt-1 block font-display text-3xl font-bold tabular-nums" style={{ fontFamily: 'var(--font-display)' }}>{t.n ?? '–'}</span>
            {t.id && <span className="block text-xs text-stone-600">{bucketLabels[t.id].hint}</span>}
          </button>
        ))}
      </div>
      {c && (c.needsAdmin > 0 || c.blocked > 0) && (
        <p className="mt-3 flex flex-wrap gap-3 text-sm">
          {c.needsAdmin > 0 && <button type="button" aria-pressed={f.needsAdmin} onClick={() => set('needsAdmin', !f.needsAdmin)} className={`rounded-full border px-3 py-1 font-medium ${f.needsAdmin ? 'border-red-600 bg-red-50' : 'border-stone-300'}`}>Needs an admin: {c.needsAdmin}</button>}
          {c.blocked > 0 && <button type="button" aria-pressed={f.blocked} onClick={() => set('blocked', !f.blocked)} className={`rounded-full border px-3 py-1 font-medium ${f.blocked ? 'border-orange-600 bg-orange-50' : 'border-stone-300'}`}>Blocked by an incident: {c.blocked}</button>}
        </p>
      )}
      {data && <p className="mt-2 text-xs text-stone-600">Counts follow your filters below. &ldquo;Delayed&rdquo; = in progress and either blocked by an incident, past the pickup window, or {data.delayedRule.elapsedPercent}% or more of the stage&rsquo;s allowed time used. Updated {fmtDateTime(data.generatedAt)}.</p>}

      <form role="search" aria-label="Filter rescues" onSubmit={(e) => e.preventDefault()} className="mt-4 grid gap-3 rounded-2xl border border-stone-200 bg-white shadow-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <label htmlFor="f-q" className="block text-sm font-medium">Search</label>
          <input id="f-q" type="search" placeholder="Listing, organization or rescue id" maxLength={100} value={f.q} onChange={(e) => set('q', e.target.value)} className={input} />
        </div>
        <div>
          <label htmlFor="f-prov" className="block text-sm font-medium">Provider</label>
          <select id="f-prov" value={f.providerOrgId} onChange={(e) => set('providerOrgId', e.target.value)} className={input}>
            <option value="">Any</option>
            {options?.organizations.filter((o) => o.type === 'PROVIDER').map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-ngo" className="block text-sm font-medium">NGO</label>
          <select id="f-ngo" value={f.ngoOrgId} onChange={(e) => set('ngoOrgId', e.target.value)} className={input}>
            <option value="">Any</option>
            {options?.organizations.filter((o) => o.type === 'NGO').map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-run" className="block text-sm font-medium">Runner</label>
          <select id="f-run" value={f.runnerUserId} onChange={(e) => set('runnerUserId', e.target.value)} className={input}>
            <option value="">Any</option>
            {options?.runners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-mode" className="block text-sm font-medium">Transport</label>
          <select id="f-mode" value={f.transportMode} onChange={(e) => set('transportMode', e.target.value as RescueFilters['transportMode'])} className={input}>
            <option value="">Any</option>
            <option value="NGO_PICKUP">NGO collects</option>
            <option value="RUNNER">Runner-assisted</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-from" className="block text-sm font-medium">Started from</label>
          <input id="f-from" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} aria-invalid={fields.from ? true : undefined} className={input} />
          {fields.from && <p className="mt-1 text-sm text-red-700">{fields.from}</p>}
        </div>
        <div>
          <label htmlFor="f-to" className="block text-sm font-medium">Started until (inclusive)</label>
          <input id="f-to" type="date" value={f.to} onChange={(e) => set('to', e.target.value)} aria-invalid={fields.to ? true : undefined} className={input} />
          {fields.to && <p className="mt-1 text-sm text-red-700">{fields.to}</p>}
        </div>
        <div>
          <label htmlFor="f-age" className="block text-sm font-medium">Older than</label>
          <select id="f-age" value={f.olderThanMinutes} onChange={(e) => set('olderThanMinutes', e.target.value)} className={input}>
            <option value="">Any age</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="180">3 hours</option>
            <option value="720">12 hours</option>
            <option value="1440">1 day</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-sort" className="block text-sm font-medium">Order</label>
          <select id="f-sort" value={f.sort} onChange={(e) => set('sort', e.target.value as RescueFilters['sort'])} className={input}>
            <option value="attention">Needs attention first</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
        <div className="flex items-end">
          <button type="button" onClick={clear} disabled={!filtered} className="rounded-lg border border-stone-300 px-3 py-2.5 text-sm font-medium disabled:opacity-50">Clear filters</button>
        </div>
      </form>

      {error && (
        <div className="mt-4">
          <FormError message={error} />
          <button type="button" onClick={() => void load()} className="mt-2 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100">Try again</button>
        </div>
      )}
      {loading && !data && !error && <Loading label="Loading rescues…" />}
      {data && data.rescues.length === 0 && (
        <p className="fl-appear mt-4 rounded-2xl border border-dashed border-stone-300 bg-white/70 p-6 text-center text-stone-700">
          {filtered ? 'No rescues match these filters.' : 'No rescues yet. They appear here as soon as an NGO accepts a listing.'}
          {filtered && <> <button type="button" onClick={clear} className="font-medium text-paprika-700 underline">Clear filters</button></>}
        </p>
      )}
      {data && data.rescues.length > 0 && (
        <ul className="mt-4 space-y-3" aria-label="Rescues">
          {data.rescues.map((r) => <RescueCard key={r.id} r={r} />)}
        </ul>
      )}
      {data && <Pager page={data.page} onPage={setPageNo} onSize={(n) => { setSize(n); setPageNo(1); }} />}
    </div>
  );
}

/* ----------------------------------- listings tab ----------------------------------- */

const statusText: Record<string, string> = { PENDING: 'Scheduled', DONE: 'Done', SKIPPED: 'Skipped', CANCELLED: 'Cancelled' };

/** Where this listing is in its escalation waves, with the full wave history one click away. Counts only until asked for names. */
function EscalationBlock({ listingId, e }: { listingId: string; e: EscalationSummary }) {
  const [history, setHistory] = useState<EscalationHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  async function toggle(next: boolean) {
    setOpen(next);
    if (next && !history) {
      const r = await api<EscalationHistory>(`/admin/board/listings/${listingId}/escalation`);
      if (r.ok) setHistory(r.data);
      else setError(r.error.message);
    }
  }
  if (!e.enabled) return <p className="mt-2 text-sm text-stone-700">Escalation waves are switched off: every eligible NGO is told when a listing is published.</p>;
  if (e.round === null) return <p className="mt-2 text-sm text-stone-700">No escalation schedule for this listing.</p>;
  return (
    <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm">
      <ol aria-label="Escalation waves" className="mb-2 flex flex-wrap gap-1.5">
        {e.steps.map((st) => (
          <li
            key={st.seq}
            title={`${stepLabel(st)}: ${statusText[st.status]}`}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${
              st.status === 'DONE' ? 'border-stone-900 bg-stone-900 text-white' : st.status === 'PENDING' ? 'border-saffron-600 bg-saffron-50 text-stone-900' : 'border-stone-300 bg-white text-stone-600'
            }`}
          >
            <span aria-hidden>{st.status === 'DONE' ? '✓' : st.status === 'PENDING' ? '○' : st.status === 'SKIPPED' ? '–' : '✕'}</span>
            <span>{st.seq}</span>
            <span className="sr-only">{`${stepLabel(st)}, ${statusText[st.status]}`}</span>
          </li>
        ))}
      </ol>
      <p>
        <strong>Escalation:</strong> {e.completed} of {e.total} steps done
        {e.current ? <> · last: {stepLabel(e.current)}{e.current.status === 'SKIPPED' ? ' (skipped)' : ''}</> : ' · first wave not yet due'}
        {e.next ? <> · next: {stepLabel(e.next)} {fmtDateTime(e.next.dueAt)} (<TimeLeft deadline={e.next.dueAt} />)</> : ''}
      </p>
      <p className="mt-1 flex flex-wrap gap-2">
        {e.adminAlerted && <span className="rounded-full border border-orange-600 bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-900">Admin alerted</span>}
        {e.stopped && <span className="rounded-full border border-stone-400 bg-white px-2 py-0.5 text-xs font-semibold">Stopped: {stepReasonLabels[e.stopped] ?? e.stopped}</span>}
      </p>
      <details open={open} onToggle={(ev) => void toggle((ev.currentTarget as HTMLDetailsElement).open)} className="mt-2">
        <summary className="cursor-pointer font-medium text-paprika-700">Wave history</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Escalation steps for this listing</caption>
            <thead>
              <tr className="text-stone-600">
                <th scope="col" className="py-1 pr-3 font-medium">Step</th>
                <th scope="col" className="py-1 pr-3 font-medium">Status</th>
                <th scope="col" className="py-1 pr-3 font-medium">Scheduled</th>
                <th scope="col" className="py-1 pr-3 font-medium">Ran</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Qualified</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">New</th>
                <th scope="col" className="py-1 text-right font-medium">Told</th>
              </tr>
            </thead>
            <tbody>
              {e.steps.map((s) => (
                <tr key={s.seq} className="row-hover border-t border-stone-200 align-top">
                  <th scope="row" className="py-1 pr-3 font-normal">{s.seq}. {stepLabel(s)}</th>
                  <td className="py-1 pr-3">{statusText[s.status]}{s.reason ? ` (${stepReasonLabels[s.reason] ?? s.reason})` : ''}</td>
                  <td className="py-1 pr-3">{fmtDateTime(s.dueAt)}</td>
                  <td className="py-1 pr-3">{s.executedAt ? fmtDateTime(s.executedAt) : '–'}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{s.qualified ?? '–'}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{s.newlyEligible ?? '–'}</td>
                  <td className="py-1 text-right tabular-nums">{s.kind === 'ADMIN_ALERT' ? (s.notifiedUsers !== null ? `${s.notifiedUsers} admin${s.notifiedUsers === 1 ? '' : 's'}` : '–') : s.kind === 'RUNNER_WAVE' ? (s.notifiedUsers ?? '–') : (s.notifiedOrgs ?? '–')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        {history && history.rounds.some((r) => r.steps.some((s) => s.recipients.length > 0)) && (
          <div className="mt-3">
            <p className="font-medium">Who was told</p>
            <ul className="mt-1 space-y-1">
              {history.rounds.flatMap((r) => r.steps.filter((s) => s.recipients.length > 0).map((s) => (
                <li key={`${r.round}-${s.seq}`}>
                  {stepLabel(s)}: {s.recipients.map((x) => `${x.position}. ${x.organization?.name ?? x.runner?.name ?? 'Unknown'}${x.distanceKm !== null ? ` (${x.distanceKm} km)` : ''}`).join(', ')}
                </li>
              )))}
            </ul>
          </div>
        )}
        {e.round > 1 && <p className="mt-2 text-stone-600">Round {e.round}: the listing was released by a failed rescue and its waves started again.</p>}
      </details>
    </div>
  );
}

function ListingCard({ l }: { l: BoardListing }) {
  return (
    <li className={`row-hover rounded-2xl border border-l-8 p-4 shadow-card ${l.actionable ? 'border-stone-200 border-l-saffron-400 bg-white' : 'border-stone-200 border-l-stone-300 bg-stone-50 text-stone-700'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">{l.title}</h3>
          <p className="text-sm text-stone-700">{l.provider.name} · {foodCategoryLabels[l.foodCategory as FoodCategory] ?? l.foodCategory} · {l.servings} servings · {l.transportRequired ? 'transport needed' : 'collect directly'}</p>
        </div>
        {l.actionable ? (
          <span className="rounded-full border border-stone-400 bg-stone-50 px-2.5 py-0.5 text-sm"><TimeLeft deadline={l.pickupDeadline} urgency={l.urgency} /></span>
        ) : (
          <span className="rounded-full border border-stone-400 bg-stone-100 px-2.5 py-0.5 text-sm font-semibold">{l.status === 'CANCELLED' ? 'Cancelled' : 'Expired'} · not actionable</span>
        )}
      </div>
      <p className="mt-1 text-sm">Pickup window {fmtDateTime(l.pickupStart)} to {fmtDateTime(l.pickupDeadline)}{l.closedAt ? ` · closed ${fmtDateTime(l.closedAt)}` : ''}</p>
      {l.escalation && <EscalationBlock listingId={l.id} e={l.escalation} />}
      {l.actionable && (
        <>
          <p className="mt-1 text-sm">
            Matching: <strong>{l.matching.eligibleNgos}</strong> eligible NGO{l.matching.eligibleNgos === 1 ? '' : 's'}, {l.matching.notifiedNgos} notified · published {l.publishedAgoMs !== null ? `${durationText(l.publishedAgoMs)} ago` : ''}
          </p>
          {l.flags.includes('NO_ELIGIBLE_NGO') && <p role="note" className="mt-2 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">No eligible NGO right now: this food may need a manual introduction before the deadline.</p>}
          {l.flags.includes('NOT_YET_EVALUATED') && <p role="note" className="mt-2 rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm">Matching has not been evaluated for this listing yet.</p>}
        </>
      )}
    </li>
  );
}

function ListingsTab({ options }: { options: BoardOptions | null }) {
  const [scope, setScope] = useState<'live' | 'closed'>('live');
  const [urgency, setUrgency] = useState('');
  const [noEligible, setNoEligible] = useState(false);
  const [providerOrgId, setProviderOrgId] = useState('');
  const [text, setText] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [size, setSize] = useState(25);
  const [data, setData] = useState<BoardListings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const q = useDebounced(text);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ scope, page: String(pageNo), pageSize: String(size) });
    if (q.trim()) qs.set('q', q.trim());
    if (providerOrgId) qs.set('providerOrgId', providerOrgId);
    if (scope === 'live' && urgency) qs.set('urgency', urgency);
    if (scope === 'live' && noEligible) qs.set('noEligible', 'true');
    const mine = ++latest.current;
    const res = await api<BoardListings>(`/admin/board/listings?${qs}`);
    if (mine !== latest.current) return;
    setLoading(false);
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else setError(res.error.message);
  }, [scope, q, providerOrgId, urgency, noEligible, pageNo, size]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), 15_000);

  const reset = () => setPageNo(1);
  const c = data?.counts;
  return (
    <div>
      <div role="group" aria-label="Listing scope" className="inline-flex rounded-xl border border-stone-300 bg-white p-0.5">
        {(['live', 'closed'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={scope === s} onClick={() => { setScope(s); reset(); }} className={`min-h-10 rounded-lg px-4 py-1.5 text-sm font-semibold ${scope === s ? 'bg-paprika-600 text-white' : 'hover:bg-stone-100'}`}>
            {s === 'live' ? 'Live, not yet accepted' : 'Expired or cancelled (last 7 days)'}
          </button>
        ))}
      </div>
      {scope === 'live' && c && (
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {[['Live, unaccepted', c.total], ['No eligible NGO', c.noEligibleNgo], ['Critical', c.byUrgency.CRITICAL], ['Urgent', c.byUrgency.URGENT], ['Priority', c.byUrgency.PRIORITY], ['Normal', c.byUrgency.NORMAL]].map(([k, v]) => (
            <div key={k as string} className="rounded-2xl border border-stone-200 bg-white shadow-card p-3">
              <dt className="text-sm font-medium text-stone-700">{k}</dt>
              <dd className="mt-1 text-2xl font-bold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {scope === 'closed' && <p className="mt-3 text-sm text-stone-700">Context only: these listings ended without being rescued and cannot be acted on.</p>}

      <form role="search" aria-label="Filter listings" onSubmit={(e) => e.preventDefault()} className="mt-4 grid gap-3 rounded-2xl border border-stone-200 bg-white shadow-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="l-q" className="block text-sm font-medium">Search</label>
          <input id="l-q" type="search" maxLength={100} placeholder="Listing or provider" value={text} onChange={(e) => { setText(e.target.value); reset(); }} className={input} />
        </div>
        <div>
          <label htmlFor="l-prov" className="block text-sm font-medium">Provider</label>
          <select id="l-prov" value={providerOrgId} onChange={(e) => { setProviderOrgId(e.target.value); reset(); }} className={input}>
            <option value="">Any</option>
            {options?.organizations.filter((o) => o.type === 'PROVIDER').map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        {scope === 'live' && (
          <>
            <div>
              <label htmlFor="l-urg" className="block text-sm font-medium">Urgency</label>
              <select id="l-urg" value={urgency} onChange={(e) => { setUrgency(e.target.value); reset(); }} className={input}>
                <option value="">Any</option>
                <option value="CRITICAL">Critical (under 30 min)</option>
                <option value="URGENT">Urgent (under 1 h)</option>
                <option value="PRIORITY">Priority (1 to 2 h)</option>
                <option value="NORMAL">Normal</option>
              </select>
            </div>
            <label className="flex items-end gap-2 pb-1.5 text-sm font-medium">
              <input type="checkbox" checked={noEligible} onChange={(e) => { setNoEligible(e.target.checked); reset(); }} /> Only with no eligible NGO
            </label>
          </>
        )}
      </form>

      {error && (
        <div className="mt-4">
          <FormError message={error} />
          <button type="button" onClick={() => void load()} className="mt-2 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100">Try again</button>
        </div>
      )}
      {loading && !data && !error && <Loading label="Loading listings…" />}
      {data && data.listings.length === 0 && (
        <p className="mt-4 rounded-md border border-dashed border-stone-300 p-6 text-center text-stone-700">
          {scope === 'live' ? 'No live listings are waiting for a recipient with these filters.' : 'No expired or cancelled unaccepted listings in the last 7 days with these filters.'}
        </p>
      )}
      {data && data.listings.length > 0 && <ul className="mt-4 space-y-3" aria-label="Listings">{data.listings.map((l) => <ListingCard key={l.id} l={l} />)}</ul>}
      {data && <Pager page={data.page} onPage={setPageNo} onSize={(n) => { setSize(n); setPageNo(1); }} />}
    </div>
  );
}

/* ----------------------------------- the board ----------------------------------- */

export function OpsBoard() {
  const [tab, setTab] = useState<'rescues' | 'listings' | 'map'>('rescues');
  const [options, setOptions] = useState<BoardOptions | null>(null);
  useEffect(() => {
    void api<BoardOptions>('/admin/board/options').then((r) => r.ok && setOptions(r.data));
  }, []);
  return (
    <div className="mt-4">
      <div role="tablist" aria-label="Board sections" className="inline-flex rounded-xl border border-stone-300 bg-white p-0.5">
        {([['rescues', 'Rescues'], ['listings', 'Unaccepted listings'], ['map', 'Map']] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`min-h-10 rounded-lg px-4 py-1.5 text-sm font-semibold ${tab === id ? 'bg-paprika-600 text-white' : 'hover:bg-stone-100'}`}>{label}</button>
        ))}
      </div>
      <p className="mt-3 text-sm text-stone-700">Read-only overview. Interventions (cancel, reassign, resolve) are made on each rescue&rsquo;s page, with a reason, and are recorded in its audit history. These figures are operational counts: rescued-meal totals are on <Link href="/admin/impact" className="font-medium text-paprika-700 underline">Impact</Link>.</p>
      <div className="mt-4">{tab === 'rescues' ? <RescuesTab options={options} /> : tab === 'listings' ? <ListingsTab options={options} /> : <OpsMap />}</div>
    </div>
  );
}

/* ----------------------------------- panel on the admin rescue page ----------------------------------- */

export function AdminOpsPanel({ id, refreshKey }: { id: string; refreshKey: number }) {
  const [d, setD] = useState<BoardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api<BoardDetail>(`/admin/board/rescues/${id}`).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setD(r.data);
        setError(null);
      } else setError(r.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [id, refreshKey]);

  if (error) return <FormError message={error} />;
  if (!d) return null;
  const r = d.rescue;
  const open = r.state === 'active' || r.state === 'delayed';
  return (
    <section aria-labelledby="ops-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <h2 id="ops-h" className="flex flex-wrap items-center gap-2 text-lg font-semibold">Operations <StateBadge state={r.state} /></h2>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-stone-600">Stage</dt><dd>{statusLabels[r.status].label}</dd>
        {open && (<><dt className="text-stone-600">Next{r.stage.nextActor ? ` (${actorLabels[r.stage.nextActor]})` : ''}</dt><dd>{r.stage.nextAction}</dd></>)}
        {open && r.stage.deadline && (<><dt className="text-stone-600">{r.stage.deadline.label}</dt><dd>{fmtDateTime(r.stage.deadline.at)} · <TimeLeft deadline={r.stage.deadline.at} /></dd></>)}
        {open && r.stage.elapsedMs !== null && (<><dt className="text-stone-600">In this stage for</dt><dd>{durationText(r.stage.elapsedMs)}</dd></>)}
        <dt className="text-stone-600">Rescue age</dt><dd>{durationText(r.ageMs)} (started {fmtDateTime(r.startedAt)})</dd>
        {r.runner && (<><dt className="text-stone-600">Runner</dt><dd>{r.runner.name}</dd></>)}
      </dl>
      {r.delay && (
        <p role="note" className="mt-3 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900"><strong>Why delayed:</strong> {r.delay.text} Overdue action: {r.delay.overdueAction}.</p>
      )}
      <p className="mt-3 text-sm">
        {d.incidents.length === 0 ? 'No incidents reported.' : (
          <>Incidents: {d.incidents.map((i) => (
            <Link key={i.id} href={i.link} className="mr-3 font-medium text-paprika-700 underline">{i.category.replace(/_/g, ' ').toLowerCase()} ({i.severity.toLowerCase()}, {i.status.toLowerCase()})</Link>
          ))}</>
        )}
      </p>
      <p className="mt-1 text-sm text-stone-700">{d.auditEvents} audit event{d.auditEvents === 1 ? '' : 's'} are listed in History below. <Link href="/admin/board" className="font-medium text-paprika-700 underline">Back to the board</Link></p>
    </section>
  );
}
