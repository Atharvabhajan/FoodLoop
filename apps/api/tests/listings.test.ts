import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { urgencyFor } from '../src/modules/listings/constants.js';
import { effectiveStatus, nextListingStatus } from '../src/modules/listings/lifecycle.js';
import {
  availableListing,
  createListing,
  listingBody,
  minutesFromNow,
  publishListing,
  resetData,
  setup,
  signedInAgent,
  verifiedAgent,
} from './helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const expireInDb = (id: string) =>
  ctx.db.execute(sql`UPDATE food_listings SET pickup_deadline = now() - interval '1 minute', pickup_start = now() - interval '2 hours', prepared_at = now() - interval '3 hours' WHERE id = ${id}::uuid`);

describe('listing lifecycle rules (pure)', () => {
  it('allows only DRAFT→AVAILABLE→EXPIRED and DRAFT/AVAILABLE→CANCELLED', () => {
    expect(nextListingStatus('DRAFT', 'PUBLISH')).toBe('AVAILABLE');
    expect(nextListingStatus('DRAFT', 'CANCEL')).toBe('CANCELLED');
    expect(nextListingStatus('AVAILABLE', 'CANCEL')).toBe('CANCELLED');
    expect(nextListingStatus('AVAILABLE', 'EXPIRE')).toBe('EXPIRED');
    for (const s of ['AVAILABLE', 'CANCELLED', 'EXPIRED'] as const) expect(nextListingStatus(s, 'PUBLISH')).toBeNull();
    for (const s of ['CANCELLED', 'EXPIRED'] as const) expect(nextListingStatus(s, 'CANCEL')).toBeNull();
    expect(nextListingStatus('DRAFT', 'EXPIRE')).toBeNull();
  });

  it('treats an AVAILABLE listing past its deadline as EXPIRED without any worker', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    expect(effectiveStatus({ status: 'AVAILABLE', pickupDeadline: new Date('2026-10-25T11:59:59Z') }, now)).toBe('EXPIRED');
    expect(effectiveStatus({ status: 'AVAILABLE', pickupDeadline: new Date('2026-10-25T12:00:01Z') }, now)).toBe('AVAILABLE');
    expect(effectiveStatus({ status: 'DRAFT', pickupDeadline: new Date('2026-10-25T11:00:00Z') }, now)).toBe('DRAFT');
  });

  it('buckets urgency by remaining time (spec appendix A)', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    const at = (m: number) => new Date(now.getTime() + m * 60_000);
    expect(urgencyFor(at(121), now)).toBe('NORMAL');
    expect(urgencyFor(at(90), now)).toBe('PRIORITY');
    expect(urgencyFor(at(45), now)).toBe('URGENT');
    expect(urgencyFor(at(10), now)).toBe('CRITICAL');
    expect(urgencyFor(at(0), now)).toBe('EXPIRED');
  });
});

