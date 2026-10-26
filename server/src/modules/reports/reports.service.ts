import mongoose from 'mongoose';
import { ApprovalDecision, BaselineVersion, ChangeOrder, ChangeRequest, Client, EffortEstimate, Project, ScopeAnalysis, TimeEntry } from '../../models';
import { formatMoney, money, sumMoney, toMajor, type Money } from '../../domain/money';

/**
 * Financial and operational reporting.
 *
 * The labelling discipline here is the whole point of the module. Three quantities are
 * routinely conflated in agency tools and they mean very different things:
 *
 *   potentialAdditionalValue  work requested or delivered that is NOT approved and NOT an invoice.
 *                             It is an exposure figure used to start a conversation. It must
 *                             never appear as revenue, pipeline, or expected income.
 *   approvedValue             the sum of change orders a client has actually accepted. This is
 *                             contract value — it is still not cash.
 *   collectedValue            cash received. ScopeShield does not integrate with accounting
 *                             software, so this is reported as UNTRACKED rather than estimated.
 *
 * Internal labour cost comes from recorded time at the project's internal cost rate, which is
 * deliberately separate from the client-facing billing rate.
 */

export type Money_json = { amount: number; currency: string; formatted: string };

const asJson = (m: Money): Money_json => ({ amount: m.amount, currency: m.currency, formatted: formatMoney(m) });

export interface UnapprovedWorkRow {
  requestId: string;
  ref: string;
  title: string;
  status: string;
  classification: string | null;
  hours: number;
  billableHours: number;
  ageDays: number;
  estimatedValueMinor: number;
  currency: string;
  estimatedValueFormatted: string;
  confidence: 'none' | 'estimate_exists' | 'analysis_hint_only';
}

/**
 * Unapproved work: hours already spent on requests that never received client authorisation.
 * The value shown is estimated from the request's final estimate where one exists, and is
 * explicitly flagged as low-confidence otherwise.
 */
export async function unapprovedWork(orgId: string, opts: { projectId?: string | null; from?: Date | null; to?: Date | null } = {}) {
  const match: Record<string, unknown> = { org: new mongoose.Types.ObjectId(orgId) };
  if (opts.projectId) match.project = new mongoose.Types.ObjectId(opts.projectId);
  if (opts.from || opts.to) {
    match.date = { ...(opts.from ? { $gte: opts.from } : {}), ...(opts.to ? { $lte: opts.to } : {}) };
  }

  const entries = await TimeEntry.find(match).lean();
  const unapproved = entries.filter((e) => !e.approvedAtEntry);
  const byRequest = new Map<string, { hours: number; billableHours: number }>();
  for (const entry of unapproved) {
    const key = entry.request ? String(entry.request) : '(no request)';
    const current = byRequest.get(key) ?? { hours: 0, billableHours: 0 };
    current.hours += entry.hours;
    if (entry.billable) current.billableHours += entry.hours;
    byRequest.set(key, current);
  }

  const requestIds = [...byRequest.keys()].filter((k) => k !== '(no request)');
  const requests = await ChangeRequest.find({ _id: { $in: requestIds }, org: orgId }).lean();
  const requestById = new Map(requests.map((r) => [String(r._id), r]));
  const estimates = await EffortEstimate.find({ request: { $in: requestIds }, status: 'final' }).lean();
  const estimateByRequest = new Map(estimates.map((e) => [String(e.request), e]));

  const rows: UnapprovedWorkRow[] = [];
  const currency = (
    await Project.findOne({ _id: opts.projectId ?? { $exists: true }, org: orgId }).select('currency').lean()
  )?.currency ?? 'USD';
  const perCurrency = new Map<string, Money>();

  for (const [key, totals] of byRequest) {
    const request = requestById.get(key);
    const estimate = estimateByRequest.get(key);
    const rateMinor = estimate ? Math.round((estimate.billingRate ?? 0) * 100) * 100 : 0;
    const valueMinor = estimate ? Math.round(totals.billableHours * rateMinor) : 0;
    const rowCurrency = estimate?.currency ?? currency;
    if (estimate) {
      const current = perCurrency.get(rowCurrency) ?? money(0, rowCurrency);
      perCurrency.set(rowCurrency, { amount: current.amount + valueMinor, currency: rowCurrency });
    }
    rows.push({
      requestId: key,
      ref: request?.ref ?? '',
      title: request?.title ?? 'Time logged without a request',
      status: request?.status ?? 'unknown',
      classification: request?.classification ?? null,
      hours: Math.round(totals.hours * 100) / 100,
      billableHours: Math.round(totals.billableHours * 100) / 100,
      ageDays: request?.createdAt ? Math.round((Date.now() - new Date(request.createdAt).getTime()) / 86_400_000) : 0,
      estimatedValueMinor: valueMinor,
      currency: rowCurrency,
      estimatedValueFormatted: estimate ? formatMoney(money(valueMinor, rowCurrency)) : 'No final estimate — value cannot be stated',
      confidence: estimate ? 'estimate_exists' : request?.classification ? 'analysis_hint_only' : 'none',
    });
  }
  rows.sort((a, b) => b.hours - a.hours);

  const totalHours = rows.reduce((s, r) => s + r.hours, 0);
  const estimatesForValue = money(0, currency);
  let exposure = estimatesForValue;
  for (const m of perCurrency.values()) exposure = sumMoney([exposure, m], m.currency);

  return {
    rows,
    totals: {
      requests: rows.length,
      hours: Math.round(totalHours * 100) / 100,
      billableHours: Math.round(rows.reduce((s, r) => s + r.billableHours, 0) * 100) / 100,
      exposure: asJson(exposure),
      requestsWithoutEstimate: rows.filter((r) => r.confidence !== 'estimate_exists').length,
    },
    labels: {
      title: 'Unapproved work',
      exposureDefinition:
        'Potential additional value. This is NOT approved revenue, NOT an invoice, and NOT a receivable. It is work already delivered or in progress that has no recorded client authorisation.',
      notIncluded:
        'Hours are only valued where a final estimate exists. Requests without an estimate are listed with hours but no monetary figure, because inventing a price for them would be misleading.',
    },
    window: { from: opts.from ?? null, to: opts.to ?? null, projectId: opts.projectId ?? null },
  };
}

