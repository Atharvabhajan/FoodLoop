import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PlatformRole } from '../db/schema.js';
import { AppError, errors } from './errors.js';
import { hasPermission, type Permission } from './permissions.js';

export function requestId(req: Request, res: Response, next: NextFunction) {
  req.requestId = `req_${randomUUID()}`;
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/**
 * Cookie-authenticated, state-changing requests must come from an allow-listed origin.
 * Browsers always send Origin on cross-site POST/PUT/PATCH/DELETE, so this blocks CSRF.
 */
export function originGuard(allowed: string[]): RequestHandler {
  return (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && !allowed.includes(origin)) {
      return next(new AppError(403, 'FORBIDDEN_ORIGIN', 'Request origin is not allowed.'));
    }
    next();
  };
}

export function requireRole(...roles: PlatformRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(errors.unauthenticated());
    if (!roles.includes(req.auth.user.platformRole)) return next(errors.forbidden());
    next();
  };
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(errors.unauthenticated());
    if (!hasPermission(req.auth.user.platformRole, permission)) return next(errors.forbidden());
    next();
  };
}
