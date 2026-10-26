import type { Request, Response } from 'express';
import { SESSION } from '../../config/constants';
import { env } from '../../config/env';
import {
  generateOpaqueToken,
  hashPassword,
  sha256,
  verifyPassword,
} from '../../platform/crypto';
import { conflict, forbidden, unauthenticated, badRequest } from '../../platform/errors';
import { mail } from '../../platform/mail';
import { logger } from '../../platform/logger';
import { Membership, Organization, Session, User } from '../../models';
import { BRAND } from '../../config/brand';
import { resolvePermissions, type Permission } from '../../domain/permissions';
import type { Role } from '../../config/constants';

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

export interface SessionMeta {
  ip: string;
  userAgent: string;
}

function cookieOptions(maxAgeMs: number, httpOnly = true) {
  return {
    httpOnly,
    secure: env.cookieSecure,
    sameSite: 'lax' as const,
    path: SESSION.cookiePath,
    maxAge: maxAgeMs,
  };
}

/**
 * Issues a new session and sets three cookies:
 *   ss_at  — short-lived access token (HttpOnly)
 *   ss_rt  — refresh token (HttpOnly, rotated on every use)
 *   ss_csrf — CSRF token (readable by the SPA so it can echo it in a header)
 * Only hashes of the first two ever reach the database.
 */
export async function issueSession(
  user: { _id: unknown; email: string; name: string },
  res: Response,
  meta: SessionMeta,
): Promise<{ sessionId: string; csrfToken: string }> {
  const accessToken = generateOpaqueToken(32);
  const refreshToken = generateOpaqueToken(32);
  const csrfToken = generateOpaqueToken(24);

  const session = await Session.create({
    user: user._id,
    accessTokenHash: sha256(accessToken),
    refreshTokenHash: sha256(refreshToken),
    csrfTokenHash: sha256(csrfToken),
    rotationCount: 0,
    previousTokenHashes: [],
    userAgent: meta.userAgent.slice(0, 400),
    ip: meta.ip.slice(0, 60),
    expiresAt: new Date(Date.now() + SESSION.refreshTtlSeconds * 1000),
  });

  res.cookie(SESSION.accessCookieName, accessToken, cookieOptions(SESSION.accessTtlSeconds * 1000));
  res.cookie(SESSION.refreshCookieName, refreshToken, cookieOptions(SESSION.refreshTtlSeconds * 1000));
  res.cookie(SESSION.csrfCookieName, csrfToken, cookieOptions(SESSION.refreshTtlSeconds * 1000, false));

  return { sessionId: String(session._id), csrfToken };
}

export function clearSessionCookies(res: Response): void {
  for (const name of [SESSION.accessCookieName, SESSION.refreshCookieName, SESSION.csrfCookieName]) {
    res.clearCookie(name, { path: SESSION.cookiePath });
  }
}

export async function registerUser(input: {
  email: string;
  name: string;
  password: string;
  timezone?: string;
}): Promise<{ userId: string; email: string; name: string }> {
  const email = input.email.toLowerCase().trim();
  const existing = await User.findOne({ email }).lean();
  if (existing) {
    // Do not confirm whether the address is registered to an unauthenticated caller beyond
    // what the signup flow must say to be usable.
    throw conflict('An account with this email already exists. Try signing in instead.');
  }
  const user = await User.create({
    email,
    name: input.name.trim(),
    passwordHash: hashPassword(input.password),
    timezone: input.timezone ?? 'UTC',
    status: 'active',
  });
  return { userId: String(user._id), email: user.email, name: user.name };
}

export async function loginUser(
  input: { email: string; password: string },
  res: Response,
  meta: SessionMeta,
): Promise<{ userId: string; csrfToken: string; defaultOrgSlug: string | null }> {
  const email = input.email.toLowerCase().trim();
  const user = await User.findOne({ email }).select('+passwordHash');

  // Uniform failure message: never reveal whether the email exists.
  const genericFailure = unauthenticated('Email or password is incorrect.');

  if (!user) {
    // Spend comparable time so the response time does not leak account existence.
    verifyPassword(input.password, hashPassword('placeholder-for-timing'));
    throw genericFailure;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    throw forbidden(`Too many failed attempts. Try again in ${minutes} minute(s).`);
  }
  if (user.status !== 'active') throw forbidden('This account is not active. Contact your organization owner.');

  const { ok, needsRehash } = verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    user.failedLoginCount = (user.failedLoginCount ?? 0) + 1;
    if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
      user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      user.failedLoginCount = 0;
      logger.warn('Account locked after repeated failed logins', { userId: String(user._id) });
    }
    await user.save();
    throw genericFailure;
  }

  if (needsRehash) {
    user.passwordHash = hashPassword(input.password);
  }
  user.failedLoginCount = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date();
  await user.save();

  const { csrfToken } = await issueSession(user, res, meta);
  const membership = await Membership.findOne({ user: user._id, status: 'active' }).sort({ createdAt: 1 }).lean();
  let defaultOrgSlug: string | null = null;
  if (membership) {
    const org = await Organization.findById(membership.org).select('slug').lean();
    defaultOrgSlug = org?.slug ?? null;
  }
  return { userId: String(user._id), csrfToken, defaultOrgSlug };
}

/**
 * Refresh rotation with reuse detection:
 *  - the presented token must match the CURRENT refresh hash → rotate;
 *  - if it matches a PREVIOUS hash, the token was replayed (stolen or double-used) →
 *    the whole session is revoked, forcing re-authentication.
 */
