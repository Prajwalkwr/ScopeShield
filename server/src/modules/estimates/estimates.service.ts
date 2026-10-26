/**
 * Effort estimation.
 *
 * Three rules shape this module:
 *
 *  1. Internal labour cost and client-facing price are separate numbers. They are stored side by
 *     side precisely so they are never confused; the client-facing document is generated from the
 *     price fields only.
 *  2. Every revision is a new immutable version. A number a client was shown must remain
 *     reconstructible after somebody edits it.
 *  3. Hours may be suggested by the analysis hints, but a human commits them. An estimate is only
 *     'final' when a person with the permission says so, and finalising is what lets a change
 *     order be built from it.
 */
import { Types } from 'mongoose';
import { ChangeRequest } from '../../models/changeRequest.model';
import { Project } from '../../models/project.model';
import { ScopeAnalysis } from '../../models/scopeAnalysis.model';
import { EffortEstimate } from '../../models/effortEstimate.model';
import { TimeEntry } from '../../models/timeEntry.model';
import { EFFORT_CATEGORIES } from '../../domain/lexicon';
import { priceEstimate, toMinor } from '../../domain/money';
import { computeScheduleImpact, type CalendarConfig } from '../../domain/schedule';
import { AUDIT_ACTIONS } from '../../config/constants';
import { recordAudit } from '../../platform/audit';
import { withTransaction } from '../../config/db';
import { badRequest, conflict, notFound } from '../../platform/errors';

export interface Actor {
  userId: Types.ObjectId | string;
  name: string;
  email?: string;
  ip?: string;
  userAgent?: string;
}

type Category = (typeof EFFORT_CATEGORIES)[number];

function normaliseHours(input: Record<string, number | undefined> | undefined, fallback: Partial<Record<Category, number>>): Record<Category, number> {
  const out = {} as Record<Category, number>;
  for (const category of EFFORT_CATEGORIES) {
    const raw = input?.[category];
    const value = raw === undefined || raw === null || Number.isNaN(raw) ? Number(fallback[category] ?? 0) : Number(raw);
    if (value < 0) throw badRequest(`${category} hours cannot be negative.`);
    if (value > 10000) {
      throw badRequest(`${category} hours exceed the 10,000 hour ceiling for a single request. Split the request instead.`);
    }
    out[category] = Math.round(value * 100) / 100;
  }
  return out;
}

function calendarFrom(project: { workingDays?: number[]; holidays?: string[] }): CalendarConfig {
  return {
    workingDays: project.workingDays?.length ? project.workingDays : [1, 2, 3, 4, 5],
    holidays: project.holidays ?? [],
  };
}

/** Hours suggested by the deterministic engine, keyed by effort category. */
async function suggestedHours(orgId: string, requestId: string): Promise<Partial<Record<Category, number>>> {
  const analysis = await ScopeAnalysis.findOne({ org: orgId, request: requestId, status: 'complete' })
    .sort({ createdAt: -1 })
    .lean();
  const hints = (analysis?.impactHints ?? []) as { category?: string; suggestedHours?: number }[];
  const out: Partial<Record<Category, number>> = {};
  for (const hint of hints) {
    const category = (hint.category ?? 'other') as Category;
    if (!EFFORT_CATEGORIES.includes(category)) {
      out.other = (out.other ?? 0) + Number(hint.suggestedHours ?? 0);
      continue;
    }
    out[category] = (out[category] ?? 0) + Number(hint.suggestedHours ?? 0);
  }
  return out;
}

