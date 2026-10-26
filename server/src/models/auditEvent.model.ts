import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef } from './_types';

/**
 * Append-only audit history with a per-organization hash chain.
 *
 * Each event stores `prevHash` (the hash of the previous event in this org) and its own
 * `hash` over (prevHash + canonical payload). Deleting or editing a row breaks the chain,
 * which is detectable by re-walking it. Application code has no update or delete path.
 *
 * Secrets, passwords and tokens are never written here — `before`/`after` are reduced to
 * changed-field summaries by the audit service.
 */
const auditEventSchema = new Schema(
  {
    org: orgRef,
    /** Monotonic per organization, assigned atomically. */
    seq: { type: Number, required: true },
    action: { type: String, required: true, index: true },
    actor: {
      kind: { type: String, enum: ['user', 'client', 'system'], required: true },
      user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      name: { type: String, default: '', maxlength: 160 },
      email: { type: String, default: '', maxlength: 200 },
    },
    entity: {
      type: { type: String, required: true },
      id: { type: Schema.Types.ObjectId, default: null },
      label: { type: String, default: '', maxlength: 300 },
    },
    /** Field-level summary of what changed — never raw document dumps. */
    changes: { type: [new Schema({ field: String, from: String, to: String }, { _id: false })], default: [] },
    /** Structured, non-sensitive context (counts, ids, versions, reasons). */
    meta: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String, default: '', maxlength: 60 },
    userAgent: { type: String, default: '', maxlength: 400 },
    /** Tamper-evidence chain. */
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_events' },
);

auditEventSchema.index({ org: 1, seq: 1 }, { unique: true });
auditEventSchema.index({ org: 1, createdAt: -1 });
auditEventSchema.index({ org: 1, 'entity.type': 1, 'entity.id': 1, createdAt: -1 });
auditEventSchema.index({ org: 1, action: 1, createdAt: -1 });

export type AuditEventDoc = InferSchemaType<typeof auditEventSchema>;
export const AuditEvent = model('AuditEvent', auditEventSchema);
