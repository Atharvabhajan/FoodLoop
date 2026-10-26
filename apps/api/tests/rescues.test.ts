import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadRescueSettings } from '../src/config.js';
import { createMatchingService } from '../src/modules/matching/service.js';
import {
  acceptanceDeadlines,
  dueExpiry,
  effectiveRescueStatus,
  nextRescueStatus,
  pickupWindowOpen,
  type RescueCommand,
} from '../src/modules/rescues/lifecycle.js';
import { createRescueService } from '../src/modules/rescues/service.js';
import {
  availableListing,
  createListing,
  matchedNgo,
  minutesFromNow,
  resetData,
  setup,
  signedInAgent,
  verifiedAgent,
} from './helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

type Agent = Awaited<ReturnType<typeof signedInAgent>>['agent'];
const rows = async (q: ReturnType<typeof sql>) => (await ctx.db.execute(q)).rows as Record<string, unknown>[];
const count = async (q: ReturnType<typeof sql>) => Number(((await rows(q))[0] as { n: number }).n);
const accept = (agent: Agent, listingId: string) => agent.post(`/api/v1/listings/${listingId}/accept`).send({});
const R = (id: string) => `/api/v1/rescues/${id}`;

/** A verified provider with a live listing and a nearby verified NGO that is eligible for it. */
async function scenario(listing: Record<string, unknown> = {}) {
  const provider = await verifiedAgent(ctx, 'provider');
  const ngo = await matchedNgo(ctx, { metersAway: 1000 });
  const l = await availableListing(provider.agent, listing);
  return { provider, ngo, listing: l };
}

async function accepted(listing: Record<string, unknown> = {}) {
  const s = await scenario(listing);
  const res = await accept(s.ngo.agent, s.listing.id);
  if (res.status !== 201) throw new Error(`accept failed ${res.status} ${JSON.stringify(res.body)}`);
  return { ...s, rescueId: res.body.data.rescue.id as string };
}

async function confirmed(listing: Record<string, unknown> = {}) {
  const s = await accepted(listing);
  const res = await s.provider.agent.post(`${R(s.rescueId)}/confirm`).send({});
  if (res.status !== 200) throw new Error(`confirm failed ${res.status} ${JSON.stringify(res.body)}`);
  return { ...s, code: res.body.data.pickupCode as string };
}

async function pickedUp(collected = 40) {
  const s = await confirmed();
  const res = await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: collected });
  if (res.status !== 200) throw new Error(`verify failed ${res.status} ${JSON.stringify(res.body)}`);
  return s;
}

const listingStatus = async (id: string) => ((await rows(sql`SELECT status FROM food_listings WHERE id = ${id}::uuid`))[0] as { status: string }).status;
const rescueRow = async (id: string) => (await rows(sql`SELECT * FROM rescues WHERE id = ${id}::uuid`))[0] as Record<string, unknown>;
const events = async (id: string) =>
  (await rows(sql`SELECT event_type, from_status, to_status, actor_role, reason, metadata FROM rescue_events WHERE rescue_id = ${id}::uuid ORDER BY seq`)) as {
    event_type: string;
    from_status: string | null;
    to_status: string | null;
    actor_role: string;
    reason: string | null;
    metadata: Record<string, unknown>;
  }[];

/* ------------------------------------------------------------------------------------------ */

