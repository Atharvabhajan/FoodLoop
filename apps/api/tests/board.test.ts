import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RescueSettings } from '../src/config.js';
import { createBoardService } from '../src/modules/board/service.js';
import { availableListing, createListing, matchedNgo, minutesFromNow, resetData, setup, signedInAgent, verifiedAgent } from './helpers.js';
import { R, accept, assigned, awaitingRunner, count, delivered, inTransit, rows, runnerAt } from './runner-helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

type Org = Awaited<ReturnType<typeof verifiedAgent>>;
const BOARD = '/api/v1/admin/board';
const MIN = 60_000;
const noSettle = async () => 0;
const ts = (d: Date) => d.toISOString();
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

/** The board as seen at an exact instant (no settling), with an optional override of the delayed threshold. */
const boardAt = (now: Date, percent?: number) =>
  createBoardService(ctx.runtime.db, { ...(ctx.config.rescue as RescueSettings), ...(percent ? { delayedElapsedPercent: percent } : {}) }, () => now);
const one = async (id: string, now: Date, percent?: number) => (await boardAt(now, percent).rescues(noSettle, { q: id })).rescues[0]!;

/* ---------- fixtures (real flows; timestamps then pinned in SQL for boundaries) ---------- */

async function directReserved(provider?: Org, ngo?: Org) {
  const p = provider ?? (await verifiedAgent(ctx, 'provider'));
  const n = ngo ?? (await matchedNgo(ctx, { metersAway: 1000 }));
  const l = await availableListing(p.agent);
  const acc = await accept(n.agent, l.id);
  expect(acc.status).toBe(201);
  return { provider: p, ngo: n, listing: l, rescueId: acc.body.data.rescue.id as string };
}
async function directAssigned(provider?: Org, ngo?: Org) {
  const s = await directReserved(provider, ngo);
  const code = (await s.provider.agent.post(`${R(s.rescueId)}/confirm`).send({})).body.data.pickupCode as string;
  return { ...s, code };
}
async function directPickedUp(provider?: Org, ngo?: Org) {
  const s = await directAssigned(provider, ngo);
  await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 }).expect(200);
  return s;
}
async function directCompleted(provider?: Org, ngo?: Org, deliveredServings = 30) {
  const s = await directPickedUp(provider, ngo);
  await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings }).expect(200);
  return s;
}
const setRescue = (id: string, set: ReturnType<typeof sql>) => ctx.db.execute(sql`UPDATE rescues SET ${set} WHERE id = ${id}::uuid`);
const enteredAt = async (id: string, status: string) => new Date(((await rows(ctx, sql`SELECT max(created_at) AS t FROM rescue_events WHERE rescue_id = ${id}::uuid AND to_status = ${status}::rescue_status`))[0] as { t: string }).t);

async function openIncident(agent: Org['agent'], rescueId: string, severity: 'LOW' | 'HIGH', category = 'PICKUP_PROBLEM') {
  // A different text per severity: an identical report within two minutes is (by design) treated as a repeat.
  const r = await agent.post(`${R(rescueId)}/incidents`).send({ category, severity, description: `Something went wrong at the kitchen door (${severity.toLowerCase()}).` });
  expect(r.status).toBe(201);
  return r.body.data.incident.id as string;
}

/* ---------------------------------- authorization ---------------------------------- */

describe('operations map positions', () => {
  it('gives each rescue and live listing only a coarse (2-decimal) position and city, never the address', async () => {
    const s = await directReserved();
    await ctx.db.execute(sql`UPDATE food_listings SET latitude = 18.523456, longitude = 73.856789 WHERE id = ${s.listing.id}::uuid`);
    const admin = await signedInAgent(ctx, 'admin');
    const res = await admin.agent.get(`${BOARD}/rescues`);
    const r = res.body.data.rescues.find((x: { id: string }) => x.id === s.rescueId);
    expect(r.area.latitude).toBe(18.52);
    expect(r.area.longitude).toBe(73.86);
    expect(typeof r.area.city).toBe('string');
    expect(JSON.stringify(res.body.data)).not.toMatch(/18\.523456|73\.856789|addressLine|Food Court/);
    const live = await availableListing(s.provider.agent);
    await ctx.db.execute(sql`UPDATE food_listings SET latitude = 18.523456, longitude = 73.856789 WHERE id = ${live.id}::uuid`);
    const l = (await admin.agent.get(`${BOARD}/listings?scope=live`)).body.data.listings.find((x: { id: string }) => x.id === live.id);
    expect(l.area).toMatchObject({ latitude: 18.52, longitude: 73.86 });
  });
});

describe('authorization', () => {
  it('is for admins only, on every route, enforced on the server', async () => {
    const s = await directReserved();
    const runner = await runnerAt(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    const urls = [`${BOARD}/rescues`, `${BOARD}/rescues/${s.rescueId}`, `${BOARD}/options`, `${BOARD}/listings`];
    for (const url of urls) {
      expect((await request(ctx.app).get(url)).status, `anon ${url}`).toBe(401);
      for (const who of [s.provider, s.ngo, runner]) expect((await who.agent.get(url)).status, url).toBe(403);
      expect((await admin.agent.get(url)).status, `admin ${url}`).toBe(200);
    }
  });

  it('exposes no way to change anything (read-only: other methods do not exist)', async () => {
    const s = await directReserved();
    const admin = await signedInAgent(ctx, 'admin');
    const before = (await rows(ctx, sql`SELECT version, status FROM rescues WHERE id = ${s.rescueId}::uuid`))[0];
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await admin.agent[m](`${BOARD}/rescues/${s.rescueId}`).send({ status: 'COMPLETED' });
      expect(res.status, m).toBe(404);
    }
    expect((await rows(ctx, sql`SELECT version, status FROM rescues WHERE id = ${s.rescueId}::uuid`))[0]).toEqual(before);
  });
});

