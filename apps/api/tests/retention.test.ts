import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RetentionPolicy } from '../src/config.js';
import { runRetention } from '../src/ops/retention.js';
import { LocalDiskStorage, type FileStorage } from '../src/storage/index.js';
import { resetData, setup, signedInAgent, testDatabaseUrl, uploadDoc } from './helpers.js';
import { R, assigned, count, events, rows } from './runner-helpers.js';

const ctx = setup();
const storage = new LocalDiskStorage(ctx.config.STORAGE_DIR);
beforeEach(async () => {
  await resetData(ctx.db);
  rmSync(ctx.config.STORAGE_DIR, { recursive: true, force: true });
  mkdirSync(ctx.config.STORAGE_DIR, { recursive: true });
});
afterAll(() => ctx.pool.end());

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13)), chunk('IDAT', Buffer.from([1, 2, 3, 4])), chunk('IEND', Buffer.alloc(0))]);

const policy = (p: Partial<RetentionPolicy> = {}): RetentionPolicy => ({ evidenceDays: null, incidentDays: null, orphanFileHours: null, ...p });
const run = (p: RetentionPolicy, execute: boolean, s: FileStorage = storage) => runRetention({ db: ctx.db, storage: s, policy: p, execute });

/** Runs the real flow: report, attach photos, resolve (cancelling the rescue so it is closed), then age the resolution. */
async function resolvedIncident(opts: { ageDays: number; photos?: number; resolution?: 'CANCEL_RESCUE' | 'NO_ACTION'; description?: string }) {
  const s = await assigned(ctx);
  const admin = await signedInAgent(ctx, 'admin');
  const report = await s.runner.agent.post(`${R(s.rescueId)}/incidents`).send({ category: 'FOOD_SAFETY', severity: 'HIGH', description: opts.description ?? 'The food smells strongly of smoke and gas.' });
  expect(report.status).toBe(201);
  const incidentId = report.body.data.incident.id as string;
  for (let i = 0; i < (opts.photos ?? 0); i++) {
    const up = await s.runner.agent.post(`${R(s.rescueId)}/incidents/${incidentId}/evidence`).attach('file', PNG, { filename: `p${i}.png`, contentType: 'image/png' });
    expect(up.status).toBe(201);
  }
  const res = await admin.agent.post(`/api/v1/incidents/${incidentId}/resolve`).send({ resolution: opts.resolution ?? 'CANCEL_RESCUE', note: 'Reviewed and closed by the administrator.' });
  expect(res.status).toBe(200);
  await backdate(incidentId, opts.ageDays);
  return { ...s, incidentId, admin };
}

