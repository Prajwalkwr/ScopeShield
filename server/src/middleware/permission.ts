import type { NextFunction, Request, Response } from 'express';
import { forbidden } from '../platform/errors';
import type { Permission } from '../domain/permissions';

/**
 * Capability gate. Permissions are resolved server-side from the membership on every
 * request (see middleware/auth.ts) and never read from the client.
 */
export function requirePermission(...required: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.org) return next(forbidden());
    const missing = required.filter((p) => !req.org!.permissions.includes(p));
    if (missing.length > 0) {
      return next(
        forbidden(`This action requires the "${missing.join('", "')}" permission, which your role does not have.`),
      );
    }
    next();
  };
}

/** True when the current member holds a permission (for handler branching). */
export function can(req: Request, permission: Permission): boolean {
  return Boolean(req.org?.permissions.includes(permission));
}
