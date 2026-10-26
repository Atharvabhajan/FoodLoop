'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { monthLabel, periodLabel, presetRange, type ImpactResponse } from '@/lib/impact';
import { useLiveRefresh } from '@/lib/rescue';
import { Loading } from './Shell';
import { CountUp, FormError } from './ui';

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

const intro: Record<Role, string> = {
  provider: 'What your surplus food has done: rescues completed from your listings, and the servings recipients confirmed they received.',
  ngo: 'What your organization has received: completed rescues and the servings you confirmed as received.',
  runner: 'Your completed runner-assisted deliveries. Direct NGO pickups are never credited to a runner.',
  admin: 'Platform-wide totals from completed rescues. These are totals only: no organization, person or rescue is identified here.',
};

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <dt className="text-sm font-medium text-stone-700">{label}</dt>
      <dd className="mt-1 text-4xl font-bold tabular-nums text-stone-900"><CountUp value={value} /></dd>
      {note && <p className="mt-1 text-xs text-stone-600">{note}</p>}
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

  return (
    <div className="mt-4 space-y-6">
      <p className="text-sm text-stone-700">{intro[role]}</p>

      <section aria-labelledby="period-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-4">
        <h2 id="period-h" className="text-sm font-semibold">Period</h2>
        <div role="group" aria-label="Choose a period" className="mt-2 flex flex-wrap gap-2">
          {presets.map((p) => (
            <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => choose(p.id)} className={`rounded-md border px-3 py-1.5 text-sm font-medium ${preset === p.id ? 'border-paprika-600 bg-paprika-600 text-white' : 'border-stone-300 hover:bg-stone-100'}`}>
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <form onSubmit={applyCustom} noValidate className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="imp-from" className="block text-sm font-medium">From</label>
              <input id="imp-from" type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-invalid={fields.from ? true : undefined} className={input('from')} />
              {fields.from && <p className="mt-1 text-sm text-red-700">{fields.from}</p>}
            </div>
            <div>
              <label htmlFor="imp-to" className="block text-sm font-medium">To (inclusive)</label>
              <input id="imp-to" type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-invalid={fields.to ? true : undefined} className={input('to')} />
              {fields.to && <p className="mt-1 text-sm text-red-700">{fields.to}</p>}
            </div>
            <button type="submit" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-paprika-600 px-4 py-2 text-sm font-semibold text-white hover:bg-paprika-700">Apply</button>
          </form>
        )}
        {data && (
          <p className="mt-3 text-sm" role="status">
            Showing: <strong>{periodLabel(data.period)}</strong> <span className="text-stone-600">(by completion date, UTC)</span>
          </p>
        )}
      </section>

      {error && (
        <div>
          <FormError message={error} />
          <button type="button" onClick={() => void load()} className="mt-2 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100">Try again</button>
        </div>
      )}
      {loading && !data && !error && <Loading label="Loading impact…" />}

      {data && m && (
        <>
          {data.scope.type === 'organization' && data.scope.organizations.length > 0 && (
            <p className="text-sm text-stone-700">Organization: {data.scope.organizations.map((o) => o.name).join(', ')}</p>
          )}

          {m.completedRescues === 0 ? (
            <p className="rounded-md border border-dashed border-stone-300 p-6 text-center text-stone-700">{emptyText[role]}</p>
          ) : null}

          <dl className="grid gap-4 sm:grid-cols-2">
            <Stat label="Completed rescues" value={m.completedRescues} />
            <Stat label="Servings delivered" value={m.servingsDelivered} note="As confirmed received, not as offered" />
          </dl>

          {m.byTransport && (
            <section aria-labelledby="mode-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
              <h2 id="mode-h" className="text-lg font-semibold">How the food travelled</h2>
              <table className="mt-3 w-full text-sm">
                <thead>
                  <tr className="text-left text-stone-600">
                    <th scope="col" className="py-1 font-medium">Transport</th>
                    <th scope="col" className="py-1 text-right font-medium">Rescues</th>
                    <th scope="col" className="py-1 text-right font-medium">Servings</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-stone-200"><th scope="row" className="py-1.5 text-left font-normal">Collected by the NGO</th><td className="py-1.5 text-right tabular-nums">{m.byTransport.directPickup.rescues}</td><td className="py-1.5 text-right tabular-nums">{m.byTransport.directPickup.servings}</td></tr>
                  <tr className="border-t border-stone-200"><th scope="row" className="py-1.5 text-left font-normal">Carried by a runner</th><td className="py-1.5 text-right tabular-nums">{m.byTransport.runnerAssisted.rescues}</td><td className="py-1.5 text-right tabular-nums">{m.byTransport.runnerAssisted.servings}</td></tr>
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

          {data.byMonth.length > 0 && (
            <section aria-labelledby="trend-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
              <h2 id="trend-h" className="text-lg font-semibold">By month</h2>
              <table className="mt-3 w-full text-sm">
                <caption className="sr-only">Completed rescues and servings delivered per month</caption>
                <thead>
                  <tr className="text-left text-stone-600">
                    <th scope="col" className="py-1 font-medium">Month</th>
                    <th scope="col" className="py-1 text-right font-medium">Rescues</th>
                    <th scope="col" className="py-1 pl-4 font-medium">Servings</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byMonth.map((x) => (
                    <tr key={x.month} className="border-t border-stone-200">
                      <th scope="row" className="py-1.5 text-left font-normal">{monthLabel(x.month)}</th>
                      <td className="py-1.5 text-right tabular-nums">{x.rescues}</td>
                      <td className="py-1.5 pl-4">
                        <div className="flex items-center gap-2">
                          <span aria-hidden className="inline-block h-3 rounded bg-paprika-600" style={{ width: `${Math.max(2, (x.servings / max) * 100)}%`, maxWidth: '70%' }} />
                          <span className="tabular-nums">{x.servings}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section aria-labelledby="def-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
            <h2 id="def-h" className="text-lg font-semibold">How these numbers are defined</h2>
            <dl className="mt-3 space-y-2 text-sm">
              {(['completedRescues', 'servingsDelivered', 'period', ...(role === 'runner' ? ['runnerCredit'] : ['directPickup', 'runnerAssisted'])] as const).map((k) => (
                <div key={k}>
                  <dt className="font-medium">{{ completedRescues: 'Completed rescues', servingsDelivered: 'Servings delivered', period: 'Period', runnerCredit: 'Runner credit', directPickup: 'Collected by the NGO', runnerAssisted: 'Carried by a runner' }[k]}</dt>
                  <dd className="text-stone-700">{data.definitions[k]}</dd>
                </div>
              ))}
              {data.unavailable.map((u) => (
                <div key={u.metric}>
                  <dt className="font-medium">Kilograms: not available</dt>
                  <dd className="text-stone-700">{u.reason}</dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}
    </div>
  );
}
