'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Logo } from '@/components/Logo';
import { Field, FormError, Photo, Spinner, SubmitButton } from '@/components/ui';
import { homePathFor } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { PhotoName } from '@/lib/photoCredits';

const steps: { title: string; text: string; photo: PhotoName }[] = [
  { title: 'Providers post surplus', text: 'Canteens, bakeries and caterers list safe surplus food with a pickup window and a deadline.', photo: 'provider-kitchen' },
  { title: 'NGOs claim it', text: 'Verified NGOs near the food are told in waves and accept what fits their needs and capacity.', photo: 'volunteers-serving' },
  { title: 'Runners move it', text: 'A volunteer collects it with a one-time pickup code and hands it over before it expires.', photo: 'volunteer-handoff' },
];

const paths = [
  { role: 'Food provider', text: 'Post surplus in a minute, see who accepted it, and track the rescue to the plate.' },
  { role: 'NGO', text: 'See live food near you with urgency and match reasons, then accept in one tap.' },
  { role: 'Runner', text: 'Pick up nearby jobs on your phone, verify the pickup code and hand over.' },
];

export default function Home() {
  const { status, user, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    if (status === 'authenticated' && user) router.replace(homePathFor(user.platformRole));
  }, [status, user, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    const res = await login(email, password);
    setBusy(false);
    if (!res.ok) {
      setFields(res.error.fields);
      setError(res.error.message);
    }
  }

  return (
    <div>
      <a href="#main" className="skip-link">Skip to main content</a>
      <section className="on-dark relative isolate overflow-hidden bg-stone-950 text-white">
        <Photo name="hero-handover" decorative priority className="absolute inset-0 -z-20 h-full w-full object-cover" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-stone-950/95 via-stone-950/70 to-stone-950/20" aria-hidden />
        <div className="mx-auto max-w-6xl px-4 py-6">
          <Logo size={40} tone="light" />
        </div>
        <main id="main" className="mx-auto grid max-w-6xl gap-10 px-4 pb-14 pt-6 md:grid-cols-[1.2fr_1fr] md:items-center md:pb-20 md:pt-10">
          <div>
            <p className="inline-block rounded-full bg-saffron-300 px-3 py-1 text-xs font-bold uppercase tracking-wider text-stone-950">Surplus food, rescued in time</p>
            <h1 className="mt-4 text-4xl font-bold leading-tight sm:text-5xl">Good food belongs on plates, not in bins.</h1>
            <p className="mt-4 max-w-xl text-lg text-stone-100">
              FoodLoop connects canteens, bakeries and caterers with verified NGOs and volunteer runners, so time-sensitive surplus reaches people while it is still fresh.
            </p>
            <ul className="mt-6 flex flex-wrap gap-2 text-sm font-semibold">
              {['Verified NGOs only', 'One-time pickup codes', 'Impact you can count'].map((t) => (
                <li key={t} className="rounded-full border border-white/30 bg-white/10 px-3 py-1">✓ {t}</li>
              ))}
            </ul>
          </div>

          <section aria-labelledby="signin-h" className="on-light rounded-2xl bg-white p-6 text-stone-900 shadow-lift">
            <h2 id="signin-h" className="text-2xl font-bold">Sign in</h2>
            <p className="text-sm text-stone-600">Providers, NGOs, runners and admins all start here.</p>
            {status === 'loading' ? (
              <Spinner label="Checking your session…" />
            ) : (
              <form onSubmit={onSubmit} noValidate className="mt-4 space-y-4">
                {status === 'unavailable' && <FormError message="Cannot reach the FoodLoop server. Check that the API is running." />}
                <Field id="email" label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={fields.email} />
                <Field id="password" label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={fields.password} />
                <FormError message={error} />
                <SubmitButton busy={busy}>Sign in</SubmitButton>
                <p className="text-center text-sm text-stone-700">
                  New to FoodLoop?{' '}
                  <Link href="/register" className="font-semibold text-paprika-700 underline underline-offset-2">
                    Create an account
                  </Link>
                </p>
              </form>
            )}
          </section>
        </main>
      </section>

      <section aria-labelledby="how-h" className="mx-auto max-w-6xl px-4 py-14">
        <h2 id="how-h" className="text-3xl font-bold text-stone-900">How a rescue works</h2>
        <ol className="stagger mt-8 grid gap-6 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className="lift overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-card">
              <Photo name={s.photo} className="h-44 w-full object-cover" />
              <div className="p-5">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-paprika-600 text-sm font-bold text-white" aria-hidden>{i + 1}</span>
                <h3 className="mt-3 text-xl font-bold">{s.title}</h3>
                <p className="mt-1 text-stone-700">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="who-h" className="bg-saffron-50 py-14">
        <div className="mx-auto max-w-6xl px-4">
          <h2 id="who-h" className="text-3xl font-bold text-stone-900">Find your place in the loop</h2>
          <div className="stagger mt-8 grid gap-6 md:grid-cols-3">
            {paths.map((p) => (
              <div key={p.role} className="lift rounded-2xl border border-saffron-200 bg-white p-5">
                <h3 className="text-xl font-bold text-paprika-800">{p.role}</h3>
                <p className="mt-2 text-stone-700">{p.text}</p>
                <Link href="/register" className="mt-4 inline-block font-semibold text-paprika-700 underline underline-offset-4">
                  Register as {p.role === 'Food provider' ? 'a provider' : p.role === 'NGO' ? 'an NGO' : 'a runner'}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-stone-200 py-6 text-center text-sm text-stone-600">
        <Logo size={26} /> <span className="block pt-2">Rescuing surplus food, closing the loop · <Link href="/credits" className="underline underline-offset-2">Photo credits</Link></span>
      </footer>
    </div>
  );
}