describe('creating and validating listings', () => {
  it('creates a DRAFT with every captured field', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const res = await agent.post('/api/v1/listings').send(listingBody());
    expect(res.status).toBe(201);
    expect(res.body.data.listing).toMatchObject({
      providerOrgId: organizationId,
      title: 'Vegetable Biryani',
      foodCategory: 'COOKED_MEALS',
      servings: 45,
      estimatedKg: 18,
      addressLine: '12 Secret Lane, Block C',
      city: 'Pune',
      packaging: 'INDIVIDUAL_BOXES',
      dietaryTags: ['VEGETARIAN'],
      transportRequired: true,
      status: 'DRAFT',
      hasImage: false,
      editable: true,
      publishedAt: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/imageKey|image_key|storage/i);
  });

  it('rejects invalid servings and weight', async () => {
    const { agent } = await signedInAgent(ctx, 'provider');
    for (const servings of [0, -5, 1.5, '12', null]) {
      const res = await agent.post('/api/v1/listings').send(listingBody({ servings }));
      expect(res.status, String(servings)).toBe(400);
      expect(res.body.details.fields.servings).toBeDefined();
    }
    for (const estimatedKg of [0, -1]) {
      const res = await agent.post('/api/v1/listings').send(listingBody({ estimatedKg }));
      expect(res.status).toBe(400);
      expect(res.body.details.fields.estimatedKg).toBeDefined();
    }
    expect((await agent.post('/api/v1/listings').send(listingBody({ estimatedKg: null }))).status).toBe(201);
  });

  it('reports every missing required field', async () => {
    const { agent } = await signedInAgent(ctx, 'provider');
    const res = await agent.post('/api/v1/listings').send({});
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.details.fields)).toEqual(
      expect.arrayContaining(['title', 'foodCategory', 'servings', 'preparedAt', 'pickupStart', 'pickupDeadline', 'addressLine', 'city', 'packaging', 'transportRequired']),
    );
  });

  it('validates dates and the pickup window', async () => {
    const { agent } = await signedInAgent(ctx, 'provider');
    const post = (o: Record<string, unknown>) => agent.post('/api/v1/listings').send(listingBody(o));
    expect((await post({ pickupDeadline: 'tomorrow' })).body.details.fields.pickupDeadline).toMatch(/valid date/);
    expect((await post({ pickupStart: minutesFromNow(120), pickupDeadline: minutesFromNow(60) })).body.details.fields.pickupDeadline).toMatch(/after the pickup start/);
    expect((await post({ preparedAt: minutesFromNow(60) })).body.details.fields.preparedAt).toMatch(/cannot be in the future/);
    expect((await post({ preparedAt: minutesFromNow(400) })).body.details.fields.preparedAt).toBeDefined();
    expect((await post({ latitude: 10, longitude: null })).body.details.fields.longitude).toMatch(/both/i);
    expect((await post({ latitude: 95, longitude: 10 })).status).toBe(400);
  });

  it('rejects unknown fields, bad enums, and client-set status', async () => {
    const { agent } = await signedInAgent(ctx, 'provider');
    for (const extra of [{ status: 'AVAILABLE' }, { providerOrgId: '00000000-0000-4000-8000-000000000000' }, { foodCategory: 'PIZZA' }, { packaging: 'BAG' }, { dietaryTags: ['MAGIC'] }, { dietaryTags: ['VEGAN', 'VEGAN'] }]) {
      expect((await agent.post('/api/v1/listings').send(listingBody(extra))).status).toBe(400);
    }
  });

  it('is limited to provider users', async () => {
    const ngo = await signedInAgent(ctx, 'ngo');
    expect((await ngo.agent.post('/api/v1/listings').send(listingBody())).status).toBe(403);
    const runner = await signedInAgent(ctx, 'runner');
    expect((await runner.agent.post('/api/v1/listings').send(listingBody())).status).toBe(403);
    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.post('/api/v1/listings').send(listingBody())).status).toBe(403);
    expect((await request(ctx.app).post('/api/v1/listings').send(listingBody())).status).toBe(401);
  });
});

describe('publishing', () => {
  it('requires a verified Provider organization', async () => {
    const { agent } = await signedInAgent(ctx, 'provider'); // UNSUBMITTED
    const l = await createListing(agent); // drafting is allowed
    const res = await publishListing(agent, l.id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORGANIZATION_NOT_VERIFIED');
    expect((await agent.get(`/api/v1/listings/${l.id}`)).body.data.listing.status).toBe('DRAFT');
  });

  it.each(['UNDER_REVIEW', 'REJECTED', 'RESUBMISSION_REQUESTED'])('blocks publishing for a %s organization', async (status) => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const l = await createListing(agent);
    await ctx.db.execute(sql`UPDATE organizations SET verification_status = ${status}::verification_status WHERE id = ${organizationId}::uuid`);
    expect((await publishListing(agent, l.id)).status).toBe(403);
  });

  it('publishes a valid draft for a verified provider, recording the declaration and history', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await createListing(agent);
    const res = await publishListing(agent, l.id);
    expect(res.status).toBe(200);
    expect(res.body.data.listing).toMatchObject({ status: 'AVAILABLE', editable: true });
    expect(res.body.data.listing.publishedAt).toBeTruthy();
    expect(res.body.data.listing.declarationAcceptedAt).toBeTruthy();
    expect(['NORMAL', 'PRIORITY']).toContain(res.body.data.listing.urgency);
    const history = (await agent.get(`/api/v1/listings/${l.id}/history`)).body.data.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['PUBLISHED']);
  });

  it('requires the explicit declaration', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await createListing(agent);
    for (const body of [{}, { declarationAccepted: false }, { declarationAccepted: 'yes' }]) {
      const res = await agent.post(`/api/v1/listings/${l.id}/publish`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.details.fields.declarationAccepted).toBeDefined();
    }
    const decl = await agent.get('/api/v1/listings/declaration');
    expect(decl.body.data.declaration).toMatch(/prepared within the stated time/);
  });

  it('refuses a deadline that is past or less than 15 minutes away', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const past = await createListing(agent, { pickupStart: minutesFromNow(-120), pickupDeadline: minutesFromNow(-10), preparedAt: minutesFromNow(-180) });
    const r1 = await publishListing(agent, past.id);
    expect(r1.status).toBe(400);
    expect(r1.body.details.fields.pickupDeadline).toMatch(/at least 15 minutes/);
    const soon = await createListing(agent, { pickupStart: minutesFromNow(-20), pickupDeadline: minutesFromNow(5) });
    expect((await publishListing(agent, soon.id)).status).toBe(400);
    expect((await agent.get(`/api/v1/listings/${soon.id}`)).body.data.listing.status).toBe('DRAFT');
  });

  it('cannot be published twice or after cancellation', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(agent);
    const again = await publishListing(agent, l.id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATUS_TRANSITION');
    const d = await createListing(agent);
    await agent.post(`/api/v1/listings/${d.id}/cancel`).send({ reason: 'Changed plans' }).expect(200);
    expect((await publishListing(agent, d.id)).status).toBe(409);
  });
});

