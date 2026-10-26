import type { RescueSettings } from '../../config.js';
import type { RescueStatus, TransportMode } from '../../db/schema.js';

/**
 * Rescue lifecycle. Names follow the specification's state machine (section 7).
 *
 * Direct NGO pickup (Phase 5, unchanged):
 *   RESERVED ──provider confirms──▶ PICKUP_ASSIGNED ──NGO verifies code──▶ PICKUP_CONFIRMED ──NGO confirms──▶ RECIPIENT_CONFIRMED ─▶ COMPLETED
 *
 * Runner-assisted (Phase 6, only when the NGO asked for a runner on a listing that requests transport):
 *   RESERVED ──provider confirms──▶ AWAITING_RUNNER ──runner accepts──▶ PICKUP_ASSIGNED
 *       PICKUP_ASSIGNED ──runner verifies code──▶ PICKUP_CONFIRMED ─(same step)─▶ IN_TRANSIT
 *       IN_TRANSIT ──runner hands over──▶ DELIVERED ──NGO confirms quantity──▶ RECIPIENT_CONFIRMED ─(system)─▶ COMPLETED
 *   AWAITING_RUNNER ◀── runner releases / admin reassigns ── PICKUP_ASSIGNED        (the search restarts)
 *   AWAITING_RUNNER ──NGO collects it itself──▶ PICKUP_ASSIGNED                      (falls back to direct pickup)
 *   AWAITING_RUNNER ──no runner in time──▶ EXPIRED                                   (listing released)
 *
 * Failures: pickup not verified in time ─▶ PICKUP_FAILED; transit/handover/receipt overdue, or an admin marking custody
 * lost ─▶ DELIVERY_FAILED, which only an admin resolves (with a reason). A runner can never complete a rescue: completion
 * needs the NGO's receipt confirmation or an explicit admin resolution.
 */
export type RescueCommand =
  | 'PROVIDER_CONFIRM'
  | 'PROVIDER_CONFIRM_RUNNER'
  | 'PROVIDER_REJECT'
  | 'PROVIDER_CANCEL'
  | 'NGO_CANCEL'
  | 'ADMIN_CANCEL'
  | 'RUNNER_ACCEPT'
  | 'RUNNER_RELEASE'
  | 'ADMIN_REASSIGN'
  | 'SWITCH_TO_SELF'
  | 'VERIFY_PICKUP'
  | 'START_TRANSIT'
  | 'RUNNER_HANDOVER'
  | 'CONFIRM_DELIVERY'
  | 'COMPLETE'
  | 'ADMIN_RESOLVE'
  | 'ADMIN_FAIL'
  | 'EXPIRE_CONFIRMATION'
  | 'EXPIRE_RUNNER_SEARCH'
  | 'EXPIRE_PICKUP'
  | 'EXPIRE_TRANSIT'
  | 'EXPIRE_DELIVERY';

