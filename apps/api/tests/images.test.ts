import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sniffImage, stripImageMetadata } from '../src/modules/listings/images.js';
import { availableListing, createListing, pdfBytes, resetData, setup, signedInAgent, verifiedAgent } from './helpers.js';

const ctx = setup();
beforeEach(async () => {
  await resetData(ctx.db);
  rmSync(ctx.config.STORAGE_DIR, { recursive: true, force: true });
  mkdirSync(ctx.config.STORAGE_DIR, { recursive: true });
});
afterAll(() => ctx.pool.end());

const SECRET = 'GPS-SECRET-1234';

/** SOI, JFIF APP0, an EXIF APP1 carrying SECRET, then SOS + data + EOI. */
function jpegWithExif(): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);
  const exifBody = Buffer.from(`Exif\0\0${SECRET}`);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, exifBody.length + 2]), exifBody]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0x56]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, sos, Buffer.from([0xff, 0xd9])]);
}

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};
function pngWithText(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('tEXt', Buffer.from(`Comment\0${SECRET}`)),
    chunk('IDAT', Buffer.from([1, 2, 3, 4])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const files = (dir = ctx.config.STORAGE_DIR): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));

type Agent = Awaited<ReturnType<typeof signedInAgent>>['agent'];
const put = (agent: Agent, id: string, data: Buffer, filename: string, contentType = 'image/jpeg') =>
  agent.post(`/api/v1/listings/${id}/image`).attach('file', data, { filename, contentType });

describe('metadata stripping (pure)', () => {
  it('removes EXIF/APP1 from JPEG and text chunks from PNG, keeping image data', () => {
    const jpg = stripImageMetadata(jpegWithExif(), 'jpeg')!;
    expect(jpg.includes(Buffer.from(SECRET))).toBe(false);
    expect(jpg.includes(Buffer.from('JFIF'))).toBe(true);
    expect(jpg.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    expect(jpg.includes(Buffer.from([0x12, 0x34, 0x56]))).toBe(true);
    const png = stripImageMetadata(pngWithText(), 'png')!;
    expect(png.includes(Buffer.from(SECRET))).toBe(false);
    expect(png.includes(Buffer.from('IDAT'))).toBe(true);
    expect(sniffImage(png)).toBe('png');
  });

  it('rejects structurally broken images', () => {
    expect(stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1]), 'jpeg')).toBeNull();
    expect(stripImageMetadata(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0xff, 0xff]), 'png')).toBeNull();
  });
});

describe('image upload validation', () => {
  it('accepts JPEG and PNG, stores a stripped copy under a server-generated name', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await createListing(agent);
    const res = await put(agent, l.id, jpegWithExif(), 'My Photo.JPG');
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ hasImage: true });
    expect((await agent.get(`/api/v1/listings/${l.id}`)).body.data.listing.hasImage).toBe(true);

    const [stored] = files();
    expect(path.basename(stored!)).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(path.relative(ctx.config.STORAGE_DIR, stored!)).toMatch(/^listing-[0-9a-f-]{36}[\\/]/);
    expect(readFileSync(stored!).includes(Buffer.from(SECRET))).toBe(false);

    // Replacing the image removes the old file.
    await put(agent, l.id, pngWithText(), 'new.png', 'image/png').then((r) => expect(r.status).toBe(201));
    expect(files()).toHaveLength(1);
    expect(files()[0]).toMatch(/\.png$/);
  });

  it('rejects unsupported types, disguised files and mismatched extensions', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await createListing(agent);
    const cases: [string, Buffer, string][] = [
      ['notes.txt', Buffer.from('hello'), 'text/plain'],
      ['photo.jpg', pdfBytes(), 'image/jpeg'],
      ['doc.pdf', pdfBytes(), 'application/pdf'],
      ['evil.svg', Buffer.from('<svg onload=alert(1)/>'), 'image/svg+xml'],
      ['photo.png', jpegWithExif(), 'image/png'],
      ['noext', jpegWithExif(), 'image/jpeg'],
    ];
    for (const [name, data, type] of cases) {
      const res = await put(agent, l.id, data, name, type);
      expect(res.status, name).toBe(415);
    }
    expect((await put(agent, l.id, Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1]), 'broken.jpg')).status).toBe(400);
    expect(files()).toHaveLength(0);
  });

  it('rejects images over 3 MB with 413', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await createListing(agent);
    const big = Buffer.concat([jpegWithExif().subarray(0, -2), Buffer.alloc(3 * 1024 * 1024 + 1024), Buffer.from([0xff, 0xd9])]);
    const res = await put(agent, l.id, big, 'big.jpg');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
    expect(files()).toHaveLength(0);
  });

  it('rejects path-like filenames and a missing file', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await createListing(agent);
    const boundary = '----fl';
    const raw = (filename: string) =>
      agent
        .post(`/api/v1/listings/${l.id}/image`)
        .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
        .send(
          Buffer.concat([
            Buffer.from([`--${boundary}`, `Content-Disposition: form-data; name="file"; filename="${filename}"`, 'Content-Type: image/jpeg', '', ''].join('\r\n'), 'latin1'),
            jpegWithExif(),
            Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
          ]).toString('latin1'),
        );
    for (const name of ['../../x.jpg', '..\\..\\x.jpg', '/etc/passwd.jpg', 'a/b.jpg', 'x..jpg']) {
      const res = await raw(name);
      expect(res.status, name).toBe(400);
    }
    expect(files()).toHaveLength(0);
    const none = await agent.post(`/api/v1/listings/${l.id}/image`).field('x', 'y');
    expect(none.status).toBe(400);
  });

  it('is only allowed while the listing is editable', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(agent);
    await agent.post(`/api/v1/listings/${l.id}/cancel`).send({ reason: 'Not needed' });
    expect((await put(agent, l.id, jpegWithExif(), 'late.jpg')).status).toBe(409);
    expect((await agent.delete(`/api/v1/listings/${l.id}/image`)).status).toBe(409);
  });

  it('removes the stored file when the image is deleted', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await createListing(agent);
    await put(agent, l.id, jpegWithExif(), 'a.jpg').then((r) => expect(r.status).toBe(201));
    expect(files()).toHaveLength(1);
    expect((await agent.delete(`/api/v1/listings/${l.id}/image`)).status).toBe(200);
    expect(files()).toHaveLength(0);
    expect((await agent.get(`/api/v1/listings/${l.id}/image`)).status).toBe(404);
    expect(((await ctx.db.execute(sql`SELECT image_key FROM food_listings`)).rows[0] as { image_key: string | null }).image_key).toBeNull();
  });
});

