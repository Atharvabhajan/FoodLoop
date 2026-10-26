import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { errors, validationError } from '../../http/errors.js';
import { requireRole } from '../../http/middleware.js';
import { ok } from '../../http/respond.js';
import { parsePeriod } from '../impact/service.js';
import { idParam } from '../organizations/routes.js';
import type { EscalationService } from '../escalation/service.js';
import type { RescueService } from '../rescues/service.js';
import { BUCKETS, type BoardService } from './service.js';

const uuid = z.string().uuid('Use a valid id.');
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (min: number, max: number, msg: string) => z.coerce.number(msg).int(msg).min(min, msg).max(max, msg);

const rescueQuery = z
  .object({
    state: z.enum(BUCKETS, 'Choose active, delayed, failed, completed or cancelled.').optional(),
    providerOrgId: uuid.optional(),
    ngoOrgId: uuid.optional(),
    runnerUserId: uuid.optional(),
    transportMode: z.enum(['NGO_PICKUP', 'RUNNER'], 'Choose NGO_PICKUP or RUNNER.').optional(),
    q: z.string().trim().max(100, 'Search text is too long.').optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    olderThanMinutes: int(1, 525_600, 'Use a number of minutes between 1 and 525600.').optional(),
    blocked: flag.optional(),
    needsAdmin: flag.optional(),
    sort: z.enum(['attention', 'newest', 'oldest'], 'Sort by attention, newest or oldest.').optional(),
    page: int(1, 100_000, 'Page must be 1 or more.').optional(),
    pageSize: int(1, 100, 'Page size must be between 1 and 100.').optional(),
  })
  .strict();

const listingQuery = z
  .object({
    scope: z.enum(['live', 'closed'], 'Choose live or closed.').optional(),
    q: z.string().trim().max(100, 'Search text is too long.').optional(),
    providerOrgId: uuid.optional(),
    urgency: z.enum(['NORMAL', 'PRIORITY', 'URGENT', 'CRITICAL'], 'Choose an urgency level.').optional(),
    noEligible: flag.optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page: int(1, 100_000, 'Page must be 1 or more.').optional(),
    pageSize: int(1, 100, 'Page size must be between 1 and 100.').optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, query: unknown): T {
  const r = schema.safeParse(query);
  if (!r.success) throw validationError(r.error);
  return r.data;
}

/**
 * Admin live operations board. Every route is admin-only on the server; the board only reads (interventions use the existing
 * audited admin actions on /rescues/:id/admin/* and /incidents/:id/resolve).
 */
export function createBoardRouter(board: BoardService, rescues: RescueService, authenticate: RequestHandler, escalation?: EscalationService) {
  const router = Router();
  router.use(authenticate, requireRole('admin'));
  const settleDue = (now: Date) => rescues.settleDue(now);

  router.get('/rescues', async (req, res) => {
    const q = parse(rescueQuery, req.query);
    const { start, endExclusive } = parsePeriod(q.from, q.to);
    ok(
      req,
      res,
      await board.rescues(settleDue, {
        state: q.state,
        providerOrgId: q.providerOrgId,
        ngoOrgId: q.ngoOrgId,
        runnerUserId: q.runnerUserId,
        transportMode: q.transportMode,
        q: q.q || undefined,
        startedFrom: start,
        startedBefore: endExclusive,
        olderThanMinutes: q.olderThanMinutes,
        blocked: q.blocked,
        needsAdmin: q.needsAdmin,
        sort: q.sort,
        page: q.page,
        pageSize: q.pageSize,
      }),
    );
  });

  router.get('/rescues/:id', async (req, res) => {
    ok(req, res, await board.rescue(settleDue, idParam(req.params.id)));
  });

  router.get('/options', async (req, res) => {
    ok(req, res, await board.options());
  });

  router.get('/listings', async (req, res) => {
    const q = parse(listingQuery, req.query);
    const { start, endExclusive } = parsePeriod(q.from, q.to);
    ok(
      req,
      res,
      await board.listings({
        scope: q.scope,
        q: q.q || undefined,
        providerOrgId: q.providerOrgId,
        urgency: q.urgency,
        noEligible: q.noEligible,
        closedFrom: start,
        closedBefore: endExclusive,
        page: q.page,
        pageSize: q.pageSize,
      }),
    );
  });

  /** The full wave history of one listing: which waves ran, when, how many qualified, who was told, and the final alert. */
  router.get('/listings/:id/escalation', async (req, res) => {
    if (!escalation) throw errors.notFound('Escalation history is not available.');
    ok(req, res, await escalation.history(idParam(req.params.id)));
  });

  return router;
}
