import { desc, eq, sql } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import type { Db } from '../../db/client.js';
import { notifications } from '../../db/schema.js';
import { ok } from '../../http/respond.js';

/** Minimal in-app inbox: a user reads only their own notifications. No push channels yet. */
export function createNotificationsRouter(db: Db, authenticate: RequestHandler) {
  const router = Router();
  router.use(authenticate);

  router.get('/', async (req, res) => {
    const userId = req.auth!.user.id;
    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        body: notifications.body,
        entityType: notifications.entityType,
        entityId: notifications.entityId,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(sql`${notifications.userId} = ${userId} AND ${notifications.readAt} IS NULL`);
    // Stale notifications are never actionable: a match only counts while the listing is still live and this
    // user's NGO is still an eligible candidate; a rescue update only while that rescue is still in progress.
    const listingIds = rows.filter((r) => r.type === 'LISTING_MATCH' && r.entityId).map((r) => r.entityId!);
    const rescueIds = rows.filter((r) => (r.type === 'RESCUE_UPDATE' || r.type === 'RUNNER_JOB') && r.entityId).map((r) => r.entityId!);
    const alertIds = rows.filter((r) => (r.type === 'LISTING_RUNNER_ALERT' || r.type === 'ESCALATION_ADMIN') && r.entityId).map((r) => r.entityId!);
    const openListings = new Set<string>(); // listings still open (runner and admin escalation alerts)
    if (alertIds.length > 0) {
      const open = await db.execute(sql`SELECT id FROM food_listings WHERE status = 'AVAILABLE' AND pickup_deadline > now() AND id IN (${sql.join(alertIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
      for (const r of open.rows as { id: string }[]) openListings.add(r.id);
    }
    const liveMatches = new Set<string>();
    if (listingIds.length > 0) {
      const live = await db.execute(sql`
        SELECT DISTINCT mc.listing_id FROM match_candidates mc
          JOIN food_listings l ON l.id = mc.listing_id
          JOIN organization_members m ON m.organization_id = mc.ngo_org_id AND m.user_id = ${userId}::uuid AND m.status = 'ACTIVE'
         WHERE mc.eligible AND l.status = 'AVAILABLE' AND l.pickup_deadline > now()
           AND mc.listing_id IN (${sql.join(listingIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
      for (const r of live.rows as { listing_id: string }[]) liveMatches.add(r.listing_id);
    }
    const activeRescues = new Set<string>();
    const openJobs = new Set<string>(); // runner jobs still waiting for a runner
    if (rescueIds.length > 0) {
      const act = await db.execute(sql`
        SELECT id, status::text AS status, runner_by FROM rescues WHERE status IN ('RESERVED', 'AWAITING_RUNNER', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DELIVERED', 'DELIVERY_FAILED')
           AND id IN (${sql.join(rescueIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
      for (const r of act.rows as { id: string; status: string; runner_by: string | null }[]) {
        activeRescues.add(r.id);
        if (r.status === 'AWAITING_RUNNER' && r.runner_by && new Date(r.runner_by) > new Date()) openJobs.add(r.id);
      }
    }
    const withState = rows.map((r) => ({
      ...r,
      actionable: r.type === 'LISTING_MATCH' ? liveMatches.has(r.entityId ?? '') : r.type === 'RESCUE_UPDATE' ? activeRescues.has(r.entityId ?? '') : r.type === 'RUNNER_JOB' ? openJobs.has(r.entityId ?? '') : r.type === 'LISTING_RUNNER_ALERT' || r.type === 'ESCALATION_ADMIN' ? openListings.has(r.entityId ?? '') : false,
    }));
    ok(req, res, { notifications: withState, unreadCount: n });
  });

  return router;
}
