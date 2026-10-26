import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Config } from './config.js';
import { describeError, logger } from './log.js';
import type { Db, Pool } from './db/client.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { originGuard, requestId } from './http/middleware.js';
import { applyRateLimits, createRateLimiters } from './http/rate-limits.js';
import { createAccessRouter } from './modules/access/routes.js';
import { createAuthRouter, createAuthenticate } from './modules/auth/routes.js';
import { createAuthService } from './modules/auth/service.js';
import { createHealthRouter } from './modules/health/routes.js';
import { createDocumentService } from './modules/organizations/documents.js';
import { createOrganizationsRouter } from './modules/organizations/routes.js';
import { createMatchingRouter } from './modules/matching/routes.js';
import { createEscalationService, type EscalationService } from './modules/escalation/service.js';
import { createMatchingService } from './modules/matching/service.js';
import { createNotificationsRouter } from './modules/notifications/routes.js';
import { createBoardRouter } from './modules/board/routes.js';
import { createBoardService } from './modules/board/service.js';
import { createImpactRouter } from './modules/impact/routes.js';
import { createImpactService } from './modules/impact/service.js';
import { createIncidentService } from './modules/incidents/service.js';
import { createAcceptRouter, createRescuesRouter } from './modules/rescues/routes.js';
import { createRunnerRoutes } from './modules/runners/routes.js';
import { createRunnerService } from './modules/runners/service.js';
import { createRescueService, type RescueService } from './modules/rescues/service.js';
import { createListingsRouter } from './modules/listings/routes.js';
import { createListingService } from './modules/listings/service.js';
import { createRequirementsRouter } from './modules/requirements/routes.js';
import { createRequirementService } from './modules/requirements/service.js';
import { createOrganizationService } from './modules/organizations/service.js';
import { createAdminVerificationRouter } from './modules/verification/routes.js';
import { createVerificationService } from './modules/verification/service.js';
import { LocalDiskStorage, type FileStorage } from './storage/index.js';

export interface AppDeps {
  /** Real-time nudges (ids only); the server wires this to Socket.IO. */
  realtime?: { rescueChanged(userIds: string[], rescueId: string): void; listingChanged?(listingId: string, userIds?: string[]): void };
  /** Optional hook to receive the rescue service (the server starts its expiry worker with it). */
  onRescueService?: (service: RescueService) => void;
  /** Optional hook to receive the escalation service (the server starts its worker with it). */
  onEscalationService?: (service: EscalationService) => void;
  config: Config;
  db: Db;
  pool: Pool;
  /** Defaults to local disk at config.STORAGE_DIR; replace with object storage later. */
  storage?: FileStorage;
}

export function createApp({ config, db, pool, storage = new LocalDiskStorage(config.STORAGE_DIR), onRescueService, onEscalationService, realtime }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  // Only trust X-Forwarded-For from a proxy we actually run (e.g. the Next.js rewrite): 0 hops = ignore it.
  if (config.TRUST_PROXY_HOPS > 0) app.set('trust proxy', config.TRUST_PROXY_HOPS);

  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(originGuard(config.corsOrigins));

  const authService = createAuthService(db, config);
  const authenticate = createAuthenticate(authService, config);

  const v1 = express.Router();
  const limits = createRateLimiters(config);
  applyRateLimits(v1, limits);
  v1.use('/health', createHealthRouter(pool));
  v1.use('/auth', createAuthRouter(authService, config, authenticate, limits.auth));
  v1.use('/access', createAccessRouter(authenticate));
  // Recommendations are refreshed after the triggering change commits. A failed refresh is logged and
  // can be retried via the explicit refresh endpoints; it never undoes the user's change.
  // Escalation waves own the notifications (wave by wave); matching only computes and ranks candidates. With
  // ESCALATION_ENABLED=false it falls back to telling every eligible NGO at once, as before waves existed.
  const matching = createMatchingService(db, config.match, undefined, { notifyOnRecompute: !config.escalation.enabled });
  const escalation = createEscalationService(db, config.escalation, {
    match: config.match,
    rescue: config.rescue,
    matching,
    hooks: { notified: (listingId, userIds) => realtime?.listingChanged?.(listingId, userIds) },
  });
  onEscalationService?.(escalation);
  const safely = (what: string, fn: (id: string) => Promise<unknown>) => async (id: string) => {
    try {
      await fn(id);
    } catch (err) {
      logger.error(`Match refresh failed (${what})`, describeError(err));
    }
  };
  /** Schedules the waves for a listing that just opened (or re-opened) and runs any step that is already due. Never throws. */
  const escalate = async (id: string, reason: 'PUBLISHED' | 'RELEASED') => {
    try {
      await escalation.schedule(id, reason);
      await escalation.runDue(undefined, id);
    } catch (err) {
      logger.error('Escalation failed to start', describeError(err));
    }
  };
  const orgService = createOrganizationService(db, {
    coordinatesAdded: safely('organization coordinates', async (id) => {
      await matching.recomputeForNgo(id);
    }),
  });
  const docService = createDocumentService(db, storage, orgService);
  v1.use('/organizations', createOrganizationsRouter(orgService, docService, authenticate));
  v1.use('/admin/verifications', createAdminVerificationRouter(
      createVerificationService(db, { ngoApproved: safely('ngo approved', (id) => matching.recomputeForNgo(id)) }),
      authenticate,
    ));
  const rescueService = createRescueService(db, config.rescue, matching, undefined, {
    listingReleased: async (id) => {
      realtime?.listingChanged?.(id);
      await safely('listing released', (x) => matching.recomputeListing(x))(id);
      await escalate(id, 'RELEASED');
    },
    rescueChanged: realtime ? (users, id) => realtime.rescueChanged(users, id) : undefined,
  });
  onRescueService?.(rescueService);
  // Matching and accept routes first: /listings/recommended must not be read as a listing id.
  v1.use('/listings', createMatchingRouter(matching, authenticate));
  v1.use('/listings', createAcceptRouter(rescueService, authenticate));
  // Phase 6: runners, location and incidents. These routes are mounted first so static paths such as
  // /rescues/available-runs are not read as a rescue id.
  const runnerService = createRunnerService(rescueService.internals, config.match);
  const incidentService = createIncidentService(rescueService.internals, runnerService, storage);
  const runnerRoutes = createRunnerRoutes(rescueService, runnerService, incidentService, authenticate);
  v1.use('/rescues', runnerRoutes.rescueExtras);
  v1.use('/rescues', createRescuesRouter(rescueService, authenticate));
  v1.use('/runner', runnerRoutes.profile);
  v1.use('/incidents', runnerRoutes.admin);
  v1.use(
    '/listings',
    createListingsRouter(
      createListingService(db, storage, undefined, {
        listingChanged: async (id) => {
          realtime?.listingChanged?.(id);
          await safely('listing changed', (x) => matching.recomputeListing(x))(id);
          await escalate(id, 'PUBLISHED'); // a no-op unless this is the first time the listing is live
        },
      }),
      authenticate,
    ),
  );
  v1.use(
    '/ngo-requirements',
    createRequirementsRouter(
      createRequirementService(db, undefined, { requirementChanged: safely('requirement changed', (id) => matching.recomputeForNgo(id)) }),
      authenticate,
    ),
  );
  v1.use('/notifications', createNotificationsRouter(db, authenticate));
  v1.use('/impact', createImpactRouter(createImpactService(db), authenticate));
  v1.use('/admin/board', createBoardRouter(createBoardService(db, config.rescue, undefined, escalation), rescueService, authenticate, escalation));
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler(config.NODE_ENV !== 'test'));
  return app;
}
