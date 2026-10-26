import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMatchingService } from '../src/modules/matching/service.js';
import {
  PROVIDER_POINT,
  availableListing,
  createListing,
  dbCandidates,
  listingBody,
  matchedNgo,
  minutesFromNow,
  pointAt,
  publishListing,
  requirementBody,
  resetData,
  setOrgCoords,
  setup,
  signedInAgent,
  submitApplication,
  verifiedAgent,
} from './helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const matches = (agent: Awaited<ReturnType<typeof verifiedAgent>>['agent'], id: string) => agent.get(`/api/v1/listings/${id}/matches`);
const reasonCodes = async (listingId: string, orgId: string | undefined) => {
  const r = await ctx.db.execute(sql`SELECT reasons FROM match_candidates WHERE listing_id = ${listingId}::uuid AND ngo_org_id = ${orgId}::uuid`);
  return ((r.rows[0] as { reasons: { code: string }[] } | undefined)?.reasons ?? []).map((x) => x.code);
};
const count = async (table: string) => ((await ctx.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0] as { n: number }).n;

describe('ranking and eligibility (provider view)', () => {
  it('ranks eligible NGOs by score, and explains every exclusion', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const listing = await availableListing(provider.agent);

    const near = await matchedNgo(ctx, { metersAway: 1000 });
    const mid = await matchedNgo(ctx, { metersAway: 3000 });
    const far = await matchedNgo(ctx, { metersAway: 4800 });
    const outsideService = await matchedNgo(ctx, { metersAway: 6000 }); // service radius is 5 km
    const platformOutside = await matchedNgo(ctx, { metersAway: 12000, requirement: { serviceRadiusKm: 50 } }); // beyond the 10 km platform radius
    const paused = await matchedNgo(ctx, { metersAway: 1500 });
    await paused.agent.post('/api/v1/ngo-requirements/current/pause').expect(200);
    const wrongCategory = await matchedNgo(ctx, { metersAway: 1500, requirement: { foodCategories: ['BAKERY'] } });
    const lowCapacity = await matchedNgo(ctx, { metersAway: 1500, requirement: { neededServings: 20, capacityServings: 30 } });
    const noCoords = await matchedNgo(ctx, { point: null });
    const unverified = await signedInAgent(ctx, 'ngo');
    await setOrgCoords(ctx, unverified.organizationId, await pointAt(ctx, PROVIDER_POINT, 500));

    // Make sure everything created after the last hook is reflected.
    await provider.agent.post(`/api/v1/listings/${listing.id}/matches/refresh`).expect(200);

    const res = await matches(provider.agent, listing.id);
    expect(res.status).toBe(200);
    const { candidates, excluded, listing: meta } = res.body.data;
    expect(meta).toMatchObject({ matchable: true, unavailableReason: null });
    expect(candidates.map((c: { organizationId: string }) => c.organizationId)).toEqual([near, mid, far].map((n) => n.organizationId));
    expect(candidates.map((c: { rank: number }) => c.rank)).toEqual([1, 2, 3]);
    const scores = candidates.map((c: { score: number }) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const c of candidates) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
      expect(Object.keys(c.breakdown).sort()).toEqual(['distance', 'need', 'quantity', 'reliability', 'urgency']);
      expect(c.reasons.length).toBeGreaterThan(0);
      expect(c.estimatedTravelMinutes).toBeGreaterThan(0);
      expect(typeof c.estimatedMarginMinutes).toBe('number');
    }
    expect(candidates[0].estimatedDistanceKm).toBeCloseTo(1.0, 1);
    expect(candidates[2].estimatedDistanceKm).toBeCloseTo(4.8, 1);
    expect(res.body.data.estimate.note).toMatch(/estimate/i);
    expect(res.body.data.estimate.basis).toBe('STRAIGHT_LINE_DISTANCE_ESTIMATE');

    // Provider sees why others were excluded, in aggregate and without organization names.
    const excludedCodes = excluded.map((e: { code: string }) => e.code).sort();
    expect(excludedCodes).toEqual(['CATEGORY_NOT_ACCEPTED', 'INSUFFICIENT_CAPACITY', 'INTAKE_PAUSED', 'NGO_NO_COORDINATES', 'OUTSIDE_SERVICE_RADIUS']);
    for (const e of excluded) expect(e.count).toBe(1);
    expect(res.body.data.excludedOrganizations).toBeUndefined();

    // Admins can additionally see which organizations were excluded and why.
    const admin = await signedInAgent(ctx, 'admin');
    const adminView = await matches(admin.agent, listing.id);
    expect(adminView.status).toBe(200);
    const byOrg = new Map(adminView.body.data.excludedOrganizations.map((e: { organizationId: string; reasons: { code: string }[] }) => [e.organizationId, e.reasons.map((r) => r.code)]));
    expect(byOrg.get(paused.organizationId!)).toContain('INTAKE_PAUSED');
    expect(byOrg.get(wrongCategory.organizationId!)).toContain('CATEGORY_NOT_ACCEPTED');
    expect(byOrg.get(lowCapacity.organizationId!)).toContain('INSUFFICIENT_CAPACITY');
    expect(byOrg.get(noCoords.organizationId!)).toContain('NGO_NO_COORDINATES');
    expect(byOrg.get(outsideService.organizationId!)).toContain('OUTSIDE_SERVICE_RADIUS');

    // Beyond the platform radius, and unverified NGOs, are not evaluated at all.
    const stored = (await dbCandidates(ctx, listing.id)).map((r) => r.ngo_org_id);
    expect(stored).not.toContain(platformOutside.organizationId);
    expect(stored).not.toContain(unverified.organizationId);
    expect(stored).toHaveLength(8);
  });

  it('applies dietary, availability-window and capacity filters from real requirements', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const listing = await availableListing(provider.agent, { dietaryTags: ['VEGETARIAN'] });
    const mustHaveHalal = await matchedNgo(ctx, { requirement: { dietaryMustHave: ['HALAL'] } });
    const avoidVeg = await matchedNgo(ctx, { requirement: { dietaryMustAvoid: ['VEGETARIAN'] } });
    const needsVeg = await matchedNgo(ctx, { requirement: { dietaryMustHave: ['VEGETARIAN'] } });
    const lateWindow = await matchedNgo(ctx, { requirement: { availableFrom: minutesFromNow(60 * 5), availableTo: minutesFromNow(60 * 24) } });
    const exactCapacity = await matchedNgo(ctx, { requirement: { neededServings: 45, capacityServings: 45 } });
    await provider.agent.post(`/api/v1/listings/${listing.id}/matches/refresh`).expect(200);

    expect(await reasonCodes(listing.id, mustHaveHalal.organizationId)).toEqual(['DIETARY_MISSING_REQUIRED']);
    expect(await reasonCodes(listing.id, avoidVeg.organizationId)).toEqual(['DIETARY_EXCLUDED']);
    expect(await reasonCodes(listing.id, lateWindow.organizationId)).toEqual(['WINDOW_NO_OVERLAP']);
    const eligible = (await dbCandidates(ctx, listing.id)).filter((r) => r.eligible).map((r) => r.ngo_org_id).sort();
    expect(eligible).toEqual([needsVeg.organizationId, exactCapacity.organizationId].sort());
  });

  it('rejects a requirement that both requires and excludes the same dietary tag', async () => {
    const ngo = await verifiedAgent(ctx, 'ngo');
    const res = await ngo.agent.post('/api/v1/ngo-requirements').send(requirementBody({ dietaryMustHave: ['HALAL'], dietaryMustAvoid: ['HALAL'] }));
    expect(res.status).toBe(400);
    expect(res.body.details.fields.dietaryMustAvoid).toMatch(/both required and excluded/);
    expect((await ngo.agent.post('/api/v1/ngo-requirements').send(requirementBody({ dietaryMustHave: ['SPICY'] }))).status).toBe(400);
  });

  it('rejects NGOs whose estimated trip does not fit before the pickup deadline', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    // 25 minutes to the deadline: a 5 km trip (about 17 min plus 20 min dispatch) cannot fit; 300 m can.
    const listing = await availableListing(provider.agent, { pickupStart: minutesFromNow(10), pickupDeadline: minutesFromNow(25) });
    const closeNgo = await matchedNgo(ctx, { metersAway: 300 });
    const farNgo = await matchedNgo(ctx, { metersAway: 5000, requirement: { serviceRadiusKm: 8 } });
    await provider.agent.post(`/api/v1/listings/${listing.id}/matches/refresh`).expect(200);
    expect(await reasonCodes(listing.id, farNgo.organizationId)).toEqual(['TIME_INFEASIBLE']);
    const eligible = (await dbCandidates(ctx, listing.id)).filter((r) => r.eligible).map((r) => r.ngo_org_id);
    expect(eligible).toEqual([closeNgo.organizationId]);
  });

  it('honours the platform search radius setting', async () => {
    const small = setup({ MATCH_SEARCH_RADIUS_KM: '2' });
    try {
      await resetData(small.db);
      const provider = await verifiedAgent(small, 'provider');
      const listing = await availableListing(provider.agent);
      const inside = await matchedNgo(small, { metersAway: 1990 });
      const outside = await matchedNgo(small, { metersAway: 2010 }); // inside its own 5 km radius, outside the platform's 2 km
      await provider.agent.post(`/api/v1/listings/${listing.id}/matches/refresh`).expect(200);
      const stored = (await dbCandidates(small, listing.id)).map((r) => r.ngo_org_id);
      expect(stored).toEqual([inside.organizationId]);
      expect(stored).not.toContain(outside.organizationId);
    } finally {
      await small.pool.end();
    }
  });
});

