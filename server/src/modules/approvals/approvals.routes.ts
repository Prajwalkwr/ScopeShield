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
import { ApprovalDecision, ApprovalToken, ChangeOrder, Client, Project } from '../../models';
import { logger } from '../../platform/logger';
import { lookupToken, publicViewForToken, recordDecision, revokeToken } from './approvals.service';

/**
 * Two surfaces, deliberately separated:
 *   publicApprovalsRouter  — token-authenticated, unauthenticated by session, tightly rate limited,
 *                            returns only what a client should see. No org context is inferred.
 *   approvalsRouter        — internal, org-scoped, permission-gated, for links and decision history.
 */
export const publicApprovalsRouter = Router();
export const approvalsRouter = Router();

const clientActor = (req: Parameters<Parameters<typeof asyncHandler>[0]>[0]) => ({
  ip: req.ip,
  userAgent: req.header('user-agent') ?? '',
});

/**
 * Prefetch the document a link refers to. This records an ACCESS, never a decision.
 * Every state that is not actionable returns 200 with a status the page can render honestly
 * (expired / revoked / superseded / already decided), so the client sees a clear explanation
 * instead of a bare error.
 */
publicApprovalsRouter.get(
  '/approvals/:token',
  rateLimit({ scope: 'approval:view', capacity: 60, refillPerSecond: 60 / 600, keyFn: (req) => `ip:${req.ip}` }),
  asyncHandler(async (req, res) => {
    const raw = String(req.params.token ?? '');
    const state = await lookupToken(raw, clientActor(req));
    if (state.kind === 'invalid') throw notFound('This approval link is not valid.');

    if (state.kind === 'valid') {
      const view = await publicViewForToken(state.token, state.order);
      res.json({ state: 'valid', ...view });
      return;
    }
    if (state.kind === 'expired') {
      res.json({ state: 'expired', expiresAt: state.token.expiresAt, message: 'This link has expired. Ask the agency to issue a new one.' });
      return;
    }
    if (state.kind === 'revoked') {
      res.json({ state: 'revoked', message: state.reason, revokedAt: state.token.revokedAt });
      return;
    }
    if (state.kind === 'superseded') {
      res.json({
        state: 'superseded',
        message:
          'This proposal has been replaced by a newer version. The agency will send you the updated document — please review that one instead.',
        supersededVersion: state.token.boundVersion,
      });
      return;
    }
    // already_decided
    const order = state.order;
    res.json({
      state: 'decided',
      decision: order?.decision?.outcome ?? 'recorded',
      decidedAt: order?.decision?.decidedAt ?? state.token.decisionRecordedAt,
      deciderName: order?.decision?.deciderName ?? '',
      message: 'A decision has already been recorded for this document. No further action is needed.',
    });
  }),
);

