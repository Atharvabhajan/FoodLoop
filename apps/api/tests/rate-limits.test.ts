import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { PASSWORD, pdfBytes, resetData, setup, signedInAgent, testConfig } from './helpers.js';
import { R, assigned, count, delivered } from './runner-helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const LIMITS = {
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_AUTH_MAX: '3',
  RATE_LIMIT_UPLOAD_MAX: '2',
  RATE_LIMIT_RESCUE_ACTION_MAX: '3',
  RATE_LIMIT_INCIDENT_MAX: '2',
  RATE_LIMIT_LOCATION_MAX: '2',
};

/** A fresh app (so fresh counters) on the same runtime connection, with limits switched on. */
const limitedApp = (overrides: Record<string, string> = {}) =>
  createApp({ config: testConfig({ ...LIMITS, ...overrides }), db: ctx.runtime.db, pool: ctx.runtime.pool });

async function cookieFor(email: string) {
  const res = await request(ctx.app).post('/api/v1/auth/login').send({ email, password: PASSWORD }); // unlimited app
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!).join('; ');
}

const SOME_ID = '00000000-0000-4000-8000-000000000000';

describe('the 429 contract', () => {
  it('is the same shape for every limiter, with Retry-After and rate-limit headers', async () => {
    const app = limitedApp();
    const user = await signedInAgent(ctx, 'provider');
    const cookie = await cookieFor(user.email);
    const hit = (path: string) => request(app).post(path).set('Cookie', cookie).send({});
    const probes: [string, string, string][] = [
      ['UPLOAD', `/api/v1/listings/${SOME_ID}/image`, 'uploads'],
      ['RESCUE_ACTION', `/api/v1/rescues/${SOME_ID}/confirm`, 'actions'],
      ['INCIDENT', `/api/v1/rescues/${SOME_ID}/incidents`, 'incident'],
      ['LOCATION', `/api/v1/rescues/${SOME_ID}/location`, 'location'],
    ];
    for (const [limiter, path] of probes) {
      let last = await hit(path);
      for (let i = 0; i < 4 && last.status !== 429; i++) last = await hit(path);
      expect(last.status, limiter).toBe(429);
      expect(last.body).toMatchObject({ success: false, code: 'RATE_LIMITED', details: { limiter } });
      expect(typeof last.body.message).toBe('string');
      expect(last.body.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(Number(last.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(last.body.meta.requestId).toMatch(/^req_/);
      expect(last.headers['ratelimit']).toBeTruthy();
    }
  });
});

describe('authentication', () => {
  it('limits repeated sign-in attempts per client', async () => {
    const app = limitedApp();
    const attempt = () => request(app).post('/api/v1/auth/login').send({ email: 'nobody@example.test', password: 'wrong-password-1' });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });

  it('keeps each proxied client in its own bucket only when a proxy hop is trusted', async () => {
    const trusted = limitedApp({ RATE_LIMIT_AUTH_MAX: '2', TRUST_PROXY_HOPS: '1' });
    const login = (app: typeof trusted, ip: string) => request(app).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ email: 'nobody@example.test', password: 'wrong-password-1' });
    expect((await login(trusted, '10.1.1.1')).status).toBe(401);
    expect((await login(trusted, '10.1.1.1')).status).toBe(401);
    expect((await login(trusted, '10.1.1.1')).status).toBe(429);
    expect((await login(trusted, '10.2.2.2')).status).toBe(401); // a different client is unaffected

    // With no trusted proxy, a spoofed X-Forwarded-For must not buy a fresh bucket.
    const untrusted = limitedApp({ RATE_LIMIT_AUTH_MAX: '2' });
    expect((await login(untrusted, '10.3.3.1')).status).toBe(401);
    expect((await login(untrusted, '10.3.3.2')).status).toBe(401);
    expect((await login(untrusted, '10.3.3.3')).status).toBe(429);
  });
});

describe('per-user limits on actions', () => {
  it('counts rescue actions per signed-in user, not per address', async () => {
    const app = limitedApp();
    const a = await signedInAgent(ctx, 'provider');
    const b = await signedInAgent(ctx, 'provider');
    const [ca, cb] = [await cookieFor(a.email), await cookieFor(b.email)];
    const act = (cookie: string) => request(app).post(`/api/v1/rescues/${SOME_ID}/confirm`).set('Cookie', cookie).send({});
    for (let i = 0; i < 3; i++) expect((await act(ca)).status).not.toBe(429);
    expect((await act(ca)).status).toBe(429);
    expect((await act(cb)).status).not.toBe(429); // same IP, different user
  });

  it('keeps incident reports, location updates and other rescue actions in separate buckets', async () => {
    const app = limitedApp({ RATE_LIMIT_RESCUE_ACTION_MAX: '2' });
    const u = await signedInAgent(ctx, 'runner');
    const cookie = await cookieFor(u.email);
    const post = (path: string) => request(app).post(path).set('Cookie', cookie).send({});
    for (let i = 0; i < 3; i++) await post(`/api/v1/rescues/${SOME_ID}/incidents`);
    for (let i = 0; i < 3; i++) await post(`/api/v1/rescues/${SOME_ID}/location`);
    // Both of those are now limited, yet ordinary rescue actions still have their whole budget.
    expect((await post(`/api/v1/rescues/${SOME_ID}/incidents`)).status).toBe(429);
    expect((await post(`/api/v1/rescues/${SOME_ID}/location`)).status).toBe(429);
    expect((await post(`/api/v1/rescues/${SOME_ID}/runner/release`)).status).not.toBe(429);
    expect((await post(`/api/v1/rescues/${SOME_ID}/runner/release`)).status).not.toBe(429);
    expect((await post(`/api/v1/rescues/${SOME_ID}/runner/release`)).status).toBe(429);
  });

  it('does not count reads', async () => {
    const app = limitedApp({ RATE_LIMIT_RESCUE_ACTION_MAX: '1' });
    const u = await signedInAgent(ctx, 'provider');
    const cookie = await cookieFor(u.email);
    for (let i = 0; i < 8; i++) expect((await request(app).get('/api/v1/rescues').set('Cookie', cookie)).status).toBe(200);
  });

  it('a forged or expired token cannot choose its own bucket', async () => {
    const app = limitedApp();
    let status = 0;
    for (let i = 0; i < 6 && status !== 429; i++) {
      status = (await request(app).post(`/api/v1/rescues/${SOME_ID}/location`).set('Cookie', `fl_access=forged-${i}.token.${i}`).send({})).status;
    }
    expect(status).toBe(429);
  });
});

describe('uploads', () => {
  it('refuses further uploads before reading them, and stores nothing for the refused ones', async () => {
    const app = limitedApp();
    const owner = await signedInAgent(ctx, 'provider');
    const cookie = await cookieFor(owner.email);
    const upload = (name: string) =>
      request(app)
        .post(`/api/v1/organizations/${owner.organizationId}/documents`)
        .set('Cookie', cookie)
        .field('documentType', 'REGISTRATION_CERTIFICATE')
        .attach('file', pdfBytes(), { filename: name, contentType: 'application/pdf' });
    expect((await upload('one.pdf')).status).toBe(201);
    expect((await upload('two.pdf')).status).toBe(201);
    const third = await upload('three.pdf');
    expect(third.status).toBe(429);
    expect(third.body.details.limiter).toBe('UPLOAD');
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM verification_documents`)).toBe(2);
  });
});

describe('configuration', () => {
  it('is configurable per limiter and validated', () => {
    expect(testConfig({ RATE_LIMIT_UPLOAD_MAX: '7', RATE_LIMIT_UPLOAD_WINDOW_SECONDS: '30' }).rateLimits.UPLOAD).toEqual({ max: 7, windowSeconds: 30 });
    expect(testConfig().rateLimits.AUTH).toEqual({ max: 60, windowSeconds: 900 });
    expect(() => testConfig({ RATE_LIMIT_UPLOAD_MAX: '0' })).toThrow(/rate limit/i);
    expect(() => testConfig({ RATE_LIMIT_LOCATION_WINDOW_SECONDS: 'soon' })).toThrow(/rate limit/i);
  });

  it('is off in the default test configuration so the suite is not flaky', async () => {
    const u = await signedInAgent(ctx, 'provider');
    const cookie = await cookieFor(u.email);
    for (let i = 0; i < 12; i++) expect((await request(ctx.app).post(`/api/v1/rescues/${SOME_ID}/confirm`).set('Cookie', cookie).send({})).status).not.toBe(429);
  });
});

describe('ordinary workflows are not throttled at the default limits', () => {
  it('runs a complete runner-assisted rescue with limiting switched on', async () => {
    const enabled = createApp({ config: testConfig({ RATE_LIMIT_ENABLED: 'true' }), db: ctx.runtime.db, pool: ctx.runtime.pool });
    const lctx = { ...ctx, app: enabled };
    const s = await delivered(lctx);
    const done = await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 38 });
    expect(done.status).toBe(200);
    expect(done.body.data.rescue.status).toBe('COMPLETED');
  });

  it('lets a runner share a position at the browser cadence, report an incident and release', async () => {
    const enabled = createApp({ config: testConfig({ RATE_LIMIT_ENABLED: 'true', RUNNER_LOCATION_MIN_INTERVAL_SECONDS: '1' }), db: ctx.runtime.db, pool: ctx.runtime.pool });
    const lctx = { ...ctx, app: enabled };
    const s = await assigned(lctx);
    expect((await s.runner.agent.post(`${R(s.rescueId)}/location`).send({ latitude: 18.52, longitude: 73.85 })).status).toBe(200);
    const incident = await s.runner.agent.post(`${R(s.rescueId)}/incidents`).send({ category: 'PICKUP_PROBLEM', severity: 'LOW', description: 'The gate is locked for a while.' });
    expect(incident.status).toBe(201);
    expect((await s.runner.agent.post(`${R(s.rescueId)}/runner/release`).send({ reason: 'Cannot wait any longer' })).status).toBe(200);
  });
});
