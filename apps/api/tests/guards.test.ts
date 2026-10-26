import { sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthenticate } from '../src/modules/auth/routes.js';
import { createAuthService } from '../src/modules/auth/service.js';
import { assertOrganizationVerified, assertVerifiedMember, requireVerifiedMember } from '../src/modules/organizations/guards.js';
import { errorHandler } from '../src/http/errors.js';
import { requestId } from '../src/http/middleware.js';
import { resetData, setup, signedInAgent, submitApplication } from './helpers.js';
import cookieParser from 'cookie-parser';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const setStatus = (orgId: string, status: string) =>
  ctx.db.execute(sql`UPDATE organizations SET verification_status = ${status}::verification_status WHERE id = ${orgId}`);

describe('verified-organization domain guard', () => {
  it.each(['UNSUBMITTED', 'UNDER_REVIEW', 'REJECTED', 'RESUBMISSION_REQUESTED'])('blocks a %s organization', async (status) => {
    const { organizationId } = await signedInAgent(ctx, 'provider');
    await setStatus(organizationId!, status);
    await expect(assertOrganizationVerified(ctx.db, organizationId!)).rejects.toMatchObject({
      status: 403,
      code: 'ORGANIZATION_NOT_VERIFIED',
      details: { verificationStatus: status },
    });
  });

  it('allows a VERIFIED organization and 404s an unknown one', async () => {
    const { organizationId } = await signedInAgent(ctx, 'provider');
    await setStatus(organizationId!, 'VERIFIED');
    await expect(assertOrganizationVerified(ctx.db, organizationId!)).resolves.toMatchObject({ id: organizationId });
    await expect(assertOrganizationVerified(ctx.db, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 404 });
  });

  it('assertVerifiedMember also requires active membership', async () => {
    const a = await signedInAgent(ctx, 'ngo');
    const b = await signedInAgent(ctx, 'ngo');
    await setStatus(a.organizationId!, 'VERIFIED');
    const userB = ((await ctx.db.execute(sql`SELECT id FROM users WHERE email = ${b.email}`)).rows[0] as { id: string }).id;
    const userA = ((await ctx.db.execute(sql`SELECT id FROM users WHERE email = ${a.email}`)).rows[0] as { id: string }).id;
    await expect(assertVerifiedMember(ctx.db, userA, a.organizationId!)).resolves.toBeDefined();
    await expect(assertVerifiedMember(ctx.db, userB, a.organizationId!)).rejects.toMatchObject({ status: 404 });
    await ctx.db.execute(sql`UPDATE organization_members SET status = 'REMOVED' WHERE user_id = ${userA}`);
    await expect(assertVerifiedMember(ctx.db, userA, a.organizationId!)).rejects.toMatchObject({ status: 404 });
  });

  it('works as route middleware: unverified blocked, verified allowed, end to end through approval', async () => {
    // A throwaway probe route standing in for future live operations (listings, acceptance...).
    const probe = express();
    probe.use(requestId, cookieParser());
    const authenticate = createAuthenticate(createAuthService(ctx.db, ctx.config), ctx.config);
    probe.get('/orgs/:id/live', authenticate, requireVerifiedMember(ctx.db, (req) => String(req.params.id)), (_req, res) => {
      res.json({ ok: true });
    });
    probe.use(errorHandler(false));

    const applicant = await signedInAgent(ctx, 'provider');
    const orgId = applicant.organizationId!;
    // supertest agents keep cookies privately; log in again to capture them for the probe app.
    const login = await request(ctx.app).post('/api/v1/auth/login').send({ email: applicant.email, password: 'Test-Password-123' });
    const cookies = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!).join('; ');

    const blocked = await request(probe).get(`/orgs/${orgId}/live`).set('Cookie', cookies);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('ORGANIZATION_NOT_VERIFIED');

    const { submissionNumber } = await submitApplication(applicant.agent, orgId);
    expect((await request(probe).get(`/orgs/${orgId}/live`).set('Cookie', cookies)).status).toBe(403); // still UNDER_REVIEW

    const admin = await signedInAgent(ctx, 'admin');
    await admin.agent.post(`/api/v1/admin/verifications/${orgId}/decision`).send({ decision: 'APPROVE', submissionNumber }).expect(200);
    expect((await request(probe).get(`/orgs/${orgId}/live`).set('Cookie', cookies)).status).toBe(200);

    // A different user's verified-ness does not carry over.
    const stranger = await signedInAgent(ctx, 'provider');
    const strangerLogin = await request(ctx.app).post('/api/v1/auth/login').send({ email: stranger.email, password: 'Test-Password-123' });
    const strangerCookies = (strangerLogin.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!).join('; ');
    expect((await request(probe).get(`/orgs/${orgId}/live`).set('Cookie', strangerCookies)).status).toBe(404);
  });
});
