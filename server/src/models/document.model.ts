import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef } from './_types';

const documentSchema = new Schema(
  {
    org: orgRef,
    project: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
    client: { type: Schema.Types.ObjectId, ref: 'Client', default: null },
    kind: {
      type: String,
      enum: ['proposal', 'statement_of_work', 'contract', 'change_order_pdf', 'request_evidence', 'requirement_source', 'other'],
      default: 'other',
      index: true,
    },
    /** Original client-supplied filename, stored for display only — never used as a path. */
    originalName: { type: String, required: true, maxlength: 300 },
    /** Generated storage key (never derived from user input). */
    storageKey: { type: String, required: true, unique: true },
    /** MIME type we determined ourselves from the bytes, not what the client claimed. */
    detectedMime: { type: String, required: true, maxlength: 160 },
    claimedMime: { type: String, default: '', maxlength: 160 },
    sizeBytes: { type: Number, required: true, min: 0 },
    sha256: { type: String, required: true, index: true },
    /** Extracted plain text, capped. Null until extraction has run. */
    extractedText: { type: String, default: null, select: false },
    extraction: {
      status: { type: String, enum: ['pending', 'done', 'failed', 'unsupported', 'skipped'], default: 'pending', index: true },
      method: { type: String, enum: ['pdf_text', 'docx_xml', 'plain_text', 'none'], default: 'none' },
      charCount: { type: Number, default: 0 },
      pageCount: { type: Number, default: null },
      error: { type: String, default: '' },
      attemptedAt: { type: Date, default: null },
      /** true when the file appears to be scanned imagery with no text layer. */
      needsOcr: { type: Boolean, default: false },
    },
    /** Pending AI/suggestion output awaiting human review before it becomes a baseline. */
    extractionReview: {
      candidateRequirements: { type: [Schema.Types.Mixed], default: [] },
      reviewedAt: { type: Date, default: null },
      reviewedBy: userRef,
      appliedToBaseline: { type: Schema.Types.ObjectId, ref: 'BaselineVersion', default: null },
      discarded: { type: Boolean, default: false },
    },
    linkedTo: {
      type: { type: String, enum: ['request', 'change_order', 'baseline', 'project', 'client', 'none'], default: 'none' },
      id: { type: Schema.Types.ObjectId, default: null },
    },
    uploadedBy: userRef,
    deletedAt: { type: Date, default: null },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'documents' },
);

documentSchema.index({ org: 1, project: 1, kind: 1, deletedAt: 1 });
documentSchema.index({ org: 1, createdAt: -1 });

export type DocumentDoc = InferSchemaType<typeof documentSchema>;
export const Document = model('Document', documentSchema);
