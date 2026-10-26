import { Schema, model, type InferSchemaType } from 'mongoose';
import { userRef } from './_types';

/**
 * Refresh-token sessions with rotation and reuse detection.
 * Only hashes are stored: a database leak does not yield usable tokens.
 */
const sessionSchema = new Schema(
  {
    user: { ...userRef, required: true },
    /** SHA-256 of the refresh token currently valid for this session. */
    refreshTokenHash: { type: String, required: true, index: true },
    /** SHA-256 of the short-lived access token, so logout can revoke it immediately. */
    accessTokenHash: { type: String, default: '', index: true },
    /** Rotated on every refresh; a repeated value indicates token theft. */
    rotationCount: { type: Number, default: 0 },
    /** Hashes of previously issued refresh tokens for this session (reuse detection). */
    previousTokenHashes: { type: [String], default: [], select: false },
    /** Hash of the CSRF token issued with this session (double-submit cookie defence). */
    csrfTokenHash: { type: String, default: '', select: false },
    userAgent: { type: String, default: '', maxlength: 400 },
    ip: { type: String, default: '', maxlength: 60 },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, enum: ['logout', 'rotated', 'reuse_detected', 'password_change', 'admin', ''], default: '' },
    lastUsedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, collection: 'sessions' },
);

// Sessions expire; MongoDB removes them a little after expiry.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });
sessionSchema.index({ user: 1, revokedAt: 1 });

export type SessionDoc = InferSchemaType<typeof sessionSchema>;
export const Session = model('Session', sessionSchema);
