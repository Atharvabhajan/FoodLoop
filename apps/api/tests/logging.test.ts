import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { errorHandler } from '../src/http/errors.js';
import { createLogger, describeError, scrubText, scrubValue } from '../src/log.js';
import { startExpiryWorker } from '../src/modules/listings/expiry.js';
import { PASSWORD, resetData, setup, signedInAgent, testConfig } from './helpers.js';
import { assigned, awaitingRunner } from './runner-helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());
afterEach(() => vi.restoreAllMocks());

describe('scrubbing free text', () => {
  const cases: [string, string, RegExp][] = [
    ['connection strings', 'connect ECONNREFUSED using postgres://foodloop_runtime:Sup3rSecret@db.internal:5432/foodloop', /Sup3rSecret|foodloop_runtime|db\.internal/],
    ['other URLs with credentials', 'redis://user:hunter2@cache:6379', /hunter2|user:/],
    ['passwords in messages', 'login failed password=hunter2, retrying', /hunter2/],
    ['JWTs', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123_-xyz was rejected', /eyJhbGci/],
    ['bearer tokens', 'Authorization: Bearer abc.def-ghi_jkl', /abc\.def-ghi/],
    ['session cookies', 'cookie fl_access=abc123XYZ; fl_refresh=def456', /abc123XYZ|def456/],
    ['email addresses', 'could not notify priya.rao@example.test today', /priya\.rao/],
    ['precise coordinates', 'point (73.857891, 18.523456) was outside', /73\.857891|18\.523456/],
    ['rejected input values', 'invalid input syntax for type uuid: "6f1c9d52-private-value"', /private-value/],
    ['unique-violation details', 'Key (email)=(priya@example.test) already exists', /priya/],
  ];
  for (const [what, input, leak] of cases) {
    it(`removes ${what}`, () => {
      const out = scrubText(input);
      expect(out).not.toMatch(leak);
      expect(out.length).toBeGreaterThan(0);
    });
  }

  it('drops the statement and parameters the ORM appends to a failed query', () => {
    const out = scrubText('Failed query: INSERT INTO rescue_locations (latitude) VALUES ($1)\nparams: 18.523456,73.857891,pickup-code-483920');
    expect(out).toBe('Failed query (statement and parameters withheld)');
  });

  it('keeps ordinary diagnostic text readable', () => {
    expect(scrubText('Match refresh failed (listing changed)')).toBe('Match refresh failed (listing changed)');
    expect(scrubText('duplicate key value violates unique constraint "organizations_pkey"')).toContain('unique constraint');
    expect(scrubText('rate 3 of 10, port 4000, status 500')).toBe('rate 3 of 10, port 4000, status 500');
  });
});

describe('scrubbing structured fields', () => {
  it('replaces sensitive fields wholesale at any depth and keeps safe ones', () => {
    const out = scrubValue({
      requestId: 'req_1',
      count: 3,
      latitude: 18.523456,
      longitude: 73.857891,
      pickupCode: '483920',
      pickupCodeHash: 'abc',
      contactPhone: '+91 98765 43210',
      contactEmail: 'a@b.test',
      description: 'free text about the incident',
      password: 'pw',
      storageKey: 'incident-1/x.png',
      sha256: 'ff',
      params: [1, 2],
      nested: { authorization: 'Bearer x', ok: 'fine', deeper: { cookie: 'fl_access=abc' } },
      list: [{ addressLine: '12 Market Road', status: 'ok' }],
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    for (const secret of ['18.523456', '73.857891', '483920', '98765', 'a@b.test', 'free text', 'incident-1', 'Market Road', 'fl_access=abc']) expect(text).not.toContain(secret);
    expect(out).toMatchObject({ requestId: 'req_1', count: 3, nested: { ok: 'fine' }, list: [{ status: 'ok' }] });
  });

  it('bounds depth and array length', () => {
    let deep: Record<string, unknown> = { v: 'end' };
    for (let i = 0; i < 10; i++) deep = { child: deep };
    expect(JSON.stringify(scrubValue(deep))).toContain('[truncated]');
    expect((scrubValue(Array.from({ length: 100 }, (_, i) => i)) as number[]).length).toBe(20);
  });

  it('the logger applies both layers and always emits one JSON line', () => {
    const lines: string[] = [];
    const log = createLogger((_level, line) => lines.push(line));
    log.error('Could not reach postgres://u:pw@h/db', { requestId: 'req_9', latitude: 18.5234567, detail: 'near 18.5234567, 73.8578912' });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ level: 'error', requestId: 'req_9', latitude: '[redacted]' });
    expect(lines[0]).not.toMatch(/pw@|18\.5234567|73\.8578912/);
  });
});

describe('describing errors from the real database driver', () => {
  it('reports the driver code but not the statement or the values it was given', async () => {
    let caught: unknown;
    try {
      await ctx.runtime.db.execute(sql`SELECT ${'priya.rao@example.test 18.523456'}::int`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    // The raw error really does carry the values (that is why it must not be logged as is).
    expect(String((caught as Error).message) + JSON.stringify((caught as { cause?: unknown }).cause ?? '')).toMatch(/priya\.rao|18\.523456/);
    const d = describeError(caught);
    expect(d.code).toBe('22P02');
    expect(JSON.stringify(d)).not.toMatch(/priya|18\.523456|SELECT/);
  });

  it('never throws and stays small for odd values', () => {
    expect(describeError('plain string with a@b.test').message).not.toContain('a@b.test');
    expect(describeError(undefined).name).toBe('UnknownError');
    expect(describeError(new Error('x'.repeat(5000))).message.length).toBeLessThanOrEqual(300);
  });
});

describe('what the API logs and returns when something unexpected fails', () => {
  it('logs a scrubbed line and returns a generic 500 body', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = express();
    app.get('/boom', () => {
      throw new Error('connect failed postgres://svc:TopSecretPw@10.0.0.5/foodloop for priya@example.test at 18.523456,73.857891; pickup code 483920 password=TopSecretPw');
    });
    app.use(errorHandler(true));
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' });
    expect(JSON.stringify(res.body)).not.toMatch(/TopSecretPw|priya|18\.5234|postgres/);
    const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('Unhandled request error');
    expect(logged).not.toMatch(/TopSecretPw|10\.0\.0\.5|priya|18\.523456|73\.857891/);
  });

  it('a real failure inside the app (unusable database) is generic to the client and scrubbed in the log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = createDb(ctx.config.DATABASE_URL);
    await broken.pool.end();
    const app = createApp({ config: testConfig(), db: broken.db, pool: broken.pool });
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'someone@example.test', password: PASSWORD });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/pool|postgres|someone@example/i);
    const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toMatch(/someone@example|postgres:\/\//);
    expect(logged).not.toContain(new URL(ctx.config.DATABASE_URL).password);
  });

  it('background sweeps log a scrubbed failure', async () => {
    const lines: string[] = [];
    const failing = { transaction: async () => { throw new Error('Failed query: UPDATE x\nparams: priya@example.test,18.523456'); } };
    const stop = startExpiryWorker(failing as never, 3600, (m) => lines.push(m));
    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
    stop();
    expect(lines.join('\n')).toContain('Expiry run failed');
    expect(lines.join('\n')).not.toMatch(/priya|18\.523456|UPDATE x/);
  });
});

