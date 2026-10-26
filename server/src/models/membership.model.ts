import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef } from './_types';
import { ROLES } from '../config/constants';

const membershipSchema = new Schema(
  {
    org: orgRef,
    user: { ...userRef, required: true },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: ['active', 'suspended', 'removed'], default: 'active', index: true },
    invitedBy: userRef,
    joinedAt: { type: Date, default: () => new Date() },
    /**
     * Per-organization capability overrides. Bounded by resolvePermissions(), which
     * refuses to grant some capabilities (e.g. billing) through an override.
     */
    grants: { type: [String], default: [] },
    revokes: { type: [String], default: [] },
    /** Scope limiting: when non-empty, the member only sees these projects. Empty = all. */
    projectScope: { type: [Schema.Types.ObjectId], ref: 'Project', default: [] },
  },
  { timestamps: true, collection: 'memberships' },
);

membershipSchema.index({ org: 1, user: 1 }, { unique: true });
membershipSchema.index({ user: 1, status: 1 });

export type MembershipDoc = InferSchemaType<typeof membershipSchema>;
export const Membership = model('Membership', membershipSchema);
