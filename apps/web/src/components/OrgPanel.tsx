'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DocumentList, HistoryList, formatDate } from '@/components/OrgParts';
import { LocationPicker } from '@/components/LocationPicker';
import { parseCoords } from '@/lib/geo';
import { Loading, StatusBadge } from '@/components/Shell';
import { Field, FormError, SubmitButton } from '@/components/ui';
import {
  MAX_UPLOAD_MB,
  api,
  documentTypeLabels,
  type DocumentType,
  type HistoryItem,
  type OrgDocument,
  type Organization,
  type VerificationStatus,
} from '@/lib/api';

const statusHelp: Record<VerificationStatus, string> = {
  UNSUBMITTED: 'Complete your profile, upload your registration certificate, then submit for review.',
  UNDER_REVIEW: 'An admin is reviewing your application. You cannot edit it until they respond.',
  VERIFIED: 'Your organization is verified: it can publish or accept food and take part in rescues.',
  REJECTED: 'This application was rejected and is closed. You can start a new application.',
  RESUBMISSION_REQUESTED: 'The admin needs changes. Update your details or documents, then submit again.',
};

const missingLabels: Record<string, string> = {
  name: 'Organization name',
  contactName: 'Contact name',
  contactEmail: 'Contact email',
  contactPhone: 'Contact phone',
  addressLine: 'Address',
  city: 'City',
  'document:REGISTRATION_CERTIFICATE': 'Registration certificate document',
};

type Profile = {
  name: string; contactName: string; contactEmail: string; contactPhone: string;
  addressLine: string; city: string; latitude: string; longitude: string;
};

const toProfile = (o?: Organization): Profile => ({
  name: o?.name ?? '', contactName: o?.contactName ?? '', contactEmail: o?.contactEmail ?? '', contactPhone: o?.contactPhone ?? '',
  addressLine: o?.addressLine ?? '', city: o?.city ?? '', latitude: o?.latitude?.toString() ?? '', longitude: o?.longitude?.toString() ?? '',
});

/** Empty optional strings are omitted; coordinates become numbers or null. */
function toPayload(p: Profile, only?: (keyof Profile)[]) {
  const out: Record<string, unknown> = {};
  const keys = only ?? (Object.keys(p) as (keyof Profile)[]);
  for (const k of keys) {
    const v = p[k].trim();
    if (k === 'latitude' || k === 'longitude') out[k] = v === '' ? null : Number(v);
    else if (v !== '') out[k] = v;
  }
  return out;
}

/** The whole organization area (status, details, map location, documents, submit). Rendered inside /profile and /organization. */
export function OrganizationPanel({ role }: { role: 'provider' | 'ngo' }) {
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ organizations: Organization[] }>('/organizations');
    if (res.ok) setOrgs(res.data.organizations);
    else setLoadError(res.error.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const current = orgs?.find((o) => o.verificationStatus !== 'REJECTED') ?? null;
  const rejected = orgs?.filter((o) => o.verificationStatus === 'REJECTED') ?? [];

  return (
    <div data-role={role}>
      {loadError && <FormError message={loadError} />}
      {!orgs && !loadError && <Loading label="Loading your organization…" />}
      {orgs && !current && (
        <>
          {rejected.length > 0 && <RejectedNotice org={rejected[0]!} />}
          <CreateForm onCreated={load} />
        </>
      )}
      {current && <OrganizationView key={current.id} org={current} onChanged={load} />}
    </div>
  );
}

function RejectedNotice({ org }: { org: Organization }) {
  return (
    <div role="status" className="fl-appear mt-4 rounded-xl border-2 border-red-700 bg-red-50 p-4 text-sm text-red-900">
      <p className="font-semibold"><span aria-hidden>✕</span> Your application for &ldquo;{org.name}&rdquo; was rejected.</p>
      {org.statusReason && <p className="mt-1">Reason: {org.statusReason}</p>}
      <p className="mt-1">You can start a new application below.</p>
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    const res = await api('/organizations', { method: 'POST', body: JSON.stringify({ name }) });
    if (res.ok) await onCreated();
    else {
      setFields(res.error.fields);
      setError(res.error.message);
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} noValidate className="mt-6 max-w-md space-y-4 rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <h2 className="text-lg font-semibold">Create your organization profile</h2>
      <p className="text-sm text-stone-700">Start with the name. You will add contact details and documents next.</p>
      <Field id="org-name" label="Organization name" required value={name} onChange={(e) => setName(e.target.value)} error={fields.name} />
      <FormError message={error} />
      <SubmitButton busy={busy}>Create profile</SubmitButton>
    </form>
  );
}

