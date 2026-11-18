'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type Role } from '@/lib/api';
import { useLiveRefresh, type RescueSummary } from '@/lib/rescue';
import { RescueStatusBadge } from './RescueParts';
import { StageTrack } from './StageTrack';
import { fmtDateTime } from './SupplyParts';
import { Photo, Skeleton } from './ui';
import type { PhotoName } from '@/lib/photoCredits';

export const firstName = (name: string) => name.replace(/\(.*?\)/g, '').trim().split(/\s+/)[0] ?? name;

export function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** Dark band at the top of a workspace: welcome, organization/status line, and the main actions. */
export function Band({ photo, eyebrow, title, children, actions }: { photo: PhotoName; eyebrow: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <section className="on-dark relative isolate overflow-hidden rounded-2xl bg-stone-950 text-white shadow-card">
      <Photo name={photo} decorative className="absolute inset-0 -z-20 h-full w-full object-cover" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-stone-950/95 via-stone-950/80 to-stone-950/35" aria-hidden />
      <div className="flex flex-wrap items-end justify-between gap-4 px-5 py-5 md:px-7 md:py-6">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wider text-zest-200">{eyebrow}</p>
          <h2 className="mt-1 text-2xl font-bold md:text-3xl" style={{ fontFamily: 'var(--font-display)' }}>{title}</h2>
          {children && <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">{children}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </section>
  );
}

export function Kpi({ label, value, note, tone = 'plain', href }: { label: string; value: ReactNode; note?: string; tone?: 'plain' | 'hot' | 'ink'; href?: string }) {
  const body = (
    <div className={`lift h-full rounded-2xl border p-4 shadow-card ${tone === 'hot' ? 'border-orange-300 bg-orange-50' : tone === 'ink' ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-200 bg-white'}`}>
      <dd className="text-3xl font-bold tabular-nums md:text-4xl" style={{ fontFamily: 'var(--font-display)' }}>{value}</dd>
      <dt className={`mt-1 text-sm font-semibold ${tone === 'ink' ? 'text-stone-100' : 'text-stone-800'}`}>{label}</dt>
      {note && <p className={`mt-0.5 text-xs ${tone === 'ink' ? 'text-stone-300' : 'text-stone-600'}`}>{note}</p>}
    </div>
  );
  return href ? <Link href={href} className="block rounded-2xl">{body}</Link> : body;
}

export function KpiRow({ children, label }: { children: ReactNode; label: string }) {
  return <dl aria-label={label} className="stagger mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</dl>;
}

export function Panel({ title, id, action, children, className = '' }: { title: string; id: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={`rounded-2xl border border-stone-200 bg-white p-4 shadow-card md:p-5 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-lg font-bold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export const linkCls = 'text-sm font-semibold text-brand-700 underline underline-offset-2';

export function Loadingish() {
  return <div className="mt-3 space-y-2" aria-hidden><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
}

export function RescueRow({ r, role }: { r: RescueSummary; role: Role }) {
  const mine = r.nextAction.party === role;
  return (
    <li className={`lift rounded-xl border-2 p-3 ${mine ? 'border-brand-500 bg-brand-50' : 'border-stone-200 bg-white'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link href={`/${role}/rescues/${r.id}`} className="font-semibold text-stone-900 underline-offset-2 hover:underline">{r.listingTitle}</Link>
        <RescueStatusBadge status={r.status} />
      </div>
      <p className="mt-1 text-sm text-stone-700">{r.providerName} → {r.ngoName} · {r.servingsOffered} servings</p>
      <StageTrack status={r.status} compact />
      <p className="mt-2 text-sm">
        <strong>{mine ? 'Your next step: ' : `Waiting for ${r.nextAction.party ?? 'the system'}: `}</strong>
        {r.nextAction.text}
      </p>
      {mine && (
        <Link href={`/${role}/rescues/${r.id}`} className="mt-2 inline-flex min-h-10 items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Do this now</Link>
      )}
    </li>
  );
}

export interface Note {
  id: string;
  type: string;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
  actionable: boolean;
}

/** Notification texts carry raw ISO timestamps; show them as local dates. */
export const niceBody = (s: string) => s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, (iso) => fmtDateTime(iso));

export function noteHref(n: Note, role: Role): string | null {
  if (n.type === 'RUNNER_JOB' || n.type === 'LISTING_RUNNER_ALERT') return '/runner/jobs';
  if (n.type === 'ESCALATION_ADMIN') return '/admin/board';
  if (n.type === 'LISTING_MATCH') return role === 'ngo' ? '/ngo' : null;
  if ((n.entityType === 'RESCUE' || n.type === 'RESCUE_UPDATE') && n.entityId) return `/${role}/rescues/${n.entityId}`;
  return null;
}

export function useNotes() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ notifications: Note[] }>('/notifications');
    if (r.ok) setNotes(r.data.notifications);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), 30_000);
  return notes;
}

export function ActivityList({ notes, role, limit = 5 }: { notes: Note[] | null; role: Role; limit?: number }) {
  if (!notes) return <Loadingish />;
  if (notes.length === 0) return <p className="mt-3 text-sm text-stone-700">No activity yet.</p>;
  return (
    <ol className="mt-3 space-y-3 border-l-2 border-stone-200 pl-4">
      {notes.slice(0, limit).map((n) => {
        const href = noteHref(n, role);
        return (
          <li key={n.id} className="text-sm">
            <p className="font-semibold">{href ? <Link href={href} className="underline-offset-2 hover:underline">{n.title}</Link> : n.title}</p>
            <p className="text-stone-700">{niceBody(n.body)}</p>
            <p className="text-xs text-stone-600">{fmtDateTime(n.createdAt)}</p>
          </li>
        );
      })}
    </ol>
  );
}

/** Segmented list/map switch for small screens (both panes show side by side from lg up). */
export function ViewSwitch({ value, onChange, labels = ['List', 'Map'] }: { value: 'list' | 'map'; onChange: (v: 'list' | 'map') => void; labels?: [string, string] }) {
  return (
    <div role="tablist" aria-label="View" className="mt-4 inline-flex rounded-xl border border-stone-300 bg-white p-0.5 lg:hidden">
      {(['list', 'map'] as const).map((v, i) => (
        <button key={v} role="tab" aria-selected={value === v} onClick={() => onChange(v)} className={`min-h-10 rounded-lg px-5 py-1.5 text-sm font-semibold ${value === v ? 'bg-brand-600 text-white' : 'hover:bg-stone-100'}`}>{labels[i]}</button>
      ))}
    </div>
  );
}
