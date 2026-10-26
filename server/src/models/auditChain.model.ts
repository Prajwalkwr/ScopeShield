import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef } from './_types';

/**
 * The head of each organization's audit hash chain. Updated atomically with $inc so that
 * concurrent writers cannot produce the same sequence number.
 */
const auditChainSchema = new Schema(
  {
    org: { ...orgRef, unique: true },
    lastSeq: { type: Number, default: 0, required: true },
    lastHash: { type: String, default: 'GENESIS', required: true },
  },
  { timestamps: true, collection: 'audit_chains' },
);

export type AuditChainDoc = InferSchemaType<typeof auditChainSchema>;
export const AuditChain = model('AuditChain', auditChainSchema);
