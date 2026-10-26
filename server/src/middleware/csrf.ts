import type { NextFunction, Request, Response } from 'express';
import { SESSION } from '../config/constants';
import { env } from '../config/env';
import { sha256, safeEqual, generateOpaqueToken } from '../platform/crypto';
import { AppError } from '../platform/errors';

/**
 * CSRF defence for cookie-based sessions: double-submit token + Origin check.
 *
 *  1. A random token is issued at login and set in a NON-HttpOnly cookie so the SPA can
 *     read it, while its hash is stored server-side against the session.
 *  2. Mutating requests must echo it in the x-csrf-token header; the header is compared
 *     with the stored hash, not merely with the cookie, so a cookie injected by a
 *     subdomain cannot be paired with a header the attacker cannot read.
 *  3. For state-changing methods the Origin (when present) must be an allowed origin.
 *
 * Combined with SameSite=Lax this closes the classic cross-site POST vector.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function issueCsrfToken(res: Response): string {
  const token = generateOpaqueToken(24);
  res.cookie(SESSION.csrfCookieName, token, {
    httpOnly: false, // must be readable by the SPA to echo it back
    secure: env.cookieSecure,
    sameSite: 'lax',
    path: SESSION.cookiePath,
    maxAge: SESSION.refreshTtlSeconds * 1000,
  });
  return token;
}

export function verifyCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.header('origin');
  if (origin) {
    const allowed = env.corsOrigins.length > 0 ? env.corsOrigins : [env.webPublicUrl];
    // Same-origin requests from the SPA are covered by the configured list.
    const normalised = origin.replace(/\/$/, '');
    if (!allowed.some((a) => a.replace(/\/$/, '') === normalised)) {
      return next(new AppError('PERMISSION_DENIED', 'This request came from an unrecognised origin.'));
    }
  }

  const headerToken = req.header(SESSION.csrfHeaderName);
  const storedHash = (req as Request & { csrfTokenHash?: string }).csrfTokenHash;
  if (!headerToken || !storedHash) {
    return next(
      new AppError('PERMISSION_DENIED', 'This action requires a valid CSRF token. Reload the page and try again.'),
    );
  }
  if (!safeEqual(sha256(headerToken), storedHash)) {
    return next(new AppError('PERMISSION_DENIED', 'Your session token is out of date. Reload the page and try again.'));
  }
  next();
}
