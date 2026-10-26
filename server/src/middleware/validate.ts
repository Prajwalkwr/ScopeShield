import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

/**
 * Request validation. Every input is validated server-side even though the frontend
 * validates too. Validated values are written back onto req (parsed & coerced), so
 * handlers work with typed, sanitised data.
 */
type Schemas = { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny };

function format(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join('.') || 'body', message: i.message }));
}

export function validate(schemas: Schemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as Request['params'];
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query);
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(422).json({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Some fields need attention.',
            details: format(err),
            requestId: req.requestId,
          },
        });
        return;
      }
      next(err);
    }
  };
}

export type Infer<T extends ZodTypeAny> = z.infer<T>;