function priceAndSchedule(project: InstanceType<typeof Project>, hours: Record<Category, number>, overrides: {
  fixedPrice?: number | null;
  contingencyPct?: number;
  discountPct?: number;
  taxPct?: number;
  currency?: string;
  billingRate?: number;
  billingModel?: string;
  people?: number;
  availability?: number;
  startDate?: Date;
  floatDays?: number | null;
}) {
  const totalHours = EFFORT_CATEGORIES.reduce((sum, c) => sum + hours[c], 0);
  const billingModel = (overrides.billingModel as typeof project.contractType) ?? project.contractType ?? 'fixed_price';
  const pricing = priceEstimate({
    currency: overrides.currency ?? project.currency ?? 'USD',
    hoursByCategory: hours,
    hourlyRate: overrides.billingRate ?? project.hourlyRate ?? 0,
    contingencyPct: overrides.contingencyPct ?? 0,
    discountPct: overrides.discountPct ?? 0,
    taxPct: overrides.taxPct ?? 0,
    fixedPrice: overrides.fixedPrice ?? null,
  });

  /**
   * The billing model changes how hours become money, and it is recorded rather than assumed.
   * A retainer or fixed-price engagement is not simply hourly work with a different label, so the
   * estimate carries the model and the UI explains the arithmetic in those terms.
   */
  if (billingModel === 'retainer' && !overrides.fixedPrice) {
    pricing.total = { amount: pricing.subtotal.amount, currency: pricing.subtotal.currency };
  }

  const schedule = computeScheduleImpact({
    additionalHours: totalHours,
    hoursPerPersonDay: project.hoursPerPersonDay ?? 6,
    people: overrides.people ?? 1,
    availability: overrides.availability ?? 1,
    startDate: overrides.startDate ?? new Date(),
    calendar: calendarFrom(project),
    /**
     * Float (the slack left before the committed date is breached) and the committed target date
     * are contract facts this model does not yet record per project. Passing an invention here
     * would be worse than passing nothing: the schedule result says so explicitly and asks for the
     * date, rather than reporting a slippage that was computed from a guess.
     */
    floatDays: overrides.floatDays ?? null,
    currentTargetDate: null,
  });

  const internalCostMinor = toMinor((project.internalCostRate ?? 0) * totalHours, project.currency ?? 'USD').amount;
  return { totalHours, pricing, schedule, internalCostMinor, billingModel };
}

export async function createEstimate(input: {
  orgId: string;
  requestId: string;
  actor: Actor;
  hours?: Record<string, number>;
  useSuggestedHours?: boolean;
  note?: string;
  currency?: string;
  billingRate?: number;
  internalCostRate?: number;
  billingModel?: string;
  basis?: string;
  fixedPrice?: number | null;
  contingencyPct?: number;
  discountPct?: number;
  taxPct?: number;
  capacity?: { hoursPerPersonDay?: number; people?: number; availability?: number; floatDays?: number | null };
  people?: number;
  availability?: number;
  startDate?: Date;
  floatDays?: number | null;
}) {
  const request = await ChangeRequest.findOne({ _id: input.requestId, org: input.orgId });
  if (!request) throw notFound('Change request not found in this organisation.');
  if (['closed', 'rejected', 'withdrawn'].includes(String(request.status))) {
    throw conflict(`An estimate cannot be created for a request that is ${request.status}.`);
  }
  const project = await Project.findOne({ _id: request.project, org: input.orgId });
  if (!project) throw notFound('Project not found in this organisation.');

  const hints = await suggestedHours(input.orgId, input.requestId);
  const hours = normaliseHours(input.hours, input.useSuggestedHours ? hints : {});
  const capacity = input.capacity ?? {};
  const basis = input.hours ? (input.useSuggestedHours ? 'suggested_from_hints' : 'manual') : 'suggested_from_hints';
  const { totalHours, pricing, schedule, internalCostMinor, billingModel } = priceAndSchedule(project, hours, {
    ...input,
    people: capacity.people ?? input.people,
    availability: capacity.availability ?? input.availability,
    floatDays: capacity.floatDays ?? input.floatDays,
  });

  const existing = await EffortEstimate.find({ org: input.orgId, request: request._id })
    .sort({ version: -1 })
    .limit(1)
    .lean();
  const version = (existing[0]?.version ?? 0) + 1;

  const { result: estimate, transactional } = await withTransaction(async (session) => {
    const [created] = await EffortEstimate.create(
      [
        {
          org: input.orgId,
          project: project._id,
          request: request._id,
          version,
          hours,
          totalHours,
          currency: project.currency ?? 'USD',
          billingRate: input.billingRate ?? project.hourlyRate ?? 0,
          internalCostRate: input.internalCostRate ?? project.internalCostRate ?? 0,
          billingModel,
          fixedPrice: input.fixedPrice ?? null,
          contingencyPct: input.contingencyPct ?? 0,
          discountPct: input.discountPct ?? 0,
          taxPct: input.taxPct ?? 0,
          pricing: { ...pricing, internalCostMinor },
          schedule,
          basis,
          note: input.note ?? '',
          author: input.actor.userId,
          authorName: input.actor.name,
          status: 'draft',
          isDemo: Boolean(project.isDemo),
        },
      ],
      session ? { session } : {},
    );
    return created!;
  });

  await recordAudit({
    org: input.orgId,
    actor: { kind: 'user', userId: String(input.actor.userId), name: input.actor.name, email: input.actor.email },
    action: AUDIT_ACTIONS.estimateCreated,
    entity: { type: 'EffortEstimate', id: String(estimate._id), label: `v${estimate.version}` },
    meta: { requestRef: request.ref, totalHours, internalCostMinor, transactional },
  });

  request.effort = { ...(request.effort ?? {}), estimatedHours: totalHours } as never;
  await request.save();

  const view = estimateView(estimate, { includeInternal: true });
  return {
    estimate: estimate.toObject(),
    view,
    priced: pricing,
    scheduleImpact: schedule,
    margin: marginOf(estimate),
    internalCostMinor,
    transactional,
  };
}

