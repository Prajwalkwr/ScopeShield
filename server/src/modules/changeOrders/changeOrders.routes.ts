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
import { ApprovalToken, ApprovalDecision, ChangeOrder, ChangeRequest } from '../../models';
import { storage } from '../../platform/storage';
import { generateChangeOrder, optionLabel, renderAndStorePdf, sendChangeOrder } from './changeOrders.service';
import { applyAcceptedChange } from '../approvals/approvals.service';

export const changeOrdersRouter = Router();
const mutating = [authenticate, verifyCsrf] as const;
changeOrdersRouter.use(authenticate, requireOrg);

function actorOf(req: Parameters<Parameters<typeof asyncHandler>[0]>[0]) {
  return {
    userId: req.auth!.userId,
    name: req.auth!.user.name,
    email: req.auth!.user.email,
    ip: req.ip,
    userAgent: req.header('user-agent'),
  };
}

changeOrdersRouter.get(
  '/requests/:requestId/change-orders',
  requirePermission('request.view'),
  asyncHandler(async (req, res) => {
    const orders = await ChangeOrder.find({ org: req.org!.orgId, request: String(req.params.requestId ?? '') })
      .sort({ version: -1 })
      .lean();
    res.json({
      orders: orders.map((o) => ({
        id: String(o._id),
        number: o.number,
        version: o.version,
        status: o.status,
        option: o.option,
        optionLabel: optionLabel(o.option),
        title: o.title,
        summary: o.summary,
        total: o.pricing?.total ?? null,
        currency: o.pricing?.currency ?? 'USD',
        additionalWorkdays: o.schedule?.additionalWorkdays ?? 0,
        sentAt: o.sentAt,
        decidedAt: o.decision?.decidedAt ?? null,
        deciderName: o.decision?.deciderName ?? '',
        hasPdf: Boolean(o.pdfDocument),
      })),
    });
  }),
);

