import mongoose from 'mongoose';
import { ApprovalToken, BaselineVersion, ChangeOrder, ChangeRequest, Client, Document, EffortEstimate, Organization, Project } from '../../models';
import { badRequest, conflict, notFound, precondition } from '../../platform/errors';
import { generateOpaqueToken, sha256 } from '../../platform/crypto';
import { renderChangeOrderPdf } from '../../platform/pdf';
import { storage } from '../../platform/storage';
import { recordAudit } from '../../platform/audit';
import { AUDIT_ACTIONS } from '../../config/constants';
import { env } from '../../config/env';
import { webUrl } from '../../platform/http';
import { formatMoney } from '../../domain/money';

export type ActorCtx = { userId: string; name: string; email: string; ip?: string; userAgent?: string };

const OPTION_LABELS: Record<string, string> = {
  add_with_fee: 'Additional work — additional fee',
  add_with_time: 'Additional work — timeline extension',
  substitute: 'Substitution — equal-value swap',
  defer: 'Deferred to a later phase',
  goodwill: 'Included as a goodwill exception',
  reject: 'Not proceeding',
  clarify: 'Clarification required before pricing',
};

export function optionLabel(option: string): string {
  return OPTION_LABELS[option] ?? option;
}

async function nextOrderNumber(orgId: string): Promise<{ number: string; sequence: number }> {
  const last = await ChangeOrder.findOne({ org: orgId }).sort({ sequence: -1 }).select('sequence').lean();
  const sequence = (last?.sequence ?? 0) + 1;
  return { number: `CO-${String(sequence).padStart(4, '0')}`, sequence };
}

const PRICED_OPTIONS = ['add_with_fee', 'add_with_time', 'substitute'];

/**
 * Creates (or versions) a change order for a request.
 *
 * Versioning rule: issuing a new version supersedes the previous one AND revokes its
 * approval links, so a client can never accept a document they did not read.
 */