/** Test-only: resolved reports are immutable, so ageing one needs the guard trigger briefly off (privileged connection). */
async function backdate(incidentId: string, days: number) {
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE incident_reports DISABLE TRIGGER incident_reports_guard`);
    await tx.execute(sql`UPDATE incident_reports SET resolved_at = now() - make_interval(days => ${days}) WHERE id = ${incidentId}::uuid`);
    await tx.execute(sql`ALTER TABLE incident_reports ENABLE TRIGGER incident_reports_guard`);
  });
}

const evidenceFiles = async (incidentId: string) => (await rows(ctx, sql`SELECT storage_key FROM incident_evidence WHERE incident_id = ${incidentId}::uuid`)).map((r) => r.storage_key as string);
const totals = async () => ({
  incidents: await count(ctx, sql`SELECT count(*)::int AS n FROM incident_reports`),
  evidence: await count(ctx, sql`SELECT count(*)::int AS n FROM incident_evidence`),
  runs: await count(ctx, sql`SELECT count(*)::int AS n FROM retention_runs`),
  events: await count(ctx, sql`SELECT count(*)::int AS n FROM rescue_events`),
});

describe('nothing happens without a configured period', () => {
  it('does nothing in dry-run or execute mode, and records no run', async () => {
    await resolvedIncident({ ageDays: 4000, photos: 2 });
    const before = await totals();
    for (const execute of [false, true]) {
      const r = await run(policy(), execute);
      expect(r).toMatchObject({ evidence: { eligible: 0, deleted: 0 }, incidents: { eligible: 0, deleted: 0 }, orphans: { eligible: 0, deleted: 0 }, failures: 0 });
    }
    expect(await totals()).toEqual(before);
  });
});

describe('dry run (the default)', () => {
  it('reports what would be removed and changes nothing', async () => {
    const x = await resolvedIncident({ ageDays: 120, photos: 2 });
    const files = await evidenceFiles(x.incidentId);
    const before = await totals();
    const r = await run(policy({ evidenceDays: 30, incidentDays: 90 }), false);
    expect(r).toMatchObject({ mode: 'dry-run', evidence: { eligible: 2, deleted: 0 }, incidents: { eligible: 1, deleted: 0 }, failures: 0 });
    expect(await totals()).toEqual(before);
    for (const f of files) expect(existsSync(path.join(ctx.config.STORAGE_DIR, f))).toBe(true);
  });
});

describe('what is eligible', () => {
  it('measures from the day the incident was resolved, per period', async () => {
    const recent = await resolvedIncident({ ageDays: 10, photos: 1 });
    const mid = await resolvedIncident({ ageDays: 40, photos: 1 });
    const old = await resolvedIncident({ ageDays: 120, photos: 1 });
    const r = await run(policy({ evidenceDays: 30, incidentDays: 100 }), false);
    expect(r.evidence.eligible).toBe(2); // mid and old photos
    expect(r.incidents.eligible).toBe(1); // only the old incident
    expect([recent, mid, old].every((x) => x.incidentId)).toBe(true);
  });

  it('never touches an open incident, however old', async () => {
    const s = await assigned(ctx);
    const report = await s.runner.agent.post(`${R(s.rescueId)}/incidents`).send({ category: 'OTHER', severity: 'LOW', description: 'Waiting at the gate for ages.' });
    await s.runner.agent.post(`${R(s.rescueId)}/incidents/${report.body.data.incident.id}/evidence`).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE incident_reports DISABLE TRIGGER incident_reports_guard`);
      await tx.execute(sql`UPDATE incident_reports SET created_at = now() - interval '2000 days'`);
      await tx.execute(sql`ALTER TABLE incident_reports ENABLE TRIGGER incident_reports_guard`);
    });
    const r = await run(policy({ evidenceDays: 7, incidentDays: 30 }), true);
    expect(r.evidence.eligible + r.incidents.eligible).toBe(0);
    expect((await totals()).evidence).toBe(1);
  });

  it('never touches a resolved incident whose rescue is still in progress', async () => {
    const x = await resolvedIncident({ ageDays: 400, photos: 1, resolution: 'NO_ACTION' });
    expect(x.incidentId).toBeTruthy();
    const r = await run(policy({ evidenceDays: 30, incidentDays: 90 }), true);
    expect(r.evidence.eligible + r.incidents.eligible).toBe(0);
    expect((await totals()).evidence).toBe(1);
  });
});

