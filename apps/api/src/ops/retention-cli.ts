import { describeTarget, resolveAdminUrl } from '../db/admin-url.js';
import { createDb } from '../db/client.js';
import { DEFAULT_STORAGE_DIR, loadRetentionPolicy } from '../config.js';
import { LocalDiskStorage } from '../storage/index.js';
import { policyIsEmpty, runRetention } from './retention.js';

/**
 * Operator command:
 *   npm run retention                 dry run: reports what WOULD be removed, changes nothing (default)
 *   npm run retention -- --execute    removes it
 * Needs RETENTION_EVIDENCE_DAYS / RETENTION_INCIDENT_DAYS / RETENTION_ORPHAN_FILE_HOURS; with none set it does nothing.
 * Prints counts only (never file names, descriptions or other content).
 */
async function main() {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((a) => a !== '--execute' && a !== '--dry-run');
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(' ')}. Use --dry-run (default) or --execute.`);
  if (args.has('--execute') && args.has('--dry-run')) throw new Error('Choose either --dry-run or --execute, not both.');
  const execute = args.has('--execute');

  const policy = loadRetentionPolicy();
  if (policyIsEmpty(policy)) {
    console.log('No retention period is configured (RETENTION_EVIDENCE_DAYS, RETENTION_INCIDENT_DAYS, RETENTION_ORPHAN_FILE_HOURS). Nothing to do.');
    if (execute) process.exitCode = 1;
    return;
  }

  const url = resolveAdminUrl();
  console.log(`Privileged connection: ${describeTarget(url)}`);
  console.log(`Policy: evidence ${policy.evidenceDays ?? 'keep'} day(s) after resolution, incidents ${policy.incidentDays ?? 'keep'} day(s), orphan files ${policy.orphanFileHours ?? 'keep'} hour(s)`);
  const { db, pool } = createDb(url);
  try {
    const storage = new LocalDiskStorage(process.env.STORAGE_DIR ?? DEFAULT_STORAGE_DIR);
    const r = await runRetention({ db, storage, policy, execute });
    console.log(execute ? 'EXECUTED retention run:' : 'DRY RUN (nothing was changed):');
    console.log(`  evidence photos : ${execute ? `${r.evidence.deleted} removed of ${r.evidence.eligible} eligible` : `${r.evidence.eligible} would be removed`}`);
    console.log(`  resolved incidents: ${execute ? `${r.incidents.deleted} removed of ${r.incidents.eligible} eligible` : `${r.incidents.eligible} would be removed`}`);
    console.log(`  orphan files    : ${execute ? `${r.orphans.deleted} removed of ${r.orphans.eligible} eligible` : `${r.orphans.eligible} would be removed`}`);
    if (r.failures > 0) {
      console.log(`  failures        : ${r.failures} (see the error lines above; safe to re-run)`);
      process.exitCode = 1;
    }
    if (!execute) console.log('Re-run with --execute to apply.');
  } finally {
    await pool.end();
  }
}

main().catch((err: Error) => {
  console.error(`Retention failed: ${err.message}`);
  process.exit(1);
});
