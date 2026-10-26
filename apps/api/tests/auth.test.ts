import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, resetData, setup } from './helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const providerBody = {
  name: 'Priya Provider',
  email: 'priya@example.test',
  password: PASSWORD,
  role: 'provider',
  organizationName: 'Priya Canteen',
};

describe('registration', () => {
  it('registers a provider with an organization and owner membership, setting httpOnly cookies', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/register').send(providerBody);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.meta.requestId).toMatch(/^req_/);
    expect(res.body.data.user).toMatchObject({ email: 'priya@example.test', platformRole: 'provider' });
    expect(res.body.data.user.memberships).toHaveLength(1);
    expect(res.body.data.user.memberships[0]).toMatchObject({
      organizationName: 'Priya Canteen',
      memberRole: 'owner',
      verificationStatus: 'UNSUBMITTED',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies).toHaveLength(2);
    for (const c of cookies) expect(c).toMatch(/HttpOnly/i);
    expect(cookies.find((c) => c.startsWith('fl_refresh='))).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('creates a volunteer profile for runners', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/register')
      .send({ name: 'Ravi Runner', email: 'ravi@example.test', password: PASSWORD, role: 'runner' });
    expect(res.status).toBe(201);
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM volunteer_profiles`);
    expect(rows.rows[0]).toMatchObject({ n: 1 });
  });

  it('rejects duplicate emails case-insensitively', async () => {
    await request(ctx.app).post('/api/v1/auth/register').send(providerBody).expect(201);
    const res = await request(ctx.app)
      .post('/api/v1/auth/register')
      .send({ ...providerBody, email: 'PRIYA@example.test' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'EMAIL_TAKEN' });
  });

  it('validates the body with field-level, non-sensitive errors', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/register')
      .send({ name: 'X', email: 'not-an-email', password: 'short', role: 'provider' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.details.fields)).toEqual(
      expect.arrayContaining(['name', 'email', 'password', 'organizationName']),
    );
    expect(JSON.stringify(res.body)).not.toContain('short');
  });

  it('does not allow self-registration as admin or with unknown fields', async () => {
    const asAdmin = await request(ctx.app)
      .post('/api/v1/auth/register')
      .send({ ...providerBody, role: 'admin' });
    expect(asAdmin.status).toBe(400);
    const extra = await request(ctx.app)
      .post('/api/v1/auth/register')
      .send({ ...providerBody, platformRole: 'admin' });
    expect(extra.status).toBe(400);
  });

  it('returns a consistent error for malformed JSON', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"oops"');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_JSON' });
  });
});

describe('password storage', () => {
  it('stores a bcrypt hash, never the plaintext', async () => {
    await request(ctx.app).post('/api/v1/auth/register').send(providerBody).expect(201);
    const { rows } = await ctx.db.execute(sql`SELECT password_hash FROM users WHERE email = 'priya@example.test'`);
    const hash = (rows[0] as { password_hash: string }).password_hash;
    expect(hash).not.toContain(PASSWORD);
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
  });
});

describe('login', () => {
  it('signs in with valid credentials (email is case-insensitive)', async () => {
    await request(ctx.app).post('/api/v1/auth/register').send(providerBody).expect(201);
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: 'Priya@Example.test', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user.platformRole).toBe('provider');
    expect(res.body.data.user.permissions).toContain('provider:access');
  });

  it('rejects a wrong password and an unknown email with the same response', async () => {
    await request(ctx.app).post('/api/v1/auth/register').send(providerBody).expect(201);
    const wrong = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@example.test', password: 'Wrong-Password-1' });
    const unknown = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'Wrong-Password-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.message).toBe(unknown.body.message);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('blocks suspended accounts', async () => {
    await request(ctx.app).post('/api/v1/auth/register').send(providerBody).expect(201);
    await ctx.db.execute(sql`UPDATE users SET status = 'SUSPENDED'`);
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@example.test', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('sessions', () => {
  it('rejects unauthenticated access to /auth/me', async () => {
    const res = await request(ctx.app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, code: 'UNAUTHENTICATED' });
  });

  it('returns the current user for a signed-in session', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/api/v1/auth/register').send(providerBody).expect(201);
    const res = await agent.get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('priya@example.test');
  });

  it('revokes the session on logout so the old cookies stop working', async () => {
    const agent = request.agent(ctx.app);
    const reg = await agent.post('/api/v1/auth/register').send(providerBody).expect(201);
    const stolen = (reg.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!).join('; ');

    await agent.post('/api/v1/auth/logout').expect(200);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);

    // Replaying the pre-logout cookies must fail even though the JWT has not expired.
    const replay = await request(ctx.app).get('/api/v1/auth/me').set('Cookie', stolen);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('SESSION_REVOKED');
    const refreshReplay = await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', stolen);
    expect(refreshReplay.status).toBe(401);
  });

  it('rotates the refresh token and rejects the old one', async () => {
    const agent = request.agent(ctx.app);
    const reg = await agent.post('/api/v1/auth/register').send(providerBody).expect(201);
    const oldCookies = (reg.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!).join('; ');

    await agent.post('/api/v1/auth/refresh').expect(200);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);

    const replay = await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', oldCookies);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('SESSION_EXPIRED');
  });
});

describe('request hardening', () => {
  it('rejects state-changing requests from a non-allow-listed Origin', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'priya@example.test', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('answers CORS only for allow-listed origins, never with a wildcard', async () => {
    const allowed = await request(ctx.app).get('/api/v1/health').set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const denied = await request(ctx.app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns the standard error envelope for unknown routes', async () => {
    const res = await request(ctx.app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });
});
