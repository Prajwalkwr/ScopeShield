import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../platform/http';
import { authenticate } from '../../middleware/auth';
import { requireOrg } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { verifyCsrf } from '../../middleware/csrf';
import { rateLimit } from '../../middleware/rateLimit';
import { notFound } from '../../platform/errors';
import { ScopeAnalysis } from '../../models';
import { CATEGORY_META } from '../../domain/classification';
import { correctClassification, runAnalysis } from './analysis.service';

export const analysisRouter = Router();
const mutating = [authenticate, verifyCsrf] as const;
analysisRouter.use(authenticate, requireOrg);

/** Category reference data for the UI (labels, posture, guidance) — single source of truth. */
analysisRouter.get('/categories', requirePermission('request.view'), (_req, res) => {
  res.json({ categories: Object.values(CATEGORY_META) });
});

analysisRouter.post(
  '/requests/:requestId/analyze',
  ...mutating,
  requirePermission('analysis.run'),
  rateLimit({ scope: 'analysis:run', capacity: 20, refillPerSecond: 20 / 3600, keyFn: (req) => `u:${req.auth?.userId}` }),
  validate({ body: z.object({ useAi: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await runAnalysis({
      orgId: req.org!.orgId,
      requestId: String(req.params.requestId ?? ''),
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email, ip: req.ip, userAgent: req.header('user-agent') },
      useAi: req.body.useAi,
    });
    res.status(201).json(result);
  }),
);

analysisRouter.get(
  '/requests/:requestId/analyses',
  requirePermission('request.view'),
  asyncHandler(async (req, res) => {
    const analyses = await ScopeAnalysis.find({ org: req.org!.orgId, request: String(req.params.requestId ?? '') })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ analyses });
  }),
);

/** Human correction of a classification — always carries a written reason. */
analysisRouter.post(
  '/requests/:requestId/classification',
  ...mutating,
  requirePermission('analysis.correct'),
  validate({
    body: z.object({
      category: z.enum(Object.keys(CATEGORY_META) as [string, ...string[]]),
      reason: z.string().min(10).max(2000),
    }),
  }),
  asyncHandler(async (req, res) => {
    const request = await correctClassification({
      orgId: req.org!.orgId,
      requestId: String(req.params.requestId ?? ''),
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email, ip: req.ip, userAgent: req.header('user-agent') },
      category: req.body.category as keyof typeof CATEGORY_META,
      reason: req.body.reason,
    });
    res.json({ request });
  }),
);
