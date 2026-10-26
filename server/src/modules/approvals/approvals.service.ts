import mongoose from 'mongoose';
import {
  ApprovalDecision,
  ApprovalToken,
  ChangeOrder,
  ChangeRequest,
  Client,
  Organization,
  Project,
  User,
} from '../../models';
import { badRequest, conflict, notFound, proposalSuperseded, tokenConsumed, tokenExpired, tokenRevoked } from '../../platform/errors';
import { sha256 } from '../../platform/crypto';
import { recordAudit } from '../../platform/audit';
import { AUDIT_ACTIONS } from '../../config/constants';
import { logger } from '../../platform/logger';

/**
 * The public approval portal.
 *
 * Design rules encoded here:
 *  1. Opening a link is NOT acceptance. Reads are logged and nothing else changes.
 *  2. A decision is bound to the exact (version, document hash) that was displayed. If the
 *     proposal was superseded or re-rendered in between, the decision is REFUSED, not
 *     silently applied to the newer document.
 *  3. Expired, revoked, or already-decided links fail closed with distinct, non-leaky errors.
 *  4. Accepting never edits the baseline. It records the client's authorisation and marks the
 *     change as pending an internal baseline update, which a human performs deliberately.
 *  5. Nothing here claims legal enforceability or qualified e-signature status.
 */

export type PublicContext = { ip?: string; userAgent?: string };

export type TokenState =
  | { kind: 'valid'; token: InstanceType<typeof ApprovalToken>; order: InstanceType<typeof ChangeOrder> }
  | { kind: 'invalid' }
  | { kind: 'expired'; token: InstanceType<typeof ApprovalToken> }
  | { kind: 'revoked'; token: InstanceType<typeof ApprovalToken>; reason: string }
  | { kind: 'superseded'; token: InstanceType<typeof ApprovalToken>; order: InstanceType<typeof ChangeOrder> | null }
  | { kind: 'already_decided'; token: InstanceType<typeof ApprovalToken>; order: InstanceType<typeof ChangeOrder> | null };

export async function lookupToken(rawToken: string, ctx: PublicContext = {}): Promise<TokenState> {
  if (!rawToken || rawToken.length < 20) return { kind: 'invalid' };
  const tokenHash = sha256(rawToken);
  const token = await ApprovalToken.findOne({ tokenHash });
  // A well-formed but unknown token is indistinguishable from a malformed one to the outside
  // world, but the caller still gets a distinct state for rendering.
  if (!token) return { kind: 'invalid' };

  const order = await ChangeOrder.findById(token.changeOrder);
  const now = new Date();

  // Record the read. This is deliberately an accounting-only write.
  await ApprovalToken.updateOne(
    { _id: token._id },
    {
      $inc: { accessCount: 1 },
      $set: { lastAccessedAt: now, ...(token.firstAccessedAt ? {} : { firstAccessedAt: now }) },
      $push: { accessLog: { $each: [{ at: now, ip: ctx.ip ?? '', userAgent: (ctx.userAgent ?? '').slice(0, 400) }], $slice: -50 } },
    },
  );

  if (token.revokedAt) return { kind: 'revoked', token, reason: token.revokedReason || 'This link was revoked.' };
  if (token.expiresAt.getTime() < now.getTime()) return { kind: 'expired', token };
  if (!order) return { kind: 'invalid' };

  if (order.status === 'superseded') return { kind: 'superseded', token, order };
  if (token.decisionRecordedAt) return { kind: 'already_decided', token, order };

  // The link may only act on the document it was issued for.
  if (order.version !== token.boundVersion || (order.pdfHash && order.pdfHash !== token.boundDocumentHash)) {
    return { kind: 'superseded', token, order };
  }

  return { kind: 'valid', token, order };
}

/** Client-safe projection of the change order. No internal notes, no cost, no margins. */
export function publicOrderView(order: InstanceType<typeof ChangeOrder>) {
  const pricing = order.pricing ?? null;
  return {
    id: String(order._id),
    number: order.number,
    version: order.version,
    status: order.status,
    option: order.option,
    title: order.title,
    summary: order.summary,
    baselineVersionNumber: order.baselineVersionNumber ?? null,
    scopeAdditions: order.scopeAdditions.map((s) => ({
      title: s.title,
      description: s.description ?? '',
      acceptanceCriteria: s.acceptanceCriteria ?? [],
      estimatedHours: s.estimatedHours ?? null,
    })),
    scopeRemovals: order.scopeRemovals.map((s) => ({ requirementKey: s.requirementKey ?? '', title: s.title ?? '', note: s.note ?? '' })),
    relatedRequirements: order.relatedRequirements.map((r) => ({ key: r.key ?? '', title: r.title ?? '' })),
    // Billing total only. Internal cost rates and margin are never exposed on this surface.
    pricing: pricing
      ? {
          currency: pricing.currency,
          subtotal: pricing.subtotal?.amount ?? 0,
          contingency: pricing.contingency?.amount ?? 0,
          discount: pricing.discount?.amount ?? 0,
          tax: pricing.tax?.amount ?? 0,
          total: pricing.total?.amount ?? 0,
          notes: pricing.notes ?? '',
        }
      : null,
    schedule: {
      additionalWorkdays: order.schedule?.additionalWorkdays ?? 0,
      currentTargetDate: order.schedule?.currentTargetDate ?? null,
      revisedTargetDate: order.schedule?.revisedTargetDate ?? null,
      assumptions: order.schedule?.assumptions ?? [],
    },
    assumptions: order.assumptions,
    dependencies: order.dependencies,
    termsText: order.termsText,
    validUntil: order.validUntil,
    sentAt: order.sentAt,
  };
}

