'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, type Role, type VerificationStatus } from '@/lib/api';
import { Loading, Shell, StatusBadge, useRoleGuard } from './Shell';
import { CountUp, FormError, Photo } from './ui';
import { Today } from './Today';
import type { ImpactResponse } from '@/lib/impact';
import type { PhotoName } from '@/lib/photoCredits';

const titles: Record<Role, string> = {
  provider: 'Food Provider home',
  ngo: 'NGO home',
  runner: 'Rescue Runner home',
  admin: 'Admin home',
};

const banner: Record<Role, { photo: PhotoName; line: string }> = {
  provider: { photo: 'provider-kitchen', line: 'Turn today\u2019s surplus into tonight\u2019s meals.' },
  ngo: { photo: 'volunteers-serving', line: 'Fresh food, close by, ready for the people you serve.' },
  runner: { photo: 'volunteer-handoff', line: 'Every delivery you finish puts a meal on a plate.' },
  admin: { photo: 'hero-handover', line: 'Keep every rescue moving and every organization verified.' },
};

function Tile({ href, title, text, cta, primary = false }: { href: string; title: string; text: string; cta: string; primary?: boolean }) {
  return (
    <section className={`lift flex flex-col rounded-2xl border p-5 shadow-card ${primary ? 'border-paprika-300 bg-paprika-50' : 'border-stone-200 bg-white'}`}>
      <h2 className="text-lg font-bold text-stone-900">{title}</h2>
      <p className="mt-1 flex-1 text-sm text-stone-700">{text}</p>
      <Link href={href} className={`mt-4 inline-flex min-h-11 items-center justify-center self-start rounded-lg px-4 py-2 text-sm font-semibold ${primary ? 'bg-paprika-600 text-white hover:bg-paprika-700' : 'border border-paprika-600 text-paprika-700 hover:bg-paprika-50'}`}>
        {cta}
      </Link>
    </section>
  );
}

type Check = { state: 'checking' } | { state: 'ok' } | { state: 'failed'; message: string };

