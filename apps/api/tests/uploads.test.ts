import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskStorage } from '../src/storage/index.js';
import { pdfBytes, pngBytes, rawUpload, resetData, setup, signedInAgent, submitApplication, uploadDoc } from './helpers.js';

const ctx = setup();
beforeEach(async () => {
  await resetData(ctx.db);
  rmSync(ctx.config.STORAGE_DIR, { recursive: true, force: true });
  mkdirSync(ctx.config.STORAGE_DIR, { recursive: true });
});
afterAll(() => ctx.pool.end());

const docCount = async () =>
  ((await ctx.db.execute(sql`SELECT count(*)::int AS n FROM verification_documents`)).rows[0] as { n: number }).n;

function filesUnderStorage(dir = ctx.config.STORAGE_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnderStorage(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe('document upload validation', () => {
  it('accepts a PDF and PNG, stores bytes on disk (not in the database) under a server-generated name', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const pdf = await uploadDoc(agent, organizationId!, { filename: 'My Certificate.pdf' });
    expect(pdf.status).toBe(201);
    expect(pdf.body.data.document).toMatchObject({
      documentType: 'REGISTRATION_CERTIFICATE',
      originalFilename: 'My Certificate.pdf',
      mimeType: 'application/pdf',
      reviewStatus: 'PENDING',
    });
    expect(Object.keys(pdf.body.data.document).sort()).toEqual(
      ['createdAt', 'documentType', 'id', 'mimeType', 'originalFilename', 'reviewStatus', 'sizeBytes'],
    );
    const png = await uploadDoc(agent, organizationId!, { type: 'ID_PROOF', filename: 'id.png', data: pngBytes(), contentType: 'image/png' });
    expect(png.status).toBe(201);

    const files = filesUnderStorage();
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(path.basename(f)).toMatch(/^[0-9a-f-]{36}\.(pdf|png)$/); // not derived from the client filename
      expect(path.relative(ctx.config.STORAGE_DIR, f).startsWith('..')).toBe(false);
    }
    expect(readFileSync(files.find((f) => f.endsWith('.pdf'))!).equals(pdfBytes())).toBe(true);
  });

  it('rejects unsupported types: wrong bytes, wrong extension, disguised executables', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const cases: [string, Buffer, string][] = [
      ['notes.txt', Buffer.from('just text'), 'text/plain'],
      ['evil.pdf', Buffer.from('MZ\x90\x00 not really a pdf'), 'application/pdf'], // claims PDF, bytes say otherwise
      ['page.html', Buffer.from('<script>alert(1)</script>'), 'text/html'],
      ['photo.png', pdfBytes(), 'image/png'], // PDF bytes with a .png name
      ['noextension', pdfBytes(), 'application/pdf'],
    ];
    for (const [filename, data, contentType] of cases) {
      const res = await uploadDoc(agent, organizationId!, { filename, data, contentType });
      expect(res.status, filename).toBe(415);
      expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE');
    }
    expect(await docCount()).toBe(0);
    expect(filesUnderStorage()).toHaveLength(0);
  });

  it('rejects files over the 5 MB limit with 413 and stores nothing', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const big = Buffer.concat([pdfBytes(), Buffer.alloc(5 * 1024 * 1024 + 1024)]);
    const res = await uploadDoc(agent, organizationId!, { data: big, filename: 'big.pdf' });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
    expect(await docCount()).toBe(0);
    expect(filesUnderStorage()).toHaveLength(0);
  });

  it.each(['../../evil.pdf', '..\\..\\evil.pdf', '/etc/passwd.pdf', 'a/b.pdf', 'evil..pdf', 'nul\u0000.pdf', '..pdf'])(
    'rejects the unsafe filename %j',
    async (filename) => {
      const { agent, organizationId } = await signedInAgent(ctx, 'provider');
      const res = await rawUpload(agent, organizationId!, filename);
      expect(res.status).toBe(400);
      // Control characters may be refused by the multipart parser itself; either way nothing is stored.
      expect(['INVALID_FILENAME', 'UPLOAD_INVALID']).toContain(res.body.code);
      expect(await docCount()).toBe(0);
      expect(filesUnderStorage()).toHaveLength(0);
    },
  );

  it('requires a valid document type and a file', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const badType = await uploadDoc(agent, organizationId!, { type: 'PASSPORT' });
    expect(badType.status).toBe(400);
    expect(badType.body.details.fields.documentType).toBeDefined();
    const noFile = await agent.post(`/api/v1/organizations/${organizationId}/documents`).field('documentType', 'OTHER');
    expect(noFile.status).toBe(400);
    expect(noFile.body.code).toBe('FILE_REQUIRED');
  });

  it('is only allowed while the application is editable', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    await submitApplication(agent, organizationId!);
    const res = await uploadDoc(agent, organizationId!, { filename: 'late.pdf' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORGANIZATION_LOCKED');
  });
});

