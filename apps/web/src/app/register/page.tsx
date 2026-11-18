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
    <main id="main" className="mx-auto grid min-h-screen max-w-6xl gap-8 px-4 py-6 md:grid-cols-[1fr_1.1fr] md:items-start md:gap-12 md:py-10">
      <aside className="on-dark fl-night relative isolate overflow-hidden rounded-[2rem] p-6 text-white md:sticky md:top-8 md:min-h-[calc(100vh-5rem)] md:p-9">
        <div className="fl-grid absolute inset-0 -z-10" aria-hidden />
        <Link href="/" aria-label="FoodLoop home" className="inline-block"><Logo size={38} tone="light" /></Link>
        <div className="hidden md:block">
          <h2 className="mt-12 text-4xl font-extrabold leading-tight lg:text-5xl">
            Join the loop. <span className="text-zest-gradient">Feed people,</span> not landfills.
          </h2>
          <p className="mt-4 max-w-md text-stone-300">
            {role === 'provider' ? 'List surplus food in a minute and follow every rescue to the plate.' : role === 'ngo' ? 'Get told about live food near you and accept what fits your needs.' : 'Pick up nearby jobs, verify the pickup code and hand the food over.'}
          </p>
          <div className="zoom relative mt-8 overflow-hidden rounded-2xl border border-white/10 shadow-2xl">
            <Photo key={role} name={rolePhoto[role]} className="fl-appear h-64 w-full object-cover" />
            <p className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-stone-950/90 to-transparent px-5 pb-4 pt-12 font-semibold text-white" style={{ fontFamily: 'var(--font-display)' }}>
              {roleOptions.find((o) => o.value === role)?.help}
            </p>
          </div>
          <ul className="mt-8 space-y-2.5 text-sm text-stone-200">
            {['Organizations are verified before they post or accept food', 'Pickup codes are one-time and shown only once', 'Impact counts only food the NGO confirms it received'].map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <span aria-hidden className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zest-300 text-[10px] font-black text-stone-950">✓</span>
                {t}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className="md:pt-4">
        <Link href="/" className="inline-flex items-center gap-1 text-sm font-semibold text-brand-700 underline-offset-4 hover:underline">
          <span aria-hidden>←</span> Back to sign in
        </Link>
        <h1 className="mt-4 text-4xl font-extrabold text-stone-900">Create your account</h1>
        <p className="mt-2 text-stone-600">It takes a minute. You can add organization details after signing in.</p>
        <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5 rounded-3xl border border-stone-200 bg-white p-6 shadow-card sm:p-7">
          <fieldset>
            <legend className="text-sm font-semibold">I am joining as</legend>
            <div className="mt-2 grid gap-2">
              {roleOptions.map((o) => (
                <label key={o.value} className={`lift flex cursor-pointer gap-3 rounded-2xl border-2 p-3.5 ${role === o.value ? 'border-brand-600 bg-brand-50 shadow-[0_8px_20px_-12px_rgb(6_120_88/0.6)]' : 'border-stone-200 hover:border-stone-300'}`}>
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