describe('ordinary rescue traffic does not log secrets', () => {
  it('a full flow (codes, contacts, locations, incident text) writes nothing sensitive to the console', async () => {
    const out: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
    const s = await assigned(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    await s.runner.agent.post(`/api/v1/rescues/${s.rescueId}/location`).send({ latitude: 18.523456, longitude: 73.857891 });
    const inc = await s.runner.agent.post(`/api/v1/rescues/${s.rescueId}/incidents`).send({ category: 'OTHER', severity: 'LOW', description: 'Distinctive incident wording for the log check.' });
    await admin.agent.get(`/api/v1/incidents/${inc.body.data.incident.id}`);
    const logged = out.join('\n');
    expect(logged).not.toContain(s.code);
    expect(logged).not.toMatch(/Distinctive incident wording|18\.523456|73\.857891|@example\.test|\+91 98765/);
  });

  it('the pickup code never appears outside the single provider response that issues it', async () => {
    const s = await awaitingRunner(ctx);
    const body = JSON.stringify([(await s.ngo.agent.get(`/api/v1/rescues/${s.rescueId}`)).body, (await s.provider.agent.get(`/api/v1/rescues/${s.rescueId}`)).body, (await s.ngo.agent.get('/api/v1/notifications')).body]);
    expect(body).not.toContain(s.code);
  });
});
