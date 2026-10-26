import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, loadEscalationSettings } from '../src/config.js';
import { startEscalationWorker } from '../src/modules/escalation/service.js';
import { expireListings } from '../src/modules/listings/expiry.js';
import { WORKER_LOCKS, advisoryGuard } from '../src/ops/advisory-lock.js';
import { availableListing, createListing, matchedNgo, minutesFromNow, publishListing, resetData, setup, signedInAgent, verifiedAgent } from './helpers.js';
import { R, accept, count, rows, runnerAt } from './runner-helpers.js';

// The specification's example policy: T+3 / 15 / 25 / 35 / 45 minutes, 3 / 6 / 10 km, batch of 5.
const ctx = setup({ ESCALATION_WAVE1_MINUTES: '3' });
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const MIN = 60_000;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
type Step = { seq: number; kind: string; radius_km: number | null; due_at: string; status: string; executed_at: string | null; qualified: number | null; newly_eligible: number | null; notified_orgs: number | null; notified_users: number | null; reason: string | null };
const steps = async (listingId: string, round = 1) =>
  (await rows(ctx, sql`SELECT seq, kind, radius_km, due_at, status, executed_at, qualified, newly_eligible, notified_orgs, notified_users, reason FROM escalation_steps WHERE listing_id = ${listingId}::uuid AND round = ${round} ORDER BY seq`)) as unknown as Step[];
const dueOf = (s: Step) => new Date(s.due_at);
const notes = (type: string, listingId?: string) =>
  count(ctx, sql`SELECT count(*)::int AS n FROM notifications WHERE type = ${type} ${listingId ? sql`AND entity_id = ${listingId}::uuid` : sql``}`);
const toldNgos = async (listingId: string) =>
  ((await rows(ctx, sql`SELECT ngo_org_id FROM escalation_recipients WHERE listing_id = ${listingId}::uuid AND kind = 'NGO' ORDER BY created_at, position`)) as { ngo_org_id: string }[]).map((r) => r.ngo_org_id);
const run = (now: Date, listingId?: string) => ctx.escalation.runDue(now, listingId);
const deadlineOf = async (listingId: string) => new Date(((await rows(ctx, sql`SELECT pickup_deadline FROM food_listings WHERE id = ${listingId}::uuid`))[0] as { pickup_deadline: string }).pickup_deadline);
/** Database errors arrive wrapped by the driver; the original message is on `cause`. */
const dbError = (re: RegExp) => ({ cause: { message: expect.stringMatching(re) } });
const FAR = { serviceRadiusKm: 15 }; // an NGO's own radius must reach it as well as the wave

/** One provider with a published, transport-requiring listing, and NGOs at the given distances (metres). */
async function market(distances: number[] = [], listing: Record<string, unknown> = {}, requirement: Record<string, unknown> = FAR) {
  const provider = await verifiedAgent(ctx, 'provider');
  const ngos = [];
  for (const metersAway of distances) ngos.push(await matchedNgo(ctx, { metersAway, requirement }));
  const l = await availableListing(provider.agent, listing);
  return { provider, ngos, listing: l, published: new Date() };
}