// Each verification state gets its own frame (border weight/style and colour) plus a headline, so no state relies on colour alone.
const stateFrame: Record<VerificationStatus, string> = {
  UNSUBMITTED: 'border-stone-300 border-l-stone-400 border-dashed',
  UNDER_REVIEW: 'border-zest-200 border-l-zest-400',
  VERIFIED: 'border-stone-300 border-l-stone-900',
  REJECTED: 'border-red-300 border-l-red-700',
  RESUBMISSION_REQUESTED: 'border-brand-200 border-l-brand-600',
};
const stateHeadline: Record<VerificationStatus, string> = {
  UNSUBMITTED: 'Step 1 of 3: finish your profile',
  UNDER_REVIEW: 'Step 2 of 3: an admin is reviewing',
  VERIFIED: 'Step 3 of 3: verified and active',
  REJECTED: 'Application closed',
  RESUBMISSION_REQUESTED: 'Action needed: update and resubmit',
};

function OrganizationView({ org, onChanged }: { org: Organization; onChanged: () => Promise<void> }) {
  const [docs, setDocs] = useState<OrgDocument[] | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const loadDetails = useCallback(async () => {
    const [d, h] = await Promise.all([
      api<{ documents: OrgDocument[] }>(`/organizations/${org.id}/documents`),
      api<{ history: HistoryItem[] }>(`/organizations/${org.id}/verification-history`),
    ]);
    if (d.ok) setDocs(d.data.documents);
    if (h.ok) setHistory(h.data.history);
  }, [org.id]);
  useEffect(() => {
    void loadDetails();
  }, [loadDetails, org.updatedAt]);

  const refresh = async () => {
    await Promise.all([onChanged(), loadDetails()]);
  };
  const canManage = org.myRole === 'owner' || org.myRole === 'manager';
  const [radiusKm, setRadiusKm] = useState<number | null>(null);
  useEffect(() => {
    if (org.type !== 'NGO') return;
    void api<{ requirement: { serviceRadiusKm: number } | null }>('/ngo-requirements/current').then((r) => setRadiusKm(r.ok ? (r.data.requirement?.serviceRadiusKm ?? null) : null));
  }, [org.type, org.updatedAt]);

  return (
    <div className="mt-4 space-y-6">
      <section aria-labelledby="status-h" className={`fl-appear rounded-2xl border-y border-r border-l-8 bg-white p-5 shadow-card ${stateFrame[org.verificationStatus]}`}>
        <p className="text-xs font-bold uppercase tracking-wider text-stone-600">{stateHeadline[org.verificationStatus]}</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <h2 id="status-h" className="text-lg font-semibold">{org.name}</h2>
          <StatusBadge status={org.verificationStatus} />
        </div>
        <p className="mt-2 text-sm text-stone-700">{statusHelp[org.verificationStatus]}</p>
        {org.myRole && <p className="mt-1 text-sm text-stone-600">Your role here: <strong>{org.myRole}</strong>{org.myRole === 'operator' ? ' (read-only: only an owner or manager can change details, location and documents).' : ' (can change details, location and documents).'}</p>}
        {org.statusReason && (org.verificationStatus === 'RESUBMISSION_REQUESTED' || org.verificationStatus === 'REJECTED') && (
          <p role="note" className="mt-3 rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-950">
            <strong>Admin feedback:</strong> {org.statusReason}
          </p>
        )}
        {org.submittedAt && <p className="mt-2 text-xs text-stone-600">Last submitted {formatDate(org.submittedAt)} (submission {org.submissionNumber})</p>}
        <h3 className="mt-4 text-sm font-semibold">Review history</h3>
        <HistoryList history={history} />
      </section>

      <ProfileForm org={org} canManage={canManage} onSaved={refresh} radiusKm={radiusKm} />

      <DocumentsSection org={org} docs={docs} canManage={canManage} onChanged={refresh} />

      {org.editable && canManage && <SubmitSection org={org} docs={docs} onSubmitted={refresh} />}
      {!canManage && <p className="text-sm text-stone-600">Your membership role is read-only. Ask an owner or manager to make changes.</p>}
    </div>
  );
}

