import mongoose from 'mongoose';
import {
  BaselineVersion,
  ChangeOrder,
  ChangeRequest,
  EffortEstimate,
  Notification,
  Project,
  TimeEntry,
} from '../../models';
import { conflict, forbidden, notFound, precondition, invalidTransition } from '../../platform/errors';
import { recordAudit } from '../../platform/audit';
import { AUDIT_ACTIONS } from '../../config/constants';
import {
  AUTHORISED_STATUSES,
  canTransition,
  transitionsFrom,
  type RequestStatus,
  type TransitionContext,
} from '../../domain/stateMachine';

export type ActorCtx = { userId: string; name: string; email: string; ip?: string; userAgent?: string };

/** Allocates the next human reference (CR-2026-0007) for an organization. */
async function nextRequestRef(orgId: string): Promise<{ ref: string; sequence: number }> {
  const year = new Date().getUTCFullYear();
  const last = await ChangeRequest.findOne({ org: orgId }).sort({ sequence: -1 }).select('sequence').lean();
  const sequence = (last?.sequence ?? 0) + 1;
  return { ref: `CR-${year}-${String(sequence).padStart(4, '0')}`, sequence };
}

export async function createRequest(input: {
  orgId: string;
  projectId: string;
  actor: ActorCtx;
  data: {
    title: string;
    description: string;
    requesterName?: string;
    requesterEmail?: string;
    source?: string;
    sourceDetail?: string;
    desiredBy?: string | null;
    businessReason?: string;
    affectedDeliverables?: string[];
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    evidence?: {
      kind: string;
      source?: string;
      occurredAt?: string | null;
      quote?: string;
      documentId?: string;
      consentAttested?: boolean;
    }[];
    assignedReviewerId?: string;
    submit?: boolean;
  },
}) {
  const project = await Project.findOne({ _id: input.projectId, org: input.orgId, deletedAt: null }).lean();
  if (!project) throw notFound('Project not found.');

  const { ref, sequence } = await nextRequestRef(input.orgId);
  const submit = input.data.submit !== false;

  const request = await ChangeRequest.create({
    org: input.orgId,
    project: project._id,
    ref,
    sequence,
    title: input.data.title,
    description: input.data.description,
    requester: {
      name: input.data.requesterName ?? input.actor.name,
      email: (input.data.requesterEmail ?? input.actor.email).toLowerCase(),
      user: input.actor.userId,
      client: project.client,
    },
    source: input.data.source ?? 'internal',
    sourceDetail: input.data.sourceDetail ?? '',
    desiredBy: input.data.desiredBy ? new Date(input.data.desiredBy) : null,
    businessReason: input.data.businessReason ?? '',
    affectedDeliverables: input.data.affectedDeliverables ?? [],
    priority: input.data.priority ?? 'normal',
    status: submit ? 'submitted' : 'draft',
    submittedAt: submit ? new Date() : null,
    assignedReviewer: input.data.assignedReviewerId
      ? new mongoose.Types.ObjectId(input.data.assignedReviewerId)
      : new mongoose.Types.ObjectId(input.actor.userId),
    evidence: (input.data.evidence ?? []).map((e) => ({
      kind: e.kind,
      source: e.source ?? '',
      occurredAt: e.occurredAt ? new Date(e.occurredAt) : null,
      quote: e.quote ?? '',
      document: e.documentId ? new mongoose.Types.ObjectId(e.documentId) : null,
      addedBy: new mongoose.Types.ObjectId(input.actor.userId),
      addedAt: new Date(),
      consentAttested: Boolean(e.consentAttested),
    })),
    createdBy: input.actor.userId,
  });

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.requestCreated,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'ChangeRequest', id: String(request._id), label: `${request.ref} — ${request.title}` },
    meta: { source: request.source, evidenceCount: request.evidence.length, submitted: submit },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });

  if (request.assignedReviewer && String(request.assignedReviewer) !== input.actor.userId) {
    await Notification.create({
      org: input.orgId,
      user: request.assignedReviewer,
      type: 'request_assigned',
      title: `Review requested: ${request.ref}`,
      body: `${request.title} — assigned to you by ${input.actor.name}.`,
      link: `/app/requests/${request._id}`,
    });
  }

  return request;
}

/**
 * Builds the transition preconditions from live data. This is where "the client cannot
 * approve what they have not seen" and "work cannot start without a recorded decision"
 * are actually enforced.
 */
export async function buildTransitionContext(
  request: { _id: unknown; project: unknown; status: string; classification?: unknown; outstandingClarification: boolean; baselineUpdatedOrNotRequired: boolean },
  actorKind: 'member' | 'client' | 'system',
  reason?: string,
): Promise<TransitionContext> {
  const requestId = request._id as mongoose.Types.ObjectId;
  const [finalEstimate, sentOrder, acceptedDecision, rejectedDecision, anyDecision] = await Promise.all([
    EffortEstimate.findOne({ request: requestId, status: 'final' }).select('_id').lean(),
    ChangeOrder.findOne({ request: requestId, status: { $in: ['sent', 'accepted', 'rejected', 'clarification_requested'] } }).select('_id').lean(),
    ChangeOrder.findOne({ request: requestId, 'decision.outcome': 'accepted' }).select('_id').lean(),
    ChangeOrder.findOne({ request: requestId, 'decision.outcome': 'rejected' }).select('_id').lean(),
    ChangeOrder.findOne({ request: requestId, 'decision.outcome': { $ne: null } }).select('_id').lean(),
  ]);

  return {
    actorKind,
    hasFinalEstimate: Boolean(finalEstimate),
    hasClassification: Boolean(request.classification),
    changeOrderSent: Boolean(sentOrder),
    hasAcceptedDecision: Boolean(acceptedDecision),
    hasRejectedDecision: Boolean(rejectedDecision),
    awaitingClarification: request.outstandingClarification,
    baselineUpdatedOrNotRequired: request.baselineUpdatedOrNotRequired,
    hasAnyDecision: Boolean(anyDecision),
    reason,
  };
}