describe('the persisted schedule', () => {
  it('is created at publish with the specification\'s timings and radii, and nobody is told before wave 1', async () => {
    const m = await market([2000]);
    const s = await steps(m.listing.id);
    expect(s.map((x) => [x.seq, x.kind, x.radius_km])).toEqual([
      [1, 'NGO_WAVE', 3],
      [2, 'NGO_WAVE', 6],
      [3, 'RUNNER_WAVE', 6],
      [4, 'NGO_WAVE', 10],
      [5, 'ADMIN_ALERT', null],
    ]);
    const offsets = s.map((x) => Math.round((dueOf(x).getTime() - m.published.getTime()) / MIN));
    expect(offsets).toEqual([3, 15, 25, 35, 45]);
    expect(s.every((x) => x.status === 'PENDING' && x.executed_at === null)).toBe(true);
    expect(await notes('LISTING_MATCH')).toBe(0); // the old behaviour told every eligible NGO right here
    expect((await m.ngos[0]!.agent.get('/api/v1/notifications')).body.data.notifications).toEqual([]);
  });

  it('is idempotent: publishing again, editing, or scheduling twice never adds steps', async () => {
    const m = await market([2000]);
    await ctx.escalation.schedule(m.listing.id, 'PUBLISHED');
    await ctx.escalation.schedule(m.listing.id, 'RELEASED'); // pending steps exist: nothing new
    await m.provider.agent.patch(`/api/v1/listings/${m.listing.id}`).send({ title: 'Edited title' }).expect(200);
    expect((await steps(m.listing.id)).length).toBe(5);
    expect((await publishListing(m.provider.agent, m.listing.id)).status).toBe(409); // already published
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM escalation_steps`)).toBe(5);
  });

  it('lets the worker backfill an open listing that has no schedule (inserted directly, or scheduling failed)', async () => {
    const m = await market([2000]);
    await ctx.db.execute(sql`TRUNCATE escalation_recipients, escalation_steps`); // as if it had never been scheduled
    expect(await steps(m.listing.id)).toEqual([]);
    const now = plus(m.published, 10 * MIN);
    await ctx.escalation.runDue(now);
    const s = await steps(m.listing.id);
    expect(s).toHaveLength(5);
    expect(Math.round((dueOf(s[0]!).getTime() - now.getTime()) / MIN)).toBe(3); // timed from this pass
    await ctx.escalation.runDue(now);
    expect(await steps(m.listing.id)).toHaveLength(5); // and only once
    // A listing that is not open is never given a schedule.
    await m.provider.agent.post(`/api/v1/listings/${m.listing.id}/cancel`).send({ reason: 'Kitchen closed early' }).expect(200);
    await ctx.db.execute(sql`TRUNCATE escalation_recipients, escalation_steps`);
    await ctx.escalation.runDue(now);
    expect(await steps(m.listing.id)).toEqual([]);
  });

  it('does not schedule drafts, and schedules only once a draft is published', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const draft = await createListing(provider.agent);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM escalation_steps`)).toBe(0);
    await publishListing(provider.agent, draft.id).then((r) => expect(r.status).toBe(200));
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM escalation_steps WHERE listing_id = ${draft.id}::uuid`)).toBe(5);
  });
});

describe('every wave boundary', () => {
  it('runs each step exactly at its time (inclusive) and not one millisecond earlier, in order, once', async () => {
    const m = await market([2000, 4500, 8000]);
    const s = await steps(m.listing.id);
    const expected: Record<number, string[]> = {};
    for (const step of s) {
      const before = plus(dueOf(step), -1);
      const early = await run(before, m.listing.id);
      expect(early.executed.map((e) => e.seq), `before step ${step.seq}`).not.toContain(step.seq);
      const onTime = await run(dueOf(step), m.listing.id);
      expect(onTime.executed.map((e) => e.seq), `at step ${step.seq}`).toEqual([step.seq]);
      expect((await run(dueOf(step), m.listing.id)).executed).toEqual([]); // a repeat finds nothing
      expected[step.seq] = (await steps(m.listing.id)).filter((x) => x.status !== 'PENDING').map((x) => `${x.seq}:${x.status}`);
    }
    expect(expected[5]).toEqual(['1:DONE', '2:DONE', '3:DONE', '4:DONE', '5:DONE']);
    const done = await steps(m.listing.id);
    expect(done.every((x) => x.executed_at !== null)).toBe(true);
  });

  it('catches up in order when a worker was late (several steps due at once)', async () => {
    const m = await market([2000, 4500]);
    const r = await run(plus(m.published, 40 * MIN), m.listing.id);
    expect(r.executed.map((e) => e.seq)).toEqual([1, 2, 3, 4]); // admin alert (45 min) is not due yet
    expect((await steps(m.listing.id)).map((x) => x.status)).toEqual(['DONE', 'DONE', 'DONE', 'DONE', 'PENDING']);
  });
});

describe('radius expansion and who is told', () => {
  it('tells only the NGOs inside each wave\'s radius, each organization once, and never anyone outside the platform radius', async () => {
    const m = await market([2000, 4500, 8000, 11000]);
    const [a, b, c, d] = m.ngos;
    await run(plus(m.published, 3 * MIN), m.listing.id);
    expect(await toldNgos(m.listing.id)).toEqual([a!.organizationId]);
    await run(plus(m.published, 15 * MIN), m.listing.id);
    expect(await toldNgos(m.listing.id)).toEqual([a!.organizationId, b!.organizationId]);
    await run(plus(m.published, 35 * MIN), m.listing.id);
    expect(await toldNgos(m.listing.id)).toEqual([a!.organizationId, b!.organizationId, c!.organizationId]);
    expect(await toldNgos(m.listing.id)).not.toContain(d!.organizationId);

    const s = await steps(m.listing.id);
    expect(s[0]).toMatchObject({ status: 'DONE', qualified: 1, newly_eligible: 1, notified_orgs: 1, notified_users: 1, reason: null });
    expect(s[1]).toMatchObject({ status: 'DONE', qualified: 2, newly_eligible: 1, notified_orgs: 1, notified_users: 1 }); // A is not told again
    expect(s[3]).toMatchObject({ status: 'DONE', qualified: 3, newly_eligible: 1, notified_orgs: 1, notified_users: 1 });
    for (const n of [a, b, c]) expect((await n!.agent.get('/api/v1/notifications')).body.data.notifications.filter((x: { type: string }) => x.type === 'LISTING_MATCH')).toHaveLength(1);
    expect((await d!.agent.get('/api/v1/notifications')).body.data.notifications).toEqual([]);
  });

  it('orders each wave by the deterministic match score and respects the batch size', async () => {
    const batch = setup({ ESCALATION_WAVE1_MINUTES: '3', ESCALATION_BATCH_SIZE: '2' });
    try {
      await resetData(batch.db);
      const provider = await verifiedAgent(batch, 'provider');
      for (const metersAway of [900, 1400, 1900, 2300, 2700]) await matchedNgo(batch, { metersAway, requirement: { ...FAR, neededServings: 10 + metersAway / 100 } });
      const l = await availableListing(provider.agent);
      const published = new Date();
      const ranked = (await batch.db.execute(sql`SELECT ngo_org_id FROM match_candidates WHERE listing_id = ${l.id}::uuid AND eligible ORDER BY rank`)).rows.map((r) => (r as { ngo_org_id: string }).ngo_org_id);
      expect(ranked).toHaveLength(5);

      await batch.escalation.runDue(plus(published, 3 * MIN), l.id);
      const told = async () => ((await batch.db.execute(sql`SELECT ngo_org_id FROM escalation_recipients WHERE listing_id = ${l.id}::uuid ORDER BY created_at, position`)).rows as { ngo_org_id: string }[]).map((r) => r.ngo_org_id);
      expect(await told()).toEqual(ranked.slice(0, 2)); // the two best, best first
      const w1 = (await batch.db.execute(sql`SELECT position FROM escalation_recipients WHERE listing_id = ${l.id}::uuid ORDER BY position`)).rows as { position: number }[];
      expect(w1.map((x) => x.position)).toEqual([1, 2]);
      const s1 = (await batch.db.execute(sql`SELECT qualified, newly_eligible, notified_orgs FROM escalation_steps WHERE listing_id = ${l.id}::uuid AND seq = 1`)).rows[0];
      expect(s1).toMatchObject({ qualified: 5, newly_eligible: 5, notified_orgs: 2 }); // all five qualify; only two fit the batch

      await batch.escalation.runDue(plus(published, 15 * MIN), l.id);
      expect(await told()).toEqual(ranked.slice(0, 4)); // the next two, still in score order
      await batch.escalation.runDue(plus(published, 35 * MIN), l.id);
      expect(await told()).toEqual(ranked); // the last one in the final wave
    } finally {
      await batch.pool.end();
    }
  });

  it('records waves that qualify nobody, and still sends the final alert', async () => {
    const m = await market([]);
    const r = await run(plus(m.published, 46 * MIN), m.listing.id);
    expect(r.executed.map((e) => [e.seq, e.status])).toEqual([[1, 'DONE'], [2, 'DONE'], [3, 'DONE'], [4, 'DONE'], [5, 'DONE']]);
    const s = await steps(m.listing.id);
    expect(s[0]).toMatchObject({ qualified: 0, newly_eligible: 0, notified_orgs: 0, notified_users: 0, reason: 'NO_QUALIFYING_NGO' });
    expect(s[2]).toMatchObject({ reason: 'NO_QUALIFYING_RUNNER' });
    expect(await notes('LISTING_MATCH')).toBe(0);
  });

  it('does not tell the same NGO again when later waves find it again, and reports "no new" honestly', async () => {
    const m = await market([2000]);
    await run(plus(m.published, 3 * MIN), m.listing.id);
    await run(plus(m.published, 35 * MIN), m.listing.id);
    const s = await steps(m.listing.id);
    expect(s[1]).toMatchObject({ qualified: 1, newly_eligible: 0, notified_orgs: 0, reason: 'NO_NEW_NGO' });
    expect(await notes('LISTING_MATCH', m.listing.id)).toBe(1);
  });
});

describe('eligibility is re-checked when each wave runs', () => {
  it('skips an NGO that paused intake, was unverified, lost capacity or moved away since the listing opened', async () => {
    const m = await market([1000, 1500, 2000, 2500, 2800]);
    const [paused, unverified, smallCapacity, moved, fine] = m.ngos;
    await paused!.agent.post('/api/v1/ngo-requirements/current/pause').expect(200);
    await ctx.db.execute(sql`UPDATE organizations SET verification_status = 'REJECTED' WHERE id = ${unverified!.organizationId}::uuid`);
    await ctx.db.execute(sql`UPDATE ngo_requirements SET needed_servings = 1, capacity_servings = 5 WHERE ngo_org_id = ${smallCapacity!.organizationId}::uuid`);
    await ctx.db.execute(sql`UPDATE organizations SET latitude = 19.5, longitude = 74.5 WHERE id = ${moved!.organizationId}::uuid`); // far outside every radius
    const r = await run(plus(m.published, 3 * MIN), m.listing.id);
    expect(r.executed[0]).toMatchObject({ seq: 1, qualified: 1, notifiedOrgs: 1 });
    expect(await toldNgos(m.listing.id)).toEqual([fine!.organizationId]);
  });

  it('tells an NGO that became eligible after the listing opened in the next wave that reaches it', async () => {
    const m = await market([2000]);
    await run(plus(m.published, 3 * MIN), m.listing.id);
    const late = await matchedNgo(ctx, { metersAway: 1000, requirement: FAR }); // eligible only now
    expect((await late.agent.get('/api/v1/notifications')).body.data.notifications).toEqual([]);
    await run(plus(m.published, 15 * MIN), m.listing.id);
    expect(await toldNgos(m.listing.id)).toContain(late.organizationId);
    expect(await notes('LISTING_MATCH', m.listing.id)).toBe(2);
  });

  it('does not treat stale candidate rows as eligible: a candidate that lost eligibility is dropped even though its row said eligible', async () => {
    const m = await market([2000]);
    // Make the stored row look eligible and then break the NGO without telling matching: the wave must recompute.
    await ctx.db.execute(sql`UPDATE ngo_requirements SET available_to = now() - interval '1 hour', available_from = now() - interval '2 hours' WHERE ngo_org_id = ${m.ngos[0]!.organizationId}::uuid`);
    await ctx.db.execute(sql`UPDATE match_candidates SET eligible = true, rank = 1 WHERE listing_id = ${m.listing.id}::uuid`);
    const r = await run(plus(m.published, 3 * MIN), m.listing.id);
    expect(r.executed[0]).toMatchObject({ qualified: 0, notifiedOrgs: 0 });
    expect(await toldNgos(m.listing.id)).toEqual([]);
  });

  it('excludes NGOs that cannot reach the pickup in time (time feasibility near the deadline)', async () => {
    // 45 minutes left: an NGO 9 km away needs about 30 min travel plus the dispatch buffer, so it cannot make it.
    const m = await market([2000, 9000], { pickupStart: minutesFromNow(1), pickupDeadline: minutesFromNow(45) });
    const [near, far] = m.ngos;
    const sched = await steps(m.listing.id);
    await run(plus(dueOf(sched[3]!), 0), m.listing.id);
    expect(await toldNgos(m.listing.id)).toContain(near!.organizationId);
    expect(await toldNgos(m.listing.id)).not.toContain(far!.organizationId);
  });
});

describe('near-deadline behaviour', () => {
  it('compresses the schedule for URGENT listings (under 60 minutes left)', async () => {
    const m = await market([2000], { pickupStart: minutesFromNow(1), pickupDeadline: minutesFromNow(50) });
    const offsets = (await steps(m.listing.id)).map((x) => Math.round(((dueOf(x).getTime() - m.published.getTime()) / MIN) * 10) / 10);
    expect(offsets).toEqual([1.5, 7.5, 12.5, 17.5, 22.5]); // half of 3 / 15 / 25 / 35 / 45
  });

  it('escalates a CRITICAL listing (under 30 minutes left) immediately, all the way to the admin alert', async () => {
    await signedInAgent(ctx, 'admin');
    // 500 m away: close enough to reach the pickup inside 25 minutes (travel plus the dispatch buffer).
    const m = await market([500], { pickupStart: minutesFromNow(1), pickupDeadline: minutesFromNow(25) });
    const s = await steps(m.listing.id);
    expect(s.every((x) => x.status === 'DONE')).toBe(true); // everything already ran at publish
    expect(await toldNgos(m.listing.id)).toEqual([m.ngos[0]!.organizationId]);
    expect(await notes('ESCALATION_ADMIN', m.listing.id)).toBe(1);
  });

  it('never schedules a step later than the deadline margin before pickup closes', async () => {
    // A 90-minute listing is not urgent, so nothing is compressed; a 120-minute final stage would fall after the deadline.
    const cfg = setup({ ESCALATION_WAVE1_MINUTES: '3', ESCALATION_ADMIN_MINUTES: '120' });
    try {
      await resetData(cfg.db);
      const p = await verifiedAgent(cfg, 'provider');
      const l = await availableListing(p.agent, { pickupStart: minutesFromNow(1), pickupDeadline: minutesFromNow(90) });
      const deadline = new Date(((await cfg.db.execute(sql`SELECT pickup_deadline FROM food_listings WHERE id = ${l.id}::uuid`)).rows[0] as { pickup_deadline: string }).pickup_deadline).getTime();
      const dues = ((await cfg.db.execute(sql`SELECT due_at FROM escalation_steps WHERE listing_id = ${l.id}::uuid ORDER BY seq`)).rows as { due_at: string }[]).map((r) => new Date(r.due_at).getTime());
      expect(deadline - dues[4]!).toBe(5 * MIN); // the final stage is clamped to exactly the margin before the deadline
      expect(dues.every((d) => deadline - d >= 5 * MIN)).toBe(true); // and no step is later than that
      expect(dues).toEqual([...dues].sort((x, y) => x - y)); // the order is preserved
    } finally {
      await cfg.pool.end();
    }
  });

  it('cancels a step that comes due after the pickup deadline and notifies no one', async () => {
    const m = await market([2000]);
    const deadline = await deadlineOf(m.listing.id);
    const r = await run(plus(deadline, 1000), m.listing.id);
    expect(r.executed).toEqual([expect.objectContaining({ seq: 1, status: 'CANCELLED', reason: 'DEADLINE_PASSED' })]);
    expect((await steps(m.listing.id)).every((x) => x.status === 'CANCELLED')).toBe(true);
    expect(await notes('LISTING_MATCH')).toBe(0);
  });
});

describe('stopping the schedule', () => {
  it('cancels every pending step the moment an NGO accepts, and later runs do nothing', async () => {
    const m = await market([2000, 4500]);
    await run(plus(m.published, 3 * MIN), m.listing.id);
    await accept(m.ngos[0]!.agent, m.listing.id).expect(201);
    expect((await steps(m.listing.id)).map((x) => [x.status, x.reason])).toEqual([['DONE', null], ['CANCELLED', 'LISTING_ACCEPTED'], ['CANCELLED', 'LISTING_ACCEPTED'], ['CANCELLED', 'LISTING_ACCEPTED'], ['CANCELLED', 'LISTING_ACCEPTED']]);
    const before = await notes('LISTING_MATCH');
    expect((await run(plus(m.published, 60 * MIN), m.listing.id)).executed).toEqual([]);
    expect(await notes('LISTING_MATCH')).toBe(before);
    expect(await notes('ESCALATION_ADMIN')).toBe(0);
  });

  it('keeps the accept race protection: of many NGOs accepting at once exactly one wins, and the schedule is cancelled once', async () => {
    const m = await market([1000, 1200, 1400, 1600, 1800]);
    const results = await Promise.all(m.ngos.map((n) => accept(n.agent, m.listing.id).then((r) => r.status)));
    expect(results.filter((s) => s === 201)).toHaveLength(1);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM rescues WHERE listing_id = ${m.listing.id}::uuid`)).toBe(1);
    expect((await steps(m.listing.id)).every((x) => x.status === 'CANCELLED' && x.reason === 'LISTING_ACCEPTED')).toBe(true);
  });

  it('cancels the schedule when the provider cancels the listing, and when the listing expires', async () => {
    const m = await market([2000]);
    await m.provider.agent.post(`/api/v1/listings/${m.listing.id}/cancel`).send({ reason: 'Kitchen closed early' }).expect(200);
    expect((await steps(m.listing.id)).every((x) => x.status === 'CANCELLED' && x.reason === 'LISTING_CANCELLED')).toBe(true);

    const e = await market([2000]);
    await ctx.db.execute(sql`UPDATE food_listings SET prepared_at = now() - interval '6 hours', pickup_start = now() - interval '4 hours', pickup_deadline = now() - interval '1 minute' WHERE id = ${e.listing.id}::uuid`);
    await expireListings(ctx.runtime.db);
    expect((await steps(e.listing.id)).every((x) => x.status === 'CANCELLED' && x.reason === 'LISTING_EXPIRED')).toBe(true);
    expect((await run(plus(e.published, 60 * MIN), e.listing.id)).executed).toEqual([]);
    expect(await notes('LISTING_MATCH')).toBe(0);
  });

  it('defends in depth: even with the cancel trigger off, the executor never notifies a listing that is not open', async () => {
    const m = await market([2000]);
    await ctx.db.execute(sql`ALTER TABLE food_listings DISABLE TRIGGER food_listings_cancel_escalation`);
    try {
      await ctx.db.execute(sql`UPDATE food_listings SET status = 'RESERVED' WHERE id = ${m.listing.id}::uuid`);
      expect((await steps(m.listing.id)).every((x) => x.status === 'PENDING')).toBe(true); // the trigger really was off
      const r = await run(plus(m.published, 3 * MIN), m.listing.id);
      expect(r.executed).toEqual([expect.objectContaining({ status: 'CANCELLED', reason: 'LISTING_NOT_AVAILABLE' })]);
    } finally {
      await ctx.db.execute(sql`ALTER TABLE food_listings ENABLE TRIGGER food_listings_cancel_escalation`);
    }
    expect(await notes('LISTING_MATCH')).toBe(0);
  });

  it('starts a fresh round when a failed rescue releases the listing, without re-telling anyone', async () => {
    const m = await market([2000, 4500]);
    await run(plus(m.published, 3 * MIN), m.listing.id);
    const rescue = await accept(m.ngos[0]!.agent, m.listing.id).expect(201);
    await m.ngos[0]!.agent.post(`${R(rescue.body.data.rescue.id)}/cancel`).send({ reason: 'We cannot collect it today' }).expect(200);
    const round2 = await steps(m.listing.id, 2);
    expect(round2).toHaveLength(5);
    expect(round2.every((x) => x.status === 'PENDING')).toBe(true);
    expect((await steps(m.listing.id, 1)).map((x) => x.status)).toEqual(['DONE', 'CANCELLED', 'CANCELLED', 'CANCELLED', 'CANCELLED']);
    const later = plus(new Date(), 20 * MIN);
    await run(later, m.listing.id);
    // The NGO that cancelled is not offered the listing again; the other one is told once.
    expect(await toldNgos(m.listing.id)).toEqual([m.ngos[0]!.organizationId, m.ngos[1]!.organizationId]);
    expect(await notes('LISTING_MATCH', m.listing.id)).toBe(2);
  });
});