/** Profitability per project: contract value, approved change value, internal delivery cost. */
export async function projectProfitability(orgId: string, opts: { projectId?: string | null } = {}) {
  const projectFilter: Record<string, unknown> = { org: orgId, deletedAt: null };
  if (opts.projectId) projectFilter._id = new mongoose.Types.ObjectId(opts.projectId);
  const projects = await Project.find(projectFilter).lean();
  const clients = await Client.find({ org: orgId }).select('name').lean();
  const clientById = new Map(clients.map((c) => [String(c._id), c.name]));

  const results = [];
  for (const project of projects) {
    const [entries, acceptedOrders, acceptedDraftValue, requestCount, baselineCount, unapprovedHours] = await Promise.all([
      TimeEntry.find({ org: orgId, project: project._id }).lean(),
      ChangeOrder.find({ org: orgId, project: project._id, status: 'accepted' }).lean(),
      ChangeOrder.find({ org: orgId, project: project._id, status: 'sent' }).lean(),
      ChangeRequest.countDocuments({ org: orgId, project: project._id }),
      BaselineVersion.countDocuments({ org: orgId, project: project._id, status: { $in: ['approved', 'superseded'] } }),
      TimeEntry.aggregate([
        { $match: { org: new mongoose.Types.ObjectId(orgId), project: project._id, loggedWithoutApproval: true } },
        { $group: { _id: null, hours: { $sum: '$hours' } } },
      ]),
    ]);

    const loggedHours = entries.reduce((s, e) => s + e.hours, 0);
    const internalCostMinor = Math.round(project.internalCostRate * loggedHours * 100);
    const currency = project.currency;
    const contract = money(project.contractAmountMinor, currency);
    const approvedChange = money(
      acceptedOrders.reduce((s, o) => s + (o.pricing?.total?.amount ?? 0), 0),
      currency,
    );
    const pendingChange = money(
      acceptedDraftValue.reduce((s, o) => s + (o.pricing?.total?.amount ?? 0), 0),
      currency,
    );
    const internalCost = money(internalCostMinor, currency);
    const totalContract = sumMoney([contract, approvedChange], currency);
    const grossMargin = money(totalContract.amount - internalCost.amount, currency);
    const marginPct = totalContract.amount > 0 ? Math.round((grossMargin.amount / totalContract.amount) * 1000) / 10 : null;

    results.push({
      projectId: String(project._id),
      code: project.code,
      name: project.name,
      clientName: clientById.get(String(project.client)) ?? '',
      status: project.status,
      billingModel: project.contractType,
      currency,
      healthScore: project.healthScore,
      healthBand: project.healthBand,
      values: {
        originalContract: asJson(contract),
        approvedChanges: asJson(approvedChange),
        currentContractValue: asJson(totalContract),
        pendingClientDecision: asJson(pendingChange),
        internalDeliveryCost: asJson(internalCost),
        grossMargin: asJson(grossMargin),
        grossMarginPct: marginPct,
        collected: null,
      },
      effort: {
        loggedHours: Math.round(loggedHours * 100) / 100,
        unapprovedHours: Math.round((unapprovedHours[0]?.hours ?? 0) * 100) / 100,
        internalCostRate: project.internalCostRate,
        billingRate: project.hourlyRate,
      },
      counts: { requests: requestCount, baselineVersions: baselineCount, acceptedChangeOrders: acceptedOrders.length },
    });
  }

  const currency = results[0]?.currency ?? 'USD';
  const portfolio = results.reduce(
    (acc, row) => ({
      currentContractValueMinor: acc.currentContractValueMinor + row.values.currentContractValue.amount,
      approvedChangesMinor: acc.approvedChangesMinor + row.values.approvedChanges.amount,
      internalCostMinor: acc.internalCostMinor + row.values.internalDeliveryCost.amount,
      pendingMinor: acc.pendingMinor + row.values.pendingClientDecision.amount,
      loggedHours: acc.loggedHours + row.effort.loggedHours,
      unapprovedHours: acc.unapprovedHours + row.effort.unapprovedHours,
    }),
    { currentContractValueMinor: 0, approvedChangesMinor: 0, internalCostMinor: 0, pendingMinor: 0, loggedHours: 0, unapprovedHours: 0 },
  );

  return {
    projects: results,
    portfolio: {
      currency,
      currentContractValue: asJson(money(portfolio.currentContractValueMinor, currency)),
      approvedChanges: asJson(money(portfolio.approvedChangesMinor, currency)),
      internalDeliveryCost: asJson(money(portfolio.internalCostMinor, currency)),
      grossMargin: asJson(money(portfolio.currentContractValueMinor - portfolio.internalCostMinor, currency)),
      grossMarginPct:
        portfolio.currentContractValueMinor > 0
          ? Math.round(((portfolio.currentContractValueMinor - portfolio.internalCostMinor) / portfolio.currentContractValueMinor) * 1000) / 10
          : null,
      pendingClientDecision: asJson(money(portfolio.pendingMinor, currency)),
      loggedHours: Math.round(portfolio.loggedHours * 100) / 100,
      unapprovedHours: Math.round(portfolio.unapprovedHours * 100) / 100,
    },
    labels: {
      approvedChanges: 'Accepted by the client. Contract value, not cash received.',
      pendingClientDecision: 'Sent to the client and awaiting a recorded decision. Not yet contract value.',
      internalDeliveryCost: 'Recorded hours × the project’s internal cost rate. Internal only — never shown to clients.',
      collected: 'UNTRACKED. ScopeShield has no accounting integration, so cash received is not estimated or inferred. Use your invoicing system for that figure.',
    },
  };
}