changeOrdersRouter.post(
  '/requests/:requestId/change-orders',
  ...mutating,
  requirePermission('change_order.generate'),
  validate({
    body: z.object({
      option: z.enum(['add_with_fee', 'add_with_time', 'substitute', 'defer', 'goodwill', 'reject', 'clarify']),
      title: z.string().min(3).max(300).optional(),
      summary: z.string().min(20).max(6000),
      scopeAdditions: z
        .array(
          z.object({
            title: z.string().min(3).max(300),
            description: z.string().max(3000).optional(),
            acceptanceCriteria: z.array(z.string().max(500)).max(20).optional(),
            estimatedHours: z.number().min(0).max(10000).optional(),
          }),
        )
        .max(50)
        .optional(),
      scopeRemovals: z
        .array(z.object({ requirementKey: z.string().max(40).optional(), title: z.string().max(300).optional(), note: z.string().max(1000).optional() }))
        .max(50)
        .optional(),
      relatedRequirementKeys: z.array(z.string().max(40)).max(50).optional(),
      estimateId: z.string().min(1).optional(),
      validUntil: z.string().datetime().nullable().optional(),
      termsText: z.string().max(12000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await generateChangeOrder({
      orgId: req.org!.orgId,
      requestId: String(req.params.requestId ?? ''),
      actor: actorOf(req),
      ...req.body,
    });
    res.status(201).json({
      order: {
        id: String(result.order._id),
        number: result.order.number,
        version: result.order.version,
        status: result.order.status,
        option: result.order.option,
        optionLabel: optionLabel(result.order.option),
        total: result.order.pricing?.total ?? null,
        currency: result.order.pricing?.currency ?? 'USD',
      },
    });
  }),
);

changeOrdersRouter.get(
  '/change-orders/:orderId',
  requirePermission('request.view'),
  asyncHandler(async (req, res) => {
    const order = await ChangeOrder.findOne({ _id: String(req.params.orderId ?? ''), org: req.org!.orgId }).lean();
    if (!order) throw notFound('Change order not found.');
    const tokens = req.org!.permissions.includes('change_order.send')
      ? await ApprovalToken.find({ changeOrder: order._id, org: req.org!.orgId }).select('recipientEmail expiresAt revokedAt accessCount decisionRecordedAt').lean()
      : [];
    const decisions = await ApprovalDecision.find({ changeOrder: order._id }).sort({ createdAt: -1 }).lean();
    res.json({ order, links: tokens, decisions });
  }),
);

/** Re-renders the PDF (useful after a template change) without altering the decision binding of a sent document. */
changeOrdersRouter.post(
  '/change-orders/:orderId/render',
  ...mutating,
  requirePermission('change_order.generate'),
  asyncHandler(async (req, res) => {
    const order = await ChangeOrder.findOne({ _id: String(req.params.orderId ?? ''), org: req.org!.orgId });
    if (!order) throw notFound('Change order not found.');
    if (order.status === 'sent' || order.status === 'accepted') {
      // Re-rendering after sending would change the hash a client is deciding against.
      res.status(409).json({
        code: 'CONFLICT',
        message:
          'This document has already been sent. Re-rendering would change the document a client is deciding on — create a new version instead.',
      });
      return;
    }
    const result = await renderAndStorePdf(String(order._id), actorOf(req));
    res.json({ documentId: String(result.document._id), documentHash: result.documentHash, sizeBytes: result.document.sizeBytes });
  }),
);

changeOrdersRouter.post(
  '/change-orders/:orderId/send',
  ...mutating,
  requirePermission('change_order.send'),
  rateLimit({ scope: 'changeorder:send', capacity: 30, refillPerSecond: 30 / 3600, keyFn: (req) => `u:${req.auth?.userId}` }),
  validate({
    body: z.object({
      recipientEmail: z.string().email().optional(),
      recipientName: z.string().max(160).optional(),
      ttlDays: z.number().int().min(1).max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await sendChangeOrder({
      orgId: req.org!.orgId,
      orderId: String(req.params.orderId ?? ''),
      actor: actorOf(req),
      ...req.body,
    });
    res.status(201).json({
      order: { id: String(result.order._id), number: result.order.number, version: result.order.version, status: result.order.status },
      expiresAt: result.expiresAt,
      approvalUrl: result.approvalUrl,
      // Returned once for manual delivery. Email sending is provider-abstracted; when no mail
      // driver is configured the agency copies this link. It is never stored in plaintext.
      delivery: 'manual-link',
      deliveryNote:
        'Copy this link to the client. It is shown only once — only a hash is stored, so it cannot be retrieved later. Opening it is not acceptance.',
    });
  }),
);

/** Downloads the stored PDF through an authorised, org-scoped route (never a public URL). */
changeOrdersRouter.get(
  '/change-orders/:orderId/pdf',
  requirePermission('document.view'),
  asyncHandler(async (req, res) => {
    const order = await ChangeOrder.findOne({ _id: String(req.params.orderId ?? ''), org: req.org!.orgId });
    if (!order || !order.pdfDocument) throw notFound('No rendered document exists for this change order.');
    const { Document } = await import('../../models');
    const doc = await Document.findById(order.pdfDocument);
    if (!doc) throw notFound('The stored document could not be found.');
    const buffer = await storage.get(doc.storageKey);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.originalName}"`);
    res.setHeader('X-Document-Sha256', doc.sha256);
    res.send(buffer);
  }),
);

/** Applies an accepted change order to a new DRAFT baseline. Human-triggered on purpose. */
changeOrdersRouter.post(
  '/change-orders/:orderId/apply-to-baseline',
  ...mutating,
  requirePermission('baseline.edit_draft'),
  validate({ body: z.object({ note: z.string().max(1000).optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await applyAcceptedChange({
      orgId: req.org!.orgId,
      changeOrderId: String(req.params.orderId ?? ''),
      actor: actorOf(req),
      note: req.body.note,
    });
    const { ChangeOrder: CO } = await import('../../models');
    const request = await ChangeRequest.findOne({ _id: result.order.request, org: req.org!.orgId }).lean();
    void CO;
    res.status(201).json({
      draft: { id: String(result.draft._id), version: result.draft.version, status: result.draft.status },
      addedKeys: result.addedKeys,
      removed: result.removed,
      request: request ? { id: String(request._id), ref: request.ref, status: request.status } : null,
    });
  }),
);
