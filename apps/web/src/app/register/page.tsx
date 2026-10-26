'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Logo } from '@/components/Logo';
import { Field, FormError, Photo, SubmitButton } from '@/components/ui';
import type { PhotoName } from '@/lib/photoCredits';
import { homePathFor } from '@/lib/api';
import { useAuth } from '@/lib/auth';

type SignupRole = 'provider' | 'ngo' | 'runner';

const roleOptions: { value: SignupRole; label: string; help: string }[] = [
  { value: 'provider', label: 'Food provider', help: 'I have surplus food to donate' },
  { value: 'ngo', label: 'NGO / organization', help: 'We receive and distribute food' },
  { value: 'runner', label: 'Volunteer runner', help: 'I can collect and deliver food' },
];

const rolePhoto: Record<SignupRole, PhotoName> = { provider: 'provider-kitchen', ngo: 'volunteers-serving', runner: 'volunteer-handoff' };

export default function RegisterPage() {
  const { status, user, register } = useAuth();
  const router = useRouter();
  const [role, setRole] = useState<SignupRole>('provider');
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', organizationName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    if (status === 'authenticated' && user) router.replace(homePathFor(user.platformRole));
  }, [status, user, router]);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const needsOrg = role !== 'runner';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    const res = await register({
      name: form.name,
      email: form.email,
      password: form.password,
      role,
      ...(form.phone ? { phone: form.phone } : {}),
      ...(needsOrg ? { organizationName: form.organizationName } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setFields(res.error.fields);
      setError(res.error.code === 'VALIDATION_ERROR' ? 'Please fix the highlighted fields.' : res.error.message);
    }
  }

  return (
    <main id="main" className="mx-auto grid min-h-screen max-w-5xl gap-8 px-4 py-8 md:grid-cols-[1fr_1.1fr] md:items-start md:py-12">
      <aside className="md:sticky md:top-8">
        <Link href="/" aria-label="FoodLoop home"><Logo size={38} /></Link>
        <div className="zoom relative mt-6 hidden overflow-hidden rounded-2xl shadow-card md:block">
          <Photo key={role} name={rolePhoto[role]} className="fl-appear h-72 w-full object-cover" />
          <p className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-stone-950/85 to-transparent px-5 pb-4 pt-12 font-semibold text-white" style={{ fontFamily: 'var(--font-display)' }}>
            {roleOptions.find((o) => o.value === role)?.help}
          </p>
        </div>
        <p className="mt-4 hidden text-stone-700 md:block">
          {role === 'provider' ? 'List surplus food in a minute and follow every rescue to the plate.' : role === 'ngo' ? 'Get told about live food near you and accept what fits your needs.' : 'Pick up nearby jobs, verify the pickup code and hand the food over.'}
        </p>
      </aside>
      <section>
        <Link href="/" className="text-sm font-semibold text-paprika-700 underline underline-offset-2">
          ← Back to sign in
        </Link>
        <h1 className="mt-4 text-3xl font-bold text-stone-900">Create your account</h1>
        <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5 rounded-2xl border border-stone-200 bg-white p-6 shadow-card">
          <fieldset>
            <legend className="text-sm font-semibold">I am joining as</legend>
            <div className="mt-2 grid gap-2">
              {roleOptions.map((o) => (
                <label key={o.value} className={`lift flex cursor-pointer gap-3 rounded-xl border-2 p-3 ${role === o.value ? 'border-paprika-600 bg-paprika-50' : 'border-stone-200'}`}>
                  <input type="radio" name="role" value={o.value} checked={role === o.value} onChange={() => setRole(o.value)} className="mt-1" />
                  <span>
                    <span className="block font-semibold">{o.label}</span>
                    <span className="block text-sm text-stone-600">{o.help}</span>
                  </span>
                </label>
              ))}
            </div>
            {fields.role && <p className="mt-1 text-sm text-red-700">{fields.role}</p>}
          </fieldset>

          <Field id="name" label="Full name" autoComplete="name" required value={form.name} onChange={set('name')} error={fields.name} />
          {needsOrg && (
            <Field id="organizationName" label={role === 'provider' ? 'Business / kitchen name' : 'Organization name'} required value={form.organizationName} onChange={set('organizationName')} error={fields.organizationName} hint="After signing in you add details and documents, then submit it for verification." />
          )}
          <Field id="email" label="Email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} error={fields.email} />
          <Field id="phone" label="Phone (optional)" type="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} error={fields.phone} />
          <Field id="password" label="Password" type="password" autoComplete="new-password" required value={form.password} onChange={set('password')} error={fields.password} hint="At least 10 characters, with a letter and a number." />
          <FormError message={error} />
          <SubmitButton busy={busy}>Create account</SubmitButton>
        </form>
      </section>
    </main>
  );
}
