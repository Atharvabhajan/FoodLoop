export interface ImpactPeriod {
  from: string | null;
  to: string | null;
  timeZone: 'UTC';
  basis: string;
}

export interface TransportSplit {
  directPickup: { rescues: number; servings: number };
  runnerAssisted: { rescues: number; servings: number };
}

export interface ImpactResponse {
  period: ImpactPeriod;
  scope: { type: 'organization'; organizations: { id: string; name: string }[] } | { type: 'runner' } | { type: 'platform' };
  metrics: {
    completedRescues: number;
    servingsDelivered: number;
    byTransport?: TransportSplit;
    recipientOrganizations?: number;
    providerOrganizations?: number;
    ngoOrganizations?: number;
    runners?: number;
  };
  byMonth: { month: string; rescues: number; servings: number }[];
  definitions: Record<string, string>;
  unavailable: { metric: string; reason: string }[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Quick ranges, computed in UTC to match how the server buckets completion times. */
export function presetRange(preset: 'all' | 'month' | '30d' | '90d', now = new Date()): { from: string; to: string } {
  if (preset === 'all') return { from: '', to: '' };
  const today = iso(now);
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  const days = preset === '30d' ? 29 : 89; // inclusive of today
  return { from: iso(new Date(now.getTime() - days * 86_400_000)), to: today };
}

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function periodLabel(p: { from: string | null; to: string | null }): string {
  if (!p.from && !p.to) return 'All time';
  if (p.from && p.to) return p.from === p.to ? fmt(p.from) : `${fmt(p.from)} to ${fmt(p.to)}`;
  return p.from ? `From ${fmt(p.from)}` : `Up to ${fmt(p.to!)}`;
}

export const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
