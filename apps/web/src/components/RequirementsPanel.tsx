'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Loading, StatusBadge } from '@/components/Shell';
import { MapView } from '@/components/MapView';
import { fmtDateTime } from '@/components/SupplyParts';
import { Field, FormError, SubmitButton } from '@/components/ui';
import { api, type VerificationStatus } from '@/lib/api';
import { DIETARY_TAGS, FOOD_CATEGORIES, dietaryTagLabels, foodCategoryLabels, fromLocalInput, toLocalInput, type FoodCategory, type Requirement } from '@/lib/supply';

interface Current {
  organization: { id: string; name: string; verificationStatus: VerificationStatus };
  requirement: Requirement | null;
}

interface Form {
  foodCategories: FoodCategory[]; neededServings: string; capacityServings: string;
  serviceRadiusKm: string; availableFrom: string; availableTo: string;
  dietaryMustHave: string[]; dietaryMustAvoid: string[];
}

const defaultWindow = () => ({
  availableFrom: toLocalInput(new Date().toISOString()),
  availableTo: toLocalInput(new Date(Date.now() + 7 * 86_400_000).toISOString()),
});

const toForm = (r: Requirement | null): Form =>
  r
    ? { foodCategories: r.foodCategories, neededServings: String(r.neededServings), capacityServings: String(r.capacityServings), serviceRadiusKm: String(r.serviceRadiusKm), availableFrom: toLocalInput(r.availableFrom), availableTo: toLocalInput(r.availableTo), dietaryMustHave: r.dietaryMustHave, dietaryMustAvoid: r.dietaryMustAvoid }
    : { foodCategories: [], neededServings: '', capacityServings: '', serviceRadiusKm: '5', dietaryMustHave: [], dietaryMustAvoid: [], ...defaultWindow() };

const toPayload = (f: Form) => ({
  foodCategories: f.foodCategories,
  neededServings: f.neededServings.trim() === '' ? undefined : Number(f.neededServings),
  capacityServings: f.capacityServings.trim() === '' ? undefined : Number(f.capacityServings),
  serviceRadiusKm: f.serviceRadiusKm.trim() === '' ? undefined : Number(f.serviceRadiusKm),
  availableFrom: fromLocalInput(f.availableFrom) ?? undefined,
  availableTo: fromLocalInput(f.availableTo) ?? undefined,
  dietaryMustHave: f.dietaryMustHave,
  dietaryMustAvoid: f.dietaryMustAvoid,
});

/** Your organization's pin and the service radius you are typing, so the effect of the number is visible. */
function RadiusPreview({ radiusKm }: { radiusKm: number }) {
  const [org, setOrg] = useState<{ latitude: number | null; longitude: number | null } | null | undefined>(undefined);
  useEffect(() => {
    void api<{ organizations: { type: string; latitude: number | null; longitude: number | null; verificationStatus: string }[] }>('/organizations').then((r) => {
      const o = r.ok ? r.data.organizations.find((x) => x.type === 'NGO' && x.verificationStatus !== 'REJECTED') : undefined;
      setOrg(o ?? null);
    });
  }, []);
  if (org === undefined) return null;
  if (!org || org.latitude === null || org.longitude === null) {
    return (
      <p className="mt-4 rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-950">
        Your organization has no map location yet, so the service radius cannot be drawn or used for matching. <Link href="/profile#organization" className="font-semibold underline">Set it on the organization page</Link>.
      </p>
    );
  }
  const ok = Number.isFinite(radiusKm) && radiusKm > 0 && radiusKm <= 100;
  return (
    <div className="mt-4">
      <p className="text-sm font-semibold">Where your radius reaches</p>
      <MapView
        title="Service radius map"
        height={260}
        markers={[{ id: 'me', kind: 'org', latitude: org.latitude, longitude: org.longitude, label: 'Your organization', popup: { title: 'Your organization', lines: ['Other users see only an approximate area.'], href: '/profile#organization', hrefLabel: 'Change location' } }]}
        circles={ok ? [{ latitude: org.latitude, longitude: org.longitude, radiusKm, label: `Service radius ${radiusKm} km (straight line)` }] : []}
      />
      {!ok && <p className="mt-1 text-sm text-red-700">Enter a radius between 0 and 100 km to see it on the map.</p>}
    </div>
  );
}