export async function publicViewForToken(token: InstanceType<typeof ApprovalToken>, order: InstanceType<typeof ChangeOrder>) {
  const [project, client, org] = await Promise.all([
    Project.findById(order.project).lean(),
    Client.findById(order.client).lean(),
    Organization.findById(order.org).lean(),
  ]);
  return {
    agency: { name: org?.name ?? 'Agency', branding: org?.branding ?? {} },
    project: { code: project?.code ?? '', name: project?.name ?? '' },
    client: { name: client?.name ?? '', contactName: client?.contactName ?? '' },
    recipient: { email: token.recipientEmail, name: token.recipientName },
    expiresAt: token.expiresAt,
    order: publicOrderView(order),
    disclaimer: {
      version: 'v1',
      text:
        'Submitting this form records your decision in the agency’s system against the exact document version shown. It is a record of authorisation for this change, not legal advice, and it is not presented as a qualified electronic signature under any particular jurisdiction. Ask the agency for their contracting terms before relying on it.',
    },
  };
}

export type DecisionInput = {
  rawToken: string;
  decision: 'accepted' | 'rejected' | 'clarification_requested';
  name: string;
  email: string;
  role?: string;
  comment?: string;
  typedName?: string;
  acknowledged: boolean;
  displayedDocumentHash: string;
  displayedVersion: number;
  ctx: PublicContext;
};

/**
 * Records a client decision.
 *
 * `displayedDocumentHash` / `displayedVersion` come from the page the client actually looked at,
 * so a decision taken on a stale tab against an older draft is refused rather than misattributed.
 */