describe('deterministic ordering', () => {
  it('breaks equal scores by distance, then organization id, and is stable across runs', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const listing = await availableListing(provider.agent);
    // Same distance in opposite directions: identical scores; ties resolve by distance then id.
    const a = await matchedNgo(ctx, { metersAway: 2000, bearing: 90 });
    const b = await matchedNgo(ctx, { metersAway: 2000, bearing: 270 });
    const c = await matchedNgo(ctx, { metersAway: 2000, bearing: 0 });
    const orders: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await provider.agent.post(`/api/v1/listings/${listing.id}/matches/refresh`).expect(200);
      const res = await matches(provider.agent, listing.id);
      orders.push(res.body.data.candidates.map((x: { organizationId: string }) => x.organizationId));
      expect(res.body.data.candidates.map((x: { rank: number }) => x.rank)).toEqual([1, 2, 3]);
    }
    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
    expect(new Set(orders[0])).toEqual(new Set([a, b, c].map((n) => n.organizationId)));
    const rows = await dbCandidates(ctx, listing.id);
    // Rank order must equal the (score desc, distance asc, id asc) order.
    const expected = [...rows].sort((x, y) => y.score! - x.score! || x.distance_m! - y.distance_m! || (x.ngo_org_id < y.ngo_org_id ? -1 : 1)).map((r) => r.ngo_org_id);
    expect(rows.map((r) => r.ngo_org_id)).toEqual(expected);
  });
});

