import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expireListings } from '../src/modules/listings/expiry.js';
import { availableListing, createListing, resetData, setup, verifiedAgent } from './helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const lapse = (id: string) =>
  ctx.db.execute(sql`UPDATE food_listings SET pickup_deadline = now() - interval '1 minute', pickup_start = now() - interval '2 hours', prepared_at = now() - interval '3 hours' WHERE id = ${id}::uuid`);

const row = async (id: string) =>
  (await ctx.db.execute(sql`SELECT status, expired_at FROM food_listings WHERE id = ${id}::uuid`)).rows[0] as { status: string; expired_at: Date | null };
const eventCount = async (action: string) =>
  ((await ctx.db.execute(sql`SELECT count(*)::int AS n FROM listing_events WHERE action = ${action}::listing_event_action`)).rows[0] as { n: number }).n;

describe('expiry worker', () => {
  it('expires only available listings past their deadline, and records history', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const due = await availableListing(agent);
    const future = await availableListing(agent);
    const draft = await createListing(agent);
    const cancelled = await availableListing(agent);
    await agent.post(`/api/v1/listings/${cancelled.id}/cancel`).send({ reason: 'Not needed' });
    await lapse(due.id);
    await lapse(draft.id); // a lapsed draft is never "expired": it was never available
    await lapse(cancelled.id);

    expect(await expireListings(ctx.db)).toBe(1);
    expect(await row(due.id)).toMatchObject({ status: 'EXPIRED' });
    expect((await row(due.id)).expired_at).toBeTruthy();
    expect(await row(future.id)).toMatchObject({ status: 'AVAILABLE' });
    expect(await row(draft.id)).toMatchObject({ status: 'DRAFT' });
    expect(await row(cancelled.id)).toMatchObject({ status: 'CANCELLED' });
    expect(await eventCount('EXPIRED')).toBe(1);

    const history = (await agent.get(`/api/v1/listings/${due.id}/history`)).body.data.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['EXPIRED', 'PUBLISHED']);
  });

  it('is idempotent: repeated runs change nothing and add no duplicate events', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(agent);
    await lapse(l.id);
    expect(await expireListings(ctx.db)).toBe(1);
    const first = await row(l.id);
    expect(await expireListings(ctx.db)).toBe(0);
    expect(await expireListings(ctx.db)).toBe(0);
    expect(await row(l.id)).toEqual(first);
    expect(await eventCount('EXPIRED')).toBe(1);
  });

  it('expires each listing exactly once even when runs overlap', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await availableListing(agent, { title: `Meal ${i}` })).id);
    for (const id of ids) await lapse(id);
    const counts = await Promise.all([expireListings(ctx.db), expireListings(ctx.db), expireListings(ctx.db)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(4);
    expect(await eventCount('EXPIRED')).toBe(4);
  });

  it('honors an injected clock (deadline boundary is inclusive)', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(agent);
    const deadline = new Date((await ctx.db.execute(sql`SELECT pickup_deadline FROM food_listings WHERE id = ${l.id}::uuid`)).rows[0]!.pickup_deadline as string);
    expect(await expireListings(ctx.db, new Date(deadline.getTime() - 1))).toBe(0);
    expect(await expireListings(ctx.db, deadline)).toBe(1);
  });

  it('is not needed for correctness: reads already treat a lapsed listing as expired', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const ngo = await verifiedAgent(ctx, 'ngo');
    const l = await availableListing(agent);
    await lapse(l.id);
    expect(await row(l.id)).toMatchObject({ status: 'AVAILABLE' }); // worker has not run
    expect((await agent.get(`/api/v1/listings/${l.id}`)).body.data.listing).toMatchObject({ status: 'EXPIRED', editable: false });
    expect((await ngo.agent.get('/api/v1/listings/feed')).body.data.listings).toHaveLength(0);
    expect((await agent.get('/api/v1/listings?scope=active')).body.data.listings).toHaveLength(0);
    expect((await agent.get('/api/v1/listings?scope=past')).body.data.listings).toHaveLength(1);
  });
});
