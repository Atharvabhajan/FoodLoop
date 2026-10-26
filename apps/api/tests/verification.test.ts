import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { nextStatus, isApplicantEditable } from '../src/modules/organizations/lifecycle.js';
import { resetData, setup, signedInAgent, submitApplication, uploadDoc } from './helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const decisionUrl = (id: string | undefined) => `/api/v1/admin/verifications/${id}/decision`;

async function pendingApplication(role: 'provider' | 'ngo' = 'provider') {
  const applicant = await signedInAgent(ctx, role);
  const { submissionNumber } = await submitApplication(applicant.agent, applicant.organizationId!);
  const admin = await signedInAgent(ctx, 'admin');
  return { applicant, admin, orgId: applicant.organizationId!, submissionNumber };
}

describe('status lifecycle (pure rules)', () => {
  it('allows only the documented transitions', () => {
    expect(nextStatus('UNSUBMITTED', 'SUBMIT')).toBe('UNDER_REVIEW');
    expect(nextStatus('RESUBMISSION_REQUESTED', 'SUBMIT')).toBe('UNDER_REVIEW');
    expect(nextStatus('UNDER_REVIEW', 'APPROVE')).toBe('VERIFIED');
    expect(nextStatus('UNDER_REVIEW', 'REJECT')).toBe('REJECTED');
    expect(nextStatus('UNDER_REVIEW', 'REQUEST_RESUBMISSION')).toBe('RESUBMISSION_REQUESTED');

    expect(nextStatus('UNSUBMITTED', 'APPROVE')).toBeNull();
    expect(nextStatus('VERIFIED', 'SUBMIT')).toBeNull();
    expect(nextStatus('VERIFIED', 'REJECT')).toBeNull();
    expect(nextStatus('REJECTED', 'SUBMIT')).toBeNull(); // REJECTED is terminal
    expect(nextStatus('REJECTED', 'APPROVE')).toBeNull();
    expect(nextStatus('UNDER_REVIEW', 'SUBMIT')).toBeNull();
    expect(nextStatus('RESUBMISSION_REQUESTED', 'APPROVE')).toBeNull();
  });

  it('lets the applicant edit only before submission or after a resubmission request', () => {
    expect(isApplicantEditable('UNSUBMITTED')).toBe(true);
    expect(isApplicantEditable('RESUBMISSION_REQUESTED')).toBe(true);
    for (const s of ['UNDER_REVIEW', 'VERIFIED', 'REJECTED'] as const) expect(isApplicantEditable(s)).toBe(false);
  });
});

