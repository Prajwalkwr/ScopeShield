import { Router } from 'express';
import { z } from 'zod';
import { SESSION } from '../../config/constants';
import { env } from '../../config/env';
import { sha256 } from '../../platform/crypto';
import { asyncHandler } from '../../platform/http';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { rateLimit } from '../../middleware/rateLimit';
import { badRequest, unauthenticated } from '../../platform/errors';
import { Session } from '../../models';
import {
  buildMePayload,
  changePassword,
  clearSessionCookies,
  loginUser,
  logoutSession,
  registerUser,
  requestPasswordReset,
  resetPassword,
  rotateSession,
  sessionMetaFrom,
} from './auth.service';
import { recordAudit } from '../../platform/audit';
import { AUDIT_ACTIONS } from '../../config/constants';

export const authRouter = Router();

/** Password policy: length first, then variety. Stated once, enforced everywhere. */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(200, 'That password is too long.')
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v), 'Include both upper and lower case letters.')
  .refine((v) => /[0-9]/.test(v), 'Include at least one number.');

const loginLimiter = rateLimit({
  scope: 'auth:login',
  capacity: 10,
  refillPerSecond: 10 / 300, // 10 attempts per 5 minutes per identity
  keyFn: (req) => `ip:${req.ip ?? 'unknown'}:${String(req.body?.email ?? '').toLowerCase()}`,
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
});

authRouter.post(
  '/register',
  rateLimit({ scope: 'auth:register', capacity: 5, refillPerSecond: 5 / 900, message: 'Too many sign-ups from this address. Try again later.' }),
  validate({
    body: z.object({
      name: z.string().min(2).max(120),
      email: z.string().email('Enter a valid email address.').max(200),
      password: passwordSchema,
      timezone: z.string().max(60).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const created = await registerUser(req.body);
    res.status(201).json({ user: created, next: 'Create or join an organization to continue.' });
  }),
);

authRouter.post(
  '/login',
  loginLimiter,
  validate({ body: z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }) }),
  asyncHandler(async (req, res) => {
    const result = await loginUser(req.body, res, sessionMetaFrom(req));
    res.json({
      ok: true,
      csrfToken: result.csrfToken,
      defaultOrgSlug: result.defaultOrgSlug,
    });
  }),
);

authRouter.post(
  '/refresh',
  rateLimit({ scope: 'auth:refresh', capacity: 30, refillPerSecond: 0.5 }),
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[SESSION.refreshCookieName] as string | undefined;
    if (!token) {
      clearSessionCookies(res);
      throw unauthenticated('Your session has expired. Please sign in again.');
    }
    const { userId } = await rotateSession(token, res, sessionMetaFrom(req));
    const payload = await buildMePayload(userId);
    res.json({ ok: true, ...payload });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await logoutSession(req.auth?.sessionId, res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const payload = await buildMePayload(req.auth!.userId);
    res.json(payload);
  }),
);

authRouter.post(
  '/password/forgot',
  rateLimit({ scope: 'auth:forgot', capacity: 3, refillPerSecond: 3 / 900, keyFn: (req) => `ip:${req.ip}` }),
  validate({ body: z.object({ email: z.string().email().max(200) }) }),
  asyncHandler(async (req, res) => {
    await requestPasswordReset(req.body.email, env.webPublicUrl);
    // Same response whether or not the address exists.
    res.json({ ok: true, message: 'If that email is registered, a reset link is on its way.' });
  }),
);

authRouter.post(
  '/password/reset',
  rateLimit({ scope: 'auth:reset', capacity: 10, refillPerSecond: 10 / 900 }),
  validate({ body: z.object({ token: z.string().min(20).max(200), password: passwordSchema }) }),
  asyncHandler(async (req, res) => {
    const { userId } = await resetPassword(req.body.token, req.body.password);
    await recordAudit({
      org: 'platform',
      action: 'user.password_reset',
      actor: { kind: 'user', userId, name: 'user' },
      entity: { type: 'User', id: userId },
      meta: { note: 'Password reset via emailed token; all sessions revoked.' },
      ip: req.ip,
      userAgent: req.header('user-agent'),
    });
    res.json({ ok: true, message: 'Your password has been changed. Please sign in.' });
  }),
);

authRouter.post(
  '/password/change',
  authenticate,
  validate({
    body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema }),
  }),
  asyncHandler(async (req, res) => {
    await changePassword(req.auth!.userId, req.body.currentPassword, req.body.newPassword);
    clearSessionCookies(res);
    res.json({ ok: true, message: 'Password changed. Please sign in again on all devices.' });
  }),
);

/**
 * CSRF token inspection for the SPA: the cookie is readable, but the server-side hash is
 * the authority. A session without a CSRF hash cannot perform mutations.
 */
authRouter.get(
  '/csrf',
  authenticate,
  asyncHandler(async (req, res) => {
    const cookieToken = req.cookies?.[SESSION.csrfCookieName] as string | undefined;
    if (!cookieToken) throw badRequest('No CSRF token is associated with this session. Sign in again.');
    const session = await Session.findById(req.auth!.sessionId).select('+csrfTokenHash').lean();
    const matches = Boolean(session?.csrfTokenHash) && session!.csrfTokenHash === sha256(cookieToken);
    res.json({ valid: matches });
  }),
);
