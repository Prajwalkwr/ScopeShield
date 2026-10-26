import { Schema, model, type InferSchemaType } from 'mongoose';
import { orgRef, userRef } from './_types';

const notificationSchema = new Schema(
  {
    org: orgRef,
    user: { ...userRef, required: true, index: true },
    type: {
      type: String,
      enum: [
        'request_assigned',
        'analysis_ready',
        'estimate_needed',
        'internal_review_requested',
        'client_decision_recorded',
        'clarification_received',
        'token_expiring',
        'unapproved_work_warning',
        'invitation_accepted',
        'baseline_approved',
      ],
      required: true,
    },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, default: '', maxlength: 1000 },
    /** In-app deep link. */
    link: { type: String, default: '', maxlength: 400 },
    readAt: { type: Date, default: null, index: true },
    emailSentAt: { type: Date, default: null },
    meta: { type: Schema.Types.Mixed, default: {} },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'notifications' },
);

notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });

export type NotificationDoc = InferSchemaType<typeof notificationSchema>;
export const Notification = model('Notification', notificationSchema);
