import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetData, setup, signedInAgent } from './helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const ME = '/api/v1/auth/me';

describe('PATCH /auth/me (account profile)', () => {
  it('updates the name and phone of the signed-in user and returns the identity', async () => {
    const { agent } = await signedInAgent(ctx, 'provider');
    const res = await agent.patch(ME).send({ name: 'Priya Sharma', phone: '+91 98765 43210' });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ name: 'Priya Sharma', phone: '+91 98765 43210', platformRole: 'provider' });
    expect((await agent.get(ME)).body.data.user).toMatchObject({ name: 'Priya Sharma', phone: '+91 98765 43210' });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });

  it('clears the phone with an empty string, and leaves other fields alone on a partial update', async () => {
    const { agent } = await signedInAgent(ctx, 'runner');
    await agent.patch(ME).send({ phone: '+91 98765 43210' }).expect(200);
    const res = await agent.patch(ME).send({ phone: '' });
    expect(res.body.data.user.phone).toBeNull();
    expect(res.body.data.user.name).toBe('Test runner');
  });

  it('rejects invalid values with field errors', async () => {
    const { agent } = await signedInAgent(ctx, 'ngo');
    const bad = await agent.patch(ME).send({ name: 'x', phone: 'abc' });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.details.fields)).toEqual(expect.arrayContaining(['name', 'phone']));
    expect((await agent.patch(ME).send({})).status).toBe(400);
  });

  it('cannot change email, role, status or password (identity and permission data are not self-service)', async () => {
    const { agent, email } = await signedInAgent(ctx, 'provider');
    for (const body of [{ email: 'other@example.test' }, { platformRole: 'admin' }, { role: 'admin' }, { status: 'ACTIVE' }, { password: 'New-Password-123', name: 'Okay Name' }]) {
      expect((await agent.patch(ME).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    const me = (await agent.get(ME)).body.data.user;
    expect(me.email).toBe(email);
    expect(me.platformRole).toBe('provider');
  });

  it('requires a session', async () => {
    expect((await request(ctx.app).patch(ME).send({ name: 'Nobody Here' })).status).toBe(401);
  });

  it('works for an admin and only ever touches the caller own row', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const other = await signedInAgent(ctx, 'runner');
    await admin.agent.patch(ME).send({ name: 'Ops Admin' }).expect(200);
    expect((await other.agent.get(ME)).body.data.user.name).toBe('Test runner');
  });
});
