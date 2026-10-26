import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef } from './_types';

/**
 * An append-only record of what a client decided, against which exact document version.
 * Rows are never updated; a later reversal is a NEW decision that supersedes the old one
 * (with a reason), so the history of the relationship stays intact.
 */
const approvalDecisionSchema = new Schema(
  {
    org: orgRef,
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    changeOrder: { type: Schema.Types.ObjectId, ref: 'ChangeOrder', required: true, index: true },
    request: { type: Schema.Types.ObjectId, ref: 'ChangeRequest', required: true, index: true },
    token: { type: Schema.Types.ObjectId, ref: 'ApprovalToken', required: true },

    decision: { type: String, enum: ['accepted', 'rejected', 'clarification_requested'], required: true, index: true },
    /** Stated identity of the person deciding. */
    decider: {
      name: { type: String, required: true, maxlength: 160 },
      email: { type: String, required: true, lowercase: true },
      role: { type: String, default: '', maxlength: 120 },
      /** Whether we could verify the email belongs to the invited recipient. */
      identityBasis: { type: String, enum: ['invited_recipient', 'unverified_declaration'], default: 'unverified_declaration' },
    },
    comment: { type: String, default: '', maxlength: 4000 },

    /** Binding: EXACTLY what was on screen when the decision was made. */
    documentVersion: { type: Number, required: true },
    documentHash: { type: String, required: true },
    /** Snapshot of the headline figures at decision time (amount, currency, dates). */
    agreedTerms: {
      totalMinor: { type: Number, default: 0 },
      currency: { type: String, default: 'USD' },
      revisedTargetDate: { type: Date, default: null },
      additionalWorkdays: { type: Number, default: 0 },
      option: { type: String, default: '' },
    },

    /** Request context, kept for the audit record. */
    ip: { type: String, default: '', maxlength: 60 },
    userAgent: { type: String, default: '', maxlength: 400 },
    /** Explicit acknowledgement that the click is a recorded decision, not legal advice. */
    acknowledgement: {
      acceptedTerms: { type: Boolean, default: false },
      typedName: { type: String, default: '' },
      disclaimerVersion: { type: String, default: 'v1' },
    },

    supersededBy: { type: Schema.Types.ObjectId, ref: 'ApprovalDecision', default: null },
    supersedeReason: { type: String, default: '', maxlength: 1000 },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'approval_decisions' },
);

approvalDecisionSchema.index({ changeOrder: 1, createdAt: -1 });
approvalDecisionSchema.index({ org: 1, decision: 1, createdAt: -1 });

export type ApprovalDecisionDoc = InferSchemaType<typeof approvalDecisionSchema>;
export const ApprovalDecision = model('ApprovalDecision', approvalDecisionSchema);
