import { Router, type RequestHandler } from 'express';
import { errors } from '../../http/errors.js';
import { requireRole } from '../../http/middleware.js';
import { ok, parseBody } from '../../http/respond.js';
import { parseUpload, type DocumentService } from './documents.js';
import { createOrganizationSchema, updateOrganizationSchema, uploadFieldsSchema, uuidParam } from './schemas.js';
import type { OrganizationService } from './service.js';

/** Route params that are not UUIDs are treated as unknown resources. */
export function idParam(value: unknown): string {
  const parsed = uuidParam.safeParse(value);
  if (!parsed.success) throw errors.notFound();
  return parsed.data;
}

export function createOrganizationsRouter(
  orgs: OrganizationService,
  docs: DocumentService,
  authenticate: RequestHandler,
) {
  const router = Router();
  router.use(authenticate);
  const actor = (req: Express.Request) => ({ id: req.auth!.user.id, platformRole: req.auth!.user.platformRole });

  router.post('/', requireRole('provider', 'ngo'), async (req, res) => {
    const input = parseBody(createOrganizationSchema, req.body);
    ok(req, res, { organization: await orgs.create(actor(req), input) }, 201);
  });

  router.get('/', requireRole('provider', 'ngo'), async (req, res) => {
    ok(req, res, { organizations: await orgs.listMine(actor(req)) });
  });

  router.get('/:id', async (req, res) => {
    const id = idParam(req.params.id);
    ok(req, res, { organization: await orgs.get(actor(req), id) });
  });

  router.patch('/:id', async (req, res) => {
    const id = idParam(req.params.id);
    const input = parseBody(updateOrganizationSchema, req.body);
    ok(req, res, { organization: await orgs.update(actor(req), id, input) });
  });

  router.post('/:id/submit', async (req, res) => {
    const id = idParam(req.params.id);
    ok(req, res, { organization: await orgs.submit(actor(req), id) });
  });

  router.get('/:id/verification-history', async (req, res) => {
    const id = idParam(req.params.id);
    ok(req, res, { history: await orgs.historyForApplicant(actor(req), id) });
  });

  router.get('/:id/documents', async (req, res) => {
    const id = idParam(req.params.id);
    ok(req, res, { documents: await docs.list(actor(req), id) });
  });

  router.post('/:id/documents', async (req, res) => {
    const id = idParam(req.params.id);
    // Authorize before reading the upload body so unauthorized callers cannot make us buffer files.
    await orgs.resolve(actor(req), id, 'manage');
    await parseUpload(req, res);
    const { documentType } = parseBody(uploadFieldsSchema, req.body);
    ok(req, res, { document: await docs.add(actor(req), id, documentType, req.file) }, 201);
  });

  router.delete('/:id/documents/:docId', async (req, res) => {
    await docs.remove(actor(req), idParam(req.params.id), idParam(req.params.docId));
    ok(req, res, { deleted: true });
  });

  router.get('/:id/documents/:docId/file', async (req, res) => {
    const { doc, stream } = await docs.open(actor(req), idParam(req.params.id), idParam(req.params.docId));
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.originalFilename)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Document file is unavailable.', details: {}, meta: { requestId: req.requestId } });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });

  return router;
}