describe('listing states that must not be matched', () => {
  it('never matches drafts, expired or cancelled listings', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    await matchedNgo(ctx, { metersAway: 1000 });
    const draft = await createListing(provider.agent);
    const cancelled = await availableListing(provider.agent, { title: 'To cancel' });
    await provider.agent.post(`/api/v1/listings/${cancelled.id}/cancel`).send({ reason: 'Not needed' }).expect(200);
    const expired = await availableListing(provider.agent, { title: 'To expire' });
    await ctx.db.execute(sql`UPDATE food_listings SET pickup_deadline = now() - interval '1 minute', pickup_start = now() - interval '2 hours', prepared_at = now() - interval '3 hours' WHERE id = ${expired.id}::uuid`);

    const before = await dbCandidates(ctx, expired.id); // computed while it was still live
    for (const l of [draft, cancelled, expired]) {
      const refresh = await provider.agent.post(`/api/v1/listings/${l.id}/matches/refresh`);
      expect(refresh.status, l.id).toBe(409);
      expect(refresh.body.code).toBe('LISTING_NOT_MATCHABLE');
      const view = await matches(provider.agent, l.id);
      expect(view.body.data.listing).toMatchObject({ matchable: false, unavailableReason: 'LISTING_NOT_AVAILABLE' });
      expect(view.body.data.candidates).toEqual([]);
    }
    // A draft never had candidates, and refusing to refresh an expired listing leaves its old rows untouched.
    expect(await dbCandidates(ctx, draft.id)).toHaveLength(0);
    expect(await dbCandidates(ctx, expired.id)).toEqual(before);

    // The NGO's recommendations also never include them.
    const ngo = await matchedNgo(ctx, { metersAway: 800 });
    const rec = await ngo.agent.get('/api/v1/listings/recommended');
    expect(rec.body.data.listings).toEqual([]);
  });

  it('removes a listing from recommendations once it is cancelled or its deadline passes', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const l = await availableListing(provider.agent);
    expect((await ngo.agent.get('/api/v1/listings/recommended')).body.data.listings).toHaveLength(1);
    await ctx.db.execute(sql`UPDATE food_listings SET pickup_deadline = now() - interval '1 minute', pickup_start = now() - interval '2 hours', prepared_at = now() - interval '3 hours' WHERE id = ${l.id}::uuid`);
    // Stored candidate rows still exist, but expired listings are filtered out at read time.
    expect((await ngo.agent.get('/api/v1/listings/recommended')).body.data.listings).toEqual([]);
  });
});

