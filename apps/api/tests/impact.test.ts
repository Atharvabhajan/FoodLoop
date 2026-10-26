import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { availableListing, matchedNgo, resetData, setup, signedInAgent, verifiedAgent, type Ctx } from './helpers.js';
import { R, accept, assigned, awaitingRunner, count, delivered, rows, runnerAt } from './runner-helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

type Org = Awaited<ReturnType<typeof verifiedAgent>>;
const ME = '/api/v1/impact/me';
const PLATFORM = '/api/v1/impact/platform';
const get = (agent: Org['agent'], url: string) => agent.get(url);

/** A direct-pickup rescue taken all the way to COMPLETED between the given provider and NGO. */
async function completedDirect(provider: Org, ngo: Org, o: { collected?: number; delivered?: number } = {}) {
  const l = await availableListing(provider.agent);
  const acc = await accept(ngo.agent, l.id);
  expect(acc.status).toBe(201);
  const id = acc.body.data.rescue.id as string;
  const conf = await provider.agent.post(`${R(id)}/confirm`).send({});
  const code = conf.body.data.pickupCode as string;
  expect((await ngo.agent.post(`${R(id)}/pickup/verify`).send({ code, collectedServings: o.collected ?? 40 })).status).toBe(200);
  const done = await ngo.agent.post(`${R(id)}/delivery/confirm`).send({ deliveredServings: o.delivered ?? 38 });
  expect(done.status).toBe(200);
  expect(done.body.data.rescue.status).toBe('COMPLETED');
  return id;
}

/** A runner-assisted rescue taken to COMPLETED; returns the parties. */
async function completedByRunner(deliveredServings = 36, collected = 40) {
  const s = await delivered(ctx, collected);
  const done = await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings });
  expect(done.status).toBe(200);
  return s;
}

const setCompletedAt = (id: string, iso: string) =>
  ctx.db.execute(sql`UPDATE rescues SET completed_at = ${iso}::timestamptz, closed_at = ${iso}::timestamptz WHERE id = ${id}::uuid`);