describe('image access control', () => {
  it('serves the image only to the owner, admins, and verified NGOs while the listing is live', async () => {
    const owner = await verifiedAgent(ctx, 'provider');
    const l = await createListing(owner.agent);
    await put(owner.agent, l.id, jpegWithExif(), 'a.jpg').expect(201);
    const url = `/api/v1/listings/${l.id}/image`;

    const own = await owner.agent.get(url);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('image/jpeg');
    expect(own.headers['cache-control']).toMatch(/no-store/);
    expect(own.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(own.body).includes(Buffer.from(SECRET))).toBe(false);

    const ngo = await verifiedAgent(ctx, 'ngo');
    expect((await ngo.agent.get(url)).status).toBe(404); // still a draft
    await owner.agent.post(`/api/v1/listings/${l.id}/publish`).send({ declarationAccepted: true }).expect(200);
    expect((await ngo.agent.get(url)).status).toBe(200);
    expect((await ngo.agent.get('/api/v1/listings/feed')).body.data.listings[0].hasImage).toBe(true);

    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.get(url)).status).toBe(200);

    const unverifiedNgo = await signedInAgent(ctx, 'ngo');
    expect((await unverifiedNgo.agent.get(url)).status).toBe(403);
    const otherProvider = await verifiedAgent(ctx, 'provider');
    expect((await otherProvider.agent.get(url)).status).toBe(404);
    expect((await otherProvider.agent.delete(url)).status).toBe(404);
    expect((await put(otherProvider.agent, l.id, jpegWithExif(), 'x.jpg')).status).toBe(404);
    const runner = await signedInAgent(ctx, 'runner');
    expect((await runner.agent.get(url)).status).toBe(404);
    expect((await request(ctx.app).get(url)).status).toBe(401);

    // Once the listing is cancelled, NGOs lose access; the owner keeps it.
    await owner.agent.post(`/api/v1/listings/${l.id}/cancel`).send({ reason: 'Not needed' }).expect(200);
    expect((await ngo.agent.get(url)).status).toBe(404);
    expect((await owner.agent.get(url)).status).toBe(200);
  });

  it('is not reachable as a static file', async () => {
    const owner = await verifiedAgent(ctx, 'provider');
    const l = await createListing(owner.agent);
    await put(owner.agent, l.id, jpegWithExif(), 'a.jpg').expect(201);
    const key = path.relative(ctx.config.STORAGE_DIR, files()[0]!).replaceAll('\\', '/');
    for (const url of [`/${key}`, `/uploads/${key}`, `/api/v1/uploads/${key}`]) {
      expect((await request(ctx.app).get(url)).status, url).toBe(404);
    }
  });
});
