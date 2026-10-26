'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { incidentCategoryLabels, statusLabels, useLiveRefresh, type RescueStatus } from '@/lib/rescue';
import { SeverityBadge } from './RunnerParts';
import { Loading } from './Shell';
import { fmtDateTime } from './SupplyParts';
import { FormError } from './ui';

interface IncidentRow {
  id: string;
  rescueId: string;
  category: string;
  severity: string;
  blocking: boolean;
  status: 'OPEN' | 'RESOLVED';
  description: string;
  reporterRole: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionCode: string | null;
  resolutionNote: string | null;
  listingTitle?: string;
  rescueStatus?: RescueStatus;
  providerName?: string;
  ngoName?: string;
}

interface Evidence {
  id: string;
  mimeType: string;
  sizeBytes: number;
}

const resolutionLabels: Record<string, string> = {
  NO_ACTION: 'No action needed: let the rescue continue',
  REASSIGN_RUNNER: 'Replace the runner (job reopens to others)',
  CANCEL_RESCUE: 'Cancel the rescue (food is released)',
  FAIL_DELIVERY: 'Record the delivery as failed',
  COMPLETE_WITH_QUANTITY: 'Complete with a verified quantity',
};

export function IncidentQueue() {
  const [scope, setScope] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const [items, setItems] = useState<IncidentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await api<{ incidents: IncidentRow[] }>(`/incidents?status=${scope}`);
    if (res.ok) {
      setItems(res.data.incidents);
      setError(null);
    } else setError(res.error.message);
  }, [scope]);
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);
  useLiveRefresh(() => void load());

  return (
    <>
      <div role="tablist" aria-label="Incident filter" className="mt-4 inline-flex rounded-md border border-stone-300 bg-white p-0.5">
        {(['OPEN', 'RESOLVED'] as const).map((s) => (
          <button key={s} role="tab" aria-selected={scope === s} onClick={() => setScope(s)} className={`rounded px-4 py-1.5 text-sm font-medium ${scope === s ? 'bg-paprika-600 text-white' : 'hover:bg-stone-100'}`}>
            {s === 'OPEN' ? 'Open' : 'Resolved'}
          </button>
        ))}
      </div>
      <div className="mt-4"><FormError message={error} /></div>
      {!items && !error && <Loading label="Loading incidents…" />}
      {items && items.length === 0 && <p className="mt-4 rounded-md border border-dashed border-stone-300 p-6 text-center text-stone-700">{scope === 'OPEN' ? 'No open incidents. Nothing is waiting for review.' : 'No resolved incidents yet.'}</p>}
      {items && items.length > 0 && (
        <ul className="mt-4 space-y-3">
          {items.map((i) => (
            <li key={i.id}>
              <Link href={`/admin/incidents/${i.id}`} className="block rounded-2xl border border-stone-200 bg-white shadow-card p-4 hover:border-paprika-600">
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  {incidentCategoryLabels[i.category] ?? i.category}
                  <SeverityBadge severity={i.severity} />
                  {i.blocking && i.status === 'OPEN' && <span className="rounded-full border border-red-600 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-900">Rescue paused</span>}
                </p>
                <p className="mt-1 text-sm text-stone-700">{i.listingTitle} · {i.providerName} → {i.ngoName}{i.rescueStatus ? ` · ${statusLabels[i.rescueStatus].label}` : ''}</p>
                <p className="mt-1 text-sm">{i.description}</p>
                <p className="mt-1 text-xs text-stone-600">Reported by the {i.reporterRole} · {fmtDateTime(i.createdAt)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function IncidentDetail({ id }: { id: string }) {
  const [data, setData] = useState<{ incident: IncidentRow; evidence: Evidence[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');
  const [note, setNote] = useState('');
  const [servings, setServings] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ incident: IncidentRow; evidence: Evidence[] }>(`/incidents/${id}`);
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else setError(res.error.status === 404 ? 'This incident was not found.' : res.error.message);
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    const res = await api(`/incidents/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution, note: note.trim(), ...(resolution === 'COMPLETE_WITH_QUANTITY' ? { deliveredServings: Number(servings) } : {}) }),
    });
    setBusy(false);
    if (res.ok) {
      setDone('Incident resolved and recorded in the rescue history.');
      await load();
    } else {
      setFields(res.error.fields);
      setError(res.error.message);
      if (res.error.status === 409) await load();
    }
  }

  if (error && !data) return <div className="mt-4"><FormError message={error} /></div>;
  if (!data) return <Loading label="Loading incident…" />;
  const i = data.incident;
  const input = (k: string) => `mt-1 block w-full rounded-md border px-3 py-2 ${fields[k] ? 'border-red-600' : 'border-stone-300'}`;
  return (
    <div className="mt-4 space-y-6">
      {done && <p role="status" className="rounded-md border border-green-600 bg-green-50 px-4 py-3 text-sm font-medium text-green-900">✓ {done}</p>}
      <section aria-labelledby="idet" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
        <h2 id="idet" className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          {incidentCategoryLabels[i.category] ?? i.category} <SeverityBadge severity={i.severity} />
          <span className="text-sm font-normal text-stone-700">{i.status === 'OPEN' ? (i.blocking ? 'Open · rescue paused' : 'Open') : 'Resolved'}</span>
        </h2>
        <p className="mt-2 text-sm">{i.description}</p>
        <p className="mt-1 text-xs text-stone-600">Reported by the {i.reporterRole} · {fmtDateTime(i.createdAt)}. The report itself cannot be edited.</p>
        <p className="mt-3 text-sm"><Link href={`/admin/rescues/${i.rescueId}`} className="font-medium text-paprika-700 underline">Open the rescue (status, map, full history) →</Link></p>
        {data.evidence.length > 0 && (
          <div className="mt-3">
            <h3 className="text-sm font-medium">Photos</h3>
            <ul className="mt-1 flex flex-wrap gap-3">
              {data.evidence.map((ev, n) => (
                <li key={ev.id}><img src={`/api/v1/rescues/${i.rescueId}/incidents/${i.id}/evidence/${ev.id}`} alt={`Evidence photo ${n + 1}`} className="max-h-40 rounded-md border border-stone-300" /></li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {i.status === 'RESOLVED' ? (
        <section aria-labelledby="ires" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
          <h2 id="ires" className="text-lg font-semibold">Resolution</h2>
          <p className="mt-2 text-sm"><strong>{resolutionLabels[i.resolutionCode ?? ''] ?? i.resolutionCode}</strong></p>
          <p className="mt-1 text-sm">{i.resolutionNote}</p>
          {i.resolvedAt && <p className="mt-1 text-xs text-stone-600">Resolved {fmtDateTime(i.resolvedAt)}</p>}
        </section>
      ) : (
        <section aria-labelledby="ires" className="rounded-xl border-2 border-paprika-600 bg-white p-5">
          <h2 id="ires" className="text-lg font-semibold">Resolve this incident</h2>
          <p className="mt-1 text-sm text-stone-700">The resolution and your note are recorded permanently with your identity. A rescue is only ever completed by the NGO confirming receipt, or by you entering a verified quantity here.</p>
          <form onSubmit={(e) => void resolve(e)} noValidate className="mt-3 grid max-w-lg gap-3">
            <div>
              <label htmlFor="res" className="block text-sm font-medium">Resolution</label>
              <select id="res" value={resolution} onChange={(e) => setResolution(e.target.value)} aria-invalid={fields.resolution ? true : undefined} className={input('resolution')}>
                <option value="">Choose…</option>
                {Object.entries(resolutionLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              {fields.resolution && <p className="mt-1 text-sm text-red-700">{fields.resolution}</p>}
            </div>
            {resolution === 'COMPLETE_WITH_QUANTITY' && (
              <div>
                <label htmlFor="dsv" className="block text-sm font-medium">Servings verified as received</label>
                <input id="dsv" type="number" inputMode="numeric" min={0} value={servings} onChange={(e) => setServings(e.target.value)} className={input('deliveredServings')} />
                {fields.deliveredServings && <p className="mt-1 text-sm text-red-700">{fields.deliveredServings}</p>}
              </div>
            )}
            <div>
              <label htmlFor="rnote" className="block text-sm font-medium">Note (required)</label>
              <textarea id="rnote" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={fields.note ? true : undefined} className={input('note')} />
              {fields.note && <p className="mt-1 text-sm text-red-700">{fields.note}</p>}
            </div>
            <FormError message={error} />
            <button type="submit" disabled={busy} className="w-fit inline-flex min-h-11 items-center justify-center rounded-lg bg-paprika-600 px-4 py-2 text-sm font-semibold text-white hover:bg-paprika-700 disabled:opacity-60">{busy ? 'Saving…' : 'Resolve incident'}</button>
          </form>
        </section>
      )}
    </div>
  );
}