describe('what counts', () => {
  it('counts COMPLETED rescues only, and uses the delivered quantity (not offered, not collected)', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    await completedDirect(provider, ngo, { collected: 40, delivered: 31 }); // offered 45, collected 40, delivered 31

    // Not counted: cancelled, in progress, and a rescue that is picked up but never confirmed.
    const cancelled = await accept(ngo.agent, (await availableListing(provider.agent)).id);
    await ngo.agent.post(`${R(cancelled.body.data.rescue.id)}/cancel`).send({ reason: 'No longer needed here' }).expect(200);
    await accept(ngo.agent, (await availableListing(provider.agent)).id).then((r) => expect(r.status).toBe(201)); // RESERVED
    const picked = await accept(ngo.agent, (await availableListing(provider.agent)).id);
    const pid = picked.body.data.rescue.id as string;
    const code = (await provider.agent.post(`${R(pid)}/confirm`).send({})).body.data.pickupCode as string;
    await ngo.agent.post(`${R(pid)}/pickup/verify`).send({ code, collectedServings: 44 }).expect(200); // PICKUP_CONFIRMED

    const mine = (await get(provider.agent, ME)).body.data;
    expect(mine.metrics.completedRescues).toBe(1);
    expect(mine.metrics.servingsDelivered).toBe(31);
    const theirs = (await get(ngo.agent, ME)).body.data;
    expect(theirs.metrics).toMatchObject({ completedRescues: 1, servingsDelivered: 31 });
  });

  it('does not count failed, expired or unresolved rescues anywhere (platform view)', async () => {
    const good = await completedByRunner(30);
    // A runner delivery that failed: in transit, then marked failed by an admin.
    const failed = await assigned(ctx);
    await failed.runner.agent.post(`${R(failed.rescueId)}/pickup/verify`).send({ code: failed.code, collectedServings: 40 }).expect(200);
    const admin = await signedInAgent(ctx, 'admin');
    await admin.agent.post(`${R(failed.rescueId)}/admin/fail`).send({ reason: 'Food was not delivered' }).expect(200);
    // An expired search (no runner) and one still waiting for a runner.
    const expired = await awaitingRunner(ctx);
    await ctx.db.execute(sql`UPDATE rescues SET runner_by = now() - interval '1 minute' WHERE id = ${expired.rescueId}::uuid`);
    await expired.ngo.agent.get(R(expired.rescueId)).expect(200); // settles it
    await awaitingRunner(ctx);

    const p = (await admin.agent.get(PLATFORM)).body.data;
    expect(p.metrics.completedRescues).toBe(1);
    expect(p.metrics.servingsDelivered).toBe(30);
    expect(good.rescueId).toBeTruthy();
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM rescues`)).toBe(4);
  });

  it('counts an admin-resolved completion with the quantity the administrator recorded', async () => {
    const s = await delivered(ctx, 40);
    const admin = await signedInAgent(ctx, 'admin');
    await admin.agent.post(`${R(s.rescueId)}/admin/resolve`).send({ deliveredServings: 22, reason: 'Counted at the door with both parties' }).expect(200);
    const p = (await admin.agent.get(PLATFORM)).body.data.metrics;
    expect(p).toMatchObject({ completedRescues: 1, servingsDelivered: 22 });
  });

  it('counts a zero-serving completion as a completed rescue with zero servings', async () => {
    // An NGO must confirm at least one serving; zero can only come from an administrator's recorded resolution.
    const s = await delivered(ctx, 10);
    const admin = await signedInAgent(ctx, 'admin');
    await admin.agent.post(`${R(s.rescueId)}/admin/resolve`).send({ deliveredServings: 0, reason: 'Nothing was fit to eat on arrival' }).expect(200);
    expect((await get(s.provider.agent, ME)).body.data.metrics).toMatchObject({ completedRescues: 1, servingsDelivered: 0 });
  });
});

describe('each completed rescue contributes exactly once', () => {
  it('is unaffected by repeated confirmations, repeated reads, and a runner replacement mid-rescue', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const id = await completedDirect(provider, ngo, { delivered: 35 });
    // Replays of the completing call are idempotent and must not add anything.
    await ngo.agent.post(`${R(id)}/delivery/confirm`).send({ deliveredServings: 35 }).expect(200);
    for (let i = 0; i < 3; i++) await get(provider.agent, ME);
    expect((await get(provider.agent, ME)).body.data.metrics).toMatchObject({ completedRescues: 1, servingsDelivered: 35 });

    // Runner rescue with a first runner who releases and a second who completes: one rescue, two assignments rows.
    const s = await awaitingRunner(ctx);
    const first = await runnerAt(ctx);
    await first.agent.post(`${R(s.rescueId)}/assign-self`).send({}).expect(200);
    await first.agent.post(`${R(s.rescueId)}/runner/release`).send({ reason: 'Vehicle problem' }).expect(200);
    const second = await runnerAt(ctx);
    await second.agent.post(`${R(s.rescueId)}/assign-self`).send({}).expect(200);
    await second.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 }).expect(200);
    await second.agent.post(`${R(s.rescueId)}/delivery/handover`).send({}).expect(200);
    await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 33 }).expect(200);

    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.get(PLATFORM)).body.data.metrics).toMatchObject({ completedRescues: 2, servingsDelivered: 68 });
    expect((await s.provider.agent.get(ME)).body.data.metrics).toMatchObject({ completedRescues: 1, servingsDelivered: 33 });
    expect((await second.agent.get(ME)).body.data.metrics).toEqual({ completedRescues: 1, servingsDelivered: 33 });
    expect((await first.agent.get(ME)).body.data.metrics).toEqual({ completedRescues: 0, servingsDelivered: 0 }); // released: no credit
  });

  it('adds up across many rescues without double counting (per-month buckets sum to the total)', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const ids = [await completedDirect(provider, ngo, { delivered: 10 }), await completedDirect(provider, ngo, { delivered: 20 }), await completedDirect(provider, ngo, { delivered: 30 })];
    await setCompletedAt(ids[0]!, '2026-01-15T10:00:00Z');
    await setCompletedAt(ids[1]!, '2026-01-20T10:00:00Z');
    await setCompletedAt(ids[2]!, '2026-03-02T10:00:00Z');
    const d = (await get(provider.agent, ME)).body.data;
    expect(d.metrics).toMatchObject({ completedRescues: 3, servingsDelivered: 60 });
    expect(d.byMonth).toEqual([
      { month: '2026-01', rescues: 2, servings: 30 },
      { month: '2026-03', rescues: 1, servings: 30 },
    ]);
  });
});

describe('attribution', () => {
  it('scopes provider and NGO results to their own organization', async () => {
    const p1 = await verifiedAgent(ctx, 'provider');
    const p2 = await verifiedAgent(ctx, 'provider');
    const n1 = await matchedNgo(ctx, { metersAway: 1000 });
    const n2 = await matchedNgo(ctx, { metersAway: 1500 });
    await completedDirect(p1, n1, { delivered: 12 });
    await completedDirect(p2, n2, { delivered: 20 });
    await completedDirect(p2, n2, { delivered: 5 });
    expect((await get(p1.agent, ME)).body.data.metrics).toMatchObject({ completedRescues: 1, servingsDelivered: 12, recipientOrganizations: 1 });
    expect((await get(p2.agent, ME)).body.data.metrics).toMatchObject({ completedRescues: 2, servingsDelivered: 25 });
    expect((await get(n1.agent, ME)).body.data.metrics).toMatchObject({ completedRescues: 1, servingsDelivered: 12, providerOrganizations: 1 });
    expect((await get(n2.agent, ME)).body.data.metrics).toMatchObject({ completedRescues: 2, servingsDelivered: 25 });
  });

  it('splits direct pickup from runner-assisted rescues, and never credits a runner for a direct pickup', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    await completedDirect(provider, ngo, { delivered: 20 });
    const runnerRescue = await completedByRunner(30);
    const idle = await runnerAt(ctx);
    expect((await get(provider.agent, ME)).body.data.metrics.byTransport).toEqual({
      directPickup: { rescues: 1, servings: 20 },
      runnerAssisted: { rescues: 0, servings: 0 },
    });
    expect((await get(runnerRescue.provider.agent, ME)).body.data.metrics.byTransport).toEqual({
      directPickup: { rescues: 0, servings: 0 },
      runnerAssisted: { rescues: 1, servings: 30 },
    });
    expect((await runnerRescue.runner.agent.get(ME)).body.data.metrics).toEqual({ completedRescues: 1, servingsDelivered: 30 });
    expect((await idle.agent.get(ME)).body.data.metrics).toEqual({ completedRescues: 0, servingsDelivered: 0 });
    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.get(PLATFORM)).body.data.metrics).toMatchObject({ completedRescues: 2, runners: 1, byTransport: { directPickup: { rescues: 1 }, runnerAssisted: { rescues: 1 } } });
  });

  it('does not credit a runner whose delivery failed or who was replaced by an administrator', async () => {
    const s = await assigned(ctx);
    await s.runner.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 }).expect(200);
    const admin = await signedInAgent(ctx, 'admin');
    await admin.agent.post(`${R(s.rescueId)}/admin/fail`).send({ reason: 'Runner never arrived at the NGO' }).expect(200);
    // Later an administrator closes it with a recorded quantity: the rescue completes, but this runner's assignment was revoked.
    await admin.agent.post(`${R(s.rescueId)}/admin/resolve`).send({ deliveredServings: 25, reason: 'NGO confirmed receipt by phone' }).expect(200);
    expect((await admin.agent.get(PLATFORM)).body.data.metrics).toMatchObject({ completedRescues: 1, servingsDelivered: 25 });
    expect((await s.runner.agent.get(ME)).body.data.metrics).toEqual({ completedRescues: 0, servingsDelivered: 0 });
  });

  it('keeps an organization with several memberships separate from other organizations', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const other = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    await completedDirect(other, ngo, { delivered: 9 });
    const mine = (await get(provider.agent, ME)).body.data;
    expect(mine.scope.organizations.map((o: { id: string }) => o.id)).toEqual([provider.organizationId]);
    expect(mine.metrics.completedRescues).toBe(0);
  });
});

describe('authorization', () => {
  it('blocks cross-organization access: another organization looks like it does not exist', async () => {
    const p1 = await verifiedAgent(ctx, 'provider');
    const p2 = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    await completedDirect(p2, ngo);
    const own = await get(p1.agent, `${ME}?organizationId=${p1.organizationId}`);
    expect(own.status).toBe(200);
    for (const target of [p2.organizationId, ngo.organizationId, '00000000-0000-4000-8000-000000000000', 'not-a-uuid', 'x'.repeat(5)]) {
      const res = await get(p1.agent, `${ME}?organizationId=${target}`);
      expect(res.status, String(target)).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    // A provider cannot read an NGO's view of the same data, nor the reverse.
    expect((await get(ngo.agent, `${ME}?organizationId=${p2.organizationId}`)).status).toBe(404);
  });

  it('allows the platform summary to admins only, and /me to provider, NGO and runner only', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const runner = await runnerAt(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    for (const a of [provider.agent, ngo.agent, runner.agent]) expect((await a.get(PLATFORM)).status).toBe(403);
    expect((await admin.agent.get(ME)).status).toBe(403);
    expect((await request(ctx.app).get(ME)).status).toBe(401);
    expect((await request(ctx.app).get(PLATFORM)).status).toBe(401);
    for (const a of [provider.agent, ngo.agent, runner.agent]) expect((await a.get(ME)).status).toBe(200);
    expect((await admin.agent.get(PLATFORM)).status).toBe(200);
    expect((await runner.agent.get(`${ME}?organizationId=${provider.organizationId}`)).status).toBe(400);
  });

  it('stops showing an organization to a member who has been removed from it', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    await completedDirect(provider, ngo, { delivered: 14 });
    expect((await get(provider.agent, ME)).body.data.metrics.completedRescues).toBe(1);
    await ctx.db.execute(sql`UPDATE organization_members SET status = 'REMOVED' WHERE organization_id = ${provider.organizationId}::uuid`);
    const named = await get(provider.agent, `${ME}?organizationId=${provider.organizationId}`);
    expect(named.status).toBe(404);
    const plain = await get(provider.agent, ME);
    expect(plain.status).toBe(200);
    expect(plain.body.data.scope.organizations).toEqual([]);
    expect(plain.body.data.metrics).toMatchObject({ completedRescues: 0, servingsDelivered: 0 });
  });
});

describe('empty data', () => {
  it('returns zeros, no months, and the definitions for every role', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const runner = await runnerAt(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    for (const [agent, url] of [[provider.agent, ME], [ngo.agent, ME], [runner.agent, ME], [admin.agent, PLATFORM]] as const) {
      const res = await get(agent, url);
      expect(res.status).toBe(200);
      expect(res.body.data.metrics.completedRescues).toBe(0);
      expect(res.body.data.metrics.servingsDelivered).toBe(0);
      expect(res.body.data.byMonth).toEqual([]);
      expect(res.body.data.period).toMatchObject({ from: null, to: null, timeZone: 'UTC' });
      expect(Object.keys(res.body.data.definitions)).toEqual(expect.arrayContaining(['completedRescues', 'servingsDelivered', 'period']));
    }
  });
});

describe('kilograms are not invented', () => {
  it('reports no kilogram metric anywhere and says why', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    await completedDirect(provider, ngo); // the listing carries an estimatedKg of 18
    const res = (await get(provider.agent, ME)).body.data;
    expect(JSON.stringify(res.metrics)).not.toMatch(/kg|kilo/i);
    expect(JSON.stringify(res.byMonth)).not.toMatch(/kg|kilo/i);
    expect(res.unavailable[0]).toMatchObject({ metric: 'kilograms' });
    expect(res.unavailable[0].reason).toMatch(/no servings-to-kilograms conversion/);
  });
});

describe('date range', () => {
  const at = ['2026-03-31T23:59:59.999Z', '2026-04-01T00:00:00.000Z', '2026-04-15T12:00:00.000Z', '2026-04-30T23:59:59.999Z', '2026-05-01T00:00:00.000Z'];
  async function seeded() {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    for (const [i, when] of at.entries()) {
      const id = await completedDirect(provider, ngo, { delivered: 6 * (i + 1) });
      await setCompletedAt(id, when);
    }
    return provider;
  }

  it('includes both end days entirely and excludes the instants just outside', async () => {
    const p = await seeded();
    const d = (await get(p.agent, `${ME}?from=2026-04-01&to=2026-04-30`)).body.data;
    expect(d.metrics.completedRescues).toBe(3); // 00:00:00.000 on the 1st, mid month, 23:59:59.999 on the 30th
    expect(d.metrics.servingsDelivered).toBe(12 + 18 + 24);
    expect(d.period).toMatchObject({ from: '2026-04-01', to: '2026-04-30' });
    expect(d.byMonth).toEqual([{ month: '2026-04', rescues: 3, servings: 54 }]);
  });

  it('supports a single day, open-ended ranges, and a range with nothing in it', async () => {
    const p = await seeded();
    expect((await get(p.agent, `${ME}?from=2026-04-01&to=2026-04-01`)).body.data.metrics.completedRescues).toBe(1);
    expect((await get(p.agent, `${ME}?from=2026-04-30`)).body.data.metrics.completedRescues).toBe(2); // 30 Apr and 1 May
    expect((await get(p.agent, `${ME}?to=2026-03-31`)).body.data.metrics.completedRescues).toBe(1);
    const none = (await get(p.agent, `${ME}?from=2025-01-01&to=2025-12-31`)).body.data;
    expect(none.metrics.completedRescues).toBe(0);
    expect(none.byMonth).toEqual([]);
    expect((await get(p.agent, `${ME}`)).body.data.metrics.completedRescues).toBe(5);
  });

  it('puts boundary instants in the right UTC month buckets', async () => {
    const p = await seeded();
    const months = (await get(p.agent, ME)).body.data.byMonth;
    expect(months.map((m: { month: string; rescues: number }) => `${m.month}:${m.rescues}`)).toEqual(['2026-03:1', '2026-04:3', '2026-05:1']);
  });

  it('rejects malformed, impossible and inverted dates with field errors', async () => {
    const p = await verifiedAgent(ctx, 'provider');
    for (const [q, field] of [
      ['from=yesterday', 'from'],
      ['to=2026/04/01', 'to'],
      ['from=2026-02-30', 'from'],
      ['to=2026-13-01', 'to'],
      ['from=2026-04-10&to=2026-04-09', 'to'],
      ['from=26-04-01', 'from'],
    ] as const) {
      const res = await get(p.agent, `${ME}?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details.fields[field], q).toBeTruthy();
    }
    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.get(`${PLATFORM}?from=nope`)).status).toBe(400);
  });
});

