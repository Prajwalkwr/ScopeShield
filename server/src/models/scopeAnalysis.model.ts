import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef, evidenceRefSchema } from './_types';
import { CATEGORY_META } from '../domain/classification';

/**
 * Append-only record of every scope analysis. Analyses are EVIDENCE: they are never
 * updated in place, so a reviewer can see exactly what the system said, when, under
 * which engine version and which model, and what a human later changed.
 */
const scopeAnalysisSchema = new Schema(
  {
    org: orgRef,
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    request: { type: Schema.Types.ObjectId, ref: 'ChangeRequest', required: true, index: true },
    /** The immutable baseline version this analysis was performed against. */
    baselineVersion: { type: Schema.Types.ObjectId, ref: 'BaselineVersion', default: null },

    /** 'deterministic' = rules only; 'hybrid' = rules + model; 'fallback' = AI attempted and failed. */
    mode: { type: String, enum: ['deterministic', 'hybrid', 'fallback'], required: true, index: true },
    engineVersion: { type: String, required: true },

    category: { type: String, enum: Object.keys(CATEGORY_META), required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    confidenceBand: { type: String, enum: ['low', 'medium', 'high'], required: true },
    confidenceFactors: { type: [Schema.Types.Mixed], default: [] },
    checks: { type: [Schema.Types.Mixed], default: [] },
    evidence: { type: [evidenceRefSchema], default: [] },
    missingInformation: { type: [String], default: [] },
    suggestedQuestions: { type: [String], default: [] },
    detectedConcepts: { type: [String], default: [] },
    impactHints: { type: [Schema.Types.Mixed], default: [] },
    nearestRequirements: { type: [Schema.Types.Mixed], default: [] },
    reviewerSummary: { type: String, default: '' },
    assumptions: { type: [String], default: [] },
    injectionSuspected: { type: Boolean, default: false },
    /** Hash of the exact input text, so identical re-runs are detectable. */
    inputHash: { type: String, required: true, index: true },

    ai: {
      provider: { type: String, default: 'none' },
      model: { type: String, default: '' },
      attempted: { type: Boolean, default: false },
      succeeded: { type: Boolean, default: false },
      /** Model output BEFORE our validation. Kept for audit and debugging. */
      rawOutput: { type: String, default: '', select: false },
      /** Citations the model produced that did NOT exist in the baseline and were dropped. */
      droppedCitations: { type: [String], default: [] },
      degraded: { type: Boolean, default: false },
      degradeReason: { type: String, default: '' },
      latencyMs: { type: Number, default: 0 },
      promptTokens: { type: Number, default: 0 },
      completionTokens: { type: Number, default: 0 },
      costUsd: { type: Number, default: 0 },
      /** AI may only ADD nuance; the engine's category stands unless a human overrides. */
      suggestedCategory: { type: String, default: '' },
      suggestedQuestionAdditions: { type: [String], default: [] },
    },

    createdBy: userRef,
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'scope_analyses' },
);

scopeAnalysisSchema.index({ request: 1, createdAt: -1 });
scopeAnalysisSchema.index({ org: 1, createdAt: -1 });

export type ScopeAnalysisDoc = InferSchemaType<typeof scopeAnalysisSchema>;
export const ScopeAnalysis = model('ScopeAnalysis', scopeAnalysisSchema);
