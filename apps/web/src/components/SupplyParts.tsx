'use client';

import { useEffect, useState } from 'react';
import { timeLeftText, urgencyLabels, type ListingStatus, type Urgency } from '@/lib/supply';

const statusStyles: Record<ListingStatus, { label: string; icon: string; cls: string }> = {
  DRAFT: { label: 'Draft', icon: '✎', cls: 'border-stone-400 bg-stone-100 text-stone-800' },
  AVAILABLE: { label: 'Available', icon: '●', cls: 'border-zest-600 bg-zest-100 text-stone-900' },
  CANCELLED: { label: 'Cancelled', icon: '✕', cls: 'border-red-600 bg-red-50 text-red-900' },
  EXPIRED: { label: 'Expired', icon: '◷', cls: 'border-stone-500 bg-stone-200 text-stone-800' },
  RESERVED: { label: 'Reserved by an NGO', icon: '◼', cls: 'border-sky-700 bg-sky-50 text-sky-900' },
  COLLECTED: { label: 'Collected', icon: '✓', cls: 'border-stone-900 bg-stone-900 text-white' },
};

/** Status is shown as an icon plus text, never color alone. */
export function ListingStatusBadge({ status }: { status: ListingStatus }) {
  const s = statusStyles[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-semibold ${s.cls}`}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

/** Re-renders every 30 s so the countdown stays honest without a refresh. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function TimeLeft({ deadline, urgency }: { deadline: string; urgency?: Urgency | null }) {
  const now = useNow();
  const text = timeLeftText(deadline, now);
  const expired = text === 'Expired';
  return (
    <span className="font-medium">
      {!expired && urgency && urgency !== 'EXPIRED' ? `${urgencyLabels[urgency]} · ` : ''}
      {text}
    </span>
  );
}

export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '-';
