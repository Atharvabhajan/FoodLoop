import { Router, type RequestHandler } from 'express';
import { requireRole } from '../../http/middleware.js';
import { ok } from '../../http/respond.js';
import type { ImpactService } from './service.js';

/**
 * GET /impact/me        provider, NGO, runner: your own organization's / your own deliveries
 * GET /impact/platform  admin: platform-wide totals
 * Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC, inclusive). /me also accepts ?organizationId= (must be your own).
 */
export function createImpactRouter(service: ImpactService, authenticate: RequestHandler) {
  const router = Router();
  const actor = (req: Express.Request) => ({ id: req.auth!.user.id, platformRole: req.auth!.user.platformRole });

  router.get('/me', authenticate, requireRole('provider', 'ngo', 'runner'), async (req, res) => {
    ok(req, res, await service.mine(actor(req), req.query as Record<string, unknown>));
  });

  router.get('/platform', authenticate, requireRole('admin'), async (req, res) => {
    ok(req, res, await service.platform(actor(req), req.query as Record<string, unknown>));
  });

  return router;
}