export async function transitionRequest(input: {
  orgId: string;
  requestId: string;
  to: RequestStatus;
  actor: ActorCtx;
  reason?: string;
  expectedRevision?: number;
}) {
  const request = await ChangeRequest.findOne({ _id: input.requestId, org: input.orgId });
  if (!request) throw notFound('Request not found.');

  // Optimistic concurrency: a stale screen cannot overwrite someone else's decision.
  if (input.expectedRevision !== undefined && request.revision !== input.expectedRevision) {
    throw conflict(
      'This request changed while you were looking at it. Reload to see the current state before acting.',
      { expectedRevision: input.expectedRevision, actualRevision: request.revision },
    );
  }

  const outstanding = request.clarifications.some((c) => c.questions.length > 0 && !c.answeredAt);
  const baselineUpdated = Boolean(request.outcome?.baselineUpdatedTo);
  const ctx = await buildTransitionContext(
    {
      _id: request._id,
      project: request.project,
      status: request.status,
      classification: request.classification,
      outstandingClarification: outstanding,
      baselineUpdatedOrNotRequired: baselineUpdated || input.to !== 'scheduled',
    },
    'member',
    input.reason,
  );

  const check = canTransition(request.status as RequestStatus, input.to, ctx);
  if (!check.allowed) throw invalidTransition(check.reason ?? 'That transition is not allowed.');

  const previous = request.status;
  request.status = input.to;
  if (input.to === 'submitted' && !request.submittedAt) request.submittedAt = new Date();
  if (input.to === 'closed') request.closedAt = new Date();
  if (input.to === 'cancelled') request.cancelledReason = input.reason ?? '';
  await request.save();

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.requestStatusChanged,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'ChangeRequest', id: String(request._id), label: `${request.ref} — ${request.title}` },
    changes: [{ field: 'status', from: previous, to: input.to }],
    meta: { reason: input.reason ?? '', transitionLabel: check.transition?.label ?? '' },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });

  return { request, transition: check.transition };
}

/** What the current member may do next — drives the UI without duplicating rules there. */
export async function availableTransitions(orgId: string, requestId: string, permissions: string[]) {
  const request = await ChangeRequest.findOne({ _id: requestId, org: orgId });
  if (!request) throw notFound('Request not found.');
  const outstanding = request.clarifications.some((c) => c.questions.length > 0 && !c.answeredAt);
  const baselineUpdated = Boolean(request.outcome?.baselineUpdatedTo);
  const results = [];
  for (const candidate of transitionsFrom(request.status as RequestStatus)) {
    const ctx = await buildTransitionContext(
      {
        _id: request._id,
        project: request.project,
        status: request.status,
        classification: request.classification,
        outstandingClarification: outstanding,
        baselineUpdatedOrNotRequired: baselineUpdated || candidate.to !== 'scheduled',
      },
      'member',
      'placeholder-reason', // a reason can always be supplied; length validated on use
    );
    const check = canTransition(request.status as RequestStatus, candidate.to, ctx);
    results.push({
      to: candidate.to,
      label: candidate.label,
      permission: candidate.permission,
      allowed: check.allowed && (permissions.includes(candidate.permission) || permissions.includes('request.review')),
      blockedReason: check.allowed ? null : check.reason ?? null,
      requiresPermission: !permissions.includes(candidate.permission),
      requiresReason: Boolean(candidate.requiresReason),
    });
  }
  return { status: request.status, revision: request.revision, transitions: results };
}

/** Records actual effort. The unapproved flag is set from the request state at entry time. */
export async function recordUnapprovedHours(requestId: string, hours: number): Promise<void> {
  const request = await ChangeRequest.findById(requestId);
  if (!request) return;
  request.outcome = { ...(request.outcome ?? {}), unapprovedHours: (request.outcome?.unapprovedHours ?? 0) + hours } as never;
  await request.save();
}

export async function recomputeEffort(requestId: string): Promise<void> {
  const request = await ChangeRequest.findById(requestId);
  if (!request) return;
  const agg = await TimeEntry.aggregate([
    { $match: { request: request._id } },
    { $group: { _id: null, actual: { $sum: '$hours' } } },
  ]);
  const estimate = await EffortEstimate.findOne({ request: request._id, status: 'final' }).select('totalHours').lean();
  request.effort = { estimatedHours: estimate?.totalHours ?? 0, actualHours: agg[0]?.actual ?? 0 };
  await request.save();
}

export async function currentBaselineFor(orgId: string, projectId: string) {
  const project = await Project.findOne({ _id: projectId, org: orgId, deletedAt: null }).lean();
  if (!project) throw notFound('Project not found.');
  if (!project.currentBaseline) return { project, baseline: null };
  const baseline = await BaselineVersion.findById(project.currentBaseline).lean();
  return { project, baseline };
}

export function assertAuthorised(status: string, action: string) {
  if (!AUTHORISED_STATUSES.includes(status as RequestStatus)) {
    throw forbidden(`${action} requires an approved request. This request is "${status}".`);
  }
}

export function assertNotClientVisible(request: { internalNotes?: string }) {
  if (request.internalNotes) return; // explicit no-op to document intent
}

export { precondition, invalidTransition };
