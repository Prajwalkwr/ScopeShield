import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../platform/http';
import { authenticate } from '../../middleware/auth';
import { requireOrg } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { projectProfitability, requestFlow, unapprovedWork, windowFromQuery } from './reports.service';

export const reportsRouter = Router();
reportsRouter.use(authenticate, requireOrg);

const windowSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  projectId: z.string().optional(),
});

/**
 * Unapproved work. Available to anyone with report.view — this is the report that protects the
 * agency, so hiding it behind a financial permission would be counter-productive. The exposure
 * figure is labelled as potential, never as revenue.
 */
reportsRouter.get(
  '/reports/unapproved-work',
  requirePermission('report.view'),
  validate({ query: windowSchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof windowSchema>;
    const { from, to } = windowFromQuery(query.from ?? null, query.to ?? null);
    const report = await unapprovedWork(req.org!.orgId, { projectId: query.projectId ?? null, from, to });
    res.json(report);
  }),
);

/** Profitability. Internal cost and margin data — gated behind report.view_financials. */
reportsRouter.get(
  '/reports/profitability',
  requirePermission('report.view_financials'),
  validate({ query: windowSchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof windowSchema>;
    const report = await projectProfitability(req.org!.orgId, { projectId: query.projectId ?? null });
    res.json(report);
  }),
);

reportsRouter.get(
  '/reports/request-flow',
  requirePermission('report.view'),
  validate({ query: windowSchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof windowSchema>;
    const { from, to } = windowFromQuery(query.from ?? null, query.to ?? null);
    res.json(await requestFlow(req.org!.orgId, { from, to, projectId: query.projectId ?? null }));
  }),
);

/**
 * CSV export of the unapproved-work report. Generated server-side from real records; the
 * export itself is an audited event because financial data leaving the system matters.
 */
reportsRouter.get(
  '/reports/unapproved-work.csv',
  requirePermission('report.export'),
  asyncHandler(async (req, res) => {
    const { recordAudit } = await import('../../platform/audit');
    const { AUDIT_ACTIONS } = await import('../../config/constants');
    const report = await unapprovedWork(req.org!.orgId, { projectId: (req.query.projectId as string) ?? null });

    const header = ['request_ref', 'title', 'status', 'classification', 'hours', 'billable_hours', 'age_days', 'estimated_value', 'currency', 'confidence'];
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const lines = [
      header.join(','),
      ...report.rows.map((row) =>
        [
          row.ref,
          row.title,
          row.status,
          row.classification ?? 'unclassified',
          String(row.hours),
          String(row.billableHours),
          String(row.ageDays),
          row.confidence === 'estimate_exists' ? (row.estimatedValueMinor / 100).toFixed(2) : '',
          row.currency,
          row.confidence,
        ]
          .map((v) => escape(String(v)))
          .join(','),
      ),
      '',
      escape('NOTE: estimated_value is potential additional value, not approved revenue or an invoice. Blank where no final estimate exists.'),
    ];

    await recordAudit({
      org: req.org!.orgId,
      action: AUDIT_ACTIONS.exportGenerated,
      actor: { kind: 'user', userId: req.auth!.userId, name: req.auth!.user.name, email: req.auth!.user.email },
      entity: { type: 'Report', id: 'unapproved-work', label: 'unapproved-work.csv' },
      meta: { rows: report.rows.length, projectId: (req.query.projectId as string) ?? null },
      ip: req.ip,
      userAgent: req.header('user-agent'),
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="scopeshield-unapproved-work.csv"');
    res.send(lines.join('\n'));
  }),
);