/** Change-request throughput and classification mix, for the operations dashboard. */
export async function requestFlow(orgId: string, opts: { from?: Date | null; to?: Date | null; projectId?: string | null } = {}) {
  const match: Record<string, unknown> = { org: new mongoose.Types.ObjectId(orgId) };
  if (opts.projectId) match.project = new mongoose.Types.ObjectId(opts.projectId);
  if (opts.from || opts.to) {
    match.createdAt = { ...(opts.from ? { $gte: opts.from } : {}), ...(opts.to ? { $lte: opts.to } : {}) };
  }

  const [byStatus, byCategory, decisions, analyses] = await Promise.all([
    ChangeRequest.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ChangeRequest.aggregate([{ $match: match }, { $group: { _id: '$classification', count: { $sum: 1 } } }]),
    ApprovalDecision.aggregate([{ $match: { org: new mongoose.Types.ObjectId(orgId) } }, { $group: { _id: '$decision', count: { $sum: 1 } } }]),
    ScopeAnalysis.aggregate([
      { $match: { org: new mongoose.Types.ObjectId(orgId) } },
      { $group: { _id: '$mode', count: { $sum: 1 } } },
    ]),
  ]);

  return {
    byStatus: Object.fromEntries(byStatus.map((r) => [String(r._id), r.count])),
    byCategory: Object.fromEntries(byCategory.map((r) => [String(r._id ?? 'unclassified'), r.count])),
    decisions: Object.fromEntries(decisions.map((r) => [String(r._id), r.count])),
    analysisModes: Object.fromEntries(analyses.map((r) => [String(r._id), r.count])),
    note: 'Analysis modes show how many requests were classified deterministically, hybrid, or via fallback.',
  };
}

export function windowFromQuery(from?: string | null, to?: string | null) {
  return {
    from: from ? new Date(from) : null,
    to: to ? new Date(to) : null,
  };
}

export { toMajor };
