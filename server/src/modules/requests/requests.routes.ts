import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, paginated, parsePagination } from '../../platform/http';
import { authenticate } from '../../middleware/auth';
import { requireOrg } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { verifyCsrf } from '../../middleware/csrf';
import { forbidden, notFound } from '../../platform/errors';
import { ChangeOrder, ChangeRequest, EffortEstimate, ScopeAnalysis, TimeEntry, User } from '../../models';
import { REQUEST_STATUSES } from '../../domain/stateMachine';
import { CATEGORY_META } from '../../domain/classification';
import {
  availableTransitions,
  createRequest,
  transitionRequest,
} from './requests.service';

export const requestRouter = Router();
const mutating = [authenticate, verifyCsrf] as const;
requestRouter.use(authenticate, requireOrg);

const listQuery = z.object({
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
  projectId: z.string().optional(),
  status: z.string().optional(),
  classification: z.string().optional(),
  priority: z.string().optional(),
  assignedToMe: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(['newest', 'oldest', 'priority', 'value']).optional(),
});

requestRouter.get(
  '/',
  requirePermission('request.view'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = { org: req.org!.orgId };
    if (q.projectId) filter.project = q.projectId;
    if (q.status && REQUEST_STATUSES.includes(q.status as never)) filter.status = q.status;
    else if (q.status === 'open') filter.status = { $in: ['submitted', 'under_review', 'clarification_required', 'classified', 'estimating', 'internal_review'] };
    if (q.classification) filter.classification = q.classification;
    if (q.priority) filter.priority = q.priority;
    if (q.assignedToMe) filter.assignedReviewer = req.auth!.userId;
    if (q.search) filter.$or = [{ title: new RegExp(q.search, 'i') }, { ref: new RegExp(q.search, 'i') }, { description: new RegExp(q.search, 'i') }];
    // "value" sorts by the potential value awaiting a decision — the number an owner cares about.
    const sort = q.sort === 'oldest' ? { createdAt: 1 } : q.sort === 'priority' ? { priority: -1, createdAt: -1 } : q.sort === 'value' ? { 'outcome.additionalValueMinor': -1 } : { createdAt: -1 };

    const [items, total] = await Promise.all([
      ChangeRequest.find(filter).sort(sort as never).skip(pagination.skip).limit(pagination.pageSize).lean(),
      ChangeRequest.countDocuments(filter),
    ]);
    const assignees = await User.find({ _id: { $in: items.map((i) => i.assignedReviewer).filter(Boolean) } }).select('name').lean();
    const nameById = new Map(assignees.map((a) => [String(a._id), a.name]));

    res.json(
      paginated(
        items.map((r) => ({
          id: String(r._id),
          ref: r.ref,
          title: r.title,
          project: String(r.project),
          status: r.status,
          classification: r.classification,
          classificationConfidence: r.classificationConfidence,
          categoryMeta: r.classification ? CATEGORY_META[r.classification as keyof typeof CATEGORY_META] : null,
          priority: r.priority,
          source: r.source,
          requesterName: r.requester?.name ?? '',
          assignedReviewer: r.assignedReviewer ? { id: String(r.assignedReviewer), name: nameById.get(String(r.assignedReviewer)) ?? '' } : null,
          flaggedForReview: r.flaggedForReview,
          effort: r.effort,
          unapprovedHours: r.outcome?.unapprovedHours ?? 0,
          createdAt: r.createdAt,
          revision: r.revision,
        })),
        total,
        pagination,
      ),
    );
  }),
);

