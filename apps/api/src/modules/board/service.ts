import { sql, type SQL } from 'drizzle-orm';
import type { RescueSettings } from '../../config.js';
import type { Db } from '../../db/client.js';
import type { RescueStatus, TransportMode } from '../../db/schema.js';
import { errors } from '../../http/errors.js';
import { urgencyFor, type Urgency } from '../listings/constants.js';
import { summarizeEscalation, type EscalationService } from '../escalation/service.js';
import { nextAction } from '../rescues/lifecycle.js';

/**
 * Admin live operations board (spec 1.1 "Admin can view active, delayed, failed and completed rescues", 9.5).
 * Read-only: nothing here changes a rescue or listing; interventions stay on the existing audited admin actions.
 *
 * Classification (computed in SQL from the rescue's own timestamps and existing deadlines, so filtering, counting and
 * paging all happen on the server and nothing is stored or denormalized):
 *
 *  completed  status COMPLETED
 *  failed     EXPIRED (nobody confirmed / no runner in time), PICKUP_FAILED, DELIVERY_FAILED (the last still needs an admin)
 *  cancelled  CANCELLED (kept visible, not a failure)
 *  delayed    still in progress AND one of:
 *               BLOCKED_BY_INCIDENT     an open blocking incident is stopping the next step (spec BR-07)
 *               PICKUP_WINDOW_CLOSED    pickup assigned, and the listing's pickup deadline has passed (only the grace remains)
 *               STAGE_BEHIND_SCHEDULE   the current stage has used at least OPS_DELAYED_ELAPSED_PERCENT of the time allotted to it
 *  active     in progress and none of the above
 *
 * A stage's allotted time runs from when the stage began to the existing stage deadline (providerConfirmBy, runnerBy,
 * pickupBy or deliveryConfirmBy). Those deadlines are HARD: once one passes, the existing lifecycle closes the rescue as
 * failed, so "delayed" is the warning state before that. Overdue rescues are settled before every board read, exactly as
 * every other read of a rescue settles them.
 */

export const BUCKETS = ['active', 'delayed', 'failed', 'completed', 'cancelled'] as const;
export type Bucket = (typeof BUCKETS)[number];
export type DelayReason = 'BLOCKED_BY_INCIDENT' | 'PICKUP_WINDOW_CLOSED' | 'STAGE_BEHIND_SCHEDULE';