describe('missing coordinates', () => {
  it('handles a listing without coordinates without crashing', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    await matchedNgo(ctx, { metersAway: 1000 });
    const l = await availableListing(provider.agent, { latitude: null, longitude: null });
    const view = await matches(provider.agent, l.id);
    expect(view.status).toBe(200);
    expect(view.body.data.listing).toMatchObject({ matchable: false, unavailableReason: 'LISTING_NO_COORDINATES' });
    expect(view.body.data.candidates).toEqual([]);
    const refresh = await provider.agent.post(`/api/v1/listings/${l.id}/matches/refresh`);
    expect(refresh.status).toBe(409);
    expect(refresh.body.details.reason).toBe('LISTING_NO_COORDINATES');
    expect(await dbCandidates(ctx, l.id)).toHaveLength(0);
    // Adding coordinates later enables matching.
    await provider.agent.patch(`/api/v1/listings/${l.id}`).send({ latitude: PROVIDER_POINT.latitude, longitude: PROVIDER_POINT.longitude }).expect(200);
    expect((await matches(provider.agent, l.id)).body.data.candidates).toHaveLength(1);
  });

  it('records an NGO without coordinates as ineligible with a clear reason, and never as a candidate', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(provider.agent);
    const ngo = await matchedNgo(ctx, { point: null });
    await provider.agent.post(`/api/v1/listings/${l.id}/matches/refresh`).expect(200);
    expect(await reasonCodes(l.id, ngo.organizationId)).toContain('NGO_NO_COORDINATES');
    expect((await matches(provider.agent, l.id)).body.data.candidates).toEqual([]);
    const rec = await ngo.agent.get('/api/v1/listings/recommended');
    expect(rec.body.data).toMatchObject({ state: 'NO_COORDINATES', listings: [] });
  });
});

