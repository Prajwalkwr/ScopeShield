import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { asyncHandler, paginated, parsePagination } from '../../platform/http';
import { authenticate } from '../../middleware/auth';
import { assertProjectInScope, requireOrg } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { verifyCsrf } from '../../middleware/csrf';
import { badRequest, notFound } from '../../platform/errors';
import { recordAudit } from '../../platform/audit';
import { AUDIT_ACTIONS } from '../../config/constants';
import { BaselineVersion, ChangeOrder, ChangeRequest, Client, Project, TimeEntry, User } from '../../models';
import { computeScopeHealth } from '../../domain/health';

export const projectRouter = Router();

const mutating = [authenticate, verifyCsrf] as const;
projectRouter.use(authenticate, requireOrg);

/** Loads a project and enforces tenant + optional per-member project scope. */
async function loadProject(req: Parameters<typeof assertProjectInScope>[0], projectId: string) {
  const project = await Project.findOne({ _id: projectId, org: req.org!.orgId, deletedAt: null }).lean();
  if (!project) throw notFound('Project not found.');
  assertProjectInScope(req, String(project._id));
  return project;
}

projectRouter.get(
  '/',
  requirePermission('project.view'),
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const filter: Record<string, unknown> = { org: req.org!.orgId, deletedAt: null };
    if (typeof req.query.status === 'string' && req.query.status) filter.status = req.query.status;
    if (typeof req.query.clientId === 'string' && req.query.clientId) filter.client = req.query.clientId;
    if (req.org!.projectScope.length > 0) filter._id = { $in: req.org!.projectScope };
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { code: new RegExp(search, 'i') }];

    const [items, total] = await Promise.all([
      Project.find(filter).sort({ updatedAt: -1 }).skip(pagination.skip).limit(pagination.pageSize).lean(),
      Project.countDocuments(filter),
    ]);

    const clientIds = items.map((p) => p.client);
    const clients = await Client.find({ _id: { $in: clientIds } }).select('name').lean();
    const clientById = new Map(clients.map((c) => [String(c._id), c.name]));

    const projectIds = items.map((p) => p._id);
    const requestCounts = await ChangeRequest.aggregate([
      { $match: { project: { $in: projectIds } } },
      {
        $group: {
          _id: '$project',
          open: { $sum: { $cond: [{ $in: ['$status', ['submitted', 'under_review', 'classified', 'estimating', 'internal_review']] }, 1, 0] } },
          awaitingClient: { $sum: { $cond: [{ $eq: ['$status', 'awaiting_client_decision'] }, 1, 0] } },
          approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
          potentialValueMinor: { $sum: { $cond: [{ $eq: ['$status', 'awaiting_client_decision'] }, '$outcome.additionalValueMinor', 0] } },
        },
      },
    ]);
    const countsByProject = new Map(requestCounts.map((c) => [String(c._id), c]));

    res.json(
      paginated(
        items.map((p) => ({
          id: String(p._id),
          code: p.code,
          name: p.name,
          status: p.status,
          client: { id: String(p.client), name: clientById.get(String(p.client)) ?? 'Unknown client' },
          currency: p.currency,
          contractAmountMinor: p.contractAmountMinor,
          targetEndDate: p.targetEndDate,
          currentBaseline: p.currentBaseline ? String(p.currentBaseline) : null,
          baselineVersionCount: p.baselineVersionCount,
          healthScore: p.healthScore,
          healthBand: p.healthBand,
          requests: {
            open: countsByProject.get(String(p._id))?.open ?? 0,
            awaitingClient: countsByProject.get(String(p._id))?.awaitingClient ?? 0,
            approved: countsByProject.get(String(p._id))?.approved ?? 0,
          },
        })),
        total,
        pagination,
      ),
    );
  }),
);