/** Internal-only: the difference between what we bill and what the hours cost us. */
function marginOf(estimate: { pricing?: { total?: { amount?: number; currency?: string } | null; internalCostMinor?: number } | null }) {
  const total = estimate.pricing?.total?.amount ?? 0;
  const cost = estimate.pricing?.internalCostMinor ?? 0;
  return {
    revenueMinor: total,
    costMinor: cost,
    marginMinor: total - cost,
    marginPct: total > 0 ? Number((((total - cost) / total) * 100).toFixed(1)) : null,
    currency: estimate.pricing?.total?.currency ?? 'USD',
    /** Margin is a planning figure computed from recorded rates, not an accounting result. */
    note: 'Margin uses the internal cost rate recorded on the project and excludes overhead, tooling and non-billable time.',
  };
}

/**
 * The single place that decides what a non-owner viewer may see. Internal cost, margin and the
 * author's private note never leave this function when includeInternal is false, because a
 * developer or a client-facing view must not be able to infer our cost base from an estimate.
 */
export function estimateView(
  estimate: Record<string, unknown> | { toObject: () => Record<string, unknown> },
  opts: { includeInternal: boolean },
) {
  const raw = typeof (estimate as { toObject?: unknown }).toObject === 'function'
    ? (estimate as { toObject: () => Record<string, unknown> }).toObject()
    : (estimate as Record<string, unknown>);
  const pricing = (raw.pricing ?? {}) as Record<string, unknown>;
  const schedule = (raw.schedule ?? {}) as Record<string, unknown>;
  const base = {
    id: raw._id,
    request: raw.request,
    project: raw.project,
    version: raw.version,
    hours: raw.hours,
    totalHours: raw.totalHours,
    currency: raw.currency,
    billingModel: raw.billingModel,
    basis: raw.basis,
    status: raw.status,
    createdAt: raw.createdAt,
    pricing: {
      subtotal: pricing.subtotal,
      contingency: pricing.contingency,
      discount: pricing.discount,
      tax: pricing.tax,
      total: pricing.total,
      effectiveHourlyRate: pricing.effectiveHourlyRate,
    },
    schedule: {
      additionalWorkdays: schedule.additionalWorkdays,
      slippageWorkdays: schedule.slippageWorkdays,
      projectedEndDate: schedule.projectedEndDate,
      targetBreached: schedule.targetBreached,
      confidence: schedule.confidence,
      assumptions: schedule.assumptions,
      warnings: schedule.warnings,
      override: schedule.override,
    },
    note: raw.note,
  };
  if (!opts.includeInternal) return base;
  return {
    ...base,
    billingRate: raw.billingRate,
    internalCostRate: raw.internalCostRate,
    fixedPrice: raw.fixedPrice,
    margin: marginOf(raw as { pricing?: { total?: { amount?: number; currency?: string } | null; internalCostMinor?: number } | null }),
    authorName: raw.authorName,
    capacityPerDay: schedule.capacityPerDay,
  };
}

