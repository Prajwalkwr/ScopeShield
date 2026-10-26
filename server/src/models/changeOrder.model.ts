import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef, moneySubSchema } from './_types';

/**
 * A change order is a VERSIONED, customer-facing proposal. Changing the price, scope or
 * schedule creates a new version and supersedes the previous one — which also invalidates
 * any outstanding approval link, so a client can never accept a document they did not read.
 */
const changeOrderSchema = new Schema(
  {
    org: orgRef,
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    request: { type: Schema.Types.ObjectId, ref: 'ChangeRequest', required: true, index: true },
    client: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    /** Human reference unique per organization, e.g. CO-0007. */
    number: { type: String, required: true, uppercase: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    version: { type: Number, required: true, min: 1 },

    status: {
      type: String,
      enum: ['draft', 'sent', 'accepted', 'rejected', 'clarification_requested', 'expired', 'superseded', 'cancelled'],
      default: 'draft',
      index: true,
    },
    /** Which trade-off option this document presents. */
    option: {
      type: String,
      enum: ['add_with_fee', 'add_with_time', 'substitute', 'defer', 'goodwill', 'reject', 'clarify'],
      required: true,
    },

    title: { type: String, required: true, maxlength: 300 },
    /** Client-facing description. Written by a human (with optional AI drafting assistance). */
    summary: { type: String, required: true, maxlength: 6000 },
    baselineVersion: { type: Schema.Types.ObjectId, ref: 'BaselineVersion', default: null },
    baselineVersionNumber: { type: Number, default: null },

    scopeAdditions: {
      type: [
        new Schema(
          {
            title: { type: String, required: true, maxlength: 300 },
            description: { type: String, default: '', maxlength: 3000 },
            acceptanceCriteria: { type: [String], default: [] },
            estimatedHours: { type: Number, default: 0 },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
    /** Requirements the client is giving up (substitution / deferral). */
    scopeRemovals: {
      type: [
        new Schema(
          {
            requirementKey: { type: String, default: '' },
            title: { type: String, default: '' },
            note: { type: String, default: '', maxlength: 1000 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Requirements the proposal refers back to, for traceability in the document. */
    relatedRequirements: {
      type: [new Schema({ key: String, title: String }, { _id: false })],
      default: [],
    },

    pricing: {
      currency: { type: String, required: true, uppercase: true, maxlength: 3 },
      subtotal: moneySubSchema,
      contingency: moneySubSchema,
      discount: moneySubSchema,
      tax: moneySubSchema,
      total: moneySubSchema,
      /** Present for 'add_with_fee'; zero for goodwill/substitution. */
      effectiveHourlyRate: moneySubSchema,
      notes: { type: String, default: '', maxlength: 2000 },
    },

    schedule: {
      additionalWorkdays: { type: Number, default: 0 },
      currentTargetDate: { type: Date, default: null },
      revisedTargetDate: { type: Date, default: null },
      milestones: { type: [new Schema({ name: String, oldDate: Date, newDate: Date }, { _id: false })], default: [] },
      assumptions: { type: [String], default: [] },
    },

    dependencies: { type: [String], default: [] },
    assumptions: { type: [String], default: [] },
    /** Agency-supplied terms; we never invent legal clauses. */
    termsText: { type: String, default: '', maxlength: 12000 },
    validUntil: { type: Date, default: null },

    /** Rendered PDF, stored privately and downloadable only by authorised parties. */
    pdfDocument: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    /** SHA-256 of the rendered PDF; a decision is bound to this exact document. */
    pdfHash: { type: String, default: '' },

    sentAt: { type: Date, default: null },
    sentBy: userRef,
    sentTo: { type: [String], default: [] },
    /** Hash of the current approval token; raw token exists only in the email link. */
    activeTokenHash: { type: String, default: '', select: false, index: true },

    decision: {
      outcome: { type: String, enum: ['accepted', 'rejected', 'clarification_requested', null], default: null },
      decidedAt: { type: Date, default: null },
      deciderName: { type: String, default: '' },
      deciderEmail: { type: String, default: '' },
      comment: { type: String, default: '', maxlength: 4000 },
      /** Version + hash the decision applies to. Prevents replay against a newer document. */
      documentVersion: { type: Number, default: null },
      documentHash: { type: String, default: '' },
      decisionId: { type: Schema.Types.ObjectId, ref: 'ApprovalDecision', default: null },
    },

    supersededBy: { type: Schema.Types.ObjectId, ref: 'ChangeOrder', default: null },
    createdBy: { ...userRef, required: true },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'change_orders' },
);

/**
 * Identity rules, stated explicitly because they are easy to get wrong:
 *  - a change ORDER (number) may have several document VERSIONS, so uniqueness is
 *    (org, number, version) — not (org, number);
 *  - sequence numbers are allocated per organization, one new order per sequence, and are
 *    shared by every version of that order;
 *  - within a request, a version number may only appear once. That is what stops a duplicate
 *    or replayed version from being inserted alongside the real one.
 */
changeOrderSchema.index({ org: 1, number: 1, version: 1 }, { unique: true });
changeOrderSchema.index({ org: 1, sequence: 1, version: 1 }, { unique: true });
changeOrderSchema.index({ request: 1, version: 1 }, { unique: true });
changeOrderSchema.index({ org: 1, status: 1, createdAt: -1 });
changeOrderSchema.index({ client: 1, createdAt: -1 });

export type ChangeOrderDoc = InferSchemaType<typeof changeOrderSchema>;
export const ChangeOrder = model('ChangeOrder', changeOrderSchema);