describe('editing', () => {
  it('edits drafts and available listings, re-validating the result', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const draft = await createListing(agent);
    const e1 = await agent.patch(`/api/v1/listings/${draft.id}`).send({ servings: 50, title: 'Veg Biryani (updated)' });
    expect(e1.status).toBe(200);
    expect(e1.body.data.listing).toMatchObject({ servings: 50, title: 'Veg Biryani (updated)', status: 'DRAFT' });

    await publishListing(agent, draft.id).then((r) => expect(r.status).toBe(200));
    const e2 = await agent.patch(`/api/v1/listings/${draft.id}`).send({ servings: 44, description: null });
    expect(e2.status).toBe(200);
    expect(e2.body.data.listing).toMatchObject({ servings: 44, description: null, status: 'AVAILABLE' });

    const bad = await agent.patch(`/api/v1/listings/${draft.id}`).send({ servings: 0 });
    expect(bad.status).toBe(400);
    const pastDeadline = await agent.patch(`/api/v1/listings/${draft.id}`).send({ pickupDeadline: minutesFromNow(-5) });
    expect(pastDeadline.status).toBe(400);
    expect((await agent.patch(`/api/v1/listings/${draft.id}`).send({ pickupStart: minutesFromNow(500) })).status).toBe(400);
    expect((await agent.patch(`/api/v1/listings/${draft.id}`).send({ status: 'CANCELLED' })).status).toBe(400);
    expect((await agent.patch(`/api/v1/listings/${draft.id}`).send({})).status).toBe(400);
  });

  it('locks cancelled and expired listings', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const c = await availableListing(agent);
    await agent.post(`/api/v1/listings/${c.id}/cancel`).send({ reason: 'Food spoiled' }).expect(200);
    const r1 = await agent.patch(`/api/v1/listings/${c.id}`).send({ title: 'New title' });
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('LISTING_LOCKED');

    const e = await availableListing(agent);
    await expireInDb(e.id); // deadline passed; the worker has NOT run, status column still AVAILABLE
    const r2 = await agent.patch(`/api/v1/listings/${e.id}`).send({ title: 'Too late' });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('LISTING_EXPIRED');
  });
});

describe('cancellation', () => {
  it('requires a reason and records it in history', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(agent);
    for (const body of [{}, { reason: '' }, { reason: '  ' }, { reason: 'ab' }]) {
      const res = await agent.post(`/api/v1/listings/${l.id}/cancel`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.details.fields.reason).toBeDefined();
    }
    const ok = await agent.post(`/api/v1/listings/${l.id}/cancel`).send({ reason: 'Kitchen closed early' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.listing).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Kitchen closed early', editable: false });
    const history = (await agent.get(`/api/v1/listings/${l.id}/history`)).body.data.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['CANCELLED', 'PUBLISHED']);
    expect(history[0].reason).toBe('Kitchen closed early');
  });

  it('cannot cancel twice or cancel an expired listing; drafts can be cancelled', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(agent);
    await agent.post(`/api/v1/listings/${l.id}/cancel`).send({ reason: 'Changed plans' }).expect(200);
    const twice = await agent.post(`/api/v1/listings/${l.id}/cancel`).send({ reason: 'Changed plans' });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_STATUS_TRANSITION');

    const e = await availableListing(agent);
    await expireInDb(e.id);
    expect((await agent.post(`/api/v1/listings/${e.id}/cancel`).send({ reason: 'Changed plans' })).body.code).toBe('LISTING_EXPIRED');

    const d = await createListing(agent);
    expect((await agent.post(`/api/v1/listings/${d.id}/cancel`).send({ reason: 'Not needed' })).status).toBe(200);
  });

  it('history is append-only in the database', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(agent);
    await expect(ctx.db.execute(sql`UPDATE listing_events SET reason = 'x'`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`DELETE FROM listing_events`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`DELETE FROM food_listings WHERE id = ${l.id}::uuid`)).rejects.toThrow();
  });
});

