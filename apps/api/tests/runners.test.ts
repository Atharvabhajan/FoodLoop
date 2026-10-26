import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMatchSettings, loadRescueSettings } from '../src/config.js';
import { createMatchingService } from '../src/modules/matching/service.js';
import { createRescueService } from '../src/modules/rescues/service.js';
import { evaluateRunner, requiredKg, type RunnerFacts } from '../src/modules/runners/eligibility.js';
import { availableListing, matchedNgo, minutesFromNow, resetData, setup, signedInAgent, verifiedAgent } from './helpers.js';
import { R, accept, assigned, assignments, awaitingRunner, count, delivered, events, inTransit, listingStatus, rescueRow, rows, runnerAt } from './runner-helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

/* ------------------------------------------------------------------------------------------ */

describe('runner eligibility rules (pure)', () => {
  const s = loadMatchSettings({});
  const NOW = new Date('2026-10-25T12:00:00Z');
  const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
  const job = { requiredKg: 18, pickupStart: at(0), pickupDeadline: at(180) };
  const runner = (o: Partial<RunnerFacts> = {}): RunnerFacts => ({
    availability: 'AVAILABLE', vehicleType: 'BICYCLE', capacityKg: 25, radiusKm: 8, hasCoordinates: true,
    distanceM: 2000, withinRadius: true, busy: false, previouslyReleased: false, ...o,
  });
  const codes = (r: RunnerFacts, j = job) => evaluateRunner(j, r, NOW, s).reasons.map((x) => x.code);

  it('passes a complete, available, nearby runner with enough capacity', () => {
    expect(codes(runner())).toEqual([]);
    const e = evaluateRunner(job, runner(), NOW, s);
    expect(e.travelMinutes).toBe(7); // 2 km x 1.4 = 2.8 km at 25 km/h = 6.7 min, rounded up
    expect(e.marginMinutes).toBeGreaterThan(0);
  });

  it('applies every hard filter and reports each failing reason', () => {
    expect(codes(runner({ availability: 'OFFLINE' }))).toEqual(['RUNNER_OFFLINE']);
    expect(codes(runner({ availability: null, vehicleType: null, capacityKg: null, radiusKm: null }))).toEqual(expect.arrayContaining(['PROFILE_INCOMPLETE', 'RUNNER_OFFLINE']));
    expect(codes(runner({ busy: true }))).toEqual(['ALREADY_BUSY']);
    expect(codes(runner({ previouslyReleased: true }))).toEqual(['PREVIOUSLY_RELEASED']);
    expect(codes(runner({ capacityKg: 10 }))).toEqual(['CAPACITY']);
    expect(codes(runner({ withinRadius: false }))).toEqual(['OUTSIDE_RADIUS']);
    expect(codes(runner({ hasCoordinates: false, distanceM: null, withinRadius: null }))).toEqual(['NO_COORDINATES']);
    // 6 km + dispatch buffer cannot make a 30-minute window.
    expect(codes(runner({ distanceM: 6000 }), { ...job, pickupDeadline: at(30) })).toEqual(['TIME_INFEASIBLE']);
  });

  it('capacity boundary is inclusive and the load falls back to servings x kg-per-serving', () => {
    expect(codes(runner({ capacityKg: 18 }))).toEqual([]);
    expect(codes(runner({ capacityKg: 17.99 }))).toEqual(['CAPACITY']);
    expect(requiredKg({ estimatedKg: 18, servings: 45 }, 0.4)).toBe(18);
    expect(requiredKg({ estimatedKg: null, servings: 45 }, 0.4)).toBe(18);
    expect(requiredKg({ estimatedKg: null, servings: 10 }, 0.5)).toBe(5);
  });

  it('validates runner/rescue settings', () => {
    expect(loadRescueSettings({}).runnerSearchMinutes).toBe(30);
    expect(loadRescueSettings({ RESCUE_TRANSIT_MINUTES: '45' }).transitMinutes).toBe(45);
    expect(() => loadRescueSettings({ RESCUE_RUNNER_SEARCH_MINUTES: '0' })).toThrow();
    expect(() => loadRescueSettings({ RUNNER_LOCATION_MIN_INTERVAL_SECONDS: 'x' })).toThrow();
  });
});