describe('rescue lifecycle rules (pure)', () => {
  const ALL = ['RESERVED', 'AWAITING_RUNNER', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DELIVERED', 'RECIPIENT_CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'PICKUP_FAILED', 'DELIVERY_FAILED'] as const;
  // Phase 5 (direct pickup) rows are unchanged; Phase 6 adds the runner-assisted commands and states.
  const allowed: Record<RescueCommand, Record<string, string>> = {
    PROVIDER_CONFIRM: { RESERVED: 'PICKUP_ASSIGNED' },
    PROVIDER_CONFIRM_RUNNER: { RESERVED: 'AWAITING_RUNNER' },
    PROVIDER_REJECT: { RESERVED: 'CANCELLED' },
    PROVIDER_CANCEL: { RESERVED: 'CANCELLED', AWAITING_RUNNER: 'CANCELLED', PICKUP_ASSIGNED: 'CANCELLED' },
    NGO_CANCEL: { RESERVED: 'CANCELLED', AWAITING_RUNNER: 'CANCELLED', PICKUP_ASSIGNED: 'CANCELLED' },
    ADMIN_CANCEL: { RESERVED: 'CANCELLED', AWAITING_RUNNER: 'CANCELLED', PICKUP_ASSIGNED: 'CANCELLED' },
    RUNNER_ACCEPT: { AWAITING_RUNNER: 'PICKUP_ASSIGNED' },
    RUNNER_RELEASE: { PICKUP_ASSIGNED: 'AWAITING_RUNNER' },
    ADMIN_REASSIGN: { PICKUP_ASSIGNED: 'AWAITING_RUNNER' },
    SWITCH_TO_SELF: { AWAITING_RUNNER: 'PICKUP_ASSIGNED' },
    VERIFY_PICKUP: { PICKUP_ASSIGNED: 'PICKUP_CONFIRMED' },
    START_TRANSIT: { PICKUP_CONFIRMED: 'IN_TRANSIT' },
    RUNNER_HANDOVER: { IN_TRANSIT: 'DELIVERED' },
    CONFIRM_DELIVERY: { PICKUP_CONFIRMED: 'RECIPIENT_CONFIRMED', DELIVERED: 'RECIPIENT_CONFIRMED' },
    COMPLETE: { RECIPIENT_CONFIRMED: 'COMPLETED' },
    ADMIN_RESOLVE: { PICKUP_CONFIRMED: 'COMPLETED', IN_TRANSIT: 'COMPLETED', DELIVERED: 'COMPLETED', DELIVERY_FAILED: 'COMPLETED' },
    ADMIN_FAIL: { PICKUP_CONFIRMED: 'DELIVERY_FAILED', IN_TRANSIT: 'DELIVERY_FAILED', DELIVERED: 'DELIVERY_FAILED' },
    EXPIRE_CONFIRMATION: { RESERVED: 'EXPIRED' },
    EXPIRE_RUNNER_SEARCH: { AWAITING_RUNNER: 'EXPIRED' },
    EXPIRE_PICKUP: { PICKUP_ASSIGNED: 'PICKUP_FAILED' },
    EXPIRE_TRANSIT: { IN_TRANSIT: 'DELIVERY_FAILED' },
    EXPIRE_DELIVERY: { PICKUP_CONFIRMED: 'DELIVERY_FAILED', DELIVERED: 'DELIVERY_FAILED' },
  };

  it('allows exactly the documented transitions and rejects every other (state, command) pair', () => {
    for (const [cmd, map] of Object.entries(allowed) as [RescueCommand, Record<string, string>][]) {
      for (const s of ALL) expect(nextRescueStatus(s, cmd), `${s} + ${cmd}`).toBe(map[s] ?? null);
    }
  });

  it('never leaves a terminal state', () => {
    for (const s of ['COMPLETED', 'CANCELLED', 'EXPIRED', 'PICKUP_FAILED'] as const) {
      for (const cmd of Object.keys(allowed) as RescueCommand[]) expect(nextRescueStatus(s, cmd)).toBeNull();
    }
  });

  const NOW = new Date('2026-10-25T12:00:00Z');
  const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
  const s = loadRescueSettings({});

  it('computes overdue expiry with inclusive deadlines', () => {
    const base = { providerConfirmBy: at(0), pickupBy: at(60), deliveryConfirmBy: null };
    expect(dueExpiry({ ...base, status: 'RESERVED' }, NOW)).toBe('EXPIRE_CONFIRMATION');
    expect(dueExpiry({ ...base, status: 'RESERVED', providerConfirmBy: at(1) }, NOW)).toBeNull();
    expect(dueExpiry({ ...base, status: 'PICKUP_ASSIGNED', pickupBy: at(0) }, NOW)).toBe('EXPIRE_PICKUP');
    expect(dueExpiry({ ...base, status: 'PICKUP_CONFIRMED', deliveryConfirmBy: at(-1) }, NOW)).toBe('EXPIRE_DELIVERY');
    expect(dueExpiry({ ...base, status: 'COMPLETED' }, NOW)).toBeNull();
    expect(effectiveRescueStatus({ ...base, status: 'RESERVED' }, NOW)).toBe('EXPIRED');
    expect(effectiveRescueStatus({ ...base, status: 'PICKUP_ASSIGNED' }, NOW)).toBe('PICKUP_ASSIGNED');
  });

  it('sets deadlines from configuration, never past the pickup deadline', () => {
    const d = acceptanceDeadlines(NOW, at(180), s);
    expect(d.providerConfirmBy.getTime()).toBe(at(15).getTime());
    expect(d.pickupBy.getTime()).toBe(at(180 + 30).getTime());
    expect(acceptanceDeadlines(NOW, at(5), s).providerConfirmBy.getTime()).toBe(at(5).getTime());
  });

  it('opens pickup verification shortly before the window and closes it at the pickup grace deadline', () => {
    expect(pickupWindowOpen(NOW, at(30), at(200), s)).toBe(true); // exactly 30 min early
    expect(pickupWindowOpen(NOW, at(31), at(200), s)).toBe(false);
    expect(pickupWindowOpen(NOW, at(-60), at(0), s)).toBe(false); // grace deadline reached
  });

  it('validates rescue configuration', () => {
    expect(() => loadRescueSettings({ RESCUE_PROVIDER_CONFIRM_MINUTES: '0' })).toThrow();
    expect(() => loadRescueSettings({ RESCUE_MAX_CODE_ATTEMPTS: 'many' })).toThrow();
    expect(loadRescueSettings({ RESCUE_DELIVERY_CONFIRM_HOURS: '24' }).deliveryConfirmHours).toBe(24);
  });
});

