import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef } from './_types';

const clientSchema = new Schema(
  {
    org: orgRef,
    name: { type: String, required: true, trim: true, maxlength: 160 },
    company: { type: String, default: '', maxlength: 160 },
    contactName: { type: String, default: '', maxlength: 120 },
    contactEmail: { type: String, default: '', lowercase: true, trim: true },
    contactPhone: { type: String, default: '', maxlength: 40 },
    address: { type: String, default: '', maxlength: 400 },
    /** Free-text notes are internal-only and never exposed on the client portal. */
    internalNotes: { type: String, default: '', maxlength: 4000 },
    currency: { type: String, default: '', uppercase: true, maxlength: 3 },
    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
    tags: { type: [String], default: [] },
    /** Approval history summary maintained by the approvals service (denormalised for lists). */
    approvals: {
      accepted: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
      clarificationRequested: { type: Number, default: 0 },
      lastDecisionAt: { type: Date, default: null },
      averageTurnaroundHours: { type: Number, default: null },
    },
    createdBy: userRef,
    deletedAt: { type: Date, default: null },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'clients' },
);

clientSchema.index({ org: 1, name: 1 });
clientSchema.index({ org: 1, status: 1, deletedAt: 1 });

export type ClientDoc = InferSchemaType<typeof clientSchema>;
export const Client = model('Client', clientSchema);