export function RolePage({ role }: { role: Role }) {
  const user = useRoleGuard([role]);
  const router = useRouter();
  const [check, setCheck] = useState<Check>({ state: 'checking' });
  const [orgStatus, setOrgStatus] = useState<{ name: string; status: VerificationStatus } | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [impact, setImpact] = useState<ImpactResponse | null>(null);

  const allowed = !!user;

  // The page asks the server to confirm access; the UI does not trust itself.
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    api(`/access/${role}`).then((res) => {
      if (cancelled) return;
      if (res.ok) setCheck({ state: 'ok' });
      else {
        if (res.error.status === 401) router.replace('/');
        setCheck({ state: 'failed', message: res.error.message });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [allowed, role, router]);

  // Current organization status (fresh from the server; /auth/me can be stale after a decision).
  useEffect(() => {
    if (!allowed) return;
    if (role === 'provider' || role === 'ngo') {
      api<{ organizations: { name: string; verificationStatus: VerificationStatus }[] }>('/organizations').then((res) => {
        const o = res.ok ? res.data.organizations.find((x) => x.verificationStatus !== 'REJECTED') ?? res.data.organizations[0] : undefined;
        setOrgStatus(o ? { name: o.name, status: o.verificationStatus } : null);
      });
    } else if (role === 'admin') {
      api<{ organizations: unknown[] }>('/admin/verifications').then((res) => setPending(res.ok ? res.data.organizations.length : null));
    }
  }, [allowed, role]);

  // Headline numbers come straight from the impact endpoint (completed rescues only).
  useEffect(() => {
    if (!allowed) return;
    api<ImpactResponse>(role === 'admin' ? '/impact/platform' : '/impact/me').then((res) => setImpact(res.ok ? res.data : null));
  }, [allowed, role]);

  if (!user) return <Loading label="Restoring your session…" />;

  const b = banner[role];
  return (
    <Shell user={user} title={titles[role]}>
      <section className="on-dark relative isolate mt-4 overflow-hidden rounded-2xl bg-stone-950 text-white">
        <Photo name={b.photo} decorative className="absolute inset-0 -z-20 h-full w-full object-cover" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-stone-950/90 via-stone-950/60 to-stone-950/5" aria-hidden />
        <div className="px-6 py-8 md:py-10">
          <p className="text-sm font-semibold uppercase tracking-wider text-saffron-200">Welcome back, {user.name}</p>
          <p className="mt-2 max-w-xl text-2xl font-bold md:text-3xl" style={{ fontFamily: 'var(--font-display)' }}>{b.line}</p>
          {impact && (
            <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-2" aria-label="Your impact so far">
              <div><dd className="text-3xl font-bold tabular-nums"><CountUp value={impact.metrics.completedRescues} /></dd><dt className="text-sm text-stone-100">Completed rescues</dt></div>
              <div><dd className="text-3xl font-bold tabular-nums"><CountUp value={impact.metrics.servingsDelivered} /></dd><dt className="text-sm text-stone-100">Servings delivered</dt></div>
            </dl>
          )}
        </div>
      </section>

      <Today role={role} />

      <h2 className="mt-8 text-xl font-bold">Shortcuts</h2>
      <div className="stagger mt-3 grid gap-5 md:grid-cols-2">
        {(role === 'provider' || role === 'ngo') && (
          <section className="lift rounded-2xl border border-stone-200 bg-white p-5 shadow-card" aria-labelledby="org-h">
            <h2 id="org-h" className="text-lg font-bold text-stone-900">Your organization</h2>
            {orgStatus ? (
              <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold">{orgStatus.name}</span> <StatusBadge status={orgStatus.status} />
              </p>
            ) : (
              <p className="mt-2 text-sm text-stone-700">No organization profile yet.</p>
            )}
            <Link href="/organization" className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-paprika-600 px-4 py-2 text-sm font-semibold text-white hover:bg-paprika-700">
              {orgStatus?.status === 'VERIFIED' ? 'View organization' : 'Manage profile and verification'}
            </Link>
          </section>
        )}

        {role === 'provider' && <Tile primary href="/provider/listings" title="Surplus food listings" text="Draft, publish and cancel time-limited listings. Publishing needs a verified organization." cta="Manage listings" />}
        {role === 'ngo' && (
          <>
            <Tile primary href="/ngo/listings" title="Live food near you" text="Browse live surplus with urgency, distance and the reasons it matches your needs." cta="Browse live food" />
            <Tile href="/ngo/requirements" title="Food needs and capacity" text="Set what you can receive, pause intake, and set your availability window." cta="Food needs and capacity" />
          </>
        )}
        {role === 'runner' && (
          <>
            <Tile primary href="/runner/jobs" title="Rescue jobs" text="Nearby jobs you can finish in time. Exact addresses are shared only after you accept." cta="Available jobs" />
            <Tile href="/runner/rescues" title="My rescues" text="Your active and past deliveries, with the next action up front." cta="My rescues" />
            <Tile href="/runner/profile" title="Availability and profile" text="Set your vehicle, capacity and base area so you only see jobs you can do." cta="Availability and profile" />
          </>
        )}
        {role === 'admin' && (
          <>
            <Tile primary href="/admin/board" title="Live operations board" text="Active, delayed, failed and completed rescues with the next responsible party, plus live listings nobody has accepted yet." cta="Open the board" />
            <Tile href="/admin/incidents" title="Incidents" text="Review problems reported on rescues, pause or resume them, and record how each one was resolved." cta="Open incidents" />
            <Tile href="/admin/verifications" title="Organization verification" text={pending === null ? 'Checking the queue…' : pending === 0 ? 'No applications are waiting for review.' : `${pending} application${pending === 1 ? '' : 's'} waiting for review.`} cta="Open verification queue" />
          </>
        )}
        {(role === 'provider' || role === 'ngo' || role === 'admin') && (
          <Tile href={`/${role}/rescues`} title="Rescues" text={role === 'ngo' ? 'Track food you have accepted, verify pickup and confirm receipt.' : role === 'provider' ? 'Confirm hand-offs, share the pickup code and follow each rescue.' : 'Oversee rescues and resolve any that need follow-up.'} cta="Open rescues" />
        )}
        <Tile
          href={`/${role}/impact`}
          title="Impact"
          text={role === 'admin' ? 'Platform-wide totals from completed rescues.' : role === 'runner' ? 'Your completed deliveries and the servings they carried.' : role === 'ngo' ? 'Rescues completed for your organization and the servings you received.' : 'Rescues completed from your listings and the servings recipients received.'}
          cta="View impact"
        />
      </div>

      <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-5" aria-labelledby="who">
        <h2 id="who" className="text-lg font-bold text-stone-900">Signed in as</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-stone-600">Name</dt><dd>{user.name}</dd>
          <dt className="text-stone-600">Email</dt><dd className="break-all">{user.email}</dd>
          <dt className="text-stone-600">Role</dt><dd>{user.platformRole}</dd>
        </dl>
        <p className="mt-3 text-sm" role="status">
          {check.state === 'checking' && 'Confirming access with the server…'}
          {check.state === 'ok' && '✓ Server confirmed this role can access this area.'}
        </p>
        {check.state === 'failed' && <FormError message={check.message} />}
      </section>
    </Shell>
  );
}