describe('accepting a listing', () => {
  it('lets an eligible verified NGO reserve a live listing', async () => {
    const s = await scenario();
    const res = await accept(s.ngo.agent, s.listing.id);
    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(true);
    const r = res.body.data.rescue;
    expect(r).toMatchObject({ status: 'RESERVED', version: 1, viewerRole: 'ngo', allowedActions: ['cancel'] });
    expect(r.nextAction.party).toBe('provider');
    expect(await listingStatus(s.listing.id)).toBe('RESERVED');
    const ev = await events(r.id);
    expect(ev.map((e) => e.event_type)).toEqual(['ACCEPTED']);
    expect(ev[0]).toMatchObject({ to_status: 'RESERVED', actor_role: 'ngo' });
    // Provider members are notified; the accepting NGO user is not.
    const providerNotes = (await s.provider.agent.get('/api/v1/notifications')).body.data.notifications;
    expect(providerNotes.filter((n: { type: string }) => n.type === 'RESCUE_UPDATE')).toHaveLength(1);
  });

  it('takes the listing out of every NGO feed and recommendation, and stops matching it', async () => {
    const s = await scenario();
    const other = await matchedNgo(ctx, { metersAway: 1500 });
    expect((await other.agent.get('/api/v1/listings/recommended')).body.data.listings).toHaveLength(1);
    // This NGO became eligible after the listing opened, so it hears about it from the next escalation wave (not instantly).
    await ctx.escalation.runDue(new Date(Date.now() + 20 * 60_000));
    await accept(s.ngo.agent, s.listing.id).expect(201);
    expect((await other.agent.get('/api/v1/listings/recommended')).body.data.listings).toEqual([]);
    expect((await other.agent.get('/api/v1/listings/feed')).body.data.listings).toEqual([]);
    const refresh = await s.provider.agent.post(`/api/v1/listings/${s.listing.id}/matches/refresh`);
    expect(refresh.status).toBe(409);
    // The other NGO's earlier match notification is no longer actionable.
    const notes = (await other.agent.get('/api/v1/notifications')).body.data.notifications;
    expect(notes.find((n: { type: string }) => n.type === 'LISTING_MATCH')).toMatchObject({ actionable: false });
  });

  it('is idempotent for the same NGO: retries return the same rescue without duplicates', async () => {
    const s = await scenario();
    const first = await accept(s.ngo.agent, s.listing.id);
    const second = await accept(s.ngo.agent, s.listing.id);
    expect(second.status).toBe(200);
    expect(second.body.data.created).toBe(false);
    expect(second.body.data.rescue.id).toBe(first.body.data.rescue.id);
    expect(await count(sql`SELECT count(*)::int AS n FROM rescues`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM rescue_events`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'RESCUE_UPDATE'`)).toBe(1);
  });

  it('lets exactly one of two NGOs reserve a listing when they accept at the same time', async () => {
    const s = await scenario();
    const rival = await matchedNgo(ctx, { metersAway: 1200 });
    const results = await Promise.all([accept(s.ngo.agent, s.listing.id), accept(rival.agent, s.listing.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('LISTING_ALREADY_RESERVED');
    expect(await count(sql`SELECT count(*)::int AS n FROM rescues WHERE listing_id = ${s.listing.id}::uuid`)).toBe(1);
  });

  it('creates one rescue even when many NGOs and retries race', async () => {
    const s = await scenario();
    const others = [await matchedNgo(ctx, { metersAway: 900 }), await matchedNgo(ctx, { metersAway: 1100 }), await matchedNgo(ctx, { metersAway: 1300 })];
    const agents = [s.ngo.agent, s.ngo.agent, ...others.map((o) => o.agent), s.ngo.agent];
    const results = await Promise.all(agents.map((a) => accept(a, s.listing.id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results) expect([200, 201, 409]).toContain(r.status);
    expect(await count(sql`SELECT count(*)::int AS n FROM rescues`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM rescue_events`)).toBe(1);
  });

  it('is backed by a database rule: a second ACTIVE rescue for the listing cannot be inserted', async () => {
    const s = await accepted();
    const r = await rescueRow(s.rescueId);
    await expect(
      ctx.db.execute(sql`INSERT INTO rescues (listing_id, provider_org_id, ngo_org_id, accepted_by, servings_offered, provider_confirm_by, pickup_by)
        VALUES (${s.listing.id}::uuid, ${r.provider_org_id as string}::uuid, ${r.ngo_org_id as string}::uuid, ${r.accepted_by as string}::uuid, 45, now(), now())`),
    ).rejects.toThrow();
  });

  it('re-checks eligibility live, ignoring stale stored recommendations', async () => {
    const s = await scenario();
    // Pause intake behind the matching hooks' back: the stored candidate row still says "eligible".
    await ctx.db.execute(sql`UPDATE ngo_requirements SET intake_enabled = false WHERE ngo_org_id = ${s.ngo.organizationId}::uuid`);
    expect((await rows(sql`SELECT eligible FROM match_candidates WHERE ngo_org_id = ${s.ngo.organizationId}::uuid`))[0]).toMatchObject({ eligible: true });
    const res = await accept(s.ngo.agent, s.listing.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_ELIGIBLE');
    expect(res.body.details.reasons.map((r: { code: string }) => r.code)).toContain('INTAKE_PAUSED');
    expect(await count(sql`SELECT count(*)::int AS n FROM rescues`)).toBe(0);
  });

  it('rejects NGOs that fail a hard filter, including time feasibility that has drifted', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(provider.agent);
    const bakeryOnly = await matchedNgo(ctx, { metersAway: 1000, requirement: { foodCategories: ['BAKERY'] } });
    const cat = await accept(bakeryOnly.agent, l.id);
    expect(cat.status).toBe(409);
    expect(cat.body.details.reasons.map((r: { code: string }) => r.code)).toEqual(['CATEGORY_NOT_ACCEPTED']);

    const far = await matchedNgo(ctx, { metersAway: 5000, requirement: { serviceRadiusKm: 8 } });
    // Time passes: the deadline is now too close for a 5 km trip plus dispatch.
    await ctx.db.execute(sql`UPDATE food_listings SET pickup_start = now() - interval '5 minutes', pickup_deadline = now() + interval '20 minutes' WHERE id = ${l.id}::uuid`);
    const late = await accept(far.agent, l.id);
    expect(late.status).toBe(409);
    expect(late.body.details.reasons.map((r: { code: string }) => r.code)).toContain('TIME_INFEASIBLE');
  });

  it('refuses drafts, cancelled, expired and unknown listings', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const draft = await createListing(provider.agent);
    expect((await accept(ngo.agent, draft.id)).body.code).toBe('LISTING_NOT_AVAILABLE');
    const cancelled = await availableListing(provider.agent, { title: 'Cancelled one' });
    await provider.agent.post(`/api/v1/listings/${cancelled.id}/cancel`).send({ reason: 'Not needed' }).expect(200);
    expect((await accept(ngo.agent, cancelled.id)).body.code).toBe('LISTING_NOT_AVAILABLE');
    const expired = await availableListing(provider.agent, { title: 'Expired one' });
    await ctx.db.execute(sql`UPDATE food_listings SET pickup_deadline = now() - interval '1 minute', pickup_start = now() - interval '2 hours', prepared_at = now() - interval '3 hours' WHERE id = ${expired.id}::uuid`);
    expect((await accept(ngo.agent, expired.id)).status).toBe(409);
    expect((await accept(ngo.agent, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await accept(ngo.agent, 'not-a-uuid')).status).toBe(404);
  });

  it('only verified NGO users can accept', async () => {
    const s = await scenario();
    expect((await request(ctx.app).post(`/api/v1/listings/${s.listing.id}/accept`).send({})).status).toBe(401);
    for (const role of ['provider', 'runner', 'admin'] as const) {
      expect((await accept((await signedInAgent(ctx, role)).agent, s.listing.id)).status, role).toBe(403);
    }
    const unverified = await signedInAgent(ctx, 'ngo');
    const res = await accept(unverified.agent, s.listing.id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORGANIZATION_NOT_VERIFIED');
    expect((await s.ngo.agent.post(`/api/v1/listings/${s.listing.id}/accept`).send({ extra: 1 })).status).toBe(400);
  });
});

describe('provider confirmation and privacy staging', () => {
  it('hides exact address and contacts until the provider confirms, then shares them with both parties', async () => {
    const s = await accepted();
    await ctx.db.execute(sql`UPDATE organizations SET contact_name = 'Pat Provider', contact_phone = '+91 90000 00001' WHERE id = ${s.provider.organizationId}::uuid`);
    await ctx.db.execute(sql`UPDATE organizations SET contact_name = 'Nia NGO', contact_phone = '+91 90000 00002' WHERE id = ${s.ngo.organizationId}::uuid`);

    const ngoBefore = (await s.ngo.agent.get(R(s.rescueId))).body.data.rescue;
    expect(ngoBefore.listing.exactPickup).toBeNull();
    expect(ngoBefore.provider.contact).toBeNull();
    expect(JSON.stringify(ngoBefore)).not.toMatch(/Secret Lane|18\.52043|90000 00001/);
    const provBefore = (await s.provider.agent.get(R(s.rescueId))).body.data.rescue;
    expect(provBefore.ngo.contact).toBeNull();
    expect(JSON.stringify(provBefore)).not.toContain('90000 00002');

    const conf = await s.provider.agent.post(`${R(s.rescueId)}/confirm`).send({});
    expect(conf.status).toBe(200);
    expect(conf.body.data.pickupCode).toMatch(/^\d{6}$/);
    expect(conf.body.data.rescue).toMatchObject({ status: 'PICKUP_ASSIGNED', version: 2 });

    const ngoAfter = (await s.ngo.agent.get(R(s.rescueId))).body.data.rescue;
    expect(ngoAfter.listing.exactPickup).toMatchObject({ addressLine: '12 Secret Lane, Block C', latitude: 18.52043 });
    expect(ngoAfter.provider.contact).toMatchObject({ contactName: 'Pat Provider', contactPhone: '+91 90000 00001' });
    expect(JSON.stringify(ngoAfter)).not.toContain(conf.body.data.pickupCode); // the NGO never receives the code
    const provAfter = (await s.provider.agent.get(R(s.rescueId))).body.data.rescue;
    expect(provAfter.ngo.contact).toMatchObject({ contactName: 'Nia NGO' });
    expect(provAfter.allowedActions).toEqual(['regenerate_code', 'cancel', 'report_incident']); // Phase 6 adds incident reporting
  });

  it('is idempotent and guarded: a repeated confirm changes nothing; wrong roles and stale versions are refused', async () => {
    const s = await accepted();
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/confirm`).send({})).status).toBe(403);
    const otherProvider = await verifiedAgent(ctx, 'provider');
    expect((await otherProvider.agent.post(`${R(s.rescueId)}/confirm`).send({})).status).toBe(404);
    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.post(`${R(s.rescueId)}/confirm`).send({})).status).toBe(403);
    const stale = await s.provider.agent.post(`${R(s.rescueId)}/confirm`).send({ expectedVersion: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_RESCUE');

    await s.provider.agent.post(`${R(s.rescueId)}/confirm`).send({ expectedVersion: 1 }).expect(200);
    const again = await s.provider.agent.post(`${R(s.rescueId)}/confirm`).send({});
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ changed: false, pickupCode: null });
    expect((await events(s.rescueId)).filter((e) => e.to_status === 'PICKUP_ASSIGNED')).toHaveLength(1);
    // A stale client still holding version 1 is refused.
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/cancel`).send({ reason: 'Stale tab', expectedVersion: 1 })).body.code).toBe('STALE_RESCUE');
  });

  it('lets the provider decline: the listing returns to the market and that NGO is not offered it again', async () => {
    const s = await accepted();
    const other = await matchedNgo(ctx, { metersAway: 1500 });
    expect((await s.provider.agent.post(`${R(s.rescueId)}/reject`).send({})).status).toBe(400);
    const res = await s.provider.agent.post(`${R(s.rescueId)}/reject`).send({ reason: 'We prefer a closer NGO today' });
    expect(res.status).toBe(200);
    expect(res.body.data.rescue).toMatchObject({ status: 'CANCELLED', outcomeCode: 'PROVIDER_REJECTED', outcomeReason: 'We prefer a closer NGO today' });
    expect(await listingStatus(s.listing.id)).toBe('AVAILABLE');

    const again = await accept(s.ngo.agent, s.listing.id);
    expect(again.status).toBe(409);
    expect(again.body.details.reasons.map((r: { code: string }) => r.code)).toContain('PREVIOUSLY_DECLINED');
    // Matching was refreshed on release: the declined NGO is excluded, the other is recommended again.
    expect((await rows(sql`SELECT reasons FROM match_candidates WHERE ngo_org_id = ${s.ngo.organizationId}::uuid`))[0]!.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PREVIOUSLY_DECLINED' })]),
    );
    expect((await other.agent.get('/api/v1/listings/recommended')).body.data.listings).toHaveLength(1);
    expect((await accept(other.agent, s.listing.id)).status).toBe(201);

    const declinedAgain = await s.provider.agent.post(`${R(s.rescueId)}/reject`).send({ reason: 'We prefer a closer NGO today' });
    expect(declinedAgain.body.data.changed).toBe(false); // idempotent replay
  });

  it('cannot decline after confirming', async () => {
    const s = await confirmed();
    const res = await s.provider.agent.post(`${R(s.rescueId)}/reject`).send({ reason: 'Too late' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_RESCUE_TRANSITION');
  });
});

describe('pickup verification', () => {
  it('requires the one-time code, counts wrong attempts and locks after the limit', async () => {
    const s = await confirmed();
    const wrong = s.code === '000000' ? '111111' : '000000';
    const first = await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: wrong, collectedServings: 40 });
    expect(first.status).toBe(400);
    expect(first.body).toMatchObject({ code: 'PICKUP_CODE_INVALID', details: { attemptsLeft: 4 } });
    for (let i = 0; i < 4; i++) await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: wrong, collectedServings: 40 });
    const locked = await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('PICKUP_CODE_LOCKED');
    expect((await events(s.rescueId)).filter((e) => e.event_type === 'PICKUP_CODE_REJECTED')).toHaveLength(5);
    expect((await s.ngo.agent.get(R(s.rescueId))).body.data.rescue.pickupCode).toMatchObject({ locked: true, attemptsLeft: 0 });

    // The provider issues a new code; the old one no longer works, the new one does.
    const fresh = await s.provider.agent.post(`${R(s.rescueId)}/pickup-code`).send({});
    expect(fresh.status).toBe(200);
    const newCode = fresh.body.data.pickupCode as string;
    if (newCode !== s.code) {
      expect((await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 })).status).toBe(400);
    }
    const ok = await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: newCode, collectedServings: 40 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.rescue).toMatchObject({ status: 'PICKUP_CONFIRMED', collectedServings: 40 });
  });

  it('records collection, marks the listing collected, and makes the code single-use', async () => {
    const s = await confirmed();
    const tooMany = await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 46 });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.details.fields.collectedServings).toMatch(/45/);
    expect((await s.provider.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 })).status).toBe(403);

    const res = await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 43 });
    expect(res.status).toBe(200);
    expect(await listingStatus(s.listing.id)).toBe('COLLECTED');
    const row = await rescueRow(s.rescueId);
    expect(row).toMatchObject({ status: 'PICKUP_CONFIRMED', collected_servings: 43, pickup_code_hash: null });
    expect(row.delivery_confirm_by).toBeTruthy();
    const ev = (await events(s.rescueId)).find((e) => e.to_status === 'PICKUP_CONFIRMED')!;
    expect(ev.metadata).toMatchObject({ collectedServings: 43, proofMethod: 'OTP' });

    const replay = await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 43 });
    expect(replay.status).toBe(200);
    expect(replay.body.data.changed).toBe(false);
    expect((await s.provider.agent.post(`${R(s.rescueId)}/pickup-code`).send({})).status).toBe(409); // no new code after pickup
  });

  it('refuses verification well before the pickup window opens', async () => {
    const s = await accepted({ pickupStart: minutesFromNow(120), pickupDeadline: minutesFromNow(300) });
    const conf = await s.provider.agent.post(`${R(s.rescueId)}/confirm`).send({});
    const res = await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: conf.body.data.pickupCode, collectedServings: 40 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PICKUP_WINDOW_CLOSED');
  });

  it('validates the request body', async () => {
    const s = await confirmed();
    for (const body of [{}, { code: '12', collectedServings: 1 }, { code: s.code, collectedServings: 0 }, { code: s.code, collectedServings: 1.5 }, { code: s.code, collectedServings: 5, x: 1 }]) {
      expect((await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send(body)).status).toBe(400);
    }
  });
});

describe('delivery confirmation and completion', () => {
  it('completes the rescue through RECIPIENT_CONFIRMED with outcome data and a provider notification', async () => {
    const s = await pickedUp(43);
    const over = await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 44 });
    expect(over.status).toBe(400);
    expect(over.body.details.fields.deliveredServings).toMatch(/43/);
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 0 })).status).toBe(400);

    const res = await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 42, notes: 'One box damaged' });
    expect(res.status).toBe(200);
    expect(res.body.data.rescue).toMatchObject({ status: 'COMPLETED', deliveredServings: 42, collectedServings: 43, outcomeCode: 'COMPLETED', allowedActions: [] });
    const statuses = (await events(s.rescueId)).filter((e) => e.event_type === 'STATUS_CHANGED').map((e) => e.to_status);
    expect(statuses).toEqual(['PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'RECIPIENT_CONFIRMED', 'COMPLETED']);
    const done = (await events(s.rescueId)).find((e) => e.to_status === 'COMPLETED')!;
    expect(done.actor_role).toBe('system');
    const row = await rescueRow(s.rescueId);
    expect(row.completed_at).toBeTruthy();
    expect(row.closed_at).toBeTruthy();

    const replay = await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 42 });
    expect(replay.body.data.changed).toBe(false);
    expect((await events(s.rescueId)).filter((e) => e.to_status === 'COMPLETED')).toHaveLength(1);
    const providerNotes = (await s.provider.agent.get('/api/v1/notifications')).body.data.notifications.filter((n: { type: string }) => n.type === 'RESCUE_UPDATE');
    expect(providerNotes.map((n: { title: string }) => n.title)).toEqual(expect.arrayContaining([expect.stringMatching(/completed/i)]));
    // A finished rescue's notifications are no longer actionable.
    for (const n of providerNotes) expect(n.actionable).toBe(false);
  });

  it('only the NGO party confirms delivery, and only after pickup', async () => {
    const s = await confirmed();
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 10 })).body.code).toBe('INVALID_RESCUE_TRANSITION');
    expect((await s.provider.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 10 })).status).toBe(403);
  });

  it('keeps Phase 4 reliability neutral after a completed rescue (no reliability scoring yet)', async () => {
    const s = await pickedUp(40);
    await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 40 }).expect(200);
    const l2 = await availableListing(s.provider.agent, { title: 'Second meal' });
    const view = await s.provider.agent.get(`/api/v1/listings/${l2.id}/matches`);
    expect(view.body.data.candidates[0].breakdown.reliability).toMatchObject({ score: 50 });
  });
});

describe('cancellation', () => {
  it('NGO cancellation before pickup releases the listing for others and refreshes matching', async () => {
    const s = await confirmed();
    const other = await matchedNgo(ctx, { metersAway: 1500 });
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/cancel`).send({ reason: 'x' })).status).toBe(400);
    const res = await s.ngo.agent.post(`${R(s.rescueId)}/cancel`).send({ reason: 'Our van broke down' });
    expect(res.status).toBe(200);
    expect(res.body.data.rescue).toMatchObject({ status: 'CANCELLED', outcomeCode: 'NGO_CANCELLED' });
    expect(res.body.data.rescue.listing.exactPickup).toBeNull(); // hand-off details withdrawn again
    expect(await listingStatus(s.listing.id)).toBe('AVAILABLE');
    expect((await other.agent.get('/api/v1/listings/recommended')).body.data.listings).toHaveLength(1);
    const provNotes = (await s.provider.agent.get('/api/v1/notifications')).body.data.notifications;
    expect(provNotes.some((n: { body: string }) => n.body.includes('Our van broke down'))).toBe(true);
  });

  it('cannot cancel after pickup', async () => {
    const s = await pickedUp();
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/cancel`).send({ reason: 'Changed mind' })).body.code).toBe('INVALID_RESCUE_TRANSITION');
    expect((await s.provider.agent.post(`${R(s.rescueId)}/cancel`).send({ reason: 'Changed mind' })).body.code).toBe('INVALID_RESCUE_TRANSITION');
  });

  it('provider cancellation withdraws the food: rescue and listing are both cancelled', async () => {
    const s = await accepted();
    const res = await s.provider.agent.post(`${R(s.rescueId)}/cancel`).send({ reason: 'Food spoiled in storage' });
    expect(res.status).toBe(200);
    expect(res.body.data.rescue.outcomeCode).toBe('PROVIDER_WITHDREW');
    expect(await listingStatus(s.listing.id)).toBe('CANCELLED');
    const hist = (await s.provider.agent.get(`/api/v1/listings/${s.listing.id}/history`)).body.data.history;
    expect(hist[0]).toMatchObject({ action: 'CANCELLED', reason: 'Food spoiled in storage' });
  });

  it('a reserved listing cannot be cancelled through the listing endpoint', async () => {
    const s = await accepted();
    const res = await s.provider.agent.post(`/api/v1/listings/${s.listing.id}/cancel`).send({ reason: 'Not needed' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESCUE_ACTIVE');
    expect((await s.provider.agent.patch(`/api/v1/listings/${s.listing.id}`).send({ servings: 10 })).body.code).toBe('LISTING_LOCKED');
  });

  it('admins cancel only through the audited admin route, with a reason', async () => {
    const s = await accepted();
    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.post(`${R(s.rescueId)}/cancel`).send({ reason: 'Admin action' })).status).toBe(403);
    expect((await admin.agent.post(`${R(s.rescueId)}/admin/cancel`).send({})).status).toBe(400);
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/admin/cancel`).send({ reason: 'Not me' })).status).toBe(403);
    const res = await admin.agent.post(`${R(s.rescueId)}/admin/cancel`).send({ reason: 'Provider reported a safety concern' });
    expect(res.status).toBe(200);
    expect(res.body.data.rescue.outcomeCode).toBe('ADMIN_CANCELLED');
    expect((await events(s.rescueId)).at(-1)).toMatchObject({ actor_role: 'admin', reason: 'Provider reported a safety concern' });
  });
});

