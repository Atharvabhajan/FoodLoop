import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { availableListing, matchedNgo, resetData, setup, signedInAgent, verifiedAgent } from './helpers.js';
import { R, accept, assigned, awaitingRunner, count, delivered, inTransit, runnerAt } from './runner-helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const L = (id: string) => `${R(id)}/location`;
const stored = async (id: string) => (await ctx.db.execute(sql`SELECT * FROM rescue_locations WHERE rescue_id = ${id}::uuid`)).rows as { latitude: number; longitude: number; recorded_at: Date; runner_user_id: string }[];
const total = () => count(ctx, sql`SELECT count(*)::int AS n FROM rescue_locations`);
/** Pretend the last accepted update was `seconds` ago (to get past the rate limit or make it stale). */
const age = (id: string, seconds: number) => ctx.db.execute(sql`UPDATE rescue_locations SET recorded_at = now() - make_interval(secs => ${seconds}) WHERE rescue_id = ${id}::uuid`);

describe('sharing a position (runner)', () => {
  it('stores only the latest point, rounded to about 100 m, and overwrites rather than keeping a trail', async () => {
    const s = await assigned(ctx);
    const first = await s.runner.agent.post(L(s.rescueId)).send({ latitude: 18.523456, longitude: 73.857891 });
    expect(first.status).toBe(200);
    expect(first.body.data.precision).toMatch(/100 m/);
    let rowsNow = await stored(s.rescueId);
    expect(rowsNow).toHaveLength(1);
    expect(rowsNow[0]).toMatchObject({ latitude: 18.523, longitude: 73.858, runner_user_id: s.runner.userId }); // the precise input is not stored
    for (const [lat, lng] of [[18.524111, 73.859222], [18.525333, 73.86044]]) {
      await age(s.rescueId, 30);
      await s.runner.agent.post(L(s.rescueId)).send({ latitude: lat, longitude: lng }).expect(200);
    }
    rowsNow = await stored(s.rescueId);
    expect(rowsNow).toHaveLength(1); // no history of positions
    expect(rowsNow[0]).toMatchObject({ latitude: 18.525, longitude: 73.86 });
    expect(await total()).toBe(1);
  });

  it('rate-limits updates per rescue', async () => {
    const s = await assigned(ctx);
    await s.runner.agent.post(L(s.rescueId)).send({ latitude: 18.5, longitude: 73.8 }).expect(200);
    const fast = await s.runner.agent.post(L(s.rescueId)).send({ latitude: 18.5, longitude: 73.8 });
    expect(fast.status).toBe(429);
    expect(fast.body.code).toBe('RATE_LIMITED');
    await age(s.rescueId, 10);
    await s.runner.agent.post(L(s.rescueId)).send({ latitude: 18.5, longitude: 73.8 }).expect(200);
  });

  it('validates the body', async () => {
    const s = await assigned(ctx);
    for (const body of [{}, { latitude: 18.5 }, { latitude: 91, longitude: 73 }, { latitude: 18, longitude: 181 }, { latitude: '18', longitude: 73 }, { latitude: 18, longitude: 73, accuracy: 5 }]) {
      expect((await s.runner.agent.post(L(s.rescueId)).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await total()).toBe(0);
  });

  it('is only available to the assigned runner while collecting or delivering', async () => {
    const s = await awaitingRunner(ctx);
    const outsider = await runnerAt(ctx);
    expect((await outsider.agent.post(L(s.rescueId)).send({ latitude: 18.5, longitude: 73.8 })).status).toBe(404); // not a party
    for (const role of ['provider', 'ngo', 'admin'] as const) {
      expect((await (await signedInAgent(ctx, role)).agent.post(L(s.rescueId)).send({ latitude: 18.5, longitude: 73.8 })).status, role).toBe(403);
    }
    expect((await request(ctx.app).post(L(s.rescueId)).send({ latitude: 18.5, longitude: 73.8 })).status).toBe(401);
    // A party to the rescue (it held it once) cannot share after letting go.
    await outsider.agent.post(`${R(s.rescueId)}/assign-self`).send({}).expect(200);
    await outsider.agent.post(`${R(s.rescueId)}/runner/release`).send({ reason: 'Cannot make it' }).expect(200);
    const after = await outsider.agent.post(L(s.rescueId)).send({ latitude: 18.5, longitude: 73.8 });
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('TRACKING_NOT_ACTIVE');
    expect(await total()).toBe(0);
  });

  it('is refused for a direct-pickup rescue (no runner)', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const l = await availableListing(provider.agent);
    const id = (await accept(ngo.agent, l.id)).body.data.rescue.id;
    await provider.agent.post(`${R(id)}/confirm`).send({}).expect(200);
    const read = await ngo.agent.get(L(id));
    expect(read.body.data).toMatchObject({ location: null, reason: 'NO_RUNNER' });
  });
});

describe('stopping sharing (runner)', () => {
  it('deletes the stored point at once, only for the assigned runner, and is safe to repeat', async () => {
    const s = await assigned(ctx);
    await s.runner.agent.post(L(s.rescueId)).send({ latitude: 18.5, longitude: 73.8 }).expect(200);
    expect(await stored(s.rescueId)).toHaveLength(1);
    const other = await runnerAt(ctx);
    expect((await other.agent.delete(L(s.rescueId))).status).toBeGreaterThanOrEqual(400);
    expect(await stored(s.rescueId)).toHaveLength(1);
    expect((await s.provider.agent.delete(L(s.rescueId))).status).toBe(403);
    expect((await request(ctx.app).delete(L(s.rescueId))).status).toBe(401);
    const res = await s.runner.agent.delete(L(s.rescueId));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cleared: true });
    expect(await stored(s.rescueId)).toHaveLength(0);
    expect((await s.provider.agent.get(L(s.rescueId))).body.data.location).toBeNull();
    expect((await s.runner.agent.delete(L(s.rescueId))).status).toBe(200);
  });
});

