import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, paginated, parsePagination } from '../../platform/http';
import { authenticate } from '../../middleware/auth';
import { requireOrg } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { verifyCsrf } from '../../middleware/csrf';
import { notFound } from '../../platform/errors';
import { recordAudit } from '../../platform/audit';
import { AUDIT_ACTIONS } from '../../config/constants';
import { ApprovalDecision, ChangeOrder, Client, Project } from '../../models';

export const clientRouter = Router();

const mutating = [authenticate, verifyCsrf] as const;

clientRouter.use(authenticate, requireOrg);

clientRouter.get(
  '/',
  requirePermission('client.view'),
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const filter: Record<string, unknown> = { org: req.org!.orgId, deletedAt: null };
    if (req.query.status === 'active' || req.query.status === 'archived') filter.status = req.query.status;
    if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { company: new RegExp(search, 'i') }, { contactEmail: new RegExp(search, 'i') }];

    const [items, total] = await Promise.all([
      Client.find(filter).sort({ name: 1 }).skip(pagination.skip).limit(pagination.pageSize).lean(),
      Client.countDocuments(filter),
    ]);
    // Project counts per client, in one aggregation rather than N queries.
    const counts = await Project.aggregate([
      { $match: { org: (await import('mongoose')).Types.ObjectId.createFromHexString(req.org!.orgId), deletedAt: null } },
      { $group: { _id: '$client', projects: { $sum: 1 }, activeProjects: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } },
    ]);
    const countById = new Map(counts.map((c) => [String(c._id), c]));

    res.json(
      paginated(
        items.map((c) => ({
          id: String(c._id),
          name: c.name,
          company: c.company,
          contactName: c.contactName,
          contactEmail: c.contactEmail,
          status: c.status,
          tags: c.tags,
          approvals: c.approvals,
          projects: countById.get(String(c._id))?.projects ?? 0,
          activeProjects: countById.get(String(c._id))?.activeProjects ?? 0,
          createdAt: c.createdAt,
        })),
        total,
        pagination,
      ),
    );
  }),
);

clientRouter.post(
  '/',
  ...mutating,
  requirePermission('client.manage'),
  validate({
    body: z.object({
      name: z.string().min(2).max(160),
      company: z.string().max(160).optional(),
      contactName: z.string().max(120).optional(),
      contactEmail: z.union([z.string().email().max(200), z.literal('')]).optional(),
      contactPhone: z.string().max(40).optional(),
      address: z.string().max(400).optional(),
      internalNotes: z.string().max(4000).optional(),
      currency: z.string().length(3).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const client = await Client.create({
      ...req.body,
      org: req.org!.orgId,
      createdBy: req.auth!.userId,
    });
    await recordAudit({
      org: req.org!.orgId,
      action: AUDIT_ACTIONS.clientCreated,
      actor: { kind: 'user', userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email },
      entity: { type: 'Client', id: String(client._id), label: client.name },
      ip: req.ip,
      userAgent: req.header('user-agent'),
    });
    res.status(201).json({ client });
  }),
);

clientRouter.get(
  '/:clientId',
  requirePermission('client.view'),
  asyncHandler(async (req, res) => {
    const client = await Client.findOne({ _id: req.params.clientId, org: req.org!.orgId, deletedAt: null }).lean();
    if (!client) throw notFound('Client not found.');
    const projects = await Project.find({ org: req.org!.orgId, client: client._id, deletedAt: null })
      .select('name code status targetEndDate contractAmountMinor currency')
      .sort({ updatedAt: -1 })
      .lean();
    // Decision history relevant to this client (client-safe fields only).
    const decisions = await ApprovalDecision.find({ org: req.org!.orgId, project: { $in: projects.map((p) => p._id) } })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    const orders = await ChangeOrder.find({ org: req.org!.orgId, client: client._id })
      .select('number title status option pricing.total sentAt decision.outcome')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json({ client, projects, decisions, changeOrders: orders });
  }),
);

clientRouter.patch(
  '/:clientId',
  ...mutating,
  requirePermission('client.manage'),
  validate({
    body: z.object({
      name: z.string().min(2).max(160).optional(),
      company: z.string().max(160).optional(),
      contactName: z.string().max(120).optional(),
      contactEmail: z.union([z.string().email().max(200), z.literal('')]).optional(),
      contactPhone: z.string().max(40).optional(),
      address: z.string().max(400).optional(),
      internalNotes: z.string().max(4000).optional(),
      status: z.enum(['active', 'archived']).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      currency: z.string().length(3).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const client = await Client.findOne({ _id: req.params.clientId, org: req.org!.orgId, deletedAt: null });
    if (!client) throw notFound('Client not found.');

    const changes: { field: string; from: string; to: string }[] = [];
    for (const [key, value] of Object.entries(req.body)) {
      if (value === undefined) continue;
      const before = String((client as unknown as Record<string, unknown>)[key] ?? '');
      const after = String(value);
      if (before !== after) {
        changes.push({ field: key, from: before.slice(0, 120), to: after.slice(0, 120) });
        (client as unknown as Record<string, unknown>)[key] = value;
      }
    }
    await client.save();

    if (changes.length) {
      await recordAudit({
        org: req.org!.orgId,
        action: AUDIT_ACTIONS.clientUpdated,
        actor: { kind: 'user', userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email },
        entity: { type: 'Client', id: String(client._id), label: client.name },
        changes,
        ip: req.ip,
        userAgent: req.header('user-agent'),
      });
    }
    res.json({ client });
  }),
);

clientRouter.delete(
  '/:clientId',
  ...mutating,
  requirePermission('client.manage'),
  asyncHandler(async (req, res) => {
    const client = await Client.findOne({ _id: req.params.clientId, org: req.org!.orgId, deletedAt: null });
    if (!client) throw notFound('Client not found.');
    const projectCount = await Project.countDocuments({ org: req.org!.orgId, client: client._id, deletedAt: null });
    if (projectCount > 0) {
      // Soft delete only: financial and approval history must survive.
      client.status = 'archived';
      client.deletedAt = new Date();
      await client.save();
      res.json({ ok: true, softDeleted: true, reason: `${projectCount} project(s) reference this client; archived instead of deleted.` });
      return;
    }
    client.deletedAt = new Date();
    client.status = 'archived';
    await client.save();
    res.json({ ok: true, softDeleted: true });
  }),
);
