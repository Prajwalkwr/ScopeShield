/**
 * Change-request lifecycle state machine.
 *
 * Transitions are explicit and guarded. Illegal transitions are rejected server-side
 * with a reason — the UI never offers a button the server would refuse.
 */

export const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'clarification_required',
  'classified',
  'estimating',
  'internal_review',
  'awaiting_client_decision',
  'approved',
  'rejected',
  'deferred',
  'scheduled',
  'in_progress',
  'completed',
  'closed',
  'cancelled',
  'superseded',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const STATUS_LABELS: Record<RequestStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  clarification_required: 'Clarification required',
  classified: 'Classified',
  estimating: 'Estimating',
  internal_review: 'Internal review',
  awaiting_client_decision: 'Awaiting client decision',
  approved: 'Approved',
  rejected: 'Rejected',
  deferred: 'Deferred',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  closed: 'Closed',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
};

export type Tone = 'neutral' | 'positive' | 'warning' | 'critical' | 'info';
export const STATUS_TONE: Record<RequestStatus, Tone> = {
  draft: 'neutral',
  submitted: 'info',
  under_review: 'info',
  clarification_required: 'warning',
  classified: 'info',
  estimating: 'info',
  internal_review: 'info',
  awaiting_client_decision: 'warning',
  approved: 'positive',
  rejected: 'critical',
  deferred: 'neutral',
  scheduled: 'positive',
  in_progress: 'positive',
  completed: 'positive',
  closed: 'neutral',
  cancelled: 'neutral',
  superseded: 'neutral',
};

/** Context the guards need in order to allow or refuse a transition. */
export interface TransitionContext {
  actorKind: 'member' | 'client' | 'system';
  /** Permission check already performed by middleware; this is the business precondition. */
  hasFinalEstimate: boolean;
  hasClassification: boolean;
  /** Customer-facing change order exists and has been sent. */
  changeOrderSent: boolean;
  /** An accepted approval decision exists for the CURRENT change-order version. */
  hasAcceptedDecision: boolean;
  /** A rejected decision exists for the current version. */
  hasRejectedDecision: boolean;
  /** Outstanding questions to the client. */
  awaitingClarification: boolean;
  /** Legal-ish precondition: baseline promotion happened for this request (if required). */
  baselineUpdatedOrNotRequired: boolean;
  /** Any recorded decision at all for the current version. */
  hasAnyDecision: boolean;
  /** Reason supplied for an exceptional transition. */
  reason?: string;
}

export interface Transition {
  from: RequestStatus;
  to: RequestStatus;
  label: string;
  /** Permission required (checked by middleware, mirrored here for documentation/UI). */
  permission: string;
  /** Guard evaluated by the service layer. Returns an error message or null when allowed. */
  guard?: (ctx: TransitionContext) => string | null;
  /** True when the agency should supply a written reason. */
  requiresReason?: boolean;
}