/* ---------------------------------- classification ---------------------------------- */

describe('classification and counts', () => {
  it('counts active, delayed, failed, completed and cancelled separately', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    await directReserved(provider, ngo); // active
    const slow = await directReserved(provider, ngo); // delayed (pinned below)
    await directCompleted(provider, ngo); // completed
    const cancelled = await directReserved(provider, ngo);
    await ngo.agent.post(`${R(cancelled.rescueId)}/cancel`).send({ reason: 'No longer needed here' }).expect(200);
    const failed = await inTransit(ctx); // delivery failed by an admin
    const admin = await signedInAgent(ctx, 'admin');
    await admin.agent.post(`${R(failed.rescueId)}/admin/fail`).send({ reason: 'Custody of the food is in doubt' }).expect(200);
    const now = new Date();
    await setRescue(slow.rescueId, sql`reserved_at = ${ts(plus(now, -18 * MIN))}::timestamptz, provider_confirm_by = ${ts(plus(now, 2 * MIN))}::timestamptz`);

    const res = await admin.agent.get(`${BOARD}/rescues`);
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toMatchObject({ active: 1, delayed: 1, failed: 1, completed: 1, cancelled: 1, total: 5, needsAdmin: 1 });
    expect(res.body.data.delayedRule).toEqual({ elapsedPercent: 75 });
    expect(res.body.data.page).toMatchObject({ number: 1, size: 25, total: 5, pages: 1 });
  });

  it('lists failed outcomes (expired, pickup failed, delivery failed) under failed, and marks only delivery failures as needing an admin', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const a = await awaitingRunner(ctx);
    await setRescue(a.rescueId, sql`runner_by = now() - interval '1 minute'`);
    await a.ngo.agent.get(R(a.rescueId)).expect(200); // settles to EXPIRED
    const b = await directAssigned();
    await setRescue(b.rescueId, sql`pickup_by = now() - interval '1 minute'`);
    await b.ngo.agent.get(R(b.rescueId)).expect(200); // PICKUP_FAILED
    const c = await inTransit(ctx);
    await setRescue(c.rescueId, sql`delivery_confirm_by = now() - interval '1 minute'`);
    await c.ngo.agent.get(R(c.rescueId)).expect(200); // DELIVERY_FAILED
    const d = (await admin.agent.get(`${BOARD}/rescues?state=failed&sort=oldest`)).body.data;
    expect(d.counts.failed).toBe(3);
    expect(d.rescues.map((r: { status: string }) => r.status).sort()).toEqual(['DELIVERY_FAILED', 'EXPIRED', 'PICKUP_FAILED']);
    expect(d.rescues.filter((r: { needsAdmin: boolean }) => r.needsAdmin)).toHaveLength(1);
    expect((await admin.agent.get(`${BOARD}/rescues?needsAdmin=true`)).body.data.rescues).toHaveLength(1);
  });

  it('settles an overdue rescue before reading, so it appears as failed and never as active or delayed', async () => {
    const s = await directAssigned();
    await setRescue(s.rescueId, sql`pickup_by = now() - interval '1 second'`);
    const admin = await signedInAgent(ctx, 'admin');
    const d = (await admin.agent.get(`${BOARD}/rescues?q=${s.rescueId}`)).body.data;
    expect(d.rescues[0]).toMatchObject({ status: 'PICKUP_FAILED', state: 'failed' });
    expect(d.counts).toMatchObject({ active: 0, delayed: 0, failed: 1 });
  });

  it('keeps operational states out of the impact totals (only completed rescues are rescued meals)', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const admin = await signedInAgent(ctx, 'admin');
    await directCompleted(provider, ngo, 30);
    const before = (await admin.agent.get('/api/v1/impact/platform')).body.data.metrics;
    await directReserved(provider, ngo);
    const c = await directReserved(provider, ngo);
    await ngo.agent.post(`${R(c.rescueId)}/cancel`).send({ reason: 'Changed our plans' }).expect(200);
    await inTransit(ctx);
    const board = (await admin.agent.get(`${BOARD}/rescues`)).body.data.counts;
    expect(board.total).toBe(4); // completed, reserved, cancelled and the in-transit one
    const after = (await admin.agent.get('/api/v1/impact/platform')).body.data.metrics;
    expect(after.completedRescues).toBe(before.completedRescues);
    expect(after.servingsDelivered).toBe(before.servingsDelivered);
    expect(after.completedRescues).toBe(board.completed);
  });
});

/* ---------------------------------- delayed rule ---------------------------------- */

