import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import multer from 'multer';
import { AppError } from '../platform/errors';
import { logger } from '../platform/logger';
import { env } from '../config/env';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No endpoint matches ${req.method} ${req.path}.`, requestId: req.requestId },
  });
}

/**
 * Central error handler. Every failure crossing the boundary has a stable code, and
 * internal messages are never leaked to clients in production.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error('request failed', { requestId: req.requestId, code: err.code, message: err.message });
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.expose ? err.message : 'Something went wrong on our side.',
        ...(err.details ? { details: err.details } : {}),
        requestId: req.requestId,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Some fields need attention.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId: req.requestId,
      },
    });
    return;
  }

  /**
   * A malformed identifier or field value is a client mistake, not a server fault. Without this,
   * an invalid ObjectId in a URL surfaces as a 500 and looks like an outage.
   */
  if (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'CastError') {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'That record could not be found. The identifier in the request is not valid.',
        requestId: req.requestId,
      },
    });
    return;
  }

  if (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'ValidationError') {
    const details = (err as { errors?: Record<string, { message?: string }> }).errors ?? {};
    res.status(422).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Some values were rejected by the database rules.',
        details: Object.entries(details).map(([path, issue]) => ({ path, message: issue.message ?? 'Invalid value' })),
        requestId: req.requestId,
      },
    });
    return;
  }

  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 422).json({
      error: {
        code: tooBig ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED',
        message: tooBig ? `File is larger than the ${env.maxUploadMb}MB limit.` : `Upload rejected: ${err.message}`,
        requestId: req.requestId,
      },
    });
    return;
  }

  // Mongo duplicate key → a uniqueness rule the user can act on.
  if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'That record already exists (a unique value is duplicated).',
        details: (err as { keyValue?: unknown }).keyValue ?? undefined,
        requestId: req.requestId,
      },
    });
    return;
  }

  logger.error('Unhandled error', { requestId: req.requestId, error: err });
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong on our side. The error has been logged with reference ' + req.requestId + '.',
      requestId: req.requestId,
    },
  });
}
