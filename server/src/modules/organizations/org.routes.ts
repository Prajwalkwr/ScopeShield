import { Router } from 'express';
import { z } from 'zod';
import { ROLES } from '../../config/constants';
import { asyncHandler, parsePagination, paginated } from '../../platform/http';
import { authenticate } from '../../middleware/auth';
import { requireOrg } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { verifyCsrf } from '../../middleware/csrf';
import { rateLimit } from '../../middleware/rateLimit';
import { badRequest } from '../../platform/errors';
import { Organization, Project } from '../../models';
import {
  acceptInvitation,
  createOrganization,
  getOrganization,
  inviteMember,
  listMembers,
  orgOverview,
  removeMember,
  updateMemberRole,
  updateOrganization,
} from './org.service';
import { buildMePayload } from '../auth/auth.service';

export const orgRouter = Router();

const mutating = [authenticate, verifyCsrf] as const;

/** Create an organization — the first step of onboarding. */
orgRouter.post(
  '/',
  authenticate,
  verifyCsrf,
  rateLimit({ scope: 'org:create', capacity: 5, refillPerSecond: 5 / 3600, keyFn: (req) => `u:${req.auth?.userId}` }),
  validate({
    body: z.object({
      name: z.string().min(2).max(160),
      currency: z.string().length(3).optional(),
      defaultHourlyRate: z.number().min(0).max(10000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const created = await createOrganization({
      userId: req.auth!.userId,
      userName: req.auth!.user.name,
      userEmail: req.auth!.user.email,
      ...req.body,
    });
    const payload = await buildMePayload(req.auth!.userId);
    res.status(201).json({ organization: created, ...payload });
  }),
);

/** Accept an invitation (token-based, so no organization context yet). */
orgRouter.post(
  '/invitations/accept',
  authenticate,
  verifyCsrf,
  validate({ body: z.object({ token: z.string().min(20).max(300) }) }),
  asyncHandler(async (req, res) => {
    const joined = await acceptInvitation({
      token: req.body.token,
      userId: req.auth!.userId,
      userName: req.auth!.user.name,
      userEmail: req.auth!.user.email,
    });
    const payload = await buildMePayload(req.auth!.userId);
    res.json({ joined, ...payload });
  }),
);

orgRouter.get(
  '/invitations/:token',
  rateLimit({ scope: 'invite:peek', capacity: 20, refillPerSecond: 1, keyFn: (req) => `ip:${req.ip}` }),
  asyncHandler(async (req, res) => {
    // Public peek used by the invite acceptance screen. Minimum disclosure: org name only.
    const { Invitation } = await import('../../models');
    const { sha256 } = await import('../../platform/crypto');
    const invite = await Invitation.findOne({ tokenHash: sha256(String(req.params.token ?? '')), status: 'pending' })
      .populate('org', 'name')
      .lean();
    if (!invite || invite.expiresAt < new Date()) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'This invitation is invalid or has expired.' } });
      return;
    }
    const org = invite.org as unknown as { name?: string } | null;
    res.json({
      invitation: {
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        organizationName: org?.name ?? 'an organization',
      },
    });
  }),
);

