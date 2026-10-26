import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isBlockingIncident } from '../src/modules/rescues/lifecycle.js';
import { availableListing, matchedNgo, pdfBytes, resetData, setup, signedInAgent, verifiedAgent } from './helpers.js';
import { R, accept, assigned, assignments, awaitingRunner, count, delivered, events, inTransit, listingStatus, rescueRow, rows, runnerAt } from './runner-helpers.js';

const ctx = setup();
beforeEach(async () => {
  await resetData(ctx.db);
  rmSync(ctx.config.STORAGE_DIR, { recursive: true, force: true });
  mkdirSync(ctx.config.STORAGE_DIR, { recursive: true });
});
afterAll(() => ctx.pool.end());

type Agent = Awaited<ReturnType<typeof signedInAgent>>['agent'];
const report = (agent: Agent, rescueId: string, body: Record<string, unknown> = {}) =>
  agent.post(`${R(rescueId)}/incidents`).send({ category: 'PICKUP_PROBLEM', severity: 'HIGH', description: 'The kitchen is closed and nobody answers.', ...body });
const resolve = (agent: Agent, incidentId: string, body: Record<string, unknown>) => agent.post(`/api/v1/incidents/${incidentId}/resolve`).send(body);
const incidentRow = async (id: string) => (await rows(ctx, sql`SELECT * FROM incident_reports WHERE id = ${id}::uuid`))[0]!;

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};
/** A structurally valid PNG (signature, IHDR, IDAT, IEND) so the real image validation accepts it. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13)), chunk('IDAT', Buffer.from([1, 2, 3, 4])), chunk('IEND', Buffer.alloc(0))]);

describe('what counts as a blocking incident (spec BR-07)', () => {
  it('blocks on HIGH or CRITICAL severity or any food-safety report', () => {
    expect(isBlockingIncident('PICKUP_PROBLEM', 'LOW')).toBe(false);
    expect(isBlockingIncident('QUANTITY_MISMATCH', 'MEDIUM')).toBe(false);
    expect(isBlockingIncident('OTHER', 'HIGH')).toBe(true);
    expect(isBlockingIncident('DELIVERY_PROBLEM', 'CRITICAL')).toBe(true);
    expect(isBlockingIncident('FOOD_SAFETY', 'LOW')).toBe(true);
  });
});

describe('reporting an incident', () => {
  it('lets each party report, records it in the audit history and notifies the others and admins', async () => {
    const s = await assigned(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    const res = await report(s.runner.agent, s.rescueId, { category: 'DELIVERY_PROBLEM', severity: 'MEDIUM', description: 'The road is blocked by a procession.' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ changed: true, rescueBlocked: false, incident: { category: 'DELIVERY_PROBLEM', severity: 'MEDIUM', blocking: false, status: 'OPEN', reporterRole: 'runner' } });
    expect((await events(ctx, s.rescueId)).find((e) => e.event_type === 'INCIDENT_REPORTED')).toMatchObject({ actor_role: 'runner', metadata: { category: 'DELIVERY_PROBLEM', severity: 'MEDIUM', blocking: false } });
    for (const a of [s.provider.agent, s.ngo.agent, admin.agent]) {
      const n = (await a.get('/api/v1/notifications')).body.data.notifications.find((x: { title: string }) => /Incident reported/.test(x.title));
      expect(n, 'notified').toBeTruthy();
      expect(n.body).not.toContain('procession'); // the description stays on the rescue page
    }
    expect((await s.runner.agent.get('/api/v1/notifications')).body.data.notifications.some((x: { title: string }) => /Incident reported/.test(x.title))).toBe(false); // not told about its own report

    expect((await report(s.provider.agent, s.rescueId, { severity: 'LOW' })).status).toBe(201);
    expect((await report(s.ngo.agent, s.rescueId, { severity: 'LOW', category: 'OTHER' })).status).toBe(201);
    const view = (await s.ngo.agent.get(R(s.rescueId))).body.data.rescue;
    expect(view.incidents).toHaveLength(3);
    expect(view.incidents.map((i: { reporterRole: string }) => i.reporterRole)).toEqual(['runner', 'provider', 'ngo']);
    expect(view.blockedByIncident).toBe(false);
  });

  it('validates the report and limits who may file one and when', async () => {
    const s = await assigned(ctx);
    for (const bad of [{ category: 'NOPE' }, { severity: 'SEVERE' }, { description: 'short' }, { description: 'x'.repeat(1001) }, { extra: 1 }]) {
      expect((await report(s.runner.agent, s.rescueId, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await report((await signedInAgent(ctx, 'admin')).agent, s.rescueId)).status).toBe(403); // admins resolve, they do not file
    expect((await report((await runnerAt(ctx)).agent, s.rescueId)).status).toBe(404); // unrelated runner
    expect((await report((await verifiedAgent(ctx, 'provider')).agent, s.rescueId)).status).toBe(404);
    expect((await report((await matchedNgo(ctx, { metersAway: 2000 })).agent, s.rescueId)).status).toBe(404);
    expect((await request(ctx.app).post(`${R(s.rescueId)}/incidents`).send({})).status).toBe(401);

    // Not before the provider has confirmed.
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const l = await availableListing(provider.agent, { title: 'Early report' });
    const early = (await accept(ngo.agent, l.id, { transportMode: 'RUNNER' })).body.data.rescue.id;
    const res = await report(ngo.agent, early);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INCIDENT_NOT_ALLOWED');
  });

  it('a runner who released the job can no longer report on it', async () => {
    const s = await assigned(ctx);
    await s.runner.agent.post(`${R(s.rescueId)}/runner/release`).send({ reason: 'Cannot make it' }).expect(200);
    const res = await report(s.runner.agent, s.rescueId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_ASSIGNED');
  });

  it('treats a repeated report as the same report (no duplicates, events or notifications)', async () => {
    const s = await assigned(ctx);
    const first = await report(s.runner.agent, s.rescueId);
    const again = await report(s.runner.agent, s.rescueId);
    expect(again.status).toBe(201);
    expect(again.body.data.changed).toBe(false);
    expect(again.body.data.incident.id).toBe(first.body.data.incident.id);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM incident_reports`)).toBe(1);
    expect((await events(ctx, s.rescueId)).filter((e) => e.event_type === 'INCIDENT_REPORTED')).toHaveLength(1);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM notifications WHERE title LIKE 'Incident reported%'`)).toBeGreaterThan(0);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM (SELECT dedupe_key FROM notifications GROUP BY 1 HAVING count(*) > 1) t`)).toBe(0);
    // A different description is a different report.
    expect((await report(s.runner.agent, s.rescueId, { description: 'A second, different problem appeared.' })).body.data.changed).toBe(true);
  });

  it('works for direct-pickup rescues too', async () => {
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const l = await availableListing(provider.agent);
    const id = (await accept(ngo.agent, l.id)).body.data.rescue.id;
    const conf = await provider.agent.post(`${R(id)}/confirm`).send({});
    const res = await report(ngo.agent, id, { category: 'FOOD_SAFETY', severity: 'LOW', description: 'The food smells off and is warm.' });
    expect(res.body.data).toMatchObject({ rescueBlocked: true, incident: { blocking: true } });
    const blocked = await ngo.agent.post(`${R(id)}/pickup/verify`).send({ code: conf.body.data.pickupCode, collectedServings: 40 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('RESCUE_BLOCKED_BY_INCIDENT');
  });
});

describe('a blocking incident stops the normal steps', () => {
  it('blocks the runner from claiming, collecting or handing over, and the NGO from confirming', async () => {
    // Claiming
    const a = await awaitingRunner(ctx);
    const claimer = await runnerAt(ctx);
    await report(a.provider.agent, a.rescueId, { category: 'FOOD_SAFETY', severity: 'LOW', description: 'Storage fridge failed overnight.' }).then((r) => expect(r.status).toBe(201));
    const claim = await claimer.agent.post(`${R(a.rescueId)}/assign-self`).send({});
    expect(claim.status).toBe(409);
    expect(claim.body.code).toBe('RESCUE_BLOCKED_BY_INCIDENT');
    expect((await claimer.agent.get('/api/v1/rescues/available-runs')).body.data.jobs).toHaveLength(1); // still listed; the claim is what is refused

    // Collecting
    const b = await assigned(ctx);
    await report(b.ngo.agent, b.rescueId, { severity: 'HIGH' }).then((r) => expect(r.body.data.rescueBlocked).toBe(true));
    const v = await b.runner.agent.post(`${R(b.rescueId)}/pickup/verify`).send({ code: b.code, collectedServings: 10 });
    expect(v.body.code).toBe('RESCUE_BLOCKED_BY_INCIDENT');
    const view = (await b.runner.agent.get(R(b.rescueId))).body.data.rescue;
    expect(view.blockedByIncident).toBe(true);
    expect(view.allowedActions).toEqual(['release_assignment', 'report_incident']); // forward steps removed

    // Handing over
    const c = await inTransit(ctx);
    await report(c.runner.agent, c.rescueId, { category: 'DELIVERY_PROBLEM', severity: 'CRITICAL', description: 'The cool box was opened by someone.' }).then((r) => expect(r.status).toBe(201));
    expect((await c.runner.agent.post(`${R(c.rescueId)}/delivery/handover`).send({})).body.code).toBe('RESCUE_BLOCKED_BY_INCIDENT');
    expect((await c.runner.agent.get(R(c.rescueId))).body.data.rescue.allowedActions).toEqual(['report_incident']);

    // Confirming receipt
    const d = await delivered(ctx);
    await report(d.ngo.agent, d.rescueId, { category: 'QUANTITY_MISMATCH', severity: 'HIGH', description: 'Only half of the boxes arrived.' }).then((r) => expect(r.status).toBe(201));
    const confirm = await d.ngo.agent.post(`${R(d.rescueId)}/delivery/confirm`).send({ deliveredServings: 20 });
    expect(confirm.status).toBe(409);
    expect(confirm.body.code).toBe('RESCUE_BLOCKED_BY_INCIDENT');
    expect((await rescueRow(ctx, d.rescueId)).status).toBe('DELIVERED'); // it did not silently complete
    expect((await d.ngo.agent.get(R(d.rescueId))).body.data.rescue.allowedActions).toEqual(['report_incident']);
  });

  it('does not block on a low-severity, non-safety report', async () => {
    const s = await assigned(ctx);
    await report(s.runner.agent, s.rescueId, { severity: 'LOW', description: 'Traffic is a bit slow today.' }).then((r) => expect(r.body.data.rescueBlocked).toBe(false));
    expect((await s.runner.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 })).status).toBe(200);
  });

  it('a runner cannot turn a disputed delivery into a success: only an admin can finish it', async () => {
    const s = await delivered(ctx, 40);
    await report(s.ngo.agent, s.rescueId, { category: 'QUANTITY_MISMATCH', severity: 'HIGH', description: 'We received far fewer boxes than collected.' }).then((r) => expect(r.status).toBe(201));
    const incidentId = ((await rows(ctx, sql`SELECT id FROM incident_reports`))[0] as { id: string }).id;
    const attempts = [
      () => s.runner.agent.post(`${R(s.rescueId)}/delivery/confirm`).send({ deliveredServings: 40 }),
      () => s.runner.agent.post(`${R(s.rescueId)}/admin/resolve`).send({ deliveredServings: 40, reason: 'All fine really' }),
      () => s.runner.agent.post(`/api/v1/incidents/${incidentId}/resolve`).send({ resolution: 'NO_ACTION', note: 'Fine' }),
    ];
    for (const attempt of attempts) expect([401, 403, 404]).toContain((await attempt()).status);
    expect((await rescueRow(ctx, s.rescueId)).status).toBe('DELIVERED');
    const inc = (await rows(ctx, sql`SELECT id FROM incident_reports`))[0] as { id: string };
    const admin = await signedInAgent(ctx, 'admin');
    const res = await resolve(admin.agent, inc.id, { resolution: 'COMPLETE_WITH_QUANTITY', note: 'Confirmed 18 servings with the NGO by phone', deliveredServings: 18 });
    expect(res.status).toBe(200);
    expect(res.body.data.rescue).toMatchObject({ status: 'COMPLETED', deliveredServings: 18, outcomeCode: 'ADMIN_RESOLVED' });
    expect(res.body.data.incident).toMatchObject({ status: 'RESOLVED', resolutionCode: 'COMPLETE_WITH_QUANTITY' });
  });
});

describe('resolving incidents (admin)', () => {
  it('is admin-only and needs a note', async () => {
    const s = await assigned(ctx);
    const id = (await report(s.runner.agent, s.rescueId)).body.data.incident.id as string;
    const admin = await signedInAgent(ctx, 'admin');
    for (const a of [s.runner.agent, s.provider.agent, s.ngo.agent]) expect((await resolve(a, id, { resolution: 'NO_ACTION', note: 'ok ok' })).status).toBe(403);
    expect((await request(ctx.app).post(`/api/v1/incidents/${id}/resolve`).send({})).status).toBe(401);
    for (const bad of [{}, { resolution: 'NO_ACTION' }, { resolution: 'NO_ACTION', note: 'x' }, { resolution: 'EXPLODE', note: 'ok ok' }, { resolution: 'NO_ACTION', note: 'ok ok', extra: 1 }]) {
      expect((await resolve(admin.agent, id, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await resolve(admin.agent, '00000000-0000-4000-8000-000000000000', { resolution: 'NO_ACTION', note: 'ok ok' })).status).toBe(404);
    expect((await incidentRow(id)).status).toBe('OPEN');
  });

  it('NO_ACTION closes the incident and unblocks the rescue; repeating is a no-op; a different outcome is refused', async () => {
    const s = await assigned(ctx);
    const id = (await report(s.runner.agent, s.rescueId, { category: 'OTHER', severity: 'HIGH', description: 'Gate guard refused entry at first.' })).body.data.incident.id as string;
    const admin = await signedInAgent(ctx, 'admin');
    const res = await resolve(admin.agent, id, { resolution: 'NO_ACTION', note: 'Provider cleared it with the guard' });
    expect(res.status).toBe(200);
    expect(res.body.data.incident).toMatchObject({ status: 'RESOLVED', resolutionCode: 'NO_ACTION', resolutionNote: 'Provider cleared it with the guard' });
    const stored = await incidentRow(id);
    expect(stored.resolved_by).toBeTruthy();
    expect(stored.resolved_at).toBeTruthy();
    expect((await s.runner.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: 40 })).status).toBe(200); // flows again
    expect((await events(ctx, s.rescueId)).find((e) => e.event_type === 'INCIDENT_RESOLVED')).toMatchObject({ actor_role: 'admin', reason: 'Provider cleared it with the guard', metadata: { resolution: 'NO_ACTION' } });

    expect((await resolve(admin.agent, id, { resolution: 'NO_ACTION', note: 'Provider cleared it with the guard' })).body.data.changed).toBe(false);
    const other = await resolve(admin.agent, id, { resolution: 'CANCEL_RESCUE', note: 'Changed my mind' });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('INCIDENT_ALREADY_RESOLVED');
    expect((await events(ctx, s.rescueId)).filter((e) => e.event_type === 'INCIDENT_RESOLVED')).toHaveLength(1);
    // The reporter and the organisations are told.
    expect((await s.runner.agent.get('/api/v1/notifications')).body.data.notifications.some((n: { title: string }) => /Incident resolved/.test(n.title))).toBe(true);
  });

  it('REASSIGN_RUNNER replaces the runner and restarts the search', async () => {
    const s = await assigned(ctx);
    const id = (await report(s.provider.agent, s.rescueId, { category: 'RUNNER_UNAVAILABLE', severity: 'HIGH', description: 'The runner has not arrived and is not answering.' })).body.data.incident.id as string;
    const admin = await signedInAgent(ctx, 'admin');
    const res = await resolve(admin.agent, id, { resolution: 'REASSIGN_RUNNER', note: 'Runner unreachable; finding another' });
    expect(res.body.data.rescue.status).toBe('AWAITING_RUNNER');
    expect((await assignments(ctx, s.rescueId))[0]).toMatchObject({ status: 'REVOKED' });
    expect((await incidentRow(id)).status).toBe('RESOLVED');
    // Only valid while a runner holds a pickup that has not happened.
    const t = await inTransit(ctx);
    const tid = (await report(t.ngo.agent, t.rescueId)).body.data.incident.id as string;
    const bad = await resolve(admin.agent, tid, { resolution: 'REASSIGN_RUNNER', note: 'Try to reassign in transit' });
    expect(bad.status).toBe(409);
    expect((await incidentRow(tid)).status).toBe('OPEN'); // the failed resolution changed nothing
    expect((await rescueRow(ctx, t.rescueId)).status).toBe('IN_TRANSIT');
  });

  it('CANCEL_RESCUE before pickup releases the listing; FAIL_DELIVERY after pickup marks custody failed', async () => {
    const a = await assigned(ctx);
    const admin = await signedInAgent(ctx, 'admin');
    const aid = (await report(a.provider.agent, a.rescueId, { category: 'FOOD_SAFETY', severity: 'CRITICAL', description: 'Food was left out in the sun for hours.' })).body.data.incident.id as string;
    const res = await resolve(admin.agent, aid, { resolution: 'CANCEL_RESCUE', note: 'Unsafe: cancelling the rescue' });
    expect(res.body.data.rescue).toMatchObject({ status: 'CANCELLED', outcomeCode: 'ADMIN_CANCELLED' });
    expect(await listingStatus(ctx, a.listing.id)).toBe('AVAILABLE');
    expect((await assignments(ctx, a.rescueId))[0]!.status).toBe('REVOKED');

    const b = await inTransit(ctx);
    const bid = (await report(b.runner.agent, b.rescueId, { category: 'DELIVERY_PROBLEM', severity: 'CRITICAL', description: 'The vehicle was in an accident.' })).body.data.incident.id as string;
    const cancel = await resolve(admin.agent, bid, { resolution: 'CANCEL_RESCUE', note: 'Cannot cancel after pickup' });
    expect(cancel.status).toBe(409);
    const fail = await resolve(admin.agent, bid, { resolution: 'FAIL_DELIVERY', note: 'Food lost in the accident' });
    expect(fail.body.data.rescue).toMatchObject({ status: 'DELIVERY_FAILED', outcomeCode: 'ADMIN_MARKED_FAILED' });
  });

  it('COMPLETE_WITH_QUANTITY needs a valid quantity and leaves the incident open when it fails', async () => {
    const s = await delivered(ctx, 30);
    const id = (await report(s.ngo.agent, s.rescueId, { category: 'QUANTITY_MISMATCH', severity: 'HIGH', description: 'Quantity does not match the label.' })).body.data.incident.id as string;
    const admin = await signedInAgent(ctx, 'admin');
    const missing = await resolve(admin.agent, id, { resolution: 'COMPLETE_WITH_QUANTITY', note: 'Settled by phone' });
    expect(missing.status).toBe(400);
    expect(missing.body.details.fields.deliveredServings).toBeDefined();
    const over = await resolve(admin.agent, id, { resolution: 'COMPLETE_WITH_QUANTITY', note: 'Settled by phone', deliveredServings: 31 });
    expect(over.status).toBe(400);
    expect((await incidentRow(id)).status).toBe('OPEN');
    expect((await rescueRow(ctx, s.rescueId)).status).toBe('DELIVERED');
  });
});

describe('incident records are immutable', () => {
  it('rejects edits, reopening and deletion at the database level', async () => {
    const s = await assigned(ctx);
    const id = (await report(s.runner.agent, s.rescueId)).body.data.incident.id as string;
    await expect(ctx.db.execute(sql`UPDATE incident_reports SET description = 'rewritten' WHERE id = ${id}::uuid`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`UPDATE incident_reports SET severity = 'LOW', blocking = false WHERE id = ${id}::uuid`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`UPDATE incident_reports SET reporter_user_id = ${s.provider.organizationId}::uuid WHERE id = ${id}::uuid`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`DELETE FROM incident_reports WHERE id = ${id}::uuid`)).rejects.toThrow();
    // A resolution must say who and when, and once resolved the row is frozen.
    await expect(ctx.db.execute(sql`UPDATE incident_reports SET status = 'RESOLVED' WHERE id = ${id}::uuid`)).rejects.toThrow();
    const admin = await signedInAgent(ctx, 'admin');
    await resolve(admin.agent, id, { resolution: 'NO_ACTION', note: 'Looked into it' }).then((r) => expect(r.status).toBe(200));
    await expect(ctx.db.execute(sql`UPDATE incident_reports SET status = 'OPEN' WHERE id = ${id}::uuid`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`UPDATE incident_reports SET resolution_note = 'changed' WHERE id = ${id}::uuid`)).rejects.toThrow();
    expect((await incidentRow(id)).description).toBe('The kitchen is closed and nobody answers.');
  });

  it('keeps rescue history append-only and the incident trail inside it', async () => {
    const s = await assigned(ctx);
    await report(s.runner.agent, s.rescueId);
    await expect(ctx.db.execute(sql`UPDATE rescue_events SET reason = 'x'`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`DELETE FROM rescue_events`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`DELETE FROM rescue_assignments WHERE rescue_id = ${s.rescueId}::uuid`)).resolves.toBeDefined(); // assignments are history rows, not the audit log
  });
});

describe('evidence photos', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const upload = (agent: Agent, rescueId: string, incidentId: string, data: Buffer, filename = 'photo.png', type = 'image/png') =>
    agent.post(`${R(rescueId)}/incidents/${incidentId}/evidence`).attach('file', data, { filename, contentType: type });

  it('lets the reporter attach photos and the parties and admins read them, and nobody else', async () => {
    const s = await assigned(ctx);
    const id = (await report(s.runner.agent, s.rescueId)).body.data.incident.id as string;
    const up = await upload(s.runner.agent, s.rescueId, id, PNG);
    expect(up.status).toBe(201);
    expect(Object.keys(up.body.data.evidence).sort()).toEqual(['createdAt', 'id', 'mimeType', 'sizeBytes']); // no key, hash or filename
    const url = `${R(s.rescueId)}/incidents/${id}/evidence/${up.body.data.evidence.id}`;
    const admin = await signedInAgent(ctx, 'admin');
    for (const a of [s.runner.agent, s.provider.agent, s.ngo.agent, admin.agent]) {
      const res = await a.get(url);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toMatch(/no-store/);
    }
    for (const x of [await verifiedAgent(ctx, 'provider'), await matchedNgo(ctx, { metersAway: 2000 }), await runnerAt(ctx)]) expect((await x.agent.get(url)).status).toBe(404);
    expect((await request(ctx.app).get(url)).status).toBe(401);
    expect(JSON.stringify((await s.ngo.agent.get(R(s.rescueId))).body)).not.toMatch(/storage|sha256|incident-/);
    // The rescue view reports how many photos each incident has (regression: an unqualified id in the subquery always gave 0).
    expect((await s.ngo.agent.get(R(s.rescueId))).body.data.rescue.incidents[0].evidenceCount).toBe(1);
    expect((await events(ctx, s.rescueId)).some((e) => e.event_type === 'INCIDENT_EVIDENCE_ADDED')).toBe(true);
  });

  it('accepts only the reporter, only images, at most three, and only while the incident is open', async () => {
    const s = await assigned(ctx);
    const id = (await report(s.runner.agent, s.rescueId)).body.data.incident.id as string;
    expect((await upload(s.provider.agent, s.rescueId, id, PNG)).status).toBe(404); // not their report
    expect((await upload(s.runner.agent, s.rescueId, id, pdfBytes(), 'doc.pdf', 'application/pdf')).status).toBe(415);
    expect((await upload(s.runner.agent, s.rescueId, id, Buffer.from('not an image'), 'x.png')).status).toBe(415);
    expect((await upload(s.runner.agent, s.rescueId, id, Buffer.concat([PNG.subarray(0, 8), Buffer.from([0, 0, 0xff, 0xff])]), 'broken.png')).status).toBe(400);
    expect((await upload(s.runner.agent, s.rescueId, id, Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024 + 10)]), 'big.png')).status).toBe(413);
    expect(files(ctx.config.STORAGE_DIR).filter((f) => f.includes('incident-'))).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect((await upload(s.runner.agent, s.rescueId, id, PNG)).status).toBe(201);
    expect((await upload(s.runner.agent, s.rescueId, id, PNG)).body.code).toBe('EVIDENCE_LIMIT');
    expect(files(ctx.config.STORAGE_DIR).filter((f) => f.includes('incident-'))).toHaveLength(3);
    const admin = await signedInAgent(ctx, 'admin');
    await resolve(admin.agent, id, { resolution: 'NO_ACTION', note: 'Reviewed the photos' }).then((r) => expect(r.status).toBe(200));
    expect((await upload(s.runner.agent, s.rescueId, id, PNG)).body.code).toBe('INCIDENT_CLOSED');
    await expect(ctx.db.execute(sql`DELETE FROM incident_evidence`)).rejects.toThrow(); // append-only
  });
});

describe('the admin incident queue', () => {
  it('lists open incidents for admins only, most serious first, without private contact data', async () => {
    const s = await assigned(ctx);
    const low = (await report(s.runner.agent, s.rescueId, { severity: 'LOW', category: 'OTHER', description: 'Minor delay on the way here.' })).body.data.incident.id as string;
    const t = await inTransit(ctx);
    const high = (await report(t.runner.agent, t.rescueId, { category: 'FOOD_SAFETY', severity: 'CRITICAL', description: 'The box seal was broken in transit.' })).body.data.incident.id as string;
    const admin = await signedInAgent(ctx, 'admin');
    const list = await admin.agent.get('/api/v1/incidents?status=OPEN');
    expect(list.status).toBe(200);
    expect(list.body.data.incidents.map((i: { id: string }) => i.id)).toEqual([high, low]);
    expect(list.body.data.incidents[0]).toMatchObject({ category: 'FOOD_SAFETY', blocking: true, listingTitle: 'Vegetable Biryani', providerName: 'Test provider org' });
    expect(JSON.stringify(list.body)).not.toMatch(/contact|phone|email|storage/i);
    expect((await admin.agent.get(`/api/v1/incidents/${high}`)).body.data.incident.description).toMatch(/seal was broken/);
    expect((await admin.agent.get('/api/v1/incidents?status=NOPE')).status).toBe(400);
    for (const a of [s.runner.agent, s.provider.agent, s.ngo.agent]) {
      expect((await a.get('/api/v1/incidents')).status).toBe(403);
      expect((await a.get(`/api/v1/incidents/${high}`)).status).toBe(403);
    }
    expect((await request(ctx.app).get('/api/v1/incidents')).status).toBe(401);
    await resolve(admin.agent, low, { resolution: 'NO_ACTION', note: 'Not an issue' }).then((r) => expect(r.status).toBe(200));
    expect((await admin.agent.get('/api/v1/incidents?status=OPEN')).body.data.incidents).toHaveLength(1);
    expect((await admin.agent.get('/api/v1/incidents?status=RESOLVED')).body.data.incidents).toHaveLength(1);
    expect((await admin.agent.get('/api/v1/incidents?status=ALL')).body.data.incidents).toHaveLength(2);
  });
});
