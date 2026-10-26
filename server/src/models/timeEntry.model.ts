import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef } from './_types';
import { EFFORT_CATEGORIES } from '../domain/lexicon';

const timeEntrySchema = new Schema(
  {
    org: orgRef,
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    /** Optional: an entry may be general project work, not tied to a change request. */
    request: { type: Schema.Types.ObjectId, ref: 'ChangeRequest', default: null, index: true },
    user: { ...userRef, required: true },
    date: { type: Date, required: true, index: true },
    hours: { type: Number, required: true, min: 0.1, max: 24 },
    category: { type: String, enum: EFFORT_CATEGORIES, default: 'other' },
    billable: { type: Boolean, default: true },
    note: { type: String, default: '', maxlength: 1000 },
    /** Copied from the request at entry time so historical reports stay truthful. */
    approvedAtEntry: { type: Boolean, default: false },
    /** True when this hour was logged against a request that had no recorded approval. */
    loggedWithoutApproval: { type: Boolean, default: false, index: true },
    createdBy: userRef,
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'time_entries' },
);

timeEntrySchema.index({ org: 1, project: 1, date: -1 });
timeEntrySchema.index({ org: 1, user: 1, date: -1 });
timeEntrySchema.index({ org: 1, loggedWithoutApproval: 1, date: -1 });

export type TimeEntryDoc = InferSchemaType<typeof timeEntrySchema>;
export const TimeEntry = model('TimeEntry', timeEntrySchema);
