import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { errors, fieldErrors } from '../../http/errors.js';
import type { PlatformRole } from '../../db/schema.js';
import { activeOrganizations } from '../organizations/membership.js';

/**
 * Impact metrics (spec 1.1, BR-08, FL-014). Everything here is DERIVED, on every request, from the authoritative rescue
 * records: there are no counters to drift, so a completed rescue contributes exactly once by construction (a row is
 * either COMPLETED or it is not; no joins can multiply it, and runner attribution uses EXISTS, never a join).
 *
 *  - Only rescues in status COMPLETED count. Cancelled, expired, failed and unresolved rescues never do.
 *  - Servings come from `delivered_servings` (what the NGO, or an admin resolution, recorded as actually received),
 *    never from the offered or the collected quantity.
 *  - Time is the rescue's `completed_at`, bucketed and filtered in UTC.
 *  - Kilograms are NOT reported: weight exists only as an optional, provider-declared estimate on the listing for the
 *    whole offered quantity, there is no per-rescue weight, and no servings-to-kg conversion is defined.
 */

export const DEFINITIONS = {
  completedRescues: 'Rescues that reached COMPLETED: the recipient (or an administrator, with a recorded reason) confirmed what was received. Cancelled, expired, failed and in-progress rescues are not counted.',
  servingsDelivered: 'Servings the recipient confirmed as actually received (the delivered quantity). Not the quantity offered or collected, which can be higher.',
  period: 'A rescue belongs to the period in which it was completed (its completion time, in UTC). Both dates are inclusive. With no dates, all completed rescues are included.',
  directPickup: 'Completed rescues where the NGO collected the food itself.',
  runnerAssisted: 'Completed rescues where a volunteer runner carried the food.',
  runnerCredit: 'A runner is credited only for completed runner-assisted rescues whose assignment to that runner ended as completed. A runner who released the job, was replaced, or whose delivery failed is not credited, and direct NGO pickups are never credited to a runner.',
} as const;

export const UNAVAILABLE = [
  {
    metric: 'kilograms',
    reason: 'Not available. Weight is only an optional, provider-declared estimate for the whole offered quantity on a listing; no per-rescue weight is recorded and no servings-to-kilograms conversion is defined.',
  },
];

export interface Period {
  from: string | null;
  to: string | null;
}

