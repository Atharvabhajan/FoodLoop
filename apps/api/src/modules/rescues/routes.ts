import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { fieldErrors } from '../../http/errors.js';
import { requireRole } from '../../http/middleware.js';
import { ok, parseBody } from '../../http/respond.js';
import { idParam } from '../organizations/routes.js';
import type { RescueService } from './service.js';

const expectedVersion = z.number().int().positive('expectedVersion must be a positive integer.').optional();
const reason = z.string().trim().min(3, 'A reason is required.').max(500, 'Reason is too long.');

const versionOnly = z.object({ expectedVersion }).strict();
const withReason = z.object({ reason, expectedVersion }).strict();
const verifySchema = z
  .object({
    code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit pickup code.'),
    collectedServings: z.number('Collected servings must be a number.').int('Collected servings must be a whole number.').positive('Collected servings must be at least 1.'),
    expectedVersion,
  })
  .strict();
const deliverySchema = z
  .object({
    deliveredServings: z
      .number('Delivered servings must be a number.')
      .int('Delivered servings must be a whole number.')
      .positive('Delivered servings must be at least 1. If nothing arrived, contact FoodLoop support.'),
    notes: z.string().trim().max(500, 'Notes are too long.').optional(),
    expectedVersion,
  })
  .strict();
const resolveSchema = z
  .object({
    deliveredServings: z.number('Delivered servings must be a number.').int().min(0, 'Delivered servings cannot be negative.'),
    reason,
  })
  .strict();
const listQuery = z.object({
  scope: z.enum(['active', 'past', 'all']).default('active'),
  listingId: z.uuid().optional(),
});

const actorOf = (req: Express.Request) => ({ id: req.auth!.user.id, platformRole: req.auth!.user.platformRole });

/** POST /listings/:id/accept, mounted on /listings before the listings router. */
export function createAcceptRouter(service: RescueService, authenticate: RequestHandler) {
  const router = Router();
  router.post('/:id/accept', authenticate, requireRole('ngo'), async (req, res) => {
    const body = parseBody(z.object({ transportMode: z.enum(['NGO_PICKUP', 'RUNNER'], 'Choose NGO_PICKUP or RUNNER.').optional() }).strict(), req.body);
    const out = await service.accept(actorOf(req), idParam(req.params.id), body);
    ok(req, res, out, out.created ? 201 : 200);
  });
  return router;
}

export function createRescuesRouter(service: RescueService, authenticate: RequestHandler) {
  const router = Router();
  router.use(authenticate);

  router.get('/', async (req, res) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) throw fieldErrors({ scope: 'Use active, past or all, and a valid listingId.' });
    ok(req, res, { rescues: await service.list(actorOf(req), q.data) });
  });

  router.get('/:id', async (req, res) => {
    ok(req, res, { rescue: await service.get(actorOf(req), idParam(req.params.id)) });
  });

  router.post('/:id/confirm', async (req, res) => {
    const body = parseBody(versionOnly, req.body);
    ok(req, res, await service.confirm(actorOf(req), idParam(req.params.id), body.expectedVersion));
  });

  router.post('/:id/reject', async (req, res) => {
    const body = parseBody(withReason, req.body);
    ok(req, res, await service.reject(actorOf(req), idParam(req.params.id), body.reason, body.expectedVersion));
  });

  router.post('/:id/pickup-code', async (req, res) => {
    parseBody(z.object({}).strict(), req.body);
    ok(req, res, await service.regenerateCode(actorOf(req), idParam(req.params.id)));
  });

  router.post('/:id/cancel', async (req, res) => {
    const body = parseBody(withReason, req.body);
    ok(req, res, await service.cancel(actorOf(req), idParam(req.params.id), body.reason, body.expectedVersion));
  });

  router.post('/:id/pickup/verify', async (req, res) => {
    const body = parseBody(verifySchema, req.body);
    ok(req, res, await service.verifyPickup(actorOf(req), idParam(req.params.id), body));
  });

  router.post('/:id/delivery/confirm', async (req, res) => {
    const body = parseBody(deliverySchema, req.body);
    ok(req, res, await service.confirmDelivery(actorOf(req), idParam(req.params.id), body));
  });

  router.post('/:id/admin/cancel', requireRole('admin'), async (req, res) => {
    const body = parseBody(z.object({ reason }).strict(), req.body);
    ok(req, res, await service.adminCancel(actorOf(req), idParam(req.params.id), body.reason));
  });

  router.post('/:id/admin/resolve', requireRole('admin'), async (req, res) => {
    const body = parseBody(resolveSchema, req.body);
    ok(req, res, await service.adminResolve(actorOf(req), idParam(req.params.id), body));
  });

  return router;
}
