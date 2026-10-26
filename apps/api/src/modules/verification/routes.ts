import { Router, type RequestHandler } from 'express';
import { requireRole } from '../../http/middleware.js';
import { AppError } from '../../http/errors.js';
import { ok, parseBody } from '../../http/respond.js';
import { decisionSchema } from '../organizations/schemas.js';
import { idParam } from '../organizations/routes.js';
import { isVerificationStatus, type VerificationService } from './service.js';

/** Admin-only verification queue and decisions. `:id` is the organization id. */
export function createAdminVerificationRouter(service: VerificationService, authenticate: RequestHandler) {
  const router = Router();
  router.use(authenticate, requireRole('admin'));

  router.get('/', async (req, res) => {
    const raw = typeof req.query.status === 'string' ? req.query.status : 'UNDER_REVIEW';
    if (raw !== 'ALL' && !isVerificationStatus(raw)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', { fields: { status: 'Unknown status filter.' } });
    }
    ok(req, res, { organizations: await service.queue(raw) });
  });

  router.get('/:id', async (req, res) => {
    ok(req, res, await service.detail(idParam(req.params.id)));
  });

  router.post('/:id/decision', async (req, res) => {
    const input = parseBody(decisionSchema, req.body);
    ok(req, res, { organization: await service.decide(req.auth!.user.id, idParam(req.params.id), input) });
  });

  return router;
}