describe('reading a position', () => {
  it('lets the provider, the accepting NGO and admins see it, and nobody else', async () => {
    const s = await assigned(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    expect((await s.provider.agent.get(L(s.rescueId))).body.data).toMatchObject({ location: null, reason: 'NO_LOCATION_SHARED' });
    await s.runner.agent.post(L(s.rescueId)).send({ latitude: 18.523456, longitude: 73.857891 }).expect(200);
    for (const a of [s.provider.agent, s.ngo.agent, admin.agent]) {
      const res = await a.get(L(s.rescueId));
      expect(res.status).toBe(200);
      expect(res.body.data.location).toMatchObject({ latitude: 18.523, longitude: 73.858 });
      expect(res.body.data.location.ageSeconds).toBeLessThan(30);
      expect(Object.keys(res.body.data.location).sort()).toEqual(['ageSeconds', 'latitude', 'longitude', 'recordedAt']); // no identity, accuracy or speed
    }
    // The runner does not read positions back; unrelated users do not know the rescue exists.
    expect((await s.runner.agent.get(L(s.rescueId))).status).toBe(404);
    const strangers = [await verifiedAgent(ctx, 'provider'), await matchedNgo(ctx, { metersAway: 2000 }), await runnerAt(ctx)];
    for (const x of strangers) expect((await x.agent.get(L(s.rescueId))).status).toBe(404);
    expect((await request(ctx.app).get(L(s.rescueId))).status).toBe(401);
    expect((await s.provider.agent.get(L('not-a-uuid'))).status).toBe(404);
  });

  it('never returns a stale position', async () => {
    const s = await assigned(ctx);
    await s.runner.agent.post(L(s.rescueId)).send({ latitude: 18.5, longitude: 73.8 }).expect(200);
    await age(s.rescueId, 11 * 60); // older than RUNNER_LOCATION_MAX_AGE_MINUTES (10)
    expect((await s.ngo.agent.get(L(s.rescueId))).body.data).toMatchObject({ location: null, reason: 'LOCATION_STALE' });
  });

  it('is visible during transit too', async () => {
    const s = await inTransit(ctx);
    await s.runner.agent.post(L(s.rescueId)).send({ latitude: 18.51, longitude: 73.85 }).expect(200);
    expect((await s.ngo.agent.get(L(s.rescueId))).body.data.location).toMatchObject({ latitude: 18.51, longitude: 73.85 });
    expect((await s.ngo.agent.get(R(s.rescueId))).body.data.rescue.trackingActive).toBe(true); // the parties need it to show the map
    expect((await s.runner.agent.get(R(s.rescueId))).body.data.rescue.trackingActive).toBe(true);
  });
});

describe('retention: the position disappears when tracking stops', () => {
  it('is deleted at handover, so it cannot be read or shared afterwards', async () => {
    const s = await inTransit(ctx);
    await s.runner.agent.post(L(s.rescueId)).send({ latitude: 18.51, longitude: 73.85 }).expect(200);
    expect(await total()).toBe(1);
    await s.runner.agent.post(`${R(s.rescueId)}/delivery/handover`).send({}).expect(200);
    expect(await total()).toBe(0);
    expect((await s.ngo.agent.get(L(s.rescueId))).body.data).toMatchObject({ location: null, reason: 'NOT_TRACKING' });
    expect((await s.runner.agent.post(L(s.rescueId)).send({ latitude: 18.5, longitude: 73.8 })).status).toBe(409);
    expect(await total()).toBe(0);
  });

  it('is deleted when the runner releases, the NGO cancels or an admin reassigns', async () => {
    const a = await assigned(ctx);
    await a.runner.agent.post(L(a.rescueId)).send({ latitude: 18.5, longitude: 73.8 }).expect(200);
    await a.runner.agent.post(`${R(a.rescueId)}/runner/release`).send({ reason: 'Flat tyre' }).expect(200);
    expect(await stored(a.rescueId)).toEqual([]);

    const b = await assigned(ctx);
    await b.runner.agent.post(L(b.rescueId)).send({ latitude: 18.5, longitude: 73.8 }).expect(200);
    await b.ngo.agent.post(`${R(b.rescueId)}/cancel`).send({ reason: 'Not needed' }).expect(200);
    expect(await stored(b.rescueId)).toEqual([]);

    const c = await assigned(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    await c.runner.agent.post(L(c.rescueId)).send({ latitude: 18.5, longitude: 73.8 }).expect(200);
    await admin.agent.post(`${R(c.rescueId)}/admin/reassign`).send({ reason: 'Unresponsive' }).expect(200);
    expect(await total()).toBe(0);
  });

  it('is deleted when an overdue rescue is settled, and is not exposed while it is overdue but unsettled', async () => {
    const s = await inTransit(ctx);
    await s.runner.agent.post(L(s.rescueId)).send({ latitude: 18.5, longitude: 73.8 }).expect(200);
    await ctx.db.execute(sql`UPDATE rescues SET delivery_confirm_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    // The row still exists (nothing has settled the rescue) but the read judges the EFFECTIVE status.
    expect(await total()).toBe(1);
    expect((await s.ngo.agent.get(L(s.rescueId))).body.data).toMatchObject({ location: null, reason: 'NOT_TRACKING' });
    await s.ngo.agent.get(R(s.rescueId)).expect(200); // reading the rescue settles it
    expect(await total()).toBe(0);
  });

  it('is not kept after a completed rescue', async () => {
    const s = await delivered(ctx);
    await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 40 }).expect(200);
    expect(await total()).toBe(0);
  });
});
