'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import {
  DIETARY_TAGS,
  FOOD_CATEGORIES,
  PACKAGING_TYPES,
  dietaryTagLabels,
  foodCategoryLabels,
  fromLocalInput,
  packagingLabels,
  toLocalInput,
  type FoodCategory,
  type Listing,
  type Packaging,
} from '@/lib/supply';
import { Field, FormError, SubmitButton } from './ui';
import { LocationPicker } from './LocationPicker';

interface Form {
  title: string; description: string; foodCategory: FoodCategory | ''; servings: string; estimatedKg: string;
  preparedAt: string; pickupStart: string; pickupDeadline: string; addressLine: string; city: string;
  latitude: string; longitude: string; packaging: Packaging | ''; dietaryTags: string[]; allergenNotes: string;
  transportRequired: 'yes' | 'no' | '';
}

const toForm = (l?: Listing): Form => ({
  title: l?.title ?? '', description: l?.description ?? '', foodCategory: l?.foodCategory ?? '',
  servings: l ? String(l.servings) : '', estimatedKg: l?.estimatedKg != null ? String(l.estimatedKg) : '',
  preparedAt: toLocalInput(l?.preparedAt), pickupStart: toLocalInput(l?.pickupStart), pickupDeadline: toLocalInput(l?.pickupDeadline),
  addressLine: l?.addressLine ?? '', city: l?.city ?? '', latitude: l?.latitude != null ? String(l.latitude) : '',
  longitude: l?.longitude != null ? String(l.longitude) : '', packaging: l?.packaging ?? '', dietaryTags: l?.dietaryTags ?? [],
  allergenNotes: l?.allergenNotes ?? '', transportRequired: l ? (l.transportRequired ? 'yes' : 'no') : '',
});

const num = (v: string) => (v.trim() === '' ? null : Number(v));
const text = (v: string) => (v.trim() === '' ? null : v.trim());

/** Values that cannot be sent as valid types are left as-is so the server reports a clear field error. */
function toPayload(f: Form) {
  return {
    title: f.title.trim(),
    description: text(f.description),
    foodCategory: f.foodCategory || undefined,
    servings: f.servings.trim() === '' ? undefined : Number(f.servings),
    estimatedKg: num(f.estimatedKg),
    preparedAt: fromLocalInput(f.preparedAt) ?? undefined,
    pickupStart: fromLocalInput(f.pickupStart) ?? undefined,
    pickupDeadline: fromLocalInput(f.pickupDeadline) ?? undefined,
    addressLine: f.addressLine.trim(),
    city: f.city.trim(),
    latitude: num(f.latitude),
    longitude: num(f.longitude),
    packaging: f.packaging || undefined,
    dietaryTags: f.dietaryTags,
    allergenNotes: text(f.allergenNotes),
    transportRequired: f.transportRequired === '' ? undefined : f.transportRequired === 'yes',
  };
}

const selectCls = (err?: string) => `mt-1 block w-full rounded-md border bg-white px-3 py-2 ${err ? 'border-red-600' : 'border-stone-300'}`;

