import type { NextFunction, Request, Response } from 'express';
import { forbidden, notFound } from '../platform/errors';

/**
 * Tenant resolution and isolation.
 *
 * The organization is resolved, in order of precedence, from:
 *   1. the URL (`/organizations/:orgId/...`) — the most explicit form;
 *   2. the `X-Org-Id` header — how the single-page app states which organization is active;
 *   3. `orgId` in the body or query string of a request.
 *
 * Whichever source is used, it must match one of the caller's ACTIVE memberships: a client
 * cannot widen its own access by claiming an organization, because membership is looked up
 * server-side from the session. Everything downstream is scoped by `req.org.orgId`, so a
 * handler physically cannot query across tenants without deliberately ignoring the scope.
 *
 * A record that exists but belongs to another organization returns 404, not 403: the
 * difference between "wrong tenant" and "does not exist" is itself information.
 */
export async function requireOrg(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) return next(forbidden());

    const headerOrg = req.header('x-org-id') ?? req.header('x-organization-id');
    const identifier =
      req.params.orgId ?? req.params.orgSlug ?? headerOrg ?? req.body?.orgId ?? req.query?.orgId;
    if (typeof identifier !== 'string' || !identifier) {
      return next(notFound('No organization was specified in the request.'));
    }

    const membership = req.auth.memberships.find(
      (m) => m.orgId === identifier || m.orgSlug === identifier.toLowerCase(),
    );
    if (!membership) {
      // Same response for "not a member" and "no such organization".
      return next(notFound('Organization not found, or you are not a member of it.'));
    }

    req.org = {
      orgId: membership.orgId,
      membershipId: membership.membershipId,
      role: membership.role,
      permissions: membership.permissions,
      projectScope: membership.projectScope,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Restricts access to specific roles (used sparingly; permissions are the main tool). */
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.org) return next(forbidden());
    if (!roles.includes(req.org.role)) {
      return next(forbidden(`This action requires one of these roles: ${roles.join(', ')}.`));
    }
    next();
  };
}

/**
 * Project-level access assertion. Called by services/controllers before touching a
 * project-scoped record. Enforces optional per-member project scope.
 */
export function assertProjectInScope(req: Request, projectId: string): void {
  if (!req.org) throw forbidden();
  const scope = req.org.projectScope;
  if (scope.length > 0 && !scope.includes(String(projectId))) {
    throw notFound('Project not found.');
  }
}