export async function updateDraftEstimate(input: {
  orgId: string;
  estimateId: string;
  actor: Actor;
  hours?: Record<string, number>;
  note?: string;
  currency?: string;
  billingRate?: number;
  internalCostRate?: number;
  billingModel?: string;
  fixedPrice?: number | null;
  contingencyPct?: number;
  discountPct?: number;
  taxPct?: number;
  people?: number;
  availability?: number;
  startDate?: Date;
  floatDays?: number | null;
}) {
  const estimate = await EffortEstimate.findOne({ _id: input.estimateId, org: input.orgId });
  if (!estimate) throw notFound('Estimate not found in this organisation.');
  if (estimate.status !== 'draft') {
    // Immutability is the point: a number the client may have seen is never edited in place.
    throw conflict('Finalised estimates are immutable. Create a new version instead.');
  }
  const project = await Project.findOne({ _id: estimate.project, org: input.orgId });
  if (!project) throw notFound('Project not found in this organisation.');

  const previous = estimate.toObject() as unknown as { hours: Record<Category, number> };
  const hours = normaliseHours(input.hours ?? previous.hours, previous.hours);
  const { totalHours, pricing, schedule, internalCostMinor } = priceAndSchedule(project, hours, {
    fixedPrice: input.fixedPrice === undefined ? estimate.fixedPrice : input.fixedPrice,
    contingencyPct: input.contingencyPct ?? estimate.contingencyPct,
    discountPct: input.discountPct ?? estimate.discountPct,
    taxPct: input.taxPct ?? estimate.taxPct,
    people: input.people,
    availability: input.availability,
    startDate: input.startDate,
    floatDays: input.floatDays,
  });

  estimate.set({
    hours,
    totalHours,
    pricing: { ...pricing, internalCostMinor },
    schedule,
    note: input.note ?? estimate.note,
    basis: 'manual',
  });
  await estimate.save();

  const request = await ChangeRequest.findOne({ _id: estimate.request, org: input.orgId }).lean();
  await recordAudit({
    org: input.orgId,
    actor: { kind: 'user', userId: String(input.actor.userId), name: input.actor.name, email: input.actor.email },
    action: AUDIT_ACTIONS.estimateCreated,
    entity: { type: 'EffortEstimate', id: String(estimate._id), label: `v${estimate.version}` },
    meta: { requestRef: request?.ref, totalHours },
  });
  return estimate.toObject();
}

export async function finaliseEstimate(input: { orgId: string; estimateId: string; actor: Actor; note?: string }) {
  const estimate = await EffortEstimate.findOne({ _id: input.estimateId, org: input.orgId });
  if (!estimate) throw notFound('Estimate not found in this organisation.');
  if (estimate.status === 'final') return { estimate: estimate.toObject(), alreadyFinal: true };
  if (estimate.status === 'superseded') throw conflict('A superseded estimate cannot be finalised.');
  if (estimate.totalHours <= 0) {
    throw badRequest('An estimate with zero hours cannot be finalised. Record the effort or withdraw the request.');
  }

  await EffortEstimate.updateMany(
    { org: input.orgId, request: estimate.request, status: 'final' },
    { $set: { status: 'superseded' } },
  );
  estimate.set({ status: 'final', finalisedAt: new Date(), finalisedBy: input.actor.userId, note: input.note ?? estimate.note });
  await estimate.save();

  const request = await ChangeRequest.findOne({ _id: estimate.request, org: input.orgId });
  if (request) {
    request.effort = { ...(request.effort ?? {}), estimatedHours: estimate.totalHours } as never;
    await request.save();
  }

  await recordAudit({
    org: input.orgId,
    actor: { kind: 'user', userId: String(input.actor.userId), name: input.actor.name, email: input.actor.email },
    action: AUDIT_ACTIONS.estimateFinalised,
    entity: { type: 'EffortEstimate', id: String(estimate._id), label: `v${estimate.version}` },
    meta: { requestRef: request?.ref, internalCostMinor: estimate.pricing?.internalCostMinor ?? 0, note: 'Client-facing total stored with the estimate for reproducibility.' },
  });
  return { estimate: estimate.toObject(), alreadyFinal: false };
}

/** Internal users see cost and margin; the client-facing projection never includes them. */
export function toPublicEstimate(estimate: Record<string, unknown>) {
  const pricing = (estimate.pricing ?? {}) as Record<string, { amount: number; currency: string } | number>;
  return {
    id: estimate._id,
    version: estimate.version,
    totalHours: estimate.totalHours,
    currency: estimate.currency,
    billingModel: estimate.billingModel,
    pricing: {
      subtotal: pricing.subtotal,
      contingency: pricing.contingency,
      discount: pricing.discount,
      tax: pricing.tax,
      total: pricing.total,
      effectiveHourlyRate: pricing.effectiveHourlyRate,
    },
    schedule: estimate.schedule,
    status: estimate.status,
  };
}

export async function listEstimates(orgId: string, requestId: string, includeInternal = false) {
  const estimates = await EffortEstimate.find({ org: orgId, request: requestId }).sort({ version: -1 }).lean();
  return estimates.map((estimate) => estimateView(estimate as unknown as Record<string, unknown>, { includeInternal }));
}

