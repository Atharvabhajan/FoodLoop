import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { minutesFromNow, requirementBody, resetData, setup, signedInAgent, verifiedAgent } from './helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const BASE = '/api/v1/ngo-requirements';

describe('NGO requirement: authorization', () => {
  it('is NGO-only and requires a verified organization to manage', async () => {
    expect((await request(ctx.app).get(`${BASE}/current`)).status).toBe(401);
    for (const role of ['provider', 'runner', 'admin'] as const) {
      const u = await signedInAgent(ctx, role);
      expect((await u.agent.get(`${BASE}/current`)).status, role).toBe(403);
      expect((await u.agent.post(BASE).send(requirementBody())).status, role).toBe(403);
    }
    const unverified = await signedInAgent(ctx, 'ngo');
    const res = await unverified.agent.post(BASE).send(requirementBody());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORGANIZATION_NOT_VERIFIED');
    // An unverified NGO may look, but sees nothing and cannot manage.
    const cur = await unverified.agent.get(`${BASE}/current`);
    expect(cur.status).toBe(200);
    expect(cur.body.data).toMatchObject({ requirement: null, organization: { verificationStatus: 'UNSUBMITTED' } });
    expect((await unverified.agent.post(`${BASE}/current/pause`)).status).toBe(403);
  });

  it('keeps each NGO to its own requirement', async () => {
    const a = await verifiedAgent(ctx, 'ngo');
    const b = await verifiedAgent(ctx, 'ngo');
    await a.agent.post(BASE).send(requirementBody({ neededServings: 11, capacityServings: 12 })).expect(201);
    expect((await b.agent.get(`${BASE}/current`)).body.data.requirement).toBeNull();
    await b.agent.post(BASE).send(requirementBody({ neededServings: 22, capacityServings: 30 })).expect(201);
    expect((await a.agent.get(`${BASE}/current`)).body.data.requirement.neededServings).toBe(11);
    // B pausing and editing never touches A.
    await b.agent.post(`${BASE}/current/pause`).expect(200);
    await b.agent.patch(`${BASE}/current`).send({ serviceRadiusKm: 9 }).expect(200);
    const after = (await a.agent.get(`${BASE}/current`)).body.data.requirement;
    expect(after).toMatchObject({ intakeEnabled: true, serviceRadiusKm: 5, neededServings: 11 });
  });
});

describe('NGO requirement: create and validate', () => {
  it('creates an active requirement with all fields', async () => {
    const { agent, organizationId } = await verifiedAgent(ctx, 'ngo');
    const res = await agent.post(BASE).send(requirementBody());
    expect(res.status).toBe(201);
    expect(res.body.data.requirement).toMatchObject({
      ngoOrgId: organizationId,
      foodCategories: ['COOKED_MEALS', 'BAKERY'],
      neededServings: 40,
      capacityServings: 60,
      serviceRadiusKm: 5,
      intakeEnabled: true,
      active: true,
      acceptingNow: true,
    });
    const cur = await agent.get(`${BASE}/current`);
    expect(cur.body.data.requirement.id).toBe(res.body.data.requirement.id);
  });

  it('allows only one current requirement per NGO', async () => {
    const { agent } = await verifiedAgent(ctx, 'ngo');
    await agent.post(BASE).send(requirementBody()).expect(201);
    const dup = await agent.post(BASE).send(requirementBody());
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('REQUIREMENT_EXISTS');
  });

  it('validates every field', async () => {
    const { agent } = await verifiedAgent(ctx, 'ngo');
    const bad = async (o: Record<string, unknown>, field: string) => {
      const res = await agent.post(BASE).send(requirementBody(o));
      expect(res.status, field).toBe(400);
      expect(res.body.details.fields[field], field).toBeDefined();
    };
    await bad({ foodCategories: [] }, 'foodCategories');
    await bad({ foodCategories: ['PIZZA'] }, 'foodCategories.0');
    await bad({ foodCategories: ['BAKERY', 'BAKERY'] }, 'foodCategories');
    await bad({ neededServings: 0 }, 'neededServings');
    await bad({ neededServings: 2.5 }, 'neededServings');
    await bad({ capacityServings: -1 }, 'capacityServings');
    await bad({ neededServings: 80, capacityServings: 60 }, 'capacityServings');
    await bad({ serviceRadiusKm: 0 }, 'serviceRadiusKm');
    await bad({ serviceRadiusKm: 101 }, 'serviceRadiusKm');
    await bad({ availableFrom: 'soon' }, 'availableFrom');
    await bad({ availableFrom: minutesFromNow(100), availableTo: minutesFromNow(50) }, 'availableTo');
    await bad({ availableFrom: minutesFromNow(-200), availableTo: minutesFromNow(-100) }, 'availableTo');
    expect((await agent.post(BASE).send({ ...requirementBody(), ngoOrgId: 'x' })).status).toBe(400);
    expect((await agent.post(BASE).send({})).status).toBe(400);
  });

  it('reports a future availability window as active but not yet accepting', async () => {
    const { agent } = await verifiedAgent(ctx, 'ngo');
    const res = await agent.post(BASE).send(requirementBody({ availableFrom: minutesFromNow(60), availableTo: minutesFromNow(600) }));
    expect(res.body.data.requirement).toMatchObject({ active: true, acceptingNow: false });
  });
});