describe('the delayed rule', () => {
  const T = new Date('2030-06-01T12:00:00.000Z');

  it('RESERVED: delayed once 75% of the confirmation window has passed (inclusive)', async () => {
    const s = await directReserved();
    await setRescue(s.rescueId, sql`reserved_at = ${ts(T)}::timestamptz, provider_confirm_by = ${ts(plus(T, 20 * MIN))}::timestamptz`);
    const at = (ms: number) => one(s.rescueId, plus(T, ms));
    expect((await at(15 * MIN - 1000)).state).toBe('active');
    const exactly = await at(15 * MIN);
    expect(exactly).toMatchObject({ state: 'delayed', delay: { reason: 'STAGE_BEHIND_SCHEDULE', overdueAction: 'Provider confirmation' } });
    expect(exactly.delay!.text).toMatch(/75% of the allowed time/);
    expect((await at(19 * MIN)).state).toBe('delayed');
    expect((await at(0)).state).toBe('active');
  });

  it('uses the configured percentage and validates it', async () => {
    const s = await directReserved();
    await setRescue(s.rescueId, sql`reserved_at = ${ts(T)}::timestamptz, provider_confirm_by = ${ts(plus(T, 20 * MIN))}::timestamptz`);
    expect((await one(s.rescueId, plus(T, 15 * MIN), 80)).state).toBe('active'); // 75% < 80%
    expect((await one(s.rescueId, plus(T, 16 * MIN), 80)).state).toBe('delayed'); // exactly 80%
    expect((await one(s.rescueId, plus(T, 10 * MIN), 50)).state).toBe('delayed');
    expect((await one(s.rescueId, plus(T, 10 * MIN - 1000), 50)).state).toBe('active');
    const { loadRescueSettings } = await import('../src/config.js');
    expect(loadRescueSettings({}).delayedElapsedPercent).toBe(75);
    expect(loadRescueSettings({ OPS_DELAYED_ELAPSED_PERCENT: '60' }).delayedElapsedPercent).toBe(60);
    for (const bad of ['0', '100', '-5', 'half']) expect(() => loadRescueSettings({ OPS_DELAYED_ELAPSED_PERCENT: bad })).toThrow();
  });

  it('AWAITING_RUNNER: measured from when the search began to the runner deadline', async () => {
    const s = await awaitingRunner(ctx);
    const start = await enteredAt(s.rescueId, 'AWAITING_RUNNER');
    await setRescue(s.rescueId, sql`runner_by = ${ts(plus(start, 40 * MIN))}::timestamptz`);
    // The event time carries microseconds that a JS Date cannot, so test a second either side; the exact inclusive edge is
    // asserted for the stages whose timestamps are pinned to the millisecond.
    expect((await one(s.rescueId, plus(start, 30 * MIN - 1000))).state).toBe('active');
    expect(await one(s.rescueId, plus(start, 30 * MIN + 1000))).toMatchObject({ state: 'delayed', delay: { overdueAction: 'Runner acceptance' }, stage: { nextActor: 'runner' } });
  });

  it('PICKUP_ASSIGNED: delayed exactly when the listing pickup window closes (no threshold), before the grace deadline fails it', async () => {
    const s = await assigned(ctx);
    const D = plus(T, 0);
    await ctx.db.execute(sql`UPDATE food_listings SET pickup_deadline = ${ts(D)}::timestamptz WHERE id = ${s.listing.id}::uuid`);
    await setRescue(s.rescueId, sql`pickup_by = ${ts(plus(D, 30 * MIN))}::timestamptz`);
    expect((await one(s.rescueId, plus(D, -1))).state).toBe('active');
    const closed = await one(s.rescueId, D);
    expect(closed).toMatchObject({ state: 'delayed', delay: { reason: 'PICKUP_WINDOW_CLOSED', overdueAction: 'Pickup verification' }, stage: { nextActor: 'runner' } });
    expect(closed.delay!.text).toMatch(/Pickup verification is overdue: the pickup window closed/);
    expect(closed.delay!.text).toMatch(/grace period ends in 30 min/);
    expect((await one(s.rescueId, plus(D, 29 * MIN))).state).toBe('delayed');
  });

  it('PICKUP_CONFIRMED, IN_TRANSIT and DELIVERED: measured from the stage start to the delivery-confirmation deadline', async () => {
    const direct = await directPickedUp();
    await setRescue(direct.rescueId, sql`picked_up_at = ${ts(T)}::timestamptz, delivery_confirm_by = ${ts(plus(T, 100 * MIN))}::timestamptz`);
    expect((await one(direct.rescueId, plus(T, 75 * MIN - 1000))).state).toBe('active');
    expect(await one(direct.rescueId, plus(T, 75 * MIN))).toMatchObject({ state: 'delayed', delay: { overdueAction: 'Receipt confirmation' }, stage: { nextActor: 'ngo' } });

    const transit = await inTransit(ctx);
    await setRescue(transit.rescueId, sql`transit_started_at = ${ts(T)}::timestamptz, delivery_confirm_by = ${ts(plus(T, 120 * MIN))}::timestamptz`);
    expect((await one(transit.rescueId, plus(T, 90 * MIN - 1000))).state).toBe('active');
    expect(await one(transit.rescueId, plus(T, 90 * MIN))).toMatchObject({ state: 'delayed', delay: { overdueAction: 'Delivery handover' }, stage: { nextActor: 'runner' } });

    const handed = await delivered(ctx);
    await setRescue(handed.rescueId, sql`handed_over_at = ${ts(T)}::timestamptz, delivery_confirm_by = ${ts(plus(T, 60 * MIN))}::timestamptz`);
    expect((await one(handed.rescueId, plus(T, 45 * MIN - 1000))).state).toBe('active');
    expect(await one(handed.rescueId, plus(T, 45 * MIN))).toMatchObject({ state: 'delayed', delay: { overdueAction: 'Receipt confirmation' }, stage: { nextActor: 'ngo' } });
  });

  it('never calls a degenerate window (deadline not after its start) delayed by percentage', async () => {
    const s = await directReserved();
    await setRescue(s.rescueId, sql`reserved_at = ${ts(T)}::timestamptz, provider_confirm_by = ${ts(T)}::timestamptz`);
    expect((await one(s.rescueId, plus(T, 10 * MIN))).state).toBe('active');
  });

  it('an open blocking incident makes a rescue delayed, naming an admin as the next actor; a minor or resolved one does not', async () => {
    const s = await assigned(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    const minor = await openIncident(s.runner.agent, s.rescueId, 'LOW');
    const now = new Date();
    expect((await one(s.rescueId, now)).state).toBe('active');
    expect((await one(s.rescueId, now)).openIncidents).toBe(1);
    expect((await one(s.rescueId, now)).blocked).toBe(false);
    const blocking = await openIncident(s.runner.agent, s.rescueId, 'HIGH');
    const view = await one(s.rescueId, new Date());
    expect(view).toMatchObject({ state: 'delayed', blocked: true, openIncidents: 2, delay: { reason: 'BLOCKED_BY_INCIDENT', overdueAction: 'Resolve the open incident' }, stage: { nextActor: 'admin' } });
    expect(view.stage.nextAction).toMatch(/^Resolve the open incident, then:/);
    expect(view.links.incidents).toBe('/admin/incidents');
    expect((await admin.agent.get(`${BOARD}/rescues?blocked=true`)).body.data.rescues).toHaveLength(1);
    await admin.agent.post(`/api/v1/incidents/${blocking}/resolve`).send({ resolution: 'NO_ACTION', note: 'Checked with the kitchen' }).expect(200);
    await admin.agent.post(`/api/v1/incidents/${minor}/resolve`).send({ resolution: 'NO_ACTION', note: 'Not a problem' }).expect(200);
    expect((await one(s.rescueId, new Date())).state).toBe('active');
  });

  it('never reclassifies finished rescues as delayed, however old', async () => {
    const s = await directCompleted();
    await setRescue(s.rescueId, sql`reserved_at = now() - interval '400 days'`);
    expect((await one(s.rescueId, new Date())).state).toBe('completed');
  });

  it('shows who acts next, the deadline, and elapsed and remaining time for in-progress rescues', async () => {
    const s = await directReserved();
    await setRescue(s.rescueId, sql`reserved_at = ${ts(T)}::timestamptz, provider_confirm_by = ${ts(plus(T, 20 * MIN))}::timestamptz`);
    const v = await one(s.rescueId, plus(T, 5 * MIN));
    expect(v.stage).toMatchObject({ status: 'RESERVED', nextActor: 'provider', deadline: { label: 'Provider must confirm by', remainingMs: 15 * MIN }, elapsedMs: 5 * MIN });
    expect(v.stage.nextAction).toMatch(/Provider to confirm/);
    expect(v.ageMs).toBe(5 * MIN);
    expect(v.links.rescue).toBe(`/admin/rescues/${s.rescueId}`);
  });
});

/* ---------------------------------- filters, search, pagination ---------------------------------- */

describe('filters, search and pagination (server side)', () => {
  it('filters by state, organization, runner, transport mode and blocked', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const p1 = await verifiedAgent(ctx, 'provider');
    const p2 = await verifiedAgent(ctx, 'provider');
    const n1 = await matchedNgo(ctx, { metersAway: 1000 });
    const n2 = await matchedNgo(ctx, { metersAway: 1500 });
    const a = await directReserved(p1, n1);
    const b = await directReserved(p2, n2);
    const c = await directCompleted(p1, n2);
    const r = await assigned(ctx); // runner rescue (own provider and NGO)
    const get = async (q: string) => (await admin.agent.get(`${BOARD}/rescues?${q}`)).body.data;
    const ids = (d: { rescues: { id: string }[] }) => d.rescues.map((x) => x.id).sort();

    expect(ids(await get(`providerOrgId=${p1.organizationId}`))).toEqual([a.rescueId, c.rescueId].sort());
    expect(ids(await get(`ngoOrgId=${n2.organizationId}`))).toEqual([b.rescueId, c.rescueId].sort());
    expect(ids(await get(`providerOrgId=${p1.organizationId}&ngoOrgId=${n2.organizationId}`))).toEqual([c.rescueId]);
    expect(ids(await get('state=completed'))).toEqual([c.rescueId]);
    expect(ids(await get('state=active'))).toEqual([a.rescueId, b.rescueId, r.rescueId].sort());
    expect(ids(await get('transportMode=RUNNER'))).toEqual([r.rescueId]);
    expect(ids(await get(`runnerUserId=${r.runner.userId}`))).toEqual([r.rescueId]);
    expect(ids(await get(`runnerUserId=${(await runnerAt(ctx)).userId}`))).toEqual([]);

    // The counts follow the organization filter but not the state tab.
    const scoped = await get(`providerOrgId=${p1.organizationId}&state=completed`);
    expect(scoped.counts).toMatchObject({ active: 1, completed: 1, total: 2 });
    expect(scoped.page.total).toBe(1);
  });

  it('searches listing titles and organization names, and treats % and _ literally', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const l1 = await availableListing(provider.agent, { title: 'Rajma Chawal 100% fresh' });
    const l2 = await availableListing(provider.agent, { title: 'Paneer wrap' });
    const r1 = (await accept(ngo.agent, l1.id)).body.data.rescue.id as string;
    await accept(ngo.agent, l2.id);
    const search = async (q: string) => (await admin.agent.get(`${BOARD}/rescues`).query({ q })).body.data.rescues.map((x: { id: string }) => x.id);
    expect(await search('rajma')).toEqual([r1]);
    expect(await search('100%')).toEqual([r1]);
    expect(await search('%')).toEqual([r1]); // a literal percent sign, not "match everything"
    expect(await search('_')).toEqual([]); // a literal underscore, not "any character"
    expect((await search('Test provider org')).length).toBe(2); // organization name
    expect(await search(r1.slice(0, 8))).toEqual([r1]); // rescue id prefix
    expect(await search('no such thing')).toEqual([]);
  });

  it('filters by start date (UTC, inclusive) and by minimum age', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const when = ['2030-03-31T23:59:59.999Z', '2030-04-01T00:00:00.000Z', '2030-04-30T23:59:59.999Z', '2030-05-01T00:00:00.000Z'];
    const ids: string[] = [];
    for (const w of when) {
      const s = await directReserved(provider, ngo);
      await setRescue(s.rescueId, sql`reserved_at = ${w}::timestamptz`);
      ids.push(s.rescueId);
    }
    const get = async (q: string) => (await admin.agent.get(`${BOARD}/rescues?${q}`)).body.data.rescues.map((x: { id: string }) => x.id).sort();
    expect(await get('from=2030-04-01&to=2030-04-30')).toEqual([ids[1], ids[2]].sort());
    expect(await get('from=2030-04-30')).toEqual([ids[2], ids[3]].sort());
    expect(await get('to=2030-03-31')).toEqual([ids[0]]);
    expect((await admin.agent.get(`${BOARD}/rescues?olderThanMinutes=60`)).body.data.page.total).toBe(0); // all are in the future
    await setRescue(ids[0]!, sql`reserved_at = now() - interval '3 hours'`);
    expect(await get('olderThanMinutes=120')).toEqual([ids[0]]);
    expect(await get('olderThanMinutes=240')).toEqual([]);
  });

  it('rejects malformed filters with field errors', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    for (const [q, field] of [
      ['state=exploded', 'state'],
      ['providerOrgId=abc', 'providerOrgId'],
      ['transportMode=TELEPORT', 'transportMode'],
      ['page=0', 'page'],
      ['pageSize=101', 'pageSize'],
      ['pageSize=abc', 'pageSize'],
      ['olderThanMinutes=0', 'olderThanMinutes'],
      ['sort=random', 'sort'],
      ['from=2030-02-30', 'from'],
      ['from=2030-05-02&to=2030-05-01', 'to'],
      ['blocked=maybe', 'blocked'],
    ] as const) {
      const res = await admin.agent.get(`${BOARD}/rescues?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.details.fields[field], q).toBeTruthy();
    }
    expect((await admin.agent.get(`${BOARD}/rescues?unknownFilter=1`)).status).toBe(400);
    expect((await admin.agent.get(`${BOARD}/rescues?q=${'x'.repeat(101)}`)).status).toBe(400);
  });

  it('pages in a stable order with no gaps or repeats, and orders by attention by default', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const made: string[] = [];
    for (let i = 0; i < 7; i++) made.push((await directReserved(provider, ngo)).rescueId);
    const done = await directCompleted(provider, ngo);
    const slow = made[3]!;
    await setRescue(slow, sql`reserved_at = now() - interval '18 minutes', provider_confirm_by = now() + interval '2 minutes'`);

    const seen: string[] = [];
    for (let p = 1; p <= 3; p++) {
      const d = (await admin.agent.get(`${BOARD}/rescues?pageSize=3&page=${p}`)).body.data;
      expect(d.page).toMatchObject({ number: p, size: 3, total: 8, pages: 3 });
      seen.push(...d.rescues.map((x: { id: string }) => x.id));
    }
    expect(new Set(seen).size).toBe(8);
    const again: string[] = [];
    for (let p = 1; p <= 3; p++) again.push(...(await admin.agent.get(`${BOARD}/rescues?pageSize=3&page=${p}`)).body.data.rescues.map((x: { id: string }) => x.id));
    expect(again).toEqual(seen); // deterministic
    expect(seen[0]).toBe(slow); // delayed first
    expect(seen[seen.length - 1]).toBe(done.rescueId); // completed after everything in progress
    expect((await admin.agent.get(`${BOARD}/rescues?pageSize=3&page=9`)).body.data.rescues).toEqual([]);
    const newest = (await admin.agent.get(`${BOARD}/rescues?sort=newest&pageSize=100`)).body.data.rescues.map((x: { startedAt: string }) => x.startedAt);
    expect([...newest].sort().reverse()).toEqual(newest);
    expect((await admin.agent.get(`${BOARD}/rescues`)).body.data.page.size).toBe(25);
  });
});

/* ---------------------------------- detail ---------------------------------- */

describe('rescue detail', () => {
  it('gives the operational view with incidents and the audit-event count, and 404s for unknown ids', async () => {
    const s = await assigned(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    const inc = await openIncident(s.runner.agent, s.rescueId, 'HIGH', 'FOOD_SAFETY');
    const d = (await admin.agent.get(`${BOARD}/rescues/${s.rescueId}`)).body.data;
    expect(d.rescue).toMatchObject({ id: s.rescueId, state: 'delayed', runner: { name: expect.any(String) } });
    expect(d.incidents).toEqual([expect.objectContaining({ id: inc, category: 'FOOD_SAFETY', severity: 'HIGH', blocking: true, status: 'OPEN', link: `/admin/incidents/${inc}` })]);
    expect(JSON.stringify(d.incidents)).not.toContain('kitchen door'); // the description stays on the incident page
    expect(d.auditEvents).toBeGreaterThan(3);
    expect((await admin.agent.get(`${BOARD}/rescues/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await admin.agent.get(`${BOARD}/rescues/not-a-uuid`)).status).toBe(404);
  });
});

