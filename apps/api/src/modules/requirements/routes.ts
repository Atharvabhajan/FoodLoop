import { Router, type RequestHandler } from 'express';
import { requireRole } from '../../http/middleware.js';
import { ok, parseBody } from '../../http/respond.js';
import { createRequirementSchema, updateRequirementSchema } from './schemas.js';
import type { RequirementService } from './service.js';

/** One current requirement per NGO organization; all routes are NGO-only. */
export function createRequirementsRouter(service: RequirementService, authenticate: RequestHandler) {
  const router = Router();
  router.use(authenticate, requireRole('ngo'));
  const actor = (req: Express.Request) => ({ id: req.auth!.user.id, platformRole: req.auth!.user.platformRole });

  router.get('/current', async (req, res) => ok(req, res, await service.getCurrent(actor(req))));

  router.post('/', async (req, res) => {
    const input = parseBody(createRequirementSchema, req.body);
    ok(req, res, { requirement: await service.create(actor(req), input) }, 201);
  });

  router.patch('/current', async (req, res) => {
    const input = parseBody(updateRequirementSchema, req.body);
    ok(req, res, { requirement: await service.update(actor(req), input) });
  });

  router.post('/current/pause', async (req, res) => ok(req, res, { requirement: await service.setIntake(actor(req), false) }));
  router.post('/current/resume', async (req, res) => ok(req, res, { requirement: await service.setIntake(actor(req), true) }));

  return router;
}