const transitions: Record<RescueCommand, Partial<Record<RescueStatus, RescueStatus>>> = {
  PROVIDER_CONFIRM: { RESERVED: 'PICKUP_ASSIGNED' },
  PROVIDER_CONFIRM_RUNNER: { RESERVED: 'AWAITING_RUNNER' },
  PROVIDER_REJECT: { RESERVED: 'CANCELLED' },
  PROVIDER_CANCEL: { RESERVED: 'CANCELLED', AWAITING_RUNNER: 'CANCELLED', PICKUP_ASSIGNED: 'CANCELLED' },
  NGO_CANCEL: { RESERVED: 'CANCELLED', AWAITING_RUNNER: 'CANCELLED', PICKUP_ASSIGNED: 'CANCELLED' },
  ADMIN_CANCEL: { RESERVED: 'CANCELLED', AWAITING_RUNNER: 'CANCELLED', PICKUP_ASSIGNED: 'CANCELLED' },
  RUNNER_ACCEPT: { AWAITING_RUNNER: 'PICKUP_ASSIGNED' },
  RUNNER_RELEASE: { PICKUP_ASSIGNED: 'AWAITING_RUNNER' },
  ADMIN_REASSIGN: { PICKUP_ASSIGNED: 'AWAITING_RUNNER' },
  SWITCH_TO_SELF: { AWAITING_RUNNER: 'PICKUP_ASSIGNED' },
  VERIFY_PICKUP: { PICKUP_ASSIGNED: 'PICKUP_CONFIRMED' },
  START_TRANSIT: { PICKUP_CONFIRMED: 'IN_TRANSIT' },
  RUNNER_HANDOVER: { IN_TRANSIT: 'DELIVERED' },
  CONFIRM_DELIVERY: { PICKUP_CONFIRMED: 'RECIPIENT_CONFIRMED', DELIVERED: 'RECIPIENT_CONFIRMED' },
  COMPLETE: { RECIPIENT_CONFIRMED: 'COMPLETED' },
  ADMIN_RESOLVE: { PICKUP_CONFIRMED: 'COMPLETED', IN_TRANSIT: 'COMPLETED', DELIVERED: 'COMPLETED', DELIVERY_FAILED: 'COMPLETED' },
  ADMIN_FAIL: { PICKUP_CONFIRMED: 'DELIVERY_FAILED', IN_TRANSIT: 'DELIVERY_FAILED', DELIVERED: 'DELIVERY_FAILED' },
  EXPIRE_CONFIRMATION: { RESERVED: 'EXPIRED' },
  EXPIRE_RUNNER_SEARCH: { AWAITING_RUNNER: 'EXPIRED' },
  EXPIRE_PICKUP: { PICKUP_ASSIGNED: 'PICKUP_FAILED' },
  EXPIRE_TRANSIT: { IN_TRANSIT: 'DELIVERY_FAILED' },
  EXPIRE_DELIVERY: { PICKUP_CONFIRMED: 'DELIVERY_FAILED', DELIVERED: 'DELIVERY_FAILED' },
};

export function nextRescueStatus(from: RescueStatus, command: RescueCommand): RescueStatus | null {
  return transitions[command][from] ?? null;
}