describe('overlapping and repeated runs', () => {
  it('executes a step exactly once when many runs race for it', async () => {
    const m = await market([2000, 4500]);
    const at = plus(m.published, 3 * MIN);
    const results = await Promise.all(Array.from({ length: 8 }, () => ctx.escalation.executeNext(m.listing.id, at)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await toldNgos(m.listing.id)).toHaveLength(1);
    expect(await notes('LISTING_MATCH')).toBe(1);
    expect((await steps(m.listing.id))[0]).toMatchObject({ status: 'DONE', notified_users: 1 });
  });

  it('never duplicates notifications or recipients across concurrent full runs of the whole schedule', async () => {
    await signedInAgent(ctx, 'admin');
    await signedInAgent(ctx, 'admin');
    const m = await market([2000, 4500, 8000]);
    const at = plus(m.published, 50 * MIN);
    await Promise.all(Array.from({ length: 6 }, () => ctx.escalation.runDue(at)));
    await ctx.escalation.runDue(at);
    expect((await steps(m.listing.id)).every((x) => x.status === 'DONE')).toBe(true);
    expect(await toldNgos(m.listing.id)).toHaveLength(3);
    expect(await notes('LISTING_MATCH')).toBe(3);
    expect(await notes('ESCALATION_ADMIN')).toBe(2); // two admins, one alert each
    const dup = (await rows(ctx, sql`SELECT count(*)::int AS n FROM (SELECT dedupe_key FROM notifications GROUP BY dedupe_key HAVING count(*) > 1) t`))[0] as { n: number };
    expect(dup.n).toBe(0);
  });

  it('lets only one worker run a pass at a time (advisory lock), and releases it afterwards', async () => {
    const guard = advisoryGuard(ctx.runtime.pool, WORKER_LOCKS.escalation);
    const other = advisoryGuard(ctx.runtime.pool, WORKER_LOCKS.escalation);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const first = guard(async () => {
      started();
      await hold;
    });
    await running;
    let ran = false;
    expect(await other(async () => { ran = true; })).toBe(false);
    expect(ran).toBe(false);
    release();
    await first;
    expect(await other(async () => { ran = true; })).toBe(true);
  });

  it('refuses duplicates at the database level', async () => {
    const m = await market([2000]);
    await run(plus(m.published, 3 * MIN), m.listing.id);
    const stepId = ((await rows(ctx, sql`SELECT id FROM escalation_steps WHERE listing_id = ${m.listing.id}::uuid AND seq = 1`))[0] as { id: string }).id;
    await expect(ctx.db.execute(sql`INSERT INTO escalation_recipients (listing_id, step_id, kind, ngo_org_id, position) VALUES (${m.listing.id}::uuid, ${stepId}::uuid, 'NGO', ${m.ngos[0]!.organizationId}::uuid, 9)`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`INSERT INTO escalation_steps (listing_id, round, seq, kind, due_at) VALUES (${m.listing.id}::uuid, 1, 1, 'NGO_WAVE', now())`)).rejects.toThrow();
    // A finished step cannot be edited or re-run; recipients are insert-only; nothing can be deleted.
    await expect(ctx.db.execute(sql`UPDATE escalation_steps SET status = 'PENDING' WHERE id = ${stepId}::uuid`)).rejects.toMatchObject(dbError(/finished/));
    await expect(ctx.db.execute(sql`UPDATE escalation_recipients SET position = 2 WHERE step_id = ${stepId}::uuid`)).rejects.toMatchObject(dbError(/append-only/));
    await expect(ctx.db.execute(sql`DELETE FROM escalation_recipients WHERE step_id = ${stepId}::uuid`)).rejects.toMatchObject(dbError(/append-only/));
    await expect(ctx.db.execute(sql`DELETE FROM escalation_steps WHERE id = ${stepId}::uuid`)).rejects.toMatchObject(dbError(/cannot be deleted/));
    // The runtime role cannot rewrite this history either.
    for (const t of ['escalation_steps', 'escalation_recipients']) await expect(ctx.runtime.pool.query(`DELETE FROM ${t}`)).rejects.toMatchObject({ code: '42501' });
    await expect(ctx.runtime.pool.query('UPDATE escalation_recipients SET position = 1')).rejects.toMatchObject({ code: '42501' });
    await expect(ctx.runtime.pool.query("UPDATE escalation_steps SET due_at = now()")).rejects.toMatchObject({ code: '42501' });
  });

  it('the worker loop runs due steps, logs a scrubbed failure, and is disabled by a zero interval', async () => {
    const lines: string[] = [];
    let calls = 0;
    const stop = startEscalationWorker({ runDue: async () => { calls += 1; return { executed: [{ seq: 1 } as never] }; } }, 3600, (l) => lines.push(l));
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(calls).toBe(1);
    expect(lines.join('')).toContain('Escalation steps run');
    const bad: string[] = [];
    const stop2 = startEscalationWorker({ runDue: async () => { throw new Error('Failed query: UPDATE x\nparams: priya@example.test'); } }, 3600, (l) => bad.push(l));
    await new Promise((r) => setTimeout(r, 50));
    stop2();
    expect(bad.join('')).toContain('Escalation run failed');
    expect(bad.join('')).not.toMatch(/priya|UPDATE x/);
    expect(startEscalationWorker({ runDue: async () => ({ executed: [] }) }, 0)()).toBeUndefined();
  });
});

describe('the runner wave', () => {
  it('alerts only eligible, available runners (nearest first, once), for listings that need transport', async () => {
    const m = await market([2000]);
    const eligible = await runnerAt(ctx, { metersAway: 1500 });
    const eligibleFar = await runnerAt(ctx, { metersAway: 5000 });
    const offline = await runnerAt(ctx, { availability: 'OFFLINE' });
    const tiny = await runnerAt(ctx, { capacityKg: 2 }); // listing weighs 18 kg
    const shortRadius = await runnerAt(ctx, { metersAway: 3000, radiusKm: 1 });
    const incomplete = await runnerAt(ctx, { vehicle: null });
    const outside = await runnerAt(ctx, { metersAway: 8000, radiusKm: 15 }); // beyond the 6 km runner-wave radius
    const busy = await runnerAt(ctx, { metersAway: 1200 });
    const other = await assignedElsewhere(busy.userId);
    expect(other).toBeTruthy();

    const r = await run(plus(m.published, 25 * MIN), m.listing.id);
    expect(r.executed.at(-1)).toMatchObject({ seq: 3, kind: 'RUNNER_WAVE', status: 'DONE', qualified: 2, newlyEligible: 2, notifiedUsers: 2 });
    const told = ((await rows(ctx, sql`SELECT runner_user_id FROM escalation_recipients WHERE kind = 'RUNNER' ORDER BY position`)) as { runner_user_id: string }[]).map((x) => x.runner_user_id);
    expect(told).toEqual([eligible.userId, eligibleFar.userId]); // nearest first
    for (const bad of [offline, tiny, shortRadius, incomplete, outside, busy]) {
      expect((await bad.agent.get('/api/v1/notifications')).body.data.notifications.filter((n: { type: string }) => n.type === 'LISTING_RUNNER_ALERT'), bad.email).toEqual([]);
    }
    const mine = (await eligible.agent.get('/api/v1/notifications')).body.data.notifications.filter((n: { type: string }) => n.type === 'LISTING_RUNNER_ALERT');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ entityType: 'listing', entityId: m.listing.id, actionable: true });
    expect(JSON.stringify(mine)).not.toMatch(/Secret Lane|Block C|18\.52043|73\.85674|@example\.test|\+91/);
    expect((await run(plus(m.published, 26 * MIN), m.listing.id)).executed).toEqual([]);
    expect(await notes('LISTING_RUNNER_ALERT')).toBe(2);
  });

  it('respects the runner batch size', async () => {
    const cfg = setup({ ESCALATION_WAVE1_MINUTES: '3', ESCALATION_RUNNER_BATCH_SIZE: '2' });
    try {
      await resetData(cfg.db);
      const p = await verifiedAgent(cfg, 'provider');
      const runners = [await runnerAt(cfg, { metersAway: 900 }), await runnerAt(cfg, { metersAway: 1200 }), await runnerAt(cfg, { metersAway: 1500 })];
      const l = await availableListing(p.agent);
      await cfg.escalation.runDue(new Date(Date.now() + 30 * MIN), l.id);
      const told = ((await cfg.db.execute(sql`SELECT runner_user_id FROM escalation_recipients WHERE kind = 'RUNNER' ORDER BY position`)).rows as { runner_user_id: string }[]).map((x) => x.runner_user_id);
      expect(told).toEqual([runners[0]!.userId, runners[1]!.userId]);
    } finally {
      await cfg.pool.end();
    }
  });

  it('is skipped (and says why) for a listing that needs no transport', async () => {
    const m = await market([2000], { transportRequired: false });
    await runnerAt(ctx, { metersAway: 1000 });
    await run(plus(m.published, 25 * MIN), m.listing.id);
    expect((await steps(m.listing.id))[2]).toMatchObject({ kind: 'RUNNER_WAVE', status: 'SKIPPED', reason: 'NO_TRANSPORT_NEEDED' });
    expect(await notes('LISTING_RUNNER_ALERT')).toBe(0);
  });
});