describe('provider list scopes', () => {
  it('separates active (drafts + live) from past (cancelled + expired), including not-yet-recorded expiry', async () => {
    const { agent } = await verifiedAgent(ctx, 'provider');
    const draft = await createListing(agent, { title: 'Draft one' });
    const live = await availableListing(agent, { title: 'Live one' });
    const cancelled = await availableListing(agent, { title: 'Cancelled one' });
    await agent.post(`/api/v1/listings/${cancelled.id}/cancel`).send({ reason: 'Nope' });
    const lapsed = await availableListing(agent, { title: 'Lapsed one' });
    await expireInDb(lapsed.id); // status column still AVAILABLE

    const titles = async (scope: string) =>
      ((await agent.get(`/api/v1/listings?scope=${scope}`)).body.data.listings as { title: string; status: string }[]).map((l) => `${l.title}:${l.status}`).sort();
    expect(await titles('active')).toEqual(['Draft one:DRAFT', 'Live one:AVAILABLE']);
    expect(await titles('past')).toEqual(['Cancelled one:CANCELLED', 'Lapsed one:EXPIRED']);
    expect((await titles('all')).length).toBe(4);
    expect((await agent.get('/api/v1/listings?scope=nope')).status).toBe(400);
    void draft; void live;
  });
});

describe('cross-organization access', () => {
  it("denies another provider's reads and writes (404) and keeps data unchanged", async () => {
    const a = await verifiedAgent(ctx, 'provider');
    const b = await verifiedAgent(ctx, 'provider');
    const l = await availableListing(a.agent);
    const base = `/api/v1/listings/${l.id}`;
    expect((await b.agent.get(base)).status).toBe(404);
    expect((await b.agent.patch(base).send({ title: 'Hijack' })).status).toBe(404);
    expect((await b.agent.post(`${base}/cancel`).send({ reason: 'Hijack' })).status).toBe(404);
    expect((await b.agent.post(`${base}/publish`).send({ declarationAccepted: true })).status).toBe(404);
    expect((await b.agent.get(`${base}/history`)).status).toBe(404);
    expect((await b.agent.delete(`${base}/image`)).status).toBe(404);
    expect((await b.agent.get('/api/v1/listings?scope=all')).body.data.listings).toHaveLength(0);
    expect((await a.agent.get(base)).body.data.listing).toMatchObject({ title: 'Vegetable Biryani', status: 'AVAILABLE' });
  });

  it('lets admins read but not change listings; keeps drafts invisible to NGOs; malformed ids are 404', async () => {
    const p = await verifiedAgent(ctx, 'provider');
    const ngo = await verifiedAgent(ctx, 'ngo');
    const admin = await signedInAgent(ctx, 'admin');
    const draft = await createListing(p.agent);
    expect((await admin.agent.get(`/api/v1/listings/${draft.id}`)).status).toBe(200);
    expect((await admin.agent.patch(`/api/v1/listings/${draft.id}`).send({ title: 'Admin edit' })).status).toBe(403);
    expect((await admin.agent.post(`/api/v1/listings/${draft.id}/cancel`).send({ reason: 'Admin cancel' })).status).toBe(403);
    expect((await ngo.agent.get(`/api/v1/listings/${draft.id}`)).status).toBe(404);
    expect((await p.agent.get('/api/v1/listings/not-a-uuid')).status).toBe(404);
    expect((await request(ctx.app).get(`/api/v1/listings/${draft.id}`)).status).toBe(401);
  });

  it('lets any active member of the provider organization manage its listings', async () => {
    const owner = await verifiedAgent(ctx, 'provider');
    const staff = await signedInAgent(ctx, 'provider');
    await ctx.db.execute(sql`INSERT INTO organization_members (user_id, organization_id, member_role)
      SELECT u.id, ${owner.organizationId}::uuid, 'operator' FROM users u WHERE u.email = ${staff.email}`);
    // The staff member now belongs to two provider orgs; their newest org is their own unverified one,
    // so they act through the owner's listing by id.
    const l = await createListing(owner.agent);
    expect((await staff.agent.get(`/api/v1/listings/${l.id}`)).status).toBe(200);
    expect((await staff.agent.patch(`/api/v1/listings/${l.id}`).send({ servings: 20 })).status).toBe(200);
    expect((await staff.agent.post(`/api/v1/listings/${l.id}/publish`).send({ declarationAccepted: true })).status).toBe(200);
  });
});
