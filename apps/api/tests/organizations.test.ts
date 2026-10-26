import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { completeProfile, prepareApplication, resetData, setup, signedInAgent, submitApplication } from './helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

describe('organization creation and validation', () => {
  it('a registered provider already has an unsubmitted organization owned by them', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const res = await agent.get('/api/v1/organizations');
    expect(res.status).toBe(200);
    expect(res.body.data.organizations).toHaveLength(1);
    expect(res.body.data.organizations[0]).toMatchObject({
      id: organizationId,
      type: 'PROVIDER',
      verificationStatus: 'UNSUBMITTED',
      myRole: 'owner',
      editable: true,
    });
  });

  it('refuses a second organization while one is open (409)', async () => {
    const { agent } = await signedInAgent(ctx, 'ngo');
    const res = await agent.post('/api/v1/organizations').send({ name: 'Another NGO' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORGANIZATION_EXISTS');
  });

  it('only provider and NGO users can create organizations; type follows the role', async () => {
    const runner = await signedInAgent(ctx, 'runner');
    expect((await runner.agent.post('/api/v1/organizations').send({ name: 'Runner Org' })).status).toBe(403);
    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.post('/api/v1/organizations').send({ name: 'Admin Org' })).status).toBe(403);
    expect((await request(ctx.app).post('/api/v1/organizations').send({ name: 'Anon Org' })).status).toBe(401);
  });

  it('validates fields and rejects client-chosen type, status and unknown keys', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const bad = await agent.patch(`/api/v1/organizations/${organizationId}`).send({
      contactEmail: 'nope',
      contactPhone: 'abc',
      latitude: 120,
    });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.details.fields)).toEqual(expect.arrayContaining(['contactEmail', 'contactPhone', 'latitude']));

    for (const body of [{ type: 'NGO' }, { verificationStatus: 'VERIFIED' }, { id: 'x' }]) {
      const res = await agent.patch(`/api/v1/organizations/${organizationId}`).send(body);
      expect(res.status).toBe(400);
    }
    expect((await agent.patch(`/api/v1/organizations/${organizationId}`).send({})).status).toBe(400);
  });

  it('requires latitude and longitude together', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const res = await agent.patch(`/api/v1/organizations/${organizationId}`).send({ latitude: 18.5 });
    expect(res.status).toBe(400);
    expect(res.body.details.fields.longitude ?? res.body.details.fields.latitude).toMatch(/both/i);
    const okRes = await agent.patch(`/api/v1/organizations/${organizationId}`).send({ latitude: 18.5, longitude: 73.8 });
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.organization).toMatchObject({ latitude: 18.5, longitude: 73.8 });
  });
});