describe('recomputation triggers', () => {
  it('recomputes on publish', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const draft = await createListing(provider.agent);
    expect(await dbCandidates(ctx, draft.id)).toHaveLength(0);
    await publishListing(provider.agent, draft.id).then((r) => expect(r.status).toBe(200));
    const rows = await dbCandidates(ctx, draft.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ngo_org_id: ngo.organizationId, eligible: true, rank: 1 });
  });

  it('recomputes when an available listing is edited', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 }); // capacity 60
    const l = await availableListing(provider.agent);
    expect((await ngo.agent.get('/api/v1/listings/recommended')).body.data.listings).toHaveLength(1);
    await provider.agent.patch(`/api/v1/listings/${l.id}`).send({ servings: 90 }).expect(200);
    expect(await reasonCodes(l.id, ngo.organizationId)).toEqual(['INSUFFICIENT_CAPACITY']);
    expect((await ngo.agent.get('/api/v1/listings/recommended')).body.data.listings).toEqual([]);
    await provider.agent.patch(`/api/v1/listings/${l.id}`).send({ servings: 50 }).expect(200);
    expect((await ngo.agent.get('/api/v1/listings/recommended')).body.data.listings).toHaveLength(1);
  });

  it('recomputes when an NGO requirement changes, pauses or resumes', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(provider.agent);
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const eligibleCount = async () => (await dbCandidates(ctx, l.id)).filter((r) => r.eligible).length;
    expect(await eligibleCount()).toBe(1);

    await ngo.agent.post('/api/v1/ngo-requirements/current/pause').expect(200);
    expect(await eligibleCount()).toBe(0);
    expect(await reasonCodes(l.id, ngo.organizationId)).toContain('INTAKE_PAUSED');
    const paused = await ngo.agent.get('/api/v1/listings/recommended');
    expect(paused.status).toBe(200);
    expect(paused.body.data).toMatchObject({ state: 'PAUSED', listings: [] });

    await ngo.agent.post('/api/v1/ngo-requirements/current/resume').expect(200);
    expect(await eligibleCount()).toBe(1);

    await ngo.agent.patch('/api/v1/ngo-requirements/current').send({ foodCategories: ['PRODUCE'] }).expect(200);
    expect(await eligibleCount()).toBe(0);
    await ngo.agent.patch('/api/v1/ngo-requirements/current').send({ foodCategories: ['COOKED_MEALS'] }).expect(200);
    expect(await eligibleCount()).toBe(1);
  });

  it('makes a newly approved NGO a candidate (ineligible until it has a requirement)', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(provider.agent);
    const applicant = await signedInAgent(ctx, 'ngo');
    const { submissionNumber } = await submitApplication(applicant.agent, applicant.organizationId!);
    expect(await dbCandidates(ctx, l.id)).toHaveLength(0); // unverified: not evaluated
    const admin = await signedInAgent(ctx, 'admin');
    await admin.agent.post(`/api/v1/admin/verifications/${applicant.organizationId}/decision`).send({ decision: 'APPROVE', submissionNumber }).expect(200);
    expect(await reasonCodes(l.id, applicant.organizationId)).toEqual(['NO_REQUIREMENT']);
    // Creating the requirement (the profile's coordinates are near the provider) makes it eligible.
    await applicant.agent.post('/api/v1/ngo-requirements').send(requirementBody()).expect(201);
    expect((await dbCandidates(ctx, l.id)).filter((r) => r.eligible)).toHaveLength(1);
  });

  it('offers explicit refresh actions to the owning provider, admins and verified NGOs', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const l = await availableListing(provider.agent);
    const own = await provider.agent.post(`/api/v1/listings/${l.id}/matches/refresh`);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ matchable: true, eligible: 1 });
    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.post(`/api/v1/listings/${l.id}/matches/refresh`)).status).toBe(200);
    const mine = await ngo.agent.post('/api/v1/listings/recommended/refresh');
    expect(mine.status).toBe(200);
    expect(mine.body.data.listingsRecomputed).toBeGreaterThanOrEqual(1);
  });
});

