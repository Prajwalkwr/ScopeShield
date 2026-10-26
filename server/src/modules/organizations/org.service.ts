import { Membership, Organization, Project, User, Invitation, AuditChain } from '../../models';
import { conflict, forbidden, notFound, badRequest, internal } from '../../platform/errors';
import { withTransaction } from '../../config/db';
import { generateOpaqueToken, sha256, shortId } from '../../platform/crypto';
import { recordAudit } from '../../platform/audit';
import { AUDIT_ACTIONS, ROLES, type Role } from '../../config/constants';
import { mail } from '../../platform/mail';
import { webUrl } from '../../platform/http';
import { isGrantable, isPermission, type Permission } from '../../domain/permissions';
import { BRAND } from '../../config/brand';
import mongoose from 'mongoose';

const RESERVED_SLUGS = new Set([
  'api', 'app', 'www', 'admin', 'dashboard', 'login', 'signup', 'register', 'settings', 'support',
  'help', 'docs', 'status', 'billing', 'portal', 'approve', 'approval', 'public', 'static', 'assets',
]);

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export async function createOrganization(input: {
  userId: string;
  userName: string;
  userEmail: string;
  name: string;
  currency?: string;
  defaultHourlyRate?: number;
}): Promise<{ orgId: string; slug: string }> {
  const base = slugify(input.name) || `studio-${shortId(4).toLowerCase()}`;
  let slug = RESERVED_SLUGS.has(base) ? `${base}-studio` : base;

  // Ensure uniqueness without a race: retry on the unique index.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const exists = await Organization.findOne({ slug }).lean();
    if (!exists) break;
    slug = `${base}-${shortId(3).toLowerCase()}`;
  }

  const run = async (session: mongoose.ClientSession | null) => {
    const created = await Organization.create(
      [
        {
          name: input.name.trim(),
          slug,
          createdBy: input.userId,
          currency: input.currency ?? 'USD',
          defaultHourlyRate: input.defaultHourlyRate ?? 75,
        },
      ],
      session ? { session } : {},
    );
    const organization = Array.isArray(created) ? (created[0] as (typeof created)[number] | undefined) : undefined;
    if (!organization) throw internal('Could not create the organization.');
    await Membership.create(
      [{ org: organization._id, user: input.userId, role: 'owner' as Role, joinedAt: new Date() }] as never,
      session ? { session } : {},
    );
    await AuditChain.updateOne(
      { org: organization._id },
      { $setOnInsert: { lastSeq: 0, lastHash: 'GENESIS' } },
      { upsert: true, ...(session ? { session } : {}) },
    );
    return organization;
  };

  // Atomic when the deployment supports transactions; sequential with a warning otherwise.
  const { result: org } = await withTransaction(run);

  await recordAudit({
    org: String(org._id),
    action: AUDIT_ACTIONS.orgCreated,
    actor: { kind: 'user', userId: input.userId, name: input.userName, email: input.userEmail },
    entity: { type: 'Organization', id: String(org._id), label: org.name },
    meta: { slug },
  });

  return { orgId: String(org._id), slug };
}

export async function getOrganization(orgId: string) {
  const org = await Organization.findOne({ _id: orgId, deletedAt: null }).lean();
  if (!org) throw notFound('Organization not found.');
  return org;
}

