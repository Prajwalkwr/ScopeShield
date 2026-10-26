import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef, acceptanceCriterionSchema } from './_types';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  IMMUTABLE SCOPE BASELINE VERSION
 * ═══════════════════════════════════════════════════════════════════════════════
 * An approved version is never edited. It is superseded by a new version that records
 * its parent and the change request that caused it. `snapshotHash` (SHA-256 over the
 * canonical JSON of `snapshot`) lets anyone verify, later, that the text being quoted
 * is byte-for-byte the text that was approved.
 *
 * Requirements are EMBEDDED here rather than living in a separate collection, because:
 *   - immutability is the whole point (a snapshot that could be edited elsewhere is not a snapshot),
 *   - every read path is project-scoped, so a global requirements index buys nothing,
 *   - it removes any possibility of the snapshot and its "live" copy drifting apart.
 * The trade-off (no cross-project requirement queries) is accepted and documented.
 */

const requirementSchema = new Schema(
  {
    /** Stable identifier, e.g. REQ-001. Referenced by analyses, so it must never be reused. */
    key: { type: String, required: true, uppercase: true, trim: true, maxlength: 20 },
    kind: { type: String, enum: ['requirement', 'exclusion'], required: true },
    title: { type: String, required: true, maxlength: 300 },
    description: { type: String, default: '', maxlength: 4000 },
    /** functional | non_functional | content | design | technical | legal */
    category: { type: String, default: 'functional', maxlength: 40 },
    priority: { type: String, enum: ['must', 'should', 'could', 'wont'], default: 'must' },
    acceptanceCriteria: { type: [acceptanceCriterionSchema], default: [] },
    /** Deliverable this belongs to, used for revision allowances. */
    deliverable: { type: String, default: '', maxlength: 160 },
    estimatedHours: { type: Number, default: 0, min: 0 },
    /** Keys of other requirements in this version. Embedded, not a separate collection. */
    dependsOn: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    /** true when the wording is subjective and cannot be objectively verified. */
    ambiguous: { type: Boolean, default: false },
  },
  { _id: true },
);

const milestoneSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 200 },
    dueDate: { type: Date, default: null },
    amountMinor: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'in_progress', 'done', 'missed'], default: 'pending' },
  },
  { _id: true },
);

const snapshotSchema = new Schema(
  {
    objectives: { type: [String], default: [] },
    requirements: { type: [requirementSchema], default: [] },
    assumptions: { type: [String], default: [] },
    dependencies: { type: [String], default: [] },
    clientResponsibilities: { type: [String], default: [] },
    supportBoundaries: { type: [String], default: [] },
    milestones: { type: [milestoneSchema], default: [] },
    budget: {
      amountMinor: { type: Number, default: 0 },
      currency: { type: String, default: 'USD' },
      estimatedHours: { type: Number, default: 0 },
    },
  },
  { _id: false },
);

const baselineVersionSchema = new Schema(
  {
    org: orgRef,
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    /** Monotonic per project, starting at 1. */
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['draft', 'approved', 'superseded'], default: 'draft', index: true },
    parent: { type: Schema.Types.ObjectId, ref: 'BaselineVersion', default: null },
    /** The approved change request that produced this version, when applicable. */
    changeRequest: { type: Schema.Types.ObjectId, ref: 'ChangeRequest', default: null },
    reason: { type: String, default: '', maxlength: 2000 },
    label: { type: String, default: '', maxlength: 200 },

    snapshot: { type: snapshotSchema, required: true },
    /** SHA-256 over canonicalJson(snapshot) at approval time. */
    snapshotHash: { type: String, default: '', index: true },

    approvedBy: userRef,
    approvedAt: { type: Date, default: null },
    /** Provenance: how the snapshot was produced. */
    source: {
      type: { type: String, enum: ['manual', 'document_import', 'change_order', 'api'], default: 'manual' },
      document: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
      importedAt: { type: Date, default: null },
    },
    /** Evidence for the approval: who approved, on what basis. */
    approvalEvidence: {
      method: { type: String, enum: ['internal', 'client_change_order', 'external_document', 'migration'], default: 'internal' },
      actorName: { type: String, default: '' },
      actorEmail: { type: String, default: '' },
      note: { type: String, default: '', maxlength: 2000 },
      document: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    },
    /** Diff against the parent version, computed at creation for display. */
    diff: {
      addedRequirements: { type: [String], default: [] },
      removedRequirements: { type: [String], default: [] },
      modifiedRequirements: { type: [String], default: [] },
      addedExclusions: { type: [String], default: [] },
      removedExclusions: { type: [String], default: [] },
    },
    createdBy: { ...userRef, required: true },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'baseline_versions' },
);

baselineVersionSchema.index({ project: 1, version: 1 }, { unique: true });
baselineVersionSchema.index({ org: 1, status: 1 });
// One draft at a time per project: prevents two people editing different drafts unknowingly.
baselineVersionSchema.index(
  { project: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'draft' } },
);

export type BaselineVersionDoc = InferSchemaType<typeof baselineVersionSchema>;
export const BaselineVersion = model('BaselineVersion', baselineVersionSchema);
