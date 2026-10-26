import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { describeError, logger } from '../log.js';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const errors = {
  unauthenticated: (message = 'Authentication is required.') =>
    new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have permission to perform this action.') =>
    new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'The requested resource was not found.') =>
    new AppError(404, 'NOT_FOUND', message),
};

export function validationError(err: ZodError) {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  return new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', { fields });
}

/** Builds the standard 400 VALIDATION_ERROR from a field -> message map. */
export function fieldErrors(fields: Record<string, string>) {
  return new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', { fields });
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(errors.notFound('Route not found.'));
}

export function errorHandler(logErrors: boolean) {
  // Express identifies error middleware by arity, so all four parameters are required.
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const meta = { requestId: req.requestId };

    if (err instanceof AppError) {
      res.status(err.status).json({
        success: false,
        code: err.code,
        message: err.message,
        details: err.details,
        meta,
      });
      return;
    }

    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({
        success: false,
        code: 'INVALID_JSON',
        message: 'Request body is not valid JSON.',
        details: {},
        meta,
      });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({
        success: false,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large.',
        details: {},
        meta,
      });
      return;
    }

    // Unknown failure: log server-side only, never leak internals to the client.
    if (logErrors) {
      logger.error('Unhandled request error', { requestId: req.requestId, ...describeError(err) });
    }
    res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      details: {},
      meta,
    });
  };
}
