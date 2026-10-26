import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef, moneySubSchema } from './_types';
import { EFFORT_CATEGORIES } from '../domain/lexicon';

/**
 * Every estimate is a new immutable version. Nothing is overwritten, because
 * "what did we quote, and when" is precisely the question that appears in disputes.
 * Internal cost and client-facing price are separate fields and never derived from
 * one another: an agency's labour cost is not its billing rate.
 */
const effortEstimateSchema = new Schema(
  {
    org: orgRef,
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    request: { type: Schema.Types.ObjectId, ref: 'ChangeRequest', required: true, index: true },
    version: { type: Number, required: true, min: 1 },

    /** Hours per category. Missing categories mean zero. */
    hours: {
      type: new Schema(
        Object.fromEntries(EFFORT_CATEGORIES.map((c: string) => [c, { type: Number, default: 0, min: 0, max: 10000 }])),
        { _id: false },
      ),
      required: true,
    },
    totalHours: { type: Number, required: true, min: 0 },

    currency: { type: String, required: true, uppercase: true, maxlength: 3 },
    /** Client-facing billing rate per hour (major units). */
    billingRate: { type: Number, default: 0, min: 0 },
    /** Internal labour cost rate per hour (major units) — never shown to clients. */
    internalCostRate: { type: Number, default: 0, min: 0 },
    billingModel: { type: String, enum: ['fixed_price', 'hourly', 'daily', 'retainer'], default: 'fixed_price' },
    /** When set, replaces hours×rate for the client-facing subtotal. */
    fixedPrice: { type: Number, default: null },
    contingencyPct: { type: Number, default: 0, min: 0, max: 100 },
    discountPct: { type: Number, default: 0, min: 0, max: 100 },
    taxPct: { type: Number, default: 0, min: 0, max: 100 },

    /** Computed by domain/money.priceEstimate — stored so the client-facing document is reproducible. */
    pricing: {
      subtotal: moneySubSchema,
      contingency: moneySubSchema,
      discount: moneySubSchema,
      tax: moneySubSchema,
      total: moneySubSchema,
      effectiveHourlyRate: moneySubSchema,
      internalCostMinor: { type: Number, default: 0 },
    },

    schedule: {
      additionalHours: { type: Number, default: 0 },
      capacityPerDay: { type: Number, default: 0 },
      additionalWorkdays: { type: Number, default: 0 },
      projectedEndDate: { type: Date, default: null },
      slippageWorkdays: { type: Number, default: 0 },
      targetBreached: { type: Boolean, default: false },
      confidence: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
      assumptions: { type: [String], default: [] },
      warnings: { type: [String], default: [] },
      /** A human may override the projection, but must say why. */
      override: {
        applied: { type: Boolean, default: false },
        workdays: { type: Number, default: null },
        projectedEndDate: { type: Date, default: null },
        reason: { type: String, default: '', maxlength: 1000 },
        overriddenBy: userRef,
        overriddenAt: { type: Date, default: null },
      },
    },

    /** Where the hours came from, so a reviewer can see whether they trust them. */
    basis: {
      type: String,
      enum: ['manual', 'suggested_from_hints', 'copied_from_previous', 'template'],
      default: 'manual',
    },
    note: { type: String, default: '', maxlength: 2000 },
    author: { ...userRef, required: true },
    authorName: { type: String, default: '' },
    status: { type: String, enum: ['draft', 'final', 'superseded'], default: 'draft', index: true },
    finalisedAt: { type: Date, default: null },
    finalisedBy: userRef,
    supersededBy: { type: Schema.Types.ObjectId, ref: 'EffortEstimate', default: null },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'effort_estimates' },
);

effortEstimateSchema.index({ request: 1, version: 1 }, { unique: true });
effortEstimateSchema.index({ request: 1, status: 1 });
// Only one final estimate may exist per request.
effortEstimateSchema.index(
  { request: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'final' } },
);

export type EffortEstimateDoc = InferSchemaType<typeof effortEstimateSchema>;
export const EffortEstimate = model('EffortEstimate', effortEstimateSchema);
