import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../platform/http';
import { authenticate } from '../../middleware/auth';
import { requireOrg } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { verifyCsrf } from '../../middleware/csrf';
import { notFound } from '../../platform/errors';
import { BaselineVersion, Project } from '../../models';
import {
  addRequirement,
  approveVersion,
  createDraft,
  detectAmbiguity,
  removeRequirement,
  summariseSnapshot,
  updateRequirement,
  updateSnapshotMeta,
} from './baselines.service';

export const baselineRouter = Router({ mergeParams: true });

const mutating = [authenticate, verifyCsrf] as const;
baselineRouter.use(authenticate, requireOrg);

const criterionList = z.array(z.string().min(3).max(600)).max(20);

const requirementBody = z.object({
  kind: z.enum(['requirement', 'exclusion']),
  title: z.string().min(3).max(300),
  description: z.string().max(4000).optional(),
  category: z.string().max(40).optional(),
  priority: z.enum(['must', 'should', 'could', 'wont']).optional(),
  acceptanceCriteria: criterionList.optional(),
  deliverable: z.string().max(160).optional(),
  estimatedHours: z.number().min(0).max(10000).optional(),
  dependsOn: z.array(z.string().max(20)).max(20).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

/** Version history for a project (newest first). */
baselineRouter.get(
  '/',
  requirePermission('baseline.view'),
  asyncHandler(async (req, res) => {
    const project = await Project.findOne({ _id: req.params.projectId, org: req.org!.orgId, deletedAt: null }).lean();
    if (!project) throw notFound('Project not found.');
    const versions = await BaselineVersion.find({ org: req.org!.orgId, project: project._id })
      .select('-snapshot')
      .sort({ version: -1 })
      .lean();
    res.json({
      currentBaselineId: project.currentBaseline ? String(project.currentBaseline) : null,
      versions: versions.map((v) => ({
        id: String(v._id),
        version: v.version,
        status: v.status,
        label: v.label,
        reason: v.reason,
        parent: v.parent ? String(v.parent) : null,
        changeRequest: v.changeRequest ? String(v.changeRequest) : null,
        snapshotHash: v.snapshotHash,
        approvedAt: v.approvedAt,
        createdAt: v.createdAt,
        diff: v.diff,
        isCurrent: project.currentBaseline ? String(project.currentBaseline) === String(v._id) : false,
      })),
    });
  }),
);

/** The full snapshot of one version. This is the authoritative "what was agreed". */
baselineRouter.get(
  '/:versionId',
  requirePermission('baseline.view'),
  asyncHandler(async (req, res) => {
    const version = await BaselineVersion.findOne({
      _id: req.params.versionId,
      org: req.org!.orgId,
      project: req.params.projectId,
    }).lean();
    if (!version) throw notFound('Baseline version not found.');
    res.json({ version, summary: summariseSnapshot(version.snapshot) });
  }),
);

baselineRouter.post(
  '/',
  ...mutating,
  requirePermission('baseline.edit_draft'),
  validate({
    body: z.object({
      label: z.string().max(200).optional(),
      reason: z.string().max(2000).optional(),
      fromVersionId: z.string().optional(),
      changeRequestId: z.string().optional(),
      documentId: z.string().optional(),
      sourceType: z.enum(['manual', 'document_import', 'change_order', 'api']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const version = await createDraft({
      orgId: req.org!.orgId,
      projectId: String(req.params.projectId ?? ''),
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email, ip: req.ip, userAgent: req.header('user-agent') },
      ...req.body,
    });
    res.status(201).json({ version, summary: summariseSnapshot(version.snapshot) });
  }),
);

baselineRouter.patch(
  '/:versionId',
  ...mutating,
  requirePermission('baseline.edit_draft'),
  validate({
    body: z.object({
      objectives: z.array(z.string().max(600)).max(30).optional(),
      assumptions: z.array(z.string().max(600)).max(40).optional(),
      dependencies: z.array(z.string().max(600)).max(40).optional(),
      clientResponsibilities: z.array(z.string().max(600)).max(40).optional(),
      supportBoundaries: z.array(z.string().max(600)).max(40).optional(),
      milestones: z.array(z.object({ name: z.string().max(200), dueDate: z.string().nullable().optional(), amountMinor: z.number().optional() })).max(30).optional(),
      budget: z.object({ amountMinor: z.number().min(0).optional(), currency: z.string().length(3).optional(), estimatedHours: z.number().min(0).optional() }).optional(),
      label: z.string().max(200).optional(),
      reason: z.string().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const version = await updateSnapshotMeta({
      orgId: req.org!.orgId,
      projectId: String(req.params.projectId ?? ''),
      versionId: String(req.params.versionId ?? ''),
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email, ip: req.ip, userAgent: req.header('user-agent') },
      patch: req.body,
    });
    res.json({ version, summary: summariseSnapshot(version.snapshot) });
  }),
);

baselineRouter.post(
  '/:versionId/requirements',
  ...mutating,
  requirePermission('baseline.edit_draft'),
  validate({ body: requirementBody }),
  asyncHandler(async (req, res) => {
    const result = await addRequirement({
      orgId: req.org!.orgId,
      projectId: String(req.params.projectId ?? ''),
      versionId: String(req.params.versionId ?? ''),
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email, ip: req.ip, userAgent: req.header('user-agent') },
      requirement: req.body,
    });
    res.status(201).json({
      key: result.key,
      requirement: result.version.snapshot.requirements.find((r) => r.key === result.key),
      summary: summariseSnapshot(result.version.snapshot),
      // Surfaced immediately so vague wording is caught at authoring time, not at dispute time.
      looksAmbiguous: detectAmbiguity(`${req.body.title} ${req.body.description ?? ''}`),
    });
  }),
);

baselineRouter.patch(
  '/:versionId/requirements/:key',
  ...mutating,
  requirePermission('baseline.edit_draft'),
  validate({ body: requirementBody.partial().omit({ kind: true }) }),
  asyncHandler(async (req, res) => {
    const result = await updateRequirement({
      orgId: req.org!.orgId,
      projectId: String(req.params.projectId ?? ''),
      versionId: String(req.params.versionId ?? ''),
      key: String(req.params.key ?? ''),
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email, ip: req.ip, userAgent: req.header('user-agent') },
      patch: req.body,
    });
    res.json({ requirement: result.requirement, summary: summariseSnapshot(result.version.snapshot) });
  }),
);

baselineRouter.delete(
  '/:versionId/requirements/:key',
  ...mutating,
  requirePermission('baseline.edit_draft'),
  asyncHandler(async (req, res) => {
    const version = await removeRequirement({
      orgId: req.org!.orgId,
      projectId: String(req.params.projectId ?? ''),
      versionId: String(req.params.versionId ?? ''),
      key: String(req.params.key ?? ''),
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email, ip: req.ip, userAgent: req.header('user-agent') },
      reason: typeof req.query.reason === 'string' ? req.query.reason : undefined,
    });
    res.json({ ok: true, summary: summariseSnapshot(version.snapshot) });
  }),
);

/** Approve — freezes the version, hashes it, and supersedes the previous one. */
baselineRouter.post(
  '/:versionId/approve',
  ...mutating,
  requirePermission('baseline.approve'),
  validate({
    body: z.object({
      method: z.enum(['internal', 'client_change_order', 'external_document', 'migration']).default('internal'),
      actorName: z.string().max(160).optional(),
      actorEmail: z.string().email().max(200).optional(),
      note: z.string().max(2000).optional(),
      changeRequestId: z.string().optional(),
      confirm: z.literal(true),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await approveVersion({
      orgId: req.org!.orgId,
      projectId: String(req.params.projectId ?? ''),
      versionId: String(req.params.versionId ?? ''),
      actor: { userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email, ip: req.ip, userAgent: req.header('user-agent') },
      evidence: req.body,
      changeRequestId: req.body.changeRequestId,
    });
    res.json({
      version: result.version,
      alreadyApproved: result.alreadyApproved,
      summary: summariseSnapshot(result.version.snapshot),
      immutable: true,
      note: 'This version is now frozen. Any further change creates a new version and keeps this one exactly as approved.',
    });
  }),
);