describe('privacy of aggregate responses', () => {
  it('never carries other parties, rescue identifiers, addresses, contacts or incident text', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const rescueId = await completedDirect(provider, ngo);
    const s = await completedByRunner(30);
    const admin = await signedInAgent(ctx, 'admin');
    const responses = [
      (await get(provider.agent, ME)).body,
      (await get(ngo.agent, ME)).body,
      (await s.runner.agent.get(ME)).body,
      (await admin.agent.get(PLATFORM)).body,
    ];
    const text = JSON.stringify(responses);
    for (const secret of ['Secret Lane', '@example.test', rescueId, s.rescueId, s.runner.email, ngo.email, provider.email, '+91', 'latitude', 'longitude', 'pickupCode']) {
      expect(text, secret).not.toContain(secret);
    }
    // A provider sees the count of recipient organizations, not who they are.
    expect(JSON.stringify(responses[0])).not.toContain(ngo.organizationId);
    expect(JSON.stringify(responses[1])).not.toContain(provider.organizationId);
    // The platform summary identifies nothing at all.
    expect(JSON.stringify(responses[3])).not.toMatch(new RegExp(`${provider.organizationId}|${ngo.organizationId}`));
  });
});

describe('realistic volume', () => {
  it('matches independent SQL on thousands of mixed rescues and answers quickly', async () => {
    const providers = [await verifiedAgent(ctx, 'provider'), await verifiedAgent(ctx, 'provider'), await verifiedAgent(ctx, 'provider')];
    const ngos = [await matchedNgo(ctx, { metersAway: 1000 }), await matchedNgo(ctx, { metersAway: 1500 }), await matchedNgo(ctx, { metersAway: 2000 })];
    const runners = [await runnerAt(ctx), await runnerAt(ctx), await runnerAt(ctx)];
    const listing = await availableListing(providers[0]!.agent);
    const any = (await rows(ctx, sql`SELECT id FROM users LIMIT 1`))[0]!.id as string;

    // 4,500 rescues over ~20 months: 60% completed, the rest cancelled / expired / failed. Runner-assisted on a third.
    await ctx.db.execute(sql`
      WITH p AS (SELECT array_agg(id ORDER BY id) AS ids FROM organizations WHERE type = 'PROVIDER'),
           n AS (SELECT array_agg(id ORDER BY id) AS ids FROM organizations WHERE type = 'NGO')
      INSERT INTO rescues (listing_id, provider_org_id, ngo_org_id, accepted_by, status, servings_offered, collected_servings, delivered_servings,
                           provider_confirm_by, pickup_by, completed_at, closed_at, transport_mode, reserved_at)
      SELECT ${listing.id}::uuid, p.ids[1 + (g % 3)], n.ids[1 + ((g / 3) % 3)], ${any}::uuid,
             (CASE WHEN g % 10 < 6 THEN 'COMPLETED' WHEN g % 10 = 6 THEN 'CANCELLED' WHEN g % 10 = 7 THEN 'EXPIRED' WHEN g % 10 = 8 THEN 'PICKUP_FAILED' ELSE 'DELIVERY_FAILED' END)::rescue_status,
             50, 40, (g % 41),
             now(), now(),
             CASE WHEN g % 10 < 6 THEN timestamptz '2025-01-01' + make_interval(hours => (g * 37) % (24 * 600)) END,
             now(),
             (CASE WHEN g % 3 = 0 THEN 'RUNNER' ELSE 'NGO_PICKUP' END)::transport_mode,
             now()
        FROM generate_series(1, 4500) g, p, n`);
    // The non-completed rows must carry no delivered quantity that could leak into totals if status were ignored: they do (g % 41), on purpose.
    const ids = (await rows(ctx, sql`SELECT id, row_number() OVER (ORDER BY id) AS rn FROM rescues WHERE status = 'COMPLETED' AND transport_mode = 'RUNNER'`)) as { id: string }[];
    expect(ids.length).toBeGreaterThan(500);
    // Credit runners on the completed runner rescues; also leave a RELEASED assignment on some (must not be credited).
    for (const [i, r] of runners.entries()) {
      await ctx.db.execute(sql`
        INSERT INTO rescue_assignments (rescue_id, runner_user_id, status, ended_at)
        SELECT id, ${r.userId}::uuid, 'COMPLETED', now()
          FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM rescues WHERE status = 'COMPLETED' AND transport_mode = 'RUNNER') x
         WHERE x.rn % 3 = ${i}`);
    }
    await ctx.db.execute(sql`
      INSERT INTO rescue_assignments (rescue_id, runner_user_id, status, ended_at)
      SELECT id, ${runners[0]!.userId}::uuid, 'RELEASED', now() FROM rescues WHERE status = 'COMPLETED' AND transport_mode = 'RUNNER' LIMIT 200`);
    await ctx.db.execute(sql`ANALYZE rescues`);
    await ctx.db.execute(sql`ANALYZE rescue_assignments`);

    const admin = await signedInAgent(ctx, 'admin');
    const timed = async <T>(fn: () => Promise<T>) => {
      const t = Date.now();
      const out = await fn();
      return { out, ms: Date.now() - t };
    };

    // Platform, all time, vs. an independent query that shares no code with the service.
    const truth = (await rows(ctx, sql`SELECT count(*)::int AS n, sum(delivered_servings)::int AS s FROM rescues WHERE status = 'COMPLETED'`))[0] as { n: number; s: number };
    const all = await timed(() => admin.agent.get(PLATFORM));
    expect(all.out.body.data.metrics).toMatchObject({ completedRescues: truth.n, servingsDelivered: truth.s });
    expect(all.ms).toBeLessThan(1500);

    // Platform with a date range.
    const t2 = (await rows(ctx, sql`SELECT count(*)::int AS n, sum(delivered_servings)::int AS s FROM rescues WHERE status = 'COMPLETED' AND completed_at >= timestamptz '2025-06-01 00:00:00+00' AND completed_at < timestamptz '2025-09-01 00:00:00+00'`))[0] as { n: number; s: number };
    const ranged = await timed(() => admin.agent.get(`${PLATFORM}?from=2025-06-01&to=2025-08-31`));
    expect(ranged.out.body.data.metrics).toMatchObject({ completedRescues: t2.n, servingsDelivered: t2.s });
    expect(ranged.ms).toBeLessThan(1500);
    const monthSum = ranged.out.body.data.byMonth.reduce((a: number, m: { rescues: number }) => a + m.rescues, 0);
    expect(monthSum).toBe(t2.n);

    // One provider, one NGO.
    for (const [who, col, org] of [[providers[1]!, 'provider_org_id', providers[1]!.organizationId], [ngos[2]!, 'ngo_org_id', ngos[2]!.organizationId]] as const) {
      const tt = (await rows(ctx, sql`SELECT count(*)::int AS n, sum(delivered_servings)::int AS s FROM rescues WHERE status = 'COMPLETED' AND ${sql.raw(col)} = ${org}::uuid`))[0] as { n: number; s: number };
      const r = await timed(() => who.agent.get(ME));
      expect(r.out.body.data.metrics).toMatchObject({ completedRescues: tt.n, servingsDelivered: tt.s });
      expect(r.ms).toBeLessThan(1500);
    }

    // Runners: credited rows only (COMPLETED assignment on a COMPLETED runner rescue), counted once even with a RELEASED row beside it.
    let credited = 0;
    for (const r of runners) {
      const tt = (await rows(ctx, sql`
        SELECT count(DISTINCT x.id)::int AS n, coalesce(sum(x.delivered_servings), 0)::int AS s
          FROM rescues x WHERE x.status = 'COMPLETED' AND x.transport_mode = 'RUNNER'
           AND x.id IN (SELECT rescue_id FROM rescue_assignments WHERE runner_user_id = ${r.userId}::uuid AND status = 'COMPLETED')`))[0] as { n: number; s: number };
      const got = await timed(() => r.agent.get(ME));
      expect(got.out.body.data.metrics).toEqual({ completedRescues: tt.n, servingsDelivered: tt.s });
      expect(got.ms).toBeLessThan(1500);
      credited += tt.n;
    }
    expect(credited).toBe(ids.length); // every completed runner rescue credited to exactly one runner
    expect(all.out.body.data.metrics.runners).toBe(3);
    expect(all.out.body.data.metrics.byTransport.runnerAssisted.rescues).toBe(ids.length);

    // The supporting index is in place.
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'rescues_completed_at_idx'`)).toBe(1);
  }, 120_000);
});

// Referenced so a future helper change that drops these exports fails loudly here.
void ([resetData, setup] satisfies unknown[]);
export type { Ctx };