function ProfileForm({ org, canManage, onSaved, radiusKm }: { org: Organization; canManage: boolean; onSaved: () => Promise<void>; radiusKm: number | null }) {
  const [form, setForm] = useState<Profile>(toProfile(org));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});

  // After verification only contact details may change; identity fields are locked server-side too.
  const verified = org.verificationStatus === 'VERIFIED';
  const editable = canManage && (org.editable || verified);
  const locked = (k: keyof Profile) => !editable || (verified && !['contactName', 'contactEmail', 'contactPhone', 'latitude', 'longitude'].includes(k));
  const here = parseCoords(form.latitude, form.longitude);
  const radiusCircle = here.ok && radiusKm ? [{ latitude: here.latitude, longitude: here.longitude, radiusKm, label: `Service radius: ${radiusKm} km (straight line)` }] : [];
  const set = (k: keyof Profile) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    setFields({});
    const only = verified ? (['contactName', 'contactEmail', 'contactPhone', 'latitude', 'longitude'] as (keyof Profile)[]) : undefined;
    const res = await api(`/organizations/${org.id}`, { method: 'PATCH', body: JSON.stringify(toPayload(form, only)) });
    if (res.ok) {
      setSaved(true);
      await onSaved();
    } else {
      setFields(res.error.fields);
      setError(res.error.code === 'VALIDATION_ERROR' ? 'Please fix the highlighted fields.' : res.error.message);
    }
    setBusy(false);
  }

  const f = (k: keyof Profile, label: string, extra: object = {}) => (
    <Field id={`p-${k}`} label={label} value={form[k]} onChange={set(k)} error={fields[k]} disabled={locked(k)} {...extra} />
  );

  return (
    <form onSubmit={save} noValidate aria-labelledby="profile-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <h2 id="profile-h" className="text-lg font-semibold">Profile and contact details</h2>
      {verified && <p className="mt-1 text-sm text-stone-600">Name and street address are locked after verification. Contact details and the map position can still be updated.</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">{f('name', 'Organization name')}</div>
        {f('contactName', 'Contact person')}
        {f('contactPhone', 'Contact phone', { type: 'tel' })}
        <div className="sm:col-span-2">{f('contactEmail', 'Contact email', { type: 'email' })}</div>
        <div className="sm:col-span-2">{f('addressLine', 'Street address')}</div>
        {f('city', 'City')}
        <LocationPicker
          idPrefix="p"
          latitude={form.latitude}
          longitude={form.longitude}
          disabled={locked('latitude')}
          errors={{ latitude: fields.latitude, longitude: fields.longitude }}
          onChange={(la, lo) => { setSaved(false); setForm((p) => ({ ...p, latitude: la, longitude: lo })); }}
          circles={radiusCircle}
          note={org.type === 'NGO'
            ? 'This point is used to measure distance to food and to your service radius (the dashed circle, set under Needs). Other users only ever see an approximate area. The exact point is shared only with the people in a rescue you accepted, when its stage allows.'
            : 'This point is used to match your food with nearby NGOs. NGOs only see the approximate area (about 1 km) until a rescue is confirmed; the exact address and pin stay private.'}
        />
      </div>
      {editable && (
        <div className="mt-4 max-w-xs space-y-3">
          <FormError message={error} />
          {saved && <p role="status" className="text-sm font-medium text-green-800">✓ Changes saved.</p>}
          <SubmitButton busy={busy}>Save changes</SubmitButton>
        </div>
      )}
    </form>
  );
}