export async function generateChangeOrder(input: {
  orgId: string;
  requestId: string;
  actor: ActorCtx;
  option: 'add_with_fee' | 'add_with_time' | 'substitute' | 'defer' | 'goodwill' | 'reject' | 'clarify';
  title?: string;
  summary: string;
  scopeAdditions?: { title: string; description?: string; acceptanceCriteria?: string[]; estimatedHours?: number }[];
  scopeRemovals?: { requirementKey?: string; title?: string; note?: string }[];
  relatedRequirementKeys?: string[];
  estimateId?: string;
  validUntil?: string | null;
  termsText?: string;
}) {
  const request = await ChangeRequest.findOne({ _id: input.requestId, org: input.orgId });
  if (!request) throw notFound('Request not found.');
  const project = await Project.findOne({ _id: request.project, org: input.orgId });
  if (!project) throw notFound('Project not found.');
  const client = await Client.findById(project.client).lean();

  if (request.status === 'clarification_required' && input.option !== 'clarify') {
    throw precondition(
      'This request is waiting on clarification. Answer the outstanding questions before pricing it, or issue a clarification document.',
    );
  }
  if (input.option === 'clarify' && (input.scopeAdditions?.length ?? 0) > 0) {
    throw badRequest('A clarification document cannot carry priced scope additions.');
  }

  const estimate = input.estimateId
    ? await EffortEstimate.findOne({ _id: input.estimateId, org: input.orgId, request: request._id })
    : await EffortEstimate.findOne({ request: request._id, status: 'final' });

  const priced = PRICED_OPTIONS.includes(input.option);
  if (priced && !estimate) throw precondition('Create and finalise an estimate before issuing a priced change order.');
  if (priced && estimate && estimate.status !== 'final') {
    throw precondition('The estimate for this request is still a draft. Finalise it before creating the change order.');
  }
  const additions = input.scopeAdditions ?? [];
  if (priced && additions.length === 0) {
    throw badRequest('Describe at least one scope addition. A price without a described deliverable is not something a client can meaningfully accept.');
  }

  const pricing = priced && estimate
    ? {
        currency: estimate.pricing?.total?.currency ?? estimate.currency,
        subtotal: estimate.pricing?.subtotal ?? { amount: 0, currency: estimate.currency },
        contingency: estimate.pricing?.contingency ?? { amount: 0, currency: estimate.currency },
        discount: estimate.pricing?.discount ?? { amount: 0, currency: estimate.currency },
        tax: estimate.pricing?.tax ?? { amount: 0, currency: estimate.currency },
        total: estimate.pricing?.total ?? { amount: 0, currency: estimate.currency },
        effectiveHourlyRate: estimate.pricing?.effectiveHourlyRate ?? { amount: 0, currency: estimate.currency },
        notes: estimate.note ?? '',
      }
    : {
        currency: project.currency,
        subtotal: { amount: 0, currency: project.currency },
        contingency: { amount: 0, currency: project.currency },
        discount: { amount: 0, currency: project.currency },
        tax: { amount: 0, currency: project.currency },
        total: { amount: 0, currency: project.currency },
        effectiveHourlyRate: { amount: 0, currency: project.currency },
        notes: input.option === 'goodwill' ? 'No charge. Offered as a goodwill exception.' : '',
      };

  const schedule = estimate
    ? {
        additionalWorkdays: estimate.schedule?.override?.applied
          ? estimate.schedule.override.workdays ?? 0
          : estimate.schedule?.additionalWorkdays ?? 0,
        currentTargetDate: project.targetEndDate ?? null,
        revisedTargetDate: estimate.schedule?.override?.projectedEndDate ?? estimate.schedule?.projectedEndDate ?? null,
        assumptions: estimate.schedule?.assumptions ?? [],
      }
    : {
        additionalWorkdays: 0,
        currentTargetDate: project.targetEndDate ?? null,
        revisedTargetDate: null,
        assumptions: ['No estimate is attached, so no schedule change is stated in this document.'],
      };

  const previous = (await ChangeOrder.find({ request: request._id }).sort({ version: -1 }))[0];
  const version = (previous?.version ?? 0) + 1;
  const identity = previous
    ? { number: previous.number, sequence: previous.sequence }
    : await nextOrderNumber(input.orgId);

  const baselineSnapshot = project.currentBaseline ? await BaselineVersion.findById(project.currentBaseline).lean() : null;
  const relatedKeys = input.relatedRequirementKeys ?? [];
  const relatedRequirements = (baselineSnapshot?.snapshot.requirements ?? [])
    .filter((r) => relatedKeys.includes(r.key))
    .map((r) => ({ key: r.key, title: r.title }));

  const order = await ChangeOrder.create({
    org: input.orgId,
    project: project._id,
    request: request._id,
    client: project.client,
    number: identity.number,
    sequence: identity.sequence,
    version,
    status: 'draft',
    option: input.option,
    title: input.title ?? request.title,
    summary: input.summary,
    baselineVersion: baselineSnapshot?._id ?? null,
    baselineVersionNumber: baselineSnapshot?.version ?? null,
    scopeAdditions: additions,
    scopeRemovals: (input.scopeRemovals ?? []).map((r) => ({ requirementKey: r.requirementKey ?? '', title: r.title ?? '', note: r.note ?? '' })),
    relatedRequirements,
    pricing,
    schedule,
    dependencies: [],
    assumptions: schedule.assumptions,
    termsText: input.termsText ?? '',
    validUntil: input.validUntil ? new Date(input.validUntil) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdBy: input.actor.userId,
  });

  if (previous) {
    previous.status = 'superseded';
    previous.supersededBy = order._id as mongoose.Types.ObjectId;
    previous.activeTokenHash = '';
    await previous.save();
    await ApprovalToken.updateMany(
      { changeOrder: previous._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: `Superseded by version ${version}` } },
    );
  }

  request.activeChangeOrder = order._id as mongoose.Types.ObjectId;
  request.chosenOption = input.option;
  await request.save();

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.changeOrderGenerated,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'ChangeOrder', id: String(order._id), label: `${order.number} v${version}` },
    meta: {
      option: input.option,
      totalMinor: pricing.total.amount,
      currency: pricing.currency,
      estimateId: estimate ? String(estimate._id) : null,
      supersededPrevious: Boolean(previous),
    },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });

  return { order, project, request, client };
}

