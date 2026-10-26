import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  availableListing,
  createListing,
  minutesFromNow,
  resetData,
  setup,
  signedInAgent,
  verifiedAgent,
} from './helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const FEED = '/api/v1/listings/feed';

describe('NGO live listing feed: access', () => {
  it('requires a signed-in, verified NGO member', async () => {
    expect((await request(ctx.app).get(FEED)).status).toBe(401);

    const unverified = await signedInAgent(ctx, 'ngo');
    const blocked = await unverified.agent.get(FEED);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('ORGANIZATION_NOT_VERIFIED');

    for (const role of ['provider', 'runner', 'admin'] as const) {
      const other = await signedInAgent(ctx, role);
      expect((await other.agent.get(FEED)).status, role).toBe(403);
    }

    const ngo = await verifiedAgent(ctx, 'ngo');
    expect((await ngo.agent.get(FEED)).status).toBe(200);
  });

  // A REJECTED application is no longer a "current" organization, so the feed asks for a new profile (409).
  it.each([['UNDER_REVIEW', 403], ['REJECTED', 409], ['RESUBMISSION_REQUESTED', 403]] as const)('stays closed to a %s NGO', async (status, expected) => {
    const { agent, organizationId } = await signedInAgent(ctx, 'ngo');
    await ctx.db.execute(sql`UPDATE organizations SET verification_status = ${status}::verification_status WHERE id = ${organizationId}::uuid`);
    expect((await agent.get(FEED)).status).toBe(expected);
  });
});

describe('NGO live listing feed: content', () => {
  it('shows only live AVAILABLE listings, soonest deadline first', async () => {
    const p = await verifiedAgent(ctx, 'provider');
    const ngo = await verifiedAgent(ctx, 'ngo');

    await createListing(p.agent, { title: 'A draft' });
    const cancelled = await availableListing(p.agent, { title: 'Cancelled' });
    await p.agent.post(`/api/v1/listings/${cancelled.id}/cancel`).send({ reason: 'Not available' });
    const lapsed = await availableListing(p.agent, { title: 'Lapsed' });
    await ctx.db.execute(sql`UPDATE food_listings SET pickup_deadline = now() - interval '1 minute', pickup_start = now() - interval '2 hours', prepared_at = now() - interval '3 hours' WHERE id = ${lapsed.id}::uuid`);
    await availableListing(p.agent, { title: 'Later', pickupDeadline: minutesFromNow(300) });
    await availableListing(p.agent, { title: 'Sooner', pickupDeadline: minutesFromNow(60) });

    const res = await ngo.agent.get(FEED);
    expect(res.status).toBe(200);
    expect(res.body.data.listings.map((l: { title: string }) => l.title)).toEqual(['Sooner', 'Later']);
    for (const l of res.body.data.listings) expect(l.status).toBe('AVAILABLE');
    expect(res.body.data.listings[0].urgency).toBe('URGENT');
  });

  it('omits listings from non-verified provider organizations and filters by category', async () => {
    const p = await verifiedAgent(ctx, 'provider');
    const ngo = await verifiedAgent(ctx, 'ngo');
    await availableListing(p.agent, { title: 'Meals', foodCategory: 'COOKED_MEALS' });
    await availableListing(p.agent, { title: 'Bread', foodCategory: 'BAKERY' });
    const res = await ngo.agent.get(`${FEED}?category=BAKERY`);
    expect(res.body.data.listings.map((l: { title: string }) => l.title)).toEqual(['Bread']);
    expect((await ngo.agent.get(`${FEED}?category=PIZZA`)).status).toBe(400);

    await ctx.db.execute(sql`UPDATE organizations SET verification_status = 'UNDER_REVIEW' WHERE id = ${p.organizationId}::uuid`);
    expect((await ngo.agent.get(FEED)).body.data.listings).toHaveLength(0);
  });

  it('is empty (not an error) when nothing is live', async () => {
    const ngo = await verifiedAgent(ctx, 'ngo');
    const res = await ngo.agent.get(FEED);
    expect(res.status).toBe(200);
    expect(res.body.data.listings).toEqual([]);
  });
});

describe('private address redaction', () => {
  it('never exposes the exact address, coordinates or provider contact details to NGOs', async () => {
    const p = await verifiedAgent(ctx, 'provider');
    const ngo = await verifiedAgent(ctx, 'ngo');
    const l = await availableListing(p.agent);
    await ctx.db.execute(sql`UPDATE organizations SET contact_email = 'secret-contact@example.test', contact_phone = '+91 99999 11111', contact_name = 'Secret Person' WHERE id = ${p.organizationId}::uuid`);

    const feed = await ngo.agent.get(FEED);
    const detail = await ngo.agent.get(`/api/v1/listings/${l.id}`);
    for (const res of [feed, detail]) {
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      for (const secret of ['12 Secret Lane', 'Block C', '18.52043', '73.85674', 'secret-contact', '99999 11111', 'Secret Person', 'addressLine', 'declaration', 'cancellation', 'imageKey', 'providerOrgId']) {
        expect(raw, secret).not.toContain(secret);
      }
    }
    const item = feed.body.data.listings[0];
    expect(item.approximateArea).toEqual({ city: 'Pune', latitude: 18.52, longitude: 73.86 });
    expect(item.providerName).toBe('Test provider org');
    expect(detail.body.data.listing).toMatchObject({ title: 'Vegetable Biryani', servings: 45 });

    // The owner still sees everything.
    const own = await p.agent.get(`/api/v1/listings/${l.id}`);
    expect(own.body.data.listing).toMatchObject({ addressLine: '12 Secret Lane, Block C', latitude: 18.52043 });
  });

  it('does not let NGOs read non-live listings by id', async () => {
    const p = await verifiedAgent(ctx, 'provider');
    const ngo = await verifiedAgent(ctx, 'ngo');
    const cancelled = await availableListing(p.agent);
    await p.agent.post(`/api/v1/listings/${cancelled.id}/cancel`).send({ reason: 'Gone' });
    expect((await ngo.agent.get(`/api/v1/listings/${cancelled.id}`)).status).toBe(404);
    const lapsed = await availableListing(p.agent);
    await ctx.db.execute(sql`UPDATE food_listings SET pickup_deadline = now() - interval '1 minute', pickup_start = now() - interval '2 hours', prepared_at = now() - interval '3 hours' WHERE id = ${lapsed.id}::uuid`);
    expect((await ngo.agent.get(`/api/v1/listings/${lapsed.id}`)).status).toBe(404);
  });

  it('keeps NGO and provider writes separate: an NGO cannot modify or cancel listings', async () => {
    const p = await verifiedAgent(ctx, 'provider');
    const ngo = await verifiedAgent(ctx, 'ngo');
    const l = await availableListing(p.agent);
    expect((await ngo.agent.patch(`/api/v1/listings/${l.id}`).send({ title: 'Hijacked title' })).status).toBe(404);
    expect((await ngo.agent.post(`/api/v1/listings/${l.id}/cancel`).send({ reason: 'xyz' })).status).toBe(404);
    expect((await ngo.agent.get(`/api/v1/listings/${l.id}/history`)).status).toBe(404);
  });
});
