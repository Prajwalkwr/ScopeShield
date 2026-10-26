import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef } from './_types';

/** Per-call AI usage and cost, so an administrator can see spend before the invoice arrives. */
const aiUsageSchema = new Schema(
  {
    org: orgRef,
    user: userRef,
    feature: { type: String, enum: ['scope_analysis', 'requirement_drafting', 'communication_draft', 'document_extraction'], required: true },
    provider: { type: String, required: true },
    model: { type: String, default: '' },
    /** Which record the call related to, for traceability. */
    relatedTo: {
      type: { type: String, default: '' },
      id: { type: Schema.Types.ObjectId, default: null },
    },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    outcome: { type: String, enum: ['success', 'invalid_output', 'error', 'timeout', 'budget_exceeded'], required: true },
    errorCode: { type: String, default: '' },
    /** Character count actually transmitted, for data-minimisation auditing. */
    inputChars: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'ai_usage' },
);

aiUsageSchema.index({ org: 1, createdAt: -1 });
aiUsageSchema.index({ org: 1, feature: 1, createdAt: -1 });

export type AiUsageDoc = InferSchemaType<typeof aiUsageSchema>;
export const AiUsage = model('AiUsage', aiUsageSchema);