/** Renders the PDF, stores it privately, and records the hash a decision will bind to. */
export async function renderAndStorePdf(orderId: string, actor: ActorCtx) {
  const order = await ChangeOrder.findById(orderId);
  if (!order) throw notFound('Change order not found.');
  const [project, client, org, request] = await Promise.all([
    Project.findById(order.project).lean(),
    Client.findById(order.client).lean(),
    Organization.findById(order.org).lean(),
    ChangeRequest.findById(order.request).lean(),
  ]);

  // Narrowed once so the renderer never sees a partially-populated pricing block.
  const rawPricing = order.pricing as
    | {
        currency?: string;
        subtotal?: { amount: number; currency: string } | null;
        contingency?: { amount: number; currency: string } | null;
        discount?: { amount: number; currency: string } | null;
        tax?: { amount: number; currency: string } | null;
        total?: { amount: number; currency: string } | null;
        effectiveHourlyRate?: { amount: number; currency: string } | null;
        notes?: string | null;
      }
    | null
    | undefined;
  const pricing = { currency: rawPricing?.currency ?? order.pricing?.currency ?? 'USD', ...rawPricing };
  const fallback = { amount: 0, currency: pricing.currency };
  const schedule = order.schedule ?? { additionalWorkdays: 0, currentTargetDate: null, revisedTargetDate: null, assumptions: [] };

  const buffer = await renderChangeOrderPdf({
    agencyName: org?.name ?? 'Agency',
    agencyFooter: org?.branding?.documentFooter ?? '',
    agencyContact: actor.email,
    clientName: client?.name ?? 'Client',
    clientContact: [client?.contactName, client?.contactEmail].filter(Boolean).join(' · '),
    projectCode: project?.code ?? '',
    projectName: project?.name ?? '',
    requestRef: request?.ref ?? '',
    requestTitle: request?.title ?? '',
    orderNumber: order.number,
    version: order.version,
    option: order.option,
    optionLabel: optionLabel(order.option),
    baselineVersion: order.baselineVersionNumber ?? null,
    summary: order.summary,
    scopeAdditions: order.scopeAdditions.map((s) => ({
      title: s.title,
      description: s.description ?? undefined,
      acceptanceCriteria: s.acceptanceCriteria ?? [],
      estimatedHours: s.estimatedHours ?? undefined,
    })),
    scopeRemovals: order.scopeRemovals.map((s) => ({ requirementKey: s.requirementKey ?? '', title: s.title ?? '', note: s.note ?? '' })),
    relatedRequirements: order.relatedRequirements.map((r) => ({ key: r.key ?? '', title: r.title ?? '' })),
    pricing: {
      currency: pricing.currency,
      subtotal: pricing.subtotal ?? fallback,
      contingency: pricing.contingency ?? fallback,
      discount: pricing.discount ?? fallback,
      tax: pricing.tax ?? fallback,
      total: pricing.total ?? fallback,
      notes: pricing.notes ?? '',
      effectiveHourlyRate: pricing.effectiveHourlyRate ?? undefined,
    },
    schedule: {
      additionalWorkdays: schedule.additionalWorkdays ?? 0,
      currentTargetDate: schedule.currentTargetDate ?? null,
      revisedTargetDate: schedule.revisedTargetDate ?? null,
      assumptions: schedule.assumptions ?? [],
    },
    dependencies: order.dependencies,
    assumptions: order.assumptions,
    validUntil: order.validUntil,
    termsText: order.termsText,
    generatedAt: new Date(),
    approvalUrl: `${env.webPublicUrl}/approve/LINK`,
  });

  const stored = await storage.put(buffer, { extension: '.pdf' });
  const document = await Document.create({
    org: order.org,
    project: order.project,
    client: order.client,
    kind: 'change_order_pdf',
    originalName: `${order.number}-v${order.version}.pdf`,
    storageKey: stored.key,
    detectedMime: 'application/pdf',
    claimedMime: 'application/pdf',
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    extraction: { status: 'skipped', method: 'none', charCount: 0, error: '', attemptedAt: new Date(), needsOcr: false },
    linkedTo: { type: 'change_order', id: order._id },
    uploadedBy: actor.userId,
  });

  const documentHash = sha256(
    `${order.number}|v${order.version}|${stored.sha256}|${pricing.total?.amount ?? 0}|${pricing.currency}`,
  );
  order.pdfDocument = document._id as mongoose.Types.ObjectId;
  order.pdfHash = documentHash;
  await order.save();

  return { document, documentHash, order };
}

