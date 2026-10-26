import { Schema, type Types } from 'mongoose';

export type ObjectIdLike = Types.ObjectId;

/** Tenant-scoping helper: every organization-owned document includes this field. */
export const orgRef = {
  type: Schema.Types.ObjectId,
  ref: 'Organization',
  required: true,
  index: true,
} as const;

export const userRef = { type: Schema.Types.ObjectId, ref: 'User' } as const;

export const moneySubSchema = new Schema(
  {
    amount: { type: Number, required: true }, // integer minor units
    currency: { type: String, required: true, uppercase: true, trim: true, maxlength: 3 },
  },
  { _id: false },
);

export const evidenceRefSchema = new Schema(
  {
    type: { type: String, enum: ['requirement', 'exclusion', 'request', 'change_order', 'policy', 'document', 'text'], required: true },
    ref: { type: String, required: true },
    excerpt: { type: String, required: true, maxlength: 600 },
    relation: { type: String, enum: ['supports', 'contradicts', 'related'], required: true },
  },
  { _id: false },
);

export const acceptanceCriterionSchema = new Schema(
  { id: { type: String, required: true }, text: { type: String, required: true, maxlength: 600 } },
  { _id: false },
);
