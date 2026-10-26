import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../platform/logger';

/** Assigns a request id, echoes it back, and logs a completion line with duration. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w-]{6,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('request', {
      requestId: req.requestId,
      method: req.method,
      // Path only — never log query strings wholesale (they can carry tokens).
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms),
      userId: req.auth?.userId ?? null,
      orgId: req.org?.orgId ?? null,
    });
  });

  next();
}
