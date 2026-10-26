import type { RescueStatus } from './rescue';

export type Bucket = 'active' | 'delayed' | 'failed' | 'completed' | 'cancelled';
export type DelayReason = 'BLOCKED_BY_INCIDENT' | 'PICKUP_WINDOW_CLOSED' | 'STAGE_BEHIND_SCHEDULE';

export interface BoardRescue {
  id: string;
  state: Bucket;
  status: RescueStatus;
  needsAdmin: boolean;
  transportMode: 'NGO_PICKUP' | 'RUNNER';
  listing: { id: string; title: string };
  /** Coarse (about 1 km) positions for the operations map; exact addresses stay on the rescue page. */
  area: { city: string | null; latitude: number | null; longitude: number | null };
  ngoArea: { latitude: number | null; longitude: number | null };
  provider: { id: string; name: string };
  ngo: { id: string; name: string };
  runner: { id: string; name: string } | null;
  servings: { offered: number; collected: number | null; delivered: number | null };
  stage: {
    status: RescueStatus;
    nextActor: 'provider' | 'ngo' | 'runner' | 'admin' | null;
    nextAction: string;
    deadline: { label: string; at: string; remainingMs: number } | null;
    startedAt: string | null;
    elapsedMs: number | null;
  };
  delay: { reason: DelayReason; text: string; overdueAction: string } | null;
  openIncidents: number;
  blocked: boolean;
  startedAt: string;
  ageMs: number;
  pickupWindow: { start: string; deadline: string };
  completedAt: string | null;
  closedAt: string | null;
  outcomeCode: string | null;
  links: { rescue: string; incidents: string | null };
}

export interface BoardPage {
  number: number;
  size: number;
  total: number;
  pages: number;
}

export interface BoardRescues {
  generatedAt: string;
  delayedRule: { elapsedPercent: number };
  counts: { active: number; delayed: number; failed: number; completed: number; cancelled: number; total: number; needsAdmin: number; blocked: number };
  page: BoardPage;
  rescues: BoardRescue[];
}

export type EscalationKind = 'NGO_WAVE' | 'RUNNER_WAVE' | 'ADMIN_ALERT';

export interface EscalationStepView {
  seq: number;
  kind: EscalationKind;
  radiusKm: number | null;
  dueAt: string;
  status: 'PENDING' | 'DONE' | 'SKIPPED' | 'CANCELLED';
  executedAt: string | null;
  qualified: number | null;
  newlyEligible: number | null;
  notifiedOrgs: number | null;
  notifiedUsers: number | null;
  reason: string | null;
}

export interface EscalationSummary {
  enabled: boolean;
  round: number | null;
  steps: EscalationStepView[];
  completed: number;
  total: number;
  current: EscalationStepView | null;
  next: EscalationStepView | null;
  adminAlerted: boolean;
  /** Why the remaining steps will never run (the listing was accepted, cancelled or expired). */
  stopped: string | null;
}

export interface EscalationHistory {
  listing: { id: string; title: string; status: string };
  enabled: boolean;
  rounds: {
    round: number;
    steps: (EscalationStepView & {
      recipients: { kind: 'NGO' | 'RUNNER'; position: number; distanceKm: number | null; organization?: { id: string; name: string }; runner?: { id: string; name: string } }[];
    })[];
  }[];
}

export const stepLabel = (s: { kind: EscalationKind; radiusKm: number | null; seq: number }) =>
  s.kind === 'NGO_WAVE' ? `NGO wave (within ${s.radiusKm} km)` : s.kind === 'RUNNER_WAVE' ? `Runner network (within ${s.radiusKm} km)` : 'Admin alert';

export const stepReasonLabels: Record<string, string> = {
  NO_QUALIFYING_NGO: 'No eligible NGO in range',
  NO_NEW_NGO: 'Everyone eligible had already been told',
  NO_QUALIFYING_RUNNER: 'No eligible, available runner in range',
  NO_NEW_RUNNER: 'Every eligible runner had already been told',
  NO_TRANSPORT_NEEDED: 'This listing needs no transport',
  NO_ADMINS: 'There is no active admin to alert',
  LISTING_ACCEPTED: 'An NGO accepted the listing',
  LISTING_CANCELLED: 'The provider cancelled the listing',
  LISTING_EXPIRED: 'The listing expired',
  LISTING_NOT_AVAILABLE: 'The listing was no longer open',
  DEADLINE_PASSED: 'The pickup deadline passed',
  LISTING_NO_COORDINATES: 'The listing has no coordinates',
  NOT_MATCHABLE: 'The listing could not be matched',
  LISTING_CLOSED: 'The listing was closed',
};

export interface BoardListing {
  id: string;
  title: string;
  foodCategory: string;
  servings: number;
  provider: { id: string; name: string };
  area: { city: string | null; latitude: number | null; longitude: number | null };
  transportRequired: boolean;
  status: string;
  actionable: boolean;
  urgency: 'NORMAL' | 'PRIORITY' | 'URGENT' | 'CRITICAL' | null;
  pickupStart: string;
  pickupDeadline: string;
  remainingMs: number | null;
  publishedAt: string | null;
  publishedAgoMs: number | null;
  closedAt: string | null;
  matching: { evaluated: number; eligibleNgos: number; notifiedNgos: number };
  flags: ('NO_ELIGIBLE_NGO' | 'NOT_YET_EVALUATED')[];
  escalation: EscalationSummary | null;
}

export interface BoardListings {
  generatedAt: string;
  scope: 'live' | 'closed';
  counts: { total: number; noEligibleNgo: number; byUrgency: Record<'CRITICAL' | 'URGENT' | 'PRIORITY' | 'NORMAL', number> };
  page: BoardPage;
  listings: BoardListing[];
}

export interface BoardOptions {
  organizations: { id: string; name: string; type: 'PROVIDER' | 'NGO' }[];
  runners: { id: string; name: string }[];
}

export interface BoardDetail {
  generatedAt: string;
  delayedRule: { elapsedPercent: number };
  rescue: BoardRescue;
  incidents: { id: string; category: string; severity: string; blocking: boolean; status: string; reportedAt: string; link: string }[];
  auditEvents: number;
}

export const bucketLabels: Record<Bucket, { label: string; icon: string; cls: string; hint: string }> = {
  active: { label: 'Active', icon: '▶', cls: 'border-blue-600 bg-blue-50 text-blue-900', hint: 'In progress and on schedule' },
  delayed: { label: 'Delayed', icon: '◔', cls: 'border-amber-600 bg-amber-50 text-amber-900', hint: 'In progress but behind schedule or blocked' },
  failed: { label: 'Failed', icon: '!', cls: 'border-red-600 bg-red-50 text-red-900', hint: 'Expired, pickup failed or delivery failed' },
  completed: { label: 'Completed', icon: '✓', cls: 'border-stone-900 bg-stone-900 text-white', hint: 'Recipient confirmed receipt' },
  cancelled: { label: 'Cancelled', icon: '✕', cls: 'border-stone-500 bg-stone-100 text-stone-800', hint: 'Cancelled or declined' },
};

export const actorLabels: Record<string, string> = { provider: 'Provider', ngo: 'NGO', runner: 'Runner', admin: 'Admin' };

/** "12 min", "3 h 5 min", "2 days": compact and exact enough for operations. */
export function durationText(ms: number): string {
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.round(h / 24)} days`;
}