describe('idempotent recomputation', () => {
  it('does not duplicate candidates or notifications on retries or concurrent runs', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngos = [await matchedNgo(ctx, { metersAway: 1000 }), await matchedNgo(ctx, { metersAway: 2000 }), await matchedNgo(ctx, { point: null })];
    const l = await availableListing(provider.agent);

    const snapshot = async () => ({
      candidates: (await ctx.db.execute(sql`SELECT id, ngo_org_id, eligible, score, rank FROM match_candidates WHERE listing_id = ${l.id}::uuid ORDER BY ngo_org_id`)).rows,
      notifications: await count('notifications'),
    });
    const first = await snapshot();
    expect(first.candidates).toHaveLength(3);
    expect(first.notifications).toBe(2); // two eligible NGOs, one member each; the ineligible NGO is not notified

    const service = createMatchingService(ctx.db, ctx.config.match);
    await Promise.all([1, 2, 3, 4, 5].map(() => service.recomputeListing(l.id)));
    await provider.agent.post(`/api/v1/listings/${l.id}/matches/refresh`).expect(200);
    await ngos[0]!.agent.post('/api/v1/listings/recommended/refresh').expect(200);

    const after = await snapshot();
    expect(after.candidates).toEqual(first.candidates); // same row ids, scores and ranks: upserted, not duplicated
    expect(after.notifications).toBe(2);
    const dup = (await ctx.db.execute(sql`SELECT count(*)::int AS n FROM (SELECT dedupe_key FROM notifications GROUP BY dedupe_key HAVING count(*) > 1) t`)).rows[0] as { n: number };
    expect(dup.n).toBe(0);
    const notified = (await ctx.db.execute(sql`SELECT count(*) FILTER (WHERE notified_at IS NOT NULL)::int AS n FROM match_candidates WHERE listing_id = ${l.id}::uuid`)).rows[0] as { n: number };
    expect(notified.n).toBe(2);
  });

  it('notifies each eligible NGO member once, and only about that listing, without private details', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const other = await matchedNgo(ctx, { metersAway: 1000, requirement: { foodCategories: ['BAKERY'] } });
    await availableListing(provider.agent);
    const mine = await ngo.agent.get('/api/v1/notifications');
    expect(mine.status).toBe(200);
    expect(mine.body.data.unreadCount).toBe(1);
    expect(mine.body.data.notifications).toHaveLength(1);
    expect(mine.body.data.notifications[0]).toMatchObject({ type: 'LISTING_MATCH', entityType: 'listing' });
    expect(JSON.stringify(mine.body)).not.toMatch(/Secret Lane|Block C|18\.52043|73\.85674/);
    expect((await other.agent.get('/api/v1/notifications')).body.data.notifications).toEqual([]);
    expect((await provider.agent.get('/api/v1/notifications')).body.data.notifications).toEqual([]);
    expect((await request(ctx.app).get('/api/v1/notifications')).status).toBe(401);
  });

  it('does not re-notify when a listing is edited and stays eligible', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    await matchedNgo(ctx, { metersAway: 1000 });
    const l = await availableListing(provider.agent);
    await provider.agent.patch(`/api/v1/listings/${l.id}`).send({ servings: 44 }).expect(200);
    await provider.agent.patch(`/api/v1/listings/${l.id}`).send({ title: 'Renamed biryani' }).expect(200);
    expect(await count('notifications')).toBe(1);
  });
});