/** Request inbox summary — the counts that drive the dashboard tiles. */
requestRouter.get(
  '/summary',
  requirePermission('request.view'),
  asyncHandler(async (req, res) => {
    const orgId = req.org!.orgId;
    const rows = await ChangeRequest.aggregate([
      { $match: { org: (await import('mongoose')).Types.ObjectId.createFromHexString(orgId) } },
      { $group: { _id: '$status', count: { $sum: 1 }, potentialValueMinor: { $sum: '$outcome.additionalValueMinor' }, unapprovedHours: { $sum: '$outcome.unapprovedHours' } } },
    ]);
    const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.count]));
    const awaitingClient = (rows.find((r) => r._id === 'awaiting_client_decision')?.potentialValueMinor ?? 0) + 0;
    const approvedValue = await ChangeOrder.aggregate([
      { $match: { org: (await import('mongoose')).Types.ObjectId.createFromHexString(orgId), status: 'accepted' } },
      { $group: { _id: null, total: { $sum: '$pricing.total.amount' } } },
    ]);
    const unapprovedHours = rows.reduce((sum, r) => sum + (r.unapprovedHours ?? 0), 0);

    res.json({
      byStatus,
      open: ['submitted', 'under_review', 'clarification_required', 'classified', 'estimating', 'internal_review'].reduce((s, k) => s + (byStatus[k] ?? 0), 0),
      awaitingClientDecision: byStatus.awaiting_client_decision ?? 0,
      approved: byStatus.approved ?? 0,
      rejected: byStatus.rejected ?? 0,
      deferred: byStatus.deferred ?? 0,
      // Precise terminology: these are NOT revenue.
      potentialValueMinor: awaitingClient,
      approvedAdditionalValueMinor: approvedValue[0]?.total ?? 0,
      unapprovedHours: Number(unapprovedHours.toFixed(2)),
    });
  }),
);

