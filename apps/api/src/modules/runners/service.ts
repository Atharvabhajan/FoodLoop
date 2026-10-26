import { and, eq, sql } from 'drizzle-orm';
import type { MatchSettings } from '../../config.js';
import {
  foodListings,
  notifications,
  rescueAssignments,
  rescueLocations,
  rescues,
  volunteerProfiles,
  type VehicleType,
} from '../../db/schema.js';
import { AppError, errors, fieldErrors } from '../../http/errors.js';
import { urgencyFor } from '../listings/constants.js';
import type { Reason } from '../matching/engine.js';
import { effectiveRescueStatus, runnerSearchDeadline, TRACKING_STATUSES } from '../rescues/lifecycle.js';
import { invalidTransition, type Actor, type Ctx, type RescueInternals, type Tx } from '../rescues/service.js';
import { evaluateRunner, requiredKg, type RunnerFacts } from './eligibility.js';

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const km1 = (m: number | null) => (m === null ? null : Math.round(m / 100) / 10);

interface PairRow {
  availability_status: 'OFFLINE' | 'AVAILABLE' | 'BUSY' | null;
  vehicle_type: string | null;
  capacity_kg: number | null;
  radius_km: number | null;
  has_geog: boolean;
  distance_m: number | null;
  within_radius: boolean | null;
  leg_m: number | null;
  estimated_kg: number | null;
  servings: number;
  pickup_start: Date;
  pickup_deadline: Date;
  listing_has_geog: boolean;
  busy: boolean;
  released: boolean;
}

