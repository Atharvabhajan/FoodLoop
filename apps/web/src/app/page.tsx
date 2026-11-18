'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Logo } from '@/components/Logo';
import { Field, FormError, Photo, Spinner, SubmitButton } from '@/components/ui';
import { homePathFor } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { PhotoName } from '@/lib/photoCredits';

const steps: { title: string; text: string; photo: PhotoName; tag: string }[] = [
  { title: 'Providers post surplus', text: 'Canteens, bakeries and caterers list safe surplus food with a pickup window and a deadline.', photo: 'provider-kitchen', tag: 'Post' },
  { title: 'NGOs claim it', text: 'Verified NGOs near the food are told in waves and accept what fits their needs and capacity.', photo: 'volunteers-serving', tag: 'Match' },
  { title: 'Runners move it', text: 'A volunteer collects it with a one-time pickup code and hands it over before it expires.', photo: 'volunteer-handoff', tag: 'Deliver' },
];

const Icon = ({ d }: { d: string }) => (
  <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const paths: { role: string; article: string; text: string; points: string[]; icon: string; tile: string; card: string }[] = [
  {
    role: 'Food provider',
    article: 'a provider',
    text: 'Post surplus in a minute and follow every rescue to the plate.',
    points: ['Matched NGOs with distance and score', 'One-time pickup code at hand-off'],
    icon: 'M3 11h18M5 11V7a7 7 0 0 1 14 0v4M4 15h16l-1.5 5h-13z',
    tile: 'bg-brand-100 text-brand-700',
    card: 'border-stone-200 bg-white',
  },
  {
    role: 'NGO',
    article: 'an NGO',
    text: 'See live food near you, ranked for your needs, and accept in one tap.',
    points: ['Urgency and match reasons', 'Capacity, radius and availability'],
    icon: 'M12 21s-7-4.5-7-11a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 6.5-7 11-7 11z',
    tile: 'bg-zest-300 text-stone-950',
    card: 'on-dark border-stone-800 bg-stone-950 text-white',
  },
  {
    role: 'Runner',
    article: 'a runner',
    text: 'Pick up nearby jobs that fit your vehicle and hand food over in time.',
    points: ['Jobs sized to your capacity', 'Map, next step and live status'],
    icon: 'M5 18a3 3 0 1 0 0-.01M19 18a3 3 0 1 0 0-.01M5 18l4-9h5l3 9M9 9h-2',
    tile: 'bg-blue-50 text-blue-600',
    card: 'border-stone-200 bg-white',
  },
];

function Chip({ children }: { children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 py-1.5 text-sm font-medium text-stone-100 backdrop-blur">
      <span aria-hidden className="flex h-4 w-4 items-center justify-center rounded-full bg-zest-300 text-[10px] font-black text-stone-950">✓</span>
      {children}
    </li>
  );
}

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
      <section className="on-dark fl-night relative isolate overflow-hidden text-white">
        <div className="fl-grid absolute inset-0 -z-10" aria-hidden />
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
          <Logo size={40} tone="light" />
          <nav aria-label="Get started" className="flex items-center gap-2 text-sm font-semibold">
            <a href="#how-h" className="hidden rounded-full px-3 py-2 text-stone-200 hover:bg-white/10 sm:inline-block">How it works</a>
            <Link href="/register" className="rounded-full bg-white px-4 py-2 text-stone-950 hover:bg-zest-200">Create account</Link>
          </nav>
        </div>

        <main id="main" className="mx-auto grid max-w-6xl gap-12 px-4 pb-16 pt-8 md:grid-cols-[1.15fr_1fr] md:items-center md:pb-24 md:pt-14">
          <div className="fl-page">
            <p className="inline-flex items-center gap-2 rounded-full border border-zest-300/40 bg-zest-300/10 px-3 py-1 text-xs font-bold uppercase tracking-wider text-zest-200">
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-zest-300" />
              Surplus food, rescued in time
            </p>
            <h1 className="mt-5 text-5xl font-extrabold leading-[1.02] sm:text-6xl lg:text-7xl">
              Good food belongs on <span className="text-zest-gradient">plates</span>, not in bins.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-stone-300">
              FoodLoop connects canteens, bakeries and caterers with verified NGOs and volunteer runners, so time-sensitive surplus reaches people while it is still fresh.
            </p>
            <ul className="mt-8 flex flex-wrap gap-2">
              <Chip>Verified NGOs only</Chip>
              <Chip>One-time pickup codes</Chip>
              <Chip>Impact you can count</Chip>
            </ul>
          </div>

          <div className="relative">
            {/* decorative photo cards peeking out behind the form */}
            <div aria-hidden className="pointer-events-none absolute -right-6 -top-10 hidden w-44 overflow-hidden rounded-2xl border-4 border-white/10 shadow-2xl fl-float lg:block" style={{ ['--r' as string]: '6deg' }}>
              <Photo name="cooked-thali" decorative className="h-32 w-full object-cover" />
            </div>
            <div aria-hidden className="pointer-events-none absolute -bottom-10 -left-10 hidden w-40 overflow-hidden rounded-2xl border-4 border-white/10 shadow-2xl fl-float lg:block" style={{ ['--r' as string]: '-7deg', animationDelay: '1.5s' }}>
              <Photo name="bakery-loaves" decorative className="h-28 w-full object-cover" />
            </div>

            <section aria-labelledby="signin-h" className="on-light fl-appear relative rounded-3xl border border-white/60 bg-white/95 p-7 text-stone-900 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.55)] backdrop-blur sm:p-8">
              <h2 id="signin-h" className="text-3xl font-bold">Welcome back</h2>
              <p className="mt-1 text-sm text-stone-600">Providers, NGOs, runners and admins all sign in here.</p>
              {status === 'loading' ? (
                <Spinner label="Checking your session…" />
              ) : (
                <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
                  {status === 'unavailable' && <FormError message="Cannot reach the FoodLoop server. Check that the API is running." />}
                  <Field id="email" label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={fields.email} />
                  <Field id="password" label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={fields.password} />
                  <FormError message={error} />
                  <SubmitButton busy={busy}>Sign in</SubmitButton>
                  <p className="border-t border-stone-200 pt-4 text-center text-sm text-stone-700">
                    New to FoodLoop?{' '}
                    <Link href="/register" className="font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-800">
                      Create an account
                    </Link>
                  </p>
                </form>
              )}
            </section>
          </div>
        </main>
      </section>

      <section aria-labelledby="how-h" className="mx-auto max-w-6xl scroll-mt-6 px-4 py-20">
        <div className="max-w-2xl">
          <p className="text-xs font-bold uppercase tracking-wider text-brand-700">How it works</p>
          <h2 id="how-h" className="mt-2 text-4xl font-extrabold text-stone-900 sm:text-5xl">From surplus to supper, in three moves.</h2>
        </div>
        <ol className="stagger mt-12 grid gap-6 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className="lift group relative overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-card">
              <div className="zoom relative">
                <Photo name={s.photo} className="h-48 w-full object-cover" />
                <span className="absolute left-4 top-4 rounded-full bg-white/90 px-3 py-1 text-xs font-bold uppercase tracking-wider text-stone-900 backdrop-blur">{s.tag}</span>
              </div>
              <div className="p-6">
                <span aria-hidden className="inline-flex h-9 min-w-9 items-center justify-center rounded-full bg-brand-50 px-2 text-sm font-extrabold text-brand-700 ring-1 ring-brand-200">0{i + 1}</span>
                <h3 className="mt-3 text-xl font-bold">{s.title}</h3>
                <p className="mt-2 leading-relaxed text-stone-600">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="who-h" className="border-y border-stone-200 bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <div className="max-w-2xl">
            <p className="text-xs font-bold uppercase tracking-wider text-brand-700">Who it is for</p>
            <h2 id="who-h" className="mt-2 text-4xl font-extrabold text-stone-900 sm:text-5xl">Find your place in the loop.</h2>
          </div>
          <div className="stagger mt-12 grid gap-6 md:grid-cols-3">
            {paths.map((p) => (
              <div key={p.role} className={`lift flex flex-col rounded-3xl border p-7 shadow-card ${p.card}`}>
                <span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${p.tile}`}>
                  <Icon d={p.icon} />
                </span>
                <h3 className="mt-5 text-2xl font-bold">{p.role}</h3>
                <p className={`mt-2 leading-relaxed ${p.card.includes('on-dark') ? 'text-stone-300' : 'text-stone-600'}`}>{p.text}</p>
                <ul className="mt-5 space-y-2 text-sm">
                  {p.points.map((pt) => (
                    <li key={pt} className="flex items-start gap-2">
                      <span aria-hidden className={`mt-0.5 font-black ${p.card.includes('on-dark') ? 'text-zest-300' : 'text-brand-600'}`}>✓</span>
                      {pt}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/register"
                  className={`press mt-auto inline-flex items-center gap-1.5 self-start rounded-full pt-6 font-semibold underline-offset-4 hover:underline ${p.card.includes('on-dark') ? 'text-zest-300' : 'text-brand-700'}`}
                >
                  Register as {p.article} <span aria-hidden>→</span>
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="on-dark fl-night relative overflow-hidden rounded-[2rem] px-8 py-14 text-center text-white sm:px-14">
          <div className="fl-grid absolute inset-0" aria-hidden />
          <div className="relative">
            <h2 className="mx-auto max-w-2xl text-4xl font-extrabold sm:text-5xl">Have surplus tonight? Close the loop.</h2>
            <p className="mx-auto mt-4 max-w-xl text-stone-300">Organizations are verified before they can post or accept food, so every rescue starts from people you can trust.</p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link href="/register" className="press rounded-full bg-zest-300 px-6 py-3 font-bold text-stone-950 hover:bg-zest-200">Create an account</Link>
              <a href="#signin-h" className="press rounded-full border border-white/25 px-6 py-3 font-semibold text-white hover:bg-white/10">I already have one</a>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-stone-600">
          <Logo size={28} />
          <p>
            Rescuing surplus food, closing the loop · <Link href="/credits" className="underline underline-offset-2 hover:text-stone-900">Photo credits</Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