function DocumentsSection({ org, docs, canManage, onChanged }: { org: Organization; docs: OrgDocument[] | null; canManage: boolean; onChanged: () => Promise<void> }) {
  const [type, setType] = useState<DocumentType>('REGISTRATION_CERTIFICATE');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);

  async function upload(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (!file) return setError('Choose a PDF, PNG or JPEG file first.');
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return setError(`That file is larger than ${MAX_UPLOAD_MB} MB.`);
    setBusy(true);
    const form = new FormData();
    form.append('documentType', type);
    form.append('file', file);
    const res = await api(`/organizations/${org.id}/documents`, { method: 'POST', body: form });
    setBusy(false);
    if (res.ok) {
      setOk(`Uploaded ${file.name}.`);
      setFile(null);
      setInputKey((k) => k + 1);
      await onChanged();
    } else setError(res.error.fields.file ?? res.error.fields.documentType ?? res.error.message);
  }

  async function remove(doc: OrgDocument) {
    setRemoving(doc.id);
    setError(null);
    const res = await api(`/organizations/${org.id}/documents/${doc.id}`, { method: 'DELETE' });
    setRemoving(null);
    if (res.ok) await onChanged();
    else setError(res.error.message);
  }

  const editable = org.editable && canManage;
  return (
    <section aria-labelledby="docs-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <h2 id="docs-h" className="text-lg font-semibold">Verification documents</h2>
      <p className="mt-1 text-sm text-stone-600">PDF, PNG or JPEG, up to {MAX_UPLOAD_MB} MB each. Documents are private: only your organization and FoodLoop admins can open them.</p>
      {docs === null ? <Loading label="Loading documents…" /> : <DocumentList orgId={org.id} documents={docs} onDelete={editable ? remove : undefined} busyId={removing} />}
      {editable && (
        <form onSubmit={upload} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" noValidate>
          <div>
            <label htmlFor="doc-type" className="block text-sm font-medium">Document type</label>
            <select id="doc-type" value={type} onChange={(e) => setType(e.target.value as DocumentType)} className="mt-1 block w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5">
              {(Object.keys(documentTypeLabels) as DocumentType[]).map((t) => (
                <option key={t} value={t}>{documentTypeLabels[t]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="doc-file" className="block text-sm font-medium">File</label>
            <input key={inputKey} id="doc-file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm" />
          </div>
          <button type="submit" disabled={busy} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </form>
      )}
      <div className="mt-3"><FormError message={error} /></div>
      {ok && <p role="status" className="mt-2 text-sm font-medium text-green-800">✓ {ok}</p>}
    </section>
  );
}

function SubmitSection({ org, docs, onSubmitted }: { org: Organization; docs: OrgDocument[] | null; onSubmitted: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    setMissing([]);
    const res = await api(`/organizations/${org.id}/submit`, { method: 'POST' });
    setBusy(false);
    if (res.ok) {
      setDone(true);
      await onSubmitted();
    } else {
      const m = res.error.details.missing as string[] | undefined;
      setError(res.error.message);
      if (m) setMissing(m);
    }
  }

  const resubmitting = org.verificationStatus === 'RESUBMISSION_REQUESTED';
  return (
    <section aria-labelledby="submit-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <h2 id="submit-h" className="text-lg font-semibold">{resubmitting ? 'Resubmit for review' : 'Submit for verification'}</h2>
      <p className="mt-1 text-sm text-stone-700">
        Save your profile changes first. Submitting locks the application while an admin reviews it.
        {docs && !docs.some((d) => d.documentType === 'REGISTRATION_CERTIFICATE') && ' A registration certificate is required.'}
      </p>
      <div className="mt-3"><FormError message={error} /></div>
      {missing.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm text-red-800">
          {missing.map((m) => <li key={m}>{missingLabels[m] ?? m} is missing</li>)}
        </ul>
      )}
      {done && <p role="status" className="mt-2 text-sm font-medium text-green-800">✓ Submitted. An admin will review it.</p>}
      <button onClick={() => void submit()} disabled={busy} className="mt-4 rounded-md bg-brand-600 px-5 py-2.5 font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
        {busy ? 'Submitting…' : resubmitting ? 'Resubmit application' : 'Submit application'}
      </button>
    </section>
  );
}
