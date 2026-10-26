import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../platform/http';
import { authenticate } from '../../middleware/auth';
import { requireOrg } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { verifyCsrf } from '../../middleware/csrf';
import { EFFORT_CATEGORIES } from '../../domain/lexicon';
import { createEstimate, estimateView, finaliseEstimate, listEstimates, logTime, overrideSchedule, suggestHours } from './estimates.service';
import { EffortEstimate } from '../../models';
import { notFound } from '../../platform/errors';

export const estimatesRouter = Router();
const mutating = [authenticate, verifyCsrf] as const;
estimatesRouter.use(authenticate, requireOrg);

const hoursSchema = z.record(z.number().min(0).max(10000)).optional();

function actorOf(req: Parameters<Parameters<typeof asyncHandler>[0]>[0]) {
  return {
    userId: req.auth!.userId,
    name: req.auth!.user.name,
    email: req.auth!.user.email,
    ip: req.ip,
    userAgent: req.header('user-agent'),
  };
}

/** Advisory first-pass hours from the analysis engine. Never a price, never final. */
estimatesRouter.get(
  '/requests/:requestId/estimate-suggestion',
  requirePermission('estimate.create'),
  asyncHandler(async (req, res) => {
    const suggestion = await suggestHours(req.org!.orgId, String(req.params.requestId ?? ''));
    res.json(suggestion);
  }),
);

estimatesRouter.get(
  '/requests/:requestId/estimates',
  requirePermission('request.view'),
  asyncHandler(async (req, res) => {
    const includeInternal = req.org!.permissions.includes('estimate.view_internal');
    const list = await listEstimates(req.org!.orgId, String(req.params.requestId ?? ''), includeInternal);
    res.json({ estimates: list, canSeeInternal: includeInternal, categories: EFFORT_CATEGORIES });
  }),
);

estimatesRouter.post(
  '/requests/:requestId/estimates',
  ...mutating,
  requirePermission('estimate.create'),
  validate({
    body: z.object({
      hours: z.record(z.number().min(0).max(10000)).refine((h) => Object.values(h).some((v) => v > 0), 'Enter hours for at least one category.'),
      currency: z.string().length(3).optional(),
      billingRate: z.number().min(0).max(100000).optional(),
      internalCostRate: z.number().min(0).max(100000).optional(),
      billingModel: z.enum(['fixed_price', 'hourly', 'daily', 'retainer']).optional(),
      fixedPrice: z.number().min(0).nullable().optional(),
      contingencyPct: z.number().min(0).max(100).optional(),
      discountPct: z.number().min(0).max(100).optional(),
      taxPct: z.number().min(0).max(100).optional(),
      note: z.string().max(2000).optional(),
      basis: z.enum(['manual', 'suggested_from_hints', 'copied_from_previous', 'template']).optional(),
      capacity: z
        .object({
          hoursPerPersonDay: z.number().min(1).max(16).optional(),
          people: z.number().min(1).max(20).optional(),
          availability: z.number().min(0.1).max(1).optional(),
          floatDays: z.number().min(0).nullable().optional(),
        })
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await createEstimate({
      orgId: req.org!.orgId,
      requestId: String(req.params.requestId ?? ''),
      actor: actorOf(req),
      ...req.body,
    });
    const includeInternal = req.org!.permissions.includes('estimate.view_internal');
    res.status(201).json({
      estimate: estimateView(result.estimate, { includeInternal }),
      priced: result.priced,
      scheduleImpact: result.scheduleImpact,
      margin: includeInternal ? result.margin : null,
      transactional: result.transactional,
    });
  }),
);

estimatesRouter.get(
  '/estimates/:estimateId',
  requirePermission('request.view'),
  asyncHandler(async (req, res) => {
    const estimate = await EffortEstimate.findOne({ _id: String(req.params.estimateId ?? ''), org: req.org!.orgId });
    if (!estimate) throw notFound('Estimate not found.');
    const includeInternal = req.org!.permissions.includes('estimate.view_internal');
    res.json({ estimate: estimateView(estimate, { includeInternal }) });
  }),
);

estimatesRouter.patch(
  '/estimates/:estimateId/schedule',
  ...mutating,
  requirePermission('estimate.create'),
  validate({
    body: z.object({
      workdays: z.number().min(0).max(500),
      projectedEndDate: z.string().datetime().nullable().optional(),
      reason: z.string().min(10).max(1000),
    }),
  }),
  asyncHandler(async (req, res) => {
    const estimate = await overrideSchedule({
      orgId: req.org!.orgId,
      estimateId: String(req.params.estimateId ?? ''),
      actor: actorOf(req),
      ...req.body,
    });
    res.json({ estimate: estimateView(estimate, { includeInternal: true }) });
  }),
);

estimatesRouter.post(
  '/estimates/:estimateId/finalise',
  ...mutating,
  requirePermission('estimate.finalise'),
  validate({ body: z.object({ note: z.string().max(2000).optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await finaliseEstimate({
      orgId: req.org!.orgId,
      estimateId: String(req.params.estimateId ?? ''),
      actor: actorOf(req),
      note: req.body.note,
    });
    res.json({ estimate: estimateView(result.estimate, { includeInternal: true }), alreadyFinal: result.alreadyFinal });
  }),
);

/** Time entries. Logging against an unapproved request is allowed but recorded as such. */
estimatesRouter.post(
  '/time-entries',
  ...mutating,
  requirePermission('time_entry.create_own'),
  validate({
    body: z.object({
      projectId: z.string().min(1),
      requestId: z.string().min(1).nullable().optional(),
      date: z.string().datetime().optional(),
      hours: z.number().min(0.1).max(24),
      category: z.enum(EFFORT_CATEGORIES as unknown as [string, ...string[]]).optional(),
      billable: z.boolean().optional(),
      note: z.string().max(1000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await logTime({ orgId: req.org!.orgId, actor: actorOf(req), ...req.body });
    res.status(201).json({
      entry: result.entry,
      approvedAtEntry: result.approvedAtEntry,
      loggedWithoutApproval: result.loggedWithoutApproval,
      notice: result.loggedWithoutApproval
        ? 'These hours were recorded against a request with no client approval. They are logged as unapproved work and are not treated as billable revenue.'
        : '',
    });
  }),
);

export { hoursSchema };