describe('membership-based access', () => {
  it('lets the owner read and update their organization', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const patch = await agent.patch(`/api/v1/organizations/${organizationId}`).send({ name: 'Renamed Canteen', city: 'Pune' });
    expect(patch.status).toBe(200);
    expect(patch.body.data.organization).toMatchObject({ name: 'Renamed Canteen', city: 'Pune' });
    const get = await agent.get(`/api/v1/organizations/${organizationId}`);
    expect(get.body.data.organization.name).toBe('Renamed Canteen');
  });

  it("hides another organization's data from non-members (404) and blocks edits", async () => {
    const a = await signedInAgent(ctx, 'provider');
    const b = await signedInAgent(ctx, 'provider');
    const base = `/api/v1/organizations/${a.organizationId}`;
    expect((await b.agent.get(base)).status).toBe(404);
    expect((await b.agent.patch(base).send({ name: 'Hijacked' })).status).toBe(404);
    expect((await b.agent.post(`${base}/submit`)).status).toBe(404);
    expect((await b.agent.get(`${base}/documents`)).status).toBe(404);
    expect((await b.agent.get(`${base}/verification-history`)).status).toBe(404);
    // Even an NGO cannot see it.
    const ngo = await signedInAgent(ctx, 'ngo');
    expect((await ngo.agent.get(base)).status).toBe(404);
    // The owner's data is unchanged.
    const mine = await a.agent.get(base);
    expect(mine.body.data.organization.name).toBe('Test provider org');
  });

  it('treats malformed ids as not found', async () => {
    const { agent } = await signedInAgent(ctx, 'provider');
    expect((await agent.get('/api/v1/organizations/not-a-uuid')).status).toBe(404);
  });

  it('lets an operator read but not edit; admin can read but not edit', async () => {
    const owner = await signedInAgent(ctx, 'provider');
    const operator = await signedInAgent(ctx, 'provider');
    await ctx.db.execute(
      // Promote the second user's own membership to operator of the first org (invitations arrive in a later phase).
      (await import('drizzle-orm')).sql`INSERT INTO organization_members (user_id, organization_id, member_role)
        SELECT u.id, ${owner.organizationId}::uuid, 'operator' FROM users u WHERE u.email = ${operator.email}`,
    );
    const base = `/api/v1/organizations/${owner.organizationId}`;
    expect((await operator.agent.get(base)).status).toBe(200);
    expect((await operator.agent.patch(base).send({ city: 'X City' })).status).toBe(403);
    expect((await operator.agent.post(`${base}/submit`)).status).toBe(403);

    const admin = await signedInAgent(ctx, 'admin');
    expect((await admin.agent.get(base)).status).toBe(200);
    expect((await admin.agent.patch(base).send({ city: 'X City' })).status).toBe(403);
  });
});

describe('verification submission', () => {
  it('rejects submission with missing profile fields and no certificate, listing what is missing', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const res = await agent.post(`/api/v1/organizations/${organizationId}/submit`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SUBMISSION_INCOMPLETE');
    expect(res.body.details.missing).toEqual(
      expect.arrayContaining(['contactName', 'contactEmail', 'contactPhone', 'addressLine', 'city', 'document:REGISTRATION_CERTIFICATE']),
    );
  });

  it('requires the registration certificate specifically', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'ngo');
    await agent.patch(`/api/v1/organizations/${organizationId}`).send(completeProfile).expect(200);
    const { uploadDoc } = await import('./helpers.js');
    await uploadDoc(agent, organizationId!, { type: 'ID_PROOF' }).then((r) => expect(r.status).toBe(201));
    const res = await agent.post(`/api/v1/organizations/${organizationId}/submit`);
    expect(res.status).toBe(422);
    expect(res.body.details.missing).toEqual(['document:REGISTRATION_CERTIFICATE']);
  });

  it('moves a complete application to UNDER_REVIEW, records history and locks editing', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    const submitted = await submitApplication(agent, organizationId!);
    expect(submitted.submissionNumber).toBe(1);

    const org = (await agent.get(`/api/v1/organizations/${organizationId}`)).body.data.organization;
    expect(org).toMatchObject({ verificationStatus: 'UNDER_REVIEW', editable: false });

    const history = await agent.get(`/api/v1/organizations/${organizationId}/verification-history`);
    expect(history.body.data.history).toHaveLength(1);
    expect(history.body.data.history[0]).toMatchObject({ action: 'SUBMITTED', toStatus: 'UNDER_REVIEW', submissionNumber: 1 });
    expect(history.body.data.history[0]).not.toHaveProperty('actorUserId');

    const edit = await agent.patch(`/api/v1/organizations/${organizationId}`).send({ city: 'Mumbai' });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('ORGANIZATION_LOCKED');
    const again = await agent.post(`/api/v1/organizations/${organizationId}/submit`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('does not let an applicant set verification fields by any route', async () => {
    const { agent, organizationId } = await signedInAgent(ctx, 'provider');
    await prepareApplication(agent, organizationId!);
    const res = await agent.post(`/api/v1/admin/verifications/${organizationId}/decision`).send({
      decision: 'APPROVE',
      submissionNumber: 1,
    });
    expect(res.status).toBe(403);
  });
});