requestRouter.post(
  '/',
  ...mutating,
  requirePermission('request.create'),
  validate({
    body: z.object({
      projectId: z.string().min(10),
      title: z.string().min(4).max(300),
      description: z.string().min(10).max(12000),
      requesterName: z.string().max(160).optional(),
      requesterEmail: z.union([z.string().email().max(200), z.literal('')]).optional(),
      source: z.enum(['client_portal', 'email', 'meeting', 'chat', 'call', 'internal', 'document']).optional(),
      sourceDetail: z.string().max(600).optional(),
      desiredBy: z.string().datetime().nullable().optional(),
      businessReason: z.string().max(2000).optional(),
      affectedDeliverables: z.array(z.string().max(160)).max(20).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      assignedReviewerId: z.string().optional(),
      submit: z.boolean().optional(),
      evidence: z
        .array(
          z.object({
            kind: z.enum(['email', 'message', 'meeting_note', 'call_note', 'document', 'screenshot', 'other']),
            source: z.string().max(300).optional(),
            occurredAt: z.string().datetime().nullable().optional(),
            quote: z.string().max(8000).optional(),
            documentId: z.string().optional(),
            consentAttested: z.boolean().optional(),
          }),
        )
        .max(20)
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const request = await createRequest({
      orgId: req.org!.orgId,
      projectId: req.body.projectId,
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email, ip: req.ip, userAgent: req.header('user-agent') },
      data: req.body,
    });
    res.status(201).json({ request });
  }),
);

/** Full request workspace: the request, its history, analyses, estimates, proposals, time. */
requestRouter.get(
  '/:requestId',
  requirePermission('request.view'),
  asyncHandler(async (req, res) => {
    const request = await ChangeRequest.findOne({ _id: req.params.requestId, org: req.org!.orgId }).lean();
    if (!request) throw notFound('Request not found.');

    const [analyses, estimates, orders, time, reviewer] = await Promise.all([
      ScopeAnalysis.find({ request: request._id }).sort({ createdAt: -1 }).limit(10).lean(),
      EffortEstimate.find({ request: request._id }).sort({ version: -1 }).lean(),
      ChangeOrder.find({ request: request._id }).sort({ version: -1 }).lean(),
      TimeEntry.find({ request: request._id }).sort({ date: -1 }).limit(100).lean(),
      request.assignedReviewer ? User.findById(request.assignedReviewer).select('name email').lean() : null,
    ]);

    // Private cost data is only returned to members who may see financials.
    const canSeeFinancials = req.org!.permissions.includes('estimate.view_internal');
    const shapedEstimates = canSeeFinancials
      ? estimates
      : estimates.map((e) => ({ ...e, pricing: { ...e.pricing, internalCostMinor: undefined }, internalCostRate: undefined, billingRate: undefined }));

    const transitions = await availableTransitions(req.org!.orgId, String(request._id), req.org!.permissions);

    res.json({ request, analyses, estimates: shapedEstimates, changeOrders: orders, timeEntries: time, reviewer, transitions });
  }),
);

requestRouter.patch(
  '/:requestId',
  ...mutating,
  requirePermission('request.update'),
  validate({
    body: z.object({
      title: z.string().min(4).max(300).optional(),
      description: z.string().min(10).max(12000).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      businessReason: z.string().max(2000).optional(),
      affectedDeliverables: z.array(z.string().max(160)).max(20).optional(),
      internalNotes: z.string().max(8000).optional(),
      desiredBy: z.string().datetime().nullable().optional(),
      assignedReviewerId: z.string().optional(),
      expectedRevision: z.number().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const request = await ChangeRequest.findOne({ _id: req.params.requestId, org: req.org!.orgId });
    if (!request) throw notFound('Request not found.');
    // Internal notes are for team members only.
    if (req.body.internalNotes && !req.org!.permissions.includes('request.review')) {
      throw forbidden('Only reviewers may add internal notes.');
    }
    if (req.body.expectedRevision !== undefined && request.revision !== req.body.expectedRevision) {
      throw (await import('../../platform/errors')).conflict('This request changed while you were editing it. Reload and try again.');
    }
    const { expectedRevision: _ignored, assignedReviewerId, desiredBy, ...patch } = req.body;
    Object.assign(request, patch);
    if (assignedReviewerId) request.assignedReviewer = new (await import('mongoose')).Types.ObjectId(assignedReviewerId);
    if (desiredBy !== undefined) request.desiredBy = desiredBy ? new Date(desiredBy) : null;
    await request.save();
    res.json({ request });
  }),
);

requestRouter.post(
  '/:requestId/transitions',
  ...mutating,
  requirePermission('request.review'),
  validate({
    body: z.object({
      to: z.enum(REQUEST_STATUSES),
      reason: z.string().max(2000).optional(),
      expectedRevision: z.number().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await transitionRequest({
      orgId: req.org!.orgId,
      requestId: String(req.params.requestId ?? ''),
      to: req.body.to,
      reason: req.body.reason,
      expectedRevision: req.body.expectedRevision,
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email, ip: req.ip, userAgent: req.header('user-agent') },
    });
    res.json({ request: result.request, transition: result.transition });
  }),
);

/** Record a client/requester answer to outstanding clarification questions. */
requestRouter.post(
  '/:requestId/clarifications/:clarificationId/answer',
  ...mutating,
  requirePermission('request.update'),
  validate({ body: z.object({ answer: z.string().min(2).max(8000), answeredBy: z.string().max(160).optional() }) }),
  asyncHandler(async (req, res) => {
    const request = await ChangeRequest.findOne({ _id: req.params.requestId, org: req.org!.orgId });
    if (!request) throw notFound('Request not found.');
    const clarification = request.clarifications.id(String(req.params.clarificationId ?? ''));
    if (!clarification) throw notFound('That clarification request no longer exists.');
    clarification.answer = req.body.answer;
    clarification.answeredAt = new Date();
    clarification.answeredBy = req.body.answeredBy ?? req.auth!.user.name;
    await request.save();
    res.json({ request });
  }),
);

requestRouter.post(
  '/:requestId/clarifications',
  ...mutating,
  requirePermission('request.review'),
  validate({ body: z.object({ questions: z.array(z.string().min(5).max(600)).min(1).max(15) }) }),
  asyncHandler(async (req, res) => {
    const request = await ChangeRequest.findOne({ _id: req.params.requestId, org: req.org!.orgId });
    if (!request) throw notFound('Request not found.');
    request.clarifications.push({
      questions: req.body.questions,
      askedAt: new Date(),
      askedBy: req.auth!.userId,
    } as never);
    if (request.status === 'under_review' || request.status === 'classified') request.status = 'clarification_required';
    await request.save();
    res.status(201).json({ request });
  }),
);
