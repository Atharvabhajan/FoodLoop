import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { validationError } from './errors.js';

export function ok(req: Request, res: Response, data: unknown, status = 200) {
  res.status(status).json({ success: true, data, meta: { requestId: req.requestId } });
}

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw validationError(result.error);
  return result.data;
}
