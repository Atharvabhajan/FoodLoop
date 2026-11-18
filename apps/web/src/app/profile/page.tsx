'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { OrganizationPanel } from '@/components/OrgPanel';
import { RequirementsPanel } from '@/components/RequirementsPanel';
import { RunnerProfileForm } from '@/components/RunnerPages';
import { Loading, Shell, StatusBadge, useRoleGuard } from '@/components/Shell';
import { Avatar, Field, FormError, SubmitButton, SuccessNote } from '@/components/ui';
import { api, type Organization, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Requirement } from '@/lib/supply';

const roleLabel: Record<Role, string> = { provider: 'Food provider', ngo: 'NGO', runner: 'Volunteer runner', admin: 'Administrator' };

const memberText: Record<string, string> = {
  owner: 'Owner: can edit the organization profile, location and documents, and submit it for verification.',
  manager: 'Manager: can edit the organization profile, location and documents, and submit it for verification.',
  operator: 'Operator: can take part in rescues for the organization but cannot change its profile, location or documents.',
};

type Tab = 'account' | 'organization' | 'needs' | 'transport';

function maskEmail(e: string) {
  const [local = '', domain = ''] = e.split('@');
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(2, local.length - 1))}@${domain.slice(0, 1)}${'•'.repeat(3)}${domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : ''}`;
}

export default function ProfilePage() {
  const user = useRoleGuard(['provider', 'ngo', 'runner', 'admin']);
  const { updateAccount, logout } = useAuth();
  const [tab, setTab] = useState<Tab>('account');
  const [name, setName] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [org, setOrg] = useState<Organization | null>(null);
  const [req, setReq] = useState<Requirement | null>(null);
  const [docCount, setDocCount] = useState<number | null>(null);

  // /profile#organization etc. open that tab (the dashboards link here)
  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.replace('#', '') as Tab;
      if (['account', 'organization', 'needs', 'transport'].includes(h)) setTab(h);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  const role = user?.platformRole;
  useEffect(() => {
    if (role !== 'provider' && role !== 'ngo') return;
    void api<{ organizations: Organization[] }>('/organizations').then((r) => {
      const o = r.ok ? (r.data.organizations.find((x) => x.verificationStatus !== 'REJECTED') ?? null) : null;
      setOrg(o);
      if (o) void api<{ documents: unknown[] }>(`/organizations/${o.id}/documents`).then((d) => setDocCount(d.ok ? d.data.documents.length : null));
    });
    if (role === 'ngo') void api<{ requirement: Requirement | null }>('/ngo-requirements/current').then((r) => setReq(r.ok ? r.data.requirement : null));
  }, [role]);

  if (!user) return <Loading label="Restoring your session…" />;
  const nameVal = name ?? user.name;
  const phoneVal = phone ?? user.phone ?? '';
  const dirty = nameVal !== user.name || phoneVal !== (user.phone ?? '');
  const hasOrg = user.platformRole === 'provider' || user.platformRole === 'ngo';
  const membership = user.memberships[0];

  const tabs: { id: Tab; label: string }[] = [
    { id: 'account', label: 'Account' },
    ...(hasOrg ? [{ id: 'organization' as Tab, label: 'Organization' }] : []),
    ...(user.platformRole === 'ngo' ? [{ id: 'needs' as Tab, label: 'Needs and capacity' }] : []),
    ...(user.platformRole === 'runner' ? [{ id: 'transport' as Tab, label: 'Transport and availability' }] : []),
  ];
  const go = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, '', `#${t}`);
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    setSaved(false);
    const res = await updateAccount({ name: nameVal.trim(), phone: phoneVal.trim() === '' ? null : phoneVal.trim() });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      setName(null);
      setPhone(null);
    } else {
      setFields(res.error.fields);
      setError(res.error.code === 'VALIDATION_ERROR' ? 'Please fix the highlighted fields.' : res.error.message);
    }
  }

  return (
    <Shell user={user} title="Your profile" eyebrow="Account" subtitle="Your personal details, your organization and the settings that decide what you are offered.">
      <section className="fl-appear mt-1 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-card">
        <div className="flex flex-wrap items-center gap-4 bg-stone-950 px-5 py-5 text-white on-dark md:px-7">
          <Avatar name={user.name} size={68} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-2xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>{user.name}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-stone-200">
              <span className="rounded-full bg-zest-300 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-stone-950">{roleLabel[user.platformRole]}</span>
              {membership && <span>{membership.organizationName}</span>}
              {org && <span className="rounded-full bg-white px-0.5"><StatusBadge status={org.verificationStatus} /></span>}
            </p>
          </div>
        </div>
        {user.platformRole === 'ngo' && (
          <dl className="grid grid-cols-2 divide-x divide-y divide-stone-200 border-t border-stone-200 text-sm md:grid-cols-4 md:divide-y-0">
            <div className="p-3"><dt className="text-xs text-stone-600">Service radius</dt><dd className="font-bold">{req ? `${req.serviceRadiusKm} km` : 'Not set'}</dd></div>
            <div className="p-3"><dt className="text-xs text-stone-600">Receiving capacity</dt><dd className="font-bold">{req ? `${req.capacityServings} servings` : 'Not set'}</dd></div>
            <div className="p-3"><dt className="text-xs text-stone-600">Intake</dt><dd className="font-bold">{!req ? 'Needs not set' : !req.intakeEnabled ? 'Paused' : req.acceptingNow ? 'Receiving' : 'Window ended'}</dd></div>
            <div className="p-3"><dt className="text-xs text-stone-600">Documents</dt><dd className="font-bold">{docCount === null ? '–' : docCount === 0 ? 'None uploaded' : `${docCount} uploaded`}</dd></div>
          </dl>
        )}
      </section>

      <div role="tablist" aria-label="Profile sections" className="mt-5 flex flex-wrap gap-1 border-b-2 border-stone-200">
        {tabs.map((t) => (
          <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} onClick={() => go(t.id)} className={`-mb-0.5 min-h-11 border-b-4 px-4 py-2 text-sm font-semibold ${tab === t.id ? 'border-brand-600 text-stone-900' : 'border-transparent text-stone-600 hover:text-stone-900'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'account' && (
        <div role="tabpanel" id="panel-account" aria-labelledby="tab-account" className="fl-appear mt-5 grid gap-5 lg:grid-cols-2">
          <form onSubmit={save} noValidate aria-labelledby="acct-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
            <h2 id="acct-h" className="text-lg font-bold">Personal details</h2>
            <p className="mt-1 text-sm text-stone-600">These belong to you, not to your organization.</p>
            <div className="mt-4 space-y-4">
              <Field id="acct-name" label="Full name" autoComplete="name" value={nameVal} onChange={(e) => { setSaved(false); setName(e.target.value); }} error={fields.name} />
              <Field id="acct-phone" label="Phone (optional)" type="tel" autoComplete="tel" value={phoneVal} onChange={(e) => { setSaved(false); setPhone(e.target.value); }} error={fields.phone} hint="Leave empty to remove it." />
              <FormError message={error} />
              {saved && <SuccessNote>Profile saved.</SuccessNote>}
              <SubmitButton busy={busy}>{dirty ? 'Save changes' : 'Save'}</SubmitButton>
            </div>
          </form>

          <section aria-labelledby="sec-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
            <h2 id="sec-h" className="text-lg font-bold">Account and security</h2>
            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="font-semibold">Role</dt>
                <dd className="text-stone-700">{roleLabel[user.platformRole]}. Roles are set when the account is created and cannot be changed from the app.</dd>
              </div>
              <div>
                <dt className="font-semibold">Sign-in email</dt>
                <dd className="flex flex-wrap items-center gap-2 text-stone-700">
                  <span className="break-all" aria-live="polite">{reveal ? user.email : maskEmail(user.email)}</span>
                  <button type="button" onClick={() => setReveal((r) => !r)} className="rounded-lg border border-stone-300 px-2.5 py-1 text-xs font-semibold hover:bg-stone-100">{reveal ? 'Hide' : 'Show'}</button>
                </dd>
                <dd className="mt-0.5 text-xs text-stone-600">Your email is your sign-in identity, so it cannot be edited here.</dd>
              </div>
              <div>
                <dt className="font-semibold">Password</dt>
                <dd className="text-stone-700">Changing your password is not available in the app yet. Your session uses secure, short-lived cookies.</dd>
              </div>
              {hasOrg && membership && (
                <div>
                  <dt className="font-semibold">Organization membership</dt>
                  <dd className="text-stone-700">{membership.organizationName}: <strong>{membership.memberRole}</strong>. {memberText[membership.memberRole] ?? ''}</dd>
                </div>
              )}
              {user.platformRole === 'admin' && (
                <div>
                  <dt className="font-semibold">Administrator access</dt>
                  <dd className="text-stone-700">Administrator accounts are created by FoodLoop operators; there is no self-service way to gain or change this role. Every admin action on a rescue or an application is recorded with a reason.</dd>
                </div>
              )}
            </dl>
            <button type="button" onClick={() => void logout()} className="mt-5 inline-flex min-h-11 items-center rounded-lg border border-stone-400 px-4 py-2 text-sm font-semibold hover:bg-stone-100">Sign out of this device</button>
          </section>

          {user.platformRole === 'runner' && (
            <section aria-labelledby="share-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card lg:col-span-2">
              <h2 id="share-h" className="text-lg font-bold">Location sharing</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-stone-700">
                <li>Sharing is <strong>never automatic</strong>. You start it yourself on an active rescue and your browser asks for permission at that moment.</li>
                <li>While it is on, the provider, the NGO and admins see your latest position (about 100 m). Only the latest point is kept, never a trail.</li>
                <li>You can stop at any time; stopping deletes the stored point. It is also deleted when you hand over, release or the rescue ends.</li>
                <li>If you deny permission you can still deliver, and you can type a position by hand instead. Each rescue asks again.</li>
              </ul>
              <p className="mt-3 text-sm"><Link href="/runner/rescues" className="font-semibold text-brand-700 underline">Go to my rescues</Link></p>
            </section>
          )}
        </div>
      )}

      {tab === 'organization' && hasOrg && (
        <div role="tabpanel" id="panel-organization" aria-labelledby="tab-organization" className="fl-appear">
          <OrganizationPanel role={user.platformRole as 'provider' | 'ngo'} />
        </div>
      )}

      {tab === 'needs' && user.platformRole === 'ngo' && (
        <div role="tabpanel" id="panel-needs" aria-labelledby="tab-needs" className="fl-appear">
          <RequirementsPanel />
        </div>
      )}

      {tab === 'transport' && user.platformRole === 'runner' && (
        <div role="tabpanel" id="panel-transport" aria-labelledby="tab-transport" className="fl-appear">
          <RunnerProfileForm />
        </div>
      )}
    </Shell>
  );
}