/* ---------------------------------- privacy ---------------------------------- */

describe('privacy', () => {
  it('returns only what operations needs: no codes, contacts, addresses, coordinates or secrets', async () => {
    const s = await assigned(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    await s.runner.agent.post(`${R(s.rescueId)}/location`).send({ latitude: 18.523456, longitude: 73.857891 }).expect(200);
    const bodies = JSON.stringify([
      (await admin.agent.get(`${BOARD}/rescues`)).body,
      (await admin.agent.get(`${BOARD}/rescues/${s.rescueId}`)).body,
      (await admin.agent.get(`${BOARD}/options`)).body,
      (await admin.agent.get(`${BOARD}/listings`)).body,
    ]);
    for (const secret of [s.code, 'Secret Lane', '@example.test', '+91', 'pickupCode', 'pickup_code', 'codeHash', 'password', '18.523', '73.857', 'storage', 'sha256', 'token', s.runner.email]) {
      expect(bodies, secret).not.toContain(secret);
    }
    // The operations map gets only coarse (about 1 km) area positions; nothing more precise than 2 decimals, and never the live runner position.
    expect(bodies).not.toMatch(/"(latitude|longitude)":-?\d+\.\d{3,}/);
    const runner = (await admin.agent.get(`${BOARD}/rescues`)).body.data.rescues[0].runner;
    expect(Object.keys(runner).sort()).toEqual(['id', 'name']);
  });
});

/* ---------------------------------- unaccepted listings ---------------------------------- */

describe('unaccepted listings', () => {
  it('shows live, unaccepted supply with urgency and matching counts, soonest deadline first', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const provider = await verifiedAgent(ctx, 'provider');
    await matchedNgo(ctx, { metersAway: 1000 });
    const urgent = await availableListing(provider.agent, { title: 'Urgent tray', pickupStart: minutesFromNow(5), pickupDeadline: minutesFromNow(45) });
    const normal = await availableListing(provider.agent, { title: 'Later tray', pickupDeadline: minutesFromNow(240) });
    const d = (await admin.agent.get(`${BOARD}/listings`)).body.data;
    expect(d.scope).toBe('live');
    expect(d.listings.map((l: { id: string }) => l.id)).toEqual([urgent.id, normal.id]);
    expect(d.listings[0]).toMatchObject({ title: 'Urgent tray', urgency: 'URGENT', actionable: true, status: 'AVAILABLE', provider: { id: provider.organizationId } });
    expect(d.listings[0].matching.eligibleNgos).toBe(1);
    expect(d.listings[0].flags).toEqual([]);
    expect(d.listings[0].remainingMs).toBeGreaterThan(40 * MIN);
    expect(d.counts).toMatchObject({ total: 2, noEligibleNgo: 0, byUrgency: { URGENT: 1, NORMAL: 1, CRITICAL: 0, PRIORITY: 0 } });
  });

  it('flags supply nobody can take and filters for it', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const lonely = await verifiedAgent(ctx, 'provider'); // no NGO exists near this listing yet
    const l = await availableListing(lonely.agent, { title: 'Stranded tray' });
    const d = (await admin.agent.get(`${BOARD}/listings?noEligible=true`)).body.data;
    expect(d.listings.map((x: { id: string }) => x.id)).toEqual([l.id]);
    expect(d.listings[0].flags).toContain('NO_ELIGIBLE_NGO');
    // Once an NGO that fits exists and matching is refreshed, the flag clears.
    await matchedNgo(ctx, { metersAway: 1000 });
    await lonely.agent.post(`/api/v1/listings/${l.id}/matches/refresh`).expect(200);
    const healed = (await admin.agent.get(`${BOARD}/listings`)).body.data;
    expect(healed.listings[0].flags).toEqual([]);
    expect(healed.listings[0].matching.eligibleNgos).toBe(1);
    expect((await admin.agent.get(`${BOARD}/listings?noEligible=true`)).body.data.listings).toEqual([]);
  });

  it('drops a listing once an NGO accepts it, and never shows drafts', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const l = await availableListing(provider.agent);
    const draft = await createListing(provider.agent, { title: 'Draft only' }); // saved but never published
    expect(draft.id).toBeTruthy();
    expect((await admin.agent.get(`${BOARD}/listings`)).body.data.listings.map((x: { id: string }) => x.id)).toEqual([l.id]);
    await accept(ngo.agent, l.id).then((r) => expect(r.status).toBe(201));
    const after = (await admin.agent.get(`${BOARD}/listings`)).body.data;
    expect(after.listings).toEqual([]);
    expect(after.counts.total).toBe(0);
  });

  it('keeps expired and cancelled listings out of the live view and shows them as non-actionable context', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const provider = await verifiedAgent(ctx, 'provider');
    const live = await availableListing(provider.agent, { title: 'Still live' });
    const cancelled = await availableListing(provider.agent, { title: 'Cancelled tray' });
    await provider.agent.post(`/api/v1/listings/${cancelled.id}/cancel`).send({ reason: 'Kitchen closed early' }).expect(200);
    const lapsed = await availableListing(provider.agent, { title: 'Lapsed tray' });
    await ctx.db.execute(sql`UPDATE food_listings SET prepared_at = now() - interval '4 hours', pickup_start = now() - interval '3 hours', pickup_deadline = now() - interval '1 hour' WHERE id = ${lapsed.id}::uuid`);
    const expired = await availableListing(provider.agent, { title: 'Swept tray' });
    await ctx.db.execute(sql`UPDATE food_listings SET status = 'EXPIRED', expired_at = now() - interval '2 hours', prepared_at = now() - interval '6 hours', pickup_start = now() - interval '5 hours', pickup_deadline = now() - interval '3 hours' WHERE id = ${expired.id}::uuid`);

    const liveView = (await admin.agent.get(`${BOARD}/listings`)).body.data;
    expect(liveView.listings.map((x: { id: string }) => x.id)).toEqual([live.id]);

    const closed = (await admin.agent.get(`${BOARD}/listings?scope=closed`)).body.data;
    expect(closed.scope).toBe('closed');
    expect(closed.listings.map((x: { title: string }) => x.title).sort()).toEqual(['Cancelled tray', 'Lapsed tray', 'Swept tray']);
    for (const x of closed.listings) {
      expect(x.actionable).toBe(false);
      expect(x.urgency).toBeNull();
      expect(x.remainingMs).toBeNull();
      expect(['CANCELLED', 'EXPIRED']).toContain(x.status);
      expect(x.flags).toEqual([]);
    }
    // Closed history is bounded by a window (default 7 days) and can be narrowed by date.
    await ctx.db.execute(sql`UPDATE food_listings SET expired_at = now() - interval '30 days', prepared_at = now() - interval '32 days', pickup_deadline = now() - interval '30 days', pickup_start = now() - interval '31 days' WHERE id = ${expired.id}::uuid`);
    expect((await admin.agent.get(`${BOARD}/listings?scope=closed`)).body.data.listings.map((x: { title: string }) => x.title)).not.toContain('Swept tray');
  });

  it('treats the pickup deadline as the end: a listing is live until that instant and closed from it', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(provider.agent, { title: 'Boundary tray' });
    const D = new Date('2031-01-01T10:00:00.000Z');
    await ctx.db.execute(sql`UPDATE food_listings SET prepared_at = ${ts(plus(D, -120 * MIN))}::timestamptz, pickup_start = ${ts(plus(D, -60 * MIN))}::timestamptz, pickup_deadline = ${ts(D)}::timestamptz WHERE id = ${l.id}::uuid`);
    const at = (now: Date) => createBoardService(ctx.runtime.db, ctx.config.rescue, () => now);
    expect((await at(plus(D, -1)).listings({})).listings.map((x) => x.id)).toEqual([l.id]);
    expect((await at(D).listings({})).listings).toEqual([]);
    expect((await at(D).listings({ scope: 'closed', closedFrom: plus(D, -86_400_000) })).listings.map((x) => x.id)).toEqual([l.id]);
    // Urgency buckets switch at their documented minute marks.
    const urgency = async (minutesBefore: number) => (await at(plus(D, -minutesBefore * MIN)).listings({})).listings[0]!.urgency;
    expect(await urgency(121)).toBe('NORMAL');
    expect(await urgency(120)).toBe('PRIORITY');
    expect(await urgency(60)).toBe('PRIORITY');
    expect(await urgency(59)).toBe('URGENT');
    expect(await urgency(30)).toBe('URGENT');
    expect(await urgency(29)).toBe('CRITICAL');
  });

  it('filters by provider, urgency and text, and pages with stable order', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const a = await verifiedAgent(ctx, 'provider');
    const b = await verifiedAgent(ctx, 'provider');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await availableListing(a.agent, { title: `Alpha ${i}`, pickupDeadline: minutesFromNow(200 + i) })).id);
    const crit = await availableListing(b.agent, { title: 'Beta critical', pickupStart: minutesFromNow(1), pickupDeadline: minutesFromNow(20) });
    const get = async (q: string) => (await admin.agent.get(`${BOARD}/listings?${q}`)).body.data;
    expect((await get(`providerOrgId=${b.organizationId}`)).listings.map((x: { id: string }) => x.id)).toEqual([crit.id]);
    expect((await get('urgency=CRITICAL')).listings.map((x: { id: string }) => x.id)).toEqual([crit.id]);
    expect((await get('q=alpha')).page.total).toBe(5);
    const p1 = await get('pageSize=2&page=1');
    const p2 = await get('pageSize=2&page=2');
    const p3 = await get('pageSize=2&page=3');
    const all = [...p1.listings, ...p2.listings, ...p3.listings].map((x: { id: string }) => x.id);
    expect(all).toEqual([crit.id, ...ids]); // soonest deadline first, then the alphas in deadline order
    expect(p1.page).toMatchObject({ total: 6, pages: 3 });
    expect((await admin.agent.get(`${BOARD}/listings?urgency=EXPIRED`)).status).toBe(400);
    expect((await admin.agent.get(`${BOARD}/listings?scope=archive`)).status).toBe(400);
  });
});