describe('executing', () => {
  it('removes old photos (file and row) but keeps the report and the rescue history', async () => {
    const x = await resolvedIncident({ ageDays: 60, photos: 2 });
    const files = await evidenceFiles(x.incidentId);
    const eventsBefore = (await events(ctx, x.rescueId)).length;
    const r = await run(policy({ evidenceDays: 30 }), true);
    expect(r).toMatchObject({ mode: 'execute', evidence: { eligible: 2, deleted: 2 }, incidents: { eligible: 0, deleted: 0 }, failures: 0 });
    for (const f of files) expect(existsSync(path.join(ctx.config.STORAGE_DIR, f))).toBe(false);
    expect(await totals()).toMatchObject({ incidents: 1, evidence: 0, runs: 1 });
    // The rescue still tells the story; the purge adds one event with ids and counts only.
    const after = await events(ctx, x.rescueId);
    expect(after.length).toBe(eventsBefore + 1);
    const purge = after.find((e) => e.event_type === 'RETENTION_PURGED')!;
    expect(purge).toMatchObject({ actor_role: 'system', metadata: { incidentId: x.incidentId, evidenceRemoved: 2, incidentRemoved: false } });
    expect(JSON.stringify(purge.metadata)).not.toMatch(/incident-|\.png|smoke/);
    const view = (await x.ngo.agent.get(R(x.rescueId))).body.data.rescue;
    expect(view.incidents[0]).toMatchObject({ id: x.incidentId, evidenceCount: 0 });
  });

  it('removes a whole old incident, report included, and says so in the history', async () => {
    const x = await resolvedIncident({ ageDays: 200, photos: 1, description: 'Distinctive text about a damaged crate.' });
    const r = await run(policy({ evidenceDays: 30, incidentDays: 180 }), true);
    expect(r).toMatchObject({ evidence: { deleted: 1 }, incidents: { eligible: 1, deleted: 1 }, failures: 0 });
    expect(await totals()).toMatchObject({ incidents: 0, evidence: 0 });
    const view = (await x.ngo.agent.get(R(x.rescueId))).body.data.rescue;
    expect(view.incidents).toEqual([]);
    const purge = (await events(ctx, x.rescueId)).find((e) => e.event_type === 'RETENTION_PURGED')!;
    expect(purge.metadata).toMatchObject({ incidentRemoved: true });
    expect((await events(ctx, x.rescueId)).some((e) => e.event_type === 'INCIDENT_REPORTED')).toBe(true); // history is never deleted
  });

  it('records the run with counts only', async () => {
    await resolvedIncident({ ageDays: 60, photos: 1 });
    await run(policy({ evidenceDays: 30 }), true);
    const row = (await rows(ctx, sql`SELECT policy, counts, failures FROM retention_runs`))[0]!;
    expect(row.counts).toEqual({ evidence: 1, incidents: 0, orphans: 0 });
    expect(row.failures).toBe(0);
    expect(JSON.stringify(row)).not.toMatch(/incident-|\.png|storage/);
  });

  it('is idempotent: a second run finds nothing', async () => {
    await resolvedIncident({ ageDays: 60, photos: 2 });
    await run(policy({ evidenceDays: 30 }), true);
    const again = await run(policy({ evidenceDays: 30 }), true);
    expect(again).toMatchObject({ evidence: { eligible: 0, deleted: 0 }, incidents: { eligible: 0, deleted: 0 } });
  });

  it('keeps the row when a file cannot be removed, reports the failure, and finishes on the next run', async () => {
    const x = await resolvedIncident({ ageDays: 60, photos: 2 });
    const [first] = await evidenceFiles(x.incidentId);
    const flaky: FileStorage = {
      save: (n, e, d) => storage.save(n, e, d),
      open: (k) => storage.open(k),
      list: () => storage.list(),
      remove: async (k) => {
        if (k === first) throw new Error('disk error at /secret/path');
        await storage.remove(k);
      },
    };
    const r = await run(policy({ evidenceDays: 30 }), true, flaky);
    expect(r.failures).toBe(1);
    expect(r.evidence.deleted).toBe(1);
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM incident_evidence`)).toBe(1); // the failing one is kept
    const healed = await run(policy({ evidenceDays: 30 }), true);
    expect(healed).toMatchObject({ failures: 0, evidence: { deleted: 1 } });
    expect(await count(ctx, sql`SELECT count(*)::int AS n FROM incident_evidence`)).toBe(0);
  });

  it('treats an already-missing file as removed (a crash between file and row heals itself)', async () => {
    const x = await resolvedIncident({ ageDays: 60, photos: 1 });
    const [key] = await evidenceFiles(x.incidentId);
    rmSync(path.join(ctx.config.STORAGE_DIR, key!));
    const r = await run(policy({ evidenceDays: 30 }), true);
    expect(r).toMatchObject({ evidence: { deleted: 1 }, failures: 0 });
  });
});

describe('the database refuses everything else', () => {
  it('rejects deleting evidence or incidents without the purge switch, even for the owner', async () => {
    const x = await resolvedIncident({ ageDays: 60, photos: 1 });
    await expect(ctx.db.execute(sql`DELETE FROM incident_evidence`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`DELETE FROM incident_reports`)).rejects.toThrow();
    expect(x.incidentId).toBeTruthy();
    expect((await totals()).evidence).toBe(1);
  });

  it('rejects the purge switch for material that is not resolved', async () => {
    const s = await assigned(ctx);
    const report = await s.runner.agent.post(`${R(s.rescueId)}/incidents`).send({ category: 'OTHER', severity: 'LOW', description: 'Nobody has looked at this yet.' });
    await s.runner.agent.post(`${R(s.rescueId)}/incidents/${report.body.data.incident.id}/evidence`).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('foodloop.retention_purge', 'on', true)`);
        await tx.execute(sql`DELETE FROM incident_evidence`);
      }),
    ).rejects.toThrow();
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('foodloop.retention_purge', 'on', true)`);
        await tx.execute(sql`DELETE FROM incident_reports`);
      }),
    ).rejects.toThrow();
    expect((await totals()).incidents).toBe(1);
  });

  it('keeps resolved reports editable by no one, purge switch or not', async () => {
    const x = await resolvedIncident({ ageDays: 60 });
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('foodloop.retention_purge', 'on', true)`);
        await tx.execute(sql`UPDATE incident_reports SET description = 'rewritten' WHERE id = ${x.incidentId}::uuid`);
      }),
    ).rejects.toThrow();
  });

  it('never allows the purge switch to remove rescue history', async () => {
    const x = await resolvedIncident({ ageDays: 60 });
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('foodloop.retention_purge', 'on', true)`);
        await tx.execute(sql`DELETE FROM rescue_events WHERE rescue_id = ${x.rescueId}::uuid`);
      }),
    ).rejects.toThrow();
  });
});

describe('orphan files (debris from failed uploads)', () => {
  const age = (key: string, hours: number) => {
    const t = new Date(Date.now() - hours * 3_600_000);
    utimesSync(path.join(ctx.config.STORAGE_DIR, key), t, t);
  };

  it('reports and removes only unreferenced files older than the period', async () => {
    const owner = await signedInAgent(ctx, 'provider');
    expect((await uploadDoc(owner.agent, owner.organizationId!)).status).toBe(201);
    const referenced = (await rows(ctx, sql`SELECT storage_key FROM verification_documents`))[0]!.storage_key as string;
    const oldOrphan = await storage.save('listing-ghost', 'png', PNG);
    const youngOrphan = await storage.save('listing-ghost', 'png', PNG);
    age(referenced, 500);
    age(oldOrphan, 100);
    age(youngOrphan, 2);

    const dry = await run(policy({ orphanFileHours: 48 }), false);
    expect(dry.orphans).toEqual({ eligible: 1, deleted: 0 });
    expect(existsSync(path.join(ctx.config.STORAGE_DIR, oldOrphan))).toBe(true);

    const real = await run(policy({ orphanFileHours: 48 }), true);
    expect(real.orphans).toEqual({ eligible: 1, deleted: 1 });
    expect(existsSync(path.join(ctx.config.STORAGE_DIR, oldOrphan))).toBe(false);
    expect(existsSync(path.join(ctx.config.STORAGE_DIR, youngOrphan))).toBe(true); // might be an upload in flight
    expect(existsSync(path.join(ctx.config.STORAGE_DIR, referenced))).toBe(true); // referenced, however old
  });

  it('never treats evidence or listing images as orphans', async () => {
    const x = await resolvedIncident({ ageDays: 1, photos: 1, resolution: 'NO_ACTION' });
    const [key] = await evidenceFiles(x.incidentId);
    age(key!, 1000);
    expect((await run(policy({ orphanFileHours: 1 }), false)).orphans.eligible).toBe(0);
  });

  it('lists stored files by key and copes with a missing storage directory', async () => {
    const key = await storage.save('listing-abc', 'png', PNG);
    const listed: string[] = [];
    for await (const f of storage.list()) listed.push(f.key);
    expect(listed).toContain(key);
    expect(key).toMatch(/^listing-abc\/[0-9a-f-]+\.png$/);
    const none: string[] = [];
    for await (const f of new LocalDiskStorage(path.join(tmpdir(), 'foodloop-does-not-exist-xyz')).list()) none.push(f.key);
    expect(none).toEqual([]);
  });
});

describe('the operator command', () => {
  const cli = (args: string[], env: Record<string, string>) => {
    const result: { code: number; out: string } = { code: 0, out: '' };
    try {
      result.out = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/retention-cli.ts', ...args], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', MIGRATION_DATABASE_URL: testDatabaseUrl(), STORAGE_DIR: ctx.config.STORAGE_DIR, ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      result.code = e.status ?? 1;
      result.out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    return result;
  };

  it('defaults to a dry run that changes nothing, and prints counts only', async () => {
    const x = await resolvedIncident({ ageDays: 60, photos: 1 });
    const files = await evidenceFiles(x.incidentId);
    const r = cli([], { RETENTION_EVIDENCE_DAYS: '30' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/DRY RUN \(nothing was changed\)/);
    expect(r.out).toMatch(/1 would be removed/);
    expect(r.out).not.toContain(files[0]!);
    expect(r.out).not.toContain(new URL(testDatabaseUrl()).password);
    expect(r.out).not.toMatch(/postgres:\/\//);
    expect((await totals()).evidence).toBe(1);
  });

  it('refuses to execute with no retention period configured', () => {
    const r = cli(['--execute'], {});
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No retention period is configured/);
  });

  it('executes only when asked with --execute', async () => {
    await resolvedIncident({ ageDays: 60, photos: 1 });
    const r = cli(['--execute'], { RETENTION_EVIDENCE_DAYS: '30' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/EXECUTED retention run/);
    expect((await totals()).evidence).toBe(0);
  });

  it('rejects unknown or conflicting options and invalid periods', () => {
    expect(cli(['--yes'], { RETENTION_EVIDENCE_DAYS: '30' }).code).toBe(1);
    expect(cli(['--execute', '--dry-run'], { RETENTION_EVIDENCE_DAYS: '30' }).code).toBe(1);
    const bad = cli([], { RETENTION_EVIDENCE_DAYS: '1' });
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/Invalid retention configuration/);
  });
});