async function assignedElsewhere(runnerUserId: string) {
  // A runner already holding another rescue is busy: put one in the database directly.
  const p = await verifiedAgent(ctx, 'provider');
  const n = await matchedNgo(ctx, { metersAway: 3500 });
  const l = await availableListing(p.agent, { title: 'Another job' });
  const acc = await accept(n.agent, l.id, { transportMode: 'RUNNER' });
  const id = acc.body.data.rescue.id as string;
  await ctx.db.execute(sql`INSERT INTO rescue_assignments (rescue_id, runner_user_id, status) VALUES (${id}::uuid, ${runnerUserId}::uuid, 'ACTIVE')`);
  return id;
}

describe('the final admin alert', () => {
  it('notifies every active admin once, with counts only, at the configured final stage', async () => {
    const a1 = await signedInAgent(ctx, 'admin');
    const a2 = await signedInAgent(ctx, 'admin');
    const m = await market([2000, 4500]);
    await run(plus(m.published, 44 * MIN), m.listing.id);
    expect(await notes('ESCALATION_ADMIN')).toBe(0); // not before the final stage
    await run(plus(m.published, 45 * MIN), m.listing.id);
    for (const a of [a1, a2]) {
      const n = (await a.agent.get('/api/v1/notifications')).body.data.notifications.filter((x: { type: string }) => x.type === 'ESCALATION_ADMIN');
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ entityType: 'listing', entityId: m.listing.id, actionable: true });
      expect(n[0].body).toMatch(/2 NGO organization\(s\) and 0 runner\(s\) have been told/);
      expect(JSON.stringify(n)).not.toMatch(/Secret Lane|Block C|18\.52043|@example\.test|\+91/);
    }
    // Repeating the stage, or running it concurrently, never alerts again.
    await Promise.all([run(plus(m.published, 46 * MIN), m.listing.id), run(plus(m.published, 47 * MIN), m.listing.id)]);
    expect(await notes('ESCALATION_ADMIN')).toBe(2);
    expect((await steps(m.listing.id))[4]).toMatchObject({ status: 'DONE', notified_users: 2 });
    // The provider and NGOs never see the admin alert.
    expect((await m.provider.agent.get('/api/v1/notifications')).body.data.notifications.filter((x: { type: string }) => x.type === 'ESCALATION_ADMIN')).toEqual([]);
  });

  it('becomes non-actionable once the listing is accepted, and is never sent if it was accepted first', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const m = await market([2000]);
    await run(plus(m.published, 45 * MIN), m.listing.id);
    await accept(m.ngos[0]!.agent, m.listing.id).expect(201);
    const n = (await admin.agent.get('/api/v1/notifications')).body.data.notifications.find((x: { type: string }) => x.type === 'ESCALATION_ADMIN');
    expect(n).toMatchObject({ actionable: false });
    const early = await market([2000]);
    await accept(early.ngos[0]!.agent, early.listing.id).expect(201);
    await run(plus(early.published, 60 * MIN), early.listing.id);
    expect(await notes('ESCALATION_ADMIN', early.listing.id)).toBe(0);
  });

  it('follows a configurable final stage', async () => {
    const cfg = setup({ ESCALATION_WAVE1_MINUTES: '0', ESCALATION_WAVE2_MINUTES: '1', ESCALATION_RUNNER_MINUTES: '2', ESCALATION_WAVE3_MINUTES: '3', ESCALATION_ADMIN_MINUTES: '4' });
    try {
      await resetData(cfg.db);
      await signedInAgent(cfg, 'admin');
      const p = await verifiedAgent(cfg, 'provider');
      const l = await availableListing(p.agent);
      const due = (await cfg.db.execute(sql`SELECT due_at FROM escalation_steps WHERE listing_id = ${l.id}::uuid AND seq = 5`)).rows[0] as { due_at: string };
      expect(Math.round((new Date(due.due_at).getTime() - Date.now()) / MIN)).toBe(4);
    } finally {
      await cfg.pool.end();
    }
  });
});

