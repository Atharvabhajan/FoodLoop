import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { INCIDENT_CATEGORIES, INCIDENT_SEVERITIES, VEHICLE_TYPES } from '../../db/schema.js';
import { fieldErrors } from '../../http/errors.js';
import { requireRole } from '../../http/middleware.js';
import { ok, parseBody } from '../../http/respond.js';
import { RESOLUTIONS, type IncidentService } from '../incidents/service.js';
import { parseImageUpload } from '../listings/images.js';
import { idParam } from '../organizations/routes.js';
import type { RescueService } from '../rescues/service.js';
import type { RunnerService } from './service.js';

const expectedVersion = z.number().int().positive('expectedVersion must be a positive integer.').optional();
const reason = z.string().trim().min(3, 'A reason is required.').max(500, 'Reason is too long.');
const actorOf = (req: Express.Request) => ({ id: req.auth!.user.id, platformRole: req.auth!.user.platformRole });

const profileSchema = z
  .object({
    availabilityStatus: z.enum(['OFFLINE', 'AVAILABLE'], 'Choose OFFLINE or AVAILABLE.'),
    vehicleType: z.enum(VEHICLE_TYPES, 'Choose how you travel.').nullable(),
    capacityKg: z.number('Capacity must be a number.').positive('Capacity must be greater than zero.').max(1000, 'Capacity is too large.').nullable(),
    radiusKm: z.number('Radius must be a number.').positive('Radius must be greater than zero.').max(100, 'Radius cannot exceed 100 km.').nullable(),
    latitude: z.number('Latitude must be a number.').min(-90).max(90).nullable(),
    longitude: z.number('Longitude must be a number.').min(-180).max(180).nullable(),
  })
  .strict();

const locationSchema = z
  .object({
    latitude: z.number('Latitude must be a number.').min(-90).max(90),
    longitude: z.number('Longitude must be a number.').min(-180).max(180),
  })
  .strict();

const incidentSchema = z
  .object({
    category: z.enum(INCIDENT_CATEGORIES, 'Choose what went wrong.'),
    severity: z.enum(INCIDENT_SEVERITIES, 'Choose how serious it is.'),
    description: z.string().trim().min(10, 'Describe the problem in at least 10 characters.').max(1000, 'Description is too long.'),
  })
  .strict();

