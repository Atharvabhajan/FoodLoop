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
import { dietaryTagLabels, foodCategoryLabels, listingImageUrl, packagingLabels, type FoodCategory, type Packaging } from '@/lib/supply';
import { Loading } from './Shell';
import { StageTrack } from './StageTrack';
import { AdminOpsPanel } from './OpsBoard';
import { IncidentList, IncidentReportForm, RescueMapSection, RunnerSection, ShareLocation, type SharedPoint } from './RunnerParts';
import { TimeLeft, fmtDateTime } from './SupplyParts';
import { FormError } from './ui';

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
      <div role="tablist" aria-label="Rescue filter" className="mt-4 inline-flex rounded-md border border-stone-300 bg-white p-0.5">
        {(['active', 'past'] as const).map((s) => (
          <button key={s} role="tab" aria-selected={scope === s} onClick={() => setScope(s)} className={`rounded px-4 py-1.5 text-sm font-medium ${scope === s ? 'bg-paprika-600 text-white' : 'hover:bg-stone-100'}`}>
            {s === 'active' ? 'In progress' : 'Finished'}
          </button>
        ))}
      </div>
      {items && items.length > 0 && (
        <form role="search" aria-label="Filter rescues" onSubmit={(e) => e.preventDefault()} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <label htmlFor="rl-q" className="block text-sm font-semibold">Search</label>
            <input id="rl-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Food, provider or NGO" className="mt-1 block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm hover:border-stone-400" />
          </div>
          {scope === 'active' && (
            <label className="flex items-center gap-2 pb-2 text-sm font-medium">
              <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Only where I must act next
            </label>
          )}
        </form>
      )}
      <div className="mt-4"><FormError message={error} /></div>
      {!items && !error && <Loading label="Loading rescues…" />}
      {items && items.length === 0 && (
        <p className="mt-4 rounded-md border border-dashed border-stone-300 p-6 text-center text-stone-700">
          {scope === 'active'
            ? role === 'ngo' ? 'No rescues in progress. Accept a recommended listing from Live food to start one.' : role === 'runner' ? 'No rescues in progress. Accept a job from Available jobs to start one.' : 'No rescues in progress. They appear here when an NGO accepts one of your listings.'
            : 'No finished rescues yet.'}
        </p>
      )}
      {items && items.length > 0 && shown.length === 0 && <p className="fl-appear mt-4 rounded-2xl border border-dashed border-stone-300 bg-white/70 p-6 text-center text-stone-700">No rescues match these filters. <button type="button" onClick={() => { setQ(''); setMineOnly(false); }} className="font-semibold text-paprika-700 underline">Clear filters</button></p>}
      {items && shown.length > 0 && (
        <ul className="mt-4 space-y-3">
          {shown.map((r) => {
            const d = activeDeadline(r);
            return (
              <li key={r.id}>
                <Link href={`/${role}/rescues/${r.id}`} className="lift block rounded-2xl border border-stone-200 bg-white shadow-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-lg font-semibold">{r.listingTitle}</span>
                    <RescueStatusBadge status={r.status} />
                  </div>
                  <StageTrack status={r.status} compact />
                  <p className="mt-1 text-sm text-stone-700">
                    {role === 'ngo' ? `From ${r.providerName}` : role === 'provider' ? `To ${r.ngoName}` : `${r.providerName} → ${r.ngoName}`} · {r.servingsOffered} servings{r.transportMode === 'RUNNER' && role !== 'runner' ? ' · runner-assisted' : ''}
                    {r.deliveredServings !== null ? ` (${r.deliveredServings} received)` : ''}
                  </p>
                  <p className="mt-1 text-sm text-stone-800"><strong>Next:</strong> {r.nextAction.text}</p>
                  {d && <p className="text-sm text-stone-600">{d.label}: <TimeLeft deadline={d.at} /></p>}
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

  return (
    <div className="mt-4 space-y-6">
      {notice && <p role="status" className="fl-appear rounded-lg border border-stone-900 bg-stone-100 px-4 py-3 text-sm font-medium text-stone-900">✓ {notice}</p>}
      <FormError message={error} />

      {/* Status and who acts next */}
      <section aria-labelledby="st" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="st" className="text-lg font-semibold">{r.listing.title}</h2>
          <RescueStatusBadge status={r.status} />
        </div>
        <StageTrack status={r.status} />
        <p className="mt-3 text-sm"><strong>Next step{r.nextAction.party ? ` (${r.nextAction.party})` : ''}:</strong> {r.nextAction.text}</p>
        {deadline && <p className="mt-1 text-sm text-stone-700">{deadline.label} by {fmtDateTime(deadline.at)} · <TimeLeft deadline={deadline.at} /></p>}
        {r.blockedByIncident && (
          <p role="alert" className="mt-2 rounded-md border border-red-400 bg-red-50 px-3 py-2 text-sm font-medium text-red-900">
            An open incident has paused this rescue. The normal next steps are unavailable until an admin resolves it.
          </p>
        )}
        {finished && r.outcomeCode && (
          <p className="mt-2 rounded-md bg-stone-100 px-3 py-2 text-sm">
            <strong>Outcome:</strong> {outcomeLabels[r.outcomeCode] ?? r.outcomeCode}
            {r.outcomeReason ? ` (${r.outcomeReason})` : ''}
            {r.collectedServings !== null ? ` · ${r.collectedServings} collected` : ''}
            {r.deliveredServings !== null ? ` · ${r.deliveredServings} received` : ''}
          </p>
        )}
      </section>

      {role === 'admin' && <AdminOpsPanel id={r.id} refreshKey={refreshKey} />}

      {/* Pickup code (provider only, once) */}
      {role === 'provider' && code && (
        <section aria-labelledby="code" role="status" className="rounded-xl border-2 border-paprika-600 bg-paprika-50 p-5">
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
        <section aria-labelledby="act" className="fl-appear rounded-2xl border-2 border-paprika-600 bg-white p-5 shadow-card">
          <h2 id="act" className="text-lg font-semibold">Actions</h2>
          {panel === null && (
            <div className="mt-3 flex flex-wrap gap-3">
              {can('confirm') && <button disabled={busy} onClick={() => void act('/confirm', {}, 'Hand-off confirmed. The pickup code is shown below.')} className={`${btn} bg-paprika-600 text-white hover:bg-paprika-700`}>{busy ? 'Confirming…' : 'Confirm hand-off'}</button>}
              {can('regenerate_code') && <button disabled={busy} onClick={() => void act('/pickup-code', {}, 'A new pickup code was issued.')} className={`${btn} border border-paprika-600 text-paprika-700`}>Generate new pickup code</button>}
              {can('reject') && <button onClick={() => setPanel('reject')} className={`${btn} border border-red-600 text-red-800`}>Decline…</button>}
              {can('verify_pickup') && <button onClick={() => { setServings(String(r.listing.servingsOffered)); setPanel('verify'); }} className={`${btn} bg-paprika-600 text-white hover:bg-paprika-700`}>Verify pickup</button>}
              {can('confirm_delivery') && <button onClick={() => { setServings(String(r.collectedServings ?? '')); setPanel('delivery'); }} className={`${btn} bg-paprika-600 text-white hover:bg-paprika-700`}>Confirm food received</button>}
              {can('report_incident') && <button onClick={() => setPanel('incident')} className={`${btn} border border-orange-600 text-orange-900`}>Report a problem…</button>}
              {can('collect_myself') && <button disabled={busy} onClick={() => void act('/transport/self', {}, 'You will collect this food yourself. You will need the provider pickup code at pickup.')} className={`${btn} border border-paprika-600 text-paprika-700`}>Collect it myself instead</button>}
              {can('release_assignment') && <button onClick={() => setPanel('release')} className={`${btn} border border-red-600 text-red-800`}>Release this job…</button>}
              {can('handover') && <button onClick={() => { setNotes(''); setPanel('handover'); }} className={`${btn} bg-paprika-600 text-white hover:bg-paprika-700`}>Hand over to the NGO</button>}
              {can('cancel') && <button onClick={() => setPanel('cancel')} className={`${btn} border border-red-600 text-red-800`}>Cancel rescue…</button>}
              {can('admin_reassign') && <button onClick={() => setPanel('admin_reassign')} className={`${btn} border border-paprika-600 text-paprika-700`}>Reassign runner…</button>}
              {can('admin_fail') && <button onClick={() => setPanel('admin_fail')} className={`${btn} border border-red-600 text-red-800`}>Mark delivery failed…</button>}
              {can('admin_cancel') && <button onClick={() => setPanel('admin_cancel')} className={`${btn} border border-red-600 text-red-800`}>Cancel as admin…</button>}
              {can('admin_resolve') && <button onClick={() => { setServings(String(r.collectedServings ?? '')); setPanel('admin_resolve'); }} className={`${btn} bg-paprika-600 text-white hover:bg-paprika-700`}>Resolve as admin…</button>}
            </div>
          )}
          {panel === 'reject' && reasonForm('Why are you declining?', 'Decline request', '/reject', 'Request declined. The listing is open to other NGOs again.')}
          {panel === 'cancel' && reasonForm(role === 'provider' ? 'Why are you withdrawing this food?' : 'Why are you cancelling?', 'Confirm cancellation', '/cancel', 'Rescue cancelled.')}
          {panel === 'admin_cancel' && reasonForm('Reason for cancelling', 'Cancel rescue', '/admin/cancel', 'Rescue cancelled and recorded in the audit history.')}
          {panel === 'incident' && <IncidentReportForm rescueId={r.id} onCancel={() => setPanel(null)} onDone={(m) => { setNotice(m); setPanel(null); void load(); }} />}
          {panel === 'release' && reasonForm('Why can you not continue?', 'Release job', '/runner/release', 'Job released. Other runners can now take it.')}
          {panel === 'admin_reassign' && reasonForm('Why is the runner being replaced?', 'Reassign', '/admin/reassign', 'The runner was removed and the job is open to others.', 'bg-paprika-600 text-white hover:bg-paprika-700')}
          {panel === 'admin_fail' && reasonForm('Why did the delivery fail?', 'Mark as failed', '/admin/fail', 'Delivery marked as failed and recorded in the audit history.')}
          {panel === 'handover' && (
            <form onSubmit={(e) => { e.preventDefault(); void act('/delivery/handover', notes.trim() ? { note: notes.trim() } : {}, 'Handed over. The NGO now confirms the quantity received.'); }} noValidate className="mt-3 grid max-w-sm gap-3">
              <p className="text-sm">Confirm that you have given the food to {r.ngo.name}. The NGO then confirms how much arrived; you cannot mark the rescue complete yourself.</p>
              <div>
                <label htmlFor="hn" className="block text-sm font-medium">Note (optional, no personal details)</label>
                <input id="hn" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5" />
              </div>
              <div className="flex gap-3">
                <button type="submit" disabled={busy} className={`${btn} bg-paprika-600 text-white hover:bg-paprika-700`}>{busy ? 'Saving…' : 'Yes, handed over'}</button>
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
                <button type="submit" disabled={busy} className={`${btn} bg-paprika-600 text-white hover:bg-paprika-700`}>{busy ? 'Verifying…' : 'Verify pickup'}</button>
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
                <button type="submit" disabled={busy} className={`${btn} bg-paprika-600 text-white hover:bg-paprika-700`}>{busy ? 'Saving…' : 'Confirm received'}</button>
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
                <button type="submit" disabled={busy} className={`${btn} bg-paprika-600 text-white hover:bg-paprika-700`}>{busy ? 'Saving…' : 'Record resolution'}</button>
                <button type="button" onClick={() => { setPanel(null); setFields({}); }} className={`${btn} border border-stone-300`}>Back</button>
              </div>
            </form>
          )}
        </section>
      )}

      <RunnerSection r={r} role={role} />
      {role === 'runner' && r.trackingActive && <ShareLocation rescueId={r.id} onPosition={setMine} />}
      <RescueMapSection r={r} role={role} refreshKey={refreshKey} mine={mine} />

      {r.incidents.length > 0 && (
        <section aria-labelledby="inc-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
          <h2 id="inc-h" className="text-lg font-semibold">Incidents</h2>
          <IncidentList incidents={r.incidents} />
          {role === 'admin' && r.incidents.some((i) => i.status === 'OPEN') && (
            <p className="mt-3 text-sm"><Link href="/admin/incidents" className="font-medium text-paprika-700 underline">Review and resolve open incidents →</Link></p>
          )}
        </section>
      )}

      {/* Food and hand-off details */}
      <section aria-labelledby="food" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
        <h2 id="food" className="text-lg font-semibold">The food</h2>
        {r.listing.hasImage && role !== 'admin' && <img src={listingImageUrl(r.listing.id)} alt={`Photo of ${r.listing.title}`} className="mt-3 max-h-48 rounded-md border border-stone-200" />}
        <p className="mt-2 text-sm">
          {foodCategoryLabels[r.listing.foodCategory as FoodCategory] ?? r.listing.foodCategory} · <strong>{r.listing.servingsOffered} servings</strong> · {packagingLabels[r.listing.packaging as Packaging] ?? r.listing.packaging} · {r.listing.transportRequired ? 'Transport needed' : 'Collect directly'}
        </p>
        {r.listing.dietaryTags.length > 0 && <p className="mt-1 text-sm">{r.listing.dietaryTags.map((t) => dietaryTagLabels[t] ?? t).join(', ')}</p>}
        {r.listing.allergenNotes && <p className="mt-1 text-sm">Allergens: {r.listing.allergenNotes}</p>}
        <p className="mt-1 text-sm text-stone-700">Pickup window: {fmtDateTime(r.listing.pickupStart)} to {fmtDateTime(r.listing.pickupDeadline)}</p>
        <div className="mt-3 rounded-md border border-stone-200 p-3 text-sm">
          {exact ? (
            <p><strong>Pickup address:</strong> {exact.addressLine}, {exact.city}</p>
          ) : (
            <p>
              <strong>Area:</strong> {r.listing.approximateArea.city} (approximate).{' '}
              {r.status === 'RESERVED' ? 'The exact address is shared once the provider confirms the hand-off.' : 'The exact address is only shown while a hand-off is in progress.'}
            </p>
          )}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <ContactBlock title="Provider" name={r.provider.name} contact={r.provider.contact} hiddenText={r.status === 'RESERVED' ? 'Contact details are shared after the provider confirms.' : 'Contact details are only shown while a hand-off is in progress.'} />
          <ContactBlock title="NGO" name={r.ngo.name} contact={r.ngo.contact} hiddenText={r.status === 'RESERVED' ? 'Contact details are shared after you confirm the hand-off.' : 'Contact details are only shown while a hand-off is in progress.'} />
        </div>
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
  );
}