orgRouter.get(
  '/:orgId',
  authenticate,
  requireOrg,
  requirePermission('org.view'),
  asyncHandler(async (req, res) => {
    const [org, overview, pagination] = [await getOrganization(req.org!.orgId), await orgOverview(req.org!.orgId), parsePagination(req.query as Record<string, unknown>)];
    const recentProjects = await Project.find({ org: req.org!.orgId, deletedAt: null })
      .sort({ updatedAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.pageSize)
      .lean();
    res.json({
      organization: org,
      overview,
      recentProjects: paginated(
        recentProjects.map((p) => ({ id: String(p._id), name: p.name, code: p.code, status: p.status })),
        overview.projects,
        pagination,
      ),
      permissions: req.org!.permissions,
      role: req.org!.role,
    });
  }),
);

orgRouter.patch(
  '/:orgId',
  ...mutating,
  requireOrg,
  requirePermission('org.update'),
  validate({
    body: z.object({
      name: z.string().min(2).max(160).optional(),
      currency: z.string().length(3).optional(),
      timezone: z.string().max(60).optional(),
      defaultHourlyRate: z.number().min(0).max(10000).optional(),
      hoursPerPersonDay: z.number().min(1).max(16).optional(),
      defaultRevisionRounds: z.number().min(0).max(20).optional(),
      workingDays: z.array(z.number().min(0).max(6)).max(7).optional(),
      termsText: z.string().max(12000).optional(),
      approvalPolicy: z
        .object({
          tokenTtlDays: z.number().min(1).max(120).optional(),
          autoApproveUnderAmount: z.number().min(0).optional(),
          requireEstimateBeforeInternalReview: z.boolean().optional(),
          warnOnUnapprovedWork: z.boolean().optional(),
        })
        .optional(),
      ai: z
        .object({
          enabled: z.boolean().optional(),
          provider: z.enum(['heuristic', 'openai', 'anthropic']).optional(),
          model: z.string().max(120).optional(),
          monthlyBudgetUsd: z.number().min(0).max(10000).optional(),
          allowDocumentText: z.boolean().optional(),
        })
        .optional(),
      branding: z
        .object({
          accentColor: z.string().max(20).optional(),
          logoUrl: z.string().max(500).optional(),
          documentFooter: z.string().max(1000).optional(),
        })
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    // Billing + AI settings are privileged.
    if (req.body.ai && !req.org!.permissions.includes('org.manage_ai')) {
      throw badRequest('Changing AI settings requires the "org.manage_ai" permission.');
    }
    const org = await updateOrganization(
      req.org!.orgId,
      { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email },
      req.body,
      { ip: req.ip, userAgent: req.header('user-agent') },
    );
    res.json({ organization: org });
  }),
);

orgRouter.get(
  '/:orgId/members',
  authenticate,
  requireOrg,
  requirePermission('org.view'),
  asyncHandler(async (req, res) => {
    res.json({ members: await listMembers(req.org!.orgId) });
  }),
);

orgRouter.post(
  '/:orgId/invitations',
  ...mutating,
  requireOrg,
  requirePermission('org.manage_members'),
  validate({
    body: z.object({ email: z.string().email().max(200), role: z.enum(ROLES) }),
  }),
  asyncHandler(async (req, res) => {
    const org = await Organization.findById(req.org!.orgId).select('name').lean();
    const invite = await inviteMember({
      orgId: req.org!.orgId,
      orgName: org?.name ?? 'the organization',
      email: req.body.email,
      role: req.body.role,
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email },
      ip: req.ip,
      userAgent: req.header('user-agent'),
    });
    // The token is returned so a self-hosted deployment without a mail driver can still
    // deliver the link manually; the raw token is never persisted.
    res.status(201).json({ invitation: { id: invite.invitationId, expiresAt: invite.expiresAt }, linkToken: invite.token });
  }),
);

orgRouter.patch(
  '/:orgId/members/:membershipId',
  ...mutating,
  requireOrg,
  requirePermission('org.manage_members'),
  validate({
    body: z.object({
      role: z.enum(ROLES).optional(),
      grants: z.array(z.string()).max(60).optional(),
      revokes: z.array(z.string()).max(60).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const membership = await updateMemberRole({
      orgId: req.org!.orgId,
      membershipId: String(req.params.membershipId ?? ''),
      ...req.body,
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email },
    });
    res.json({ membership: { id: String(membership._id), role: membership.role } });
  }),
);

orgRouter.delete(
  '/:orgId/members/:membershipId',
  ...mutating,
  requireOrg,
  requirePermission('org.manage_members'),
  asyncHandler(async (req, res) => {
    const result = await removeMember({
      orgId: req.org!.orgId,
      membershipId: String(req.params.membershipId ?? ''),
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email },
    });
    res.json(result);
  }),
);
