'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DocumentList, HistoryList, formatDate } from '@/components/OrgParts';
import { Loading, Shell, StatusBadge, useRoleGuard } from '@/components/Shell';
import { MapView } from '@/components/MapView';
import { FormError } from '@/components/ui';
import { api, type HistoryItem, type OrgDocument, type Organization } from '@/lib/api';

interface Detail {
  organization: Organization;
  owner: { name: string; email: string; phone: string | null } | null;
  documents: OrgDocument[];
  history: HistoryItem[];
}

type Decision = 'APPROVE' | 'REQUEST_RESUBMISSION' | 'REJECT';

const decisions: { value: Decision; label: string; help: string; needsReason: boolean }[] = [
  { value: 'APPROVE', label: 'Approve', help: 'Marks the organization verified.', needsReason: false },
  { value: 'REQUEST_RESUBMISSION', label: 'Request resubmission', help: 'The applicant can fix details or documents and submit again.', needsReason: true },
  { value: 'REJECT', label: 'Reject', help: 'Final. The applicant must start a new application.', needsReason: true },
];

export default function VerificationDetailPage() {
  const user = useRoleGuard(['admin']);
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<Detail>(`/admin/verifications/${id}`);
    if (res.ok) setDetail(res.data);
    else setError(res.error.status === 404 ? 'This organization was not found.' : res.error.message);
  }, [id]);
  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (!user) return <Loading label="Restoring your session…" />;
  const org = detail?.organization;

  return (
    <Shell
      user={user}
      title={org ? org.name : 'Application review'}
      eyebrow={org ? `${org.type === 'PROVIDER' ? 'Food provider' : 'NGO'} application` : 'Verification'}
      back={{ href: '/admin/verifications', label: 'Back to queue' }}
      subtitle={org ? <span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={org.verificationStatus} /> {org.submissionNumber ? `Submission #${org.submissionNumber}, ${formatDate(org.submittedAt)}` : 'Not submitted yet'}</span> : undefined}
    >
      {error && <FormError message={error} />}
      {!detail && !error && <Loading label="Loading application…" />}
      {detail && org && (
        <div className="space-y-4">
          {notice && <p role="status" className="fl-appear rounded-xl border-2 border-stone-900 bg-white px-4 py-3 text-sm font-semibold text-stone-900 shadow-card">✓ {notice}</p>}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] lg:items-start">
            <div className="min-w-0 space-y-4">
              <section aria-labelledby="org-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
                <h2 id="org-h" className="text-lg font-bold">{org.type === 'PROVIDER' ? 'Food provider' : 'NGO'} details</h2>
                <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  {([
                    ['Name', org.name],
                    ['Contact person', org.contactName],
                    ['Contact email', org.contactEmail],
                    ['Contact phone', org.contactPhone],
                    ['Address', [org.addressLine, org.city].filter(Boolean).join(', ')],
                    ['Account owner', detail.owner ? `${detail.owner.name} (${detail.owner.email})` : null],
                  ] as const).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-stone-600">{k}</dt>
                      <dd className="mt-0.5 break-words">{v || <span className="text-stone-500">Not provided</span>}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              {org.latitude != null && org.longitude != null && (
                <section aria-labelledby="loc-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
                  <h2 id="loc-h" className="text-lg font-bold">Location</h2>
                  <p className="text-sm text-stone-700">{org.latitude}, {org.longitude} · compare it with the address above.</p>
                  <MapView title="Organization location" height={260} markers={[{ id: 'org', kind: 'org', latitude: org.latitude, longitude: org.longitude, label: org.name, showLabel: true }]} />
                </section>
              )}

              <section aria-labelledby="docs-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
                <h2 id="docs-h" className="text-lg font-bold">Documents</h2>
                <DocumentList orgId={org.id} documents={detail.documents} />
              </section>

              <section aria-labelledby="hist-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
                <h2 id="hist-h" className="text-lg font-bold">Review history</h2>
                <HistoryList history={detail.history} />
              </section>
            </div>

            <aside className="lg:sticky lg:top-24">
              {org.verificationStatus === 'UNDER_REVIEW' ? (
                <DecisionForm org={org} onDecided={async (msg) => { setNotice(msg); await load(); }} />
              ) : (
                <p role="status" className="rounded-2xl border border-stone-300 bg-white p-5 text-sm shadow-card">
                  No decision is needed: this application is <strong>{org.verificationStatus.replace(/_/g, ' ').toLowerCase()}</strong>.
                </p>
              )}
            </aside>
          </div>
        </div>
      )}
    </Shell>
  );
}

function DecisionForm({ org, onDecided }: { org: Organization; onDecided: (message: string) => Promise<void> }) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const chosen = decisions.find((d) => d.value === decision);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setReasonError(null);
    if (!chosen) return setError('Choose a decision.');
    if (chosen.needsReason && !reason.trim()) return setReasonError('A reason is required. The applicant will see it.');
    setBusy(true);
    const res = await api(`/admin/verifications/${org.id}/decision`, {
      method: 'POST',
      body: JSON.stringify({
        decision: chosen.value,
        submissionNumber: org.submissionNumber,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    });
    setBusy(false);
    if (res.ok) {
      await onDecided(`Decision recorded: ${chosen.label.toLowerCase()}.`);
    } else if (res.error.code === 'STALE_REVIEW' || res.error.code === 'INVALID_STATUS_TRANSITION') {
      setError(`${res.error.message} The page has been refreshed.`);
      await onDecided('');
    } else {
      setReasonError(res.error.fields.reason ?? null);
      setError(res.error.message);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="decide-h" className="rounded-2xl border-2 border-brand-600 bg-white p-5 shadow-card">
      <h2 id="decide-h" className="text-lg font-semibold">Decision</h2>
      <fieldset className="mt-3 space-y-2">
        <legend className="sr-only">Choose a decision</legend>
        {decisions.map((d) => (
          <label key={d.value} className={`lift flex cursor-pointer gap-3 rounded-xl border-2 p-3 ${decision === d.value ? 'border-brand-600 bg-brand-50' : 'border-stone-300'}`}>
            <input type="radio" name="decision" value={d.value} checked={decision === d.value} onChange={() => setDecision(d.value)} className="mt-1" />
            <span>
              <span className="block font-medium">{d.label}</span>
              <span className="block text-sm text-stone-600">{d.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-4">
        <label htmlFor="reason" className="block text-sm font-medium">
          Reason {chosen?.needsReason ? '(required)' : '(optional)'}
        </label>
        <textarea id="reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={reasonError ? true : undefined} aria-describedby={reasonError ? 'reason-error' : undefined} className={`mt-1 block w-full rounded-md border px-3 py-2 ${reasonError ? 'border-red-600' : 'border-stone-300'}`} />
        {reasonError && <p id="reason-error" className="mt-1 text-sm text-red-700">{reasonError}</p>}
      </div>
      <div className="mt-3"><FormError message={error} /></div>
      <button type="submit" disabled={busy || !decision} className="mt-4 w-full rounded-lg bg-brand-600 px-5 py-3 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60">
        {busy ? 'Saving…' : 'Record decision'}
      </button>
    </form>
  );
}