/* ---------------------------------- options ---------------------------------- */

describe('filter options', () => {
  it('lists the organizations and runners that appear in rescues, by name, without contact details', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const s = await assigned(ctx);
    const o = (await admin.agent.get(`${BOARD}/options`)).body.data;
    expect(o.organizations.map((x: { id: string }) => x.id).sort()).toEqual([s.provider.organizationId, s.ngo.organizationId].sort());
    expect(o.runners).toEqual([{ id: s.runner.userId, name: expect.any(String) }]);
    expect(Object.keys(o.organizations[0]).sort()).toEqual(['id', 'name', 'type']);
  });
});

/* ---------------------------------- representative volume ---------------------------------- */

describe('representative volume', () => {
  it('stays correct and fast with thousands of rescues and listings', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const providers = [await verifiedAgent(ctx, 'provider'), await verifiedAgent(ctx, 'provider'), await verifiedAgent(ctx, 'provider')];
    for (const metersAway of [1000, 1500, 2000]) await matchedNgo(ctx, { metersAway }); // the NGO organizations the bulk rows refer to
    const runners = [await runnerAt(ctx), await runnerAt(ctx)];
    const listing = await availableListing(providers[0]!.agent);
    const any = (await rows(ctx, sql`SELECT id FROM users LIMIT 1`))[0]!.id as string;

    // 6,000 terminal rescues over two years, plus 250 in progress (each on its own listing to respect the one-active-rescue index).
    await ctx.db.execute(sql`
      WITH p AS (SELECT array_agg(id ORDER BY id) AS ids FROM organizations WHERE type = 'PROVIDER'),
           n AS (SELECT array_agg(id ORDER BY id) AS ids FROM organizations WHERE type = 'NGO')
      INSERT INTO rescues (listing_id, provider_org_id, ngo_org_id, accepted_by, status, servings_offered, collected_servings, delivered_servings,
                           provider_confirm_by, pickup_by, completed_at, closed_at, transport_mode, reserved_at)
      SELECT ${listing.id}::uuid, p.ids[1 + (g % 3)], n.ids[1 + ((g / 3) % 3)], ${any}::uuid,
             (CASE g % 10 WHEN 0 THEN 'CANCELLED' WHEN 1 THEN 'EXPIRED' WHEN 2 THEN 'PICKUP_FAILED' WHEN 3 THEN 'DELIVERY_FAILED' ELSE 'COMPLETED' END)::rescue_status,
             50, 40, (g % 41), now(), now(), now(), now(), (CASE WHEN g % 3 = 0 THEN 'RUNNER' ELSE 'NGO_PICKUP' END)::transport_mode,
             timestamptz '2028-01-01' + make_interval(mins => (g * 53) % (60 * 24 * 700))
        FROM generate_series(1, 6000) g, p, n`);
    await ctx.db.execute(sql`
      WITH p AS (SELECT array_agg(id ORDER BY id) AS ids FROM organizations WHERE type = 'PROVIDER'),
           n AS (SELECT array_agg(id ORDER BY id) AS ids FROM organizations WHERE type = 'NGO'),
           l AS (
             INSERT INTO food_listings (provider_org_id, created_by, title, food_category, servings, prepared_at, pickup_start, pickup_deadline, address_line, city, latitude, longitude, packaging, dietary_tags, transport_required, status, published_at, declaration_accepted_at)
             SELECT p.ids[1 + (g % 3)], ${any}::uuid, 'Bulk ' || g, 'COOKED_MEALS', 20, now() - interval '1 hour', now() - interval '30 minutes', now() + make_interval(mins => 60 + (g % 600)),
                    'x', 'Pune', 18.52, 73.85, 'INDIVIDUAL_BOXES', '{}', false, 'RESERVED', now() - interval '20 minutes', now() - interval '20 minutes'
               FROM generate_series(1, 250) g, p RETURNING id, provider_org_id, title)
      INSERT INTO rescues (listing_id, provider_org_id, ngo_org_id, accepted_by, status, servings_offered, provider_confirm_by, pickup_by, reserved_at)
      SELECT l.id, l.provider_org_id, (SELECT n.ids[1 + (substring(l.title from 6)::int % 3)] FROM n), ${any}::uuid, 'RESERVED', 20,
             now() + make_interval(mins => 5 + (substring(l.title from 6)::int % 15)), now() + interval '3 hours', now() - make_interval(mins => substring(l.title from 6)::int % 25)
        FROM l`);
    await ctx.db.execute(sql`
      INSERT INTO rescue_assignments (rescue_id, runner_user_id, status)
      SELECT id, (ARRAY[${runners[0]!.userId}::uuid, ${runners[1]!.userId}::uuid])[1 + (row_number() OVER (ORDER BY id) % 2)::int], 'COMPLETED'
        FROM rescues WHERE transport_mode = 'RUNNER' AND status = 'COMPLETED'`);
    await ctx.db.execute(sql`ANALYZE rescues`);
    await ctx.db.execute(sql`ANALYZE food_listings`);
    await ctx.db.execute(sql`ANALYZE rescue_assignments`);

    const timed = async <T>(fn: () => Promise<T>) => {
      const t = Date.now();
      const out = await fn();
      return { out, ms: Date.now() - t };
    };
    const truth = (await rows(ctx, sql`
      SELECT count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
             count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
             count(*) FILTER (WHERE status IN ('EXPIRED', 'PICKUP_FAILED', 'DELIVERY_FAILED'))::int AS failed,
             count(*) FILTER (WHERE status = 'DELIVERY_FAILED')::int AS needs_admin,
             count(*) FILTER (WHERE status = 'RESERVED')::int AS in_progress, count(*)::int AS total FROM rescues`))[0] as Record<string, number>;

    const overview = await timed(() => admin.agent.get(`${BOARD}/rescues?pageSize=50`));
    const c = overview.out.body.data.counts;
    expect(c).toMatchObject({ completed: truth.completed, cancelled: truth.cancelled, failed: truth.failed, total: truth.total, needsAdmin: truth.needs_admin });
    expect(c.active + c.delayed).toBe(truth.in_progress);
    expect(c.delayed).toBeGreaterThan(0); // the 250 in-progress rescues were spread across the confirmation window
    expect(c.active).toBeGreaterThan(0);
    expect(overview.out.body.data.rescues).toHaveLength(50);
    expect(overview.ms).toBeLessThan(2500);

    // Each filter returns exactly what an independent query says.
    const p0 = providers[1]!.organizationId;
    const t1 = (await rows(ctx, sql`SELECT count(*)::int AS n FROM rescues WHERE provider_org_id = ${p0}::uuid AND status = 'COMPLETED'`))[0] as { n: number };
    const byOrg = await timed(() => admin.agent.get(`${BOARD}/rescues?providerOrgId=${p0}&state=completed&pageSize=100&page=3`));
    expect(byOrg.out.body.data.page.total).toBe(t1.n);
    expect(byOrg.ms).toBeLessThan(2500);
    const t2 = (await rows(ctx, sql`SELECT count(*)::int AS n FROM rescues WHERE reserved_at >= timestamptz '2028-06-01 00:00:00+00' AND reserved_at < timestamptz '2028-09-01 00:00:00+00'`))[0] as { n: number };
    const ranged = await timed(() => admin.agent.get(`${BOARD}/rescues?from=2028-06-01&to=2028-08-31&pageSize=100`));
    expect(ranged.out.body.data.counts.total).toBe(t2.n);
    expect(ranged.ms).toBeLessThan(2500);
    const t3 = (await rows(ctx, sql`SELECT count(DISTINCT rescue_id)::int AS n FROM rescue_assignments WHERE runner_user_id = ${runners[0]!.userId}::uuid`))[0] as { n: number };
    const byRunner = await timed(() => admin.agent.get(`${BOARD}/rescues?runnerUserId=${runners[0]!.userId}`));
    expect(byRunner.out.body.data.counts.total).toBe(t3.n);
    const searched = await timed(() => admin.agent.get(`${BOARD}/rescues?q=Vegetable`));
    expect(searched.ms).toBeLessThan(2500);

    // Impact and board agree, and in-progress/failed volume never leaks into rescued meals.
    const impact = (await admin.agent.get('/api/v1/impact/platform')).body.data.metrics;
    expect(impact.completedRescues).toBe(truth.completed);

    // Unaccepted listings: only the one live AVAILABLE listing; the 250 RESERVED ones are accepted supply.
    const l = await timed(() => admin.agent.get(`${BOARD}/listings?pageSize=100`));
    expect(l.out.body.data.counts.total).toBe(1);
    expect(l.ms).toBeLessThan(2500);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM rescues`)).toBe(truth.total!);
  }, 180_000);
});
