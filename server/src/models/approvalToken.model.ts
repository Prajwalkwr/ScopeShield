import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef } from './_types';

/**
 * Secure client approval link.
 *
 * Properties that matter:
 *  - the raw token is never stored, only its SHA-256 hash;
 *  - it is bound to ONE change-order version + document hash, so it cannot be replayed
 *    against a later, different proposal;
 *  - it expires and can be revoked explicitly;
 *  - ACCESS IS NOT ACCEPTANCE: opening the link only records an access event.
 */
const approvalTokenSchema = new Schema(
  {
    org: orgRef,
    changeOrder: { type: Schema.Types.ObjectId, ref: 'ChangeOrder', required: true, index: true },
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    /** SHA-256 of the raw token. */
    tokenHash: { type: String, required: true, index: true },
    /** The exact proposal version this link may act upon. */
    boundVersion: { type: Number, required: true },
    boundDocumentHash: { type: String, required: true },

    recipientEmail: { type: String, required: true, lowercase: true },
    recipientName: { type: String, default: '' },
    createdBy: { ...userRef, required: true },

    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: '' },

    /** Usage accounting. Multiple reads are allowed (a client may open it twice); 
        the DECISION endpoint is the one protected by an idempotency key + single-use exchange. */
    accessCount: { type: Number, default: 0 },
    firstAccessedAt: { type: Date, default: null },
    lastAccessedAt: { type: Date, default: null },
    accessLog: {
      type: [
        new Schema(
          { at: { type: Date, default: () => new Date() }, ip: String, userAgent: String },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Set once a decision is recorded so the link can be shown as closed. */
    decisionRecordedAt: { type: Date, default: null },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'approval_tokens' },
);

approvalTokenSchema.index({ tokenHash: 1 }, { unique: true });
approvalTokenSchema.index({ changeOrder: 1, revokedAt: 1 });
approvalTokenSchema.index({ expiresAt: 1 });

export type ApprovalTokenDoc = InferSchemaType<typeof approvalTokenSchema>;
export const ApprovalToken = model('ApprovalToken', approvalTokenSchema);