describe('FL-018: nobody accepts in the first wave', () => {
  it('runs the next wave once, never twice, and alerts the admin at the final stage', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const m = await market([2000, 5000, 9000]);
    const [near, mid, far] = m.ngos;
    const every = async (offsetMin: number) => {
      await Promise.all([run(plus(m.published, offsetMin * MIN), m.listing.id), run(plus(m.published, offsetMin * MIN), m.listing.id)]);
    };
    await every(3);
    expect(await toldNgos(m.listing.id)).toEqual([near!.organizationId]); // wave 1: only inside 3 km
    await every(10); // nothing new is due between the waves
    expect(await toldNgos(m.listing.id)).toHaveLength(1);
    await every(15); // nobody accepted: wave 2 (6 km) runs, once
    expect(await toldNgos(m.listing.id)).toEqual([near!.organizationId, mid!.organizationId]);
    await every(35);
    expect(await toldNgos(m.listing.id)).toEqual([near!.organizationId, mid!.organizationId, far!.organizationId]);
    expect(await notes('ESCALATION_ADMIN')).toBe(0);
    await every(45);
    expect(await notes('ESCALATION_ADMIN')).toBe(1);
    expect((await admin.agent.get('/api/v1/notifications')).body.data.notifications.filter((x: { type: string }) => x.type === 'ESCALATION_ADMIN')).toHaveLength(1);
    expect(await notes('LISTING_MATCH')).toBe(3); // one per NGO, no duplicates from the repeats
    expect((await steps(m.listing.id)).every((x) => x.status === 'DONE')).toBe(true);
    // The listing is still open and unaccepted until its deadline: no rescue exists.
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM rescues`)).toBe(0);
  });
});

describe('configuration', () => {
  it('defaults to the specification\'s example policy', () => {
    const s = loadEscalationSettings({});
    expect(s.enabled).toBe(true);
    expect(s.steps.map((x) => [x.kind, x.offsetMinutes, x.radiusKm])).toEqual([['NGO_WAVE', 3, 3], ['NGO_WAVE', 15, 6], ['RUNNER_WAVE', 25, 6], ['NGO_WAVE', 35, 10], ['ADMIN_ALERT', 45, null]]);
    expect([s.batchSize, s.runnerBatchSize, s.urgentScale, s.criticalScale, s.deadlineMarginMinutes, s.intervalSeconds]).toEqual([5, 10, 0.5, 0, 5, 30]);
  });

  it('reads every value from the environment, including fractions of a minute (demo mode)', () => {
    const s = loadEscalationSettings({ ESCALATION_WAVE1_MINUTES: '0.5', ESCALATION_WAVE2_MINUTES: '1', ESCALATION_RUNNER_MINUTES: '1.5', ESCALATION_WAVE3_MINUTES: '2', ESCALATION_ADMIN_MINUTES: '2.5', ESCALATION_BATCH_SIZE: '3', ESCALATION_INTERVAL_SECONDS: '5', ESCALATION_WAVE2_RADIUS_KM: '7.5' });
    expect(s.steps.map((x) => x.offsetMinutes)).toEqual([0.5, 1, 1.5, 2, 2.5]);
    expect(s.steps[1]!.radiusKm).toBe(7.5);
    expect([s.batchSize, s.intervalSeconds]).toEqual([3, 5]);
  });

  it('rejects nonsense at startup with a clear message', () => {
    expect(() => loadEscalationSettings({ ESCALATION_WAVE2_MINUTES: '2' })).toThrow(/step times must not decrease/);
    expect(() => loadEscalationSettings({ ESCALATION_ADMIN_MINUTES: '30' })).toThrow(/must not decrease/);
    expect(() => loadEscalationSettings({ ESCALATION_WAVE2_RADIUS_KM: '2' })).toThrow(/radii must not shrink/);
    expect(() => loadEscalationSettings({ ESCALATION_WAVE3_RADIUS_KM: '5' })).toThrow(/radii must not shrink/);
    for (const bad of [{ ESCALATION_BATCH_SIZE: '0' }, { ESCALATION_BATCH_SIZE: '2.5' }, { ESCALATION_BATCH_SIZE: '101' }, { ESCALATION_WAVE1_MINUTES: '-1' }, { ESCALATION_WAVE1_RADIUS_KM: '0' }, { ESCALATION_URGENT_SCALE: '1.5' }, { ESCALATION_INTERVAL_SECONDS: '-5' }, { ESCALATION_INTERVAL_SECONDS: 'fast' }, { ESCALATION_ENABLED: 'maybe' }]) {
      expect(() => loadEscalationSettings(bad), JSON.stringify(bad)).toThrow(/escalation configuration/i);
    }
    expect(() => loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://a:b@h/db', JWT_ACCESS_SECRET: 'x'.repeat(40), ESCALATION_WAVE2_MINUTES: '1' })).toThrow(/escalation/i);
  });

  it('caps a wave at the platform search radius and records the radius actually used', async () => {
    const cfg = setup({ ESCALATION_WAVE1_MINUTES: '3', MATCH_SEARCH_RADIUS_KM: '5' });
    try {
      await resetData(cfg.db);
      const p = await verifiedAgent(cfg, 'provider');
      const l = await availableListing(p.agent);
      const radii = ((await cfg.db.execute(sql`SELECT radius_km FROM escalation_steps WHERE listing_id = ${l.id}::uuid ORDER BY seq`)).rows as { radius_km: number | null }[]).map((r) => r.radius_km);
      expect(radii).toEqual([3, 5, 5, 5, null]);
    } finally {
      await cfg.pool.end();
    }
  });

  it('with ESCALATION_ENABLED=false keeps the previous behaviour: everyone eligible is told at publish, and there is no schedule', async () => {
    const off = setup({ ESCALATION_ENABLED: 'false' });
    try {
      await resetData(off.db);
      const p = await verifiedAgent(off, 'provider');
      await matchedNgo(off, { metersAway: 1000 });
      await matchedNgo(off, { metersAway: 4000, requirement: FAR });
      const l = await availableListing(p.agent);
      expect(await count(off, sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'LISTING_MATCH'`)).toBe(2);
      expect(await count(off, sql`SELECT count(*)::int AS n FROM escalation_steps WHERE listing_id = ${l.id}::uuid`)).toBe(0);
      expect((await off.escalation.runDue(new Date(Date.now() + 60 * MIN))).executed).toEqual([]);
    } finally {
      await off.pool.end();
    }
  });
});