type Actor = { id: string; platformRole: PlatformRole };
type Scope =
  | { kind: 'organizations'; side: 'provider' | 'ngo'; ids: string[] }
  | { kind: 'runner'; userId: string }
  | { kind: 'platform' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates YYYY-MM-DD (a real calendar day) and returns the instant range [start, endExclusive) in UTC. */
export function parsePeriod(from: unknown, to: unknown): { period: Period; start: Date | null; endExclusive: Date | null } {
  const bad: Record<string, string> = {};
  const parse = (v: unknown, key: string): Date | null => {
    if (v === undefined || v === '') return null;
    if (typeof v !== 'string' || !DATE.test(v)) {
      bad[key] = 'Use a date like 2026-10-31.';
      return null;
    }
    const d = new Date(`${v}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
      bad[key] = 'That is not a real calendar date.';
      return null;
    }
    return d;
  };
  const start = parse(from, 'from');
  const end = parse(to, 'to');
  if (Object.keys(bad).length > 0) throw fieldErrors(bad);
  if (start && end && start.getTime() > end.getTime()) throw fieldErrors({ to: 'The end date cannot be before the start date.' });
  return {
    period: { from: start ? start.toISOString().slice(0, 10) : null, to: end ? end.toISOString().slice(0, 10) : null },
    start,
    endExclusive: end ? new Date(end.getTime() + 86_400_000) : null,
  };
}

export function createImpactService(db: Db) {
  const where = (scope: Scope, start: Date | null, endExclusive: Date | null): SQL => {
    const parts: SQL[] = [sql`r.status = 'COMPLETED'`];
    if (scope.kind === 'organizations') {
      const col = scope.side === 'provider' ? sql`r.provider_org_id` : sql`r.ngo_org_id`;
      parts.push(sql`${col} IN (${sql.join(scope.ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
    } else if (scope.kind === 'runner') {
      parts.push(sql`r.transport_mode = 'RUNNER'`);
      parts.push(sql`EXISTS (SELECT 1 FROM rescue_assignments a WHERE a.rescue_id = r.id AND a.runner_user_id = ${scope.userId}::uuid AND a.status = 'COMPLETED')`);
    }
    if (start) parts.push(sql`r.completed_at >= ${start.toISOString()}::timestamptz`);
    if (endExclusive) parts.push(sql`r.completed_at < ${endExclusive.toISOString()}::timestamptz`);
    return sql.join(parts, sql` AND `);
  };

  async function compute(scope: Scope, start: Date | null, endExclusive: Date | null) {
    if (scope.kind === 'organizations' && scope.ids.length === 0) return empty();
    const w = where(scope, start, endExclusive);
    const totals = (
      await db.execute(sql`
        SELECT count(*)::int AS completed,
               coalesce(sum(r.delivered_servings), 0)::int AS servings,
               count(*) FILTER (WHERE r.transport_mode = 'NGO_PICKUP')::int AS direct_rescues,
               coalesce(sum(r.delivered_servings) FILTER (WHERE r.transport_mode = 'NGO_PICKUP'), 0)::int AS direct_servings,
               count(*) FILTER (WHERE r.transport_mode = 'RUNNER')::int AS runner_rescues,
               coalesce(sum(r.delivered_servings) FILTER (WHERE r.transport_mode = 'RUNNER'), 0)::int AS runner_servings,
               count(DISTINCT r.provider_org_id)::int AS providers,
               count(DISTINCT r.ngo_org_id)::int AS ngos
          FROM rescues r WHERE ${w}`)
    ).rows[0] as Record<string, number>;
    const months = (
      await db.execute(sql`
        SELECT to_char(date_trunc('month', r.completed_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
               count(*)::int AS rescues, coalesce(sum(r.delivered_servings), 0)::int AS servings
          FROM rescues r WHERE ${w}
         GROUP BY 1 ORDER BY 1`)
    ).rows as { month: string; rescues: number; servings: number }[];
    return { totals, months };
  }

  const empty = () => ({
    totals: { completed: 0, servings: 0, direct_rescues: 0, direct_servings: 0, runner_rescues: 0, runner_servings: 0, providers: 0, ngos: 0 } as Record<string, number>,
    months: [] as { month: string; rescues: number; servings: number }[],
  });

  const shape = (t: Record<string, number>) => ({
    completedRescues: t.completed!,
    servingsDelivered: t.servings!,
    byTransport: {
      directPickup: { rescues: t.direct_rescues!, servings: t.direct_servings! },
      runnerAssisted: { rescues: t.runner_rescues!, servings: t.runner_servings! },
    },
  });

  const envelope = (period: Period) => ({
    period: { ...period, timeZone: 'UTC', basis: 'completion time' },
    definitions: DEFINITIONS,
    unavailable: UNAVAILABLE,
  });

  return {
    /** The signed-in user's own impact: their organization(s) for providers and NGOs, their own deliveries for runners. */
    async mine(actor: Actor, query: { from?: unknown; to?: unknown; organizationId?: unknown }) {
      const { period, start, endExclusive } = parsePeriod(query.from, query.to);
      if (actor.platformRole === 'runner') {
        if (query.organizationId !== undefined) throw fieldErrors({ organizationId: 'Runners do not have an organization.' });
        const { totals, months } = await compute({ kind: 'runner', userId: actor.id }, start, endExclusive);
        return {
          ...envelope(period),
          scope: { type: 'runner' as const },
          metrics: { completedRescues: totals.completed!, servingsDelivered: totals.servings! },
          byMonth: months,
        };
      }
      if (actor.platformRole !== 'provider' && actor.platformRole !== 'ngo') throw errors.forbidden();

      const side = actor.platformRole;
      const mine = await activeOrganizations(db, actor.id, side === 'provider' ? 'PROVIDER' : 'NGO');
      let orgs = mine;
      if (query.organizationId !== undefined) {
        // Someone else's organization looks exactly like one that does not exist.
        orgs = typeof query.organizationId === 'string' ? mine.filter((o) => o.id === query.organizationId) : [];
        if (orgs.length === 0) throw errors.notFound('Organization not found.');
      }
      const { totals, months } = await compute({ kind: 'organizations', side, ids: orgs.map((o) => o.id) }, start, endExclusive);
      return {
        ...envelope(period),
        scope: { type: 'organization' as const, organizations: orgs.map((o) => ({ id: o.id, name: o.name })) },
        metrics: {
          ...shape(totals),
          // Counts only: no names or other details of the other side.
          ...(side === 'provider' ? { recipientOrganizations: totals.ngos! } : { providerOrganizations: totals.providers! }),
        },
        byMonth: months,
      };
    },

    /** Platform-wide totals (admin only). Aggregates only: no organization, user or rescue is identified. */
    async platform(actor: Actor, query: { from?: unknown; to?: unknown }) {
      if (actor.platformRole !== 'admin') throw errors.forbidden();
      const { period, start, endExclusive } = parsePeriod(query.from, query.to);
      const { totals, months } = await compute({ kind: 'platform' }, start, endExclusive);
      const runners = (
        await db.execute(sql`
          SELECT count(DISTINCT a.runner_user_id)::int AS n
            FROM rescue_assignments a JOIN rescues r ON r.id = a.rescue_id
           WHERE a.status = 'COMPLETED' AND ${where({ kind: 'platform' }, start, endExclusive)} AND r.transport_mode = 'RUNNER'`)
      ).rows[0] as { n: number };
      return {
        ...envelope(period),
        scope: { type: 'platform' as const },
        metrics: { ...shape(totals), providerOrganizations: totals.providers!, ngoOrganizations: totals.ngos!, runners: runners.n },
        byMonth: months,
      };
    },
  };
}

export type ImpactService = ReturnType<typeof createImpactService>;
