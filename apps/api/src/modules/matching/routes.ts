import { Router, type RequestHandler } from 'express';
import { requireRole } from '../../http/middleware.js';
import { ok } from '../../http/respond.js';
import { idParam } from '../organizations/routes.js';
import type { MatchingService } from './service.js';

/**
 * Recommendation endpoints (recommendations only: nothing here accepts or reserves a listing).
 * Mounted on /listings BEFORE the listings router so "/recommended" is not read as a listing id;
 * authentication is applied per route so other /listings paths fall through untouched.
 */
export function createMatchingRouter(service: MatchingService, authenticate: RequestHandler) {
  const router = Router();
  const actor = (req: Express.Request) => ({ id: req.auth!.user.id, platformRole: req.auth!.user.platformRole });

  router.get('/recommended', authenticate, requireRole('ngo'), async (req, res) => {
    ok(req, res, await service.recommendedForNgo(actor(req)));
  });

  router.post('/recommended/refresh', authenticate, requireRole('ngo'), async (req, res) => {
    ok(req, res, await service.refreshForNgo(actor(req)));
  });

  router.get('/:id/matches', authenticate, async (req, res) => {
    ok(req, res, await service.getListingMatches(actor(req), idParam(req.params.id)));
  });

  router.post('/:id/matches/refresh', authenticate, async (req, res) => {
    const result = await service.refreshListing(actor(req), idParam(req.params.id));
    ok(req, res, { ...result, ...(await service.getListingMatches(actor(req), idParam(req.params.id))) });
  });

  return router;
}