const TRANSITIONS: Transition[] = [
  { from: 'draft', to: 'submitted', label: 'Submit for review', permission: 'request.update' },
  { from: 'draft', to: 'cancelled', label: 'Discard', permission: 'request.cancel' },

  { from: 'submitted', to: 'under_review', label: 'Start review', permission: 'request.review' },
  { from: 'submitted', to: 'cancelled', label: 'Cancel', permission: 'request.cancel', requiresReason: true },

  {
    from: 'under_review',
    to: 'classified',
    label: 'Record classification',
    permission: 'request.review',
    guard: (ctx) => (ctx.hasClassification ? null : 'Run or record a scope analysis before classifying.'),
  },
  {
    from: 'under_review',
    to: 'clarification_required',
    label: 'Ask the client for clarification',
    permission: 'request.review',
  },
  { from: 'under_review', to: 'classified', label: 'Classify', permission: 'request.review' },
  { from: 'under_review', to: 'cancelled', label: 'Cancel', permission: 'request.cancel', requiresReason: true },

  {
    from: 'clarification_required',
    to: 'under_review',
    label: 'Clarification received',
    permission: 'request.review',
    guard: (ctx) => (ctx.awaitingClarification ? 'Mark the outstanding questions as answered first.' : null),
  },

  { from: 'classified', to: 'estimating', label: 'Start estimating', permission: 'estimate.create' },
  {
    from: 'classified',
    to: 'closed',
    label: 'Close as no action needed',
    permission: 'request.review',
    requiresReason: true,
    guard: (ctx) =>
      ctx.hasFinalEstimate ? 'This request has an estimate; route it through internal review instead of closing.' : null,
  },
  {
    from: 'classified',
    to: 'rejected',
    label: 'Reject internally',
    permission: 'request.review',
    requiresReason: true,
  },
  { from: 'classified', to: 'deferred', label: 'Defer to a later phase', permission: 'request.review' },

  {
    from: 'estimating',
    to: 'internal_review',
    label: 'Send to internal review',
    permission: 'request.review',
    guard: (ctx) => (ctx.hasFinalEstimate ? null : 'A finalised estimate is required before internal review.'),
  },
  { from: 'estimating', to: 'clarification_required', label: 'Need clarification to estimate', permission: 'request.review' },
  { from: 'estimating', to: 'deferred', label: 'Defer', permission: 'request.review' },

  {
    from: 'internal_review',
    to: 'awaiting_client_decision',
    label: 'Send change order to client',
    permission: 'change_order.send',
    guard: (ctx) => {
      if (!ctx.hasFinalEstimate) return 'A finalised estimate is required before contacting the client.';
      if (!ctx.changeOrderSent) return 'Generate and send a change order before awaiting a client decision.';
      return null;
    },
  },
  { from: 'internal_review', to: 'estimating', label: 'Return to estimating', permission: 'estimate.create' },
  { from: 'internal_review', to: 'rejected', label: 'Reject internally', permission: 'request.review', requiresReason: true },
  { from: 'internal_review', to: 'deferred', label: 'Defer', permission: 'request.review' },

  {
    from: 'awaiting_client_decision',
    to: 'approved',
    label: 'Client accepted',
    permission: 'request.review',
    guard: (ctx) => (ctx.hasAcceptedDecision ? null : 'No acceptance has been recorded for the current proposal version.'),
  },
  {
    from: 'awaiting_client_decision',
    to: 'rejected',
    label: 'Client declined',
    permission: 'request.review',
    guard: (ctx) => (ctx.hasRejectedDecision ? null : 'No decline has been recorded for the current proposal version.'),
  },
  {
    from: 'awaiting_client_decision',
    to: 'clarification_required',
    label: 'Client asked for clarification',
    permission: 'request.review',
    guard: (ctx) => (ctx.hasAnyDecision ? null : 'No client response has been recorded yet.'),
  },
  { from: 'awaiting_client_decision', to: 'deferred', label: 'Defer', permission: 'request.review' },

  {
    from: 'approved',
    to: 'scheduled',
    label: 'Schedule the work',
    permission: 'request.review',
    guard: (ctx) =>
      ctx.baselineUpdatedOrNotRequired
        ? null
        : 'Promote the approved change into a new baseline version before scheduling, so the agreed scope stays traceable.',
  },
  { from: 'approved', to: 'in_progress', label: 'Start work', permission: 'request.review' },

  { from: 'scheduled', to: 'in_progress', label: 'Start work', permission: 'request.review' },
  { from: 'scheduled', to: 'cancelled', label: 'Cancel', permission: 'request.cancel', requiresReason: true },

  { from: 'in_progress', to: 'completed', label: 'Mark complete', permission: 'request.update' },
  { from: 'in_progress', to: 'cancelled', label: 'Cancel', permission: 'request.cancel', requiresReason: true },

  { from: 'completed', to: 'closed', label: 'Close', permission: 'request.review' },
  { from: 'completed', to: 'in_progress', label: 'Reopen (rework)', permission: 'request.review', requiresReason: true },

  // Deferred work can always be picked back up.
  { from: 'deferred', to: 'under_review', label: 'Reopen for review', permission: 'request.review' },
  { from: 'deferred', to: 'cancelled', label: 'Cancel', permission: 'request.cancel', requiresReason: true },

  // A rejected request can be superseded by a NEW request — never silently approved.
  { from: 'rejected', to: 'superseded', label: 'Superseded by a new request', permission: 'request.review', requiresReason: true },
];

const KEY = (from: RequestStatus, to: RequestStatus) => `${from}->${to}`;
const TRANSITION_MAP = new Map<string, Transition>(TRANSITIONS.map((t) => [KEY(t.from, t.to), t]));

export const TERMINAL_STATUSES: RequestStatus[] = ['closed', 'cancelled', 'superseded'];

export function transitionsFrom(status: RequestStatus): Transition[] {
  return TRANSITIONS.filter((t) => t.from === status);
}

export interface TransitionCheck {
  allowed: boolean;
  /** Present when allowed === false. */
  reason?: string;
  transition?: Transition;
  requiresReason: boolean;
}

/**
 * Validate a transition. Order of evaluation matters and is intentional:
 *   1. does the transition exist at all?
 *   2. is a written reason required and missing?
 *   3. do the business preconditions hold?
 */
export function canTransition(
  from: RequestStatus,
  to: RequestStatus,
  ctx: TransitionContext,
): TransitionCheck {
  const transition = TRANSITION_MAP.get(KEY(from, to));
  if (!transition) {
    return {
      allowed: false,
      reason: `"${STATUS_LABELS[from]}" cannot move directly to "${STATUS_LABELS[to]}".`,
      requiresReason: false,
    };
  }
  if (transition.requiresReason && !(ctx.reason && ctx.reason.trim().length >= 8)) {
    return {
      allowed: false,
      reason: 'This transition requires a written reason of at least 8 characters for the audit record.',
      transition,
      requiresReason: true,
    };
  }
  if (transition.guard) {
    const failure = transition.guard(ctx);
    if (failure) return { allowed: false, reason: failure, transition, requiresReason: Boolean(transition.requiresReason) };
  }
  return { allowed: true, transition, requiresReason: Boolean(transition.requiresReason) };
}

/** Statuses in which logged time counts as "unapproved work" when no decision exists. */
export const AWAITING_DECISION_STATUSES: RequestStatus[] = [
  'submitted', 'under_review', 'clarification_required', 'classified', 'estimating', 'internal_review', 'awaiting_client_decision',
];

/** Statuses that authorise implementation work. */
export const AUTHORISED_STATUSES: RequestStatus[] = ['approved', 'scheduled', 'in_progress', 'completed', 'closed'];
