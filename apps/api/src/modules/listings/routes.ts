import { Router, type RequestHandler } from 'express';
import { fieldErrors } from '../../http/errors.js';
import { requireRole } from '../../http/middleware.js';
import { ok, parseBody } from '../../http/respond.js';
import { idParam } from '../organizations/routes.js';
import { DECLARATION_TEXT } from './constants.js';
import { parseImageUpload } from './images.js';
import {
  cancelSchema,
  createListingSchema,
  feedQuerySchema,
  listScopeSchema,
  publishSchema,
  updateListingSchema,
} from './schemas.js';
import type { ListingService } from './service.js';

export function createListingsRouter(service: ListingService, authenticate: RequestHandler) {
  const router = Router();
  router.use(authenticate);
  const actor = (req: Express.Request) => ({ id: req.auth!.user.id, platformRole: req.auth!.user.platformRole });

  // Static paths first so they are not captured by "/:id".
  router.get('/declaration', (req, res) => ok(req, res, { declaration: DECLARATION_TEXT }));

  router.get('/feed', requireRole('ngo'), async (req, res) => {
    const parsed = feedQuerySchema.safeParse(req.query);
    if (!parsed.success) throw fieldErrors({ category: 'Unknown food category.' });
    ok(req, res, { listings: await service.feed(actor(req), parsed.data) });
  });

  router.post('/', requireRole('provider'), async (req, res) => {
    const input = parseBody(createListingSchema, req.body);
    ok(req, res, { listing: await service.create(actor(req), input) }, 201);
  });

  router.get('/', requireRole('provider'), async (req, res) => {
    const scope = listScopeSchema.safeParse(req.query.scope);
    if (!scope.success) throw fieldErrors({ scope: 'Use active, past or all.' });
    ok(req, res, { listings: await service.listMine(actor(req), scope.data) });
  });

  router.get('/:id', async (req, res) => {
    ok(req, res, { listing: await service.get(actor(req), idParam(req.params.id)) });
  });

  router.patch('/:id', async (req, res) => {
    const input = parseBody(updateListingSchema, req.body);
    ok(req, res, { listing: await service.update(actor(req), idParam(req.params.id), input) });
  });

  router.post('/:id/publish', async (req, res) => {
    parseBody(publishSchema, req.body);
    ok(req, res, { listing: await service.publish(actor(req), idParam(req.params.id)) });
  });

  router.post('/:id/cancel', async (req, res) => {
    const { reason } = parseBody(cancelSchema, req.body);
    ok(req, res, { listing: await service.cancel(actor(req), idParam(req.params.id), reason) });
  });

  router.get('/:id/history', async (req, res) => {
    ok(req, res, { history: await service.history(actor(req), idParam(req.params.id)) });
  });

  router.post('/:id/image', async (req, res) => {
    const id = idParam(req.params.id);
    await service.assertCanManage(actor(req), id);
    await parseImageUpload(req, res);
    ok(req, res, await service.setImage(actor(req), id, req.file), 201);
  });

  router.delete('/:id/image', async (req, res) => {
    await service.removeImage(actor(req), idParam(req.params.id));
    ok(req, res, { removed: true });
  });

  router.get('/:id/image', async (req, res) => {
    const { mime, stream } = await service.openImage(actor(req), idParam(req.params.id));
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Image is unavailable.', details: {}, meta: { requestId: req.requestId } });
      } else res.destroy();
    });
    stream.pipe(res);
  });

  return router;
}
