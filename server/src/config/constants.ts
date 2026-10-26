export const API_PREFIX = '/api/v1';

export const ROLES = ['owner', 'admin', 'pm', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  pm: 'Project manager',
  developer: 'Team member',
  viewer: 'Viewer (read-only)',
};

/** Client-side portal actors are NOT organization members. */
export const CLIENT_ACTOR = 'client' as const;

export const SESSION = {
  accessCookieName: 'ss_at',
  refreshCookieName: 'ss_rt',
  csrfCookieName: 'ss_csrf',
  csrfHeaderName: 'x-csrf-token',
  accessTtlSeconds: 60 * 30, // 30 minutes
  refreshTtlSeconds: 60 * 60 * 24 * 30, // 30 days
  cookiePath: '/',
} as const;

export const LIMITS = {
  maxUploadBytes: 15 * 1024 * 1024,
  allowedUploadMimes: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'image/png',
    'image/jpeg',
  ] as const,
  allowedUploadExts: ['.pdf', '.docx', '.txt', '.md', '.png', '.jpg', '.jpeg'] as const,
  /** JSON body ceiling. Change orders and baselines are text; anything larger is multipart. */
  maxJsonKb: 512,
  pageSizeDefault: 25,
  pageSizeMax: 100,
} as const;

export const AUDIT_ACTIONS = {
  orgCreated: 'organization.created',
  memberInvited: 'membership.invited',
  memberJoined: 'membership.joined',
  memberRoleChanged: 'membership.role_changed',
  memberRemoved: 'membership.removed',
  clientCreated: 'client.created',
  clientUpdated: 'client.updated',
  projectCreated: 'project.created',
  projectUpdated: 'project.updated',
  projectStatusChanged: 'project.status_changed',
  baselineCreated: 'baseline.created',
  baselineApproved: 'baseline.approved',
  baselineSuperseded: 'baseline.superseded',
  documentUploaded: 'document.uploaded',
  documentExtracted: 'document.extracted',
  requirementChanged: 'requirement.changed',
  requestCreated: 'request.created',
  requestStatusChanged: 'request.status_changed',
  requestClassified: 'request.classified',
  analysisGenerated: 'analysis.generated',
  estimateCreated: 'estimate.created',
  estimateFinalised: 'estimate.finalised',
  changeOrderGenerated: 'change_order.generated',
  changeOrderSent: 'change_order.sent',
  approvalTokenCreated: 'approval.token_created',
  approvalTokenRevoked: 'approval.token_revoked',
  approvalDecisionRecorded: 'approval.decision_recorded',
  approvalLinkAccessed: 'approval.link_accessed',
  overrideApplied: 'override.applied',
  timeEntryCreated: 'time_entry.created',
  exportGenerated: 'export.generated',
  aiSettingsChanged: 'ai.settings_changed',
} as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
