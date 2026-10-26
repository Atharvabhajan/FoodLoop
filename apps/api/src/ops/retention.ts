import { sql } from 'drizzle-orm';
import type { RetentionPolicy } from '../config.js';
import type { Db } from '../db/client.js';
import { rescueEvents, retentionRuns } from '../db/schema.js';
import { describeError } from '../log.js';
import type { FileStorage } from '../storage/index.js';

/**
 * Retention for resolved incidents and their evidence photos (operator command; see docs/phase-7-security-operations.md).
 *
 * Rules: nothing is touched unless a period is configured; open incidents are never touched; only incidents on closed
 * rescues are considered; the cut-off is measured from the day the incident was RESOLVED. A dry run (the default) reads
 * and reports only. The privileged connection is required because the runtime role cannot delete audit-style rows.
 *
 * What is removed, by policy:
 *  - evidenceDays: photos (file and row) of incidents resolved that long ago. The report text stays.
 *  - incidentDays: the whole resolved incident (report, any photos left) resolved that long ago.
 *  - orphanFileHours: files in storage that no row references and that are older than this (failed-upload debris).
 * The rescue's own event history is never deleted; each purge adds a RETENTION_PURGED event (ids and counts only).
 */

const CLOSED_RESCUE = ['COMPLETED', 'CANCELLED', 'EXPIRED', 'PICKUP_FAILED'];

export interface RetentionReport {
  mode: 'dry-run' | 'execute';
  policy: RetentionPolicy;
  evidence: { eligible: number; deleted: number };
  incidents: { eligible: number; deleted: number };
  orphans: { eligible: number; deleted: number };
  failures: number;
}

