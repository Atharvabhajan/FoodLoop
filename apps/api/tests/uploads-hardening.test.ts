import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { LocalDiskStorage, type FileStorage } from '../src/storage/index.js';
import { pdfBytes, resetData, setup, signedInAgent, verifiedAgent } from './helpers.js';
import { R, assigned, count } from './runner-helpers.js';

const ctx = setup();
const storage = new LocalDiskStorage(ctx.config.STORAGE_DIR);
beforeEach(async () => {
  await resetData(ctx.db);
  rmSync(ctx.config.STORAGE_DIR, { recursive: true, force: true });
  mkdirSync(ctx.config.STORAGE_DIR, { recursive: true });
});
afterAll(() => ctx.pool.end());

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13)), chunk('IDAT', Buffer.from([1, 2, 3, 4])), chunk('IEND', Buffer.alloc(0))]);
const storedFiles = () => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else out.push(e.name);
    }
  };
  walk(ctx.config.STORAGE_DIR);
  return out;
};

async function cookieFor(email: string) {
  const res = await request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'Test-Password-123' });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!).join('; ');
}

const brokenStorage: FileStorage = {
  save: async () => {
    throw new Error('ENOSPC: no space left on device, write /var/data/uploads/secret-name.png');
  },
  open: (k) => storage.open(k),
  remove: (k) => storage.remove(k),
  list: () => storage.list(),
};

describe('when the storage layer fails', () => {
  it('a verification document upload fails cleanly: generic 500, nothing recorded, no path leaked', async () => {
    const owner = await signedInAgent(ctx, 'provider');
    const app = createApp({ config: ctx.config, db: ctx.runtime.db, pool: ctx.runtime.pool, storage: brokenStorage });
    const cookie = await cookieFor(owner.email);
    const res = await request(app)
      .post(`/api/v1/organizations/${owner.organizationId}/documents`)
      .set('Cookie', cookie)
      .field('documentType', 'REGISTRATION_CERTIFICATE')
      .attach('file', pdfBytes(), { filename: 'c.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/ENOSPC|\/var\/data|secret-name/);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM verification_documents`)).toBe(0);
  });

  it('an evidence upload fails cleanly: nothing recorded and the incident can still take a photo afterwards', async () => {
    const s = await assigned(ctx);
    const incident = (await s.runner.agent.post(`${R(s.rescueId)}/incidents`).send({ category: 'OTHER', severity: 'LOW', description: 'Something is wrong here today.' })).body.data.incident.id as string;
    const app = createApp({ config: ctx.config, db: ctx.runtime.db, pool: ctx.runtime.pool, storage: brokenStorage });
    const cookie = await cookieFor(s.runner.email);
    const bad = await request(app).post(`${R(s.rescueId)}/incidents/${incident}/evidence`).set('Cookie', cookie).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(bad.status).toBe(500);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM incident_evidence`)).toBe(0);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM rescue_events WHERE event_type = 'INCIDENT_EVIDENCE_ADDED'`)).toBe(0);
    const good = await s.runner.agent.post(`${R(s.rescueId)}/incidents/${incident}/evidence`).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(good.status).toBe(201);
  });
});

describe('the evidence limit holds under concurrent uploads, and refused uploads leave no files behind', () => {
  it('six simultaneous uploads: exactly three are kept, the rest are refused and cleaned up', async () => {
    const s = await assigned(ctx);
    const incident = (await s.runner.agent.post(`${R(s.rescueId)}/incidents`).send({ category: 'OTHER', severity: 'LOW', description: 'Taking many photos of the same problem.' })).body.data.incident.id as string;
    const cookie = await cookieFor(s.runner.email);
    const send = (i: number) =>
      request(ctx.app).post(`${R(s.rescueId)}/incidents/${incident}/evidence`).set('Cookie', cookie).attach('file', PNG, { filename: `p${i}.png`, contentType: 'image/png' }).then((r) => r);
    const results = await Promise.all([0, 1, 2, 3, 4, 5].map(send));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((x) => x === 201)).toHaveLength(3);
    expect(statuses.filter((x) => x === 409)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'EVIDENCE_LIMIT')).toBe(true);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM incident_evidence`)).toBe(3);
    expect(storedFiles()).toHaveLength(3); // the three refused uploads removed their files
  });
});

describe('malformed images are rejected before anything is stored', () => {
  it('rejects truncated and tampered image files', async () => {
    const s = await assigned(ctx);
    const incident = (await s.runner.agent.post(`${R(s.rescueId)}/incidents`).send({ category: 'OTHER', severity: 'LOW', description: 'Checking the upload validation.' })).body.data.incident.id as string;
    const send = (data: Buffer, name: string) => s.runner.agent.post(`${R(s.rescueId)}/incidents/${incident}/evidence`).attach('file', data, { filename: name, contentType: 'image/png' });
    const truncated = PNG.subarray(0, PNG.length - 20); // cut inside the chunks
    expect((await send(truncated, 'cut.png')).status).toBe(400);
    expect((await send(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<script>alert(1)</script>')]), 'x.png')).status).toBe(400);
    expect((await send(Buffer.from('<html><script>alert(1)</script></html>'), 'page.png')).status).toBe(415);
    expect((await send(Buffer.alloc(0), 'empty.png')).status).toBeGreaterThanOrEqual(400);
    expect(storedFiles()).toHaveLength(0);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM incident_evidence`)).toBe(0);
  });

  it('strips EXIF and text metadata from stored evidence', async () => {
    const s = await assigned(ctx);
    const incident = (await s.runner.agent.post(`${R(s.rescueId)}/incidents`).send({ category: 'OTHER', severity: 'LOW', description: 'Photo that carries metadata.' })).body.data.incident.id as string;
    const withText = Buffer.concat([PNG.subarray(0, 8), chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('GPSLatitude\x0018.523456')), chunk('IDAT', Buffer.from([1, 2, 3, 4])), chunk('IEND', Buffer.alloc(0))]);
    const up = await s.runner.agent.post(`${R(s.rescueId)}/incidents/${incident}/evidence`).attach('file', withText, { filename: 'meta.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const download = await s.ngo.agent.get(`${R(s.rescueId)}/incidents/${incident}/evidence/${up.body.data.evidence.id}`).buffer(true).parse((res, cb) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect((download.body as Buffer).toString('latin1')).not.toContain('GPSLatitude');
  });
});