export function ListingForm({ listing, onSaved, submitLabel }: { listing?: Listing; onSaved: (l: Listing) => void; submitLabel: string }) {
  const [f, setF] = useState<Form>(toForm(listing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const disabled = listing ? !listing.editable : false;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setSaved(false);
    setF((p) => ({ ...p, [k]: v }));
  };
  const input = (k: keyof Form, label: string, extra: object = {}) => (
    <Field id={`l-${k}`} label={label} value={f[k] as string} onChange={(e) => set(k, e.target.value as never)} error={fields[k]} disabled={disabled} {...extra} />
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    setSaved(false);
    const res = listing
      ? await api<{ listing: Listing }>(`/listings/${listing.id}`, { method: 'PATCH', body: JSON.stringify(toPayload(f)) })
      : await api<{ listing: Listing }>('/listings', { method: 'POST', body: JSON.stringify(toPayload(f)) });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      onSaved(res.data.listing);
    } else {
      setFields(res.error.fields);
      setError(res.error.code === 'VALIDATION_ERROR' ? 'Please fix the highlighted fields.' : res.error.message);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Listing details" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">{input('title', 'Title')}</div>
        <div className="sm:col-span-2">
          <label htmlFor="l-description" className="block text-sm font-medium">Description (optional)</label>
          <textarea id="l-description" rows={3} maxLength={1000} value={f.description} disabled={disabled} onChange={(e) => set('description', e.target.value)} className={selectCls(fields.description)} />
          <p className="mt-1 text-xs text-stone-600">Do not put your street address here. NGOs only see the area until a later pickup step.</p>
        </div>
        <div>
          <label htmlFor="l-foodCategory" className="block text-sm font-medium">Food category</label>
          <select id="l-foodCategory" value={f.foodCategory} disabled={disabled} onChange={(e) => set('foodCategory', e.target.value as FoodCategory)} className={selectCls(fields.foodCategory)} aria-invalid={fields.foodCategory ? true : undefined}>
            <option value="">Choose…</option>
            {FOOD_CATEGORIES.map((c) => <option key={c} value={c}>{foodCategoryLabels[c]}</option>)}
          </select>
          {fields.foodCategory && <p className="mt-1 text-sm text-red-700">{fields.foodCategory}</p>}
        </div>
        <div>
          <label htmlFor="l-packaging" className="block text-sm font-medium">Packaging</label>
          <select id="l-packaging" value={f.packaging} disabled={disabled} onChange={(e) => set('packaging', e.target.value as Packaging)} className={selectCls(fields.packaging)} aria-invalid={fields.packaging ? true : undefined}>
            <option value="">Choose…</option>
            {PACKAGING_TYPES.map((p) => <option key={p} value={p}>{packagingLabels[p]}</option>)}
          </select>
          {fields.packaging && <p className="mt-1 text-sm text-red-700">{fields.packaging}</p>}
        </div>
        {input('servings', 'Servings', { type: 'number', inputMode: 'numeric', min: 1, step: 1 })}
        {input('estimatedKg', 'Estimated weight in kg (optional)', { type: 'number', inputMode: 'decimal', min: 0, step: 'any' })}
        {input('preparedAt', 'Prepared at', { type: 'datetime-local' })}
        {input('pickupStart', 'Pickup window opens', { type: 'datetime-local' })}
        <div className="sm:col-span-2">{input('pickupDeadline', 'Pickup deadline', { type: 'datetime-local', hint: 'Listings expire automatically at this time.' })}</div>
        <div className="sm:col-span-2">{input('addressLine', 'Pickup address (private)', { hint: 'Shown only to your organization and admins for now.' })}</div>
        {input('city', 'City / area (shown to NGOs)')}
        <LocationPicker
          idPrefix="l"
          latitude={f.latitude}
          longitude={f.longitude}
          disabled={disabled}
          errors={{ latitude: fields.latitude, longitude: fields.longitude }}
          onChange={(la, lo) => { set('latitude', la); set('longitude', lo); }}
          note="Click the map or drag the pin to the pickup point, or type the coordinates. NGOs only ever see the area (rounded to about 1 km) until the rescue is confirmed; your exact address and pin stay private."
        />
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium">Dietary tags</legend>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {DIETARY_TAGS.map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={disabled} checked={f.dietaryTags.includes(t)} onChange={(e) => set('dietaryTags', e.target.checked ? [...f.dietaryTags, t] : f.dietaryTags.filter((x) => x !== t))} />
                {dietaryTagLabels[t]}
              </label>
            ))}
          </div>
          {fields.dietaryTags && <p className="mt-1 text-sm text-red-700">{fields.dietaryTags}</p>}
        </fieldset>
        <div className="sm:col-span-2">{input('allergenNotes', 'Allergen notes (optional)')}</div>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium">Is transport required?</legend>
          <div className="mt-2 flex gap-6">
            {(['yes', 'no'] as const).map((v) => (
              <label key={v} className="flex items-center gap-2 text-sm">
                <input type="radio" name="transport" disabled={disabled} checked={f.transportRequired === v} onChange={() => set('transportRequired', v)} />
                {v === 'yes' ? 'Yes, someone must collect it for the NGO' : 'No, the NGO can collect it'}
              </label>
            ))}
          </div>
          {fields.transportRequired && <p className="mt-1 text-sm text-red-700">{fields.transportRequired}</p>}
        </fieldset>
      </div>
      {!disabled && (
        <div className="mt-5 max-w-xs space-y-3">
          <FormError message={error} />
          {saved && <p role="status" className="text-sm font-medium text-green-800">✓ Saved.</p>}
          <SubmitButton busy={busy}>{submitLabel}</SubmitButton>
        </div>
      )}
      {disabled && <p className="mt-4 text-sm text-stone-600">This listing is {listing?.status.toLowerCase()} and can no longer be edited.</p>}
    </form>
  );
}
