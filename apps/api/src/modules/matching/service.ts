import { and, asc, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import type { MatchSettings } from '../../config.js';
import type { Db } from '../../db/client.js';
import {
  foodListings,
  matchCandidates,
  notifications,
  ngoRequirements,
  organizationMembers,
  organizations,
  type FoodCategory,
  type PlatformRole,
} from '../../db/schema.js';
import { AppError, errors } from '../../http/errors.js';
import { assertOrganizationVerified } from '../organizations/guards.js';
import { activeOrganizations, isActiveMember } from '../organizations/membership.js';
import { urgencyFor } from '../listings/constants.js';
import { serializePublicListing } from '../listings/service.js';
import { GENERIC_REASONS, compareRank, evaluate, explain, scoreCandidate, type Breakdown, type ListingFacts, type NgoFacts, type Reason, type RequirementFacts } from './engine.js';

export interface Actor {
  id: string;
  platformRole: PlatformRole;
}

type Clock = () => Date;

export type UnavailableReason = 'LISTING_NOT_AVAILABLE' | 'LISTING_NO_COORDINATES';

export interface RecomputeResult {
  matchable: boolean;
  unavailableReason?: UnavailableReason;
  evaluated: number;
  eligible: number;
}

const CATEGORY_LABEL = (c: string) => c.toLowerCase().replace(/_/g, ' ');

/** A missing PostGIS type/function means the spatial setup is absent; report it as unavailable, not a crash. */
function spatialGuard(err: unknown): never {
  const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
  if (code === '42883' || code === '42704' || code === '58P01') {
    throw new AppError(503, 'SPATIAL_UNAVAILABLE', 'Matching is temporarily unavailable (spatial support is not installed).');
  }
  throw err;
}

interface Row {
  org_id: string;
  name: string;
  city: string | null;
  has_geog: boolean;
  distance_m: number | null;
  within_service_radius: boolean | null;
  req_id: string | null;
  food_categories: FoodCategory[] | null;
  needed_servings: number | null;
  capacity_servings: number | null;
  service_radius_km: number | null;
  available_from: Date | null;
  available_to: Date | null;
  intake_enabled: boolean | null;
  dietary_must_have: string[] | null;
  dietary_must_avoid: string[] | null;
}

function toRequirement(row: Row): RequirementFacts | null {
  return row.req_id
    ? {
        foodCategories: row.food_categories!,
        neededServings: row.needed_servings!,
        capacityServings: row.capacity_servings!,
        serviceRadiusKm: row.service_radius_km!,
        availableFrom: new Date(row.available_from!),
        availableTo: new Date(row.available_to!),
        intakeEnabled: row.intake_enabled!,
        dietaryMustHave: row.dietary_must_have ?? [],
        dietaryMustAvoid: row.dietary_must_avoid ?? [],
      }
    : null;
}

const declinedReason: Reason = {
  code: 'PREVIOUSLY_DECLINED',
  message: 'An earlier rescue of this listing by your organization ended before pickup (cancelled, declined or not confirmed in time).',
};

/** NGOs whose earlier rescue of this listing ended before pickup are not offered it again (avoids accept/cancel loops). */
async function declinedOrgs(exec: Pick<Db, 'execute'>, listingId: string): Promise<Set<string>> {
  const r = await exec.execute(sql`
    SELECT DISTINCT ngo_org_id FROM rescues
     WHERE listing_id = ${listingId}::uuid AND status IN ('CANCELLED', 'EXPIRED') AND picked_up_at IS NULL`);
  return new Set((r.rows as { ngo_org_id: string }[]).map((x) => x.ngo_org_id));
}

export interface MatchingOptions {
  /**
   * Notify every eligible NGO as soon as candidates are computed (the behaviour before escalation waves existed). Off by
   * default: with waves, notification is the escalation service's job, wave by wave. Turned on only when
   * ESCALATION_ENABLED=false.
   */
  notifyOnRecompute?: boolean;
}

/** The text an NGO's member is sent about a listing (shared by the immediate path and the escalation waves). */
export function listingMatchNotification(l: { title: string; servings: number; foodCategory: string; city: string; pickupDeadline: Date }) {
  return {
    title: `New food listing near you: ${l.title}`,
    body: `${l.servings} servings of ${CATEGORY_LABEL(l.foodCategory)} in ${l.city}. Pickup by ${l.pickupDeadline.toISOString()}.`,
  };
}

export function createMatchingService(db: Db, settings: MatchSettings, clock: Clock = () => new Date(), options: MatchingOptions = {}) {
  const estimateInfo = () => ({
    basis: 'STRAIGHT_LINE_DISTANCE_ESTIMATE',
    roadDistanceFactor: settings.roadDistanceFactor,
    avgSpeedKmh: settings.avgSpeedKmh,
    dispatchBufferMinutes: settings.dispatchBufferMinutes,
    searchRadiusKm: settings.searchRadiusKm,
    note: 'Distances are straight-line (geodesic). Road distance and travel time are estimates, not routes or guaranteed arrival times.',
  });

  /** Recomputes and persists the recommendations for one listing. Idempotent. */
  async function recomputeListing(listingId: string, now: Date = clock()): Promise<RecomputeResult> {
    try {
      return await db.transaction(async (tx) => {
        // Serialize concurrent recomputations of the same listing.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`match:${listingId}`}))`);
        const lr = await tx.execute(sql`
          SELECT id, title, food_category, servings, dietary_tags, pickup_start, pickup_deadline, city, status,
                 (geog IS NOT NULL) AS has_geog
            FROM food_listings WHERE id = ${listingId}::uuid`);
        const l = lr.rows[0] as
          | { id: string; title: string; food_category: FoodCategory; servings: number; dietary_tags: string[]; pickup_start: Date; pickup_deadline: Date; city: string; status: string; has_geog: boolean }
          | undefined;
        if (!l) throw errors.notFound('Listing not found.');

        // Expired, cancelled and draft listings never enter matching.
        if (l.status !== 'AVAILABLE' || new Date(l.pickup_deadline) <= now) {
          return { matchable: false, unavailableReason: 'LISTING_NOT_AVAILABLE' as const, evaluated: 0, eligible: 0 };
        }
        if (!l.has_geog) {
          await tx.delete(matchCandidates).where(eq(matchCandidates.listingId, listingId));
          return { matchable: false, unavailableReason: 'LISTING_NO_COORDINATES' as const, evaluated: 0, eligible: 0 };
        }

        const facts: ListingFacts = {
          servings: l.servings,
          foodCategory: l.food_category,
          dietaryTags: l.dietary_tags,
          pickupStart: new Date(l.pickup_start),
          pickupDeadline: new Date(l.pickup_deadline),
        };
        const platformM = settings.searchRadiusKm * 1000;

        // Nearby lookup: ST_DWithin on the GiST-indexed organizations.geog narrows to NGOs inside the
        // platform radius (plus NGOs with no coordinates, which are recorded as ineligible).
        const found = await tx.execute(sql`
          SELECT o.id AS org_id, o.name, o.city,
                 (o.geog IS NOT NULL) AS has_geog,
                 CASE WHEN o.geog IS NULL THEN NULL ELSE ST_Distance(o.geog, l.geog) END AS distance_m,
                 (o.geog IS NOT NULL AND r.id IS NOT NULL AND ST_DWithin(o.geog, l.geog, r.service_radius_km * 1000)) AS within_service_radius,
                 r.id AS req_id, r.food_categories::text[] AS food_categories, r.needed_servings, r.capacity_servings,
                 r.service_radius_km, r.available_from, r.available_to, r.intake_enabled,
                 r.dietary_must_have, r.dietary_must_avoid
            FROM food_listings l
            JOIN organizations o ON o.type = 'NGO' AND o.verification_status = 'VERIFIED'
            LEFT JOIN ngo_requirements r ON r.ngo_org_id = o.id
           WHERE l.id = ${listingId}::uuid
             AND (o.geog IS NULL OR ST_DWithin(o.geog, l.geog, ${platformM}::float8))
           ORDER BY o.id`);

        const declined = await declinedOrgs(tx, listingId);
        const evaluated = (found.rows as unknown as Row[]).map((row) => {
          const requirement = toRequirement(row);
          const ngo: NgoFacts = {
            hasCoordinates: row.has_geog,
            distanceM: row.distance_m,
            withinServiceRadius: row.within_service_radius,
            requirement,
          };
          const ev = evaluate(facts, ngo, now, settings);
          if (declined.has(row.org_id)) ev.reasons.push(declinedReason);
          if (ev.reasons.length > 0 || !requirement || !ev.travel) {
            return { orgId: row.org_id, eligible: false as const, reasons: ev.reasons, distanceM: row.distance_m, travel: ev.travel };
          }
          // No rescue history exists yet, so reliability is the documented neutral default.
          const input = { listing: facts, requirement, travel: ev.travel, history: null };
          const scored = scoreCandidate(input, now, settings);
          return {
            orgId: row.org_id,
            eligible: true as const,
            reasons: explain(input, settings, now),
            distanceM: row.distance_m!,
            travel: ev.travel,
            score: scored.score,
            breakdown: scored.breakdown,
          };
        });

        const ranked = evaluated
          .filter((e): e is Extract<typeof e, { eligible: true }> => e.eligible)
          .sort((a, b) => compareRank({ organizationId: a.orgId, score: a.score, distanceM: a.distanceM }, { organizationId: b.orgId, score: b.score, distanceM: b.distanceM }));
        const rankOf = new Map(ranked.map((e, i) => [e.orgId, i + 1]));

        if (evaluated.length > 0) {
          await tx
            .insert(matchCandidates)
            .values(
              evaluated.map((e) => ({
                listingId,
                ngoOrgId: e.orgId,
                eligible: e.eligible,
                score: e.eligible ? e.score : null,
                rank: rankOf.get(e.orgId) ?? null,
                distanceM: e.distanceM,
                estimatedTravelMinutes: e.travel ? e.travel.travelMinutes : null,
                marginMinutes: e.travel ? e.travel.marginMinutes : null,
                breakdown: e.eligible ? e.breakdown : null,
                reasons: e.reasons,
                computedAt: now,
              })),
            )
            .onConflictDoUpdate({
              target: [matchCandidates.listingId, matchCandidates.ngoOrgId],
              set: {
                eligible: sql`excluded.eligible`,
                score: sql`excluded.score`,
                rank: sql`excluded.rank`,
                distanceM: sql`excluded.distance_m`,
                estimatedTravelMinutes: sql`excluded.estimated_travel_minutes`,
                marginMinutes: sql`excluded.margin_minutes`,
                breakdown: sql`excluded.breakdown`,
                reasons: sql`excluded.reasons`,
                computedAt: sql`excluded.computed_at`,
              },
            });
        }
        // Drop rows for NGOs no longer evaluated (moved out of range, unverified, ...).
        await tx
          .delete(matchCandidates)
          .where(
            evaluated.length > 0
              ? and(eq(matchCandidates.listingId, listingId), notInArray(matchCandidates.ngoOrgId, evaluated.map((e) => e.orgId)))
              : eq(matchCandidates.listingId, listingId),
          );

        // With escalation waves the notifications are sent wave by wave (see the escalation service); only the legacy mode
        // (ESCALATION_ENABLED=false) tells every eligible NGO right here.
        if (options.notifyOnRecompute) {
          // In-app notifications for eligible NGOs' active members. dedupe_key makes retries no-ops.
          const eligibleOrgs = ranked.map((e) => e.orgId);
          if (eligibleOrgs.length > 0) {
            const members = await tx
              .select({ userId: organizationMembers.userId, orgId: organizationMembers.organizationId })
              .from(organizationMembers)
              .where(and(eq(organizationMembers.status, 'ACTIVE'), inArray(organizationMembers.organizationId, eligibleOrgs)));
            const body = `${l.servings} servings of ${CATEGORY_LABEL(l.food_category)} in ${l.city}. Pickup by ${new Date(l.pickup_deadline).toISOString()}.`;
            if (members.length > 0) {
              await tx
                .insert(notifications)
                .values(
                  members.map((m) => ({
                    userId: m.userId,
                    type: 'LISTING_MATCH',
                    title: `New food listing near you: ${l.title}`,
                    body,
                    entityType: 'listing',
                    entityId: listingId,
                    dedupeKey: `listing-match:${listingId}:${m.userId}`,
                  })),
                )
                .onConflictDoNothing({ target: notifications.dedupeKey });
            }
            await tx
              .update(matchCandidates)
              .set({ notifiedAt: now })
              .where(and(eq(matchCandidates.listingId, listingId), eq(matchCandidates.eligible, true), sql`${matchCandidates.notifiedAt} IS NULL`));
          }
        }
        return { matchable: true, evaluated: evaluated.length, eligible: ranked.length };
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      return spatialGuard(err);
    }
  }

  /** Live listings with coordinates: the set an NGO-side change can affect. */
  async function liveListingIds(now: Date): Promise<string[]> {
    const rows = await db
      .select({ id: foodListings.id })
      .from(foodListings)
      .where(and(eq(foodListings.status, 'AVAILABLE'), gt(foodListings.pickupDeadline, now)))
      .orderBy(asc(foodListings.pickupDeadline))
      .limit(500);
    return rows.map((r) => r.id);
  }

  async function recomputeAllLive(now: Date = clock()) {
    let count = 0;
    for (const id of await liveListingIds(now)) {
      await recomputeListing(id, now);
      count += 1;
    }
    return count;
  }

  /** The NGO's profile, verification or requirement changed: refresh every live listing's candidates. */
  async function recomputeForNgo(_ngoOrgId: string, now: Date = clock()) {
    return recomputeAllLive(now);
  }

  /** Provider members and admins may see a listing's candidates; everyone else gets 404. */
  async function assertListingAccess(actor: Actor, listingId: string): Promise<{ id: string; status: string; pickupDeadline: Date; hasCoordinates: boolean; providerOrgId: string }> {
    const r = await db.execute(sql`
      SELECT id, status, pickup_deadline, provider_org_id, (geog IS NOT NULL) AS has_geog FROM food_listings WHERE id = ${listingId}::uuid`);
    const l = r.rows[0] as { id: string; status: string; pickup_deadline: Date; provider_org_id: string; has_geog: boolean } | undefined;
    if (!l) throw errors.notFound('Listing not found.');
    const allowed =
      actor.platformRole === 'admin' ||
      (actor.platformRole === 'provider' && (await isActiveMember(db, actor.id, l.provider_org_id)));
    if (!allowed) throw errors.notFound('Listing not found.');
    return { id: l.id, status: l.status, pickupDeadline: new Date(l.pickup_deadline), hasCoordinates: l.has_geog, providerOrgId: l.provider_org_id };
  }

  const km1 = (m: number | null) => (m === null ? null : Math.round(m / 100) / 10);

  async function ngoContext(actor: Actor) {
    if (actor.platformRole !== 'ngo') throw errors.forbidden();
    const orgs = await activeOrganizations(db, actor.id, 'NGO');
    const verified = orgs.find((o) => o.verificationStatus === 'VERIFIED');
    if (verified) return verified;
    if (orgs[0]) return assertOrganizationVerified(db, orgs[0].id); // throws ORGANIZATION_NOT_VERIFIED
    throw new AppError(409, 'ORGANIZATION_REQUIRED', 'Create your organization profile first.');
  }

  /**
   * Authoritative, live eligibility check for ONE (listing, NGO) pair, used at acceptance time inside the
   * accepting transaction. Stored candidate rows are only recommendations and may be stale (time passes,
   * requirements change); this re-applies every hard filter against current data.
   */
  async function evaluateForAccept(exec: Pick<Db, 'execute'>, listingId: string, ngoOrgId: string, now: Date) {
    const platformM = settings.searchRadiusKm * 1000;
    const r = await exec.execute(sql`
      SELECT o.id AS org_id, o.name, o.city, o.verification_status,
             (o.geog IS NOT NULL) AS has_geog,
             (l.geog IS NOT NULL) AS listing_has_geog,
             CASE WHEN o.geog IS NULL OR l.geog IS NULL THEN NULL ELSE ST_Distance(o.geog, l.geog) END AS distance_m,
             (o.geog IS NOT NULL AND l.geog IS NOT NULL AND r.id IS NOT NULL AND ST_DWithin(o.geog, l.geog, r.service_radius_km * 1000)) AS within_service_radius,
             (o.geog IS NOT NULL AND l.geog IS NOT NULL AND ST_DWithin(o.geog, l.geog, ${platformM}::float8)) AS within_platform,
             l.food_category, l.servings, l.dietary_tags, l.pickup_start, l.pickup_deadline,
             r.id AS req_id, r.food_categories::text[] AS food_categories, r.needed_servings, r.capacity_servings,
             r.service_radius_km, r.available_from, r.available_to, r.intake_enabled,
             r.dietary_must_have, r.dietary_must_avoid
        FROM food_listings l
        JOIN organizations o ON o.id = ${ngoOrgId}::uuid AND o.type = 'NGO'
        LEFT JOIN ngo_requirements r ON r.ngo_org_id = o.id
       WHERE l.id = ${listingId}::uuid`);
    const row = r.rows[0] as
      | (Row & { verification_status: string; listing_has_geog: boolean; within_platform: boolean; food_category: FoodCategory; servings: number; dietary_tags: string[]; pickup_start: Date; pickup_deadline: Date })
      | undefined;
    if (!row) return { eligible: false as const, reasons: [{ code: 'NGO_NOT_VERIFIED', message: 'Organization not found.' }] };
    const facts: ListingFacts = {
      servings: row.servings,
      foodCategory: row.food_category,
      dietaryTags: row.dietary_tags,
      pickupStart: new Date(row.pickup_start),
      pickupDeadline: new Date(row.pickup_deadline),
    };
    const requirement = toRequirement(row);
    const ev = evaluate(facts, { hasCoordinates: row.has_geog, distanceM: row.distance_m, withinServiceRadius: row.within_service_radius, requirement }, now, settings);
    const reasons: Reason[] = [...ev.reasons];
    if (row.verification_status !== 'VERIFIED') reasons.unshift({ code: 'NGO_NOT_VERIFIED', message: 'Your organization is not verified.' });
    if (!row.listing_has_geog) reasons.push({ code: 'LISTING_NO_COORDINATES', message: 'The listing has no coordinates, so it cannot be matched.' });
    else if (row.has_geog && !row.within_platform) reasons.push({ code: 'OUTSIDE_SEARCH_RADIUS', message: `Outside the ${settings.searchRadiusKm} km platform search radius.` });
    if ((await declinedOrgs(exec, listingId)).has(ngoOrgId)) reasons.push(declinedReason);
    if (reasons.length > 0 || !requirement || !ev.travel) return { eligible: false as const, reasons };
    const input = { listing: facts, requirement, travel: ev.travel, history: null };
    const scored = scoreCandidate(input, now, settings);
    return {
      eligible: true as const,
      reasons: explain(input, settings, now),
      score: scored.score,
      breakdown: scored.breakdown,
      distanceM: row.distance_m!,
      travel: ev.travel,
    };
  }

  return {
    evaluateForAccept,
    recomputeListing,
    recomputeAllLive,
    recomputeForNgo,
    estimateInfo,

    /** Provider/Admin: ranked candidates for one listing (read from the stored recommendations). */
    async getListingMatches(actor: Actor, listingId: string) {
      const listing = await assertListingAccess(actor, listingId);
      const now = clock();
      const live = listing.status === 'AVAILABLE' && listing.pickupDeadline > now;
      const unavailableReason: UnavailableReason | null = !live ? 'LISTING_NOT_AVAILABLE' : !listing.hasCoordinates ? 'LISTING_NO_COORDINATES' : null;

      const rows = unavailableReason
        ? []
        : await db
            .select({ mc: matchCandidates, name: organizations.name, city: organizations.city })
            .from(matchCandidates)
            .innerJoin(organizations, eq(organizations.id, matchCandidates.ngoOrgId))
            .where(eq(matchCandidates.listingId, listingId))
            .orderBy(asc(matchCandidates.rank), desc(matchCandidates.score), asc(matchCandidates.distanceM), asc(matchCandidates.ngoOrgId));

      const eligible = rows.filter((r) => r.mc.eligible);
      const excluded = rows.filter((r) => !r.mc.eligible);
      const counts = new Map<string, { code: string; message: string; count: number }>();
      for (const r of excluded) {
        for (const reason of r.mc.reasons as Reason[]) {
          const cur = counts.get(reason.code);
          if (cur) cur.count += 1;
          else counts.set(reason.code, { code: reason.code, message: GENERIC_REASONS[reason.code] ?? 'Not eligible', count: 1 });
        }
      }
      return {
        listing: { id: listing.id, matchable: unavailableReason === null, unavailableReason, urgency: live ? urgencyFor(listing.pickupDeadline, now) : 'EXPIRED', pickupDeadline: listing.pickupDeadline },
        computedAt: rows.reduce<Date | null>((m, r) => (!m || r.mc.computedAt > m ? r.mc.computedAt : m), null),
        estimate: estimateInfo(),
        candidates: eligible.map((r) => ({
          rank: r.mc.rank,
          organizationId: r.mc.ngoOrgId,
          organizationName: r.name,
          city: r.city,
          score: r.mc.score,
          breakdown: r.mc.breakdown as Breakdown,
          reasons: (r.mc.reasons as Reason[]).map((x) => x.message),
          estimatedDistanceKm: km1(r.mc.distanceM),
          estimatedTravelMinutes: r.mc.estimatedTravelMinutes,
          estimatedMarginMinutes: r.mc.marginMinutes,
          notifiedAt: r.mc.notifiedAt,
        })),
        // Providers only learn *why* others were excluded, in aggregate; admins also see which organizations.
        excluded: [...counts.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
        ...(actor.platformRole === 'admin'
          ? { excludedOrganizations: excluded.map((r) => ({ organizationId: r.mc.ngoOrgId, organizationName: r.name, reasons: r.mc.reasons as Reason[] })) }
          : {}),
      };
    },

    async refreshListing(actor: Actor, listingId: string) {
      await assertListingAccess(actor, listingId);
      const result = await recomputeListing(listingId);
      if (!result.matchable) {
        throw new AppError(409, 'LISTING_NOT_MATCHABLE', result.unavailableReason === 'LISTING_NO_COORDINATES' ? 'Add pickup coordinates to this listing to enable matching.' : 'Only live, available listings can be matched.', {
          reason: result.unavailableReason,
        });
      }
      return result;
    },

    /** Verified NGO: ranked live listings recommended for them, with explanations. */
    async recommendedForNgo(actor: Actor) {
      const org = await ngoContext(actor);
      const now = clock();
      const [req] = await db.select().from(ngoRequirements).where(eq(ngoRequirements.ngoOrgId, org.id)).limit(1);
      const state = !req ? 'NO_REQUIREMENT' : !req.intakeEnabled ? 'PAUSED' : req.availableTo <= now ? 'WINDOW_ENDED' : org.latitude === null || org.longitude === null ? 'NO_COORDINATES' : 'ACTIVE';
      const base = { state, estimate: estimateInfo() };
      if (state !== 'ACTIVE') return { ...base, listings: [] };

      const rows = await db
        .select({ mc: matchCandidates, listing: foodListings, providerName: organizations.name })
        .from(matchCandidates)
        .innerJoin(foodListings, eq(foodListings.id, matchCandidates.listingId))
        .innerJoin(organizations, eq(organizations.id, foodListings.providerOrgId))
        .where(
          and(
            eq(matchCandidates.ngoOrgId, org.id),
            eq(matchCandidates.eligible, true),
            eq(foodListings.status, 'AVAILABLE'),
            gt(foodListings.pickupDeadline, now),
            eq(organizations.verificationStatus, 'VERIFIED'),
          ),
        )
        .orderBy(desc(matchCandidates.score), asc(matchCandidates.distanceM), asc(matchCandidates.listingId))
        .limit(100);
      return {
        ...base,
        listings: rows.map((r) => ({
          // Redacted listing view: approximate area only, never the exact address.
          ...serializePublicListing(r.listing, r.providerName, now),
          match: {
            score: r.mc.score,
            rankAmongCandidates: r.mc.rank,
            breakdown: r.mc.breakdown as Breakdown,
            reasons: (r.mc.reasons as Reason[]).map((x) => x.message),
            estimatedDistanceKm: km1(r.mc.distanceM),
            estimatedTravelMinutes: r.mc.estimatedTravelMinutes,
            estimatedMarginMinutes: r.mc.marginMinutes,
          },
        })),
      };
    },

    async refreshForNgo(actor: Actor) {
      const org = await ngoContext(actor);
      return { listingsRecomputed: await recomputeForNgo(org.id) };
    },
  };
}

export type MatchingService = ReturnType<typeof createMatchingService>;
