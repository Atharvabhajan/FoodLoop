import { sql } from 'drizzle-orm';
import type { EscalationSettings, MatchSettings, RescueSettings } from '../../config.js';
import type { Db } from '../../db/client.js';
import { errors } from '../../http/errors.js';
import { describeError } from '../../log.js';
import { unguarded, type Guard } from '../../ops/advisory-lock.js';
import { evaluateRunner, requiredKg, type RunnerFacts } from '../runners/eligibility.js';
import { listingMatchNotification, type MatchingService } from '../matching/service.js';

/**
 * Escalation waves (spec 3.3 Workflow C, 8.4). A published listing gets a persisted schedule of steps:
 *
 *   NGO wave (radius 1) -> NGO wave (radius 2) -> runner wave -> NGO wave (radius 3) -> admin alert
 *
 * Nobody is told at publish time beyond what the first wave says. Each NGO wave tells only organizations that are eligible
 * RIGHT NOW (candidates are recomputed from live data when the step runs), inside that wave's radius, not told by an earlier
 * wave, best match score first, at most `batchSize`. The runner wave tells eligible, available runners (nearest first). The
 * final step alerts admins. Steps stop the moment the listing is no longer open.
 *
 * Why a step cannot run twice or tell anyone twice (defence in depth):
 *  1. one worker at a time (advisory lock, in the worker guard);
 *  2. one executor per listing at a time (transaction-level advisory lock below);
 *  3. a step leaves PENDING exactly once, and a trigger refuses any later change to a finished step;
 *  4. escalation_recipients is unique per listing and recipient (and insert-only);
 *  5. notifications carry deduplication keys.
 */

export type StepKind = 'NGO_WAVE' | 'RUNNER_WAVE' | 'ADMIN_ALERT';
export type StepStatus = 'PENDING' | 'DONE' | 'SKIPPED' | 'CANCELLED';

export interface StepView {
  seq: number;
  kind: StepKind;
  radiusKm: number | null;
  dueAt: string;
  status: StepStatus;
  executedAt: string | null;
  qualified: number | null;
  newlyEligible: number | null;
  notifiedOrgs: number | null;
  notifiedUsers: number | null;
  reason: string | null;
}

/**
 * One listing's escalation at a glance, for the admin board: the latest round's steps plus where it stands. Counts and
 * times only: no recipient names, addresses or contact details.
 */
export function summarizeEscalation(enabled: boolean, found: { round: number; steps: StepView[] } | undefined) {
  if (!found) return { enabled, round: null, steps: [] as StepView[], completed: 0, total: 0, current: null as StepView | null, next: null as StepView | null, adminAlerted: false, stopped: null as string | null };
  const finished = found.steps.filter((s) => s.status === 'DONE' || s.status === 'SKIPPED');
  const cancelled = found.steps.find((s) => s.status === 'CANCELLED');
  return {
    enabled,
    round: found.round,
    steps: found.steps,
    completed: finished.length,
    total: found.steps.length,
    current: finished.length > 0 ? finished[finished.length - 1]! : null,
    next: found.steps.find((s) => s.status === 'PENDING') ?? null,
    adminAlerted: found.steps.some((s) => s.kind === 'ADMIN_ALERT' && s.status === 'DONE'),
    /** Why the remaining steps will never run (listing accepted, cancelled or expired), if they were stopped. */
    stopped: cancelled?.reason ?? null,
  };
}

export interface ExecutionResult {
  seq: number;
  kind: StepKind;
  status: StepStatus;
  reason: string | null;
  qualified: number | null;
  newlyEligible: number | null;
  notifiedOrgs: number | null;
  notifiedUsers: number | null;
}

export interface EscalationDeps {
  match: MatchSettings;
  rescue: RescueSettings;
  matching: Pick<MatchingService, 'recomputeListing'>;
  /** After commit: these users were notified about this listing (ids only: the socket layer nudges them to refetch). */
  hooks?: { notified?(listingId: string, userIds: string[]): void };
  clock?: () => Date;
}

