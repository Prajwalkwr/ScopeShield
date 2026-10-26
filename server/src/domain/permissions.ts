import type { Role } from '../config/constants';
import { ROLES } from '../config/constants';

/**
 * Two-axis authorization:
 *   axis 1 — TENANT:  is the actor a member of the organization that owns this record?
 *   axis 2 — CAPABILITY: does the actor's role grant this permission?
 *
 * Frontend route guards are UX only. These values are evaluated server-side on every
 * request, and no endpoint trusts a client-supplied role, org id or permission list.
 */
export const PERMISSIONS = [
  'org.view',
  'org.update',
  'org.manage_billing',
  'org.manage_members',
  'org.manage_integrations',
  'org.manage_ai',
  'org.view_audit',
  'org.export',

  'client.view',
  'client.manage',

  'project.view',
  'project.create',
  'project.update',
  'project.archive',
  'project.view_financials',

  'baseline.view',
  'baseline.edit_draft',
  'baseline.approve',
  'baseline.supersede',

  'document.view',
  'document.upload',
  'document.delete',

  'request.view',
  'request.create',
  'request.update',
  'request.classify_suggest',
  'request.review', // correct a classification, move through workflow
  'request.assign',
  'request.cancel',

  'analysis.run',
  'analysis.correct',

  'estimate.view_internal',
  'estimate.create',
  'estimate.finalise',

  'change_order.generate',
  'change_order.send',
  'change_order.revoke_token',

  'time_entry.view',
  'time_entry.create_own',
  'time_entry.create_any',

  'report.view',
  'report.view_financials',
  'report.export',

  'notification.view',

  // An explicit, auditable break-glass capability. Never granted by default except owner.
  'override.approve_without_estimate',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Role → capability matrix.
 * Design rules encoded here:
 *  - 'developer' can record, estimate and flag, but CANNOT approve commercial outcomes
 *    or send anything to a client (Part 11 rule: developers must not approve their own
 *    commercial changes unless the organization explicitly grants it — see ORG overrides).
 *  - 'viewer' is read-only, and cannot see internal cost estimates or financial reports.
 *  - only 'owner' holds override + billing capabilities.
 */
const MATRIX: Record<Role, Permission[]> = {
  owner: [...PERMISSIONS],

  admin: [
    'org.view', 'org.update', 'org.manage_members', 'org.manage_integrations', 'org.manage_ai',
    'org.view_audit', 'org.export',
    'client.view', 'client.manage',
    'project.view', 'project.create', 'project.update', 'project.archive', 'project.view_financials',
    'baseline.view', 'baseline.edit_draft', 'baseline.approve', 'baseline.supersede',
    'document.view', 'document.upload', 'document.delete',
    'request.view', 'request.create', 'request.update', 'request.classify_suggest', 'request.review', 'request.assign', 'request.cancel',
    'analysis.run', 'analysis.correct',
    'estimate.view_internal', 'estimate.create', 'estimate.finalise',
    'change_order.generate', 'change_order.send', 'change_order.revoke_token',
    'time_entry.view', 'time_entry.create_own', 'time_entry.create_any',
    'report.view', 'report.view_financials', 'report.export',
    'notification.view',
  ],

  pm: [
    'org.view',
    'client.view', 'client.manage',
    'project.view', 'project.create', 'project.update', 'project.view_financials',
    'baseline.view', 'baseline.edit_draft', 'baseline.approve',
    'document.view', 'document.upload',
    'request.view', 'request.create', 'request.update', 'request.classify_suggest', 'request.review', 'request.assign', 'request.cancel',
    'analysis.run', 'analysis.correct',
    'estimate.view_internal', 'estimate.create', 'estimate.finalise',
    'change_order.generate', 'change_order.send', 'change_order.revoke_token',
    'time_entry.view', 'time_entry.create_own', 'time_entry.create_any',
    'report.view', 'report.view_financials', 'report.export',
    'notification.view',
  ],

  developer: [
    'org.view',
    'client.view',
    'project.view',
    'baseline.view',
    'document.view', 'document.upload',
    'request.view', 'request.create', 'request.update', 'request.classify_suggest',
    'analysis.run',
    'estimate.view_internal', 'estimate.create',
    'time_entry.view', 'time_entry.create_own',
    'report.view',
    'notification.view',
  ],

  viewer: [
    'org.view',
    'client.view',
    'project.view',
    'baseline.view',
    'document.view',
    'request.view',
    'time_entry.view',
    'report.view',
    'notification.view',
  ],
};

export function permissionsForRole(role: Role): Permission[] {
  return MATRIX[role] ?? [];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/**
 * Capabilities that can never be handed out as a per-member override, whatever an owner asks for.
 * Billing control stays with the organization owner role; everything else is delegable.
 */
export const NON_GRANTABLE_PERMISSIONS = ['org.manage_billing'] as const;

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function isGrantable(value: string): value is Permission {
  return isPermission(value) && !(NON_GRANTABLE_PERMISSIONS as readonly string[]).includes(value);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Resolve the effective permission set for a membership: role matrix ± org overrides. */
export function resolvePermissions(
  role: Role,
  grants: Permission[] = [],
  revokes: Permission[] = [],
): Permission[] {
  const set = new Set<Permission>(permissionsForRole(role));
  for (const g of grants) set.add(g);
  for (const r of revokes) set.delete(r);
  // Hard invariant: a per-organization override can never grant these.
  for (const p of NON_GRANTABLE_PERMISSIONS) set.delete(p as Permission);
  if (role === 'owner') set.add('org.manage_billing');
  return [...set];
}
