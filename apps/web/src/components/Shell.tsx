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
    user.platformRole === 'runner' ? { href: '/profile#transport', label: 'Transport and availability' } : user.platformRole === 'admin' ? null : { href: '/profile#organization', label: 'My organization' };
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

function BellIcon() {
  return (
    <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/** Same width for header, page header and content on every screen. */
export const PAGE_W = 'max-w-[88rem]';

export interface PageHeaderProps {
  /** Short line above the title (section name). */
  eyebrow?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  /** Extra content under the title row (tabs, chips, summary). */
  below?: ReactNode;
}

/** The one page header used by every inner page: back link, eyebrow, serif title, subtitle and actions. */
export function PageHeader({ title, eyebrow, subtitle, actions, back, below }: PageHeaderProps & { title: string }) {
  return (
    <header className="mb-5 border-b border-stone-200 pb-4 md:mb-6">
      {back && (
        <Link href={back.href} className="inline-flex items-center gap-1 text-sm font-semibold text-paprika-700 underline-offset-4 hover:underline">
          <span aria-hidden>←</span> {back.label}
        </Link>
      )}
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && <p className="text-xs font-bold uppercase tracking-wider text-paprika-700">{eyebrow}</p>}
          <h1 className="text-3xl font-bold text-stone-900 md:text-4xl">{title}</h1>
          {subtitle && <div className="mt-1 max-w-3xl text-sm text-stone-700 md:text-base">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {below && <div className="mt-3">{below}</div>}
    </header>
  );
}

export function Shell({ user, title, children, hideTitle = false, eyebrow, subtitle, actions, back, below }: { user: User; title: string; children: ReactNode; wide?: boolean; hideTitle?: boolean } & PageHeaderProps) {
  const { logout } = useAuth();
  const router = useRouter();
  const home = homePathFor(user.platformRole);
  const links: { href: string; label: string }[] = [{ href: home, label: 'Dashboard' }];
  if (user.platformRole === 'provider') links.push({ href: '/provider/listings', label: 'Listings' }, { href: '/provider/rescues', label: 'Rescues' }, { href: '/provider/impact', label: 'Impact' });
  if (user.platformRole === 'ngo') links.push({ href: '/ngo/listings', label: 'Live food' }, { href: '/ngo/rescues', label: 'Rescues' }, { href: '/ngo/impact', label: 'Impact' });
  if (user.platformRole === 'runner') links.push({ href: '/runner/jobs', label: 'Available jobs' }, { href: '/runner/rescues', label: 'My rescues' }, { href: '/runner/impact', label: 'Impact' });
  if (user.platformRole === 'admin') links.push({ href: '/admin/board', label: 'Operations' }, { href: '/admin/rescues', label: 'Rescues' }, { href: '/admin/incidents', label: 'Incidents' }, { href: '/admin/verifications', label: 'Verification queue' }, { href: '/admin/impact', label: 'Impact' });
  const [unread, setUnread] = useState(0);
  const loadUnread = useCallback(async () => {
    const res = await api<{ unreadCount: number }>('/notifications');
    if (res.ok) setUnread(res.data.unreadCount);
  }, []);
  useEffect(() => {
    void loadUnread();
  }, [loadUnread]);
  useLiveRefresh(() => void loadUnread(), 60_000);

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
  const isActive = (href: string) => (href === home ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));
  const roleLabel: Record<Role, string> = { provider: 'Food provider', ngo: 'NGO', runner: 'Runner', admin: 'Admin' };
  const signOut = () => void logout().then(() => router.replace('/'));
  const notifActive = pathname === '/notifications';

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="skip-link">Skip to main content</a>
      <header ref={headerRef} className="on-dark sticky top-0 z-40 bg-stone-950 text-white shadow-md">
        <div className={`mx-auto flex ${PAGE_W} items-center gap-3 px-4 py-2`}>
          <Link href={home} aria-label="FoodLoop home" className="mr-2 shrink-0">
            <Logo size={32} tone="light" />
          </Link>
          <nav aria-label="Main" className="hidden flex-1 md:block">
            <ul className="flex flex-wrap items-center gap-1">
              {links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    aria-current={isActive(l.href) ? 'page' : undefined}
                    className={`block rounded-full px-3.5 py-2 text-sm font-semibold ${isActive(l.href) ? 'bg-saffron-300 text-stone-950' : 'text-stone-100 hover:bg-white/10'}`}
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-1 md:ml-0">
            <Link
              href="/notifications"
              aria-current={notifActive ? 'page' : undefined}
              aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
              className={`relative inline-flex h-11 w-11 items-center justify-center rounded-full ${notifActive ? 'bg-white/15 text-white' : 'text-stone-100 hover:bg-white/10'}`}
            >
              <BellIcon />
              {unread > 0 && <span aria-hidden className="absolute right-1 top-1 min-w-5 rounded-full bg-saffron-300 px-1 text-center text-[11px] font-bold leading-5 text-stone-950">{unread > 99 ? '99+' : unread}</span>}
            </Link>
            <div className="hidden items-center gap-2 md:flex">
              <AccountMenu user={user} roleLabel={roleLabel[user.platformRole]} onSignOut={signOut} />
              <button onClick={signOut} className="rounded-lg border border-white/30 px-3 py-1.5 text-sm font-semibold hover:bg-white/10">Sign out</button>
            </div>
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
          </div>
        </div>
        <div className="menu-panel border-t border-white/10 bg-stone-900 md:hidden" data-open={menuOpen}>
          <div>
            <nav aria-label="Main menu" id="main-nav">
              <div className="flex items-center gap-3 px-4 pb-1 pt-3">
                <Avatar name={user.name} size={36} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{user.name}</p>
                  <p className="text-xs font-semibold uppercase tracking-wide text-saffron-200">{roleLabel[user.platformRole]}</p>
                </div>
              </div>
              <ul className="flex flex-col gap-0.5 px-2 py-2">
                {[...links, { href: '/notifications', label: unread > 0 ? `Notifications (${unread})` : 'Notifications' }, { href: '/profile', label: 'Profile' }].map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      aria-current={isActive(l.href) ? 'page' : undefined}
                      className={`block rounded-lg px-3 py-3 text-sm font-semibold ${isActive(l.href) ? 'bg-saffron-300 text-stone-950' : 'text-stone-100 hover:bg-white/10'}`}
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
                <li>
                  <button onClick={signOut} className="block w-full rounded-lg px-3 py-3 text-left text-sm font-semibold text-stone-100 hover:bg-white/10">
                    Sign out
                  </button>
                </li>
              </ul>
            </nav>
          </div>
        </div>
      </header>
      <main id="main" className={`fl-page mx-auto w-full ${PAGE_W} flex-1 px-4 py-5 md:py-7`}>
        {hideTitle ? <h1 className="sr-only">{title}</h1> : <PageHeader title={title} eyebrow={eyebrow} subtitle={subtitle} actions={actions} back={back} below={below} />}
        {children}
      </main>
      <footer className="border-t border-stone-200 bg-stone-100">
        <div className={`mx-auto flex ${PAGE_W} flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-stone-600`}>
          <span className="inline-flex items-center gap-2"><Logo size={20} /> Rescuing surplus food, closing the loop.</span>
          <span>Distances are straight-line estimates · <Link href="/credits" className="underline underline-offset-2">Photo credits</Link></span>
        </div>
      </footer>
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <Spinner label={label} />;
}