const iso = (d: Date) => d.toISOString();
const date = (v: unknown) => (v == null ? null : new Date(v as string));
const MIN = 60_000;

interface StepRow {
  id: string;
  listing_id: string;
  round: number;
  seq: number;
  kind: StepKind;
  radius_km: number | null;
  due_at: string;
  status: StepStatus;
  executed_at: string | null;
  qualified: number | null;
  newly_eligible: number | null;
  notified_orgs: number | null;
  notified_users: number | null;
  reason: string | null;
}

const toView = (r: StepRow): StepView => ({
  seq: r.seq,
  kind: r.kind,
  radiusKm: r.radius_km,
  dueAt: new Date(r.due_at).toISOString(),
  status: r.status,
  executedAt: date(r.executed_at)?.toISOString() ?? null,
  qualified: r.qualified,
  newlyEligible: r.newly_eligible,
  notifiedOrgs: r.notified_orgs,
  notifiedUsers: r.notified_users,
  reason: r.reason,
});

export function createEscalationService(db: Db, settings: EscalationSettings, deps: EscalationDeps) {
  const clock = deps.clock ?? (() => new Date());

  /**
   * Creates the schedule for a listing that has just been published (round 1), or a fresh round for one a failed rescue
   * released back to the market. Idempotent: nothing is created while steps are still pending, or (on publish) if a
   * schedule already exists. Times follow the configured offsets, compressed for URGENT and CRITICAL listings and never
   * later than the deadline margin before the pickup deadline.
   */
  async function schedule(listingId: string, reason: 'PUBLISHED' | 'RELEASED', now: Date = clock()) {
    if (!settings.enabled) return { scheduled: false as const, round: null };
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`escalation:${listingId}`}))`);
      const l = (await tx.execute(sql`SELECT status, pickup_deadline FROM food_listings WHERE id = ${listingId}::uuid FOR SHARE`)).rows[0] as
        | { status: string; pickup_deadline: string }
        | undefined;
      if (!l || l.status !== 'AVAILABLE') return { scheduled: false as const, round: null };
      const deadline = new Date(l.pickup_deadline);
      if (deadline.getTime() <= now.getTime()) return { scheduled: false as const, round: null };

      const latest = (await tx.execute(sql`SELECT coalesce(max(round), 0)::int AS round FROM escalation_steps WHERE listing_id = ${listingId}::uuid`)).rows[0] as { round: number };
      if (reason === 'PUBLISHED' && latest.round > 0) return { scheduled: false as const, round: latest.round };
      if (latest.round > 0) {
        const pending = (await tx.execute(sql`SELECT count(*)::int AS n FROM escalation_steps WHERE listing_id = ${listingId}::uuid AND round = ${latest.round} AND status = 'PENDING'`)).rows[0] as { n: number };
        if (pending.n > 0) return { scheduled: false as const, round: latest.round };
      }
      const round = latest.round + 1;
      const remainingMin = (deadline.getTime() - now.getTime()) / MIN;
      // Spec 8.4 / Appendix A: urgent listings escalate faster; critical ones skip the slower waves ("immediate ... if feasible").
      const scale = remainingMin < 30 ? settings.criticalScale : remainingMin < 60 ? settings.urgentScale : 1;
      const latestAllowed = deadline.getTime() - settings.deadlineMarginMinutes * MIN;
      for (const s of settings.steps) {
        // Candidates are only looked up inside the platform radius, so a wider wave could never reach anyone more: the wave's
        // radius is capped at it (and the capped value is what the history records).
        const radius = s.radiusKm === null ? null : Math.min(s.radiusKm, deps.match.searchRadiusKm);
        const due = Math.max(now.getTime(), Math.min(now.getTime() + s.offsetMinutes * scale * MIN, latestAllowed));
        await tx.execute(sql`
          INSERT INTO escalation_steps (listing_id, round, seq, kind, radius_km, due_at)
          VALUES (${listingId}::uuid, ${round}, ${s.seq}, ${s.kind}::escalation_step_kind, ${radius}, ${iso(new Date(due))}::timestamptz)
          ON CONFLICT (listing_id, round, seq) DO NOTHING`);
      }
      return { scheduled: true as const, round };
    });
  }

  const cancelPending = (tx: Pick<Db, 'execute'>, listingId: string, why: string) =>
    tx.execute(sql`UPDATE escalation_steps SET status = 'CANCELLED', reason = ${why} WHERE listing_id = ${listingId}::uuid AND status = 'PENDING'`);

  /**
   * Runs the next step of this listing if it is due. Returns null when nothing is due (or another run got there first).
   * Safe to call concurrently and repeatedly.
   */
  async function executeNext(listingId: string, now: Date = clock()): Promise<ExecutionResult | null> {
    // Cheap pre-check, so overlapping callers that lost the race do no work.
    const due = (await db.execute(sql`SELECT 1 FROM escalation_steps WHERE listing_id = ${listingId}::uuid AND status = 'PENDING' AND due_at <= ${iso(now)}::timestamptz LIMIT 1`)).rows.length > 0;
    if (!due) return null;

    // Eligibility is re-evaluated from live data when the step runs: candidates are recomputed here (verification, intake,
    // requirement, capacity, location, deadline and time feasibility are all part of that evaluation). Done before the
    // transaction below so that overlapping runs never hold pool connections while waiting for each other.
    let matchable: boolean | null = null;
    const peek = (await db.execute(sql`SELECT kind FROM escalation_steps WHERE listing_id = ${listingId}::uuid AND status = 'PENDING' ORDER BY round DESC, seq ASC LIMIT 1`)).rows[0] as { kind: StepKind } | undefined;
    if (peek?.kind === 'NGO_WAVE') matchable = (await deps.matching.recomputeListing(listingId, now).catch(() => ({ matchable: false }))).matchable;

    const notified: string[] = [];
    const result = await db.transaction(async (tx): Promise<ExecutionResult | null> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`escalation:${listingId}`}))`);
      // Lock order matches an accepting NGO (listing first, then the steps its trigger cancels): no deadlock.
      const l = (
        await tx.execute(sql`
          SELECT id, title, servings, food_category, city, status, pickup_deadline, transport_required, estimated_kg, pickup_start,
                 (geog IS NOT NULL) AS has_geog
            FROM food_listings WHERE id = ${listingId}::uuid FOR SHARE`)
      ).rows[0] as
        | { id: string; title: string; servings: number; food_category: string; city: string; status: string; pickup_deadline: string; transport_required: boolean; estimated_kg: number | null; pickup_start: string; has_geog: boolean }
        | undefined;
      const step = (
        await tx.execute(sql`
          SELECT * FROM escalation_steps WHERE listing_id = ${listingId}::uuid AND status = 'PENDING' ORDER BY round DESC, seq ASC LIMIT 1 FOR UPDATE`)
      ).rows[0] as StepRow | undefined;
      if (!step || new Date(step.due_at).getTime() > now.getTime()) return null; // already done by another run, or not due

      const finish = async (status: StepStatus, why: string | null, c: { qualified?: number; newly?: number; orgs?: number; users?: number } = {}) => {
        await tx.execute(sql`
          UPDATE escalation_steps
             SET status = ${status}::escalation_step_status, executed_at = ${iso(now)}::timestamptz, reason = ${why},
                 qualified = ${c.qualified ?? null}, newly_eligible = ${c.newly ?? null}, notified_orgs = ${c.orgs ?? null}, notified_users = ${c.users ?? null}
           WHERE id = ${step.id}::uuid`);
        return { seq: step.seq, kind: step.kind, status, reason: why, qualified: c.qualified ?? null, newlyEligible: c.newly ?? null, notifiedOrgs: c.orgs ?? null, notifiedUsers: c.users ?? null };
      };

      // Never notify or offer a listing that is no longer open.
      if (!l || l.status !== 'AVAILABLE') {
        await cancelPending(tx, listingId, l ? 'LISTING_NOT_AVAILABLE' : 'LISTING_MISSING');
        return { seq: step.seq, kind: step.kind, status: 'CANCELLED', reason: 'LISTING_NOT_AVAILABLE', qualified: null, newlyEligible: null, notifiedOrgs: null, notifiedUsers: null };
      }
      const deadline = new Date(l.pickup_deadline);
      if (deadline.getTime() <= now.getTime()) {
        await cancelPending(tx, listingId, 'DEADLINE_PASSED');
        return { seq: step.seq, kind: step.kind, status: 'CANCELLED', reason: 'DEADLINE_PASSED', qualified: null, newlyEligible: null, notifiedOrgs: null, notifiedUsers: null };
      }

      if (step.kind === 'NGO_WAVE') {
        if (!l.has_geog || matchable === false) {
          await cancelPending(tx, listingId, l.has_geog ? 'NOT_MATCHABLE' : 'LISTING_NO_COORDINATES');
          return { seq: step.seq, kind: step.kind, status: 'CANCELLED', reason: l.has_geog ? 'NOT_MATCHABLE' : 'LISTING_NO_COORDINATES', qualified: null, newlyEligible: null, notifiedOrgs: null, notifiedUsers: null };
        }
        const radiusM = (step.radius_km ?? 0) * 1000;
        const found = (
          await tx.execute(sql`
            SELECT mc.ngo_org_id, mc.rank, mc.distance_m,
                   EXISTS (SELECT 1 FROM escalation_recipients er WHERE er.listing_id = mc.listing_id AND er.ngo_org_id = mc.ngo_org_id AND er.kind = 'NGO') AS already,
                   EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = mc.ngo_org_id AND m.status = 'ACTIVE') AS has_members
              FROM match_candidates mc
             WHERE mc.listing_id = ${listingId}::uuid AND mc.eligible AND mc.distance_m <= ${radiusM}::float8
             ORDER BY mc.rank ASC NULLS LAST, mc.score DESC NULLS LAST, mc.distance_m ASC, mc.ngo_org_id ASC`)
        ).rows as { ngo_org_id: string; rank: number | null; distance_m: number; already: boolean; has_members: boolean }[];
        const fresh = found.filter((r) => !r.already && r.has_members);
        const picked = fresh.slice(0, settings.batchSize);

        let users = 0;
        for (const [i, p] of picked.entries()) {
          await tx.execute(sql`
            INSERT INTO escalation_recipients (listing_id, step_id, kind, ngo_org_id, position, distance_m)
            VALUES (${listingId}::uuid, ${step.id}::uuid, 'NGO', ${p.ngo_org_id}::uuid, ${i + 1}, ${p.distance_m})
            ON CONFLICT DO NOTHING`);
        }
        if (picked.length > 0) {
          const ids = picked.map((p) => sql`${p.ngo_org_id}::uuid`);
          const members = (await tx.execute(sql`SELECT user_id FROM organization_members WHERE status = 'ACTIVE' AND organization_id IN (${sql.join(ids, sql`, `)})`)).rows as { user_id: string }[];
          const text = listingMatchNotification({ title: l.title, servings: l.servings, foodCategory: l.food_category, city: l.city, pickupDeadline: deadline });
          for (const m of members) {
            // The same deduplication key as the original match notification: nobody is told twice about one listing.
            const ins = await tx.execute(sql`
              INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id, dedupe_key)
              VALUES (${m.user_id}::uuid, 'LISTING_MATCH', ${text.title}, ${text.body}, 'listing', ${listingId}::uuid, ${`listing-match:${listingId}:${m.user_id}`})
              ON CONFLICT (dedupe_key) DO NOTHING RETURNING user_id`);
            if (ins.rows.length > 0) {
              users += 1;
              notified.push(m.user_id);
            }
          }
          await tx.execute(sql`UPDATE match_candidates SET notified_at = ${iso(now)}::timestamptz WHERE listing_id = ${listingId}::uuid AND ngo_org_id IN (${sql.join(ids, sql`, `)}) AND notified_at IS NULL`);
        }
        return finish('DONE', picked.length === 0 ? (found.length === 0 ? 'NO_QUALIFYING_NGO' : 'NO_NEW_NGO') : null, { qualified: found.length, newly: fresh.length, orgs: picked.length, users });
      }

      if (step.kind === 'RUNNER_WAVE') {
        if (!l.transport_required) return finish('SKIPPED', 'NO_TRANSPORT_NEEDED');
        if (!l.has_geog) return finish('SKIPPED', 'LISTING_NO_COORDINATES');
        const waveM = (step.radius_km ?? 0) * 1000;
        const rows = (
          await tx.execute(sql`
            SELECT vp.user_id, vp.availability_status, vp.vehicle_type, vp.capacity_kg, vp.radius_km, (vp.geog IS NOT NULL) AS has_geog,
                   ST_Distance(vp.geog, l.geog) AS distance_m,
                   (vp.radius_km IS NOT NULL AND ST_DWithin(vp.geog, l.geog, LEAST(vp.radius_km, ${deps.match.searchRadiusKm}::float8) * 1000)) AS within_radius,
                   EXISTS (SELECT 1 FROM rescue_assignments a WHERE a.runner_user_id = vp.user_id AND a.status = 'ACTIVE') AS busy,
                   EXISTS (SELECT 1 FROM escalation_recipients er WHERE er.listing_id = l.id AND er.runner_user_id = vp.user_id AND er.kind = 'RUNNER') AS already
              FROM volunteer_profiles vp
              JOIN users u ON u.id = vp.user_id AND u.status = 'ACTIVE'
              JOIN food_listings l ON l.id = ${listingId}::uuid
             WHERE vp.availability_status = 'AVAILABLE' AND vp.geog IS NOT NULL AND l.geog IS NOT NULL AND ST_DWithin(vp.geog, l.geog, ${waveM}::float8)
             ORDER BY ST_Distance(vp.geog, l.geog) ASC, vp.user_id ASC`)
        ).rows as { user_id: string; availability_status: RunnerFacts['availability']; vehicle_type: string | null; capacity_kg: number | null; radius_km: number | null; has_geog: boolean; distance_m: number; within_radius: boolean; busy: boolean; already: boolean }[];
        const job = {
          requiredKg: requiredKg({ estimatedKg: l.estimated_kg, servings: l.servings }, deps.rescue.kgPerServing),
          pickupStart: new Date(l.pickup_start),
          pickupDeadline: deadline,
        };
        // The same live runner rules as claiming a job: available, complete profile, capacity, radius, can reach it in time, not busy.
        const eligible = rows.filter((r) =>
          evaluateRunner(job, { availability: r.availability_status, vehicleType: r.vehicle_type, capacityKg: r.capacity_kg, radiusKm: r.radius_km, hasCoordinates: r.has_geog, distanceM: r.distance_m, withinRadius: r.within_radius, busy: r.busy, previouslyReleased: false }, now, deps.match).reasons.length === 0,
        );
        const fresh = eligible.filter((r) => !r.already);
        const picked = fresh.slice(0, settings.runnerBatchSize);
        let users = 0;
        for (const [i, p] of picked.entries()) {
          await tx.execute(sql`
            INSERT INTO escalation_recipients (listing_id, step_id, kind, runner_user_id, position, distance_m)
            VALUES (${listingId}::uuid, ${step.id}::uuid, 'RUNNER', ${p.user_id}::uuid, ${i + 1}, ${p.distance_m})
            ON CONFLICT DO NOTHING`);
          const ins = await tx.execute(sql`
            INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id, dedupe_key)
            VALUES (${p.user_id}::uuid, 'LISTING_RUNNER_ALERT', ${`Possible delivery job near you: ${l.title}`},
                    ${`${l.servings} servings in ${l.city} that no NGO has accepted yet. If an NGO accepts and asks for a runner, the job will appear in Available jobs.`},
                    'listing', ${listingId}::uuid, ${`escalation-runner:${listingId}:${p.user_id}`})
            ON CONFLICT (dedupe_key) DO NOTHING RETURNING user_id`);
          if (ins.rows.length > 0) {
            users += 1;
            notified.push(p.user_id);
          }
        }
        return finish('DONE', picked.length === 0 ? (eligible.length === 0 ? 'NO_QUALIFYING_RUNNER' : 'NO_NEW_RUNNER') : null, { qualified: eligible.length, newly: fresh.length, users });
      }

      // ADMIN_ALERT: the final stage. One notification per admin per round (deduplicated), counts only.
      const told = (await tx.execute(sql`
        SELECT count(*) FILTER (WHERE kind = 'NGO')::int AS orgs, count(*) FILTER (WHERE kind = 'RUNNER')::int AS runners
          FROM escalation_recipients WHERE listing_id = ${listingId}::uuid`)).rows[0] as { orgs: number; runners: number };
      const admins = (await tx.execute(sql`SELECT id FROM users WHERE platform_role = 'admin' AND status = 'ACTIVE' ORDER BY id`)).rows as { id: string }[];
      const minutesLeft = Math.max(0, Math.round((deadline.getTime() - now.getTime()) / MIN));
      let users = 0;
      for (const a of admins) {
        const ins = await tx.execute(sql`
          INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id, dedupe_key)
          VALUES (${a.id}::uuid, 'ESCALATION_ADMIN', ${`No NGO has accepted: ${l.title}`},
                  ${`${l.servings} servings are still unaccepted with about ${minutesLeft} min until pickup closes. ${told.orgs} NGO organization(s) and ${told.runners} runner(s) have been told. Manual intervention may be needed: see the operations board.`},
                  'listing', ${listingId}::uuid, ${`escalation-admin:${listingId}:${step.round}:${a.id}`})
          ON CONFLICT (dedupe_key) DO NOTHING RETURNING user_id`);
        if (ins.rows.length > 0) {
          users += 1;
          notified.push(a.id);
        }
      }
      return finish('DONE', admins.length === 0 ? 'NO_ADMINS' : null, { users });
    });
    if (notified.length > 0) deps.hooks?.notified?.(listingId, notified);
    return result;
  }

  /** Runs every due step (in order, per listing). One worker pass; also called right after publish for steps already due. */
  async function runDue(now: Date = clock(), only?: string): Promise<{ executed: ExecutionResult[] }> {
    if (!settings.enabled) return { executed: [] };
    // Catch-up (worker passes only): an open listing with no schedule at all (published before waves existed, inserted
    // directly, or whose scheduling failed) gets one now, timed from this pass.
    if (!only) {
      const missing = (
        await db.execute(sql`
          SELECT l.id FROM food_listings l
           WHERE l.status = 'AVAILABLE' AND l.pickup_deadline > ${iso(now)}::timestamptz
             AND NOT EXISTS (SELECT 1 FROM escalation_steps s WHERE s.listing_id = l.id)
           ORDER BY l.pickup_deadline ASC LIMIT 50`)
      ).rows as { id: string }[];
      for (const m of missing) await schedule(m.id, 'PUBLISHED', now).catch(() => undefined);
    }
    const ids = only
      ? [only]
      : ((await db.execute(sql`SELECT DISTINCT listing_id FROM escalation_steps WHERE status = 'PENDING' AND due_at <= ${iso(now)}::timestamptz LIMIT 200`)).rows as { listing_id: string }[]).map((r) => r.listing_id);
    const executed: ExecutionResult[] = [];
    for (const id of ids) {
      for (let guard = 0; guard < settings.steps.length + 1; guard++) {
        const r = await executeNext(id, now);
        if (!r) break;
        executed.push(r);
        if (r.status === 'CANCELLED') break;
      }
    }
    return { executed };
  }

  /** The latest round of each listing's schedule, for the admin board. Counts and times only. */
  async function summaries(listingIds: string[]): Promise<Map<string, { round: number; steps: StepView[] }>> {
    const out = new Map<string, { round: number; steps: StepView[] }>();
    if (listingIds.length === 0) return out;
    const rows = (
      await db.execute(sql`
        SELECT s.* FROM escalation_steps s
         WHERE s.listing_id IN (${sql.join(listingIds.map((id) => sql`${id}::uuid`), sql`, `)})
           AND s.round = (SELECT max(round) FROM escalation_steps x WHERE x.listing_id = s.listing_id)
         ORDER BY s.listing_id, s.seq`)
    ).rows as unknown as StepRow[];
    for (const r of rows) {
      const e = out.get(r.listing_id) ?? { round: r.round, steps: [] };
      e.steps.push(toView(r));
      out.set(r.listing_id, e);
    }
    return out;
  }

  /** Full wave history of one listing (all rounds) with who was told. Admin use; ids and names, no contact details. */
  async function history(listingId: string) {
    const l = (await db.execute(sql`SELECT id, title, status FROM food_listings WHERE id = ${listingId}::uuid`)).rows[0] as { id: string; title: string; status: string } | undefined;
    if (!l) throw errors.notFound('Listing not found.');
    const steps = (await db.execute(sql`SELECT * FROM escalation_steps WHERE listing_id = ${listingId}::uuid ORDER BY round, seq`)).rows as unknown as StepRow[];
    const recipients = (
      await db.execute(sql`
        SELECT er.step_id, er.kind, er.position, er.distance_m, er.created_at, o.id AS org_id, o.name AS org_name, u.id AS user_id, u.name AS user_name
          FROM escalation_recipients er
          LEFT JOIN organizations o ON o.id = er.ngo_org_id
          LEFT JOIN users u ON u.id = er.runner_user_id
         WHERE er.listing_id = ${listingId}::uuid ORDER BY er.created_at, er.position`)
    ).rows as { step_id: string; kind: 'NGO' | 'RUNNER'; position: number; distance_m: number | null; created_at: string; org_id: string | null; org_name: string | null; user_id: string | null; user_name: string | null }[];
    return {
      listing: { id: l.id, title: l.title, status: l.status },
      enabled: settings.enabled,
      rounds: [...new Set(steps.map((s) => s.round))].map((round) => ({
        round,
        steps: steps
          .filter((s) => s.round === round)
          .map((s) => ({
            ...toView(s),
            recipients: recipients
              .filter((r) => r.step_id === s.id)
              .map((r) => ({
                kind: r.kind,
                position: r.position,
                distanceKm: r.distance_m === null ? null : Math.round(r.distance_m / 100) / 10,
                ...(r.kind === 'NGO' ? { organization: { id: r.org_id, name: r.org_name } } : { runner: { id: r.user_id, name: r.user_name } }),
              })),
          })),
      })),
    };
  }

  return { schedule, executeNext, runDue, summaries, history, settings };
}

export type EscalationService = ReturnType<typeof createEscalationService>;

/** In-process scheduler, like the expiry workers: guarded by an advisory lock, idempotent, and never the only safeguard. */
export function startEscalationWorker(
  service: Pick<EscalationService, 'runDue'>,
  intervalSeconds: number,
  log: (msg: string) => void = console.log,
  guard: Guard = unguarded,
) {
  if (intervalSeconds <= 0) return () => undefined;
  const run = async () => {
    try {
      await guard(async () => {
        const { executed } = await service.runDue();
        if (executed.length > 0) log(JSON.stringify({ level: 'info', msg: 'Escalation steps run', count: executed.length }));
      });
    } catch (err) {
      log(JSON.stringify({ level: 'error', msg: 'Escalation run failed', ...describeError(err) }));
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
