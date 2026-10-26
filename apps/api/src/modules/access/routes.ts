import { Router, type RequestHandler } from 'express';
import { ok } from '../../http/respond.js';
import { requirePermission, requireRole } from '../../http/middleware.js';

/**
 * Foundation test routes. They exist only to prove server-side authorization works
 * and carry no business behavior.
 */
export function createAccessRouter(authenticate: RequestHandler) {
  const router = Router();
  router.use(authenticate);

  const probe = (area: string): RequestHandler => (req, res) =>
    ok(req, res, { area, userId: req.auth!.user.id, role: req.auth!.user.platformRole });

  router.get('/provider', requireRole('provider'), probe('provider'));
  router.get('/ngo', requireRole('ngo'), probe('ngo'));
  router.get('/runner', requireRole('runner'), probe('runner'));
  router.get('/admin', requireRole('admin'), probe('admin'));
  // Permission-based (not role-name based) so later roles can be granted platform management explicitly.
  router.get('/admin-only', requirePermission('platform:manage'), probe('admin-only'));

  return router;
}