export function RequirementsPanel() {
  const [current, setCurrent] = useState<Current | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<Current>('/ngo-requirements/current');
    if (res.ok) setCurrent(res.data);
    else setError(res.error.code === 'ORGANIZATION_REQUIRED' ? 'Create your organization profile first.' : res.error.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const verified = current?.organization.verificationStatus === 'VERIFIED';

  return (
    <div>
      <div className="mt-4"><FormError message={error} /></div>
      {!current && !error && <Loading label="Loading your requirements…" />}
      {current && !verified && (
        <div role="status" className="mt-4 rounded-md border border-amber-500 bg-amber-50 p-4 text-sm text-amber-950">
          <p className="flex flex-wrap items-center gap-2 font-semibold">Your organization is not verified yet: <StatusBadge status={current.organization.verificationStatus} /></p>
          <p className="mt-1">Only verified NGOs can set food needs or see live listings. Finish verification under Organization.</p>
        </div>
      )}
      {current && verified && <RequirementEditor requirement={current.requirement} onChanged={load} />}
    </div>
  );
}

function RequirementEditor({ requirement, onChanged }: { requirement: Requirement | null; onChanged: () => Promise<void> }) {
  const [f, setF] = useState<Form>(toForm(requirement));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setNotice(null);
    setF((p) => ({ ...p, [k]: v }));
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    setNotice(null);
    const res = requirement
      ? await api('/ngo-requirements/current', { method: 'PATCH', body: JSON.stringify(toPayload(f)) })
      : await api('/ngo-requirements', { method: 'POST', body: JSON.stringify(toPayload(f)) });
    setBusy(false);
    if (res.ok) {
      setNotice(requirement ? 'Requirements updated.' : 'Requirements saved. Your NGO is now receiving.');
      await onChanged();
    } else {
      const catErr = Object.entries(res.error.fields).find(([k]) => k.startsWith('foodCategories'))?.[1];
      setFields({ ...res.error.fields, ...(catErr ? { foodCategories: catErr } : {}) });
      setError(res.error.code === 'VALIDATION_ERROR' ? 'Please fix the highlighted fields.' : res.error.message);
    }
  }

  async function toggle(enable: boolean) {
    setBusy(true);
    setError(null);
    const res = await api(`/ngo-requirements/current/${enable ? 'resume' : 'pause'}`, { method: 'POST' });
    setBusy(false);
    if (res.ok) {
      setNotice(enable ? 'Intake resumed.' : 'Intake paused. Your profile is kept.');
      await onChanged();
    } else setError(res.error.message);
  }

  return (
    <div className="mt-4 space-y-6">
      {notice && <p role="status" className="rounded-md border border-green-600 bg-green-50 px-4 py-3 text-sm font-medium text-green-900">✓ {notice}</p>}

      {requirement && (
        <section aria-labelledby="state-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
          <h2 id="state-h" className="text-lg font-semibold">Intake status</h2>
          <p className="mt-2 text-sm">
            {!requirement.intakeEnabled && <strong>Paused</strong>}
            {requirement.intakeEnabled && requirement.active && requirement.acceptingNow && <strong>● Receiving now</strong>}
            {requirement.intakeEnabled && requirement.active && !requirement.acceptingNow && <strong>◔ Scheduled (window starts {fmtDateTime(requirement.availableFrom)})</strong>}
            {requirement.intakeEnabled && !requirement.active && <strong>Window ended. Extend the availability window below to receive again.</strong>}
          </p>
          <p className="mt-1 text-xs text-stone-600">Last updated {fmtDateTime(requirement.updatedAt)}. These settings drive your recommendations on the Live food page.</p>
          <div className="mt-3">
            {requirement.intakeEnabled ? (
              <button onClick={() => void toggle(false)} disabled={busy} className="rounded-md border border-stone-400 px-4 py-2 text-sm font-semibold hover:bg-stone-100 disabled:opacity-60">Pause intake</button>
            ) : (
              <button onClick={() => void toggle(true)} disabled={busy} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">Resume intake</button>
            )}
          </div>
        </section>
      )}

      <form onSubmit={save} noValidate aria-label="Food requirements" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
        <h2 className="text-lg font-semibold">{requirement ? 'Update requirements' : 'Set up your requirements'}</h2>
        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Accepted food categories</legend>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {FOOD_CATEGORIES.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.foodCategories.includes(c)} onChange={(e) => set('foodCategories', e.target.checked ? [...f.foodCategories, c] : f.foodCategories.filter((x) => x !== c))} />
                {foodCategoryLabels[c]}
              </label>
            ))}
          </div>
          {fields.foodCategories && <p className="mt-1 text-sm text-red-700">{fields.foodCategories}</p>}
        </fieldset>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {(['dietaryMustHave', 'dietaryMustAvoid'] as const).map((key) => (
            <fieldset key={key}>
              <legend className="text-sm font-medium">{key === 'dietaryMustHave' ? 'Listing must be tagged (optional)' : 'Listing must NOT be tagged (optional)'}</legend>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                {DIETARY_TAGS.map((t) => (
                  <label key={t} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={f[key].includes(t)} onChange={(e) => set(key, e.target.checked ? [...f[key], t] : f[key].filter((x) => x !== t))} />
                    {dietaryTagLabels[t]}
                  </label>
                ))}
              </div>
              {fields[key] && <p className="mt-1 text-sm text-red-700">{fields[key]}</p>}
            </fieldset>
          ))}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field id="r-needed" label="Servings needed" type="number" inputMode="numeric" min={1} step={1} value={f.neededServings} onChange={(e) => set('neededServings', e.target.value)} error={fields.neededServings} />
          <Field id="r-capacity" label="Receiving capacity (servings)" type="number" inputMode="numeric" min={1} step={1} value={f.capacityServings} onChange={(e) => set('capacityServings', e.target.value)} error={fields.capacityServings} />
          <Field id="r-radius" label="Service radius (km)" type="number" inputMode="decimal" min={0} step="any" value={f.serviceRadiusKm} onChange={(e) => set('serviceRadiusKm', e.target.value)} error={fields.serviceRadiusKm} hint="Listings farther than this are not recommended to you." />
          <Field id="r-from" label="Available from" type="datetime-local" value={f.availableFrom} onChange={(e) => set('availableFrom', e.target.value)} error={fields.availableFrom} />
          <Field id="r-to" label="Available until" type="datetime-local" value={f.availableTo} onChange={(e) => set('availableTo', e.target.value)} error={fields.availableTo} />
        </div>
        <RadiusPreview radiusKm={Number(f.serviceRadiusKm)} />
        <div className="mt-5 max-w-xs space-y-3">
          <FormError message={error} />
          <SubmitButton busy={busy}>{requirement ? 'Save changes' : 'Save requirements'}</SubmitButton>
        </div>
      </form>
    </div>
  );
}