export function policyIsEmpty(p: RetentionPolicy) {
  return p.evidenceDays === null && p.incidentDays === null && p.orphanFileHours === null;
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

interface Candidate {
  incidentId: string;
  rescueId: string;
  dropIncident: boolean;
  evidence: { id: string; key: string }[];
}

async function findIncidentCandidates(db: Db, policy: RetentionPolicy, now: Date): Promise<Candidate[]> {
  if (policy.evidenceDays === null && policy.incidentDays === null) return [];
  const evidenceCutoff = policy.evidenceDays === null ? null : daysAgo(now, policy.evidenceDays);
  const incidentCutoff = policy.incidentDays === null ? null : daysAgo(now, policy.incidentDays);
  const found = await db.execute(sql`
    SELECT i.id AS incident_id, i.rescue_id,
           (${incidentCutoff}::timestamptz IS NOT NULL AND i.resolved_at < ${incidentCutoff}::timestamptz) AS drop_incident
      FROM incident_reports i
      JOIN rescues r ON r.id = i.rescue_id
     WHERE i.status = 'RESOLVED' AND i.resolved_at IS NOT NULL
       AND r.status IN (${sql.join(CLOSED_RESCUE.map((s) => sql`${s}`), sql`, `)})
       AND ((${evidenceCutoff}::timestamptz IS NOT NULL AND i.resolved_at < ${evidenceCutoff}::timestamptz)
         OR (${incidentCutoff}::timestamptz IS NOT NULL AND i.resolved_at < ${incidentCutoff}::timestamptz))
     ORDER BY i.resolved_at ASC`);
  const out: Candidate[] = [];
  for (const row of found.rows as { incident_id: string; rescue_id: string; drop_incident: boolean }[]) {
    const ev = await db.execute(sql`SELECT id, storage_key FROM incident_evidence WHERE incident_id = ${row.incident_id}::uuid ORDER BY created_at`);
    out.push({
      incidentId: row.incident_id,
      rescueId: row.rescue_id,
      dropIncident: row.drop_incident,
      evidence: (ev.rows as { id: string; storage_key: string }[]).map((e) => ({ id: e.id, key: e.storage_key })),
    });
  }
  return out;
}

async function findOrphans(db: Db, storage: FileStorage, policy: RetentionPolicy, now: Date): Promise<string[]> {
  if (policy.orphanFileHours === null) return [];
  const cutoff = now.getTime() - policy.orphanFileHours * 3_600_000;
  // List first, then read references: a file uploaded in between is newer than any allowed cut-off anyway.
  const files: { key: string; modifiedAt: Date }[] = [];
  for await (const f of storage.list()) files.push(f);
  const referenced = new Set<string>();
  const rows = await db.execute(sql`
    SELECT storage_key AS k FROM verification_documents
    UNION SELECT image_key FROM food_listings WHERE image_key IS NOT NULL
    UNION SELECT storage_key FROM incident_evidence`);
  for (const r of rows.rows as { k: string }[]) referenced.add(r.k);
  return files.filter((f) => !referenced.has(f.key) && f.modifiedAt.getTime() < cutoff).map((f) => f.key);
}

export async function runRetention(opts: { db: Db; storage: FileStorage; policy: RetentionPolicy; execute: boolean; now?: Date }): Promise<RetentionReport> {
  const { db, storage, policy, execute } = opts;
  const now = opts.now ?? new Date();
  const startedAt = new Date();
  // No configured period means nothing is eligible, whatever the mode.
  if (policyIsEmpty(policy)) {
    return { mode: execute ? 'execute' : 'dry-run', policy, evidence: { eligible: 0, deleted: 0 }, incidents: { eligible: 0, deleted: 0 }, orphans: { eligible: 0, deleted: 0 }, failures: 0 };
  }
  const candidates = await findIncidentCandidates(db, policy, now);
  const orphanKeys = await findOrphans(db, storage, policy, now);

  const report: RetentionReport = {
    mode: execute ? 'execute' : 'dry-run',
    policy,
    evidence: { eligible: candidates.reduce((n, c) => n + c.evidence.length, 0), deleted: 0 },
    incidents: { eligible: candidates.filter((c) => c.dropIncident).length, deleted: 0 },
    orphans: { eligible: orphanKeys.length, deleted: 0 },
    failures: 0,
  };
  if (!execute) return report;

  for (const c of candidates) {
    const removable: { id: string; key: string }[] = [];
    for (const e of c.evidence) {
      try {
        await storage.remove(e.key); // already-missing files are fine; a real I/O error keeps the row for the next run
        removable.push(e);
      } catch (err) {
        report.failures += 1;
        console.error(JSON.stringify({ level: 'error', msg: 'Retention: could not remove a stored file', ...describeError(err) }));
      }
    }
    const allRemoved = removable.length === c.evidence.length;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('foodloop.retention_purge', 'on', true)`);
        for (const e of removable) await tx.execute(sql`DELETE FROM incident_evidence WHERE id = ${e.id}::uuid`);
        const dropped = c.dropIncident && allRemoved;
        if (dropped) await tx.execute(sql`DELETE FROM incident_reports WHERE id = ${c.incidentId}::uuid AND status = 'RESOLVED'`);
        if (removable.length > 0 || dropped) {
          await tx.insert(rescueEvents).values({
            rescueId: c.rescueId,
            eventType: 'RETENTION_PURGED',
            actorUserId: null,
            actorRole: 'system',
            metadata: { incidentId: c.incidentId, evidenceRemoved: removable.length, incidentRemoved: dropped },
          });
        }
        report.evidence.deleted += removable.length;
        if (dropped) report.incidents.deleted += 1;
      });
    } catch (err) {
      report.failures += 1;
      console.error(JSON.stringify({ level: 'error', msg: 'Retention: database purge failed for one incident', ...describeError(err) }));
    }
  }

  for (const key of orphanKeys) {
    try {
      await storage.remove(key);
      report.orphans.deleted += 1;
    } catch (err) {
      report.failures += 1;
      console.error(JSON.stringify({ level: 'error', msg: 'Retention: could not remove an orphan file', ...describeError(err) }));
    }
  }

  await db.insert(retentionRuns).values({
    startedAt,
    policy,
    counts: { evidence: report.evidence.deleted, incidents: report.incidents.deleted, orphans: report.orphans.deleted },
    failures: report.failures,
  });
  return report;
}
