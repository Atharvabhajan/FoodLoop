'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import {
  activeDeadline,
  outcomeLabels,
  statusLabels,
  useLiveRefresh,
  type RescueRole,
  type RescueStatus,
  type RescueSummary,
  type RescueView,
} from '@/lib/rescue';
import { dietaryTagLabels, foodCategoryLabels, packagingLabels, type FoodCategory, type Packaging } from '@/lib/supply';
import { Loading } from './Shell';
import { StageTrack } from './StageTrack';
import { AdminOpsPanel } from './OpsBoard';
import { IncidentList, IncidentReportForm, RescueMapSection, RunnerSection, ShareLocation, type SharedPoint } from './RunnerParts';
import { TimeLeft, fmtDateTime } from './SupplyParts';
import { FoodPhoto } from './FoodPhoto';
import { EmptyState, FormError } from './ui';

export function RescueStatusBadge({ status }: { status: RescueStatus }) {
  const s = statusLabels[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-semibold ${s.cls}`}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

/* ---------------------------------- list ---------------------------------- */

export function RescueList({ role }: { role: RescueRole }) {
  const [scope, setScope] = useState<'active' | 'past'>('active');
  const [items, setItems] = useState<RescueSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [mineOnly, setMineOnly] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ rescues: RescueSummary[] }>(`/rescues?scope=${scope}`);
    if (res.ok) {
      setItems(res.data.rescues);
      setError(null);
    } else setError(res.error.message);
  }, [scope]);
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);
  useLiveRefresh(() => void load());

  const needle = q.trim().toLowerCase();
  const shown = (items ?? []).filter((r) => (!mineOnly || r.nextAction.party === role) && (!needle || `${r.listingTitle} ${r.providerName} ${r.ngoName}`.toLowerCase().includes(needle)));

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Rescue filter" className="inline-flex rounded-xl border border-stone-300 bg-white p-0.5">
          {(['active', 'past'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={scope === s} onClick={() => setScope(s)} className={`min-h-10 rounded-lg px-4 py-1.5 text-sm font-semibold ${scope === s ? 'bg-brand-600 text-white' : 'hover:bg-stone-100'}`}>
              {s === 'active' ? 'In progress' : 'Finished'}
            </button>
          ))}
        </div>
        {items && items.length > 0 && (
          <form role="search" aria-label="Filter rescues" onSubmit={(e) => e.preventDefault()} className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <label htmlFor="rl-q" className="sr-only">Search rescues</label>
            <input id="rl-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search food, provider or NGO" className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm hover:border-stone-400 sm:max-w-sm" />
            {scope === 'active' && (
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Only where I must act next
              </label>
            )}
          </form>
        )}
      </div>
      {items && scope === 'active' && items.length > 0 && (
        <p className="mt-3 text-sm text-stone-700" role="status">
          {items.length} in progress · <strong>{items.filter((r) => r.nextAction.party === role).length} waiting for you</strong>
        </p>
      )}
      <div className="mt-3"><FormError message={error} /></div>
      {!items && !error && <Loading label="Loading rescues…" />}
      {items && items.length === 0 && (
        <EmptyState title={scope === 'active' ? 'Nothing in progress' : 'No finished rescues yet'} photo={role === 'runner' ? 'volunteer-handoff' : role === 'provider' ? 'provider-kitchen' : 'volunteers-serving'}>
          {scope === 'active'
            ? role === 'ngo' ? 'Accept food from Live food to start a rescue.' : role === 'runner' ? 'Accept a job from Available jobs to start one.' : role === 'admin' ? 'Rescues appear here as soon as an NGO accepts a listing.' : 'Rescues appear here when an NGO accepts one of your listings.'
            : 'Completed, cancelled and failed rescues are kept here.'}
        </EmptyState>
      )}
      {items && items.length > 0 && shown.length === 0 && <p className="fl-appear mt-4 rounded-2xl border border-dashed border-stone-300 bg-white/70 p-6 text-center text-stone-700">No rescues match these filters. <button type="button" onClick={() => { setQ(''); setMineOnly(false); }} className="font-semibold text-brand-700 underline">Clear filters</button></p>}
      {items && shown.length > 0 && (
        <ul className="stagger mt-4 grid gap-3 xl:grid-cols-2">
          {shown.map((r) => {
            const d = activeDeadline(r);
            const mine = scope === 'active' && r.nextAction.party === role;
            return (
              <li key={r.id}>
                <Link href={`/${role}/rescues/${r.id}`} className={`lift block h-full rounded-2xl border-2 bg-white p-4 shadow-card ${mine ? 'border-brand-500' : 'border-stone-200'}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-bold uppercase tracking-wider text-stone-600">{role === 'ngo' ? `From ${r.providerName}` : role === 'provider' ? `To ${r.ngoName}` : `${r.providerName} → ${r.ngoName}`}</p>
                      <span className="text-lg font-bold" style={{ fontFamily: 'var(--font-display)' }}>{r.listingTitle}</span>
                    </div>
                    <RescueStatusBadge status={r.status} />
                  </div>
                  <StageTrack status={r.status} compact />
                  <p className="mt-2 text-sm text-stone-700">
                    {r.servingsOffered} servings{r.transportMode === 'RUNNER' && role !== 'runner' ? ' · runner-assisted' : ''}
                    {r.deliveredServings !== null ? ` · ${r.deliveredServings} received` : ''}
                    {d ? <> · {d.label}: <TimeLeft deadline={d.at} /></> : null}
                  </p>
                  <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${mine ? 'bg-brand-50 font-semibold text-stone-900' : 'bg-stone-100 text-stone-800'}`}>
                    <span className="font-bold">{mine ? 'Your next step: ' : 'Next: '}</span>{r.nextAction.text}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/* --------------------------------- detail --------------------------------- */

const eventText = (e: RescueView['history'][number]) => {
  if (e.eventType === 'ACCEPTED') return 'Accepted by the NGO';
  if (e.eventType === 'PICKUP_CODE_ISSUED') return 'Pickup code issued';
  if (e.eventType === 'PICKUP_CODE_REJECTED') return 'Wrong pickup code entered';
  if (e.eventType === 'RUNNER_SEARCH_STARTED') return 'Looking for a runner';
  if (e.eventType === 'INCIDENT_REPORTED') return 'Incident reported';
  if (e.eventType === 'INCIDENT_EVIDENCE_ADDED') return 'Photo added to an incident';
  if (e.eventType === 'INCIDENT_RESOLVED') return 'Incident resolved by an admin';
  if (e.eventType === 'RETENTION_PURGED') return 'Incident photos or records removed under the retention policy';
  if (e.eventType === 'STATUS_CHANGED' && e.fromStatus === 'PICKUP_ASSIGNED' && e.toStatus === 'AWAITING_RUNNER') return 'Runner released the job: looking for another';
  if (e.eventType === 'STATUS_CHANGED' && e.fromStatus === 'AWAITING_RUNNER' && e.toStatus === 'PICKUP_ASSIGNED') return e.actorRole === 'runner' ? 'A runner accepted the job' : 'The NGO will collect it themselves';
  return e.toStatus ? statusLabels[e.toStatus].label : e.eventType;
};

function ContactBlock({ title, name, contact, hiddenText }: { title: string; name: string; contact: RescueView['provider']['contact']; hiddenText: string }) {
  return (
    <div className="rounded-md border border-stone-200 p-3 text-sm">
      <p className="font-medium">{title}: {name}</p>
      {contact ? (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-stone-600">Contact</dt><dd>{contact.contactName ?? '-'}</dd>
          <dt className="text-stone-600">Phone</dt><dd>{contact.contactPhone ?? '-'}</dd>
          <dt className="text-stone-600">Email</dt><dd>{contact.contactEmail ?? '-'}</dd>
        </dl>
      ) : (
        <p className="mt-1 text-stone-600">{hiddenText}</p>
      )}
    </div>
  );
}

type Panel = null | 'reject' | 'cancel' | 'verify' | 'delivery' | 'admin_cancel' | 'admin_resolve' | 'release' | 'handover' | 'admin_reassign' | 'admin_fail' | 'incident';

export function RescueDetail({ id, role }: { id: string; role: RescueRole }) {
  const [r, setR] = useState<RescueView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null); // shown to the provider once, right after it is issued
  const [panel, setPanel] = useState<Panel>(null);
  const [mine, setMine] = useState<SharedPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [servings, setServings] = useState('');
  const [notes, setNotes] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    const res = await api<{ rescue: RescueView }>(`/rescues/${id}`);
    if (res.ok) {
      setR(res.data.rescue);
      setRefreshKey((k) => k + 1);
      setError((e) => (e && e.startsWith('This rescue was not found') ? e : null));
    } else setError(res.error.status === 404 ? 'This rescue was not found.' : res.error.message);
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load());

  async function act(path: string, body: Record<string, unknown>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setFields({});
    const res = await api<{ rescue: RescueView; pickupCode?: string | null; changed?: boolean }>(`/rescues/${id}${path}`, {
      method: 'POST',
      body: JSON.stringify({ ...body, ...(r && !path.startsWith('/admin') ? { expectedVersion: r.version } : {}) }),
    });
    setBusy(false);
    if (res.ok) {
      setR(res.data.rescue);
      setNotice(success);
      setPanel(null);
      setReason('');
      setCodeInput('');
      setNotes('');
      if (res.data.pickupCode) setCode(res.data.pickupCode);
    } else {
      setFields(res.error.fields);
      if (res.error.code === 'STALE_RESCUE' || res.error.code === 'INVALID_RESCUE_TRANSITION') {
        setError(`${res.error.message} The page has been refreshed.`);
        await load();
      } else setError(res.error.message);
    }
  }

  if (error && !r) return <div className="mt-4"><FormError message={error} /></div>;
  if (!r) return <Loading label="Loading rescue…" />;

  const can = (a: string) => r.allowedActions.includes(a);
  const deadline = activeDeadline(r);
  const exact = r.listing.exactPickup;
  const finished = !['RESERVED', 'AWAITING_RUNNER', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DELIVERED', 'RECIPIENT_CONFIRMED', 'DELIVERY_FAILED'].includes(r.status) || r.status === 'COMPLETED';
  const btn = 'rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-60';

  const reasonForm = (title: string, submitLabel: string, path: string, success: string, tone = 'bg-red-700 text-white hover:bg-red-800') => (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (reason.trim().length < 3) return setFields({ reason: 'A reason is required.' });
        void act(path, { reason: reason.trim() }, success);
      }}
      noValidate
      className="mt-3 rounded-lg border border-stone-300 p-3"
    >
      <label htmlFor="reason" className="block text-sm font-medium">{title} (required)</label>
      <textarea id="reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={fields.reason ? true : undefined} className={`mt-1 block w-full rounded-md border px-3 py-2 ${fields.reason ? 'border-red-600' : 'border-stone-300'}`} />
      {fields.reason && <p className="mt-1 text-sm text-red-700">{fields.reason}</p>}
      <div className="mt-2 flex gap-3">
        <button type="submit" disabled={busy} className={`${btn} ${tone}`}>{busy ? 'Saving…' : submitLabel}</button>
        <button type="button" onClick={() => { setPanel(null); setFields({}); }} className={`${btn} border border-stone-300`}>Back</button>
      </div>
    </form>
  );

  const mapSection = <RescueMapSection r={r} role={role} refreshKey={refreshKey} mine={mine} />;
  return (
    <div className="space-y-4">
      {notice && <p role="status" className="fl-appear rounded-xl border-2 border-stone-900 bg-white px-4 py-3 text-sm font-semibold text-stone-900 shadow-card">✓ {notice}</p>}
      <FormError message={error} />

      {/* Status and who acts next */}
      <section aria-labelledby="st" className="fl-appear overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-card">
        <div className="flex flex-col sm:flex-row">
          <div className="h-40 shrink-0 sm:h-auto sm:w-56">
            <FoodPhoto l={{ id: r.listing.id, title: r.listing.title, foodCategory: r.listing.foodCategory as FoodCategory, hasImage: r.listing.hasImage && role !== 'admin' }} className="h-full w-full object-cover" />
          </div>
          <div className="min-w-0 flex-1 p-4 md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wider text-brand-700">{r.provider.name} → {r.ngo.name}</p>
                <h2 id="st" className="text-2xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>{r.listing.title}</h2>
                <p className="text-sm text-stone-700">{r.listing.servingsOffered} servings · {r.transportMode === 'RUNNER' ? 'runner-assisted' : 'NGO collects'}</p>
              </div>
              <RescueStatusBadge status={r.status} />
            </div>
            <StageTrack status={r.status} />
            <div className={`mt-4 rounded-xl p-3 ${r.nextAction.party === role && !finished ? 'border-2 border-brand-500 bg-brand-50' : 'bg-stone-100'}`}>
              <p className="text-xs font-bold uppercase tracking-wide text-stone-700">{finished ? 'Status' : r.nextAction.party === role ? 'Your next step' : r.nextAction.party ? `Next step (${r.nextAction.party})` : 'Next step'}</p>
              <p className="mt-0.5 font-semibold">{r.nextAction.text}</p>
              {deadline && <p className="mt-1 text-sm text-stone-700">{deadline.label} by {fmtDateTime(deadline.at)} · <TimeLeft deadline={deadline.at} /></p>}
            </div>
            {r.blockedByIncident && (
              <p role="alert" className="mt-3 rounded-lg border-2 border-red-600 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900">
                An open incident has paused this rescue. The normal next steps are unavailable until an admin resolves it.
              </p>
            )}
            {finished && r.outcomeCode && (
              <p className="mt-3 rounded-lg bg-stone-100 px-3 py-2 text-sm">
                <strong>Outcome:</strong> {outcomeLabels[r.outcomeCode] ?? r.outcomeCode}
                {r.outcomeReason ? ` (${r.outcomeReason})` : ''}
                {r.collectedServings !== null ? ` · ${r.collectedServings} collected` : ''}
                {r.deliveredServings !== null ? ` · ${r.deliveredServings} received` : ''}
              </p>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)] lg:items-start">
        <div className="min-w-0 space-y-4">
      {/* Pickup code (provider only, once) */}
      {role === 'provider' && code && (
        <section aria-labelledby="code" role="status" className="rounded-xl border-2 border-brand-600 bg-brand-50 p-5">
          <h2 id="code" className="text-lg font-semibold">Pickup code</h2>
          <p className="mt-1 text-sm">Give this code to the NGO when they collect the food. It is shown only now and works once.</p>
          <p className="mt-2 font-mono text-3xl font-bold tracking-widest" aria-label={`Pickup code ${code.split('').join(' ')}`}>{code}</p>
        </section>
      )}
      {role === 'provider' && r.pickupCode && !code && (
        <p className="rounded-md bg-stone-100 px-3 py-2 text-sm">
          A pickup code was issued. {r.pickupCode.locked ? 'It is locked after too many wrong attempts: generate a new one.' : `${r.pickupCode.attemptsLeft} wrong attempts left.`} For security it is not shown again; generate a new one if the NGO needs it.
        </p>
      )}

      {/* Actions */}
      {r.allowedActions.length > 0 && (
        <section aria-labelledby="act" className="fl-appear rounded-2xl border-2 border-brand-600 bg-white p-5 shadow-card">
          <h2 id="act" className="text-lg font-semibold">Actions</h2>
          {panel === null && (
            <div className="mt-3 flex flex-wrap gap-3">
              {can('confirm') && <button disabled={busy} onClick={() => void act('/confirm', {}, 'Hand-off confirmed. The pickup code is shown below.')} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>{busy ? 'Confirming…' : 'Confirm hand-off'}</button>}
              {can('regenerate_code') && <button disabled={busy} onClick={() => void act('/pickup-code', {}, 'A new pickup code was issued.')} className={`${btn} border border-brand-600 text-brand-700`}>Generate new pickup code</button>}
              {can('reject') && <button onClick={() => setPanel('reject')} className={`${btn} border border-red-600 text-red-800`}>Decline…</button>}
              {can('verify_pickup') && <button onClick={() => { setServings(String(r.listing.servingsOffered)); setPanel('verify'); }} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>Verify pickup</button>}
              {can('confirm_delivery') && <button onClick={() => { setServings(String(r.collectedServings ?? '')); setPanel('delivery'); }} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>Confirm food received</button>}
              {can('report_incident') && <button onClick={() => setPanel('incident')} className={`${btn} border border-orange-600 text-orange-900`}>Report a problem…</button>}
              {can('collect_myself') && <button disabled={busy} onClick={() => void act('/transport/self', {}, 'You will collect this food yourself. You will need the provider pickup code at pickup.')} className={`${btn} border border-brand-600 text-brand-700`}>Collect it myself instead</button>}
              {can('release_assignment') && <button onClick={() => setPanel('release')} className={`${btn} border border-red-600 text-red-800`}>Release this job…</button>}
              {can('handover') && <button onClick={() => { setNotes(''); setPanel('handover'); }} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>Hand over to the NGO</button>}
              {can('cancel') && <button onClick={() => setPanel('cancel')} className={`${btn} border border-red-600 text-red-800`}>Cancel rescue…</button>}
              {can('admin_reassign') && <button onClick={() => setPanel('admin_reassign')} className={`${btn} border border-brand-600 text-brand-700`}>Reassign runner…</button>}
              {can('admin_fail') && <button onClick={() => setPanel('admin_fail')} className={`${btn} border border-red-600 text-red-800`}>Mark delivery failed…</button>}
              {can('admin_cancel') && <button onClick={() => setPanel('admin_cancel')} className={`${btn} border border-red-600 text-red-800`}>Cancel as admin…</button>}
              {can('admin_resolve') && <button onClick={() => { setServings(String(r.collectedServings ?? '')); setPanel('admin_resolve'); }} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>Resolve as admin…</button>}
            </div>
          )}
          {panel === 'reject' && reasonForm('Why are you declining?', 'Decline request', '/reject', 'Request declined. The listing is open to other NGOs again.')}
          {panel === 'cancel' && reasonForm(role === 'provider' ? 'Why are you withdrawing this food?' : 'Why are you cancelling?', 'Confirm cancellation', '/cancel', 'Rescue cancelled.')}
          {panel === 'admin_cancel' && reasonForm('Reason for cancelling', 'Cancel rescue', '/admin/cancel', 'Rescue cancelled and recorded in the audit history.')}
          {panel === 'incident' && <IncidentReportForm rescueId={r.id} onCancel={() => setPanel(null)} onDone={(m) => { setNotice(m); setPanel(null); void load(); }} />}
          {panel === 'release' && reasonForm('Why can you not continue?', 'Release job', '/runner/release', 'Job released. Other runners can now take it.')}
          {panel === 'admin_reassign' && reasonForm('Why is the runner being replaced?', 'Reassign', '/admin/reassign', 'The runner was removed and the job is open to others.', 'bg-brand-600 text-white hover:bg-brand-700')}
          {panel === 'admin_fail' && reasonForm('Why did the delivery fail?', 'Mark as failed', '/admin/fail', 'Delivery marked as failed and recorded in the audit history.')}
          {panel === 'handover' && (
            <form onSubmit={(e) => { e.preventDefault(); void act('/delivery/handover', notes.trim() ? { note: notes.trim() } : {}, 'Handed over. The NGO now confirms the quantity received.'); }} noValidate className="mt-3 grid max-w-sm gap-3">
              <p className="text-sm">Confirm that you have given the food to {r.ngo.name}. The NGO then confirms how much arrived; you cannot mark the rescue complete yourself.</p>
              <div>
                <label htmlFor="hn" className="block text-sm font-medium">Note (optional, no personal details)</label>
                <input id="hn" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5" />
              </div>
              <div className="flex gap-3">
                <button type="submit" disabled={busy} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>{busy ? 'Saving…' : 'Yes, handed over'}</button>
                <button type="button" onClick={() => { setPanel(null); setFields({}); }} className={`${btn} border border-stone-300`}>Back</button>
              </div>
            </form>
          )}
          {panel === 'verify' && (
            <form onSubmit={(e) => { e.preventDefault(); void act('/pickup/verify', { code: codeInput.trim(), collectedServings: Number(servings) }, 'Pickup verified.'); }} noValidate className="mt-3 grid max-w-sm gap-3">
              <div>
                <label htmlFor="pcode" className="block text-sm font-medium">6-digit pickup code from the provider{role === 'runner' ? ' (ask them at the pickup)' : ''}</label>
                <input id="pcode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={codeInput} onChange={(e) => setCodeInput(e.target.value)} aria-invalid={fields.code ? true : undefined} className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5 font-mono text-lg tracking-widest" />
              </div>
              <div>
                <label htmlFor="coll" className="block text-sm font-medium">Servings collected (offered: {r.listing.servingsOffered})</label>
                <input id="coll" type="number" inputMode="numeric" min={1} max={r.listing.servingsOffered} value={servings} onChange={(e) => setServings(e.target.value)} className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5" />
                {fields.collectedServings && <p className="mt-1 text-sm text-red-700">{fields.collectedServings}</p>}
              </div>
              {r.pickupCode && <p className="text-xs text-stone-600">{r.pickupCode.attemptsLeft} attempts left.</p>}
              <div className="flex gap-3">
                <button type="submit" disabled={busy} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>{busy ? 'Verifying…' : 'Verify pickup'}</button>
                <button type="button" onClick={() => { setPanel(null); setFields({}); }} className={`${btn} border border-stone-300`}>Back</button>
              </div>
            </form>
          )}
          {panel === 'delivery' && (
            <form onSubmit={(e) => { e.preventDefault(); void act('/delivery/confirm', { deliveredServings: Number(servings), ...(notes.trim() ? { notes: notes.trim() } : {}) }, 'Receipt confirmed. The rescue is complete.'); }} noValidate className="mt-3 grid max-w-sm gap-3">
              <div>
                <label htmlFor="recv" className="block text-sm font-medium">Servings actually received (collected: {r.collectedServings})</label>
                <input id="recv" type="number" inputMode="numeric" min={1} max={r.collectedServings ?? undefined} value={servings} onChange={(e) => setServings(e.target.value)} className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5" />
                {fields.deliveredServings && <p className="mt-1 text-sm text-red-700">{fields.deliveredServings}</p>}
              </div>
              <div>
                <label htmlFor="rn" className="block text-sm font-medium">Notes (optional)</label>
                <input id="rn" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5" />
              </div>
              <div className="flex gap-3">
                <button type="submit" disabled={busy} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>{busy ? 'Saving…' : 'Confirm received'}</button>
                <button type="button" onClick={() => { setPanel(null); setFields({}); }} className={`${btn} border border-stone-300`}>Back</button>
              </div>
            </form>
          )}
          {panel === 'admin_resolve' && (
            <form onSubmit={(e) => { e.preventDefault(); if (reason.trim().length < 3) return setFields({ reason: 'A reason is required.' }); void act('/admin/resolve', { deliveredServings: Number(servings), reason: reason.trim() }, 'Rescue resolved and recorded.'); }} noValidate className="mt-3 grid max-w-sm gap-3">
              <div>
                <label htmlFor="rs" className="block text-sm font-medium">Servings received (collected: {r.collectedServings})</label>
                <input id="rs" type="number" inputMode="numeric" min={0} value={servings} onChange={(e) => setServings(e.target.value)} className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5" />
                {fields.deliveredServings && <p className="mt-1 text-sm text-red-700">{fields.deliveredServings}</p>}
              </div>
              <div>
                <label htmlFor="rr" className="block text-sm font-medium">Reason (required)</label>
                <textarea id="rr" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5" />
                {fields.reason && <p className="mt-1 text-sm text-red-700">{fields.reason}</p>}
              </div>
              <div className="flex gap-3">
                <button type="submit" disabled={busy} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>{busy ? 'Saving…' : 'Record resolution'}</button>
                <button type="button" onClick={() => { setPanel(null); setFields({}); }} className={`${btn} border border-stone-300`}>Back</button>
              </div>
            </form>
          )}
        </section>
      )}

      {role === 'runner' && r.trackingActive && <ShareLocation rescueId={r.id} onPosition={setMine} />}
      {role === 'runner' && mapSection}
      {r.incidents.length > 0 && (
        <section aria-labelledby="inc-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
          <h2 id="inc-h" className="text-lg font-semibold">Incidents</h2>
          <IncidentList incidents={r.incidents} />
          {role === 'admin' && r.incidents.some((i) => i.status === 'OPEN') && (
            <p className="mt-3 text-sm"><Link href="/admin/incidents" className="font-medium text-brand-700 underline">Review and resolve open incidents →</Link></p>
          )}
        </section>
      )}

      {/* Food and hand-off details */}
      <section aria-labelledby="food" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
        <h2 id="food" className="text-lg font-semibold">The food</h2>
                <p className="mt-2 text-sm">
          {foodCategoryLabels[r.listing.foodCategory as FoodCategory] ?? r.listing.foodCategory} · <strong>{r.listing.servingsOffered} servings</strong> · {packagingLabels[r.listing.packaging as Packaging] ?? r.listing.packaging} · {r.listing.transportRequired ? 'Transport needed' : 'Collect directly'}
        </p>
        {r.listing.dietaryTags.length > 0 && <p className="mt-1 text-sm">{r.listing.dietaryTags.map((t) => dietaryTagLabels[t] ?? t).join(', ')}</p>}
        {r.listing.allergenNotes && <p className="mt-1 text-sm">Allergens: {r.listing.allergenNotes}</p>}
        <p className="mt-1 text-sm text-stone-700">Pickup window: {fmtDateTime(r.listing.pickupStart)} to {fmtDateTime(r.listing.pickupDeadline)}</p>
      </section>
      {/* History */}
      <section aria-labelledby="hist" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
        <h2 id="hist" className="text-lg font-semibold">History</h2>
        <ol className="mt-3 space-y-3">
          {r.history.map((h) => (
            <li key={h.id} className="border-l-2 border-stone-300 pl-3 text-sm">
              <p className="font-medium">{eventText(h)}</p>
              <p className="text-stone-600">{fmtDateTime(h.createdAt)} · {h.actorRole}</p>
              {h.reason && <p className="mt-1">&ldquo;{h.reason}&rdquo;</p>}
            </li>
          ))}
        </ol>
      </section>
        </div>

        <aside className="space-y-4" aria-label="Where and who">
          {role !== 'runner' && mapSection}
          <RunnerSection r={r} role={role} />
          <section aria-labelledby="where-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
            <h2 id="where-h" className="text-lg font-semibold">Pickup and contacts</h2>
        <div className="mt-3 rounded-xl bg-stone-100 p-3 text-sm">
          {exact ? (
            <p><strong>Pickup address:</strong> {exact.addressLine}, {exact.city}</p>
          ) : (
            <p>
              <strong>Area:</strong> {r.listing.approximateArea.city} (approximate).{' '}
              {r.status === 'RESERVED' ? 'The exact address is shared once the provider confirms the hand-off.' : 'The exact address is only shown while a hand-off is in progress.'}
            </p>
          )}
        </div>
        <div className="mt-3 grid gap-3">
          <ContactBlock title="Provider" name={r.provider.name} contact={r.provider.contact} hiddenText={r.status === 'RESERVED' ? 'Contact details are shared after the provider confirms.' : 'Contact details are only shown while a hand-off is in progress.'} />
          <ContactBlock title="NGO" name={r.ngo.name} contact={r.ngo.contact} hiddenText={r.status === 'RESERVED' ? 'Contact details are shared after you confirm the hand-off.' : 'Contact details are only shown while a hand-off is in progress.'} />
        </div>
          </section>
      {role === 'admin' && <AdminOpsPanel id={r.id} refreshKey={refreshKey} />}
        </aside>
      </div>
    </div>
  );
}
