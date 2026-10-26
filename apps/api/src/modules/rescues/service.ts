import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { RescueSettings } from '../../config.js';
import type { Db } from '../../db/client.js';
import {
  foodListings,
  incidentEvidence,
  incidentReports,
  listingEvents,
  notifications,
  organizationMembers,
  organizations,
  rescueAssignments,
  rescueEvents,
  rescueLocations,
  rescues,
  users,
  type FoodListing,
  type Organization,
  type PlatformRole,
  type Rescue,
  type RescueStatus,
} from '../../db/schema.js';
import { AppError, errors, fieldErrors } from '../../http/errors.js';
import { describeError } from '../../log.js';
import { unguarded, type Guard } from '../../ops/advisory-lock.js';
import { assertOrganizationVerified } from '../organizations/guards.js';
import { activeOrganizations } from '../organizations/membership.js';
import type { MatchingService } from '../matching/service.js';
import {
  ACTIVE_STATUSES,
  BLOCKED_COMMANDS,
  HANDOFF_STATUSES,
  RUNNER_HANDOFF_STATUSES,
  TRACKING_STATUSES,
  acceptanceDeadlines,
  dueExpiry,
  effectiveRescueStatus,
  isActive,
  nextAction,
  nextRescueStatus,
  pickupWindowOpen,
  runnerSearchDeadline,
  type Party,
  type RescueCommand,
} from './lifecycle.js';

export interface Actor {
  id: string;
  platformRole: PlatformRole;
}

type Clock = () => Date;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface RescueHooks {
  /** A listing went back to AVAILABLE: refresh its recommendations (after commit; never rolls back). */
  listingReleased?(listingId: string): Promise<void>;
  /** Real-time nudge after commit: these users should re-fetch this rescue. Ids only, no data. */
  rescueChanged?(userIds: string[], rescueId: string): void;
}

const HOUR = 3_600_000;
const round2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);

/** The code is bound to the rescue: the same digits are useless for any other rescue. */
const hashCode = (rescueId: string, code: string) => createHash('sha256').update(`${rescueId}:${code}`).digest('hex');
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export const invalidTransition = (status: RescueStatus, what: string) =>
  new AppError(409, 'INVALID_RESCUE_TRANSITION', `This rescue is ${status.toLowerCase().replace(/_/g, ' ')}, so you cannot ${what}.`, { status });

const blockedByIncident = () =>
  new AppError(409, 'RESCUE_BLOCKED_BY_INCIDENT', 'An open incident on this rescue must be resolved by an admin before it can continue.');

const OUTCOME_FOR: Partial<Record<RescueCommand, string>> = {
  PROVIDER_REJECT: 'PROVIDER_REJECTED',
  PROVIDER_CANCEL: 'PROVIDER_WITHDREW',
  NGO_CANCEL: 'NGO_CANCELLED',
  ADMIN_CANCEL: 'ADMIN_CANCELLED',
  EXPIRE_CONFIRMATION: 'PROVIDER_NO_RESPONSE',
  EXPIRE_RUNNER_SEARCH: 'NO_RUNNER_FOUND',
  EXPIRE_PICKUP: 'PICKUP_NOT_VERIFIED',
  EXPIRE_TRANSIT: 'TRANSIT_NOT_COMPLETED',
  EXPIRE_DELIVERY: 'DELIVERY_NOT_CONFIRMED',
  ADMIN_FAIL: 'ADMIN_MARKED_FAILED',
  COMPLETE: 'COMPLETED',
  ADMIN_RESOLVE: 'ADMIN_RESOLVED',
};

export interface Ctx {
  tx: Tx;
  rescue: Rescue;
  listing: FoodListing;
  now: Date;
  /** Work to run after the transaction commits (matching refresh, socket nudges). */
  afterCommit: (() => Promise<void>)[];
  /** Id of the most recent audit event written by apply(): lets callers hang notifications on it. */
  lastEventId?: string;
}