describe('deadlines and expiry', () => {
  const service = () => createRescueService(ctx.db, ctx.config.rescue, createMatchingService(ctx.db, ctx.config.match));

  it('expires a reservation the provider never confirms, on read, and releases the listing', async () => {
    const s = await accepted();
    await ctx.db.execute(sql`UPDATE rescues SET provider_confirm_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    // No worker has run: the read settles it.
    const view = (await s.ngo.agent.get(R(s.rescueId))).body.data.rescue;
    expect(view).toMatchObject({ status: 'EXPIRED', outcomeCode: 'PROVIDER_NO_RESPONSE' });
    expect(await listingStatus(s.listing.id)).toBe('AVAILABLE');
    expect((await events(s.rescueId)).at(-1)).toMatchObject({ to_status: 'EXPIRED', actor_role: 'system' });
    // Acting on it afterwards is refused.
    const late = await s.provider.agent.post(`${R(s.rescueId)}/confirm`).send({});
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_RESCUE_TRANSITION');
  });

  it('settles overdue rescues when another NGO tries to accept, so a silent provider never blocks a listing', async () => {
    const s = await accepted();
    const other = await matchedNgo(ctx, { metersAway: 1500 });
    expect((await accept(other.agent, s.listing.id)).status).toBe(409);
    await ctx.db.execute(sql`UPDATE rescues SET provider_confirm_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    const res = await accept(other.agent, s.listing.id);
    expect(res.status).toBe(201);
    expect(await count(sql`SELECT count(*)::int AS n FROM rescues WHERE listing_id = ${s.listing.id}::uuid AND status = 'RESERVED'`)).toBe(1);
  });

  it('the worker is idempotent and safe to run concurrently', async () => {
    const s = await accepted();
    await ctx.db.execute(sql`UPDATE rescues SET provider_confirm_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    const svc = service();
    const counts = await Promise.all([svc.settleDue(), svc.settleDue(), svc.settleDue()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await svc.settleDue()).toBe(0);
    expect((await events(s.rescueId)).filter((e) => e.to_status === 'EXPIRED')).toHaveLength(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'RESCUE_UPDATE' AND body LIKE '%did not confirm in time%'`)).toBeGreaterThan(0);
    const before = await count(sql`SELECT count(*)::int AS n FROM notifications`);
    await svc.settleDue();
    expect(await count(sql`SELECT count(*)::int AS n FROM notifications`)).toBe(before);
  });

  it('fails an unverified pickup after the pickup deadline and expires the listing', async () => {
    const s = await confirmed();
    await ctx.db.execute(sql`UPDATE rescues SET pickup_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    expect(await service().settleDue()).toBe(1);
    expect((await rescueRow(s.rescueId)).status).toBe('PICKUP_FAILED');
    expect(await listingStatus(s.listing.id)).toBe('EXPIRED');
    const late = await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 });
    expect(late.body.code).toBe('INVALID_RESCUE_TRANSITION');
  });

  it('flags an unconfirmed delivery for admin follow-up, which an admin can resolve with a reason', async () => {
    const s = await pickedUp(40);
    await ctx.db.execute(sql`UPDATE rescues SET delivery_confirm_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    const view = (await s.provider.agent.get(R(s.rescueId))).body.data.rescue;
    expect(view).toMatchObject({ status: 'DELIVERY_FAILED', outcomeCode: 'DELIVERY_NOT_CONFIRMED' });
    expect(view.nextAction.party).toBe('admin');
    expect((await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 40 })).body.code).toBe('INVALID_RESCUE_TRANSITION');

    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.post(`${R(s.rescueId)}/admin/resolve`).send({ deliveredServings: 41, reason: 'Phoned the NGO' })).status).toBe(400);
    expect((await admin.agent.post(`${R(s.rescueId)}/admin/resolve`).send({ deliveredServings: 40 })).status).toBe(400);
    const res = await admin.agent.post(`${R(s.rescueId)}/admin/resolve`).send({ deliveredServings: 38, reason: 'NGO confirmed by phone' });
    expect(res.status).toBe(200);
    expect(res.body.data.rescue).toMatchObject({ status: 'COMPLETED', deliveredServings: 38, outcomeCode: 'ADMIN_RESOLVED' });
  });

  it('reads stay correct without the timer: an overdue rescue shows its expired state in lists too', async () => {
    const s = await accepted();
    await ctx.db.execute(sql`UPDATE rescues SET provider_confirm_by = now() - interval '1 second' WHERE id = ${s.rescueId}::uuid`);
    const list = (await s.provider.agent.get('/api/v1/rescues?scope=past')).body.data.rescues;
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('EXPIRED');
    expect((await s.provider.agent.get('/api/v1/rescues?scope=active')).body.data.rescues).toEqual([]);
  });
});