publicApprovalsRouter.post(
  '/approvals/:token/decision',
  // Aggressive limit: the token is the only credential here, so this is the brute-force surface.
  rateLimit({ scope: 'approval:decide', capacity: 12, refillPerSecond: 12 / 3600, keyFn: (req) => `ip:${req.ip}` }),
  validate({
    body: z.object({
      decision: z.enum(['accepted', 'rejected', 'clarification_requested']),
      name: z.string().min(2).max(160),
      email: z.string().email().max(200),
      role: z.string().max(120).optional(),
      comment: z.string().max(4000).optional(),
      typedName: z.string().max(160).optional(),
      acknowledged: z.literal(true),
      displayedDocumentHash: z.string().min(8).max(200),
      displayedVersion: z.number().int().min(1),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await recordDecision({
      rawToken: String(req.params.token ?? ''),
      ...req.body,
      ctx: clientActor(req),
    });
    res.status(201).json({
      decision: {
        id: String(result.decision._id),
        decision: result.decision.decision,
        decidedAt: result.decision.createdAt,
        documentVersion: result.decision.documentVersion,
        documentHash: result.decision.documentHash,
      },
      order: { number: result.order.number, version: result.order.version, status: result.order.status },
      next:
        result.decision.decision === 'accepted'
          ? 'Your decision has been recorded and the agency has been notified. The change will be scheduled and confirmed separately.'
          : result.decision.decision === 'rejected'
            ? 'Your decision has been recorded. No work will proceed on this proposal.'
            : 'Your questions have been sent to the agency. They will respond before any work is priced or scheduled.',
      disclaimer:
        'This records your decision against the exact document version shown. It is not legal advice and is not presented as a qualified electronic signature in any jurisdiction.',
    });
  }),
);

// ── Internal surface ────────────────────────────────────────────────────────

const mutating = [authenticate, verifyCsrf] as const;
approvalsRouter.use(authenticate, requireOrg);

approvalsRouter.get(
  '/approvals',
  requirePermission('change_order.send'),
  asyncHandler(async (req, res) => {
    const tokens = await ApprovalToken.find({ org: req.org!.orgId }).sort({ createdAt: -1 }).limit(100).lean();
    const orderIds = tokens.map((t) => t.changeOrder);
    const orders = await ChangeOrder.find({ _id: { $in: orderIds } }).select('number version title status').lean();
    const byId = new Map(orders.map((o) => [String(o._id), o]));
    res.json({
      links: tokens.map((t) => ({
        id: String(t._id),
        changeOrderId: String(t.changeOrder),
        order: byId.get(String(t.changeOrder)) ?? null,
        recipientEmail: t.recipientEmail,
        boundVersion: t.boundVersion,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
        revokedReason: t.revokedReason,
        accessCount: t.accessCount,
        firstAccessedAt: t.firstAccessedAt,
        decisionRecordedAt: t.decisionRecordedAt,
      })),
    });
  }),
);

approvalsRouter.post(
  '/approvals/:tokenId/revoke',
  ...mutating,
  requirePermission('change_order.revoke_token'),
  validate({ body: z.object({ reason: z.string().min(5).max(1000) }) }),
  asyncHandler(async (req, res) => {
    const token = await revokeToken({
      orgId: req.org!.orgId,
      tokenId: String(req.params.tokenId ?? ''),
      reason: req.body.reason,
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email, ip: req.ip, userAgent: req.header('user-agent') },
    });
    res.json({ revokedAt: token.revokedAt, reason: token.revokedReason });
  }),
);

/** Decision history — the record that answers "what exactly did the client agree to?". */
approvalsRouter.get(
  '/approvals/decisions',
  requirePermission('report.view'),
  asyncHandler(async (req, res) => {
    const decisions = await ApprovalDecision.find({ org: req.org!.orgId }).sort({ createdAt: -1 }).limit(200).lean();
    const orderIds = [...new Set(decisions.map((d) => String(d.changeOrder)))];
    const orders = await ChangeOrder.find({ _id: { $in: orderIds } }).select('number version title project').lean();
    const projectIds = [...new Set(orders.map((o) => String(o.project)))];
    const projects = await Project.find({ _id: { $in: projectIds } }).select('code name client').lean();
    const clientIds = [...new Set(projects.map((p) => String(p.client)))];
    const clients = await Client.find({ _id: { $in: clientIds } }).select('name').lean();
    const orderById = new Map(orders.map((o) => [String(o._id), o]));
    const projectById = new Map(projects.map((p) => [String(p._id), p]));
    const clientById = new Map(clients.map((c) => [String(c._id), c]));

    res.json({
      decisions: decisions.map((d) => {
        const order = orderById.get(String(d.changeOrder));
        const project = order ? projectById.get(String(order.project)) : undefined;
        const client = project ? clientById.get(String(project.client)) : undefined;
        return {
          id: String(d._id),
          decision: d.decision,
          decidedAt: d.createdAt,
          decider: d.decider,
          comment: d.comment,
          documentVersion: d.documentVersion,
          documentHash: d.documentHash,
          agreedTerms: d.agreedTerms,
          order: order ? { number: order.number, version: order.version, title: order.title } : null,
          project: project ? { code: project.code, name: project.name } : null,
          clientName: client?.name ?? '',
        };
      }),
    });
  }),
);

/** Access trail for one link — "did they even open it?" answered from stored data. */
approvalsRouter.get(
  '/approvals/:tokenId/access-log',
  requirePermission('change_order.send'),
  asyncHandler(async (req, res) => {
    const token = await ApprovalToken.findOne({ _id: String(req.params.tokenId ?? ''), org: req.org!.orgId }).lean();
    if (!token) throw notFound('Approval link not found.');
    logger.info('approval.access_log_viewed', { tokenId: String(token._id), org: String(token.org) });
    res.json({
      accessCount: token.accessCount,
      firstAccessedAt: token.firstAccessedAt,
      lastAccessedAt: token.lastAccessedAt,
      accessLog: token.accessLog,
      decisionRecordedAt: token.decisionRecordedAt,
      note: 'Opening this link records an access only. Acceptance requires an explicit decision, which is stored separately.',
    });
  }),
);
