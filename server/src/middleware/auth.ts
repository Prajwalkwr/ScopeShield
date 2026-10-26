import type { NextFunction, Request, Response } from 'express';
import { SESSION, type Role } from '../config/constants';
import { sha256 } from '../platform/crypto';
import { unauthenticated, forbidden } from '../platform/errors';
import { Membership, Organization, Session, User } from '../models';
import { resolvePermissions, type Permission } from '../domain/permissions';

/**
 * Authentication: HttpOnly cookie carrying a short-lived opaque access token.
 * Tokens are stored HASHED (sha256) so a database read does not yield a usable session.
 * No bearer token ever lives in browser storage.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = req.cookies?.[SESSION.accessCookieName] as string | undefined;
    if (!raw) return next(unauthenticated());

    const session = await Session.findOne({
      accessTokenHash: sha256(raw),
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .select('+csrfTokenHash')
      .lean();
    if (!session) return next(unauthenticated('Your session has ended. Please sign in again.'));

    // Expose only the CSRF HASH to later middleware; the raw token lives in a readable cookie.
    (req as Request & { csrfTokenHash?: string }).csrfTokenHash = session.csrfTokenHash ?? '';

    const user = await User.findById(session.user).lean();
    if (!user) return next(unauthenticated('This account no longer exists.'));
    if (user.status !== 'active') return next(forbidden('This account is suspended.'));

    const memberships = await Membership.find({ user: user._id, status: 'active' }).lean();
    const orgIds = memberships.map((m) => m.org);
    const orgs = await Organization.find({ _id: { $in: orgIds }, deletedAt: null })
      .select('name slug')
      .lean();
    const orgById = new Map(orgs.map((o) => [String(o._id), o]));

    req.auth = {
      userId: String(user._id),
      sessionId: String(session._id),
      user: {
        id: String(user._id),
        email: user.email,
        name: user.name,
        timezone: user.timezone ?? 'UTC',
        isDemo: Boolean(user.isDemo),
      },
      memberships: memberships
        .filter((m) => orgById.has(String(m.org)))
        .map((m) => {
          const org = orgById.get(String(m.org));
          return {
            membershipId: String(m._id),
            orgId: String(m.org),
            orgName: org?.name ?? '',
            orgSlug: org?.slug ?? '',
            role: m.role as Role,
            permissions: resolvePermissions(
              m.role as Role,
              (m.grants ?? []) as Permission[],
              (m.revokes ?? []) as Permission[],
            ),
            projectScope: (m.projectScope ?? []).map(String),
          };
        }),
    };

    next();
  } catch (err) {
    next(err);
  }
}

/** Optional authentication for routes that behave differently for signed-in users. */
export async function authenticateOptional(req: Request, res: Response, next: NextFunction): Promise<void> {
  const raw = req.cookies?.[SESSION.accessCookieName] as string | undefined;
  if (!raw) return next();
  return authenticate(req, res, next);
}