describe('admin verification queue', () => {
  it('is admin-only', async () => {
    const { applicant, admin } = await pendingApplication();
    expect((await request(ctx.app).get('/api/v1/admin/verifications')).status).toBe(401);
    expect((await applicant.agent.get('/api/v1/admin/verifications')).status).toBe(403);
    const ngo = await signedInAgent(ctx, 'ngo');
    expect((await ngo.agent.get('/api/v1/admin/verifications')).status).toBe(403);
    const res = await admin.agent.get('/api/v1/admin/verifications');
    expect(res.status).toBe(200);
    expect(res.body.data.organizations).toHaveLength(1);
    expect(res.body.data.organizations[0]).toMatchObject({ verificationStatus: 'UNDER_REVIEW', documentCount: 1 });
  });

  it('lists only organizations awaiting review by default and supports status filters', async () => {
    const { admin } = await pendingApplication();
    await signedInAgent(ctx, 'ngo'); // an UNSUBMITTED org
    expect((await admin.agent.get('/api/v1/admin/verifications')).body.data.organizations).toHaveLength(1);
    expect((await admin.agent.get('/api/v1/admin/verifications?status=ALL')).body.data.organizations.length).toBeGreaterThanOrEqual(2);
    expect((await admin.agent.get('/api/v1/admin/verifications?status=BOGUS')).status).toBe(400);
  });

  it('shows admins the detail view with documents, owner and history but no storage keys', async () => {
    const { admin, orgId } = await pendingApplication();
    const res = await admin.agent.get(`/api/v1/admin/verifications/${orgId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.documents).toHaveLength(1);
    expect(res.body.data.owner.email).toMatch(/@example\.test$/);
    expect(res.body.data.history[0]).toMatchObject({ action: 'SUBMITTED' });
    expect(JSON.stringify(res.body)).not.toMatch(/storageKey|storage_key|sha256|org-/);
  });
});

describe('admin decisions', () => {
  it('approves: status becomes VERIFIED, documents accepted, history recorded with the admin as actor', async () => {
    const { applicant, admin, orgId, submissionNumber } = await pendingApplication();
    const res = await admin.agent.post(decisionUrl(orgId)).send({ decision: 'APPROVE', submissionNumber });
    expect(res.status).toBe(200);
    expect(res.body.data.organization).toMatchObject({ verificationStatus: 'VERIFIED', statusReason: null });

    const docs = await applicant.agent.get(`/api/v1/organizations/${orgId}/documents`);
    expect(docs.body.data.documents[0].reviewStatus).toBe('ACCEPTED');
    const detail = await admin.agent.get(`/api/v1/admin/verifications/${orgId}`);
    expect(detail.body.data.history.map((h: { action: string }) => h.action)).toEqual(['APPROVED', 'SUBMITTED']);
    expect(detail.body.data.history[0].actorName).toBe('Test Admin');
  });

  it('requires a reason to reject or request resubmission, but not to approve', async () => {
    const { admin, orgId, submissionNumber } = await pendingApplication();
    for (const decision of ['REJECT', 'REQUEST_RESUBMISSION']) {
      for (const reason of [undefined, '', '   ']) {
        const res = await admin.agent.post(decisionUrl(orgId)).send({ decision, submissionNumber, ...(reason === undefined ? {} : { reason }) });
        expect(res.status).toBe(400);
        expect(res.body.details.fields.reason).toMatch(/reason is required/i);
      }
    }
    const status = await admin.agent.get(`/api/v1/admin/verifications/${orgId}`);
    expect(status.body.data.organization.verificationStatus).toBe('UNDER_REVIEW');
    expect((await admin.agent.post(decisionUrl(orgId)).send({ decision: 'APPROVE', submissionNumber })).status).toBe(200);
  });

  it('only admins may decide; applicants and other roles get 403, anonymous 401', async () => {
    const { applicant, orgId, submissionNumber } = await pendingApplication('ngo');
    const body = { decision: 'APPROVE', submissionNumber };
    expect((await applicant.agent.post(decisionUrl(orgId)).send(body)).status).toBe(403);
    const runner = await signedInAgent(ctx, 'runner');
    expect((await runner.agent.post(decisionUrl(orgId)).send(body)).status).toBe(403);
    expect((await request(ctx.app).post(decisionUrl(orgId)).send(body)).status).toBe(401);
    const org = await applicant.agent.get(`/api/v1/organizations/${orgId}`);
    expect(org.body.data.organization.verificationStatus).toBe('UNDER_REVIEW');
  });

  it('request-resubmission shows the reason to the applicant, who can fix, resubmit and be approved', async () => {
    const { applicant, admin, orgId, submissionNumber } = await pendingApplication();
    const reason = 'The certificate is unreadable. Please upload a clearer scan.';
    await admin.agent.post(decisionUrl(orgId)).send({ decision: 'REQUEST_RESUBMISSION', reason, submissionNumber }).expect(200);

    const org = (await applicant.agent.get(`/api/v1/organizations/${orgId}`)).body.data.organization;
    expect(org).toMatchObject({ verificationStatus: 'RESUBMISSION_REQUESTED', statusReason: reason, editable: true });

    await applicant.agent.patch(`/api/v1/organizations/${orgId}`).send({ city: 'Mumbai' }).expect(200);
    await uploadDoc(applicant.agent, orgId, { filename: 'clearer.pdf' }).then((r) => expect(r.status).toBe(201));
    const resubmitted = await applicant.agent.post(`/api/v1/organizations/${orgId}/submit`);
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.data.organization).toMatchObject({ verificationStatus: 'UNDER_REVIEW', submissionNumber: 2, statusReason: null });

    const approve = await admin.agent.post(decisionUrl(orgId)).send({ decision: 'APPROVE', submissionNumber: 2 });
    expect(approve.status).toBe(200);
    const history = (await applicant.agent.get(`/api/v1/organizations/${orgId}/verification-history`)).body.data.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['APPROVED', 'SUBMITTED', 'RESUBMISSION_REQUESTED', 'SUBMITTED']);
    expect(history.find((h: { action: string }) => h.action === 'RESUBMISSION_REQUESTED').reason).toBe(reason);
  });

  it('rejection is terminal: no resubmission, no edits, no further decisions; a new application is allowed', async () => {
    const { applicant, admin, orgId, submissionNumber } = await pendingApplication();
    await admin.agent.post(decisionUrl(orgId)).send({ decision: 'REJECT', reason: 'Not a registered food business.', submissionNumber }).expect(200);

    const submit = await applicant.agent.post(`/api/v1/organizations/${orgId}/submit`);
    expect(submit.status).toBe(409);
    expect(submit.body.code).toBe('INVALID_STATUS_TRANSITION');
    expect((await applicant.agent.patch(`/api/v1/organizations/${orgId}`).send({ city: 'Z' })).status).toBe(409);
    const again = await admin.agent.post(decisionUrl(orgId)).send({ decision: 'APPROVE', submissionNumber });
    expect(again.status).toBe(409);

    const created = await applicant.agent.post('/api/v1/organizations').send({ name: 'Fresh Start Canteen' });
    expect(created.status).toBe(201);
    expect(created.body.data.organization.verificationStatus).toBe('UNSUBMITTED');
  });

  it('rejects duplicate and stale decisions and decisions on non-pending organizations', async () => {
    const { applicant, admin, orgId, submissionNumber } = await pendingApplication();
    const body = { decision: 'REQUEST_RESUBMISSION', reason: 'Fix address', submissionNumber };

    // Two admins deciding at once: exactly one wins.
    const admin2 = await signedInAgent(ctx, 'admin');
    const [r1, r2] = await Promise.all([admin.agent.post(decisionUrl(orgId)).send(body), admin2.agent.post(decisionUrl(orgId)).send(body)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const events = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM verification_events WHERE action = 'RESUBMISSION_REQUESTED'`);
    expect(events.rows[0]).toMatchObject({ n: 1 });

    // Stale: the applicant resubmitted (submission 2); a decision based on submission 1 is refused.
    await uploadDoc(applicant.agent, orgId, { filename: 'again.pdf' });
    await applicant.agent.post(`/api/v1/organizations/${orgId}/submit`).expect(200);
    const stale = await admin.agent.post(decisionUrl(orgId)).send({ decision: 'APPROVE', submissionNumber });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVIEW');

    // An organization that was never submitted cannot be decided.
    const draft = await signedInAgent(ctx, 'ngo');
    const notPending = await admin.agent.post(decisionUrl(draft.organizationId)).send({ decision: 'APPROVE', submissionNumber: 1 });
    expect(notPending.status).toBe(409);
    expect(notPending.body.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('validates the decision body', async () => {
    const { admin, orgId } = await pendingApplication();
    expect((await admin.agent.post(decisionUrl(orgId)).send({ decision: 'MAYBE', submissionNumber: 1 })).status).toBe(400);
    expect((await admin.agent.post(decisionUrl(orgId)).send({ decision: 'APPROVE' })).status).toBe(400);
    expect((await admin.agent.post(decisionUrl('not-a-uuid')).send({ decision: 'APPROVE', submissionNumber: 1 })).status).toBe(404);
  });
});

describe('verification history is append-only', () => {
  it('rejects UPDATE and DELETE at the database level', async () => {
    const { admin, orgId, submissionNumber } = await pendingApplication();
    await admin.agent.post(decisionUrl(orgId)).send({ decision: 'APPROVE', submissionNumber }).expect(200);
    const before = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM verification_events`);
    expect(before.rows[0]).toMatchObject({ n: 2 });

    await expect(ctx.db.execute(sql`UPDATE verification_events SET reason = 'tampered'`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`DELETE FROM verification_events`)).rejects.toThrow();
    // Deleting an organization that has history is blocked too.
    await expect(ctx.db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)).rejects.toThrow();

    const after = await ctx.db.execute(sql`SELECT count(*)::int AS n, coalesce(bool_or(reason = 'tampered'), false) AS tampered FROM verification_events`);
    expect(after.rows[0]).toMatchObject({ n: 2, tampered: false });
  });
});

describe('verified organization edits', () => {
  it('lets a verified organization update contact details but not name or address', async () => {
    const { applicant, admin, orgId, submissionNumber } = await pendingApplication();
    await admin.agent.post(decisionUrl(orgId)).send({ decision: 'APPROVE', submissionNumber }).expect(200);
    const contact = await applicant.agent.patch(`/api/v1/organizations/${orgId}`).send({ contactPhone: '+91 91111 22222' });
    expect(contact.status).toBe(200);
    const identity = await applicant.agent.patch(`/api/v1/organizations/${orgId}`).send({ name: 'Different Name' });
    expect(identity.status).toBe(409);
    expect(identity.body.details.fields.name).toBeDefined();
    expect((await applicant.agent.post(`/api/v1/organizations/${orgId}/submit`)).status).toBe(409);
  });
});