describe('runner profile', () => {
  it('is runner-only and starts offline and empty', async () => {
    const runner = await signedInAgent(ctx, 'runner');
    const res = await runner.agent.get('/api/v1/runner/profile');
    expect(res.status).toBe(200);
    expect(res.body.data.profile).toMatchObject({ availabilityStatus: 'OFFLINE', vehicleType: null, capacityKg: null, complete: false, busy: false });
    for (const role of ['provider', 'ngo', 'admin'] as const) {
      expect((await (await signedInAgent(ctx, role)).agent.get('/api/v1/runner/profile')).status, role).toBe(403);
    }
    expect((await request(ctx.app).get('/api/v1/runner/profile')).status).toBe(401);
  });

  it('saves a complete profile, rounding the base position to about 1 km', async () => {
    const { agent } = await signedInAgent(ctx, 'runner');
    const put = await agent.put('/api/v1/runner/profile').send({ availabilityStatus: 'AVAILABLE', vehicleType: 'BICYCLE', capacityKg: 20, radiusKm: 6, latitude: 18.523456, longitude: 73.857891 });
    expect(put.status).toBe(200);
    expect(put.body.data.profile).toMatchObject({ availabilityStatus: 'AVAILABLE', vehicleType: 'BICYCLE', capacityKg: 20, radiusKm: 6, latitude: 18.52, longitude: 73.86, complete: true });
    const stored = (await rows(ctx, sql`SELECT latitude, longitude, geog IS NOT NULL AS has_geog FROM volunteer_profiles`))[0];
    expect(stored).toMatchObject({ latitude: 18.52, longitude: 73.86, has_geog: true }); // the precise input is never stored
  });

  it('refuses to go available with an incomplete profile, and validates every field', async () => {
    const { agent } = await signedInAgent(ctx, 'runner');
    const res = await agent.put('/api/v1/runner/profile').send({ availabilityStatus: 'AVAILABLE', vehicleType: null, capacityKg: null, radiusKm: null, latitude: null, longitude: null });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.details.fields)).toEqual(expect.arrayContaining(['vehicleType', 'capacityKg', 'radiusKm', 'latitude']));
    const base = { availabilityStatus: 'OFFLINE', vehicleType: 'CAR', capacityKg: 20, radiusKm: 5, latitude: 18.5, longitude: 73.8 };
    for (const bad of [{ capacityKg: 0 }, { capacityKg: 5000 }, { radiusKm: 101 }, { radiusKm: -1 }, { vehicleType: 'ROCKET' }, { latitude: 91 }, { availabilityStatus: 'BUSY' }, { extra: 1 }, { latitude: 18.5, longitude: null }]) {
      expect((await agent.put('/api/v1/runner/profile').send({ ...base, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await agent.put('/api/v1/runner/profile').send(base)).status).toBe(200); // offline can be incomplete-safe
  });
});

describe('requesting a runner when accepting', () => {
  it('asks for a runner only on listings that request transport; the default stays direct pickup', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const noTransport = await availableListing(provider.agent, { title: 'Collect-only', transportRequired: false });
    const bad = await accept(ngo.agent, noTransport.id, { transportMode: 'RUNNER' });
    expect(bad.status).toBe(400);
    expect(bad.body.details.fields.transportMode).toMatch(/did not ask for transport/);
    expect((await accept(ngo.agent, noTransport.id, { transportMode: 'ROCKET' })).status).toBe(400);
    const direct = await accept(ngo.agent, noTransport.id);
    expect(direct.status).toBe(201);
    expect(direct.body.data.rescue.transportMode).toBe('NGO_PICKUP');
  });

  it('records the runner request and tells the provider', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const l = await availableListing(provider.agent);
    const res = await accept(ngo.agent, l.id, { transportMode: 'RUNNER' });
    expect(res.status).toBe(201);
    expect(res.body.data.rescue).toMatchObject({ transportMode: 'RUNNER', status: 'RESERVED' });
    const note = (await provider.agent.get('/api/v1/notifications')).body.data.notifications[0];
    expect(note.body).toMatch(/volunteer runner/);
    expect(((await events(ctx, res.body.data.rescue.id))[0]!.metadata as { transportMode: string }).transportMode).toBe('RUNNER');
  });
});