export function createRunnerService(core: RescueInternals, match: MatchSettings) {
  const { db, settings, clock } = core;
  const platformKm = match.searchRadiusKm;

  const needRunner = (actor: Actor) => {
    if (actor.platformRole !== 'runner') throw errors.forbidden();
  };

  /** Live eligibility of one runner for one rescue, using PostGIS for distance and radius. */
  async function evaluatePair(tx: Tx | typeof db, rescueId: string, runnerId: string, now: Date) {
    const r = await tx.execute(sql`
      SELECT vp.availability_status, vp.vehicle_type, vp.capacity_kg, vp.radius_km,
             (vp.geog IS NOT NULL) AS has_geog,
             CASE WHEN vp.geog IS NULL OR l.geog IS NULL THEN NULL ELSE ST_Distance(vp.geog, l.geog) END AS distance_m,
             (vp.geog IS NOT NULL AND l.geog IS NOT NULL AND vp.radius_km IS NOT NULL
                AND ST_DWithin(vp.geog, l.geog, LEAST(vp.radius_km, ${platformKm}::float8) * 1000)) AS within_radius,
             CASE WHEN l.geog IS NULL OR o.geog IS NULL THEN NULL ELSE ST_Distance(l.geog, o.geog) END AS leg_m,
             l.estimated_kg, l.servings, l.pickup_start, l.pickup_deadline, (l.geog IS NOT NULL) AS listing_has_geog,
             EXISTS (SELECT 1 FROM rescue_assignments a WHERE a.runner_user_id = ${runnerId}::uuid AND a.status = 'ACTIVE' AND a.rescue_id <> r.id) AS busy,
             EXISTS (SELECT 1 FROM rescue_assignments a WHERE a.runner_user_id = ${runnerId}::uuid AND a.rescue_id = r.id AND a.status IN ('RELEASED', 'REVOKED')) AS released
        FROM rescues r
        JOIN food_listings l ON l.id = r.listing_id
        JOIN organizations o ON o.id = r.ngo_org_id
        LEFT JOIN volunteer_profiles vp ON vp.user_id = ${runnerId}::uuid
       WHERE r.id = ${rescueId}::uuid`);
    const row = r.rows[0] as PairRow | undefined;
    if (!row) return null;
    const facts: RunnerFacts = {
      availability: row.availability_status,
      vehicleType: row.vehicle_type,
      capacityKg: row.capacity_kg,
      radiusKm: row.radius_km,
      hasCoordinates: row.has_geog && row.listing_has_geog,
      distanceM: row.distance_m,
      withinRadius: row.within_radius,
      busy: row.busy,
      previouslyReleased: row.released,
    };
    const job = {
      requiredKg: requiredKg({ estimatedKg: row.estimated_kg, servings: row.servings }, settings.kgPerServing),
      pickupStart: new Date(row.pickup_start),
      pickupDeadline: new Date(row.pickup_deadline),
    };
    const ev = evaluateRunner(job, facts, now, match);
    return { ev, row, job };
  }

  /** (Re)starts the search for a runner: records the start and notifies every eligible, available runner once. */
  async function startSearch(ctx: Ctx) {
    const nearby = await ctx.tx.execute(sql`
      SELECT vp.user_id
        FROM volunteer_profiles vp
        JOIN users u ON u.id = vp.user_id AND u.status = 'ACTIVE'
        JOIN food_listings l ON l.id = ${ctx.listing.id}::uuid
       WHERE vp.availability_status = 'AVAILABLE' AND vp.geog IS NOT NULL AND l.geog IS NOT NULL
         AND ST_DWithin(vp.geog, l.geog, ${platformKm * 1000}::float8)`);
    const eligible: string[] = [];
    for (const { user_id } of nearby.rows as { user_id: string }[]) {
      const e = await evaluatePair(ctx.tx, ctx.rescue.id, user_id, ctx.now);
      if (e && e.ev.reasons.length === 0) eligible.push(user_id);
    }
    const eventId = await core.recordEvent(ctx, {
      rescueId: ctx.rescue.id,
      eventType: 'RUNNER_SEARCH_STARTED',
      from: null,
      to: null,
      actor: null,
      metadata: { eligibleRunners: eligible.length, searchEndsAt: ctx.rescue.runnerBy?.toISOString() ?? null },
    });
    if (eligible.length > 0) {
      await ctx.tx
        .insert(notifications)
        .values(
          eligible.map((userId) => ({
            userId,
            type: 'RUNNER_JOB',
            title: `New delivery job near you: ${ctx.listing.title}`,
            body: `${ctx.rescue.servingsOffered} servings in ${ctx.listing.city}. Open Jobs to review and accept.`,
            entityType: 'rescue',
            entityId: ctx.rescue.id,
            dedupeKey: `runner-job:${eventId}:${userId}`,
          })),
        )
        .onConflictDoNothing({ target: notifications.dedupeKey });
      core.emit(ctx, eligible, ctx.rescue.id);
    }
  }
  core.setRunnerNeededHandler(startSearch);

  const heldBy = async (tx: Tx, rescueId: string, runnerId: string) => {
    const a = await core.activeAssignment(tx, rescueId);
    return a?.runnerUserId === runnerId ? a : null;
  };

  return {
    /* ---------------- profile ---------------- */

    async getProfile(actor: Actor) {
      needRunner(actor);
      const r = await db.execute(sql`
        SELECT availability_status, vehicle_type, capacity_kg, radius_km, latitude, longitude,
               EXISTS (SELECT 1 FROM rescue_assignments a WHERE a.runner_user_id = user_id AND a.status = 'ACTIVE') AS busy
          FROM volunteer_profiles WHERE user_id = ${actor.id}::uuid`);
      const p = r.rows[0] as
        | { availability_status: string; vehicle_type: string | null; capacity_kg: number | null; radius_km: number | null; latitude: number | null; longitude: number | null; busy: boolean }
        | undefined;
      return {
        profile: {
          availabilityStatus: p?.availability_status ?? 'OFFLINE',
          vehicleType: p?.vehicle_type ?? null,
          capacityKg: p?.capacity_kg ?? null,
          radiusKm: p?.radius_km ?? null,
          latitude: p?.latitude ?? null,
          longitude: p?.longitude ?? null,
          busy: p?.busy ?? false,
          complete: !!(p?.vehicle_type && p?.capacity_kg && p?.radius_km && p?.latitude != null),
        },
        precisionNote: 'Your base location is stored rounded to about 1 km and is used only to decide which jobs you are offered.',
      };
    },

    async saveProfile(
      actor: Actor,
      input: { availabilityStatus: 'OFFLINE' | 'AVAILABLE'; vehicleType: VehicleType | null; capacityKg: number | null; radiusKm: number | null; latitude: number | null; longitude: number | null },
    ) {
      needRunner(actor);
      if (input.availabilityStatus === 'AVAILABLE') {
        const missing: Record<string, string> = {};
        if (!input.vehicleType) missing.vehicleType = 'Choose how you travel.';
        if (!input.capacityKg) missing.capacityKg = 'Enter how much you can carry.';
        if (!input.radiusKm) missing.radiusKm = 'Enter how far you will travel.';
        if (input.latitude === null || input.longitude === null) missing.latitude = 'Add your base location.';
        if (Object.keys(missing).length > 0) throw fieldErrors(missing);
      }
      // Minimize precision at the door: about 1 km is plenty for "which jobs are near me".
      const lat = input.latitude === null ? null : round(input.latitude, 2);
      const lng = input.longitude === null ? null : round(input.longitude, 2);
      if ((lat === null) !== (lng === null)) throw fieldErrors({ latitude: 'Provide both latitude and longitude, or neither.' });
      const values = {
        availabilityStatus: input.availabilityStatus,
        vehicleType: input.vehicleType,
        capacityKg: input.capacityKg,
        radiusKm: input.radiusKm,
        latitude: lat,
        longitude: lng,
        updatedAt: clock(),
      };
      await db.insert(volunteerProfiles).values({ userId: actor.id, ...values }).onConflictDoUpdate({ target: volunteerProfiles.userId, set: values });
      return this.getProfile(actor);
    },

    /* ---------------- discovery ---------------- */

    /** Jobs this runner may accept right now. Approximate locations only; exact details follow acceptance. */
    async availableRuns(actor: Actor) {
      needRunner(actor);
      const now = clock();
      const found = await db.execute(sql`
        SELECT r.id
          FROM rescues r
          JOIN food_listings l ON l.id = r.listing_id
          JOIN volunteer_profiles vp ON vp.user_id = ${actor.id}::uuid
         WHERE r.status = 'AWAITING_RUNNER' AND r.transport_mode = 'RUNNER' AND r.runner_by > ${now}
           AND l.geog IS NOT NULL AND vp.geog IS NOT NULL
           AND ST_DWithin(vp.geog, l.geog, ${platformKm * 1000}::float8)
         ORDER BY l.pickup_deadline ASC, r.id ASC
         LIMIT 50`);
      const jobs = [];
      for (const { id } of found.rows as { id: string }[]) {
        const e = await evaluatePair(db, id, actor.id, now);
        if (!e || e.ev.reasons.length > 0) continue; // a runner only ever sees jobs they could accept
        const [row] = await db
          .select({ r: rescues, l: foodListings })
          .from(rescues)
          .innerJoin(foodListings, eq(foodListings.id, rescues.listingId))
          .where(eq(rescues.id, id));
        const info = await db.execute(sql`
          SELECT po.name AS provider_name, no.name AS ngo_name, no.city AS ngo_city,
                 round(no.latitude::numeric, 2)::float8 AS ngo_lat, round(no.longitude::numeric, 2)::float8 AS ngo_lng
            FROM rescues r JOIN organizations po ON po.id = r.provider_org_id JOIN organizations no ON no.id = r.ngo_org_id
           WHERE r.id = ${id}::uuid`);
        const o = info.rows[0] as { provider_name: string; ngo_name: string; ngo_city: string | null; ngo_lat: number | null; ngo_lng: number | null };
        const l = row!.l;
        jobs.push({
          rescueId: id,
          listingTitle: l.title,
          foodCategory: l.foodCategory,
          servings: row!.r.servingsOffered,
          estimatedKg: l.estimatedKg,
          loadKg: e.job.requiredKg,
          packaging: l.packaging,
          pickupStart: l.pickupStart,
          pickupDeadline: l.pickupDeadline,
          searchEndsAt: row!.r.runnerBy,
          urgency: urgencyFor(l.pickupDeadline, now),
          providerName: o.provider_name,
          ngoName: o.ngo_name,
          pickupArea: { city: l.city, latitude: l.latitude === null ? null : round(l.latitude, 2), longitude: l.longitude === null ? null : round(l.longitude, 2) },
          destinationArea: { city: o.ngo_city, latitude: o.ngo_lat, longitude: o.ngo_lng },
          estimates: {
            runnerToPickupKm: km1(e.row.distance_m),
            pickupToNgoKm: km1(e.row.leg_m),
            runnerToPickupMinutes: e.ev.travelMinutes,
            marginMinutes: e.ev.marginMinutes,
            note: 'Straight-line distances and estimated times only; not a route.',
          },
        });
      }
      return jobs;
    },

    /* ---------------- claim / release / handover ---------------- */

    /**
     * A runner claims an AWAITING_RUNNER rescue. Row lock + two partial unique indexes (one active assignment per
     * rescue and per runner) mean concurrent claims cannot both win. Repeating the claim is a no-op.
     */
    async assignSelf(actor: Actor, rescueId: string) {
      needRunner(actor);
      const afterCommit: (() => Promise<void>)[] = [];
      try {
        const out = await db.transaction(async (tx) => {
          const [rescue] = await tx.select().from(rescues).where(eq(rescues.id, rescueId)).for('update');
          if (!rescue) throw errors.notFound('Rescue not found.');
          const [listing] = await tx.select().from(foodListings).where(eq(foodListings.id, rescue.listingId)).for('update');
          const ctx: Ctx = { tx, rescue, listing: listing!, now: clock(), afterCommit };
          await core.settle(ctx);

          // Failures after settle() are RETURNED, not thrown, so an expiry just recorded by settle() still commits.
          const mine = await heldBy(tx, ctx.rescue.id, actor.id);
          if (mine) return { ctx, changed: false };
          if (ctx.rescue.transportMode !== 'RUNNER') throw errors.notFound('Rescue not found.'); // not a runner job: invisible to runners
          if (ctx.rescue.status !== 'AWAITING_RUNNER') {
            return { ctx, changed: false, error: new AppError(409, 'RESCUE_NOT_AVAILABLE', 'This job is no longer available.', { status: ctx.rescue.status }) };
          }
          if (await core.hasBlockingIncident(tx, ctx.rescue.id)) return { ctx, changed: false, error: core.blockedByIncident() };

          const e = await evaluatePair(tx, ctx.rescue.id, actor.id, ctx.now);
          if (!e || e.ev.reasons.length > 0) {
            return { ctx, changed: false, error: new AppError(409, 'NOT_ELIGIBLE', 'You are not eligible to accept this job.', { reasons: e?.ev.reasons ?? ([] as Reason[]) }) };
          }
          await tx.insert(rescueAssignments).values({ rescueId: ctx.rescue.id, runnerUserId: actor.id, status: 'ACTIVE', acceptedAt: ctx.now });
          await core.apply(ctx, 'RUNNER_ACCEPT', actor, {
            patch: { runnerBy: null },
            metadata: { estimatedRunnerToPickupKm: km1(e.row.distance_m), estimatedTravelMinutes: e.ev.travelMinutes },
            notifyText: { title: `A runner accepted: ${ctx.listing.title}`, body: 'A volunteer runner will collect the food. Their name and phone are on the rescue page.' },
          });
          return { ctx, changed: true };
        });
        for (const job of afterCommit) await job().catch(() => undefined);
        if ('error' in out && out.error) throw out.error;
        return { changed: out.changed, rescue: await core.view(out.ctx.rescue, 'runner', clock(), db, actor.id) };
      } catch (err) {
        const e = err as { cause?: { code?: string; constraint?: string }; code?: string };
        if ((e.cause?.code ?? e.code) === '23505') {
          const busy = (e.cause?.constraint ?? '').includes('per_runner');
          throw new AppError(409, busy ? 'ALREADY_BUSY' : 'RESCUE_NOT_AVAILABLE', busy ? 'You are already assigned to another rescue.' : 'Another runner just accepted this job.');
        }
        throw err;
      }
    },

    /** The assigned runner steps away before collecting. The rescue goes back to searching; this runner is not re-offered it. */
    async release(actor: Actor, id: string, reason: string, expectedVersion?: number) {
      needRunner(actor);
      return core.withRescue(actor, id, 'runner', expectedVersion, async (ctx) => {
        const held = await heldBy(ctx.tx, ctx.rescue.id, actor.id);
        if (!held) {
          const prior = await db.select({ s: rescueAssignments.status }).from(rescueAssignments).where(and(eq(rescueAssignments.rescueId, ctx.rescue.id), eq(rescueAssignments.runnerUserId, actor.id)));
          if (prior.some((p) => p.s === 'RELEASED')) return { rescue: await core.view(ctx.rescue, 'runner', ctx.now, ctx.tx, actor.id), changed: false };
          return { error: new AppError(409, 'NOT_ASSIGNED', 'You are not assigned to this rescue.') };
        }
        if (ctx.rescue.status !== 'PICKUP_ASSIGNED') {
          return { error: new AppError(409, 'CANNOT_RELEASE', 'You have already collected the food. Report an incident if something is wrong.', { status: ctx.rescue.status }) };
        }
        await core.apply(ctx, 'RUNNER_RELEASE', actor, {
          reason,
          patch: { runnerBy: runnerSearchDeadline(ctx.now, ctx.listing.pickupDeadline, settings) },
          notifyText: { title: `Runner stepped away: ${ctx.listing.title}`, body: `The runner can no longer collect this. We are looking for another one. Reason: ${reason}` },
        });
        await startSearch(ctx);
        return { rescue: await core.view(ctx.rescue, 'runner', ctx.now, ctx.tx, actor.id), changed: true };
      });
    },

    /** The runner records handing the food to the NGO. This does NOT complete the rescue: the NGO must confirm receipt. */
    async handover(actor: Actor, id: string, note?: string, expectedVersion?: number) {
      needRunner(actor);
      return core.withRescue(actor, id, 'runner', expectedVersion, async (ctx) => {
        if (['DELIVERED', 'RECIPIENT_CONFIRMED', 'COMPLETED'].includes(ctx.rescue.status)) return { rescue: await core.view(ctx.rescue, 'runner', ctx.now, ctx.tx, actor.id), changed: false };
        if (ctx.rescue.status !== 'IN_TRANSIT') return { error: invalidTransition(ctx.rescue.status, 'record the handover') };
        if (!(await heldBy(ctx.tx, ctx.rescue.id, actor.id))) return { error: new AppError(409, 'NOT_ASSIGNED', 'You are not assigned to this rescue.') };
        if (await core.hasBlockingIncident(ctx.tx, ctx.rescue.id)) return { error: core.blockedByIncident() };
        await core.apply(ctx, 'RUNNER_HANDOVER', actor, {
          patch: { handedOverAt: ctx.now, deliveryConfirmBy: new Date(ctx.now.getTime() + settings.deliveryConfirmHours * 3_600_000) },
          metadata: { ...(note ? { note } : {}), collectedServings: ctx.rescue.collectedServings },
          notifyText: { title: `Food delivered: ${ctx.listing.title}`, body: 'The runner says the food has been handed over. Please confirm how many servings you received.' },
          notifyOrgs: [ctx.rescue.ngoOrgId, ctx.rescue.providerOrgId],
        });
        return { rescue: await core.view(ctx.rescue, 'runner', ctx.now, ctx.tx, actor.id), changed: true };
      });
    },

    /** NGO gives up waiting for a runner and collects the food itself (direct pickup). */
    async collectMyself(actor: Actor, id: string, expectedVersion?: number) {
      return core.withRescue(actor, id, 'ngo', expectedVersion, async (ctx) => {
        if (ctx.rescue.transportMode === 'NGO_PICKUP' && ctx.rescue.status === 'PICKUP_ASSIGNED') return { rescue: await core.view(ctx.rescue, 'ngo', ctx.now, ctx.tx, actor.id), changed: false };
        if (ctx.rescue.status !== 'AWAITING_RUNNER') return { error: invalidTransition(ctx.rescue.status, 'switch to collecting it yourself') };
        await core.apply(ctx, 'SWITCH_TO_SELF', actor, {
          patch: { transportMode: 'NGO_PICKUP', runnerBy: null },
          notifyText: { title: `NGO will collect it: ${ctx.listing.title}`, body: 'The NGO chose to collect the food itself, so no runner is needed.' },
          notifyOrgs: [ctx.rescue.providerOrgId],
        });
        return { rescue: await core.view(ctx.rescue, 'ngo', ctx.now, ctx.tx, actor.id), changed: true };
      });
    },

    /** Admin removes the current runner (e.g. unresponsive) and restarts the search. */
    async adminReassign(actor: Actor, id: string, reason: string) {
      return core.withRescue(actor, id, 'admin', undefined, async (ctx) => {
        if (ctx.rescue.status !== 'PICKUP_ASSIGNED' || ctx.rescue.transportMode !== 'RUNNER') return { error: invalidTransition(ctx.rescue.status, 'reassign the runner') };
        if (!(await core.activeAssignment(ctx.tx, ctx.rescue.id))) return { error: new AppError(409, 'NOT_ASSIGNED', 'No runner is assigned.') };
        await core.apply(ctx, 'ADMIN_REASSIGN', actor, {
          reason,
          patch: { runnerBy: runnerSearchDeadline(ctx.now, ctx.listing.pickupDeadline, settings) },
          notifyText: { title: `Runner reassigned: ${ctx.listing.title}`, body: `An administrator replaced the runner. We are looking for another. Reason: ${reason}` },
        });
        await startSearch(ctx);
        return { rescue: await core.view(ctx.rescue, 'admin', ctx.now, ctx.tx, actor.id) };
      });
    },

    /* ---------------- location (minimal, short-lived) ---------------- */

    /**
     * The assigned runner shares their current position. Only the LATEST point is kept (no trail), rounded to
     * about 100 m, and only while they are en route (PICKUP_ASSIGNED or IN_TRANSIT). Rate limited per runner.
     */
    async updateLocation(actor: Actor, id: string, input: { latitude: number; longitude: number }) {
      needRunner(actor);
      return core.withRescue(actor, id, 'runner', undefined, async (ctx) => {
        if (!(await heldBy(ctx.tx, ctx.rescue.id, actor.id)) || !TRACKING_STATUSES.includes(ctx.rescue.status)) {
          return { error: new AppError(409, 'TRACKING_NOT_ACTIVE', 'Location sharing is only available while you are collecting or delivering this rescue.') };
        }
        const [prev] = await ctx.tx.select().from(rescueLocations).where(eq(rescueLocations.rescueId, ctx.rescue.id));
        if (prev && ctx.now.getTime() - prev.recordedAt.getTime() < settings.locationMinIntervalSeconds * 1000) {
          return { error: new AppError(429, 'RATE_LIMITED', `Location updates are limited to one every ${settings.locationMinIntervalSeconds} seconds.`) };
        }
        const values = { latitude: round(input.latitude, 3), longitude: round(input.longitude, 3), recordedAt: ctx.now, runnerUserId: actor.id };
        await ctx.tx.insert(rescueLocations).values({ rescueId: ctx.rescue.id, ...values }).onConflictDoUpdate({ target: rescueLocations.rescueId, set: values });
        return { recordedAt: ctx.now, precision: 'about 100 m' };
      });
    },

    /** The assigned runner stops sharing and removes the stored point right away (it would also be deleted when the stage ends). */
    async clearLocation(actor: Actor, id: string) {
      needRunner(actor);
      return core.withRescue(actor, id, 'runner', undefined, async (ctx) => {
        if (!(await heldBy(ctx.tx, ctx.rescue.id, actor.id))) {
          return { error: new AppError(409, 'NOT_ASSIGNED', 'Only the assigned runner can stop sharing a position.') };
        }
        await ctx.tx.delete(rescueLocations).where(eq(rescueLocations.rescueId, ctx.rescue.id));
        return { cleared: true };
      });
    },

    /** Provider, accepting NGO and admins may read the runner's latest position, only while tracking is active. */
    async readLocation(actor: Actor, id: string) {
      const [rescue] = await db.select().from(rescues).where(eq(rescues.id, id));
      if (!rescue) throw errors.notFound('Rescue not found.');
      const party = await core.partyOf(actor, rescue, db);
      if (!party || party === 'runner') throw errors.notFound('Rescue not found.'); // runners do not read positions back
      const now = clock();
      // Judge by the effective status, so an overdue rescue never exposes a stale position.
      const status = effectiveRescueStatus(rescue, now);
      const none = (reason: string) => ({ location: null, reason, precision: 'about 100 m' });
      if (rescue.transportMode !== 'RUNNER') return none('NO_RUNNER');
      if (!TRACKING_STATUSES.includes(status)) return none('NOT_TRACKING');
      const [row] = await db.select().from(rescueLocations).where(eq(rescueLocations.rescueId, id));
      if (!row) return none('NO_LOCATION_SHARED');
      const ageMs = now.getTime() - row.recordedAt.getTime();
      if (ageMs > settings.locationMaxAgeMinutes * 60_000) return none('LOCATION_STALE');
      return { location: { latitude: row.latitude, longitude: row.longitude, recordedAt: row.recordedAt, ageSeconds: Math.round(ageMs / 1000) }, precision: 'about 100 m' };
    },

    startSearch,
    evaluatePair,
  };
}

export type RunnerService = ReturnType<typeof createRunnerService>;
