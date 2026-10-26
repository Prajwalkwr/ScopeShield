import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef, evidenceRefSchema, moneySubSchema } from './_types';
import { REQUEST_STATUSES } from '../domain/stateMachine';
import { CATEGORY_META } from '../domain/classification';

const CATEGORIES = Object.keys(CATEGORY_META);

/** Evidence supplied with a request: what the client actually said, and where. */
const requestEvidenceSchema = new Schema(
  {
    kind: { type: String, enum: ['email', 'message', 'meeting_note', 'call_note', 'document', 'screenshot', 'other'], required: true },
    /** Where it came from (subject line, channel name, meeting title). */
    source: { type: String, default: '', maxlength: 300 },
    occurredAt: { type: Date, default: null },
    /** Verbatim quote. The system never paraphrases client evidence. */
    quote: { type: String, default: '', maxlength: 8000 },
    document: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    addedBy: userRef,
    addedAt: { type: Date, default: () => new Date() },
    /** Consent flag: evidence must have been shared with the agency legitimately. */
    consentAttested: { type: Boolean, default: false },
  },
  { _id: true },
);

const changeRequestSchema = new Schema(
  {
    org: orgRef,
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    /** Human reference unique per organization, e.g. CR-2026-0007. */
    ref: { type: String, required: true, uppercase: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },

    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, required: true, maxlength: 12000 },
    /** Who asked. Either an org user, a known client contact, or a free-text requester. */
    requester: {
      name: { type: String, required: true, maxlength: 160 },
      email: { type: String, default: '', lowercase: true },
      user: userRef,
      client: { type: Schema.Types.ObjectId, ref: 'Client', default: null },
    },
    source: {
      type: String,
      enum: ['client_portal', 'email', 'meeting', 'chat', 'call', 'internal', 'document'],
      default: 'email',
    },
    sourceDetail: { type: String, default: '', maxlength: 600 },
    desiredBy: { type: Date, default: null },
    businessReason: { type: String, default: '', maxlength: 2000 },
    affectedDeliverables: { type: [String], default: [] },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal', index: true },

    status: { type: String, enum: REQUEST_STATUSES, default: 'draft', index: true },
    /** Latest classification. Corrections are recorded in `classificationHistory`, not lost. */
    classification: { type: String, enum: CATEGORIES, default: null, index: true },
    classificationConfidence: { type: Number, default: null },
    /** The analysis this classification came from, if any. */
    classificationAnalysis: { type: Schema.Types.ObjectId, ref: 'ScopeAnalysis', default: null },
    classificationHistory: {
      type: [
        new Schema(
          {
            category: { type: String, enum: CATEGORIES, required: true },
            previousCategory: { type: String, enum: CATEGORIES, default: null },
            source: { type: String, enum: ['engine', 'ai', 'human'], required: true },
            reason: { type: String, default: '', maxlength: 2000 },
            actor: userRef,
            actorName: { type: String, default: '' },
            at: { type: Date, default: () => new Date() },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    evidence: { type: [requestEvidenceSchema], default: [] },

    assignedReviewer: userRef,
    /** Outstanding questions sent to the requester. */
    clarifications: {
      type: [
        new Schema(
          {
            questions: { type: [String], default: [] },
            askedAt: { type: Date, default: () => new Date() },
            askedBy: userRef,
            answer: { type: String, default: '', maxlength: 8000 },
            answeredAt: { type: Date, default: null },
            answeredBy: { type: String, default: '' },
          },
          { _id: true },
        ),
      ],
      default: [],
    },

    /** Effort estimates are versioned in their own collection; these cache the final one. */
    finalEstimate: { type: Schema.Types.ObjectId, ref: 'EffortEstimate', default: null },
    /** Current customer-facing proposal. */
    activeChangeOrder: { type: Schema.Types.ObjectId, ref: 'ChangeOrder', default: null },
    /** Trade-off option the agency chose to present. */
    chosenOption: {
      type: String,
      enum: ['add_with_fee', 'add_with_time', 'substitute', 'defer', 'goodwill', 'reject', 'clarify', null],
      default: null,
    },

    /** Outcome summary (denormalised for dashboards; decisions remain the source of truth). */
    outcome: {
      decidedAt: { type: Date, default: null },
      decision: { type: String, enum: ['accepted', 'rejected', 'clarification_requested', null], default: null },
      decidedBy: { type: String, default: '' },
      additionalValueMinor: { type: Number, default: 0 },
      currency: { type: String, default: 'USD' },
      scheduleImpactWorkdays: { type: Number, default: 0 },
      baselineUpdatedTo: { type: Schema.Types.ObjectId, ref: 'BaselineVersion', default: null },
      /** Work logged against this request while it had no approval (unbilled-risk indicator). */
      unapprovedHours: { type: Number, default: 0 },
    },

    /** Aggregate of approved effort vs actual, refreshed when time entries change. */
    effort: {
      estimatedHours: { type: Number, default: 0 },
      actualHours: { type: Number, default: 0 },
    },

    internalNotes: { type: String, default: '', maxlength: 8000 },
    /** Set when a request is superseded by another request (never silently deleted). */
    supersededBy: { type: Schema.Types.ObjectId, ref: 'ChangeRequest', default: null },
    cancelledReason: { type: String, default: '', maxlength: 1000 },

    /** Monotonic counter used for optimistic concurrency on workflow updates. */
    revision: { type: Number, default: 0 },

    createdBy: { ...userRef, required: true },
    submittedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    /** Detected instruction-injection content is flagged for human attention. */
    flaggedForReview: { type: Boolean, default: false, index: true },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'change_requests' },
);

changeRequestSchema.index({ org: 1, ref: 1 }, { unique: true });
changeRequestSchema.index({ org: 1, sequence: 1 }, { unique: true });
changeRequestSchema.index({ org: 1, status: 1, createdAt: -1 });
changeRequestSchema.index({ project: 1, status: 1 });
changeRequestSchema.index({ org: 1, classification: 1 });
changeRequestSchema.index({ assignedReviewer: 1, status: 1 });

/** Optimistic concurrency: updates must carry the revision the caller last read. */
changeRequestSchema.pre('save', function bumpRevision(next) {
  if (!this.isNew && this.isModified()) {
    const modified = this.modifiedPaths();
    // Workflow mutations bump the revision; pure read-bookkeeping fields do not.
    const hasWorkflowChange = modified.some(
      (p) => p.startsWith('status') || p.startsWith('classification') || p.startsWith('outcome') || p.startsWith('effort'),
    );
    if (hasWorkflowChange) this.revision = (this.revision ?? 0) + 1;
  }
  next();
});

export type ChangeRequestDoc = InferSchemaType<typeof changeRequestSchema>;
export const ChangeRequest = model('ChangeRequest', changeRequestSchema);
export { CATEGORIES as CHANGE_REQUEST_CATEGORIES };
export const _unusedEvidence = evidenceRefSchema;
export const _unusedMoney = moneySubSchema;
