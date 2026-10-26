import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef } from './_types';
import { ROLES } from '../config/constants';

const invitationSchema = new Schema(
  {
    org: orgRef,
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ROLES, required: true },
    /** Only the hash is stored; the raw token exists only in the email link. */
    tokenHash: { type: String, required: true, index: true, select: false },
    invitedBy: { ...userRef, required: true },
    status: { type: String, enum: ['pending', 'accepted', 'revoked', 'expired'], default: 'pending', index: true },
    expiresAt: { type: Date, required: true, index: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: userRef,
    resendCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'invitations' },
);

// One live invitation per email per organization.
invitationSchema.index({ org: 1, email: 1, status: 1 });

export type InvitationDoc = InferSchemaType<typeof invitationSchema>;
export const Invitation = model('Invitation', invitationSchema);
