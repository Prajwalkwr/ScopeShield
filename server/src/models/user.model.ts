import { Schema, model, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** scrypt$N$r$p$keylen$salt$hash — never a plaintext password, never logged. */
    passwordHash: { type: String, required: true, select: false },
    passwordChangedAt: { type: Date, default: null },
    status: { type: String, enum: ['active', 'suspended', 'deactivated'], default: 'active', index: true },
    emailVerifiedAt: { type: Date, default: null },
    timezone: { type: String, default: 'UTC' },
    jobTitle: { type: String, default: '', maxlength: 120 },
    avatarColor: { type: String, default: '#4f46e5' },
    notificationPrefs: {
      emailOnAssignment: { type: Boolean, default: true },
      emailOnDecision: { type: Boolean, default: true },
      emailOnMention: { type: Boolean, default: true },
    },
    lastLoginAt: { type: Date, default: null },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    /** Set when the account is created by an invitation rather than self-registration. */
    invitedByMembership: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    /** Password reset: only the hash is stored, and it is single-use with a short expiry. */
    passwordResetTokenHash: { type: String, default: '', select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },
    passwordResetRequestedAt: { type: Date, default: null },
    /** Email verification, when the deployment has a working mail driver. */
    emailVerificationTokenHash: { type: String, default: '', select: false },
    emailVerificationExpiresAt: { type: Date, default: null, select: false },
    /** Demo accounts are flagged so production guards can refuse to treat them as real users. */
    isDemo: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, collection: 'users' },
);

// Case-insensitive uniqueness without a collation dependency.
userSchema.index({ email: 1 }, { unique: true });

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);
