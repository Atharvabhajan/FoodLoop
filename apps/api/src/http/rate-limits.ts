import type { Request, RequestHandler, Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Config, RateLimitName } from '../config.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';

/**
 * Configurable rate limits with one consistent 429 body. Counters are in this process's memory (fixed window), so
 * limits apply per API instance; the app is single-node by design (docs/phase-7-security-operations.md).
 *
 * Keyed by the user id inside a *signature-verified* access token, else by client IP. Verifying the signature (not
 * the session) is enough: a forged cookie cannot choose its own bucket, and an expired token falls back to the IP.
 */
export function createLimiter(config: Config, name: RateLimitName, message: string): RequestHandler {
  const rule = config.rateLimits[name];
  return rateLimit({
    windowMs: rule.windowSeconds * 1000,
    limit: rule.max,
    skip: () => !config.RATE_LIMIT_ENABLED,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => keyFor(req, config),
    handler: (req, res) => {
      const resetAt = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
      const retryAfterSeconds = Math.max(1, Math.ceil(((resetAt?.getTime() ?? Date.now() + 1000) - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        message,
        details: { limiter: name, retryAfterSeconds },
        meta: { requestId: req.requestId },
      });
    },
  });
}

function keyFor(req: Request, config: Config): string {
  const raw = req.cookies?.fl_access;
  if (typeof raw === 'string') {
    const claims = verifyAccessToken(raw, config.JWT_ACCESS_SECRET);
    if (claims) return `u:${claims.sub}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

export function createRateLimiters(config: Config) {
  return {
    auth: createLimiter(config, 'AUTH', 'Too many attempts. Please wait a few minutes and try again.'),
    upload: createLimiter(config, 'UPLOAD', 'Too many uploads. Please wait a little before uploading again.'),
    rescueAction: createLimiter(config, 'RESCUE_ACTION', 'Too many actions in a short time. Please wait a moment and try again.'),
    incident: createLimiter(config, 'INCIDENT', 'Too many incident reports in a short time. Please wait before reporting again.'),
    location: createLimiter(config, 'LOCATION', 'Location updates are limited. Please slow down.'),
  };
}

export type RateLimiters = ReturnType<typeof createRateLimiters>;

/**
 * Mounts the limiters on the routes they protect. Called before the routers, so a limited request is refused before any
 * body is parsed or file buffered. Each request is counted by exactly one limiter (specific routes first).
 */
export function applyRateLimits(v1: Router, limits: RateLimiters) {
  const upload = /^\/(listings\/[^/]+\/image|organizations\/[^/]+\/documents|rescues\/[^/]+\/incidents\/[^/]+\/evidence)\/?$/;
  const incident = /^\/rescues\/[^/]+\/incidents\/?$/;
  const location = /^\/rescues\/[^/]+\/location\/?$/;
  // Any other state-changing rescue call (confirm, verify, handover, release, admin...) and accepting a listing.
  const rescueAction = (path: string) =>
    (/^\/rescues\/[^/]+\/[^/]+/.test(path) && !/^\/rescues\/[^/]+\/(location|incidents)(\/|$)/.test(path)) || /^\/listings\/[^/]+\/accept\/?$/.test(path);

  const post = (matches: (path: string) => boolean, mw: RequestHandler): RequestHandler => (req, res, next) =>
    req.method === 'POST' && matches(req.path) ? mw(req, res, next) : next();

  v1.use(post((p) => upload.test(p), limits.upload));
  v1.use(post((p) => incident.test(p), limits.incident));
  v1.use(post((p) => location.test(p), limits.location));
  v1.use(post(rescueAction, limits.rescueAction));
}
