'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Loading, Shell, StatusBadge, useRoleGuard } from '@/components/Shell';
import { RunnerProfileForm } from '@/components/RunnerPages';
import { Avatar, Field, FormError, SubmitButton, SuccessNote } from '@/components/ui';
import type { Role, VerificationStatus } from '@/lib/api';
import { useAuth } from '@/lib/auth';

const roleLabel: Record<Role, string> = { provider: 'Food provider', ngo: 'NGO', runner: 'Volunteer runner', admin: 'Administrator' };

const memberText: Record<string, string> = {
  owner: 'Owner: can edit the organization profile, location and documents, and submit it for verification.',
  manager: 'Manager: can edit the organization profile, location and documents, and submit it for verification.',
  operator: 'Operator: can take part in rescues for the organization but cannot change its profile, location or documents.',
};

const permissionText: Record<string, string> = {
  'profile:manage': 'Edit your own account details',
  'admin:access': 'Open the admin area: operations board, incidents, verification queue and rescues',
  'platform:manage': 'Review organization applications and take admin actions on rescues and incidents, each with a recorded reason',
};

export default function ProfilePage() {
  const user = useRoleGuard(['provider', 'ngo', 'runner', 'admin']);
  const { updateAccount } = useAuth();
  const [name, setName] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  if (!user) return <Loading label="Restoring your session…" />;
  const nameVal = name ?? user.name;
  const phoneVal = phone ?? user.phone ?? '';
  const dirty = nameVal !== user.name || phoneVal !== (user.phone ?? '');

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
    <Shell user={user} title="Your profile">
      <section className="fl-appear mt-4 flex flex-wrap items-center gap-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
        <Avatar name={user.name} size={64} />
        <div className="min-w-0">
          <p className="truncate text-xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>{user.name}</p>
          <p className="text-sm text-stone-700">{roleLabel[user.platformRole]} · <span className="break-all">{user.email}</span></p>
        </div>
        <p className="w-full text-xs text-stone-600 sm:ml-auto sm:w-auto">Initials are shown instead of a photo. FoodLoop does not store profile pictures.</p>
      </section>

      <div className="stagger mt-6 grid gap-6 lg:grid-cols-2">
        <form onSubmit={save} noValidate aria-labelledby="acct-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
          <h2 id="acct-h" className="text-lg font-bold">Account details</h2>
          <div className="mt-4 space-y-4">
            <Field id="acct-name" label="Full name" autoComplete="name" value={nameVal} onChange={(e) => { setSaved(false); setName(e.target.value); }} error={fields.name} />
            <Field id="acct-phone" label="Phone (optional)" type="tel" autoComplete="tel" value={phoneVal} onChange={(e) => { setSaved(false); setPhone(e.target.value); }} error={fields.phone} hint="Leave empty to remove it." />
            <div>
              <label htmlFor="acct-email" className="block text-sm font-semibold">Email</label>
              <input id="acct-email" value={user.email} readOnly aria-describedby="acct-email-h" className="mt-1 block w-full rounded-lg border border-stone-200 bg-stone-100 px-3 py-2.5 text-base text-stone-700" />
              <p id="acct-email-h" className="mt-1 text-sm text-stone-600">Your email is your sign-in identity, so it cannot be changed here.</p>
            </div>
            <div>
              <label htmlFor="acct-role" className="block text-sm font-semibold">Role</label>
              <input id="acct-role" value={roleLabel[user.platformRole]} readOnly aria-describedby="acct-role-h" className="mt-1 block w-full rounded-lg border border-stone-200 bg-stone-100 px-3 py-2.5 text-base text-stone-700" />
              <p id="acct-role-h" className="mt-1 text-sm text-stone-600">Roles are set when the account is created and cannot be changed from the app.</p>
            </div>
            <FormError message={error} />
            {saved && <SuccessNote>Profile saved.</SuccessNote>}
            <SubmitButton busy={busy}>{dirty ? 'Save changes' : 'Save'}</SubmitButton>
          </div>
        </form>

        {(user.platformRole === 'provider' || user.platformRole === 'ngo') && (
          <section aria-labelledby="orgs-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
            <h2 id="orgs-h" className="text-lg font-bold">Your organization</h2>
            {user.memberships.length === 0 && <p className="mt-2 text-sm text-stone-700">You are not a member of any organization yet.</p>}
            <ul className="mt-3 space-y-4">
              {user.memberships.map((m) => (
                <li key={m.organizationId} className="rounded-xl border border-stone-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">{m.organizationName}</p>
                    <StatusBadge status={m.verificationStatus as VerificationStatus} />
                  </div>
                  <p className="mt-1 text-sm text-stone-700">{m.organizationType === 'NGO' ? 'NGO' : 'Food provider'} · your role: <strong>{m.memberRole}</strong></p>
                  <p className="mt-1 text-sm text-stone-600">{memberText[m.memberRole] ?? 'Member of this organization.'}</p>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link href="/organization" className="inline-flex min-h-11 items-center rounded-lg bg-paprika-600 px-4 py-2 text-sm font-semibold text-white hover:bg-paprika-700">Organization details, location and documents</Link>
              {user.platformRole === 'ngo' && <Link href="/ngo/requirements" className="inline-flex min-h-11 items-center rounded-lg border border-paprika-600 px-4 py-2 text-sm font-semibold text-paprika-700 hover:bg-paprika-50">Food needs and service radius</Link>}
            </div>
          </section>
        )}

        {user.platformRole === 'admin' && (
          <section aria-labelledby="perm-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
            <h2 id="perm-h" className="text-lg font-bold">What this role can do</h2>
            <p className="mt-1 text-sm text-stone-700">Administrator accounts are created by FoodLoop operators. There is no self-service way to gain or change this role.</p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
              {user.permissions.length === 0 && <li>Permissions are enforced by the server on every request.</li>}
              {user.permissions.map((p) => <li key={p}>{permissionText[p] ?? p}</li>)}
            </ul>
            <p className="mt-3 text-xs text-stone-600">Every admin action on a rescue or an application is recorded with a reason in its audit history.</p>
          </section>
        )}

        {user.platformRole === 'runner' && (
          <section aria-labelledby="share-h" className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card">
            <h2 id="share-h" className="text-lg font-bold">Location sharing</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-stone-700">
              <li>Sharing is <strong>never automatic</strong>. You start it yourself on an active rescue and your browser asks for permission at that moment.</li>
              <li>While it is on, the provider, the NGO and admins see your latest position (about 100 m). Only the latest point is kept, never a trail.</li>
              <li>You can stop at any time; stopping deletes the stored point. It is also deleted when you hand over, release or the rescue ends.</li>
              <li>If you deny permission you can still deliver, and you can type a position by hand instead.</li>
            </ul>
            <p className="mt-3 text-xs text-stone-600">There is deliberately no &ldquo;always share&rdquo; setting: each rescue asks again.</p>
          </section>
        )}
      </div>

      {user.platformRole === 'runner' && (
        <section aria-labelledby="veh-h" className="mt-6">
          <h2 id="veh-h" className="text-lg font-bold">Transport, availability and base area</h2>
          <RunnerProfileForm />
        </section>
      )}
    </Shell>
  );
}