describe('admin visibility', () => {
  const BOARD = '/api/v1/admin/board';

  it('shows the current stage and wave history on the unaccepted-listings board', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const m = await market([2000, 4500]);
    const fresh = (await admin.agent.get(`${BOARD}/listings`)).body.data.listings[0];
    expect(fresh.escalation).toMatchObject({ enabled: true, round: 1, completed: 0, total: 5, current: null, adminAlerted: false, stopped: null });
    expect(fresh.escalation.next).toMatchObject({ seq: 1, kind: 'NGO_WAVE', radiusKm: 3, status: 'PENDING' });

    await run(plus(m.published, 15 * MIN), m.listing.id);
    const mid = (await admin.agent.get(`${BOARD}/listings`)).body.data.listings[0].escalation;
    expect(mid).toMatchObject({ completed: 2, total: 5, adminAlerted: false });
    expect(mid.current).toMatchObject({ seq: 2, kind: 'NGO_WAVE', status: 'DONE', qualified: 2, newlyEligible: 1, notifiedOrgs: 1 });
    expect(mid.next).toMatchObject({ seq: 3, kind: 'RUNNER_WAVE' });

    await run(plus(m.published, 45 * MIN), m.listing.id);
    const end = (await admin.agent.get(`${BOARD}/listings`)).body.data.listings[0].escalation;
    expect(end).toMatchObject({ completed: 5, adminAlerted: true, next: null });
  });

  it('shows why the schedule stopped on closed listings, and the full history with who was told on the detail route', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const m = await market([2000]);
    await run(plus(m.published, 3 * MIN), m.listing.id);
    await m.provider.agent.post(`/api/v1/listings/${m.listing.id}/cancel`).send({ reason: 'Kitchen closed early' }).expect(200);
    const closed = (await admin.agent.get(`${BOARD}/listings?scope=closed`)).body.data.listings[0];
    expect(closed.escalation).toMatchObject({ completed: 1, stopped: 'LISTING_CANCELLED', next: null });

    const h = (await admin.agent.get(`${BOARD}/listings/${m.listing.id}/escalation`)).body.data;
    expect(h.listing).toMatchObject({ id: m.listing.id, status: 'CANCELLED' });
    expect(h.rounds).toHaveLength(1);
    expect(h.rounds[0].steps[0]).toMatchObject({ seq: 1, status: 'DONE', notifiedOrgs: 1, recipients: [{ kind: 'NGO', position: 1, organization: { id: m.ngos[0]!.organizationId } }] });
    expect(h.rounds[0].steps[1]).toMatchObject({ status: 'CANCELLED', reason: 'LISTING_CANCELLED', recipients: [] });
    expect((await admin.agent.get(`${BOARD}/listings/00000000-0000-4000-8000-000000000000/escalation`)).status).toBe(404);
  });

  it('keeps the history route admin-only, and exposes no addresses, contacts, codes or coordinates', async () => {
    const admin = await signedInAgent(ctx, 'admin');
    const m = await market([2000]);
    const runner = await runnerAt(ctx, { metersAway: 1000 });
    await run(plus(m.published, 45 * MIN), m.listing.id);
    const url = `${BOARD}/listings/${m.listing.id}/escalation`;
    expect((await request(ctx.app).get(url)).status).toBe(401);
    for (const who of [m.provider, m.ngos[0]!, runner]) expect((await who.agent.get(url)).status).toBe(403);
    const body = JSON.stringify([(await admin.agent.get(url)).body, (await admin.agent.get(`${BOARD}/listings`)).body]);
    for (const secret of ['Secret Lane', 'Block C', '@example.test', '+91', '18.52043', '73.85674', 'pickupCode', 'password', 'token', m.ngos[0]!.email, runner.email]) expect(body, secret).not.toContain(secret);
    // only the coarse (2-decimal) area positions of the operations map may appear
    expect(body).not.toMatch(/"(latitude|longitude)":-?\d+\.\d{3,}/);
  });
});

describe('privacy of notifications', () => {
  it('never puts addresses, contacts, pickup codes or coordinates in any wave notification', async () => {
    await signedInAgent(ctx, 'admin');
    const m = await market([2000]);
    await runnerAt(ctx, { metersAway: 1000 });
    await run(plus(m.published, 50 * MIN), m.listing.id);
    const all = (await rows(ctx, sql`SELECT type, title, body, entity_type FROM notifications`)) as { type: string; title: string; body: string }[];
    expect(new Set(all.map((n) => n.type))).toEqual(new Set(['LISTING_MATCH', 'LISTING_RUNNER_ALERT', 'ESCALATION_ADMIN']));
    const text = JSON.stringify(all);
    for (const secret of ['Secret Lane', 'Block C', '@example.test', '+91', '18.52043', '73.85674', 'pickup code', 'pickupCode']) expect(text, secret).not.toContain(secret);
  });
});