describe('file authorization and storage keys', () => {
  it('lets only the parties and admins read evidence; others get 404, signed-out callers 401', async () => {
    const s = await assigned(ctx);
    const incident = (await s.runner.agent.post(`${R(s.rescueId)}/incidents`).send({ category: 'OTHER', severity: 'LOW', description: 'Evidence access check.' })).body.data.incident.id as string;
    const up = await s.runner.agent.post(`${R(s.rescueId)}/incidents/${incident}/evidence`).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    const url = `${R(s.rescueId)}/incidents/${incident}/evidence/${up.body.data.evidence.id}`;
    const stranger = await verifiedAgent(ctx, 'provider');
    expect((await stranger.agent.get(url)).status).toBe(404);
    expect((await request(ctx.app).get(url)).status).toBe(401);
    expect((await s.provider.agent.get(url)).status).toBe(200);
  });

  it('never exposes a storage key or a file path in any rescue or incident response', async () => {
    const s = await assigned(ctx);
    const incident = (await s.runner.agent.post(`${R(s.rescueId)}/incidents`).send({ category: 'OTHER', severity: 'LOW', description: 'Looking for leaked internals.' })).body.data.incident.id as string;
    await s.runner.agent.post(`${R(s.rescueId)}/incidents/${incident}/evidence`).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    const admin = await signedInAgent(ctx, 'admin');
    const bodies = JSON.stringify([(await s.ngo.agent.get(R(s.rescueId))).body, (await admin.agent.get(`/api/v1/incidents/${incident}`)).body, (await admin.agent.get('/api/v1/incidents')).body]);
    expect(bodies).not.toMatch(/storage_?key|storageKey|sha256|incident-[0-9a-f-]{36}|\.png"/);
  });

  it('refuses keys that escape the storage root and unsafe namespaces or extensions', async () => {
    expect(() => storage.open('../outside.txt')).toThrow(/Invalid storage key/);
    // A backslash is a separator (so a traversal) on Windows and an ordinary character on POSIX; confined to the root either way.
    if (path.sep === '\\') expect(() => storage.open('..\\outside.txt')).toThrow(/Invalid storage key/);
    else expect(() => storage.open('..\\outside.txt')).not.toThrow();
    expect(() => storage.open(path.resolve('/etc/passwd'))).toThrow(/Invalid storage key/);
    await expect(storage.save('../evil', 'png', PNG)).rejects.toThrow(/Invalid storage namespace/);
    await expect(storage.save('ns', '../x', PNG)).rejects.toThrow(/Invalid storage namespace/);
    await expect(storage.remove('../outside.txt')).rejects.toThrow(/Invalid storage key/);
  });

  it('generates its own file names (the client name never reaches the disk)', async () => {
    const owner = await signedInAgent(ctx, 'provider');
    const cookie = await cookieFor(owner.email);
    const res = await request(ctx.app)
      .post(`/api/v1/organizations/${owner.organizationId}/documents`)
      .set('Cookie', cookie)
      .field('documentType', 'REGISTRATION_CERTIFICATE')
      .attach('file', pdfBytes(), { filename: 'my-private-name.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(storedFiles().join(' ')).not.toContain('my-private-name');
    expect(storedFiles()[0]).toMatch(/^[0-9a-f-]{36}\.pdf$/);
  });
});

describe('what is NOT claimed', () => {
  it('there is no malware scanning in the upload path (documented limitation, checked so docs stay honest)', async () => {
    const { readFileSync } = await import('node:fs');
    const sources = ['../src/modules/listings/images.ts', '../src/modules/organizations/documents.ts', '../src/modules/incidents/service.ts']
      .map((f) => readFileSync(path.resolve(import.meta.dirname, f), 'utf8'))
      .join('\n');
    expect(sources).not.toMatch(/clamav|clamd|virustotal|antivirus|malware/i);
  });
});