describe('document access control', () => {
  it('lists and downloads only for members and admins; others get 404', async () => {
    const owner = await signedInAgent(ctx, 'provider');
    const upload = await uploadDoc(owner.agent, owner.organizationId!);
    const docId = upload.body.data.document.id;
    const base = `/api/v1/organizations/${owner.organizationId}/documents`;

    const own = await owner.agent.get(`${base}/${docId}/file`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toMatch(/application\/pdf/);
    expect(own.headers['content-disposition']).toMatch(/^attachment/);
    expect(own.headers['cache-control']).toMatch(/no-store/);
    expect(own.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(own.body).equals(pdfBytes())).toBe(true);

    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.get(`${base}/${docId}/file`)).status).toBe(200);
    expect((await admin.agent.get(base)).body.data.documents).toHaveLength(1);

    const other = await signedInAgent(ctx, 'provider');
    expect((await other.agent.get(base)).status).toBe(404);
    expect((await other.agent.get(`${base}/${docId}/file`)).status).toBe(404);
    expect((await other.agent.delete(`${base}/${docId}`)).status).toBe(404);
    expect((await uploadDoc(other.agent, owner.organizationId!)).status).toBe(404);
    expect((await request(ctx.app).get(`${base}/${docId}/file`)).status).toBe(401);

    // Another org cannot reach the document by pairing its own org id with this document id.
    expect((await other.agent.get(`/api/v1/organizations/${other.organizationId}/documents/${docId}/file`)).status).toBe(404);
  });

  it('serves nothing from the storage directory over HTTP', async () => {
    const owner = await signedInAgent(ctx, 'provider');
    await uploadDoc(owner.agent, owner.organizationId!);
    const key = path.relative(ctx.config.STORAGE_DIR, filesUnderStorage()[0]!).replaceAll('\\', '/');
    for (const url of [`/${key}`, `/uploads/${key}`, `/storage/${key}`, `/api/v1/uploads/${key}`]) {
      expect((await request(ctx.app).get(url)).status, url).toBe(404);
    }
  });

  it('lets an owner delete a document while editable, removing the stored file', async () => {
    const owner = await signedInAgent(ctx, 'provider');
    const up = await uploadDoc(owner.agent, owner.organizationId!);
    expect(filesUnderStorage()).toHaveLength(1);
    const del = await owner.agent.delete(`/api/v1/organizations/${owner.organizationId}/documents/${up.body.data.document.id}`);
    expect(del.status).toBe(200);
    expect(filesUnderStorage()).toHaveLength(0);
    expect(await docCount()).toBe(0);
  });
});

describe('LocalDiskStorage', () => {
  it('refuses keys and names that would escape the root', async () => {
    const storage = new LocalDiskStorage(ctx.config.STORAGE_DIR);
    await expect(storage.save('../escape', 'pdf', Buffer.from('x'))).rejects.toThrow();
    await expect(storage.save('ok', '../x', Buffer.from('x'))).rejects.toThrow();
    expect(() => storage.open('../../etc/passwd')).toThrow();
    await expect(storage.remove('../../outside.txt')).rejects.toThrow();
    const key = await storage.save('ns', 'pdf', Buffer.from('x'));
    expect(existsSync(path.join(ctx.config.STORAGE_DIR, key))).toBe(true);
  });
});
