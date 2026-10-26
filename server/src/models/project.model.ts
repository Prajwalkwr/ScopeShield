import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef } from './_types';

/**
 * Revision policy and usage live inside the project document:
 *  - policies are per deliverable and few in number,
 *  - usage rows are the record of rounds consumed, which must be read together
 *    with the policy to decide whether a round is still covered.
 * Keeping them together removes an entire collection and any chance of them drifting apart.
 */
const revisionPolicySchema = new Schema(
  {
    deliverable: { type: String, required: true, maxlength: 160 },
    included: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false },
);

const revisionRoundSchema = new Schema(
  {
    deliverable: { type: String, required: true, maxlength: 160 },
    roundNumber: { type: Number, required: true, min: 1 },
    request: { type: Schema.Types.ObjectId, ref: 'ChangeRequest', default: null },
    note: { type: String, default: '', maxlength: 400 },
    recordedBy: userRef,
    recordedAt: { type: Date, default: () => new Date() },
  },
  { _id: true },
);

const projectSchema = new Schema(
  {
    org: orgRef,
    /** Human code, unique per organization, e.g. "EVR-001". */
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 24 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 6000 },
    client: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    manager: { ...userRef, required: true },
    members: { type: [Schema.Types.ObjectId], ref: 'Membership', default: [] },

    status: {
      type: String,
      enum: ['planning', 'active', 'on_hold', 'completed', 'archived'],
      default: 'planning',
      index: true,
    },
    contractType: {
      type: String,
      enum: ['fixed_price', 'hourly', 'daily', 'retainer'],
      default: 'fixed_price',
    },
    currency: { type: String, default: 'USD', uppercase: true, maxlength: 3 },
    /** Original agreed value in MINOR units (integer). */
    contractAmountMinor: { type: Number, default: 0, min: 0 },
    estimatedHours: { type: Number, default: 0, min: 0 },
    hourlyRate: { type: Number, default: 0, min: 0 },
    /** Internal labour cost per hour — deliberately separate from the client billing rate. */
    internalCostRate: { type: Number, default: 0, min: 0 },

    startDate: { type: Date, default: null },
    targetEndDate: { type: Date, default: null },

    workingDays: { type: [Number], default: [1, 2, 3, 4, 5] },
    holidays: { type: [String], default: [] },
    hoursPerPersonDay: { type: Number, default: 6, min: 1, max: 16 },

    revisionPolicies: { type: [revisionPolicySchema], default: [] },
    revisionRounds: { type: [revisionRoundSchema], default: [] },

    /** Current approved baseline version. Null until the first baseline is approved. */
    currentBaseline: { type: Schema.Types.ObjectId, ref: 'BaselineVersion', default: null },
    baselineVersionCount: { type: Number, default: 0 },

    /** Cached scope-health score; recomputed on demand and on major events. */
    healthScore: { type: Number, default: null },
    healthBand: { type: String, enum: ['healthy', 'watch', 'at_risk', 'critical', null], default: null },
    healthComputedAt: { type: Date, default: null },

    createdBy: userRef,
    archivedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'projects' },
);

projectSchema.index({ org: 1, code: 1 }, { unique: true });
projectSchema.index({ org: 1, status: 1, deletedAt: 1 });
projectSchema.index({ org: 1, client: 1 });
projectSchema.index({ org: 1, manager: 1 });

export type ProjectDoc = InferSchemaType<typeof projectSchema>;
export const Project = model('Project', projectSchema);