describe('audit history', () => {
  it('is append-only at the database level and never stores pickup codes', async () => {
    const s = await confirmed();
    await expect(ctx.db.execute(sql`UPDATE rescue_events SET reason = 'tampered'`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`DELETE FROM rescue_events`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`DELETE FROM rescues WHERE id = ${s.rescueId}::uuid`)).rejects.toThrow();
    const raw = JSON.stringify(await events(s.rescueId));
    expect(raw).not.toContain(s.code);
    const notes = JSON.stringify(await rows(sql`SELECT title, body FROM notifications`));
    expect(notes).not.toContain(s.code);
    expect(notes).not.toMatch(/Secret Lane|Block C/);
    // The stored hash is bound to this rescue.
    const row = await rescueRow(s.rescueId);
    expect(row.pickup_code_hash).not.toContain(s.code);
  });

  it('records actor, role, transition and reason for every change', async () => {
    const s = await accepted();
    await s.ngo.agent.post(`${R(s.rescueId)}/cancel`).send({ reason: 'Vehicle unavailable' }).expect(200);
    expect(await events(s.rescueId)).toEqual([
      expect.objectContaining({ event_type: 'ACCEPTED', from_status: null, to_status: 'RESERVED', actor_role: 'ngo' }),
      expect.objectContaining({ event_type: 'STATUS_CHANGED', from_status: 'RESERVED', to_status: 'CANCELLED', actor_role: 'ngo', reason: 'Vehicle unavailable' }),
    ]);
  });
});

