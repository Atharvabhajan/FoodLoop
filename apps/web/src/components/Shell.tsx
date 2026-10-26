'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, homePathFor, type Role, type User, type VerificationStatus } from '@/lib/api';
import { useLiveRefresh } from '@/lib/rescue';
import { useAuth } from '@/lib/auth';
import { Logo } from './Logo';
import { Avatar, Spinner } from './ui';

// Distinct border style + glyph + text per state, so it never relies on colour alone.
const statusStyles: Record<VerificationStatus, { label: string; icon: string; cls: string }> = {
  UNSUBMITTED: { label: 'Draft - not submitted', icon: '✎', cls: 'border-dashed border-stone-500 bg-stone-100 text-stone-800' },
  UNDER_REVIEW: { label: 'Pending review', icon: '◔', cls: 'border-amber-600 bg-amber-50 text-amber-900' },
  VERIFIED: { label: 'Verified', icon: '✓', cls: 'border-stone-900 bg-stone-900 text-white' },
  REJECTED: { label: 'Rejected', icon: '✕', cls: 'border-2 border-red-700 bg-red-50 text-red-900' },
  RESUBMISSION_REQUESTED: { label: 'Resubmission required', icon: '↻', cls: 'border-saffron-600 bg-saffron-50 text-saffron-700' },
};

/** Status is conveyed by an icon and text, never by color alone. */
export function StatusBadge({ status }: { status: VerificationStatus }) {
  const s = statusStyles[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-semibold ${s.cls}`}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

/** Redirects anonymous users to sign-in and users of another role to their own home. */
export function useRoleGuard(roles: Role[]): User | null {
  const { status, user } = useAuth();
  const router = useRouter();
  const allowed = status === 'authenticated' && !!user && roles.includes(user.platformRole);
  useEffect(() => {
    if (status === 'anonymous' || status === 'unavailable') router.replace('/');
    else if (status === 'authenticated' && user && !roles.includes(user.platformRole)) {
      router.replace(homePathFor(user.platformRole));
    }
  }, [status, user, router]);
  return allowed ? user : null;
}

/** Avatar button with a small menu: profile, organization or availability, notifications, sign out. Escape and outside press close it. */
function AccountMenu({ user, roleLabel, onSignOut }: { user: User; roleLabel: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPress = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress);
    };
  }, [open]);
  const second =
    user.platformRole === 'runner' ? { href: '/runner/profile', label: 'Transport and availability' } : user.platformRole === 'admin' ? null : { href: '/organization', label: 'My organization' };
  const item = 'block rounded-lg px-3 py-2 text-sm font-medium text-stone-900 hover:bg-saffron-50';
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${user.name}`}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full border border-white/30 py-1 pl-1 pr-3 text-sm hover:bg-white/10"
      >
        <Avatar name={user.name} size={30} />
        <span className="max-w-40 truncate text-stone-100">{user.name}</span>
        <span aria-hidden className="text-xs text-saffron-200">▾</span>
      </button>
      {open && (
        <div role="menu" className="fl-appear absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-stone-200 bg-white p-2 text-stone-900 shadow-lift">
          <div className="flex items-center gap-3 border-b border-stone-200 px-3 pb-2 pt-1">
            <Avatar name={user.name} size={40} />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{user.name}</p>
              <span className="inline-block rounded-full bg-saffron-300 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-stone-950">{roleLabel}</span>
            </div>
          </div>
          <Link role="menuitem" href="/profile" onClick={() => setOpen(false)} className={`${item} mt-1`}>Your profile</Link>
          {second && <Link role="menuitem" href={second.href} onClick={() => setOpen(false)} className={item}>{second.label}</Link>}
          <Link role="menuitem" href="/notifications" onClick={() => setOpen(false)} className={item}>Notifications</Link>
          <button role="menuitem" type="button" onClick={onSignOut} className={`${item} w-full text-left`}>Sign out</button>
        </div>
      )}
    </div>
  );
}

