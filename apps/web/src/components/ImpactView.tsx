'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { monthLabel, periodLabel, presetRange, type ImpactResponse } from '@/lib/impact';
import { useLiveRefresh } from '@/lib/rescue';
import { Loading } from './Shell';
import { CountUp, EmptyState, FormError } from './ui';

type Role = 'provider' | 'ngo' | 'runner' | 'admin';
type Preset = 'all' | 'month' | '30d' | '90d' | 'custom';

const presets: { id: Preset; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: 'month', label: 'This month' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'custom', label: 'Custom dates' },
];

const emptyText: Record<Role, string> = {
  provider: 'None of your rescues has been completed in this period yet. Impact appears once an NGO confirms it received your food.',
  ngo: 'No rescue has been completed for your organization in this period yet. Impact appears once you confirm the food you received.',
  runner: 'You have no completed deliveries in this period yet. A delivery counts once the NGO confirms what it received.',
  admin: 'No rescue has been completed on the platform in this period.',
};


function Stat({ label, value, note, tone = 'plain' }: { label: string; value: number; note?: string; tone?: 'plain' | 'ink' }) {
  return (
    <div className={`lift rounded-2xl border p-4 shadow-card ${tone === 'ink' ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-200 bg-white'}`}>
      <dt className={`text-sm font-semibold ${tone === 'ink' ? 'text-stone-100' : 'text-stone-700'}`}>{label}</dt>
      <dd className="mt-1 text-4xl font-bold tabular-nums" style={{ fontFamily: 'var(--font-display)' }}><CountUp value={value} /></dd>
      {note && <p className={`mt-1 text-xs ${tone === 'ink' ? 'text-stone-300' : 'text-stone-600'}`}>{note}</p>}
    </div>
  );
}