const resolveSchema = z
  .object({
    resolution: z.enum(RESOLUTIONS, 'Choose a resolution.'),
    note: z.string().trim().min(3, 'A note is required.').max(1000, 'Note is too long.'),
    deliveredServings: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * Runner, location and incident routes. Mounted on /rescues BEFORE the main rescues router: static paths such
 * as /available-runs must not be read as a rescue id. Authentication is applied per route so other /rescues
 * paths fall through untouched.
 */
export function createRunnerRoutes(rescues: RescueService, runners: RunnerService, incidents: IncidentService, authenticate: RequestHandler) {
  const rescueExtras = Router();

  rescueExtras.get('/available-runs', authenticate, requireRole('runner'), async (req, res) => {
    ok(req, res, { jobs: await runners.availableRuns(actorOf(req)) });
  });

  rescueExtras.post('/:id/assign-self', authenticate, requireRole('runner'), async (req, res) => {
    parseBody(z.object({}).strict(), req.body);
    const out = await runners.assignSelf(actorOf(req), idParam(req.params.id));
    ok(req, res, out);
  });

  rescueExtras.post('/:id/runner/release', authenticate, requireRole('runner'), async (req, res) => {
    const body = parseBody(z.object({ reason, expectedVersion }).strict(), req.body);
    ok(req, res, await runners.release(actorOf(req), idParam(req.params.id), body.reason, body.expectedVersion));
  });

  rescueExtras.post('/:id/delivery/handover', authenticate, requireRole('runner'), async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500, 'Note is too long.').optional(), expectedVersion }).strict(), req.body);
    ok(req, res, await runners.handover(actorOf(req), idParam(req.params.id), body.note, body.expectedVersion));
  });

  rescueExtras.post('/:id/transport/self', authenticate, requireRole('ngo'), async (req, res) => {
    const body = parseBody(z.object({ expectedVersion }).strict(), req.body);
    ok(req, res, await runners.collectMyself(actorOf(req), idParam(req.params.id), body.expectedVersion));
  });

  rescueExtras.post('/:id/location', authenticate, requireRole('runner'), async (req, res) => {
    const body = parseBody(locationSchema, req.body);
    ok(req, res, await runners.updateLocation(actorOf(req), idParam(req.params.id), body));
  });

  rescueExtras.delete('/:id/location', authenticate, requireRole('runner'), async (req, res) => {
    ok(req, res, await runners.clearLocation(actorOf(req), idParam(req.params.id)));
  });

  rescueExtras.get('/:id/location', authenticate, async (req, res) => {
    ok(req, res, await runners.readLocation(actorOf(req), idParam(req.params.id)));
  });

  rescueExtras.post('/:id/admin/reassign', authenticate, requireRole('admin'), async (req, res) => {
    const body = parseBody(z.object({ reason }).strict(), req.body);
    ok(req, res, await runners.adminReassign(actorOf(req), idParam(req.params.id), body.reason));
  });

  rescueExtras.post('/:id/admin/fail', authenticate, requireRole('admin'), async (req, res) => {
    const body = parseBody(z.object({ reason }).strict(), req.body);
    ok(req, res, await rescues.adminFail(actorOf(req), idParam(req.params.id), body.reason));
  });

  rescueExtras.post('/:id/incidents', authenticate, async (req, res) => {
    const body = parseBody(incidentSchema, req.body);
    ok(req, res, await incidents.report(actorOf(req), idParam(req.params.id), body), 201);
  });

  rescueExtras.post('/:id/incidents/:incidentId/evidence', authenticate, async (req, res) => {
    // Authorize first, so an unauthorized caller never has a body read; then bound the upload (3 MB, one file).
    const [rescueId, incidentId] = [idParam(req.params.id), idParam(req.params.incidentId)];
    await incidents.assertCanAttach(actorOf(req), rescueId, incidentId);
    await parseImageUpload(req, res);
    ok(req, res, await incidents.addEvidence(actorOf(req), rescueId, incidentId, req.file), 201);
  });

  rescueExtras.get('/:id/incidents/:incidentId/evidence/:evidenceId', authenticate, async (req, res) => {
    const { mime, stream } = await incidents.openEvidence(actorOf(req), idParam(req.params.id), idParam(req.params.incidentId), idParam(req.params.evidenceId));
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Evidence is unavailable.', details: {}, meta: { requestId: req.requestId } });
      else res.destroy();
    });
    stream.pipe(res);
  });

  /* ------------------------------ /runner/profile ------------------------------ */
  const profile = Router();
  profile.use(authenticate, requireRole('runner'));
  profile.get('/profile', async (req, res) => ok(req, res, await runners.getProfile(actorOf(req))));
  profile.put('/profile', async (req, res) => ok(req, res, await runners.saveProfile(actorOf(req), parseBody(profileSchema, req.body))));

  /* ------------------------------ /incidents (admin) ------------------------------ */
  const admin = Router();
  admin.use(authenticate, requireRole('admin'));
  admin.get('/', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'OPEN';
    if (!['OPEN', 'RESOLVED', 'ALL'].includes(status)) throw fieldErrors({ status: 'Use OPEN, RESOLVED or ALL.' });
    ok(req, res, { incidents: await incidents.list(actorOf(req), status as 'OPEN' | 'RESOLVED' | 'ALL') });
  });
  admin.get('/:id', async (req, res) => ok(req, res, await incidents.detail(actorOf(req), idParam(req.params.id))));
  admin.post('/:id/resolve', async (req, res) => {
    const body = parseBody(resolveSchema, req.body);
    ok(req, res, await incidents.resolve(actorOf(req), idParam(req.params.id), body));
  });

  return { rescueExtras, profile, admin };
}