export function createRescueService(
  db: Db,
  settings: RescueSettings,
  matching: Pick<MatchingService, 'evaluateForAccept'>,
  clock: Clock = () => new Date(),
  hooks: RescueHooks = {},
) {
  /** Set by the runner module: called when a rescue starts (or restarts) waiting for a runner. */
  let onRunnerNeeded: (ctx: Ctx) => Promise<void> = async () => undefined;

  /* ---------------- helpers ---------------- */

  async function activeMemberIds(tx: Tx | Db, orgId: string) {
    const rows = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.status, 'ACTIVE')));
    return rows.map((r) => r.userId);
  }

  async function isMember(tx: Tx | Db, userId: string, orgId: string) {
    return (await activeMemberIds(tx, orgId)).includes(userId);
  }

  async function adminIds(tx: Tx | Db) {
    const rows = await tx.select({ id: users.id }).from(users).where(and(eq(users.platformRole, 'admin'), eq(users.status, 'ACTIVE')));
    return rows.map((r) => r.id);
  }

  async function activeAssignment(tx: Tx | Db, rescueId: string) {
    const [a] = await tx.select().from(rescueAssignments).where(and(eq(rescueAssignments.rescueId, rescueId), eq(rescueAssignments.status, 'ACTIVE'))).limit(1);
    return a ?? null;
  }

  /** True when an open blocking incident (spec BR-07) stops normal progress on this rescue. */
  async function hasBlockingIncident(tx: Tx | Db, rescueId: string) {
    const [row] = await tx
      .select({ id: incidentReports.id })
      .from(incidentReports)
      .where(and(eq(incidentReports.rescueId, rescueId), eq(incidentReports.status, 'OPEN'), eq(incidentReports.blocking, true)))
      .limit(1);
    return !!row;
  }

  async function recordEvent(
    ctx: Pick<Ctx, 'tx'>,
    e: { rescueId: string; eventType: string; from: RescueStatus | null; to: RescueStatus | null; actor: Actor | null; reason?: string | null; metadata?: Record<string, unknown> },
  ) {
    const [row] = await ctx.tx
      .insert(rescueEvents)
      .values({
        rescueId: e.rescueId,
        eventType: e.eventType,
        fromStatus: e.from,
        toStatus: e.to,
        actorUserId: e.actor?.id ?? null,
        actorRole: e.actor?.platformRole ?? 'system',
        reason: e.reason ?? null,
        metadata: e.metadata ?? {},
      })
      .returning({ id: rescueEvents.id });
    return row!.id;
  }

  /** Real-time nudge to these users after commit (ids only). */
  function emit(ctx: Pick<Ctx, 'afterCommit'>, userIds: string[], rescueId: string) {
    if (hooks.rescueChanged && userIds.length > 0) ctx.afterCommit.push(async () => hooks.rescueChanged?.(userIds, rescueId));
  }

  /**
   * In-app notifications to the given organizations' members (and any extra users), one per (event, user): the
   * dedupe key makes retries no-ops. Text never contains addresses, contact details or pickup codes.
   */
  async function notify(
    ctx: Pick<Ctx, 'tx'> & { afterCommit?: (() => Promise<void>)[] },
    eventId: string,
    rescueId: string,
    orgIds: string[],
    exceptUserId: string | null,
    title: string,
    body: string,
    extraUserIds: string[] = [],
    type = 'RESCUE_UPDATE',
  ) {
    const recipients = new Set<string>(extraUserIds);
    for (const orgId of orgIds) for (const u of await activeMemberIds(ctx.tx, orgId)) recipients.add(u);
    if (exceptUserId) recipients.delete(exceptUserId);
    // The acting user's other tabs also refresh, but the actor is not sent a notification for their own action.
    const audience = [...recipients, ...(exceptUserId ? [exceptUserId] : [])];
    if (ctx.afterCommit && hooks.rescueChanged) {
      ctx.afterCommit.push(async () => hooks.rescueChanged?.(audience, rescueId));
    }
    if (recipients.size === 0) return;
    await ctx.tx
      .insert(notifications)
      .values(
        [...recipients].map((userId) => ({
          userId,
          type,
          title,
          body,
          entityType: 'rescue',
          entityId: rescueId,
          dedupeKey: `rescue-event:${eventId}:${userId}`,
        })),
      )
      .onConflictDoNothing({ target: notifications.dedupeKey });
  }

  async function orgNames(tx: Tx | Db, ids: string[]) {
    const rows = await tx.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Puts a listing back on the market after a pre-pickup rescue ends, or expires it if its deadline has passed. */
  async function releaseListing(ctx: Ctx) {
    const { tx, listing, now } = ctx;
    if (listing.pickupDeadline.getTime() > now.getTime()) {
      await tx.update(foodListings).set({ status: 'AVAILABLE', updatedAt: now }).where(eq(foodListings.id, listing.id));
      ctx.afterCommit.push(async () => {
        await hooks.listingReleased?.(listing.id);
      });
    } else {
      await tx.update(foodListings).set({ status: 'EXPIRED', expiredAt: now, updatedAt: now }).where(eq(foodListings.id, listing.id));
      await tx.insert(listingEvents).values({ listingId: listing.id, action: 'EXPIRED', actorUserId: null });
    }
  }

  /** Ends the rescue's ACTIVE runner assignment, if any, and returns the runner who held it. */
  async function endAssignment(ctx: Ctx, status: 'COMPLETED' | 'RELEASED' | 'REVOKED', reason: string | null) {
    const [ended] = await ctx.tx
      .update(rescueAssignments)
      .set({ status, endedAt: ctx.now, endReason: reason })
      .where(and(eq(rescueAssignments.rescueId, ctx.rescue.id), eq(rescueAssignments.status, 'ACTIVE')))
      .returning({ runnerUserId: rescueAssignments.runnerUserId });
    return ended?.runnerUserId ?? null;
  }

  /** Applies a state change: row update, audit event, runner/location side effects and notifications. */
  async function apply(
    ctx: Ctx,
    command: RescueCommand,
    actor: Actor | null,
    opts: {
      reason?: string | null;
      patch?: Partial<Rescue>;
      metadata?: Record<string, unknown>;
      notifyText?: { title: string; body: string };
      notifyOrgs?: string[];
      notifyAdmins?: boolean;
      /** Also tell the runner who held the rescue (default: yes whenever one exists). */
      notifyRunner?: boolean;
    } = {},
  ) {
    const from = ctx.rescue.status;
    const to = nextRescueStatus(from, command);
    if (!to) throw invalidTransition(from, 'do that');
    const terminal = ['COMPLETED', 'CANCELLED', 'EXPIRED', 'PICKUP_FAILED'].includes(to);
    const outcome = OUTCOME_FOR[command];
    const holder = await activeAssignment(ctx.tx, ctx.rescue.id);
    const [updated] = await ctx.tx
      .update(rescues)
      .set({
        status: to,
        version: ctx.rescue.version + 1,
        updatedAt: ctx.now,
        ...(terminal ? { closedAt: ctx.now } : {}),
        ...(outcome ? { outcomeCode: outcome } : {}),
        ...(opts.reason !== undefined ? { outcomeReason: opts.reason } : {}),
        ...opts.patch,
      })
      .where(eq(rescues.id, ctx.rescue.id))
      .returning();
    ctx.rescue = updated!;

    // The runner holds the rescue only while it is being collected and carried. Every other outcome frees them.
    if (holder) {
      if (command === 'RUNNER_RELEASE') await endAssignment(ctx, 'RELEASED', opts.reason ?? null);
      else if (to === 'DELIVERED' || to === 'COMPLETED') await endAssignment(ctx, 'COMPLETED', null);
      else if (['AWAITING_RUNNER', 'CANCELLED', 'EXPIRED', 'PICKUP_FAILED', 'DELIVERY_FAILED'].includes(to)) await endAssignment(ctx, 'REVOKED', opts.reason ?? null);
    }
    // Live position is only kept while a runner is actively en route (retention rule).
    if (!TRACKING_STATUSES.includes(to)) await ctx.tx.delete(rescueLocations).where(eq(rescueLocations.rescueId, ctx.rescue.id));

    const eventId = await recordEvent(ctx, { rescueId: ctx.rescue.id, eventType: 'STATUS_CHANGED', from, to, actor, reason: opts.reason ?? null, metadata: { command, ...opts.metadata } });
    ctx.lastEventId = eventId;
    if (opts.notifyText) {
      const extra = [...(holder && opts.notifyRunner !== false && holder.runnerUserId !== actor?.id ? [holder.runnerUserId] : []), ...(opts.notifyAdmins ? await adminIds(ctx.tx) : [])];
      await notify(ctx, eventId, ctx.rescue.id, opts.notifyOrgs ?? [ctx.rescue.providerOrgId, ctx.rescue.ngoOrgId], actor?.id ?? null, opts.notifyText.title, opts.notifyText.body, extra);
    } else if (holder) {
      emit(ctx, [holder.runnerUserId], ctx.rescue.id);
    }
    // Every transition is visible to the admin operations board, whether or not anyone was notified (no user ids: admins only).
    if (hooks.rescueChanged) ctx.afterCommit.push(async () => hooks.rescueChanged?.([], ctx.rescue.id));
    return updated!;
  }

  /**
   * Records any expiry that is already due, inside the caller's locked transaction. Called by every read,
   * every transition and the worker, so correctness never depends on when (or whether) the timer ran.
   */
  async function settle(ctx: Ctx) {
    const cmd = dueExpiry({ ...ctx.rescue, deliveryConfirmBy: ctx.rescue.deliveryConfirmBy }, ctx.now);
    if (!cmd) return false;
    const title = `Rescue update: ${ctx.listing.title}`;
    if (cmd === 'EXPIRE_CONFIRMATION') {
      await apply(ctx, cmd, null, {
        reason: 'The provider did not confirm in time.',
        notifyText: { title, body: 'The reservation expired because the provider did not confirm in time. The listing is open to other NGOs again if time allows.' },
      });
      await releaseListing(ctx);
    } else if (cmd === 'EXPIRE_RUNNER_SEARCH') {
      await apply(ctx, cmd, null, {
        reason: 'No eligible runner accepted in time.',
        notifyText: { title, body: 'No runner accepted in time, so the rescue ended and the listing is open to other NGOs again if time allows. An admin has been told.' },
        notifyAdmins: true,
      });
      await releaseListing(ctx);
    } else if (cmd === 'EXPIRE_PICKUP') {
      await apply(ctx, cmd, null, {
        reason: 'Pickup was not verified before the pickup deadline.',
        notifyText: { title, body: 'Pickup was not verified before the deadline, so this rescue failed and the listing has expired.' },
        notifyAdmins: ctx.rescue.transportMode === 'RUNNER',
      });
      await ctx.tx.update(foodListings).set({ status: 'EXPIRED', expiredAt: ctx.now, updatedAt: ctx.now }).where(eq(foodListings.id, ctx.listing.id));
      await ctx.tx.insert(listingEvents).values({ listingId: ctx.listing.id, action: 'EXPIRED', actorUserId: null });
    } else if (cmd === 'EXPIRE_TRANSIT') {
      await apply(ctx, cmd, null, {
        reason: 'The runner did not hand the food over in time.',
        notifyText: { title, body: 'Delivery was not completed in time. An admin will follow up; please do not assume the food was delivered.' },
        notifyAdmins: true,
      });
    } else {
      await apply(ctx, cmd, null, {
        reason: 'The NGO did not confirm the delivered quantity in time.',
        notifyText: { title, body: 'Delivery was not confirmed in time. An admin will follow up.' },
        notifyAdmins: ctx.rescue.transportMode === 'RUNNER',
      });
    }
    return true;
  }

  async function partyOf(actor: Actor, r: Pick<Rescue, 'id' | 'providerOrgId' | 'ngoOrgId'>, tx: Tx | Db): Promise<Party | null> {
    if (actor.platformRole === 'admin') return 'admin';
    if (actor.platformRole === 'provider' && (await isMember(tx, actor.id, r.providerOrgId))) return 'provider';
    if (actor.platformRole === 'ngo' && (await isMember(tx, actor.id, r.ngoOrgId))) return 'ngo';
    if (actor.platformRole === 'runner') {
      // A runner is a party only to rescues they hold or have held; anything else is invisible (404).
      const [a] = await tx
        .select({ id: rescueAssignments.id })
        .from(rescueAssignments)
        .where(and(eq(rescueAssignments.rescueId, r.id), eq(rescueAssignments.runnerUserId, actor.id)))
        .limit(1);
      if (a) return 'runner';
    }
    return null;
  }

  /**
   * Locks the rescue and its listing, settles due expiry, authorizes the caller, checks the optional
   * expected version, then runs `fn`. Non-parties get 404 (no existence leak); parties acting outside
   * their role get 403. `fn` may return { error } to commit side effects (e.g. a failed-attempt counter)
   * and still fail the request. `party` may depend on the rescue (e.g. who verifies pickup depends on the transport mode).
   */
  async function withRescue<T>(
    actor: Actor,
    rescueId: string,
    party: Party | ((r: Rescue) => Party),
    expectedVersion: number | undefined,
    fn: (ctx: Ctx) => Promise<T | { error: AppError }>,
  ): Promise<T> {
    const afterCommit: (() => Promise<void>)[] = [];
    const result = await db.transaction(async (tx) => {
      const [rescue] = await tx.select().from(rescues).where(eq(rescues.id, rescueId)).for('update');
      if (!rescue) throw errors.notFound('Rescue not found.');
      const role = await partyOf(actor, rescue, tx);
      if (!role) throw errors.notFound('Rescue not found.');
      const required = typeof party === 'function' ? party(rescue) : party;
      if (role !== required) throw errors.forbidden();
      const [listing] = await tx.select().from(foodListings).where(eq(foodListings.id, rescue.listingId)).for('update');
      const ctx: Ctx = { tx, rescue, listing: listing!, now: clock(), afterCommit };
      await settle(ctx);
      if (expectedVersion !== undefined && expectedVersion !== ctx.rescue.version) {
        return { error: new AppError(409, 'STALE_RESCUE', 'This rescue changed since you loaded it. Reload and try again.', { currentVersion: ctx.rescue.version, status: ctx.rescue.status }) };
      }
      return fn(ctx);
    });
    for (const job of afterCommit) await job().catch(() => undefined);
    if (result && typeof result === 'object' && 'error' in result && result.error instanceof AppError) throw result.error;
    return result as T;
  }

  /* ---------------- views ---------------- */

  async function view(r: Rescue, viewer: Party, now: Date, tx: Tx | Db = db, viewerId?: string) {
    const [listing] = await tx.select().from(foodListings).where(eq(foodListings.id, r.listingId));
    const orgs = await tx.select().from(organizations).where(inArray(organizations.id, [r.providerOrgId, r.ngoOrgId]));
    const provider = orgs.find((o) => o.id === r.providerOrgId)!;
    const ngo = orgs.find((o) => o.id === r.ngoOrgId)!;
    const status = effectiveRescueStatus({ ...r }, now);
    const mode = r.transportMode;

    // The runner this viewer is looking at: the current holder for the parties, the viewer's own latest assignment for a runner.
    const [assignment] =
      viewer === 'runner' && viewerId
        ? await tx.select().from(rescueAssignments).where(and(eq(rescueAssignments.rescueId, r.id), eq(rescueAssignments.runnerUserId, viewerId))).orderBy(desc(rescueAssignments.acceptedAt)).limit(1)
        : await tx.select().from(rescueAssignments).where(and(eq(rescueAssignments.rescueId, r.id), eq(rescueAssignments.status, 'ACTIVE'))).limit(1);
    const isHolder = assignment?.status === 'ACTIVE';
    const runnerUser = assignment ? (await tx.select({ name: users.name, phone: users.phone }).from(users).where(eq(users.id, assignment.runnerUserId)))[0] : undefined;
    const blocked = await hasBlockingIncident(tx, r.id);

    // Exact address and contacts are shared only at the hand-off stage (and always with admins).
    const handoff = HANDOFF_STATUSES.includes(status);
    const runnerHandoff = viewer === 'runner' && isHolder && RUNNER_HANDOFF_STATUSES.includes(status);
    const contact = (o: Organization, withEmail = true) => ({ contactName: o.contactName, contactPhone: o.contactPhone, contactEmail: withEmail ? o.contactEmail : null });
    const showExact = viewer === 'admin' || (viewer === 'provider') || (viewer === 'ngo' && handoff) || runnerHandoff;
    const showProviderContact = viewer === 'admin' || viewer === 'provider' || (viewer === 'ngo' && handoff) || runnerHandoff;
    const showNgoContact = viewer === 'admin' || viewer === 'ngo' || (viewer === 'provider' && handoff) || runnerHandoff;
    const history = await tx
      .select({ id: rescueEvents.id, eventType: rescueEvents.eventType, fromStatus: rescueEvents.fromStatus, toStatus: rescueEvents.toStatus, actorRole: rescueEvents.actorRole, reason: rescueEvents.reason, metadata: rescueEvents.metadata, createdAt: rescueEvents.createdAt })
      .from(rescueEvents)
      .where(eq(rescueEvents.rescueId, r.id))
      .orderBy(desc(rescueEvents.seq));
    const incidentRows = await tx
      .select({
        id: incidentReports.id,
        category: incidentReports.category,
        severity: incidentReports.severity,
        blocking: incidentReports.blocking,
        status: incidentReports.status,
        description: incidentReports.description,
        reporterRole: incidentReports.reporterRole,
        createdAt: incidentReports.createdAt,
        resolvedAt: incidentReports.resolvedAt,
        resolutionCode: incidentReports.resolutionCode,
        resolutionNote: incidentReports.resolutionNote,
        evidenceCount: sql<number>`(SELECT count(*)::int FROM ${incidentEvidence} e WHERE e.incident_id = incident_reports.id)`,
      })
      .from(incidentReports)
      .where(eq(incidentReports.rescueId, r.id))
      .orderBy(asc(incidentReports.createdAt));

    const reportable = isActive(status) && status !== 'RESERVED';
    const forward = (...a: string[]) => (blocked ? [] : a); // blocking incidents stop normal forward steps
    const actions: Record<Party, Partial<Record<RescueStatus, string[]>>> = {
      provider: {
        RESERVED: ['confirm', 'reject', 'cancel'],
        AWAITING_RUNNER: ['regenerate_code', 'cancel'],
        PICKUP_ASSIGNED: ['regenerate_code', 'cancel'],
      },
      ngo: {
        RESERVED: ['cancel'],
        AWAITING_RUNNER: ['collect_myself', 'cancel'],
        PICKUP_ASSIGNED: mode === 'NGO_PICKUP' ? [...forward('verify_pickup'), 'cancel'] : ['cancel'],
        PICKUP_CONFIRMED: forward('confirm_delivery'),
        DELIVERED: forward('confirm_delivery'),
      },
      runner: isHolder
        ? { PICKUP_ASSIGNED: [...forward('verify_pickup'), 'release_assignment'], IN_TRANSIT: forward('handover') }
        : {},
      admin: {
        RESERVED: ['admin_cancel'],
        AWAITING_RUNNER: ['admin_cancel'],
        PICKUP_ASSIGNED: mode === 'RUNNER' && isHolder ? ['admin_cancel', 'admin_reassign'] : ['admin_cancel'],
        PICKUP_CONFIRMED: ['admin_resolve', 'admin_fail'],
        IN_TRANSIT: ['admin_resolve', 'admin_fail'],
        DELIVERED: ['admin_resolve', 'admin_fail'],
        DELIVERY_FAILED: ['admin_resolve'],
      },
    };
    const allowed = [...(actions[viewer][status] ?? [])];
    if (reportable && viewer !== 'admin' && (viewer !== 'runner' || isHolder)) allowed.push('report_incident');

    return {
      id: r.id,
      status,
      version: r.version,
      viewerRole: viewer,
      transportMode: mode,
      blockedByIncident: blocked,
      allowedActions: allowed,
      nextAction: nextAction(status, mode),
      listing: {
        id: listing!.id,
        title: listing!.title,
        foodCategory: listing!.foodCategory,
        servingsOffered: r.servingsOffered,
        packaging: listing!.packaging,
        dietaryTags: listing!.dietaryTags,
        allergenNotes: listing!.allergenNotes,
        transportRequired: listing!.transportRequired,
        hasImage: listing!.imageKey !== null && viewer !== 'runner',
        pickupStart: listing!.pickupStart,
        pickupDeadline: listing!.pickupDeadline,
        approximateArea: { city: listing!.city, latitude: round2(listing!.latitude), longitude: round2(listing!.longitude) },
        exactPickup: showExact ? { addressLine: listing!.addressLine, city: listing!.city, latitude: listing!.latitude, longitude: listing!.longitude } : null,
      },
      provider: { name: provider.name, contact: showProviderContact ? contact(provider, viewer !== 'runner') : null },
      ngo: {
        name: ngo.name,
        city: ngo.city,
        contact: showNgoContact ? contact(ngo, viewer !== 'runner') : null,
        // Where the food is delivered: exact only for the runner who is carrying it (and admins).
        destination:
          viewer === 'admin' || runnerHandoff
            ? { addressLine: ngo.addressLine, city: ngo.city, latitude: ngo.latitude, longitude: ngo.longitude }
            : null,
        approximateArea: { city: ngo.city, latitude: round2(ngo.latitude), longitude: round2(ngo.longitude) },
      },
      runner: assignment
        ? {
            name: runnerUser?.name ?? 'Runner',
            assignmentStatus: assignment.status,
            // Phone is shared with the parties while the food is moving, and with admins.
            phone: viewer !== 'runner' && (viewer === 'admin' || (HANDOFF_STATUSES.includes(status) && status !== 'AWAITING_RUNNER')) ? runnerUser?.phone ?? null : null,
          }
        : null,
      deadlines: { providerConfirmBy: r.providerConfirmBy, runnerBy: r.runnerBy, pickupBy: r.pickupBy, deliveryConfirmBy: r.deliveryConfirmBy },
      pickupCode:
        (status === 'PICKUP_ASSIGNED' || status === 'AWAITING_RUNNER') && viewer !== 'runner'
          ? { issued: r.pickupCodeHash !== null, attemptsLeft: Math.max(0, settings.maxCodeAttempts - r.pickupCodeAttempts), locked: r.pickupCodeAttempts >= settings.maxCodeAttempts }
          : status === 'PICKUP_ASSIGNED' && viewer === 'runner' && isHolder
            ? { issued: r.pickupCodeHash !== null, attemptsLeft: Math.max(0, settings.maxCodeAttempts - r.pickupCodeAttempts), locked: r.pickupCodeAttempts >= settings.maxCodeAttempts }
            : null,
      trackingActive: TRACKING_STATUSES.includes(status) && mode === 'RUNNER' && !!assignment && isHolder,
      reservedAt: r.reservedAt,
      providerConfirmedAt: r.providerConfirmedAt,
      pickedUpAt: r.pickedUpAt,
      handedOverAt: r.handedOverAt,
      collectedServings: r.collectedServings,
      deliveredServings: r.deliveredServings,
      completedAt: r.completedAt,
      closedAt: r.closedAt,
      outcomeCode: r.outcomeCode,
      outcomeReason: r.outcomeReason,
      incidents: incidentRows,
      history,
    };
  }

  async function verifiedNgoOrg(actor: Actor) {
    if (actor.platformRole !== 'ngo') throw errors.forbidden();
    const orgs = await activeOrganizations(db, actor.id, 'NGO');
    const verified = orgs.find((o) => o.verificationStatus === 'VERIFIED');
    if (verified) return verified;
    if (orgs[0]) return assertOrganizationVerified(db, orgs[0].id);
    throw new AppError(409, 'ORGANIZATION_REQUIRED', 'Create your organization profile first.');
  }

  const listingTitle = (ctx: Ctx) => ctx.listing.title;

  /* ---------------- commands ---------------- */

  return {
    /**
     * Pieces shared with the runner and incident modules. Not part of the HTTP surface.
     */
    internals: {
      db,
      settings,
      clock,
      hooks,
      withRescue,
      apply,
      settle,
      recordEvent,
      notify,
      emit,
      releaseListing,
      view,
      partyOf,
      adminIds,
      activeAssignment,
      hasBlockingIncident,
      blockedByIncident,
      listingTitle,
      endAssignment,
      setRunnerNeededHandler(fn: (ctx: Ctx) => Promise<void>) {
        onRunnerNeeded = fn;
      },
    },

    /**
     * NGO accepts a live listing. Serialized per listing by a row lock; the partial unique index is the
     * final guard. Re-sending the same accept returns the existing rescue (idempotent).
     * `transportMode` RUNNER asks for a volunteer runner and is only allowed on listings that request transport.
     */
    async accept(actor: Actor, listingId: string, input: { transportMode?: 'NGO_PICKUP' | 'RUNNER' } = {}) {
      const org = await verifiedNgoOrg(actor);
      const mode = input.transportMode ?? 'NGO_PICKUP';
      const afterCommit: (() => Promise<void>)[] = [];
      try {
        const out = await db.transaction(async (tx) => {
          const [listing] = await tx.select().from(foodListings).where(eq(foodListings.id, listingId)).for('update');
          if (!listing) throw errors.notFound('Listing not found.');
          const now = clock();

          // Settle an overdue active rescue first so a provider who never responded does not block the listing.
          const [existing] = await tx
            .select()
            .from(rescues)
            .where(and(eq(rescues.listingId, listingId), inArray(rescues.status, [...ACTIVE_STATUSES])))
            .for('update');
          let current = listing;
          if (existing) {
            const ctx: Ctx = { tx, rescue: existing, listing, now, afterCommit };
            await settle(ctx);
            if (isActive(ctx.rescue.status)) {
              if (ctx.rescue.ngoOrgId === org.id) return { rescue: ctx.rescue, created: false, now, tx };
              throw new AppError(409, 'LISTING_ALREADY_RESERVED', 'Another NGO has already accepted this listing.');
            }
            const [reloaded] = await tx.select().from(foodListings).where(eq(foodListings.id, listingId));
            current = reloaded!;
          }
          if (current!.status !== 'AVAILABLE' || current!.pickupDeadline.getTime() <= now.getTime()) {
            throw new AppError(409, 'LISTING_NOT_AVAILABLE', 'This listing is no longer available.');
          }
          if (mode === 'RUNNER' && !current!.transportRequired) {
            throw fieldErrors({ transportMode: 'The provider did not ask for transport on this listing, so a runner cannot be requested. Collect it yourself.' });
          }

          // Authoritative live check of every hard filter (stored recommendations can be stale).
          const ev = await matching.evaluateForAccept(tx, listingId, org.id, now);
          if (!ev.eligible) {
            throw new AppError(409, 'NOT_ELIGIBLE', 'Your organization is not eligible to accept this listing right now.', { reasons: ev.reasons });
          }

          const deadlines = acceptanceDeadlines(now, current!.pickupDeadline, settings);
          const [rescue] = await tx
            .insert(rescues)
            .values({
              listingId,
              providerOrgId: current!.providerOrgId,
              ngoOrgId: org.id,
              acceptedBy: actor.id,
              status: 'RESERVED',
              transportMode: mode,
              servingsOffered: current!.servings,
              reservedAt: now,
              ...deadlines,
            })
            .returning();
          await tx.update(foodListings).set({ status: 'RESERVED', updatedAt: now }).where(eq(foodListings.id, listingId));
          const eventId = await recordEvent({ tx }, {
            rescueId: rescue!.id,
            eventType: 'ACCEPTED',
            from: null,
            to: 'RESERVED',
            actor,
            metadata: { transportMode: mode, score: ev.score, estimatedDistanceKm: round2(ev.distanceM / 1000), estimatedTravelMinutes: ev.travel.travelMinutes },
          });
          const minutes = Math.round((deadlines.providerConfirmBy.getTime() - now.getTime()) / 60_000);
          await notify({ tx, afterCommit }, eventId, rescue!.id, [current!.providerOrgId], actor.id, `${org.name} accepted "${current!.title}"`, `${mode === 'RUNNER' ? 'The NGO asked for a volunteer runner. ' : ''}Confirm the hand-off within ${minutes} minutes, or decline it.`);
          return { rescue: rescue!, created: true, now, tx };
        });
        for (const job of afterCommit) await job().catch(() => undefined);
        return { created: out.created, rescue: await view(out.rescue, 'ngo', clock(), db, actor.id) };
      } catch (err) {
        const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
        if (code === '23505') throw new AppError(409, 'LISTING_ALREADY_RESERVED', 'Another NGO has already accepted this listing.');
        throw err;
      }
    },

    async confirm(actor: Actor, id: string, expectedVersion?: number) {
      return withRescue(actor, id, 'provider', expectedVersion, async (ctx) => {
        // Already confirmed (any later in-progress state): repeat is a no-op.
        if (ctx.rescue.providerConfirmedAt && isActive(ctx.rescue.status)) return { rescue: await view(ctx.rescue, 'provider', ctx.now, ctx.tx, actor.id), pickupCode: null, changed: false };
        if (ctx.rescue.status !== 'RESERVED') return { error: invalidTransition(ctx.rescue.status, 'confirm it') };
        const code = newCode();
        const runnerMode = ctx.rescue.transportMode === 'RUNNER';
        const patch = { providerConfirmedAt: ctx.now, pickupCodeHash: hashCode(ctx.rescue.id, code), pickupCodeAttempts: 0, pickupCodeIssuedAt: ctx.now };
        if (runnerMode) {
          await apply(ctx, 'PROVIDER_CONFIRM_RUNNER', actor, {
            patch: { ...patch, runnerBy: runnerSearchDeadline(ctx.now, ctx.listing.pickupDeadline, settings) },
            notifyText: { title: `Hand-off confirmed: ${listingTitle(ctx)}`, body: 'The provider confirmed. We are now looking for an available runner; you can still collect it yourself.' },
            notifyOrgs: [ctx.rescue.ngoOrgId],
          });
          await recordEvent(ctx, { rescueId: ctx.rescue.id, eventType: 'PICKUP_CODE_ISSUED', from: null, to: null, actor });
          await onRunnerNeeded(ctx);
        } else {
          await apply(ctx, 'PROVIDER_CONFIRM', actor, {
            patch,
            notifyText: { title: `Hand-off confirmed: ${listingTitle(ctx)}`, body: 'The provider confirmed. The pickup address and contact details are now visible on the rescue page.' },
            notifyOrgs: [ctx.rescue.ngoOrgId],
          });
          await recordEvent(ctx, { rescueId: ctx.rescue.id, eventType: 'PICKUP_CODE_ISSUED', from: null, to: null, actor });
        }
        return { rescue: await view(ctx.rescue, 'provider', ctx.now, ctx.tx, actor.id), pickupCode: code, changed: true };
      });
    },

    async reject(actor: Actor, id: string, reason: string, expectedVersion?: number) {
      return withRescue(actor, id, 'provider', expectedVersion, async (ctx) => {
        if (ctx.rescue.status === 'CANCELLED' && ctx.rescue.outcomeCode === 'PROVIDER_REJECTED') return { rescue: await view(ctx.rescue, 'provider', ctx.now, ctx.tx, actor.id), changed: false };
        if (ctx.rescue.status !== 'RESERVED') return { error: invalidTransition(ctx.rescue.status, 'decline it') };
        await apply(ctx, 'PROVIDER_REJECT', actor, {
          reason,
          notifyText: { title: `Request declined: ${listingTitle(ctx)}`, body: `The provider declined your acceptance. Reason: ${reason}` },
          notifyOrgs: [ctx.rescue.ngoOrgId],
        });
        await releaseListing(ctx);
        return { rescue: await view(ctx.rescue, 'provider', ctx.now, ctx.tx, actor.id), changed: true };
      });
    },

    async regenerateCode(actor: Actor, id: string) {
      return withRescue(actor, id, 'provider', undefined, async (ctx) => {
        if (ctx.rescue.status !== 'PICKUP_ASSIGNED' && ctx.rescue.status !== 'AWAITING_RUNNER') return { error: invalidTransition(ctx.rescue.status, 'issue a pickup code') };
        const code = newCode();
        const [updated] = await ctx.tx
          .update(rescues)
          .set({ pickupCodeHash: hashCode(ctx.rescue.id, code), pickupCodeAttempts: 0, pickupCodeIssuedAt: ctx.now, version: ctx.rescue.version + 1, updatedAt: ctx.now })
          .where(eq(rescues.id, ctx.rescue.id))
          .returning();
        await recordEvent(ctx, { rescueId: ctx.rescue.id, eventType: 'PICKUP_CODE_ISSUED', from: null, to: null, actor, metadata: { replacedPrevious: true } });
        return { rescue: await view(updated!, 'provider', ctx.now, ctx.tx, actor.id), pickupCode: code };
      });
    },

    async cancel(actor: Actor, id: string, reason: string, expectedVersion?: number) {
      if (actor.platformRole === 'admin') throw errors.forbidden(); // admins use the audited admin-cancel route
      // Runners (and anything else) cancel nothing here: same 404 as any non-party.
      if (actor.platformRole !== 'provider' && actor.platformRole !== 'ngo') throw errors.notFound('Rescue not found.');
      const party: Party = actor.platformRole;
      const command: RescueCommand = party === 'provider' ? 'PROVIDER_CANCEL' : 'NGO_CANCEL';
      return withRescue(actor, id, party, expectedVersion, async (ctx) => {
        if (ctx.rescue.status === 'CANCELLED' && ctx.rescue.outcomeCode === OUTCOME_FOR[command]) return { rescue: await view(ctx.rescue, party, ctx.now, ctx.tx, actor.id), changed: false };
        if (!nextRescueStatus(ctx.rescue.status, command)) return { error: invalidTransition(ctx.rescue.status, 'cancel it') };
        if (party === 'provider') {
          // The provider withdraws the food: the rescue and the listing are both cancelled.
          await apply(ctx, command, actor, {
            reason,
            notifyText: { title: `Rescue cancelled: ${listingTitle(ctx)}`, body: `The provider withdrew this food. Reason: ${reason}` },
            notifyOrgs: [ctx.rescue.ngoOrgId],
          });
          await ctx.tx
            .update(foodListings)
            .set({ status: 'CANCELLED', cancelledAt: ctx.now, cancellationReason: reason, updatedAt: ctx.now })
            .where(eq(foodListings.id, ctx.listing.id));
          await ctx.tx.insert(listingEvents).values({ listingId: ctx.listing.id, action: 'CANCELLED', actorUserId: actor.id, reason });
        } else {
          await apply(ctx, command, actor, {
            reason,
            notifyText: { title: `Rescue cancelled: ${listingTitle(ctx)}`, body: `The NGO cancelled before pickup. Reason: ${reason}` },
            notifyOrgs: [ctx.rescue.providerOrgId],
          });
          await releaseListing(ctx);
        }
        return { rescue: await view(ctx.rescue, party, ctx.now, ctx.tx, actor.id), changed: true };
      });
    },

    /**
     * Verifies pickup with the provider's one-time code. Direct pickup: the NGO does it (Phase 5). Runner-assisted:
     * only the assigned runner can, and the rescue moves straight on to IN_TRANSIT.
     */
    async verifyPickup(actor: Actor, id: string, input: { code: string; collectedServings: number; expectedVersion?: number }) {
      return withRescue(actor, id, (r) => (r.transportMode === 'RUNNER' ? 'runner' : 'ngo'), input.expectedVersion, async (ctx) => {
        const runnerMode = ctx.rescue.transportMode === 'RUNNER';
        const done = runnerMode ? ['PICKUP_CONFIRMED', 'IN_TRANSIT', 'DELIVERED', 'RECIPIENT_CONFIRMED', 'COMPLETED'] : ['PICKUP_CONFIRMED'];
        const viewer: Party = runnerMode ? 'runner' : 'ngo';
        if (done.includes(ctx.rescue.status)) return { rescue: await view(ctx.rescue, viewer, ctx.now, ctx.tx, actor.id), changed: false };
        if (ctx.rescue.status !== 'PICKUP_ASSIGNED') return { error: invalidTransition(ctx.rescue.status, 'verify pickup') };
        if (runnerMode) {
          const held = await activeAssignment(ctx.tx, ctx.rescue.id);
          if (held?.runnerUserId !== actor.id) return { error: new AppError(409, 'NOT_ASSIGNED', 'You are no longer assigned to this rescue.') };
        }
        if (await hasBlockingIncident(ctx.tx, ctx.rescue.id)) return { error: blockedByIncident() };
        if (!pickupWindowOpen(ctx.now, ctx.listing.pickupStart, ctx.rescue.pickupBy, settings)) {
          return { error: new AppError(409, 'PICKUP_WINDOW_CLOSED', `Pickup can be verified from ${settings.pickupEarlyMinutes} minutes before the pickup window opens.`) };
        }
        if (input.collectedServings > ctx.rescue.servingsOffered) {
          return { error: fieldErrors({ collectedServings: `Cannot exceed the ${ctx.rescue.servingsOffered} servings offered.` }) };
        }
        if (!ctx.rescue.pickupCodeHash || ctx.rescue.pickupCodeAttempts >= settings.maxCodeAttempts) {
          return { error: new AppError(409, 'PICKUP_CODE_LOCKED', 'Too many wrong codes. Ask the provider to issue a new pickup code.') };
        }
        const expected = Buffer.from(ctx.rescue.pickupCodeHash, 'hex');
        const given = Buffer.from(hashCode(ctx.rescue.id, input.code), 'hex');
        if (!timingSafeEqual(expected, given)) {
          const attempts = ctx.rescue.pickupCodeAttempts + 1;
          await ctx.tx.update(rescues).set({ pickupCodeAttempts: attempts, updatedAt: ctx.now }).where(eq(rescues.id, ctx.rescue.id));
          await recordEvent(ctx, { rescueId: ctx.rescue.id, eventType: 'PICKUP_CODE_REJECTED', from: null, to: null, actor, metadata: { attempts } });
          const left = settings.maxCodeAttempts - attempts;
          return {
            error: new AppError(400, 'PICKUP_CODE_INVALID', left > 0 ? `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.` : 'That code is not correct. Ask the provider to issue a new code.', {
              attemptsLeft: Math.max(0, left),
            }),
          };
        }
        await apply(ctx, 'VERIFY_PICKUP', actor, {
          // The code is single-use: cleared once it succeeds (spec BR-06).
          patch: {
            pickedUpAt: ctx.now,
            collectedServings: input.collectedServings,
            pickupCodeHash: null,
            deliveryConfirmBy: new Date(ctx.now.getTime() + settings.deliveryConfirmHours * HOUR),
          },
          metadata: { collectedServings: input.collectedServings, proofMethod: 'OTP', collectedBy: viewer },
          notifyText: {
            title: `Food collected: ${listingTitle(ctx)}`,
            body: `${runnerMode ? 'The runner' : 'The NGO'} verified pickup of ${input.collectedServings} servings.`,
          },
          notifyOrgs: runnerMode ? [ctx.rescue.providerOrgId, ctx.rescue.ngoOrgId] : [ctx.rescue.providerOrgId],
        });
        await ctx.tx.update(foodListings).set({ status: 'COLLECTED', updatedAt: ctx.now }).where(eq(foodListings.id, ctx.listing.id));
        if (runnerMode) {
          // Spec 7.1: PICKUP_CONFIRMED -> IN_TRANSIT once the collected quantity is recorded. The transit clock starts now.
          await apply(ctx, 'START_TRANSIT', null, {
            patch: { transitStartedAt: ctx.now, deliveryConfirmBy: new Date(ctx.now.getTime() + settings.transitMinutes * 60_000) },
            notifyText: { title: `On the way: ${listingTitle(ctx)}`, body: 'The runner has the food and is heading to the NGO.' },
            notifyOrgs: [ctx.rescue.ngoOrgId, ctx.rescue.providerOrgId],
          });
        }
        return { rescue: await view(ctx.rescue, viewer, ctx.now, ctx.tx, actor.id), changed: true };
      });
    },

    async confirmDelivery(actor: Actor, id: string, input: { deliveredServings: number; notes?: string; expectedVersion?: number }) {
      return withRescue(actor, id, 'ngo', input.expectedVersion, async (ctx) => {
        if (ctx.rescue.status === 'COMPLETED') return { rescue: await view(ctx.rescue, 'ngo', ctx.now, ctx.tx, actor.id), changed: false };
        if (ctx.rescue.status !== 'PICKUP_CONFIRMED' && ctx.rescue.status !== 'DELIVERED') return { error: invalidTransition(ctx.rescue.status, 'confirm delivery') };
        if (await hasBlockingIncident(ctx.tx, ctx.rescue.id)) return { error: blockedByIncident() };
        if (input.deliveredServings > (ctx.rescue.collectedServings ?? 0)) {
          return { error: fieldErrors({ deliveredServings: `Cannot exceed the ${ctx.rescue.collectedServings} servings collected.` }) };
        }
        await apply(ctx, 'CONFIRM_DELIVERY', actor, {
          patch: { deliveredServings: input.deliveredServings, recipientConfirmedAt: ctx.now },
          metadata: { deliveredServings: input.deliveredServings, ...(input.notes ? { notes: input.notes } : {}) },
        });
        // Spec 7.1: RECIPIENT_CONFIRMED -> COMPLETED is a system step when no blocking incident exists
        // (checked above, in the same locked transaction).
        await apply(ctx, 'COMPLETE', null, {
          patch: { completedAt: ctx.now },
          notifyText: { title: `Rescue completed: ${listingTitle(ctx)}`, body: `${input.deliveredServings} servings were received. Thank you!` },
          notifyOrgs: [ctx.rescue.providerOrgId],
        });
        return { rescue: await view(ctx.rescue, 'ngo', ctx.now, ctx.tx, actor.id), changed: true };
      });
    },

    async adminCancel(actor: Actor, id: string, reason: string) {
      return withRescue(actor, id, 'admin', undefined, async (ctx) => {
        if (!nextRescueStatus(ctx.rescue.status, 'ADMIN_CANCEL')) return { error: invalidTransition(ctx.rescue.status, 'cancel it') };
        await apply(ctx, 'ADMIN_CANCEL', actor, {
          reason,
          notifyText: { title: `Rescue cancelled by FoodLoop: ${listingTitle(ctx)}`, body: `An administrator cancelled this rescue. Reason: ${reason}` },
        });
        await releaseListing(ctx);
        return { rescue: await view(ctx.rescue, 'admin', ctx.now, ctx.tx, actor.id) };
      });
    },

    /** Spec 1.1: completion needs recipient confirmation OR an explicit admin resolution with a reason. */
    async adminResolve(actor: Actor, id: string, input: { deliveredServings: number; reason: string }) {
      return withRescue(actor, id, 'admin', undefined, async (ctx) => {
        if (!nextRescueStatus(ctx.rescue.status, 'ADMIN_RESOLVE')) return { error: invalidTransition(ctx.rescue.status, 'resolve it') };
        if (input.deliveredServings > (ctx.rescue.collectedServings ?? 0)) {
          return { error: fieldErrors({ deliveredServings: `Cannot exceed the ${ctx.rescue.collectedServings} servings collected.` }) };
        }
        await apply(ctx, 'ADMIN_RESOLVE', actor, {
          reason: input.reason,
          patch: { deliveredServings: input.deliveredServings, completedAt: ctx.now, closedAt: ctx.now },
          metadata: { deliveredServings: input.deliveredServings },
          notifyText: { title: `Rescue resolved: ${listingTitle(ctx)}`, body: 'An administrator recorded the outcome of this rescue.' },
        });
        return { rescue: await view(ctx.rescue, 'admin', ctx.now, ctx.tx, actor.id) };
      });
    },

    /** An admin declares custody lost or delivery failed after pickup (never silently "successful"). */
    async adminFail(actor: Actor, id: string, reason: string) {
      return withRescue(actor, id, 'admin', undefined, async (ctx) => {
        if (!nextRescueStatus(ctx.rescue.status, 'ADMIN_FAIL')) return { error: invalidTransition(ctx.rescue.status, 'mark it failed') };
        await apply(ctx, 'ADMIN_FAIL', actor, {
          reason,
          notifyText: { title: `Delivery marked failed: ${listingTitle(ctx)}`, body: `An administrator recorded that this delivery failed. Reason: ${reason}` },
        });
        return { rescue: await view(ctx.rescue, 'admin', ctx.now, ctx.tx, actor.id) };
      });
    },

    /* ---------------- reads ---------------- */

    async get(actor: Actor, id: string) {
      const afterCommit: (() => Promise<void>)[] = [];
      const out = await db.transaction(async (tx) => {
        const [rescue] = await tx.select().from(rescues).where(eq(rescues.id, id)).for('update');
        if (!rescue) throw errors.notFound('Rescue not found.');
        const role = await partyOf(actor, rescue, tx);
        if (!role) throw errors.notFound('Rescue not found.');
        const [listing] = await tx.select().from(foodListings).where(eq(foodListings.id, rescue.listingId)).for('update');
        const ctx: Ctx = { tx, rescue, listing: listing!, now: clock(), afterCommit };
        await settle(ctx); // reads also record overdue expiry
        return view(ctx.rescue, role, ctx.now, tx, actor.id);
      });
      for (const job of afterCommit) await job().catch(() => undefined);
      return out;
    },

    async list(actor: Actor, query: { scope: 'active' | 'past' | 'all'; listingId?: string }) {
      let orgFilter;
      if (actor.platformRole === 'admin') {
        orgFilter = undefined; // admins see every rescue
      } else if (actor.platformRole === 'runner') {
        // Only rescues this runner holds or has held.
        orgFilter = sql`${rescues.id} IN (SELECT rescue_id FROM rescue_assignments WHERE runner_user_id = ${actor.id}::uuid)`;
      } else if (actor.platformRole === 'provider' || actor.platformRole === 'ngo') {
        const role = actor.platformRole;
        const memberOf = await db
          .select({ id: organizationMembers.organizationId })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.userId, actor.id), eq(organizationMembers.status, 'ACTIVE')));
        const ids = memberOf.map((m) => m.id);
        if (ids.length === 0) return [];
        orgFilter = role === 'provider' ? inArray(rescues.providerOrgId, ids) : inArray(rescues.ngoOrgId, ids);
      } else {
        throw errors.forbidden();
      }
      const rows = await db
        .select()
        .from(rescues)
        .where(and(orgFilter, query.listingId ? eq(rescues.listingId, query.listingId) : undefined))
        .orderBy(desc(rescues.reservedAt))
        .limit(200);
      const now = clock();
      const names = await orgNames(db, [...new Set(rows.flatMap((r) => [r.providerOrgId, r.ngoOrgId]))].filter(Boolean));
      const titles = rows.length
        ? new Map((await db.select({ id: foodListings.id, title: foodListings.title }).from(foodListings).where(inArray(foodListings.id, rows.map((r) => r.listingId)))).map((l) => [l.id, l.title]))
        : new Map<string, string>();
      return rows
        .map((r) => {
          const status = effectiveRescueStatus(r, now);
          return {
            id: r.id,
            status,
            version: r.version,
            transportMode: r.transportMode,
            listingId: r.listingId,
            listingTitle: titles.get(r.listingId) ?? '',
            providerName: names.get(r.providerOrgId) ?? '',
            ngoName: names.get(r.ngoOrgId) ?? '',
            servingsOffered: r.servingsOffered,
            collectedServings: r.collectedServings,
            deliveredServings: r.deliveredServings,
            reservedAt: r.reservedAt,
            nextAction: nextAction(status, r.transportMode),
            deadlines: { providerConfirmBy: r.providerConfirmBy, runnerBy: r.runnerBy, pickupBy: r.pickupBy, deliveryConfirmBy: r.deliveryConfirmBy },
          };
        })
        .filter((r) => (query.scope === 'all' ? true : query.scope === 'active' ? isActive(r.status) || r.status === 'DELIVERY_FAILED' : !isActive(r.status) && r.status !== 'DELIVERY_FAILED'));
    },

    /**
     * Worker entry point: records every expiry that is due. Idempotent: each rescue is locked and settled
     * in its own transaction; already-settled rescues no longer match the due filter.
     */
    async settleDue(now: Date = clock()) {
      const due = await db
        .select({ id: rescues.id })
        .from(rescues)
        .where(
          or(
            and(eq(rescues.status, 'RESERVED'), sql`${rescues.providerConfirmBy} <= ${now}`),
            and(eq(rescues.status, 'AWAITING_RUNNER'), sql`${rescues.runnerBy} <= ${now}`),
            and(eq(rescues.status, 'PICKUP_ASSIGNED'), sql`${rescues.pickupBy} <= ${now}`),
            and(inArray(rescues.status, ['PICKUP_CONFIRMED', 'IN_TRANSIT', 'DELIVERED']), sql`${rescues.deliveryConfirmBy} <= ${now}`),
          ),
        )
        .limit(500);
      let settled = 0;
      for (const { id } of due) {
        const afterCommit: (() => Promise<void>)[] = [];
        const changed = await db.transaction(async (tx) => {
          const [rescue] = await tx.select().from(rescues).where(eq(rescues.id, id)).for('update');
          if (!rescue) return false;
          const [listing] = await tx.select().from(foodListings).where(eq(foodListings.id, rescue.listingId)).for('update');
          return settle({ tx, rescue, listing: listing!, now, afterCommit });
        });
        for (const job of afterCommit) await job().catch(() => undefined);
        if (changed) settled += 1;
      }
      return settled;
    },
  };
}

export type RescueService = ReturnType<typeof createRescueService>;
export type RescueInternals = RescueService['internals'];

/** In-process scheduler (no Redis/queue in V1). Correctness does not depend on it: reads and transitions settle too. */
export function startRescueWorker(service: RescueService, intervalSeconds: number, log: (msg: string) => void = console.log, guard: Guard = unguarded) {
  if (intervalSeconds <= 0) return () => undefined;
  const run = async () => {
    try {
      await guard(async () => {
        const n = await service.settleDue();
        if (n > 0) log(JSON.stringify({ level: 'info', msg: 'Settled overdue rescues', count: n }));
      });
    } catch (err) {
      log(JSON.stringify({ level: 'error', msg: 'Rescue settlement failed', ...describeError(err) }));
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

// Re-exported for the runner and incident modules.
export { BLOCKED_COMMANDS };