export async function updateOrganization(
  orgId: string,
  actor: { userId: string; name: string; email: string },
  patch: Record<string, unknown>,
  meta: { ip?: string; userAgent?: string },
) {
  const org = await Organization.findOne({ _id: orgId, deletedAt: null });
  if (!org) throw notFound('Organization not found.');

  const changes: { field: string; from: string; to: string }[] = [];
  const setIfChanged = (field: string, next: unknown, current: unknown, transform = (v: unknown) => String(v)) => {
    if (next === undefined || next === null) return;
    const nextStr = transform(next);
    const currentStr = transform(current ?? '');
    if (nextStr !== currentStr) {
      changes.push({ field, from: currentStr.slice(0, 120), to: nextStr.slice(0, 120) });
      return next;
    }
    return undefined;
  };

  const assign = (path: string, value: unknown) => {
    const parts = path.split('.');
    let cursor: Record<string, unknown> = org as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i]!;
      if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]!] = value;
  };

  const scalarPaths: [string, string][] = [
    ['name', 'name'], ['currency', 'currency'], ['timezone', 'timezone'], ['termsText', 'termsText'],
  ];
  for (const [key, path] of scalarPaths) {
    const next = setIfChanged(path, patch[key], (org as unknown as Record<string, unknown>)[key === 'name' ? 'name' : key]);
    if (next !== undefined) assign(path, next);
  }
  const numericPaths = ['defaultHourlyRate', 'hoursPerPersonDay', 'defaultRevisionRounds'] as const;
  for (const key of numericPaths) {
    if (patch[key] !== undefined && patch[key] !== (org as unknown as Record<string, unknown>)[key]) {
      changes.push({ field: key, from: String((org as unknown as Record<string, unknown>)[key]), to: String(patch[key]) });
      assign(key, patch[key]);
    }
  }
  if (Array.isArray(patch.workingDays)) assign('workingDays', patch.workingDays);

  const policy = patch.approvalPolicy as Record<string, unknown> | undefined;
  if (policy) {
    for (const key of ['tokenTtlDays', 'autoApproveUnderAmount', 'requireEstimateBeforeInternalReview', 'warnOnUnapprovedWork']) {
      if (policy[key] !== undefined) assign(`approvalPolicy.${key}`, policy[key]);
    }
    changes.push({ field: 'approvalPolicy', from: 'previous settings', to: 'updated settings' });
  }

  const ai = patch.ai as Record<string, unknown> | undefined;
  if (ai) {
    for (const key of ['enabled', 'provider', 'model', 'monthlyBudgetUsd', 'allowDocumentText']) {
      if (ai[key] !== undefined) assign(`ai.${key}`, ai[key]);
    }
    changes.push({ field: 'ai', from: 'previous settings', to: JSON.stringify(ai).slice(0, 120) });
  }

  const branding = patch.branding as Record<string, unknown> | undefined;
  if (branding) {
    for (const key of ['accentColor', 'logoUrl', 'documentFooter']) {
      if (branding[key] !== undefined) assign(`branding.${key}`, branding[key]);
    }
  }

  await org.save();

  if (changes.length > 0) {
    const isAiChange = changes.some((c) => c.field.startsWith('ai'));
    await recordAudit({
      org: orgId,
      action: isAiChange ? AUDIT_ACTIONS.aiSettingsChanged : AUDIT_ACTIONS.orgCreated,
      actor: { kind: 'user', userId: actor.userId, name: actor.name, email: actor.email },
      entity: { type: 'Organization', id: orgId, label: org.name },
      changes,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
  return org;
}

// ── Members & invitations ────────────────────────────────────────────────────

export async function listMembers(orgId: string) {
  const memberships = await Membership.find({ org: orgId, status: { $ne: 'removed' } }).lean();
  const users = await User.find({ _id: { $in: memberships.map((m) => m.user) } })
    .select('name email status lastLoginAt jobTitle avatarColor isDemo')
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return memberships.map((m) => {
    const u = byId.get(String(m.user));
    return {
      membershipId: String(m._id),
      role: m.role as Role,
      status: m.status,
      joinedAt: m.joinedAt,
      grants: m.grants ?? [],
      revokes: m.revokes ?? [],
      projectScopeCount: (m.projectScope ?? []).length,
      user: u
        ? {
            id: String(u._id),
            name: u.name,
            email: u.email,
            status: u.status,
            jobTitle: u.jobTitle,
            avatarColor: u.avatarColor,
            lastLoginAt: u.lastLoginAt,
          }
        : null,
    };
  });
}

export async function inviteMember(input: {
  orgId: string;
  orgName: string;
  email: string;
  role: Role;
  actor: { userId: string; name: string; email: string };
  ip?: string;
  userAgent?: string;
}): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const email = input.email.toLowerCase().trim();
  if (!ROLES.includes(input.role)) throw badRequest('That role does not exist.');

  const existingUser = await User.findOne({ email }).lean();
  if (existingUser) {
    const already = await Membership.findOne({ org: input.orgId, user: existingUser._id, status: { $ne: 'removed' } }).lean();
    if (already) throw conflict('That person is already a member of this organization.');
  }

  const pending = await Invitation.findOne({ org: input.orgId, email, status: 'pending' });
  if (pending) {
    // Re-issuing replaces the previous link so only one works at a time.
    pending.status = 'revoked';
    await pending.save();
  }

  const token = generateOpaqueToken(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const invitation = await Invitation.create({
    org: input.orgId,
    email,
    role: input.role,
    tokenHash: sha256(token),
    invitedBy: input.actor.userId,
    status: 'pending',
    expiresAt,
  });

  await mail.send({
    to: email,
    subject: `${input.actor.name} invited you to ${input.orgName} on ${BRAND.name}`,
    text: [
      `${input.actor.name} has invited you to join ${input.orgName} as ${input.role}.`,
      '',
      `Accept the invitation: ${webUrl(`/accept-invitation?token=${encodeURIComponent(token)}`)}`,
      '',
      'This link expires in 7 days. If you were not expecting it, you can ignore this email.',
    ].join('\n'),
  });

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.memberInvited,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'Invitation', id: String(invitation._id), label: email },
    meta: { role: input.role },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return { invitationId: String(invitation._id), token, expiresAt };
}

export async function acceptInvitation(input: { token: string; userId: string; userName: string; userEmail: string }) {
  const hash = sha256(input.token);
  const invitation = await Invitation.findOne({ tokenHash: hash, status: 'pending' }).select('+tokenHash');
  if (!invitation) throw notFound('This invitation link is invalid or has already been used.');
  if (invitation.expiresAt < new Date()) {
    invitation.status = 'expired';
    await invitation.save();
    throw badRequest('This invitation has expired. Ask for a new one.');
  }
  if (invitation.email !== input.userEmail.toLowerCase()) {
    throw forbidden('This invitation was issued to a different email address. Sign in with the invited address.');
  }

  const existing = await Membership.findOne({ org: invitation.org, user: input.userId }).lean();
  if (existing) {
    if (existing.status === 'removed') {
      await Membership.updateOne({ _id: existing._id }, { $set: { status: 'active' } });
    }
  } else {
    await Membership.create({
      org: invitation.org,
      user: input.userId,
      role: invitation.role as Role,
      invitedBy: invitation.invitedBy,
      joinedAt: new Date(),
    });
  }

  invitation.status = 'accepted';
  invitation.acceptedAt = new Date();
  invitation.acceptedBy = new mongoose.Types.ObjectId(input.userId);
  await invitation.save();

  const org = await Organization.findById(invitation.org).select('name slug').lean();
  await recordAudit({
    org: String(invitation.org),
    action: AUDIT_ACTIONS.memberJoined,
    actor: { kind: 'user', userId: input.userId, name: input.userName, email: input.userEmail },
    entity: { type: 'Membership', id: input.userId, label: input.userEmail },
    meta: { role: invitation.role },
  });

  return { orgId: String(invitation.org), orgSlug: org?.slug ?? '', orgName: org?.name ?? '' };
}

export async function updateMemberRole(input: {
  orgId: string;
  membershipId: string;
  role?: Role;
  grants?: string[];
  revokes?: string[];
  actor: { userId: string; name: string; email: string };
}) {
  const membership = await Membership.findOne({ _id: input.membershipId, org: input.orgId });
  if (!membership) throw notFound('Membership not found.');

  // An organization must always retain at least one owner.
  if (membership.role === 'owner' && input.role && input.role !== 'owner') {
    const owners = await Membership.countDocuments({ org: input.orgId, role: 'owner', status: 'active' });
    if (owners <= 1) throw conflict('This is the only owner. Promote another member to owner first.');
  }
  if (String(membership.user) === input.actor.userId && input.role && input.role !== membership.role) {
    throw badRequest('You cannot change your own role. Ask another owner or administrator.');
  }

  const changes: { field: string; from: string; to: string }[] = [];
  if (input.role && input.role !== membership.role) {
    changes.push({ field: 'role', from: membership.role, to: input.role });
    membership.role = input.role;
  }
  /**
   * Overrides are validated against the capability catalogue rather than stored as free text.
   * A typo would otherwise create a permission that silently never applies, and an owner could
   * hand out a capability the role matrix deliberately withholds.
   */
  if (input.grants) {
    const unknown = input.grants.filter((g) => !isPermission(g));
    if (unknown.length) throw badRequest(`Unknown permission(s): ${unknown.join(', ')}.`);
    const forbidden = input.grants.filter((g) => !isGrantable(g));
    if (forbidden.length) {
      throw badRequest(
        `These permissions cannot be granted outside the owner role: ${forbidden.join(', ')}. They control billing and organization ownership.`,
      );
    }
    changes.push({ field: 'grants', from: (membership.grants ?? []).join(',') || 'none', to: input.grants.join(',') || 'none' });
    membership.grants = input.grants as never;
  }
  if (input.revokes) {
    const unknown = input.revokes.filter((g) => !isPermission(g));
    if (unknown.length) throw badRequest(`Unknown permission(s): ${unknown.join(', ')}.`);
    // Revoking the capabilities a role needs to function would leave a member who can sign in
  // but do nothing; removing them from the organization is the honest way to end access.
    const required: Permission[] = ['org.view', 'org.update'];
    const overreach = input.revokes.filter((r) => required.includes(r as Permission));
    if (overreach.length) {
      throw badRequest(
        `These capabilities cannot be revoked: ${overreach.join(', ')}. Remove the member from the organization instead of leaving them with no access.`,
      );
    }
    changes.push({ field: 'revokes', from: (membership.revokes ?? []).join(',') || 'none', to: input.revokes.join(',') || 'none' });
    membership.revokes = input.revokes as never;
  }
  await membership.save();

  if (changes.length > 0) {
    await recordAudit({
      org: input.orgId,
      action: AUDIT_ACTIONS.memberRoleChanged,
      actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
      entity: { type: 'Membership', id: input.membershipId },
      changes,
    });
  }
  return membership;
}

export async function removeMember(input: {
  orgId: string;
  membershipId: string;
  actor: { userId: string; name: string; email: string };
}) {
  const membership = await Membership.findOne({ _id: input.membershipId, org: input.orgId });
  if (!membership) throw notFound('Membership not found.');
  if (String(membership.user) === input.actor.userId) throw badRequest('You cannot remove yourself.');
  if (membership.role === 'owner') {
    const owners = await Membership.countDocuments({ org: input.orgId, role: 'owner', status: 'active' });
    if (owners <= 1) throw conflict('This is the only owner and cannot be removed.');
  }
  membership.status = 'removed';
  await membership.save();
  const sessionCount = await import('../auth/auth.service').then((m) => m.revokeAllSessions(String(membership.user), 'admin'));

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.memberRemoved,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'Membership', id: input.membershipId },
    meta: { sessionsRevoked: sessionCount },
  });
  return { ok: true, sessionsRevoked: sessionCount };
}

export async function orgOverview(orgId: string) {
  const [clients, projects, members] = await Promise.all([
    import('../../models').then((m) => m.Client.countDocuments({ org: orgId, deletedAt: null })),
    Project.countDocuments({ org: orgId, deletedAt: null }),
    Membership.countDocuments({ org: orgId, status: 'active' }),
  ]);
  return { clients, projects, members };
}