export async function recordDecision(input: DecisionInput) {
  if (!input.acknowledged) {
    throw badRequest('Please confirm you have reviewed the document before submitting a decision.');
  }
  if (!input.name.trim() || !input.email.trim()) {
    throw badRequest('Please provide your name and email address so the decision can be attributed.');
  }

  const state = await lookupToken(input.rawToken, input.ctx);
  if (state.kind === 'invalid') throw notFound('This approval link is not valid.');
  if (state.kind === 'expired') {
    throw tokenExpired('This approval link has expired. Ask the agency to issue a new one.');
  }
  if (state.kind === 'revoked') throw tokenRevoked(state.reason);
  if (state.kind === 'superseded') {
    throw proposalSuperseded('This proposal has been replaced by a newer version. Please review the latest document before deciding.');
  }
  if (state.kind === 'already_decided') throw tokenConsumed();

  const { token, order } = state;

  // Stale-tab guard.
  if (input.displayedVersion !== order.version || (order.pdfHash && input.displayedDocumentHash !== order.pdfHash)) {
    throw conflict('The document changed while this page was open. Reload to see the current version before deciding.');
  }

  const identityBasis: 'invited_recipient' | 'unverified_declaration' =
    input.email.trim().toLowerCase() === token.recipientEmail ? 'invited_recipient' : 'unverified_declaration';

  const request = await ChangeRequest.findById(order.request);

  const decision = await ApprovalDecision.create({
    org: order.org,
    project: order.project,
    changeOrder: order._id,
    request: order.request,
    token: token._id,
    decision: input.decision,
    decider: { name: input.name.trim(), email: input.email.trim().toLowerCase(), role: input.role ?? '', identityBasis },
    comment: input.comment ?? '',
    documentVersion: order.version,
    documentHash: order.pdfHash || token.boundDocumentHash,
    agreedTerms: {
      totalMinor: order.pricing?.total?.amount ?? 0,
      currency: order.pricing?.currency ?? 'USD',
      revisedTargetDate: order.schedule?.revisedTargetDate ?? null,
      additionalWorkdays: order.schedule?.additionalWorkdays ?? 0,
      option: order.option,
    },
    ip: input.ctx.ip ?? '',
    userAgent: (input.ctx.userAgent ?? '').slice(0, 400),
    acknowledgement: { acceptedTerms: true, typedName: input.typedName ?? '', disclaimerVersion: 'v1' },
    isDemo: Boolean(order.isDemo),
  });

  order.status = input.decision;
  order.decision = {
    outcome: input.decision,
    decidedAt: new Date(),
    deciderName: input.name.trim(),
    deciderEmail: input.email.trim().toLowerCase(),
    comment: input.comment ?? '',
    documentVersion: order.version,
    documentHash: order.pdfHash || token.boundDocumentHash,
    decisionId: decision._id as mongoose.Types.ObjectId,
  };
  await order.save();

  await ApprovalToken.updateOne(
    { _id: token._id },
    { $set: { decisionRecordedAt: new Date() } },
  );

  if (request) {
    if (input.decision === 'accepted') {
      // The client authorised the change. Applying it to the baseline stays a deliberate,
      // human-run step (applyAcceptedChange -> baselines.applyAcceptedChangeToBaseline).
      request.status = 'approved';
      request.chosenOption = order.option;
    } else if (input.decision === 'rejected') {
      request.status = 'rejected';
      request.chosenOption = order.option;
    } else {
      request.status = 'clarification_required';
    }
    const previous = request.outcome;
    request.outcome = {
      decidedAt: new Date(),
      decision: input.decision,
      decidedBy: `${input.name.trim()} <${input.email.trim().toLowerCase()}>`,
      additionalValueMinor: order.pricing?.total?.amount ?? 0,
      currency: order.pricing?.currency ?? 'USD',
      scheduleImpactWorkdays: order.schedule?.additionalWorkdays ?? 0,
      baselineUpdatedTo: previous?.baselineUpdatedTo ?? null,
      unapprovedHours: previous?.unapprovedHours ?? 0,
    };
    await request.save();
  }

  await recordAudit({
    org: String(order.org),
    action: AUDIT_ACTIONS.approvalDecisionRecorded,
    actor: { kind: 'client', name: input.name.trim(), email: input.email.trim().toLowerCase() },
    entity: { type: 'ChangeOrder', id: String(order._id), label: `${order.number} v${order.version}` },
    meta: {
      decision: input.decision,
      identityBasis,
      documentVersion: order.version,
      documentHash: order.pdfHash,
      commentChars: (input.comment ?? '').length,
      ip: input.ctx.ip ?? '',
      tokenId: String(token._id),
    },
    ip: input.ctx.ip,
    userAgent: input.ctx.userAgent,
  });

  // Inform internal stakeholders. A failure here must never lose the decision.
  try {
    const recipients = await User.find({ 'memberships.org': order.org, status: 'active' }).select('email name').lean();
    logger.info('approval.decision.recorded', {
      orderId: String(order._id),
      decision: input.decision,
      recipients: recipients.length,
      org: String(order.org),
    });
  } catch (err) {
    logger.error('approval.decision.notify_failed', { orderId: String(order._id), error: String(err) });
  }

  return { decision, order };
}

/** Internal: revoke a link (with reason) without touching the proposal itself. */
export async function revokeToken(input: {
  orgId: string;
  tokenId: string;
  reason: string;
  actor: { userId: string; name: string; email: string; ip?: string; userAgent?: string };
}) {
  const token = await ApprovalToken.findOne({ _id: input.tokenId, org: input.orgId });
  if (!token) throw notFound('Approval link not found.');
  if (token.revokedAt) throw conflict('This link has already been revoked.');

  token.revokedAt = new Date();
  token.revokedReason = input.reason;
  await token.save();

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.approvalTokenRevoked,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'ApprovalToken', id: String(token._id), label: token.recipientEmail },
    meta: { reason: input.reason, changeOrder: String(token.changeOrder) },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });

  return token;
}

/**
 * Internal: deliberately apply an client-accepted change to a new baseline version.
 * Kept separate so a client click can never mutate the agreed baseline by itself.
 */
export async function applyAcceptedChange(input: {
  orgId: string;
  changeOrderId: string;
  actor: { userId: string; name: string; email: string; ip?: string; userAgent?: string };
  note?: string;
}) {
  const order = await ChangeOrder.findOne({ _id: input.changeOrderId, org: input.orgId });
  if (!order) throw notFound('Change order not found.');
  if (order.status !== 'accepted') {
    throw conflict('Only an accepted change order can be applied to the baseline.');
  }
  const baselineService = await import('../baselines/baselines.service');
  return baselineService.applyAcceptedChangeToBaseline({
    orgId: input.orgId,
    changeOrderId: String(order._id),
    actor: input.actor,
    note: input.note ?? '',
  });
}