describe('history ordering', () => {
  it('is strictly ordered even for rows written in one transaction (same timestamp)', async () => {
    const s = await pickedUp(40);
    await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 40 }).expect(200);
    // RECIPIENT_CONFIRMED and COMPLETED are written in the same transaction and share created_at.
    const sameTime = await rows(sql`SELECT count(DISTINCT created_at)::int AS distinct_times, count(*)::int AS n FROM rescue_events WHERE rescue_id = ${s.rescueId}::uuid AND to_status IN ('RECIPIENT_CONFIRMED', 'COMPLETED')`);
    expect(sameTime[0]).toMatchObject({ distinct_times: 1, n: 2 });
    const view = (await s.ngo.agent.get(R(s.rescueId))).body.data.rescue;
    const shown = (view.history as { toStatus: string | null; eventType: string }[]).map((h) => `${h.eventType}:${h.toStatus}`);
    const stored = (await events(s.rescueId)).map((e) => `${e.event_type}:${e.to_status}`);
    expect(shown).toEqual([...stored].reverse()); // newest first, exactly the insertion order
    expect(shown[0]).toBe('STATUS_CHANGED:COMPLETED');
    expect(shown[1]).toBe('STATUS_CHANGED:RECIPIENT_CONFIRMED');
  });
});

describe('notifications', () => {
  it('notifies the other party once per change and never duplicates on retries', async () => {
    const s = await pickedUp(40);
    await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 40 }).expect(200);
    // Replays of every step.
    await s.provider.agent.post(`${R(s.rescueId)}/confirm`).send({});
    await s.ngo.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 });
    await s.ngo.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 40 });
    await accept(s.ngo.agent, s.listing.id);
    const providerTitles = (await s.provider.agent.get('/api/v1/notifications')).body.data.notifications
      .filter((n: { type: string }) => n.type === 'RESCUE_UPDATE')
      .map((n: { title: string }) => n.title);
    expect(providerTitles).toHaveLength(3); // accepted, collected, completed
    const ngoTitles = (await s.ngo.agent.get('/api/v1/notifications')).body.data.notifications
      .filter((n: { type: string }) => n.type === 'RESCUE_UPDATE')
      .map((n: { title: string }) => n.title);
    expect(ngoTitles).toHaveLength(1); // provider confirmed
    expect(await count(sql`SELECT count(*)::int AS n FROM (SELECT dedupe_key FROM notifications GROUP BY 1 HAVING count(*) > 1) t`)).toBe(0);
  });
});