describe('direct NGO pickup is unchanged', () => {
  it('still runs end to end without a runner, and runners cannot see or claim it', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const runner = await runnerAt(ctx);
    const l = await availableListing(provider.agent);
    const acc = await accept(ngo.agent, l.id); // no transportMode: direct pickup, even though transport is requested
    const id = acc.body.data.rescue.id;
    const conf = await provider.agent.post(`${R(id)}/confirm`).send({});
    expect(conf.body.data.rescue.status).toBe('PICKUP_ASSIGNED');
    expect((await runner.agent.get('/api/v1/rescues/available-runs')).body.data.jobs).toEqual([]);
    expect((await runner.agent.post(`${R(id)}/assign-self`).send({})).status).toBe(404);
    expect((await runner.agent.get(R(id))).status).toBe(404);
    const verify = await ngo.agent.post(`${R(id)}/pickup/verify`).send({ code: conf.body.data.pickupCode, collectedServings: 44 });
    expect(verify.body.data.rescue.status).toBe('PICKUP_CONFIRMED');
    const done = await ngo.agent.post(`${R(id)}/delivery/confirm`).send({ deliveredServings: 44 });
    expect(done.body.data.rescue).toMatchObject({ status: 'COMPLETED', transportMode: 'NGO_PICKUP' });
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM rescue_assignments`)).toBe(0);
  });
});

describe('searching for a runner', () => {
  it('moves to AWAITING_RUNNER on confirmation, records the search, and notifies only eligible runners once', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const eligible = await runnerAt(ctx);
    const offline = await runnerAt(ctx, { availability: 'OFFLINE' });
    const tooSmall = await runnerAt(ctx, { capacityKg: 5 });
    const farAway = await runnerAt(ctx, { metersAway: 9000, radiusKm: 3 });
    const l = await availableListing(provider.agent);
    const acc = await accept(ngo.agent, l.id, { transportMode: 'RUNNER' });
    const id = acc.body.data.rescue.id;
    const conf = await provider.agent.post(`${R(id)}/confirm`).send({});
    expect(conf.body.data.rescue).toMatchObject({ status: 'AWAITING_RUNNER', transportMode: 'RUNNER', nextAction: { party: 'runner' } });
    expect(conf.body.data.pickupCode).toMatch(/^\d{6}$/);
    expect((await rescueRow(ctx, id)).runner_by).toBeTruthy();

    const search = (await events(ctx, id)).find((e) => e.event_type === 'RUNNER_SEARCH_STARTED')!;
    expect(search.metadata).toMatchObject({ eligibleRunners: 1 });
    const note = async (r: { agent: typeof eligible.agent }) => (await r.agent.get('/api/v1/notifications')).body.data.notifications.filter((n: { type: string }) => n.type === 'RUNNER_JOB');
    expect(await note(eligible)).toHaveLength(1);
    expect((await note(eligible))[0]).toMatchObject({ actionable: true });
    for (const r of [offline, tooSmall, farAway]) expect(await note(r)).toEqual([]);
    expect(JSON.stringify(await note(eligible))).not.toMatch(/Secret Lane|18\.52043/);

    // A repeated confirm changes nothing: no second event, no second notification.
    const again = await provider.agent.post(`${R(id)}/confirm`).send({});
    expect(again.body.data).toMatchObject({ changed: false, pickupCode: null });
    expect(await note(eligible)).toHaveLength(1);
    expect((await events(ctx, id)).filter((e) => e.event_type === 'RUNNER_SEARCH_STARTED')).toHaveLength(1);
  });

  it('shows a runner only the jobs they could accept, with approximate locations and labelled estimates', async () => {
    const s = await awaitingRunner(ctx);
    const eligible = await runnerAt(ctx);
    const jobs = (await eligible.agent.get('/api/v1/rescues/available-runs')).body.data.jobs;
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j).toMatchObject({ rescueId: s.rescueId, listingTitle: 'Vegetable Biryani', servings: 45, loadKg: 18, providerName: 'Test provider org', ngoName: 'Test ngo org' });
    expect(j.pickupArea).toEqual({ city: 'Pune', latitude: 18.52, longitude: 73.86 });
    expect(j.estimates.note).toMatch(/not a route/i);
    expect(j.estimates.runnerToPickupKm).toBeCloseTo(2.0, 1);
    expect(['NORMAL', 'PRIORITY']).toContain(j.urgency);
    const raw = JSON.stringify(jobs);
    for (const secret of ['12 Secret Lane', 'Block C', '18.52043', '73.85674', 'contact', 'pickupCode']) expect(raw, secret).not.toContain(secret);

    const hidden = [
      await runnerAt(ctx, { availability: 'OFFLINE' }),
      await runnerAt(ctx, { capacityKg: 10 }), // 18 kg load
      await runnerAt(ctx, { metersAway: 9000, radiusKm: 4 }), // outside its own radius
      await runnerAt(ctx, { positioned: false }), // no base position
      await runnerAt(ctx, { vehicle: null, capacityKg: null, radiusKm: null }), // incomplete profile
    ];
    for (const r of hidden) expect((await r.agent.get('/api/v1/rescues/available-runs')).body.data.jobs).toEqual([]);
    for (const role of ['provider', 'ngo', 'admin'] as const) {
      expect((await (await signedInAgent(ctx, role)).agent.get('/api/v1/rescues/available-runs')).status, role).toBe(403);
    }
    expect((await request(ctx.app).get('/api/v1/rescues/available-runs')).status).toBe(401);
  });

  it('does not offer a job whose deadline a runner could not meet', async () => {
    await awaitingRunner(ctx, { pickupStart: minutesFromNow(5), pickupDeadline: minutesFromNow(30) });
    const near = await runnerAt(ctx, { metersAway: 300 });
    const far = await runnerAt(ctx, { metersAway: 5500 }); // 7.7 km road ~ 19 min + 20 min dispatch > 30
    expect((await near.agent.get('/api/v1/rescues/available-runs')).body.data.jobs).toHaveLength(1);
    expect((await far.agent.get('/api/v1/rescues/available-runs')).body.data.jobs).toEqual([]);
  });
});

describe('claiming a job', () => {
  it('assigns an eligible runner, notifies both organisations and updates the rescue', async () => {
    const runner = await runnerAt(ctx); // already available when the search starts, so they are told about the job
    const s = await awaitingRunner(ctx);
    const res = await runner.agent.post(`${R(s.rescueId)}/assign-self`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ changed: true, rescue: { status: 'PICKUP_ASSIGNED', viewerRole: 'runner', transportMode: 'RUNNER' } });
    expect(await assignments(ctx, s.rescueId)).toEqual([{ runner_user_id: runner.userId, status: 'ACTIVE', end_reason: null }]);
    expect((await events(ctx, s.rescueId)).at(-1)).toMatchObject({ to_status: 'PICKUP_ASSIGNED', actor_role: 'runner' });
    for (const a of [s.provider.agent, s.ngo.agent]) {
      const titles = (await a.get('/api/v1/notifications')).body.data.notifications.map((n: { title: string }) => n.title);
      expect(titles.some((t: string) => /runner accepted/i.test(t))).toBe(true);
    }
    // The job notification is no longer actionable once it is taken.
    const mine = (await runner.agent.get('/api/v1/notifications')).body.data.notifications.find((n: { type: string }) => n.type === 'RUNNER_JOB');
    expect(mine.actionable).toBe(false);
    // And the job disappears from every other runner's list.
    const other = await runnerAt(ctx);
    expect((await other.agent.get('/api/v1/rescues/available-runs')).body.data.jobs).toEqual([]);
  });

  it('is idempotent for the same runner', async () => {
    const s = await awaitingRunner(ctx);
    const runner = await runnerAt(ctx);
    await runner.agent.post(`${R(s.rescueId)}/assign-self`).send({}).expect(200);
    const again = await runner.agent.post(`${R(s.rescueId)}/assign-self`).send({});
    expect(again.status).toBe(200);
    expect(again.body.data.changed).toBe(false);
    expect(await assignments(ctx, s.rescueId)).toHaveLength(1);
    expect((await events(ctx, s.rescueId)).filter((e) => e.to_status === 'PICKUP_ASSIGNED')).toHaveLength(1);
  });

  it('lets exactly one of several runners claim a job at the same moment', async () => {
    const s = await awaitingRunner(ctx);
    const runners = [await runnerAt(ctx, { metersAway: 1500 }), await runnerAt(ctx, { metersAway: 2500 }), await runnerAt(ctx, { metersAway: 3500 }), await runnerAt(ctx, { metersAway: 4500 })];
    const results = await Promise.all(runners.flatMap((r) => [r.agent.post(`${R(s.rescueId)}/assign-self`).send({}), r.agent.post(`${R(s.rescueId)}/assign-self`).send({})]));
    expect(results.filter((r) => r.status === 200 && r.body.data.changed === true)).toHaveLength(1);
    for (const r of results) expect([200, 409]).toContain(r.status);
    const losers = results.filter((r) => r.status === 409);
    expect(losers.length).toBeGreaterThan(0);
    for (const l of losers) expect(l.body.code).toBe('RESCUE_NOT_AVAILABLE');
    const rows2 = await assignments(ctx, s.rescueId);
    expect(rows2.filter((a) => a.status === 'ACTIVE')).toHaveLength(1);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM rescue_events WHERE rescue_id = ${s.rescueId}::uuid AND to_status = 'PICKUP_ASSIGNED'`)).toBe(1);
  });

  it('is backed by database rules: no second ACTIVE assignment per rescue or per runner', async () => {
    const s = await assigned(ctx);
    const other = await runnerAt(ctx);
    await expect(ctx.db.execute(sql`INSERT INTO rescue_assignments (rescue_id, runner_user_id, status) VALUES (${s.rescueId}::uuid, ${other.userId}::uuid, 'ACTIVE')`)).rejects.toThrow();
    const s2 = await awaitingRunner(ctx);
    await expect(ctx.db.execute(sql`INSERT INTO rescue_assignments (rescue_id, runner_user_id, status) VALUES (${s2.rescueId}::uuid, ${s.runner.userId}::uuid, 'ACTIVE')`)).rejects.toThrow();
  });

  it('refuses ineligible runners with the reasons, and a runner already assigned elsewhere', async () => {
    const s = await awaitingRunner(ctx);
    const cases: [string, Awaited<ReturnType<typeof runnerAt>>, string][] = [
      ['offline', await runnerAt(ctx, { availability: 'OFFLINE' }), 'RUNNER_OFFLINE'],
      ['capacity', await runnerAt(ctx, { capacityKg: 5 }), 'CAPACITY'],
      ['radius', await runnerAt(ctx, { metersAway: 9000, radiusKm: 3 }), 'OUTSIDE_RADIUS'],
      ['no position', await runnerAt(ctx, { positioned: false }), 'NO_COORDINATES'],
      ['incomplete', await runnerAt(ctx, { vehicle: null }), 'PROFILE_INCOMPLETE'],
    ];
    for (const [label, r, code] of cases) {
      const res = await r.agent.post(`${R(s.rescueId)}/assign-self`).send({});
      expect(res.status, label).toBe(409);
      expect(res.body.code).toBe('NOT_ELIGIBLE');
      expect(res.body.details.reasons.map((x: { code: string }) => x.code), label).toContain(code);
    }
    expect(await assignments(ctx, s.rescueId)).toEqual([]);

    const busy = await runnerAt(ctx);
    await busy.agent.post(`${R(s.rescueId)}/assign-self`).send({}).expect(200);
    const second = await awaitingRunner(ctx);
    const res = await busy.agent.post(`${R(second.rescueId)}/assign-self`).send({});
    expect(res.status).toBe(409);
    expect(res.body.details.reasons.map((x: { code: string }) => x.code)).toContain('ALREADY_BUSY');
  });

  it('refuses non-runners, unknown ids, wrong bodies and jobs that are not waiting for a runner', async () => {
    const s = await awaitingRunner(ctx);
    for (const role of ['provider', 'ngo', 'admin'] as const) {
      expect((await (await signedInAgent(ctx, role)).agent.post(`${R(s.rescueId)}/assign-self`).send({})).status, role).toBe(403);
    }
    expect((await request(ctx.app).post(`${R(s.rescueId)}/assign-self`).send({})).status).toBe(401);
    const runner = await runnerAt(ctx);
    expect((await runner.agent.post(`${R('00000000-0000-4000-8000-000000000000')}/assign-self`).send({})).status).toBe(404);
    expect((await runner.agent.post(`${R('nope')}/assign-self`).send({})).status).toBe(404);
    expect((await runner.agent.post(`${R(s.rescueId)}/assign-self`).send({ x: 1 })).status).toBe(400);
    await s.ngo.agent.post(`${R(s.rescueId)}/cancel`).send({ reason: 'Plans changed' }).expect(200);
    const late = await runner.agent.post(`${R(s.rescueId)}/assign-self`).send({});
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('RESCUE_NOT_AVAILABLE');
  });

  it('cannot claim a job whose search deadline has passed, even before the worker runs', async () => {
    const s = await awaitingRunner(ctx);
    await ctx.db.execute(sql`UPDATE rescues SET runner_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    const runner = await runnerAt(ctx);
    expect((await runner.agent.get('/api/v1/rescues/available-runs')).body.data.jobs).toEqual([]);
    expect((await runner.agent.post(`${R(s.rescueId)}/assign-self`).send({})).status).toBe(409);
    expect((await rescueRow(ctx, s.rescueId)).status).toBe('EXPIRED'); // the failed claim settled it
  });
});

describe('privacy for the runner and the parties', () => {
  it('shares exact addresses and contacts with the assigned runner only while needed, and never the pickup code', async () => {
    const s = await awaitingRunner(ctx);
    await ctx.db.execute(sql`UPDATE organizations SET contact_name = 'Pat Provider', contact_phone = '+91 90000 00001', contact_email = 'pat@example.test' WHERE id = ${s.provider.organizationId}::uuid`);
    await ctx.db.execute(sql`UPDATE organizations SET contact_name = 'Nia NGO', contact_phone = '+91 90000 00002', address_line = '9 NGO Street' WHERE id = ${s.ngo.organizationId}::uuid`);
    const runner = await runnerAt(ctx);
    // Before accepting the runner is not a party at all.
    expect((await runner.agent.get(R(s.rescueId))).status).toBe(404);
    await runner.agent.post(`${R(s.rescueId)}/assign-self`).send({}).expect(200);

    const v = (await runner.agent.get(R(s.rescueId))).body.data.rescue;
    expect(v.listing.exactPickup).toMatchObject({ addressLine: '12 Secret Lane, Block C' });
    expect(v.ngo.destination).toMatchObject({ addressLine: '9 NGO Street' });
    expect(v.provider.contact).toMatchObject({ contactName: 'Pat Provider', contactPhone: '+91 90000 00001', contactEmail: null }); // no email for runners
    expect(v.ngo.contact).toMatchObject({ contactName: 'Nia NGO', contactEmail: null });
    expect(v.listing.hasImage).toBe(false);
    expect(JSON.stringify(v)).not.toContain(s.code);
    expect(v.pickupCode).toMatchObject({ issued: true });
    expect(v.pickupCode).not.toHaveProperty('code');

    // The parties see the runner's name and phone, but the provider still never sees the NGO's exact address.
    const prov = (await s.provider.agent.get(R(s.rescueId))).body.data.rescue;
    expect(prov.runner).toMatchObject({ name: 'Test runner', assignmentStatus: 'ACTIVE' });
    expect(prov.ngo.destination).toBeNull();
    expect(JSON.stringify(prov)).not.toContain('9 NGO Street');
    const ngo = (await s.ngo.agent.get(R(s.rescueId))).body.data.rescue;
    expect(ngo.runner.name).toBe('Test runner');

    // An unrelated runner cannot see anything about it.
    const stranger = await runnerAt(ctx);
    expect((await stranger.agent.get(R(s.rescueId))).status).toBe(404);
    expect((await stranger.agent.get('/api/v1/rescues?scope=all')).body.data.rescues).toEqual([]);
    expect((await runner.agent.get('/api/v1/rescues?scope=active')).body.data.rescues).toHaveLength(1);
  });

  it('removes the runner\'s needs-to-know access once the food is handed over', async () => {
    const s = await delivered(ctx);
    const v = (await s.runner.agent.get(R(s.rescueId))).body.data.rescue;
    expect(v.status).toBe('DELIVERED');
    expect(v.listing.exactPickup).toBeNull();
    expect(v.ngo.destination).toBeNull();
    expect(v.provider.contact).toBeNull();
    expect(v.ngo.contact).toBeNull();
    expect(v.allowedActions).toEqual(['report_incident'].filter(() => false)); // free of the rescue: nothing left to do
  });
});

describe('releasing and reassigning', () => {
  it('lets the runner step away before pickup: the search restarts and they are not re-offered the job', async () => {
    const s = await assigned(ctx);
    const other = await runnerAt(ctx);
    expect((await s.runner.agent.post(`${R(s.rescueId)}/runner/release`).send({})).status).toBe(400); // reason required
    const res = await s.runner.agent.post(`${R(s.rescueId)}/runner/release`).send({ reason: 'My bike has a flat tyre' });
    expect(res.status).toBe(200);
    expect(res.body.data.rescue.status).toBe('AWAITING_RUNNER');
    expect(await assignments(ctx, s.rescueId)).toEqual([{ runner_user_id: s.runner.userId, status: 'RELEASED', end_reason: 'My bike has a flat tyre' }]);
    expect((await rescueRow(ctx, s.rescueId)).runner_by).toBeTruthy();
    expect((await events(ctx, s.rescueId)).filter((e) => e.event_type === 'RUNNER_SEARCH_STARTED')).toHaveLength(2);

    // Not re-offered to the runner who left, but offered to others.
    expect((await s.runner.agent.get('/api/v1/rescues/available-runs')).body.data.jobs).toEqual([]);
    const again = await s.runner.agent.post(`${R(s.rescueId)}/assign-self`).send({});
    expect(again.status).toBe(409);
    expect(again.body.details.reasons.map((r: { code: string }) => r.code)).toContain('PREVIOUSLY_RELEASED');
    expect((await other.agent.get('/api/v1/rescues/available-runs')).body.data.jobs).toHaveLength(1);
    expect((await other.agent.post(`${R(s.rescueId)}/assign-self`).send({})).status).toBe(200);

    // Repeating the release is harmless (idempotent); the runner can no longer act on the rescue.
    const replay = await s.runner.agent.post(`${R(s.rescueId)}/runner/release`).send({ reason: 'My bike has a flat tyre' });
    expect(replay.status).toBe(200);
    expect(replay.body.data.changed).toBe(false);
    expect((await s.runner.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 10 })).status).toBe(409);
    const parties = (await s.provider.agent.get('/api/v1/notifications')).body.data.notifications.map((n: { body: string }) => n.body);
    expect(parties.some((b: string) => b.includes('flat tyre'))).toBe(true);
  });

  it('repeating a release returns the same result when nobody else has taken the job', async () => {
    const s = await assigned(ctx);
    await s.runner.agent.post(`${R(s.rescueId)}/runner/release`).send({ reason: 'Family emergency' }).expect(200);
    const replay = await s.runner.agent.post(`${R(s.rescueId)}/runner/release`).send({ reason: 'Family emergency' });
    expect(replay.status).toBe(200);
    expect(replay.body.data.changed).toBe(false);
    expect(await assignments(ctx, s.rescueId)).toHaveLength(1);
  });

  it('cannot be released after the food is collected', async () => {
    const s = await inTransit(ctx);
    const res = await s.runner.agent.post(`${R(s.rescueId)}/runner/release`).send({ reason: 'Changed my mind' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANNOT_RELEASE');
  });

  it('lets an admin replace the runner with a reason, notifying the runner', async () => {
    const s = await assigned(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    expect((await s.provider.agent.post(`${R(s.rescueId)}/admin/reassign`).send({ reason: 'Unresponsive' })).status).toBe(403);
    expect((await admin.agent.post(`${R(s.rescueId)}/admin/reassign`).send({})).status).toBe(400);
    const res = await admin.agent.post(`${R(s.rescueId)}/admin/reassign`).send({ reason: 'Runner is unresponsive' });
    expect(res.status).toBe(200);
    expect(res.body.data.rescue.status).toBe('AWAITING_RUNNER');
    expect((await assignments(ctx, s.rescueId))[0]).toMatchObject({ status: 'REVOKED', end_reason: 'Runner is unresponsive' });
    expect((await events(ctx, s.rescueId)).find((e) => e.reason === 'Runner is unresponsive')).toMatchObject({ actor_role: 'admin' });
    const note = (await s.runner.agent.get('/api/v1/notifications')).body.data.notifications.find((n: { title: string }) => /reassigned/i.test(n.title));
    expect(note).toBeTruthy();
    expect((await admin.agent.post(`${R(s.rescueId)}/admin/reassign`).send({ reason: 'Again please' })).body.code).toBe('INVALID_RESCUE_TRANSITION');
  });

  it('frees the runner when the NGO or provider cancels', async () => {
    const s = await assigned(ctx);
    const res = await s.ngo.agent.post(`${R(s.rescueId)}/cancel`).send({ reason: 'No longer needed' });
    expect(res.status).toBe(200);
    expect((await assignments(ctx, s.rescueId))[0]!.status).toBe('REVOKED');
    expect(await listingStatus(ctx, s.listing.id)).toBe('AVAILABLE');
    const view = (await s.runner.agent.get(R(s.rescueId))).body.data.rescue; // read-only history
    expect(view.status).toBe('CANCELLED');
    expect(view.allowedActions).toEqual([]);
    expect(view.listing.exactPickup).toBeNull();
    const note = (await s.runner.agent.get('/api/v1/notifications')).body.data.notifications.find((n: { title: string }) => /cancelled/i.test(n.title));
    expect(note).toMatchObject({ actionable: false });
    // They can take another job immediately.
    const next = await awaitingRunner(ctx);
    expect((await s.runner.agent.post(`${R(next.rescueId)}/assign-self`).send({})).status).toBe(200);
  });
});

describe('collecting the food and delivering it', () => {
  it('runs the whole runner-assisted flow, with the NGO\'s confirmation as the only way to complete', async () => {
    const s = await assigned(ctx);
    const wrong = s.code === '000000' ? '111111' : '000000';

    // Only the runner verifies pickup in runner mode.
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 })).status).toBe(403);
    expect((await s.provider.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 })).status).toBe(403);
    const bad = await s.runner.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: wrong, collectedServings: 40 });
    expect(bad.status).toBe(400);
    expect(bad.body.details.attemptsLeft).toBe(4);
    expect((await s.runner.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 46 })).body.details.fields.collectedServings).toMatch(/45/);

    const ok = await s.runner.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 43 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.rescue).toMatchObject({ status: 'IN_TRANSIT', collectedServings: 43, allowedActions: ['handover', 'report_incident'] });
    expect(await listingStatus(ctx, s.listing.id)).toBe('COLLECTED');
    const row = await rescueRow(ctx, s.rescueId);
    expect(row).toMatchObject({ pickup_code_hash: null, collected_servings: 43 });
    expect(row.transit_started_at).toBeTruthy();
    expect((await events(ctx, s.rescueId)).filter((e) => e.event_type === 'STATUS_CHANGED').map((e) => e.to_status)).toEqual(['AWAITING_RUNNER', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'IN_TRANSIT']);
    expect((await events(ctx, s.rescueId)).find((e) => e.to_status === 'PICKUP_CONFIRMED')!.metadata).toMatchObject({ proofMethod: 'OTP', collectedBy: 'runner', collectedServings: 43 });

    // Replaying the verification is a no-op.
    expect((await s.runner.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 43 })).body.data.changed).toBe(false);

    // The NGO cannot confirm receipt until the runner has handed over; nobody else can hand over.
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 43 })).body.code).toBe('INVALID_RESCUE_TRANSITION');
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/delivery/handover`).send({})).status).toBe(403);
    expect((await s.provider.agent.post(`${R(s.rescueId)}/delivery/handover`).send({})).status).toBe(403);

    const hand = await s.runner.agent.post(`${R(s.rescueId)}/delivery/handover`).send({ note: 'Left with the kitchen manager' });
    expect(hand.status).toBe(200);
    expect(hand.body.data.rescue.status).toBe('DELIVERED'); // NOT completed: the runner cannot close the rescue
    expect(hand.body.data.rescue.allowedActions).toEqual([]);
    expect((await assignments(ctx, s.rescueId))[0]!.status).toBe('COMPLETED'); // the runner is free again
    expect((await s.runner.agent.post(`${R(s.rescueId)}/delivery/handover`).send({})).body.data.changed).toBe(false);
    expect((await s.runner.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 43 })).status).toBe(403);

    // Only the NGO's confirmation completes it, and the quantity cannot exceed what was collected.
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 44 })).status).toBe(400);
    const done = await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 42 });
    expect(done.body.data.rescue).toMatchObject({ status: 'COMPLETED', deliveredServings: 42, outcomeCode: 'COMPLETED' });
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 42 })).body.data.changed).toBe(false);
    expect((await events(ctx, s.rescueId)).filter((e) => e.to_status === 'COMPLETED')).toHaveLength(1);

    // The runner's earlier notifications are no longer actionable, and a finished rescue stays read-only for them.
    const view = (await s.runner.agent.get(R(s.rescueId))).body.data.rescue;
    expect(view).toMatchObject({ status: 'COMPLETED', allowedActions: [] });
    const done2 = (await s.runner.agent.get('/api/v1/notifications')).body.data.notifications.filter((n: { type: string }) => n.type === 'RESCUE_UPDATE');
    for (const n of done2) expect(n.actionable).toBe(false);
  });

  it('keeps the runner a stranger to the NGO-pickup verification path and vice versa', async () => {
    const s = await assigned(ctx);
    const other = await runnerAt(ctx);
    expect((await other.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 })).status).toBe(404);
    expect((await other.agent.post(`${R(s.rescueId)}/delivery/handover`).send({})).status).toBe(404);
  });

  it('refuses verification well before the pickup window opens', async () => {
    const s = await awaitingRunner(ctx, { pickupStart: minutesFromNow(120), pickupDeadline: minutesFromNow(300) });
    const runner = await runnerAt(ctx);
    await runner.agent.post(`${R(s.rescueId)}/assign-self`).send({}).expect(200);
    const res = await runner.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 10 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PICKUP_WINDOW_CLOSED');
  });
});

