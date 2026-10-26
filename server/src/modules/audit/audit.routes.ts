import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../platform/http';
import { authenticate } from '../../middleware/auth';
import { requireOrg } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { parsePagination, paginated } from '../../platform/http';
import { AuditEvent } from '../../models';
import { verifyAuditChain } from '../../platform/audit';

export const auditRouter = Router();
auditRouter.use(authenticate, requireOrg);

/** Org-scoped, append-only audit trail. Readable by owners and explicitly-granted roles only. */
auditRouter.get(
  '/audit-events',
  requirePermission('org.view_audit'),
  validate({
    query: z.object({
      page: z.string().optional(),
      pageSize: z.string().optional(),
      action: z.string().max(80).optional(),
      entityType: z.string().max(60).optional(),
      entityId: z.string().max(60).optional(),
      actorUserId: z.string().max(60).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const { page, pageSize, skip } = parsePagination(query);

    const filter: Record<string, unknown> = { org: req.org!.orgId };
    if (query.action) filter.action = query.action;
    if (query.entityType) filter['entity.type'] = query.entityType;
    if (query.entityId) filter['entity.id'] = query.entityId;
    if (query.actorUserId) filter['actor.userId'] = query.actorUserId;
    if (query.from || query.to) {
      filter.createdAt = {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(query.to) } : {}),
      };
    }

    const [events, total] = await Promise.all([
      AuditEvent.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
      AuditEvent.countDocuments(filter),
    ]);

    res.json(
      paginated(
        events.map((e) => ({
          id: String(e._id),
          action: e.action,
          actor: e.actor,
          entity: e.entity,
          changes: e.changes ?? [],
          meta: e.meta ?? {},
          ip: e.ip ?? '',
          createdAt: e.createdAt,
          seq: e.seq,
        })),
        total,
        { page, pageSize, skip },
      ),
    );
  }),
);

/** One record's story, oldest first — the view you open during a client dispute. */
auditRouter.get(
  '/audit-events/timeline',
  requirePermission('org.view_audit'),
  validate({ query: z.object({ entityType: z.string().max(60), entityId: z.string().max(60) }) }),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const events = await AuditEvent.find({
      org: req.org!.orgId,
      $or: [
        { 'entity.type': query.entityType, 'entity.id': query.entityId },
        { 'meta.request': query.entityId },
        { 'meta.project': query.entityId },
        { 'meta.changeOrder': query.entityId },
      ],
    })
      .sort({ createdAt: 1, _id: 1 })
      .limit(500)
      .lean();
    res.json({
      entityType: query.entityType,
      entityId: query.entityId,
      events,
      note: 'Events are append-only. Nothing in this list can be edited or deleted through the application.',
    });
  }),
);

/**
 * Integrity check of the hash chain for this organization.
 * Honest about its limits: the chain detects edits and deletions, but concurrent writes can
 * fork it (see docs/PLAN.md), and a fork is reported rather than hidden.
 */
auditRouter.get(
  '/audit-events/verify',
  requirePermission('org.view_audit'),
  asyncHandler(async (req, res) => {
    const result = await verifyAuditChain(req.org!.orgId);
    res.json({
      ...result,
      caveat:
        'This verifies the stored hash chain for this organization. It detects modification or removal of stored events. Writes are not concurrency-hardened, so a reported break should be investigated in context rather than assumed to be tampering.',
    });
  }),
);