describe('access control and privacy', () => {
  it('hides a rescue from unrelated organizations (404) and lists only your own', async () => {
    const s = await accepted();
    const otherNgo = await matchedNgo(ctx, { metersAway: 2000 });
    const otherProvider = await verifiedAgent(ctx, 'provider');
    const runner = await signedInAgent(ctx, 'runner');
    for (const a of [otherNgo.agent, otherProvider.agent, runner.agent]) {
      const res = await a.get(R(s.rescueId));
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/Biryani|Test ngo org|Test provider org/);
      expect((await a.post(`${R(s.rescueId)}/cancel`).send({ reason: 'Not mine' })).status).toBe(404);
    }
    expect((await otherNgo.agent.get('/api/v1/rescues?scope=all')).body.data.rescues).toEqual([]);
    expect((await otherProvider.agent.get('/api/v1/rescues?scope=all')).body.data.rescues).toEqual([]);
    // Phase 6: runners may list rescues, but only ones they hold or held, so an unrelated runner sees none.
    const runnerList = await runner.agent.get('/api/v1/rescues?scope=all');
    expect(runnerList.status).toBe(200);
    expect(runnerList.body.data.rescues).toEqual([]);
    expect((await request(ctx.app).get(R(s.rescueId))).status).toBe(401);
    expect((await s.ngo.agent.get(R('not-a-uuid'))).status).toBe(404);

    const admin = await signedInAgent(ctx, 'admin');
    const adminView = (await admin.agent.get(R(s.rescueId))).body.data.rescue;
    expect(adminView.viewerRole).toBe('admin');
    expect(adminView.listing.exactPickup).not.toBeNull();
    expect((await admin.agent.get('/api/v1/rescues?scope=all')).body.data.rescues).toHaveLength(1);
  });

  it('lists rescues by scope for each party, with names but no contact details', async () => {
    const s = await accepted();
    const ngoList = (await s.ngo.agent.get('/api/v1/rescues')).body.data.rescues;
    expect(ngoList).toHaveLength(1);
    expect(ngoList[0]).toMatchObject({ id: s.rescueId, status: 'RESERVED', listingTitle: 'Vegetable Biryani', providerName: 'Test provider org' });
    expect(JSON.stringify(ngoList)).not.toMatch(/contact|Secret Lane/i);
    expect((await s.provider.agent.get(`/api/v1/rescues?listingId=${s.listing.id}`)).body.data.rescues).toHaveLength(1);
    expect((await s.provider.agent.get('/api/v1/rescues?scope=bogus')).status).toBe(400);
  });

  it('lets the rescuing NGO keep the redacted listing view and photo access after the listing leaves the feed', async () => {
    const s = await accepted();
    expect((await s.ngo.agent.get(`/api/v1/listings/${s.listing.id}`)).status).toBe(200);
    const stranger = await matchedNgo(ctx, { metersAway: 2000 });
    expect((await stranger.agent.get(`/api/v1/listings/${s.listing.id}`)).status).toBe(404);
  });
});