/**
 * Sends the approval link. A rendered PDF is required first so the client reviews a frozen
 * document. The raw token exists only in the email; the database stores its hash.
 */
export async function sendChangeOrder(input: {
  orgId: string;
  orderId: string;
  actor: ActorCtx;
  recipientEmail?: string;
  recipientName?: string;
  ttlDays?: number;
}) {
  const order = await ChangeOrder.findOne({ _id: input.orderId, org: input.orgId });
  if (!order) throw notFound('Change order not found.');
  if (order.status === 'superseded') throw conflict('This version has been superseded by a newer one. Send the current version instead.');
  if (order.status === 'accepted') throw conflict('This change order has already been accepted.');
  if (order.status === 'sent') throw conflict('This change order has already been sent. Revoke the existing link to issue a new one, or create a new version if the proposal changed.');

  /**
   * Render first, then re-read the order. `renderAndStorePdf` writes pdfDocument and pdfHash
   * through its own document instance, so continuing with the instance loaded above would leave
   * this request holding a stale copy — and the approval link would be issued against an empty
   * document hash, which the decision endpoint (correctly) refuses to accept.
   */
  const { documentHash } = await renderAndStorePdf(String(order._id), input.actor);
  const fresh = await ChangeOrder.findOne({ _id: order._id, org: input.orgId });
  if (!fresh) throw notFound('Change order not found.');
  order.pdfDocument = fresh.pdfDocument;
  order.pdfHash = fresh.pdfHash;
  await order.save();
  const [org, client] = await Promise.all([Organization.findById(input.orgId).lean(), Client.findById(order.client).lean()]);

  const ttlDays = input.ttlDays ?? org?.approvalPolicy?.tokenTtlDays ?? env.approvalTokenTtlDays;
  const token = generateOpaqueToken(32);
  const recipientEmail = (input.recipientEmail ?? client?.contactEmail ?? '').toLowerCase();
  if (!recipientEmail) {
    throw badRequest('No recipient email address is available. Add a contact email to the client, or supply one explicitly.');
  }

  await ApprovalToken.updateMany(
    { changeOrder: order._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'Replaced by a newly issued link' } },
  );

  const approvalToken = await ApprovalToken.create({
    org: input.orgId,
    changeOrder: order._id,
    project: order.project,
    tokenHash: sha256(token),
    boundVersion: order.version,
    boundDocumentHash: documentHash,
    recipientEmail,
    recipientName: input.recipientName ?? client?.contactName ?? '',
    createdBy: input.actor.userId,
    expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
  });

  order.status = 'sent';
  order.sentAt = new Date();
  order.sentBy = new mongoose.Types.ObjectId(input.actor.userId);
  order.sentTo = [recipientEmail];
  order.activeTokenHash = approvalToken.tokenHash;
  await order.save();

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.changeOrderSent,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'ChangeOrder', id: String(order._id), label: `${order.number} v${order.version}` },
    meta: { recipientEmail, expiresAt: approvalToken.expiresAt, documentHash, ttlDays },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });

  return { order, token, approvalToken, approvalUrl: webUrl(`/approve/${token}`), expiresAt: approvalToken.expiresAt };
}

export function describePricing(order: { pricing?: { total?: { amount: number; currency: string } | null } | null }): string {
  const total = order.pricing?.total;
  if (!total) return 'No price stated';
  return formatMoney({ amount: total.amount, currency: total.currency });
}