describe('authorization of match views', () => {
  it('limits candidate views to the owning provider and admins', async () => {
    const owner = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(owner.agent);
    const url = `/api/v1/listings/${l.id}/matches`;
    expect((await owner.agent.get(url)).status).toBe(200);
    expect((await (await signedInAgent(ctx, 'admin')).agent.get(url)).status).toBe(200);
    expect((await (await verifiedAgent(ctx, 'provider')).agent.get(url)).status).toBe(404);
    expect((await (await verifiedAgent(ctx, 'ngo')).agent.get(url)).status).toBe(404);
    expect((await (await signedInAgent(ctx, 'runner')).agent.get(url)).status).toBe(404);
    expect((await request(ctx.app).get(url)).status).toBe(401);
    expect((await owner.agent.get('/api/v1/listings/not-a-uuid/matches')).status).toBe(404);
    // Refresh follows the same rules.
    expect((await (await verifiedAgent(ctx, 'provider')).agent.post(`${url}/refresh`)).status).toBe(404);
    expect((await (await verifiedAgent(ctx, 'ngo')).agent.post(`${url}/refresh`)).status).toBe(404);
    expect((await request(ctx.app).post(`${url}/refresh`)).status).toBe(401);
  });

  it('limits recommendations to verified NGO members', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    await availableListing(provider.agent);
    const url = '/api/v1/listings/recommended';
    expect((await request(ctx.app).get(url)).status).toBe(401);
    const unverified = await signedInAgent(ctx, 'ngo');
    const blocked = await unverified.agent.get(url);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('ORGANIZATION_NOT_VERIFIED');
    expect((await unverified.agent.post(`${url}/refresh`)).status).toBe(403);
    for (const role of ['provider', 'runner', 'admin'] as const) {
      expect((await (await signedInAgent(ctx, role)).agent.get(url)).status, role).toBe(403);
    }
    const noRequirement = await verifiedAgent(ctx, 'ngo');
    expect((await noRequirement.agent.get(url)).body.data).toMatchObject({ state: 'NO_REQUIREMENT', listings: [] });
  });

  it('reports an NGO whose availability window has ended', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    await availableListing(provider.agent);
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    await ctx.db.execute(sql`UPDATE ngo_requirements SET available_from = now() - interval '2 days', available_to = now() - interval '1 hour'`);
    expect((await ngo.agent.get('/api/v1/listings/recommended')).body.data).toMatchObject({ state: 'WINDOW_ENDED', listings: [] });
  });

  it('does not let one NGO see another NGO\'s scores', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const a = await matchedNgo(ctx, { metersAway: 1000 });
    const b = await matchedNgo(ctx, { metersAway: 3000 });
    await availableListing(provider.agent);
    const ra = (await a.agent.get('/api/v1/listings/recommended')).body.data.listings;
    const rb = (await b.agent.get('/api/v1/listings/recommended')).body.data.listings;
    expect(ra).toHaveLength(1);
    expect(rb).toHaveLength(1);
    expect(ra[0].match.rankAmongCandidates).toBe(1);
    expect(rb[0].match.rankAmongCandidates).toBe(2);
    expect(ra[0].match.score).toBeGreaterThan(rb[0].match.score);
    expect(JSON.stringify(ra)).not.toContain(b.organizationId);
  });
});

describe('private data redaction', () => {
  it('keeps NGO contact and address details out of the provider candidate view', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    await ctx.db.execute(sql`UPDATE organizations SET contact_email = 'ngo-secret@example.test', contact_phone = '+91 90000 11111', contact_name = 'Hidden Person', address_line = '9 Hidden NGO Road' WHERE id = ${ngo.organizationId}::uuid`);
    const l = await availableListing(provider.agent);
    const res = await matches(provider.agent, l.id);
    expect(res.body.data.candidates).toHaveLength(1);
    const raw = JSON.stringify(res.body);
    for (const secret of ['ngo-secret@example.test', '90000 11111', 'Hidden Person', 'Hidden NGO Road', 'contactEmail', 'addressLine', 'latitude', 'longitude']) {
      expect(raw, secret).not.toContain(secret);
    }
    expect(res.body.data.candidates[0].organizationName).toBe('Test ngo org');
  });

  it('keeps the provider exact address, exact coordinates and contacts out of NGO recommendations', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    await ctx.db.execute(sql`UPDATE organizations SET contact_email = 'provider-secret@example.test', contact_phone = '+91 99999 22222' WHERE id = ${provider.organizationId}::uuid`);
    await availableListing(provider.agent);
    const res = await ngo.agent.get('/api/v1/listings/recommended');
    expect(res.body.data.listings).toHaveLength(1);
    const raw = JSON.stringify(res.body);
    for (const secret of ['12 Secret Lane', 'Block C', '18.52043', '73.85674', 'provider-secret@example.test', '99999 22222', 'addressLine', 'declaration', 'providerOrgId']) {
      expect(raw, secret).not.toContain(secret);
    }
    const item = res.body.data.listings[0];
    expect(item.approximateArea).toEqual({ city: 'Pune', latitude: 18.52, longitude: 73.86 });
    expect(item.match.estimatedDistanceKm).toBeCloseTo(1.0, 1);
    expect(item.urgency).toBeDefined();
    expect(item.match.reasons.join(' ')).toMatch(/estimated/i);
    expect(res.body.data.estimate.note).toMatch(/not routes/i);
  });
});

