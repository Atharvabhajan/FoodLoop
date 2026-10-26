import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { verifyRuntimeDatabase } from './db/privileges.js';
import { describeError, logger } from './log.js';
import { attachRealtime } from './realtime.js';
import { startEscalationWorker, type EscalationService } from './modules/escalation/service.js';
import { startExpiryWorker } from './modules/listings/expiry.js';
import { startRescueWorker, type RescueService } from './modules/rescues/service.js';
import { WORKER_LOCKS, advisoryGuard } from './ops/advisory-lock.js';

async function main() {
  // The API only ever uses DATABASE_URL. It never reads MIGRATION_DATABASE_URL and never falls back to another login.
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);

  // Refuse (production) or loudly warn (otherwise) when the runtime role could change the schema or rewrite audit history.
  const report = await verifyRuntimeDatabase(pool, config.privilegeCheck, (entry) => logger.warn(String(entry.msg), entry));

  let rescueService: RescueService | undefined;
  let escalationService: EscalationService | undefined;
  // The socket layer needs the HTTP server, which needs the app: forward through a late-bound function.
  let pushRescueChange: (users: string[], rescueId: string) => void = () => undefined;
  let pushListingChange: (listingId: string, userIds?: string[]) => void = () => undefined;
  const app = createApp({
    config,
    db,
    pool,
    onRescueService: (s) => (rescueService = s),
    onEscalationService: (s) => (escalationService = s),
    realtime: { rescueChanged: (users, id) => pushRescueChange(users, id), listingChanged: (id, users) => pushListingChange(id, users) },
  });
  const server = createServer(app);

  // Authenticated Socket.IO: per-user rooms, id-only "rescue.updated" events; the UI re-fetches over REST.
  // Rooms live in this process: the app is a single-node deployment (docs/phase-7-security-operations.md).
  const realtime = attachRealtime(server, db, config);
  const io = realtime.io;
  pushRescueChange = realtime.rescueChanged;
  pushListingChange = realtime.listingChanged;
  app.locals.realtimeUp = true;

  // Sweeps are idempotent and also guarded by a database advisory lock, so an overlapping second process cannot double-run them.
  const stopExpiry = startExpiryWorker(db, config.EXPIRY_INTERVAL_SECONDS, console.log, advisoryGuard(pool, WORKER_LOCKS.listingExpiry));
  const stopRescues = rescueService
    ? startRescueWorker(rescueService, config.EXPIRY_INTERVAL_SECONDS, console.log, advisoryGuard(pool, WORKER_LOCKS.rescueSettlement))
    : () => undefined;
  const stopEscalation = escalationService
    ? startEscalationWorker(escalationService, config.escalation.intervalSeconds, console.log, advisoryGuard(pool, WORKER_LOCKS.escalation))
    : () => undefined;

  server.listen(config.API_PORT, () => {
    logger.info('FoodLoop API listening', { port: config.API_PORT, dbRole: report.role, dbPrivilegeCheck: config.privilegeCheck, dbRoleClean: report.violations.length === 0 });
  });

  const shutdown = () => {
    stopExpiry();
    stopRescues();
    stopEscalation();
    io.close();
    server.close(() => void pool.end().finally(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  // Messages here never contain connection strings or passwords (see log.ts); startup failures are explicit.
  logger.error('API failed to start', describeError(err));
  process.exit(1);
});