projectRouter.post(
  '/',
  ...mutating,
  requirePermission('project.create'),
  validate({
    body: z.object({
      name: z.string().min(2).max(200),
      code: z.string().min(2).max(24),
      clientId: z.string().min(10),
      description: z.string().max(6000).optional(),
      managerMembershipId: z.string().optional(),
      status: z.enum(['planning', 'active', 'on_hold', 'completed', 'archived']).optional(),
      contractType: z.enum(['fixed_price', 'hourly', 'daily', 'retainer']).optional(),
      currency: z.string().length(3).optional(),
      contractAmount: z.number().min(0).optional(),
      estimatedHours: z.number().min(0).max(100000).optional(),
      hourlyRate: z.number().min(0).max(10000).optional(),
      internalCostRate: z.number().min(0).max(10000).optional(),
      startDate: z.string().datetime().optional(),
      targetEndDate: z.string().datetime().optional(),
      workingDays: z.array(z.number().min(0).max(6)).max(7).optional(),
      holidays: z.array(z.string().max(10)).max(60).optional(),
      hoursPerPersonDay: z.number().min(1).max(16).optional(),
      revisionPolicies: z.array(z.object({ deliverable: z.string().min(1).max(160), included: z.number().min(0).max(100) })).max(30).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const client = await Client.findOne({ _id: req.body.clientId, org: req.org!.orgId, deletedAt: null }).lean();
    if (!client) throw notFound('Client not found.');

    const code = req.body.code.toUpperCase().trim();
    const duplicate = await Project.findOne({ org: req.org!.orgId, code }).lean();
    if (duplicate) throw badRequest(`Project code "${code}" is already used in this organization.`);

    const project = await Project.create({
      org: req.org!.orgId,
      code,
      name: req.body.name,
      description: req.body.description ?? '',
      client: client._id,
      manager: req.auth!.userId,
      status: req.body.status ?? 'planning',
      contractType: req.body.contractType ?? 'fixed_price',
      currency: (req.body.currency ?? client.currency ?? 'USD').toUpperCase(),
      contractAmountMinor: Math.round((req.body.contractAmount ?? 0) * 100),
      estimatedHours: req.body.estimatedHours ?? 0,
      hourlyRate: req.body.hourlyRate ?? 0,
      internalCostRate: req.body.internalCostRate ?? 0,
      startDate: req.body.startDate ? new Date(req.body.startDate) : null,
      targetEndDate: req.body.targetEndDate ? new Date(req.body.targetEndDate) : null,
      workingDays: req.body.workingDays ?? [1, 2, 3, 4, 5],
      holidays: req.body.holidays ?? [],
      hoursPerPersonDay: req.body.hoursPerPersonDay ?? 6,
      revisionPolicies: req.body.revisionPolicies ?? [],
      createdBy: req.auth!.userId,
    });

    await recordAudit({
      org: req.org!.orgId,
      action: AUDIT_ACTIONS.projectCreated,
      actor: { kind: 'user', userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email },
      entity: { type: 'Project', id: String(project._id), label: `${project.code} — ${project.name}` },
      meta: { clientId: String(client._id), contractType: project.contractType },
      ip: req.ip,
      userAgent: req.header('user-agent'),
    });

    res.status(201).json({ project });
  }),
);

projectRouter.get(
  '/:projectId',
  requirePermission('project.view'),
  asyncHandler(async (req, res) => {
    const project = await loadProject(req, String(req.params.projectId ?? ''));
    const [client, baseline, manager, counts] = await Promise.all([
      Client.findById(project.client).select('name company contactName contactEmail').lean(),
      project.currentBaseline ? BaselineVersion.findById(project.currentBaseline).lean() : null,
      User.findById(project.manager).select('name email').lean(),
      ChangeRequest.aggregate([
        { $match: { project: project._id } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            open: { $sum: { $cond: [{ $in: ['$status', ['submitted', 'under_review', 'clarification_required', 'classified', 'estimating', 'internal_review']] }, 1, 0] } },
            awaitingClient: { $sum: { $cond: [{ $eq: ['$status', 'awaiting_client_decision'] }, 1, 0] } },
            unapprovedHours: { $sum: '$outcome.unapprovedHours' },
          },
        },
      ]),
    ]);

    res.json({
      project,
      client,
      manager,
      currentBaseline: baseline
        ? {
            id: String(baseline._id),
            version: baseline.version,
            status: baseline.status,
            snapshotHash: baseline.snapshotHash,
            approvedAt: baseline.approvedAt,
            requirementCount: baseline.snapshot.requirements.filter((r) => r.kind === 'requirement').length,
            exclusionCount: baseline.snapshot.requirements.filter((r) => r.kind === 'exclusion').length,
            objectives: baseline.snapshot.objectives,
            milestones: baseline.snapshot.milestones,
            budget: baseline.snapshot.budget,
          }
        : null,
      counts: counts[0]
        ? { total: counts[0].total, open: counts[0].open, awaitingClient: counts[0].awaitingClient, unapprovedHours: counts[0].unapprovedHours ?? 0 }
        : { total: 0, open: 0, awaitingClient: 0, unapprovedHours: 0 },
      revisionUsage: project.revisionPolicies.map((policy) => ({
        deliverable: policy.deliverable,
        included: policy.included,
        used: project.revisionRounds.filter((r) => r.deliverable === policy.deliverable).length,
      })),
    });
  }),
);

projectRouter.patch(
  '/:projectId',
  ...mutating,
  requirePermission('project.update'),
  validate({
    body: z.object({
      name: z.string().min(2).max(200).optional(),
      description: z.string().max(6000).optional(),
      status: z.enum(['planning', 'active', 'on_hold', 'completed', 'archived']).optional(),
      contractType: z.enum(['fixed_price', 'hourly', 'daily', 'retainer']).optional(),
      contractAmount: z.number().min(0).optional(),
      estimatedHours: z.number().min(0).max(100000).optional(),
      hourlyRate: z.number().min(0).max(10000).optional(),
      internalCostRate: z.number().min(0).max(10000).optional(),
      startDate: z.string().datetime().nullable().optional(),
      targetEndDate: z.string().datetime().nullable().optional(),
      workingDays: z.array(z.number().min(0).max(6)).max(7).optional(),
      holidays: z.array(z.string().max(10)).max(60).optional(),
      hoursPerPersonDay: z.number().min(1).max(16).optional(),
      revisionPolicies: z.array(z.object({ deliverable: z.string().min(1).max(160), included: z.number().min(0).max(100) })).max(30).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const project = await Project.findOne({ _id: String(req.params.projectId ?? ''), org: req.org!.orgId, deletedAt: null });
    if (!project) throw notFound('Project not found.');
    assertProjectInScope(req, String(project._id));

    const changes: { field: string; from: string; to: string }[] = [];
    const simple: [string, unknown][] = [
      ['name', req.body.name], ['description', req.body.description], ['status', req.body.status],
      ['contractType', req.body.contractType], ['estimatedHours', req.body.estimatedHours],
      ['hourlyRate', req.body.hourlyRate], ['internalCostRate', req.body.internalCostRate],
      ['hoursPerPersonDay', req.body.hoursPerPersonDay],
    ];
    for (const [key, value] of simple) {
      if (value === undefined) continue;
      const before = String((project as unknown as Record<string, unknown>)[key] ?? '');
      if (before !== String(value)) changes.push({ field: key, from: before.slice(0, 120), to: String(value).slice(0, 120) });
      (project as unknown as Record<string, unknown>)[key] = value;
    }
    if (req.body.contractAmount !== undefined) {
      const minor = Math.round(req.body.contractAmount * 100);
      if (minor !== project.contractAmountMinor) {
        changes.push({ field: 'contractAmountMinor', from: String(project.contractAmountMinor), to: String(minor) });
        project.contractAmountMinor = minor;
      }
    }
    if (req.body.startDate !== undefined) project.startDate = req.body.startDate ? new Date(req.body.startDate) : null;
    if (req.body.targetEndDate !== undefined) project.targetEndDate = req.body.targetEndDate ? new Date(req.body.targetEndDate) : null;
    if (req.body.workingDays) project.workingDays = req.body.workingDays;
    if (req.body.holidays) project.holidays = req.body.holidays;
    if (req.body.revisionPolicies) {
      project.revisionPolicies = req.body.revisionPolicies;
      changes.push({ field: 'revisionPolicies', from: 'previous', to: JSON.stringify(req.body.revisionPolicies).slice(0, 120) });
    }
    await project.save();

    if (changes.length) {
      await recordAudit({
        org: req.org!.orgId,
        action: req.body.status ? AUDIT_ACTIONS.projectStatusChanged : AUDIT_ACTIONS.projectUpdated,
        actor: { kind: 'user', userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email },
        entity: { type: 'Project', id: String(project._id), label: `${project.code} — ${project.name}` },
        changes,
        ip: req.ip,
        userAgent: req.header('user-agent'),
      });
    }
    res.json({ project });
  }),
);

/** Record a revision round against a deliverable's allowance. */
projectRouter.post(
  '/:projectId/revisions',
  ...mutating,
  requirePermission('project.update'),
  validate({
    body: z.object({
      deliverable: z.string().min(1).max(160),
      note: z.string().max(400).optional(),
      requestId: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const project = await Project.findOne({ _id: String(req.params.projectId ?? ''), org: req.org!.orgId, deletedAt: null });
    if (!project) throw notFound('Project not found.');
    const policy = project.revisionPolicies.find((p) => p.deliverable.toLowerCase() === req.body.deliverable.toLowerCase());
    if (!policy) throw badRequest(`No revision allowance is configured for "${req.body.deliverable}". Add one on the project first.`);
    const existing = project.revisionRounds.filter((r) => r.deliverable.toLowerCase() === req.body.deliverable.toLowerCase());
    const roundNumber = existing.length + 1;
    project.revisionRounds.push({
      deliverable: policy.deliverable,
      roundNumber,
      note: req.body.note ?? '',
      request: req.body.requestId ? new mongoose.Types.ObjectId(req.body.requestId) : null,
      recordedBy: new mongoose.Types.ObjectId(req.auth!.userId),
      recordedAt: new Date(),
    });
    await project.save();

    res.status(201).json({
      recorded: { deliverable: policy.deliverable, roundNumber, included: policy.included, remaining: Math.max(0, policy.included - roundNumber) },
      exhausted: roundNumber >= policy.included,
    });
  }),
);

/** Scope health for a project, with every contributing factor exposed. */
projectRouter.get(
  '/:projectId/health',
  requirePermission('project.view'),
  asyncHandler(async (req, res) => {
    const project = await loadProject(req, String(req.params.projectId ?? ''));
    const baseline = project.currentBaseline ? await BaselineVersion.findById(project.currentBaseline).lean() : null;
    const requirements = baseline?.snapshot.requirements ?? [];
    const [openCount, pendingDecisions, unapprovedAgg, approvedOrders, timeAgg] = await Promise.all([
      ChangeRequest.countDocuments({ project: project._id, status: { $in: ['submitted', 'under_review', 'clarification_required', 'classified', 'estimating', 'internal_review'] } }),
      ChangeOrder.countDocuments({ project: project._id, status: 'sent' }),
      ChangeRequest.aggregate([{ $match: { project: project._id } }, { $group: { _id: null, hours: { $sum: '$outcome.unapprovedHours' } } }]),
      ChangeOrder.countDocuments({ project: project._id, status: 'accepted' }),
      TimeEntry.aggregate([
        { $match: { project: project._id } },
        { $group: { _id: null, actual: { $sum: '$hours' } } },
      ]),
    ]);

    const estimateAgg = await ChangeRequest.aggregate([
      { $match: { project: project._id } },
      { $group: { _id: null, estimated: { $sum: '$effort.estimatedHours' } } },
    ]);
    const actual = timeAgg[0]?.actual ?? 0;
    const estimated = estimateAgg[0]?.estimated ?? 0;
    const variance = estimated > 0 ? ((actual - estimated) / estimated) * 100 : null;

    const health = computeScopeHealth({
      requirementCount: requirements.filter((r) => r.kind === 'requirement').length,
      requirementsWithoutAcceptanceCriteria: requirements.filter((r) => r.kind === 'requirement' && (r.acceptanceCriteria?.length ?? 0) === 0).length,
      exclusionCount: requirements.filter((r) => r.kind === 'exclusion').length,
      ambiguousRequirementCount: requirements.filter((r) => r.ambiguous).length,
      unresolvedRequestCount: openCount,
      unapprovedWorkHours: unapprovedAgg[0]?.hours ?? 0,
      approvedChangeCount: approvedOrders,
      revisionsExhaustedDeliverables: project.revisionPolicies.filter(
        (p) => project.revisionRounds.filter((r) => r.deliverable === p.deliverable).length >= p.included,
      ).length,
      estimateVariancePct: variance,
      pendingClientDecisions: pendingDecisions,
      averageApprovalTurnaroundDays: null,
      hasApprovedBaseline: Boolean(project.currentBaseline),
    });

    await Project.updateOne({ _id: project._id }, { $set: { healthScore: health.score, healthBand: health.band, healthComputedAt: new Date() } });
    res.json({ health, computedFrom: { openRequests: openCount, pendingDecisions, actualHours: actual, estimatedHours: estimated } });
  }),
);