export function ImpactView({ role }: { role: Role }) {
  const [preset, setPreset] = useState<Preset>('all');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [applied, setApplied] = useState({ from: '', to: '' });
  const [data, setData] = useState<ImpactResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  // Several requests can be in flight (period changes, socket reconnects); only the newest may update the page.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (applied.from) qs.set('from', applied.from);
    if (applied.to) qs.set('to', applied.to);
    const path = `${role === 'admin' ? '/impact/platform' : '/impact/me'}${qs.size ? `?${qs}` : ''}`;
    const mine = ++latest.current;
    const res = await api<ImpactResponse>(path);
    if (mine !== latest.current) return;
    setLoading(false);
    if (res.ok) {
      setData(res.data);
      setError(null);
      setFields({});
    } else {
      setFields(res.error.fields);
      setError(res.error.message);
    }
  }, [role, applied]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);
  // A completed rescue changes the numbers; the same nudge that refreshes rescue pages refreshes this one.
  useLiveRefresh(() => void load(), 60_000);

  function choose(p: Preset) {
    setPreset(p);
    if (p !== 'custom') setApplied(presetRange(p));
  }
  function applyCustom(e: FormEvent) {
    e.preventDefault();
    setApplied({ from: custom.from, to: custom.to });
  }

  const m = data?.metrics;
  const max = Math.max(1, ...(data?.byMonth.map((x) => x.servings) ?? [1]));
  const input = (k: string) => `mt-1 block rounded-md border px-3 py-2 ${fields[k] ? 'border-red-600' : 'border-stone-300'}`;

  const split = m?.byTransport;
  const splitTotal = split ? split.directPickup.servings + split.runnerAssisted.servings : 0;

  return (
    <div className="space-y-5">
      <section aria-labelledby="period-h" className="flex flex-wrap items-center gap-3">
        <h2 id="period-h" className="sr-only">Period</h2>
        <div role="group" aria-label="Choose a period" className="inline-flex flex-wrap rounded-xl border border-stone-300 bg-white p-0.5">
          {presets.map((p) => (
            <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => choose(p.id)} className={`min-h-10 rounded-lg px-3.5 py-1.5 text-sm font-semibold ${preset === p.id ? 'bg-brand-600 text-white' : 'hover:bg-stone-100'}`}>
              {p.label}
            </button>
          ))}
        </div>
        {data && (
          <p className="text-sm" role="status">
            Showing <strong>{periodLabel(data.period)}</strong> <span className="text-stone-600">(by completion date, UTC)</span>
          </p>
        )}
        {preset === 'custom' && (
          <form onSubmit={applyCustom} noValidate className="flex w-full flex-wrap items-end gap-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-card">
            <div>
              <label htmlFor="imp-from" className="block text-sm font-semibold">From</label>
              <input id="imp-from" type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-invalid={fields.from ? true : undefined} className={input('from')} />
              {fields.from && <p className="mt-1 text-sm text-red-700">{fields.from}</p>}
            </div>
            <div>
              <label htmlFor="imp-to" className="block text-sm font-semibold">To (inclusive)</label>
              <input id="imp-to" type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-invalid={fields.to ? true : undefined} className={input('to')} />
              {fields.to && <p className="mt-1 text-sm text-red-700">{fields.to}</p>}
            </div>
            <button type="submit" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Apply</button>
          </form>
        )}
      </section>

      {error && (
        <div>
          <FormError message={error} />
          <button type="button" onClick={() => void load()} className="mt-2 rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-semibold hover:bg-stone-100">Try again</button>
        </div>
      )}
      {loading && !data && !error && <Loading label="Loading impact…" />}

      {data && m && (
        <>
          {data.scope.type === 'organization' && data.scope.organizations.length > 0 && (
            <p className="text-sm text-stone-700">Organization: <strong>{data.scope.organizations.map((o) => o.name).join(', ')}</strong></p>
          )}

          <dl className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Completed rescues" value={m.completedRescues} tone="ink" />
            <Stat label="Servings delivered" value={m.servingsDelivered} note="As confirmed received, not as offered" />
            {split && <Stat label="Collected by the NGO" value={split.directPickup.servings} note={`servings in ${split.directPickup.rescues} rescue${split.directPickup.rescues === 1 ? '' : 's'}`} />}
            {split && <Stat label="Carried by a runner" value={split.runnerAssisted.servings} note={`servings in ${split.runnerAssisted.rescues} rescue${split.runnerAssisted.rescues === 1 ? '' : 's'}`} />}
          </dl>

          {m.completedRescues === 0 && (
            <EmptyState title="Nothing completed in this period" photo="volunteers-serving">{emptyText[role]}</EmptyState>
          )}

          {m.completedRescues > 0 && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
              {data.byMonth.length > 0 && (
                <section aria-labelledby="trend-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
                  <h2 id="trend-h" className="text-lg font-bold">Servings delivered by month</h2>
                  <table className="mt-4 w-full text-sm">
                    <caption className="sr-only">Completed rescues and servings delivered per month</caption>
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-stone-600">
                        <th scope="col" className="py-1 font-semibold">Month</th>
                        <th scope="col" className="py-1 pl-4 font-semibold">Servings</th>
                        <th scope="col" className="py-1 text-right font-semibold">Rescues</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byMonth.map((x) => (
                        <tr key={x.month} className="row-hover border-t border-stone-200">
                          <th scope="row" className="py-2.5 pr-2 text-left font-semibold">{monthLabel(x.month)}</th>
                          <td className="w-full py-2.5 pl-4">
                            <div className="flex items-center gap-2">
                              <span aria-hidden className="inline-block h-4 rounded-r bg-brand-500" style={{ width: `${Math.max(2, (x.servings / max) * 100)}%`, maxWidth: '85%' }} />
                              <span className="font-bold tabular-nums">{x.servings}</span>
                            </div>
                          </td>
                          <td className="py-2.5 text-right tabular-nums">{x.rescues}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              {split && (
                <section aria-labelledby="mode-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
                  <h2 id="mode-h" className="text-lg font-bold">How the food travelled</h2>
                  {splitTotal > 0 && (
                    <div className="mt-4 flex h-4 overflow-hidden rounded-full bg-stone-200" aria-hidden>
                      <span className="bg-stone-900" style={{ width: `${(split.directPickup.servings / splitTotal) * 100}%` }} />
                      <span className="bg-zest-400" style={{ width: `${(split.runnerAssisted.servings / splitTotal) * 100}%` }} />
                    </div>
                  )}
                  <table className="mt-3 w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-stone-600">
                        <th scope="col" className="py-1 font-semibold">Transport</th>
                        <th scope="col" className="py-1 text-right font-semibold">Rescues</th>
                        <th scope="col" className="py-1 text-right font-semibold">Servings</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-stone-200"><th scope="row" className="py-2 text-left font-normal"><span aria-hidden className="mr-2 inline-block h-3 w-3 rounded-full bg-stone-900 align-middle" />Collected by the NGO</th><td className="py-2 text-right tabular-nums">{split.directPickup.rescues}</td><td className="py-2 text-right tabular-nums">{split.directPickup.servings}</td></tr>
                      <tr className="border-t border-stone-200"><th scope="row" className="py-2 text-left font-normal"><span aria-hidden className="mr-2 inline-block h-3 w-3 rounded-full bg-zest-400 align-middle" />Carried by a runner</th><td className="py-2 text-right tabular-nums">{split.runnerAssisted.rescues}</td><td className="py-2 text-right tabular-nums">{split.runnerAssisted.servings}</td></tr>
                    </tbody>
                  </table>
                  <p className="mt-3 text-sm text-stone-700">
                    {m.recipientOrganizations !== undefined && `Recipient organizations: ${m.recipientOrganizations}. `}
                    {m.providerOrganizations !== undefined && role !== 'provider' && `Provider organizations: ${m.providerOrganizations}. `}
                    {m.ngoOrganizations !== undefined && `NGOs: ${m.ngoOrganizations}. `}
                    {m.runners !== undefined && `Runners credited: ${m.runners}.`}
                  </p>
                </section>
              )}
            </div>
          )}

          <details className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
            <summary className="cursor-pointer text-lg font-bold">How these numbers are defined</summary>
            <dl className="mt-3 space-y-2 text-sm">
              {(['completedRescues', 'servingsDelivered', 'period', ...(role === 'runner' ? ['runnerCredit'] : ['directPickup', 'runnerAssisted'])] as const).map((k) => (
                <div key={k}>
                  <dt className="font-semibold">{{ completedRescues: 'Completed rescues', servingsDelivered: 'Servings delivered', period: 'Period', runnerCredit: 'Runner credit', directPickup: 'Collected by the NGO', runnerAssisted: 'Carried by a runner' }[k]}</dt>
                  <dd className="text-stone-700">{data.definitions[k]}</dd>
                </div>
              ))}
              {data.unavailable.map((u) => (
                <div key={u.metric}>
                  <dt className="font-semibold">Kilograms: not available</dt>
                  <dd className="text-stone-700">{u.reason}</dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </div>
  );
}