describe('reliability uses the neutral default (no rescue history exists)', () => {
  it('stores a neutral reliability component for every candidate', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    await matchedNgo(ctx, { metersAway: 1000 });
    await matchedNgo(ctx, { metersAway: 2000 });
    const l = await availableListing(provider.agent);
    const res = await matches(provider.agent, l.id);
    for (const c of res.body.data.candidates) {
      expect(c.breakdown.reliability).toMatchObject({ score: 50, weight: 10, points: 5 });
      expect(c.reasons.join(' ')).toMatch(/neutral reliability/i);
    }
  });
});

describe('listing form unchanged by matching', () => {
  it('still validates listings as before (coordinates remain optional)', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const res = await provider.agent.post('/api/v1/listings').send(listingBody({ latitude: undefined, longitude: undefined }));
    expect(res.status).toBe(201);
  });
});

describe('adding coordinates to a verified NGO', () => {
  it('lets a verified NGO add missing coordinates once, which refreshes its recommendations', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    await availableListing(provider.agent);
    const ngo = await matchedNgo(ctx, { point: null });
    expect((await ngo.agent.get('/api/v1/listings/recommended')).body.data).toMatchObject({ state: 'NO_COORDINATES', listings: [] });

    const p = await pointAt(ctx, PROVIDER_POINT, 1500);
    const base = `/api/v1/organizations/${ngo.organizationId}`;
    expect((await ngo.agent.patch(base).send({ latitude: p.latitude, longitude: p.longitude })).status).toBe(200);
    const rec = (await ngo.agent.get('/api/v1/listings/recommended')).body.data;
    expect(rec.state).toBe('ACTIVE');
    expect(rec.listings).toHaveLength(1);
    expect(rec.listings[0].match.estimatedDistanceKm).toBeCloseTo(1.5, 1);

    // After verification the map position can still be corrected (and matching follows it), but never half cleared, and the name stays locked.
    const moved = await ngo.agent.patch(base).send({ latitude: 10, longitude: 10 });
    expect(moved.status).toBe(200);
    expect(moved.body.data.organization).toMatchObject({ latitude: 10, longitude: 10, verificationStatus: 'VERIFIED' });
    expect((await ngo.agent.get('/api/v1/listings/recommended')).body.data.listings).toHaveLength(0);
    expect((await ngo.agent.patch(base).send({ latitude: null })).status).toBe(400);
    const back = await ngo.agent.patch(base).send({ latitude: p.latitude, longitude: p.longitude });
    expect(back.status).toBe(200);
    expect((await ngo.agent.get('/api/v1/listings/recommended')).body.data.listings).toHaveLength(1);
    const renamed = await ngo.agent.patch(base).send({ name: 'New name' });
    expect(renamed.status).toBe(409);
    expect(renamed.body.code).toBe('ORGANIZATION_LOCKED');
  });
});