describe('NGO requirement: update, pause and resume', () => {
  it('updates fields and re-validates the merged result', async () => {
    const { agent } = await verifiedAgent(ctx, 'ngo');
    await agent.post(BASE).send(requirementBody()).expect(201);
    const ok = await agent.patch(`${BASE}/current`).send({ neededServings: 50, capacityServings: 80, foodCategories: ['PRODUCE'], serviceRadiusKm: 12.5 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.requirement).toMatchObject({ neededServings: 50, capacityServings: 80, foodCategories: ['PRODUCE'], serviceRadiusKm: 12.5 });
    const bad = await agent.patch(`${BASE}/current`).send({ neededServings: 100 }); // > capacity 80
    expect(bad.status).toBe(400);
    expect(bad.body.details.fields.capacityServings).toBeDefined();
    expect((await agent.patch(`${BASE}/current`).send({})).status).toBe(400);
    expect((await agent.patch(`${BASE}/current`).send({ intakeEnabled: false })).status).toBe(400); // use pause/resume
    expect((await agent.get(`${BASE}/current`)).body.data.requirement.neededServings).toBe(50);
  });

  it('returns 404 when updating a requirement that does not exist', async () => {
    const { agent } = await verifiedAgent(ctx, 'ngo');
    const res = await agent.patch(`${BASE}/current`).send({ neededServings: 5 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('REQUIREMENT_NOT_FOUND');
    expect((await agent.post(`${BASE}/current/pause`)).status).toBe(404);
  });

  it('pauses and resumes intake without deleting the profile, idempotently', async () => {
    const { agent } = await verifiedAgent(ctx, 'ngo');
    const created = (await agent.post(BASE).send(requirementBody())).body.data.requirement;

    const paused = await agent.post(`${BASE}/current/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.data.requirement).toMatchObject({ id: created.id, intakeEnabled: false, active: false, acceptingNow: false, neededServings: 40 });
    const again = await agent.post(`${BASE}/current/pause`);
    expect(again.body.data.requirement).toMatchObject({ intakeEnabled: false });
    expect(again.body.data.requirement.updatedAt).toBe(paused.body.data.requirement.updatedAt);

    const resumed = await agent.post(`${BASE}/current/resume`);
    expect(resumed.body.data.requirement).toMatchObject({ id: created.id, intakeEnabled: true, active: true });
    const n = ((await ctx.db.execute(sql`SELECT count(*)::int AS n FROM ngo_requirements`)).rows[0] as { n: number }).n;
    expect(n).toBe(1);
  });

  it('stops counting as active when the availability window ends', async () => {
    const { agent } = await verifiedAgent(ctx, 'ngo');
    await agent.post(BASE).send(requirementBody()).expect(201);
    await ctx.db.execute(sql`UPDATE ngo_requirements SET available_from = now() - interval '2 days', available_to = now() - interval '1 hour'`);
    const cur = (await agent.get(`${BASE}/current`)).body.data.requirement;
    expect(cur).toMatchObject({ intakeEnabled: true, active: false, acceptingNow: false });
    // Editing needs a valid future window; extending it revives the requirement.
    const stale = await agent.patch(`${BASE}/current`).send({ neededServings: 30 });
    expect(stale.status).toBe(400);
    expect(stale.body.details.fields.availableTo).toMatch(/future/);
    const extended = await agent.patch(`${BASE}/current`).send({ availableFrom: minutesFromNow(-10), availableTo: minutesFromNow(600) });
    expect(extended.body.data.requirement).toMatchObject({ active: true });
  });

  it('stores the service radius without using it for any spatial filtering', async () => {
    const { agent } = await verifiedAgent(ctx, 'ngo');
    await agent.post(BASE).send(requirementBody({ serviceRadiusKm: 7.5 })).expect(201);
    const row = (await ctx.db.execute(sql`SELECT service_radius_km FROM ngo_requirements`)).rows[0] as { service_radius_km: number };
    expect(row.service_radius_km).toBe(7.5);
  });
});
