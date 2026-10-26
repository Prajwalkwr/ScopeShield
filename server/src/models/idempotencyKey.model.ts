import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef } from './_types';

/**
 * Idempotency for consequential POSTs (recording a client decision, sending a change order,
 * promoting a baseline). A repeated request with the same key returns the SAME stored
 * response instead of performing the action twice — this is what makes double-submission
 * and retry-after-timeout safe.
 */
const idempotencyKeySchema = new Schema(
  {
    org: orgRef,
    /** Scoped by scope string so keys cannot collide across different operations. */
    scope: { type: String, required: true, maxlength: 120 },
    key: { type: String, required: true, maxlength: 200 },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
    responseStatus: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'idempotency_keys' },
);

idempotencyKeySchema.index({ org: 1, scope: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type IdempotencyKeyDoc = InferSchemaType<typeof idempotencyKeySchema>;
export const IdempotencyKey = model('IdempotencyKey', idempotencyKeySchema);