const ACTIVE_STATUSES = ['RESERVED', 'AWAITING_RUNNER', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DELIVERED', 'RECIPIENT_CONFIRMED'];
const list = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** What the party who must act next is being waited for, per stage. */
const ACTION_FOR: Partial<Record<RescueStatus, { key: string; label: string; deadlineLabel: string }>> = {
  RESERVED: { key: 'provider_confirmation', label: 'Provider confirmation', deadlineLabel: 'Provider must confirm by' },
  AWAITING_RUNNER: { key: 'runner_acceptance', label: 'Runner acceptance', deadlineLabel: 'A runner must be found by' },
  PICKUP_ASSIGNED: { key: 'pickup_verification', label: 'Pickup verification', deadlineLabel: 'Pickup must be verified by' },
  PICKUP_CONFIRMED: { key: 'receipt_confirmation', label: 'Receipt confirmation', deadlineLabel: 'Receipt must be confirmed by' },
  IN_TRANSIT: { key: 'delivery_handover', label: 'Delivery handover', deadlineLabel: 'Handover must be recorded by' },
  DELIVERED: { key: 'receipt_confirmation', label: 'Receipt confirmation', deadlineLabel: 'Receipt must be confirmed by' },
};

export interface BoardFilters {
  state?: Bucket;
  providerOrgId?: string;
  ngoOrgId?: string;
  runnerUserId?: string;
  transportMode?: TransportMode;
  q?: string;
  /** Started (reserved) from / before, as UTC instants; `to` already made exclusive by the caller. */
  startedFrom?: Date | null;
  startedBefore?: Date | null;
  /** Only rescues that started more than this many minutes ago. */
  olderThanMinutes?: number;
  blocked?: boolean;
  needsAdmin?: boolean;
  sort?: 'attention' | 'newest' | 'oldest';
  page?: number;
  pageSize?: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const iso = (d: Date) => d.toISOString();
const date = (v: unknown) => (v == null ? null : new Date(v as string));

function human(ms: number) {
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

interface Row {
  id: string;
  status: RescueStatus;
  transport_mode: TransportMode;
  bucket: Bucket;
  needs_admin: boolean;
  delay_reason: DelayReason | null;
  reserved_at: string;
  stage_start: string | null;
  stage_deadline: string | null;
  pickup_start: string;
  pickup_deadline: string;
  completed_at: string | null;
  closed_at: string | null;
  outcome_code: string | null;
  servings_offered: number;
  collected_servings: number | null;
  delivered_servings: number | null;
  listing_id: string;
  title: string;
  provider_org_id: string;
  provider_name: string;
  ngo_org_id: string;
  ngo_name: string;
  runner_user_id: string | null;
  runner_name: string | null;
  open_incidents: number;
  blocked: boolean;
  area_city: string | null;
  area_lat: number | null;
  area_lng: number | null;
  ngo_lat: number | null;
  ngo_lng: number | null;
  [k: string]: unknown;
}

export function createBoardService(db: Db, settings: RescueSettings, clock: () => Date = () => new Date(), escalation?: Pick<EscalationService, 'summaries' | 'settings'>) {
  const pct = settings.delayedElapsedPercent;

  /** WHERE conditions that narrow the dataset (everything except the state tab), applied before classification. */
  function narrowing(f: BoardFilters, now: Date): SQL[] {
    const w: SQL[] = [];
    if (f.providerOrgId) w.push(sql`r.provider_org_id = ${f.providerOrgId}::uuid`);
    if (f.ngoOrgId) w.push(sql`r.ngo_org_id = ${f.ngoOrgId}::uuid`);
    if (f.transportMode) w.push(sql`r.transport_mode = ${f.transportMode}::transport_mode`);
    if (f.runnerUserId) w.push(sql`EXISTS (SELECT 1 FROM rescue_assignments a WHERE a.rescue_id = r.id AND a.runner_user_id = ${f.runnerUserId}::uuid)`);
    if (f.startedFrom) w.push(sql`r.reserved_at >= ${iso(f.startedFrom)}::timestamptz`);
    if (f.startedBefore) w.push(sql`r.reserved_at < ${iso(f.startedBefore)}::timestamptz`);
    if (f.olderThanMinutes) w.push(sql`r.reserved_at <= ${iso(new Date(now.getTime() - f.olderThanMinutes * 60_000))}::timestamptz`);
    if (f.q) {
      const like = `%${escapeLike(f.q)}%`;
      w.push(sql`(l.title ILIKE ${like} OR po.name ILIKE ${like} OR n.name ILIKE ${like} OR r.id::text ILIKE ${like})`);
    }
    return w;
  }

  /** Every in-scope rescue with its classification. `now` is a parameter, so the boundaries are testable. */
  function classified(f: BoardFilters, now: Date): SQL {
    const n = iso(now);
    const where = narrowing(f, now);
    return sql`
      SELECT c.*,
             (c.status = 'DELIVERY_FAILED') AS needs_admin,
             CASE
               WHEN c.status = 'COMPLETED' THEN 'completed'
               WHEN c.status IN ('EXPIRED', 'PICKUP_FAILED', 'DELIVERY_FAILED') THEN 'failed'
               WHEN c.status = 'CANCELLED' THEN 'cancelled'
               WHEN c.delay_reason IS NOT NULL THEN 'delayed'
               ELSE 'active'
             END AS bucket
        FROM (
          SELECT b.*,
                 CASE
                   WHEN b.status NOT IN (${list(ACTIVE_STATUSES)}) THEN NULL
                   WHEN b.blocked THEN 'BLOCKED_BY_INCIDENT'
                   WHEN b.status = 'PICKUP_ASSIGNED' AND b.pickup_deadline <= ${n}::timestamptz THEN 'PICKUP_WINDOW_CLOSED'
                   WHEN b.status IN ('RESERVED', 'AWAITING_RUNNER', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DELIVERED')
                        AND b.stage_start IS NOT NULL AND b.stage_deadline IS NOT NULL AND b.stage_deadline > b.stage_start
                        AND EXTRACT(EPOCH FROM (${n}::timestamptz - b.stage_start)) * 100
                            >= ${pct} * EXTRACT(EPOCH FROM (b.stage_deadline - b.stage_start))
                     THEN 'STAGE_BEHIND_SCHEDULE'
                 END AS delay_reason
            FROM (
              SELECT r.id, r.status, r.transport_mode, r.reserved_at, r.completed_at, r.closed_at, r.outcome_code,
                     r.servings_offered, r.collected_servings, r.delivered_servings,
                     r.provider_org_id, r.ngo_org_id,
                     l.id AS listing_id, l.title, l.pickup_start, l.pickup_deadline,
                     l.city AS area_city, round(l.latitude::numeric, 2)::float8 AS area_lat, round(l.longitude::numeric, 2)::float8 AS area_lng,
                     round(n.latitude::numeric, 2)::float8 AS ngo_lat, round(n.longitude::numeric, 2)::float8 AS ngo_lng,
                     po.name AS provider_name, n.name AS ngo_name,
                     CASE r.status
                       WHEN 'RESERVED' THEN r.provider_confirm_by
                       WHEN 'AWAITING_RUNNER' THEN r.runner_by
                       WHEN 'PICKUP_ASSIGNED' THEN r.pickup_by
                       WHEN 'PICKUP_CONFIRMED' THEN r.delivery_confirm_by
                       WHEN 'IN_TRANSIT' THEN r.delivery_confirm_by
                       WHEN 'DELIVERED' THEN r.delivery_confirm_by
                     END AS stage_deadline,
                     CASE r.status
                       WHEN 'RESERVED' THEN r.reserved_at
                       WHEN 'AWAITING_RUNNER' THEN coalesce((SELECT max(e.created_at) FROM rescue_events e WHERE e.rescue_id = r.id AND e.to_status = 'AWAITING_RUNNER'), r.provider_confirmed_at, r.reserved_at)
                       WHEN 'PICKUP_ASSIGNED' THEN coalesce(r.provider_confirmed_at, r.reserved_at)
                       WHEN 'PICKUP_CONFIRMED' THEN r.picked_up_at
                       WHEN 'IN_TRANSIT' THEN coalesce(r.transit_started_at, r.picked_up_at)
                       WHEN 'DELIVERED' THEN r.handed_over_at
                     END AS stage_start,
                     (SELECT a.runner_user_id FROM rescue_assignments a WHERE a.rescue_id = r.id AND a.status = 'ACTIVE' LIMIT 1) AS runner_user_id,
                     (SELECT u.name FROM rescue_assignments a JOIN users u ON u.id = a.runner_user_id WHERE a.rescue_id = r.id AND a.status = 'ACTIVE' LIMIT 1) AS runner_name,
                     (SELECT count(*)::int FROM incident_reports i WHERE i.rescue_id = r.id AND i.status = 'OPEN') AS open_incidents,
                     (r.status IN (${list(ACTIVE_STATUSES)}) AND EXISTS (SELECT 1 FROM incident_reports i WHERE i.rescue_id = r.id AND i.status = 'OPEN' AND i.blocking)) AS blocked
                FROM rescues r
                JOIN food_listings l ON l.id = r.listing_id
                JOIN organizations po ON po.id = r.provider_org_id
                JOIN organizations n ON n.id = r.ngo_org_id
               ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
            ) b
        ) c`;
  }

  /** Overdue rescues are settled before a read, exactly like every other read of a rescue (idempotent, row-locked). */
  async function settle(settleDue: (now: Date) => Promise<number>, now: Date) {
    await settleDue(now);
  }

  function present(r: Row, now: Date) {
    const status = r.status;
    const mode = r.transport_mode;
    const next = nextAction(status, mode);
    const action = ACTION_FOR[status];
    const stageStart = date(r.stage_start);
    const stageDeadline = date(r.stage_deadline);
    const reservedAt = new Date(r.reserved_at);
    const active = r.bucket === 'active' || r.bucket === 'delayed';

    let delay: { reason: DelayReason; text: string; overdueAction: string } | null = null;
    if (r.delay_reason) {
      const remaining = stageDeadline ? stageDeadline.getTime() - now.getTime() : null;
      const overdueAction = r.delay_reason === 'BLOCKED_BY_INCIDENT' ? 'Resolve the open incident' : (action?.label ?? 'Next step');
      let text: string;
      if (r.delay_reason === 'BLOCKED_BY_INCIDENT') {
        text = `An open blocking incident is stopping this rescue. An admin must resolve it${remaining !== null ? `; the ${action?.label.toLowerCase() ?? 'stage'} deadline is in ${human(remaining)}` : ''}.`;
      } else if (r.delay_reason === 'PICKUP_WINDOW_CLOSED') {
        const over = now.getTime() - new Date(r.pickup_deadline).getTime();
        text = `Pickup verification is overdue: the pickup window closed ${human(over)} ago${remaining !== null ? ` and the grace period ends in ${human(remaining)}` : ''}.`;
      } else {
        const used = stageStart && stageDeadline ? Math.floor(((now.getTime() - stageStart.getTime()) * 100) / (stageDeadline.getTime() - stageStart.getTime())) : pct;
        text = `${action?.label ?? 'This stage'} is behind schedule: ${used}% of the allowed time has passed (limit for "delayed": ${pct}%)${remaining !== null ? `; ${human(remaining)} left before the rescue fails` : ''}.`;
      }
      delay = { reason: r.delay_reason, text, overdueAction };
    }

    return {
      id: r.id,
      state: r.bucket,
      status,
      needsAdmin: r.needs_admin,
      transportMode: mode,
      listing: { id: r.listing_id, title: r.title },
      // Coarse (about 1 km) positions for the operations map; exact addresses stay on the rescue page.
      area: { city: r.area_city, latitude: r.area_lat, longitude: r.area_lng },
      ngoArea: { latitude: r.ngo_lat, longitude: r.ngo_lng },
      provider: { id: r.provider_org_id, name: r.provider_name },
      ngo: { id: r.ngo_org_id, name: r.ngo_name },
      runner: r.runner_user_id ? { id: r.runner_user_id, name: r.runner_name } : null,
      servings: { offered: r.servings_offered, collected: r.collected_servings, delivered: r.delivered_servings },
      stage: {
        status,
        nextActor: r.delay_reason === 'BLOCKED_BY_INCIDENT' ? 'admin' : next.party,
        nextAction: r.delay_reason === 'BLOCKED_BY_INCIDENT' ? `Resolve the open incident, then: ${next.text}` : next.text,
        deadline: active && action && stageDeadline ? { label: action.deadlineLabel, at: stageDeadline.toISOString(), remainingMs: stageDeadline.getTime() - now.getTime() } : null,
        startedAt: stageStart ? stageStart.toISOString() : null,
        elapsedMs: stageStart ? Math.max(0, now.getTime() - stageStart.getTime()) : null,
      },
      delay,
      openIncidents: r.open_incidents,
      blocked: r.blocked,
      startedAt: reservedAt.toISOString(),
      ageMs: Math.max(0, now.getTime() - reservedAt.getTime()),
      pickupWindow: { start: new Date(r.pickup_start).toISOString(), deadline: new Date(r.pickup_deadline).toISOString() },
      completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
      closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
      outcomeCode: r.outcome_code,
      links: { rescue: `/admin/rescues/${r.id}`, incidents: r.open_incidents > 0 ? `/admin/incidents` : null },
    };
  }

  return {
    /** Counts per state for the current filters (the state tab itself does not narrow them), plus the paged rows. */
    async rescues(settleDue: (now: Date) => Promise<number>, f: BoardFilters) {
      const now = clock();
      await settle(settleDue, now);
      const page = Math.max(1, f.page ?? 1);
      const pageSize = Math.min(100, Math.max(1, f.pageSize ?? 25));
      const base = classified(f, now);

      const counts = (
        await db.execute(sql`
          SELECT bucket, count(*)::int AS n, count(*) FILTER (WHERE needs_admin)::int AS needs_admin, count(*) FILTER (WHERE blocked)::int AS blocked
            FROM (${base}) x GROUP BY bucket`)
      ).rows as { bucket: Bucket; n: number; needs_admin: number; blocked: number }[];
      const by = (b: Bucket) => counts.find((c) => c.bucket === b)?.n ?? 0;
      const summary = {
        active: by('active'),
        delayed: by('delayed'),
        failed: by('failed'),
        completed: by('completed'),
        cancelled: by('cancelled'),
        total: counts.reduce((a, c) => a + c.n, 0),
        needsAdmin: counts.reduce((a, c) => a + c.needs_admin, 0),
        blocked: counts.reduce((a, c) => a + c.blocked, 0),
      };

      const cond: SQL[] = [];
      if (f.state) cond.push(sql`bucket = ${f.state}`);
      if (f.blocked) cond.push(sql`blocked`);
      if (f.needsAdmin) cond.push(sql`needs_admin`);
      const filter = cond.length ? sql`WHERE ${sql.join(cond, sql` AND `)}` : sql``;
      const order =
        f.sort === 'newest'
          ? sql`ORDER BY reserved_at DESC, id ASC`
          : f.sort === 'oldest'
            ? sql`ORDER BY reserved_at ASC, id ASC`
            : sql`ORDER BY (CASE WHEN needs_admin THEN 0 WHEN bucket = 'delayed' THEN 1 WHEN bucket = 'active' THEN 2 WHEN bucket = 'failed' THEN 3 WHEN bucket = 'completed' THEN 4 ELSE 5 END) ASC,
                         (CASE WHEN bucket IN ('delayed', 'active') THEN stage_deadline END) ASC NULLS LAST,
                         (CASE WHEN bucket NOT IN ('delayed', 'active') THEN coalesce(closed_at, reserved_at) END) DESC NULLS LAST,
                         id ASC`;

      const total = (await db.execute(sql`SELECT count(*)::int AS n FROM (${base}) x ${filter}`)).rows[0] as { n: number };
      const rows = (await db.execute(sql`SELECT * FROM (${base}) x ${filter} ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)).rows as Row[];
      return {
        generatedAt: now.toISOString(),
        delayedRule: { elapsedPercent: pct },
        counts: summary,
        page: { number: page, size: pageSize, total: total.n, pages: Math.max(1, Math.ceil(total.n / pageSize)) },
        rescues: rows.map((r) => present(r, now)),
      };
    },

    /** One rescue's operational view (the audit history and incidents themselves stay on the existing admin pages). */
    async rescue(settleDue: (now: Date) => Promise<number>, id: string) {
      const now = clock();
      await settle(settleDue, now);
      const base = classified({}, now);
      const found = (await db.execute(sql`SELECT * FROM (${base}) x WHERE id = ${id}::uuid`)).rows as Row[];
      if (!found[0]) throw errors.notFound('Rescue not found.');
      const incidents = (
        await db.execute(sql`
          SELECT id, category, severity, blocking, status, created_at FROM incident_reports WHERE rescue_id = ${id}::uuid ORDER BY created_at DESC LIMIT 20`)
      ).rows as { id: string; category: string; severity: string; blocking: boolean; status: string; created_at: string }[];
      const events = (await db.execute(sql`SELECT count(*)::int AS n FROM rescue_events WHERE rescue_id = ${id}::uuid`)).rows[0] as { n: number };
      return {
        generatedAt: now.toISOString(),
        delayedRule: { elapsedPercent: pct },
        rescue: present(found[0], now),
        incidents: incidents.map((i) => ({ id: i.id, category: i.category, severity: i.severity, blocking: i.blocking, status: i.status, reportedAt: new Date(i.created_at).toISOString(), link: `/admin/incidents/${i.id}` })),
        auditEvents: events.n,
      };
    },

    /** Organizations and runners that appear in rescues, for the filter pickers (names only, bounded). */
    async options() {
      const orgs = (
        await db.execute(sql`
          SELECT o.id, o.name, o.type FROM organizations o
           WHERE o.id IN (SELECT provider_org_id FROM rescues UNION SELECT ngo_org_id FROM rescues)
           ORDER BY o.name ASC, o.id ASC LIMIT 300`)
      ).rows as { id: string; name: string; type: 'PROVIDER' | 'NGO' }[];
      const runners = (
        await db.execute(sql`
          SELECT u.id, u.name FROM users u WHERE u.id IN (SELECT runner_user_id FROM rescue_assignments)
           ORDER BY u.name ASC, u.id ASC LIMIT 300`)
      ).rows as { id: string; name: string }[];
      return { organizations: orgs, runners };
    },

    /**
     * Listings nobody has accepted. `live`: published, not past the pickup deadline, still AVAILABLE: supply that may need
     * a nudge. `closed`: expired or cancelled without ever being rescued, shown only for context and never actionable.
     */
    async listings(f: { scope?: 'live' | 'closed'; q?: string; providerOrgId?: string; urgency?: Urgency; noEligible?: boolean; closedFrom?: Date | null; closedBefore?: Date | null; page?: number; pageSize?: number }) {
      const now = clock();
      const n = iso(now);
      const scope = f.scope ?? 'live';
      const page = Math.max(1, f.page ?? 1);
      const pageSize = Math.min(100, Math.max(1, f.pageSize ?? 25));
      const w: SQL[] = [];
      if (scope === 'live') {
        w.push(sql`l.status = 'AVAILABLE' AND l.pickup_deadline > ${n}::timestamptz`);
      } else {
        w.push(sql`(l.status IN ('EXPIRED', 'CANCELLED') OR (l.status = 'AVAILABLE' AND l.pickup_deadline <= ${n}::timestamptz))`);
        w.push(sql`NOT EXISTS (SELECT 1 FROM rescues r WHERE r.listing_id = l.id AND r.status = 'COMPLETED')`);
        const closedAt = sql`coalesce(l.cancelled_at, l.expired_at, l.pickup_deadline)`;
        w.push(sql`${closedAt} >= ${iso(f.closedFrom ?? new Date(now.getTime() - 7 * 86_400_000))}::timestamptz`);
        if (f.closedBefore) w.push(sql`${closedAt} < ${iso(f.closedBefore)}::timestamptz`);
      }
      if (f.providerOrgId) w.push(sql`l.provider_org_id = ${f.providerOrgId}::uuid`);
      if (f.q) {
        const like = `%${escapeLike(f.q)}%`;
        w.push(sql`(l.title ILIKE ${like} OR po.name ILIKE ${like})`);
      }
      const minutesLeft = sql`EXTRACT(EPOCH FROM (l.pickup_deadline - ${n}::timestamptz)) / 60`;
      // Same thresholds as urgencyFor(): <30 critical, <60 urgent, <=120 priority, else normal.
      const urgencySql = sql`(CASE WHEN ${minutesLeft} <= 0 THEN 'EXPIRED' WHEN ${minutesLeft} < 30 THEN 'CRITICAL' WHEN ${minutesLeft} < 60 THEN 'URGENT' WHEN ${minutesLeft} <= 120 THEN 'PRIORITY' ELSE 'NORMAL' END)`;
      const narrowed = [...w];
      const extra: SQL[] = [];
      if (scope === 'live' && f.urgency) extra.push(sql`${urgencySql} = ${f.urgency}`);

      const from = sql`
        FROM food_listings l
        JOIN organizations po ON po.id = l.provider_org_id
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS evaluated,
                 count(*) FILTER (WHERE mc.eligible)::int AS eligible,
                 count(*) FILTER (WHERE mc.eligible AND mc.notified_at IS NOT NULL)::int AS notified
            FROM match_candidates mc WHERE mc.listing_id = l.id
        ) m ON TRUE`;
      const where = (extraConds: SQL[]) => {
        const all = [...narrowed, ...extraConds];
        return all.length ? sql`WHERE ${sql.join(all, sql` AND `)}` : sql``;
      };
      const noElig = f.noEligible ? [sql`coalesce(m.eligible, 0) = 0`] : [];

      const summary = (
        await db.execute(sql`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE coalesce(m.eligible, 0) = 0)::int AS no_eligible,
                 count(*) FILTER (WHERE ${urgencySql} = 'CRITICAL')::int AS critical,
                 count(*) FILTER (WHERE ${urgencySql} = 'URGENT')::int AS urgent,
                 count(*) FILTER (WHERE ${urgencySql} = 'PRIORITY')::int AS priority,
                 count(*) FILTER (WHERE ${urgencySql} = 'NORMAL')::int AS normal
            ${from} ${where([])}`)
      ).rows[0] as Record<string, number>;
      const total = (await db.execute(sql`SELECT count(*)::int AS n ${from} ${where([...extra, ...noElig])}`)).rows[0] as { n: number };
      const order = scope === 'live' ? sql`ORDER BY l.pickup_deadline ASC, l.id ASC` : sql`ORDER BY coalesce(l.cancelled_at, l.expired_at, l.pickup_deadline) DESC, l.id ASC`;
      const rows = (
        await db.execute(sql`
          SELECT l.id, l.title, l.city AS area_city, round(l.latitude::numeric, 2)::float8 AS area_lat, round(l.longitude::numeric, 2)::float8 AS area_lng, l.food_category, l.servings, l.status, l.transport_required, l.pickup_start, l.pickup_deadline, l.published_at,
                 l.cancelled_at, l.expired_at, l.provider_org_id, po.name AS provider_name,
                 coalesce(m.evaluated, 0) AS evaluated, coalesce(m.eligible, 0) AS eligible, coalesce(m.notified, 0) AS notified
            ${from} ${where([...extra, ...noElig])} ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)
      ).rows as Record<string, unknown>[];

      const esc = escalation ? await escalation.summaries(rows.map((r) => r.id as string)) : null;
      return {
        generatedAt: now.toISOString(),
        scope,
        counts: {
          total: summary.total!,
          noEligibleNgo: summary.no_eligible!,
          byUrgency: { CRITICAL: summary.critical!, URGENT: summary.urgent!, PRIORITY: summary.priority!, NORMAL: summary.normal! },
        },
        page: { number: page, size: pageSize, total: total.n, pages: Math.max(1, Math.ceil(total.n / pageSize)) },
        listings: rows.map((r) => {
          const deadline = new Date(r.pickup_deadline as string);
          const live = scope === 'live';
          return {
            id: r.id as string,
            title: r.title as string,
            foodCategory: r.food_category as string,
            servings: r.servings as number,
            provider: { id: r.provider_org_id as string, name: r.provider_name as string },
            area: { city: r.area_city as string | null, latitude: r.area_lat as number | null, longitude: r.area_lng as number | null },
            transportRequired: r.transport_required as boolean,
            status: live ? 'AVAILABLE' : (r.status as string) === 'AVAILABLE' ? 'EXPIRED' : (r.status as string),
            actionable: live,
            urgency: live ? urgencyFor(deadline, now) : null,
            pickupStart: new Date(r.pickup_start as string).toISOString(),
            pickupDeadline: deadline.toISOString(),
            remainingMs: live ? deadline.getTime() - now.getTime() : null,
            publishedAt: r.published_at ? new Date(r.published_at as string).toISOString() : null,
            publishedAgoMs: r.published_at ? Math.max(0, now.getTime() - new Date(r.published_at as string).getTime()) : null,
            closedAt: live ? null : new Date((r.cancelled_at ?? r.expired_at ?? r.pickup_deadline) as string).toISOString(),
            matching: { evaluated: r.evaluated as number, eligibleNgos: r.eligible as number, notifiedNgos: r.notified as number },
            escalation: escalation ? summarizeEscalation(escalation.settings.enabled, esc!.get(r.id as string)) : null,
            flags: live ? [...(((r.eligible as number) === 0) ? ['NO_ELIGIBLE_NGO'] : []), ...(((r.evaluated as number) === 0) ? ['NOT_YET_EVALUATED'] : [])] : [],
          };
        }),
      };
    },
  };
}

export type BoardService = ReturnType<typeof createBoardService>;