/** In-progress states: the rescue holds its listing. Mirrors the "not finished" index rule in migration 0012. */
export const ACTIVE_STATUSES: readonly RescueStatus[] = ['RESERVED', 'AWAITING_RUNNER', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DELIVERED'];
export const TERMINAL_STATUSES: readonly RescueStatus[] = ['COMPLETED', 'CANCELLED', 'EXPIRED', 'PICKUP_FAILED', 'DELIVERY_FAILED'];
export const isActive = (s: RescueStatus) => ACTIVE_STATUSES.includes(s);

/** Stages at which the parties may see each other's exact pickup address and contact details (Phase 5 rule). */
export const HANDOFF_STATUSES: readonly RescueStatus[] = ['AWAITING_RUNNER', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DELIVERED'];
/** Stages at which the assigned runner may see exact addresses and the parties' contacts (needs-to-know, until handover). */
export const RUNNER_HANDOFF_STATUSES: readonly RescueStatus[] = ['PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'IN_TRANSIT'];
/** Stages in which a runner's live position may be shared with the rescue's parties. Anything else deletes it. */
export const TRACKING_STATUSES: readonly RescueStatus[] = ['PICKUP_ASSIGNED', 'IN_TRANSIT'];
/** Forward steps a blocking incident stops (spec BR-07). */
export const BLOCKED_COMMANDS: readonly RescueCommand[] = ['RUNNER_ACCEPT', 'VERIFY_PICKUP', 'RUNNER_HANDOVER', 'CONFIRM_DELIVERY'];

export interface DeadlineFacts {
  status: RescueStatus;
  providerConfirmBy: Date;
  pickupBy: Date;
  deliveryConfirmBy: Date | null;
  runnerBy?: Date | null;
}

/**
 * The expiry command that applies at `now`, if any. Deadlines are inclusive: at exactly the deadline the
 * rescue is already overdue. Used by reads, by every transition (before acting) and by the worker, so a
 * delayed timer or restart never lets an overdue rescue be acted on.
 */
export function dueExpiry(r: DeadlineFacts, now: Date): RescueCommand | null {
  const t = now.getTime();
  if (r.status === 'RESERVED' && r.providerConfirmBy.getTime() <= t) return 'EXPIRE_CONFIRMATION';
  if (r.status === 'AWAITING_RUNNER' && r.runnerBy && r.runnerBy.getTime() <= t) return 'EXPIRE_RUNNER_SEARCH';
  if (r.status === 'PICKUP_ASSIGNED' && r.pickupBy.getTime() <= t) return 'EXPIRE_PICKUP';
  if (r.status === 'IN_TRANSIT' && r.deliveryConfirmBy && r.deliveryConfirmBy.getTime() <= t) return 'EXPIRE_TRANSIT';
  if ((r.status === 'PICKUP_CONFIRMED' || r.status === 'DELIVERED') && r.deliveryConfirmBy && r.deliveryConfirmBy.getTime() <= t) return 'EXPIRE_DELIVERY';
  return null;
}

/** The status a reader should see right now, even if the worker has not recorded an expiry yet. */
export function effectiveRescueStatus(r: DeadlineFacts, now: Date): RescueStatus {
  const cmd = dueExpiry(r, now);
  return cmd ? nextRescueStatus(r.status, cmd)! : r.status;
}

const MIN = 60_000;

/** Deadlines fixed at acceptance. Provider confirmation never runs past the listing's pickup deadline. */
export function acceptanceDeadlines(now: Date, pickupDeadline: Date, s: RescueSettings) {
  return {
    providerConfirmBy: new Date(Math.min(now.getTime() + s.providerConfirmMinutes * MIN, pickupDeadline.getTime())),
    pickupBy: new Date(pickupDeadline.getTime() + s.pickupGraceMinutes * MIN),
  };
}

/** When the search for a runner gives up: after the configured wait, and never past the listing's pickup deadline. */
export function runnerSearchDeadline(now: Date, pickupDeadline: Date, s: RescueSettings) {
  return new Date(Math.min(now.getTime() + s.runnerSearchMinutes * MIN, pickupDeadline.getTime()));
}

/** Pickup may be verified from shortly before the window opens until the pickup grace deadline. */
export function pickupWindowOpen(now: Date, pickupStart: Date, pickupBy: Date, s: RescueSettings) {
  return now.getTime() >= pickupStart.getTime() - s.pickupEarlyMinutes * MIN && now.getTime() < pickupBy.getTime();
}

/** Incident rule (spec BR-07): HIGH or CRITICAL severity, or any food-safety report, blocks normal progress until an admin resolves it. */
export function isBlockingIncident(category: string, severity: string): boolean {
  return severity === 'HIGH' || severity === 'CRITICAL' || category === 'FOOD_SAFETY';
}

export type Party = 'provider' | 'ngo' | 'runner' | 'admin';

/** Human-readable "who acts next" for each state (spec 9.6: every active rescue shows the next action). */
export function nextAction(status: RescueStatus, mode: TransportMode = 'NGO_PICKUP'): { party: Party | null; text: string } {
  switch (status) {
    case 'RESERVED':
      return { party: 'provider', text: 'Provider to confirm the handoff (or decline).' };
    case 'AWAITING_RUNNER':
      return { party: 'runner', text: 'Waiting for an eligible runner to accept. The NGO can collect it itself instead.' };
    case 'PICKUP_ASSIGNED':
      return mode === 'RUNNER'
        ? { party: 'runner', text: 'Runner to collect the food and verify pickup with the provider’s one-time code.' }
        : { party: 'ngo', text: 'NGO to collect the food and verify pickup with the provider’s one-time code.' };
    case 'PICKUP_CONFIRMED':
      return { party: 'ngo', text: 'NGO to confirm how many servings were received.' };
    case 'IN_TRANSIT':
      return { party: 'runner', text: 'Runner to deliver the food to the NGO and record the handover.' };
    case 'DELIVERED':
      return { party: 'ngo', text: 'NGO to confirm how many servings were received.' };
    case 'DELIVERY_FAILED':
      return { party: 'admin', text: 'Admin follow-up needed: delivery was not confirmed in time or custody is in doubt.' };
    default:
      return { party: null, text: 'No further action.' };
  }
}
