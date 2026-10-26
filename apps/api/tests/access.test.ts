import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetData, setup, signedInAgent, type Role } from './helpers.js';

const ctx = setup();
const roles: Role[] = ['provider', 'ngo', 'runner', 'admin'];
const agents = {} as Record<Role, Awaited<ReturnType<typeof signedInAgent>>['agent']>;

beforeAll(async () => {
  await resetData(ctx.db);
  for (const role of roles) agents[role] = (await signedInAgent(ctx, role)).agent;
});
afterAll(() => ctx.pool.end());

describe('role test routes', () => {
  it.each(roles)('rejects unauthenticated requests to /access/%s', async (role) => {
    const res = await request(ctx.app).get(`/api/v1/access/${role}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it.each(roles)('lets the %s role reach its own route', async (role) => {
    const res = await agents[role].get(`/api/v1/access/${role}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ area: role, role });
  });

  const denied = roles.flatMap((actor) => roles.filter((r) => r !== actor).map((target) => [actor, target] as const));
  it.each(denied)('denies %s access to the %s route', async (actor, target) => {
    const res = await agents[actor].get(`/api/v1/access/${target}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'FORBIDDEN' });
  });
});

describe('admin-only route', () => {
  it('allows admin', async () => {
    const res = await agents.admin.get('/api/v1/access/admin-only');
    expect(res.status).toBe(200);
  });

  it.each(['provider', 'ngo', 'runner'] as Role[])('denies %s', async (role) => {
    const res = await agents[role].get('/api/v1/access/admin-only');
    expect(res.status).toBe(403);
  });

  it('rejects anonymous callers', async () => {
    expect((await request(ctx.app).get('/api/v1/access/admin-only')).status).toBe(401);
  });
});