export async function rotateSession(
  refreshToken: string,
  res: Response,
  meta: SessionMeta,
): Promise<{ userId: string }> {
  const hash = sha256(refreshToken);
  const session = await Session.findOne({ refreshTokenHash: hash, revokedAt: null }).select('+previousTokenHashes');
  if (!session) {
    // Could be an expired/revoked session, or a previously rotated token.
    const stale = await Session.findOne({ previousTokenHashes: hash }).select('+previousTokenHashes');
    if (stale && !stale.revokedAt) {
      stale.revokedAt = new Date();
      stale.revokedReason = 'reuse_detected';
      await stale.save();
      logger.warn('Refresh token reuse detected; session revoked', { sessionId: String(stale._id) });
    }
    throw unauthenticated('Your session has expired. Please sign in again.');
  }
  if (session.expiresAt < new Date()) {
    throw unauthenticated('Your session has expired. Please sign in again.');
  }

  const newAccess = generateOpaqueToken(32);
  const newRefresh = generateOpaqueToken(32);
  const previous = [session.refreshTokenHash, ...(session.previousTokenHashes ?? [])].slice(0, 5);

  session.accessTokenHash = sha256(newAccess);
  session.refreshTokenHash = sha256(newRefresh);
  session.previousTokenHashes = previous;
  session.rotationCount = (session.rotationCount ?? 0) + 1;
  session.lastUsedAt = new Date();
  session.userAgent = meta.userAgent.slice(0, 400);
  session.ip = meta.ip.slice(0, 60);
  await session.save();

  res.cookie(SESSION.accessCookieName, newAccess, cookieOptions(SESSION.accessTtlSeconds * 1000));
  res.cookie(SESSION.refreshCookieName, newRefresh, cookieOptions(SESSION.refreshTtlSeconds * 1000));
  return { userId: String(session.user) };
}

export async function logoutSession(sessionId: string | undefined, res: Response): Promise<void> {
  if (sessionId) {
    await Session.updateOne(
      { _id: sessionId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
    );
  }
  clearSessionCookies(res);
}

/** Revokes every active session for a user — used after a password change. */
export async function revokeAllSessions(userId: string, reason: 'password_change' | 'admin'): Promise<number> {
  const result = await Session.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return result.modifiedCount ?? 0;
}

export async function requestPasswordReset(email: string, baseUrl: string): Promise<void> {
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  // Always behave identically, regardless of whether the account exists.
  if (!user) return;

  const token = generateOpaqueToken(32);
  user.passwordResetTokenHash = sha256(token);
  user.passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  user.passwordResetRequestedAt = new Date();
  await user.save();

  const link = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await mail.send({
    to: user.email,
    subject: `${BRAND.name}: reset your password`,
    text: [
      `Hello ${user.name},`,
      '',
      'A password reset was requested for your account.',
      'If this was you, open the link below within the next hour:',
      link,
      '',
      'If you did not request this, you can safely ignore this email — your password has not changed.',
    ].join('\n'),
  });
}

export async function resetPassword(token: string, newPassword: string): Promise<{ userId: string }> {
  const hash = sha256(token);
  const user = await User.findOne({
    passwordResetTokenHash: hash,
    passwordResetExpiresAt: { $gt: new Date() },
  }).select('+passwordResetTokenHash +passwordResetExpiresAt');

  if (!user) throw badRequest('This reset link is invalid or has expired. Request a new one.');

  user.passwordHash = hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  // Single use.
  user.passwordResetTokenHash = '';
  user.passwordResetExpiresAt = null;
  user.failedLoginCount = 0;
  user.lockedUntil = null;
  await user.save();

  const revoked = await revokeAllSessions(String(user._id), 'password_change');
  logger.info('Password reset completed', { userId: String(user._id), revokedSessions: revoked });
  return { userId: String(user._id) };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw unauthenticated();
  const { ok } = verifyPassword(currentPassword, user.passwordHash);
  if (!ok) throw badRequest('Your current password is not correct.');
  user.passwordHash = hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await user.save();
  await revokeAllSessions(String(user._id), 'password_change');
}

/** Shapes the /me payload: user, memberships, and resolved permissions per organization. */
export async function buildMePayload(userId: string) {
  const user = await User.findById(userId).lean();
  if (!user) throw unauthenticated();
  const memberships = await Membership.find({ user: userId, status: 'active' }).lean();
  const orgs = await Organization.find({ _id: { $in: memberships.map((m) => m.org) }, deletedAt: null }).lean();
  const orgById = new Map(orgs.map((o) => [String(o._id), o]));

  return {
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      timezone: user.timezone,
      jobTitle: user.jobTitle,
      avatarColor: user.avatarColor,
      emailVerified: Boolean(user.emailVerifiedAt),
      isDemo: Boolean(user.isDemo),
      createdAt: user.createdAt,
    },
    memberships: memberships
      .filter((m) => orgById.has(String(m.org)))
      .map((m) => {
        const org = orgById.get(String(m.org))!;
        return {
          membershipId: String(m._id),
          role: m.role as Role,
          joinedAt: m.joinedAt,
          permissions: resolvePermissions(m.role as Role, (m.grants ?? []) as Permission[], (m.revokes ?? []) as Permission[]),
          organization: {
            id: String(org._id),
            name: org.name,
            slug: org.slug,
            currency: org.currency,
            plan: org.plan,
            aiEnabled: Boolean(org.ai?.enabled),
            isDemo: Boolean(org.isDemo),
          },
        };
      }),
  };
}

export function sessionMetaFrom(req: Request): SessionMeta {
  return { ip: req.ip ?? '', userAgent: req.header('user-agent') ?? '' };
}