export function Shell({ user, title, children, wide = false, hideTitle = false }: { user: User; title: string; children: ReactNode; wide?: boolean; hideTitle?: boolean }) {
  const maxW = wide ? 'max-w-[90rem]' : 'max-w-6xl';
  const { logout } = useAuth();
  const router = useRouter();
  const links: { href: string; label: string }[] = [{ href: homePathFor(user.platformRole), label: 'Home' }];
  if (user.platformRole === 'provider' || user.platformRole === 'ngo') links.push({ href: '/organization', label: 'Organization' });
  if (user.platformRole === 'provider') links.push({ href: '/provider/listings', label: 'Listings' }, { href: '/provider/rescues', label: 'Rescues' }, { href: '/provider/impact', label: 'Impact' });
  if (user.platformRole === 'ngo') links.push({ href: '/ngo/requirements', label: 'Needs' }, { href: '/ngo/listings', label: 'Live food' }, { href: '/ngo/rescues', label: 'Rescues' }, { href: '/ngo/impact', label: 'Impact' });
  if (user.platformRole === 'runner') links.push({ href: '/runner/jobs', label: 'Available jobs' }, { href: '/runner/rescues', label: 'My rescues' }, { href: '/runner/impact', label: 'Impact' }, { href: '/runner/profile', label: 'Availability' });
  if (user.platformRole === 'admin') links.push({ href: '/admin/board', label: 'Operations' }, { href: '/admin/verifications', label: 'Verification queue' }, { href: '/admin/rescues', label: 'Rescues' }, { href: '/admin/incidents', label: 'Incidents' }, { href: '/admin/impact', label: 'Impact' });
  const [unread, setUnread] = useState(0);
  const loadUnread = useCallback(async () => {
    const res = await api<{ unreadCount: number }>('/notifications');
    if (res.ok) setUnread(res.data.unreadCount);
  }, []);
  useEffect(() => {
    void loadUnread();
  }, [loadUnread]);
  useLiveRefresh(() => void loadUnread(), 60_000);
  links.push({ href: '/notifications', label: unread > 0 ? `Notifications (${unread})` : 'Notifications' }, { href: '/profile', label: 'Profile' });

  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setMenuOpen(false), [pathname]);
  // The mobile menu closes on Escape (focus returns to its button) and on a press outside the header.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      toggleRef.current?.focus();
    };
    const onPress = (e: Event) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress);
    };
  }, [menuOpen]);
  const isActive = (href: string) => (href === homePathFor(user.platformRole) ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));
  const roleLabel: Record<Role, string> = { provider: 'Food provider', ngo: 'NGO', runner: 'Runner', admin: 'Admin' };
  const signOut = () => void logout().then(() => router.replace('/'));

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="skip-link">Skip to main content</a>
      <header ref={headerRef} className="on-dark sticky top-0 z-40 bg-stone-950 text-white shadow-md">
        <div className={`mx-auto flex ${maxW} items-center justify-between gap-4 px-4 py-2.5`}>
          <Link href={homePathFor(user.platformRole)} aria-label="FoodLoop home" className="shrink-0">
            <Logo size={34} tone="light" />
          </Link>
          <button
            ref={toggleRef}
            type="button"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-white/40 px-3 py-2 text-sm font-semibold hover:bg-white/10 md:hidden"
            aria-expanded={menuOpen}
            aria-controls="main-nav"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span aria-hidden className="text-base leading-none">{menuOpen ? '✕' : '☰'}</span>
            {menuOpen ? 'Close menu' : 'Menu'}
          </button>
          <div className="hidden items-center gap-3 text-sm md:flex">
            <span className="rounded-full bg-saffron-300 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-stone-950">{roleLabel[user.platformRole]}</span>
            <AccountMenu user={user} roleLabel={roleLabel[user.platformRole]} onSignOut={signOut} />
            <button onClick={signOut} className="rounded-lg border border-white/40 px-3 py-1.5 font-semibold hover:bg-white/10">Sign out</button>
          </div>
        </div>
        <div className="menu-panel border-t border-white/10 bg-stone-900" data-open={menuOpen}>
          <div>
            <nav aria-label="Main" id="main-nav">
              <ul className={`mx-auto flex ${maxW} flex-col gap-0.5 px-2 py-2 md:flex-row md:flex-wrap md:px-3 md:py-0`}>
                {links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      aria-current={isActive(l.href) ? 'page' : undefined}
                      className={`block rounded-lg px-3 py-3 text-sm font-medium md:rounded-none md:border-b-4 md:py-2.5 ${
                        isActive(l.href) ? 'bg-white/10 text-white md:border-saffron-300 md:bg-transparent' : 'text-stone-100 hover:bg-white/10 md:border-transparent md:hover:border-white/30 md:hover:bg-transparent'
                      }`}
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
                <li className="md:hidden">
                  <span className="flex items-center gap-2 px-3 pt-2 text-sm text-stone-100"><Avatar name={user.name} size={28} />{user.name}</span>
                  <span className="block px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-saffron-200">{roleLabel[user.platformRole]}</span>
                  <button onClick={signOut} className="block w-full rounded-lg px-3 py-3 text-left text-sm font-medium text-stone-100 hover:bg-white/10">
                    Sign out ({user.name})
                  </button>
                </li>
              </ul>
            </nav>
          </div>
        </div>
      </header>
      <main id="main" className={`fl-page mx-auto w-full ${maxW} flex-1 px-4 py-4 md:py-6`}>
        <h1 className={hideTitle ? 'sr-only' : 'text-3xl font-bold text-stone-900 md:text-4xl'}>{title}</h1>
        {children}
      </main>
      <footer className="border-t border-stone-200 bg-stone-100 py-4 text-center text-xs text-stone-600">
        FoodLoop · rescuing surplus food, closing the loop · <Link href="/credits" className="underline underline-offset-2">Photo credits</Link>
      </footer>
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <Spinner label={label} />;
}