describe('falling back to collecting it yourself', () => {
  it('lets the NGO switch to direct pickup while no runner holds the job', async () => {
    const s = await awaitingRunner(ctx);
    const runner = await runnerAt(ctx);
    expect((await s.provider.agent.post(`${R(s.rescueId)}/transport/self`).send({})).status).toBe(403);
    const res = await s.ngo.agent.post(`${R(s.rescueId)}/transport/self`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.rescue).toMatchObject({ status: 'PICKUP_ASSIGNED', transportMode: 'NGO_PICKUP', allowedActions: expect.arrayContaining(['verify_pickup']) });
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/transport/self`).send({})).body.data.changed).toBe(false);
    // The job vanishes for runners; the NGO now verifies pickup itself.
    expect((await runner.agent.get('/api/v1/rescues/available-runs')).body.data.jobs).toEqual([]);
    expect((await runner.agent.post(`${R(s.rescueId)}/assign-self`).send({})).status).toBe(404);
    const v = await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 });
    expect(v.body.data.rescue.status).toBe('PICKUP_CONFIRMED');
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 40 })).body.data.rescue.status).toBe('COMPLETED');
  });

  it('is not possible once a runner holds the job', async () => {
    const s = await assigned(ctx);
    const res = await s.ngo.agent.post(`${R(s.rescueId)}/transport/self`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_RESCUE_TRANSITION');
  });
});

describe('deadlines when a runner is involved', () => {
  const service = () => createRescueService(ctx.db, ctx.config.rescue, createMatchingService(ctx.db, ctx.config.match));

  it('expires a search nobody answers, releases the listing and alerts admins, without any timer', async () => {
    const s = await awaitingRunner(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    await ctx.db.execute(sql`UPDATE rescues SET runner_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    expect((await rescueRow(ctx, s.rescueId)).status).toBe('AWAITING_RUNNER'); // nothing has settled it yet
    const view = (await s.ngo.agent.get(R(s.rescueId))).body.data.rescue;
    expect(view).toMatchObject({ status: 'EXPIRED', outcomeCode: 'NO_RUNNER_FOUND' });
    expect(await listingStatus(ctx, s.listing.id)).toBe('AVAILABLE');
    expect((await events(ctx, s.rescueId)).at(-1)).toMatchObject({ to_status: 'EXPIRED', actor_role: 'system' });
    const adminNotes = (await admin.agent.get('/api/v1/notifications')).body.data.notifications;
    expect(adminNotes.some((n: { body: string }) => /No runner accepted/.test(n.body))).toBe(true);
    // Neither party can act on it afterwards.
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/transport/self`).send({})).body.code).toBe('INVALID_RESCUE_TRANSITION');
  });

  it('the worker settles runner deadlines idempotently and concurrently', async () => {
    const a = await awaitingRunner(ctx);
    await ctx.db.execute(sql`UPDATE rescues SET runner_by = now() - interval '1 second' WHERE id = ${a.rescueId}::uuid`);
    const svc = service();
    const counts = await Promise.all([svc.settleDue(), svc.settleDue(), svc.settleDue()]);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(1);
    expect(await svc.settleDue()).toBe(0);
    expect((await events(ctx, a.rescueId)).filter((e) => e.to_status === 'EXPIRED')).toHaveLength(1);
  });

  it('fails the pickup if the assigned runner never verifies it, freeing the runner', async () => {
    const s = await assigned(ctx);
    await ctx.db.execute(sql`UPDATE rescues SET pickup_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    expect(await service().settleDue()).toBe(1);
    expect(await rescueRow(ctx, s.rescueId)).toMatchObject({ status: 'PICKUP_FAILED', outcome_code: 'PICKUP_NOT_VERIFIED' });
    expect((await assignments(ctx, s.rescueId))[0]!.status).toBe('REVOKED');
    expect(await listingStatus(ctx, s.listing.id)).toBe('EXPIRED');
    expect((await s.runner.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 10 })).body.code).toBe('INVALID_RESCUE_TRANSITION');
  });

  it('flags an unfinished delivery for admins and a runner cannot then mark it successful', async () => {
    const s = await inTransit(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    await ctx.db.execute(sql`UPDATE rescues SET delivery_confirm_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    const view = (await s.provider.agent.get(R(s.rescueId))).body.data.rescue;
    expect(view).toMatchObject({ status: 'DELIVERY_FAILED', outcomeCode: 'TRANSIT_NOT_COMPLETED', nextAction: { party: 'admin' } });
    expect((await assignments(ctx, s.rescueId))[0]!.status).toBe('REVOKED');
    expect((await s.runner.agent.post(`${R(s.rescueId)}/delivery/handover`).send({})).body.code).toBe('INVALID_RESCUE_TRANSITION');
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 10 })).body.code).toBe('INVALID_RESCUE_TRANSITION');
    expect((await admin.agent.get('/api/v1/notifications')).body.data.notifications.some((n: { body: string }) => /Delivery was not completed in time/.test(n.body))).toBe(true);
    const res = await admin.agent.post(`${R(s.rescueId)}/admin/resolve`).send({ deliveredServings: 30, reason: 'NGO confirmed by phone' });
    expect(res.body.data.rescue).toMatchObject({ status: 'COMPLETED', outcomeCode: 'ADMIN_RESOLVED' });
  });

  it('fails an unconfirmed receipt after handover, for admin follow-up', async () => {
    const s = await delivered(ctx);
    await ctx.db.execute(sql`UPDATE rescues SET delivery_confirm_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    expect(await service().settleDue()).toBe(1);
    expect(await rescueRow(ctx, s.rescueId)).toMatchObject({ status: 'DELIVERY_FAILED', outcome_code: 'DELIVERY_NOT_CONFIRMED' });
  });
});

describe('admin intervention after pickup', () => {
  it('lets an admin declare a delivery failed (with a reason) and then resolve it', async () => {
    const s = await inTransit(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    expect((await s.runner.agent.post(`${R(s.rescueId)}/admin/fail`).send({ reason: 'Not mine to say' })).status).toBe(403);
    expect((await admin.agent.post(`${R(s.rescueId)}/admin/fail`).send({})).status).toBe(400);
    const res = await admin.agent.post(`${R(s.rescueId)}/admin/fail`).send({ reason: 'Runner unreachable, food not located' });
    expect(res.body.data.rescue).toMatchObject({ status: 'DELIVERY_FAILED', outcomeCode: 'ADMIN_MARKED_FAILED' });
    expect((await assignments(ctx, s.rescueId))[0]!.status).toBe('REVOKED');
    expect((await events(ctx, s.rescueId)).at(-1)).toMatchObject({ actor_role: 'admin', reason: 'Runner unreachable, food not located' });
  });
});