/** Hours the engine suggests, with the reasoning attached. Never a price. */
export async function suggestHours(orgId: string, requestId: string) {
  const request = await ChangeRequest.findOne({ _id: requestId, org: orgId }).lean();
  if (!request) throw notFound('Change request not found in this organisation.');
  const analysis = await ScopeAnalysis.findOne({ org: orgId, request: requestId, status: 'complete' })
    .sort({ createdAt: -1 })
    .lean();
  const hints = (analysis?.impactHints ?? []) as { category?: string; label?: string; suggestedHours?: number; rationale?: string }[];
  const hours = await suggestedHours(orgId, requestId);
  const totalHours = Object.values(hours).reduce((sum, h) => sum + (h ?? 0), 0);
  const project = await Project.findOne({ _id: request.project, org: orgId }).lean();
  return {
    requestRef: request.ref,
    analysisId: analysis?._id ?? null,
    analysisEngine: (analysis as { engineVersion?: string } | null)?.engineVersion ?? null,
    hints,
    hours,
    totalHours,
    categories: EFFORT_CATEGORIES,
    billingModel: project?.contractType ?? null,
    notice:
      hints.length === 0
        ? 'No analysis hints are available for this request yet. Enter hours manually.'
        : 'These hours come from the deterministic analysis hints and are a starting point for a human estimate. They are not a quote and not a commitment.',
  };
}

/** A human may override the projected schedule, but the reason is recorded with their name. */
export async function overrideSchedule(input: {
  orgId: string;
  estimateId: string;
  actor: Actor;
  workdays: number;
  projectedEndDate?: string | null;
  reason: string;
}) {
  const estimate = await EffortEstimate.findOne({ _id: input.estimateId, org: input.orgId });
  if (!estimate) throw notFound('Estimate not found in this organisation.');
  const previous = estimate.schedule?.additionalWorkdays ?? 0;
  estimate.set('schedule.override', {
    applied: true,
    workdays: input.workdays,
    projectedEndDate: input.projectedEndDate ? new Date(input.projectedEndDate) : null,
    reason: input.reason,
    overriddenBy: input.actor.userId,
    overriddenAt: new Date(),
  });
  await estimate.save();

  await recordAudit({
    org: input.orgId,
    actor: { kind: 'user', userId: String(input.actor.userId), name: input.actor.name, email: input.actor.email },
    action: AUDIT_ACTIONS.estimateFinalised,
    entity: { type: 'EffortEstimate', id: String(estimate._id), label: `v${estimate.version}` },
    meta: { reason: input.reason, previous, workdays: input.workdays, override: true },
  });
  return estimate.toObject();
}

/** Time entries. Hours against an unapproved request are recorded as unapproved work, not revenue. */
export async function logTime(input: {
  orgId: string;
  actor: Actor;
  projectId: string;
  requestId?: string | null;
  date?: string;
  hours: number;
  category?: string;
  billable?: boolean;
  note?: string;
}) {
  const project = await Project.findOne({ _id: input.projectId, org: input.orgId }).lean();
  if (!project) throw notFound('Project not found in this organisation.');

  let approvedAtEntry = false;
  if (input.requestId) {
    const request = await ChangeRequest.findOne({ _id: input.requestId, org: input.orgId }).lean();
    if (!request) throw notFound('Change request not found in this organisation.');
    approvedAtEntry = String(request.status) === 'approved' || String(request.outcome?.decision ?? '') === 'accepted';
  }
  const loggedWithoutApproval = Boolean(input.requestId) && !approvedAtEntry;

  const [entry] = await TimeEntry.create([
    {
      org: input.orgId,
      project: input.projectId,
      request: input.requestId ?? null,
      user: input.actor.userId,
      date: input.date ? new Date(input.date) : new Date(),
      hours: input.hours,
      category: input.category ?? 'other',
      billable: input.billable ?? true,
      note: input.note ?? '',
      approvedAtEntry,
      loggedWithoutApproval,
      createdBy: input.actor.userId,
      isDemo: Boolean(project.isDemo),
    },
  ]);

  await recordAudit({
    org: input.orgId,
    actor: { kind: 'user', userId: String(input.actor.userId), name: input.actor.name, email: input.actor.email },
    action: AUDIT_ACTIONS.timeEntryCreated,
    entity: { type: 'TimeEntry', id: String(entry!._id) },
    meta: { billable: input.billable ?? true, approvedAtEntry, loggedWithoutApproval },
  });

  return { entry: entry!.toObject(), approvedAtEntry, loggedWithoutApproval };
}
