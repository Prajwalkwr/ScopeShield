import mongoose from 'mongoose';
import {
  AiUsage,
  BaselineVersion,
  ChangeOrder,
  ChangeRequest,
  Organization,
  Project,
} from '../../models';
import { sha256 } from '../../platform/crypto';
import { notFound } from '../../platform/errors';
import { recordAudit } from '../../platform/audit';
import { AUDIT_ACTIONS } from '../../config/constants';
import { logger } from '../../platform/logger';
import { classifyRequest, CATEGORY_META, type ClassificationCategory, type ClassificationInput } from '../../domain/classification';
import { resolveAiProvider } from '../../ai';
import type { AnalyzeScopeInput } from '../../ai/types';

export type ActorCtx = { userId: string; name: string; email: string; ip?: string; userAgent?: string };

/**
 * Runs a scope analysis and stores it append-only.
 *
 * Order of operations is deliberate:
 *   1. gather evidence from the database (baseline, open requests, approved changes, revisions)
 *   2. run the DETERMINISTIC engine — this is the result of record
 *   3. optionally ask the configured AI provider for nuance
 *   4. verify every citation the model produced against the actual baseline
 *   5. persist everything, including what was dropped and why
 *
 * The AI can add questions and wording. It cannot change the category, and its output is
 * never treated as an approval or a price.
 */
export async function runAnalysis(input: {
  orgId: string;
  requestId: string;
  actor: ActorCtx;
  useAi?: boolean;
}) {
  const request = await ChangeRequest.findOne({ _id: input.requestId, org: input.orgId });
  if (!request) throw notFound('Request not found.');
  const project = await Project.findOne({ _id: request.project, org: input.orgId }).lean();
  if (!project) throw notFound('Project not found.');
  const org = await Organization.findById(input.orgId).select('name ai ai').lean();
  const baseline = project.currentBaseline ? await BaselineVersion.findById(project.currentBaseline).lean() : null;

  const requirements = (baseline?.snapshot.requirements ?? []).filter((r) => r.kind === 'requirement');
  const exclusions = (baseline?.snapshot.requirements ?? []).filter((r) => r.kind === 'exclusion');

  const [openRequests, approvedChangeOrders] = await Promise.all([
    ChangeRequest.find({
      project: project._id,
      _id: { $ne: request._id },
      status: { $in: ['submitted', 'under_review', 'clarification_required', 'classified', 'estimating', 'internal_review', 'awaiting_client_decision'] },
    })
      .select('ref title description status classification')
      .limit(50)
      .lean(),
    ChangeOrder.find({ project: project._id, status: 'accepted' })
      .select('number title summary scopeAdditions relatedRequirements')
      .limit(50)
      .lean(),
  ]);

  const revisionPolicies = project.revisionPolicies.map((policy) => ({
    deliverable: policy.deliverable,
    included: policy.included,
    used: project.revisionRounds.filter((r) => r.deliverable === policy.deliverable).length,
  }));

  const hasEvidence = request.evidence.length > 0 && request.evidence.some((e) => e.quote || e.document);

  const engineInput: ClassificationInput = {
    text: request.description,
    title: request.title,
    requirements: requirements.map((r) => ({
      key: r.key,
      kind: 'requirement' as const,
      title: r.title,
      description: r.description ?? '',
      acceptanceCriteria: (r.acceptanceCriteria ?? []).map((c) => c.text),
      category: r.category ?? undefined,
      deliverable: r.deliverable ?? undefined,
      estimatedHours: r.estimatedHours ?? undefined,
    })),
    exclusions: exclusions.map((r) => ({
      key: r.key,
      kind: 'exclusion' as const,
      title: r.title,
      description: r.description ?? '',
      acceptanceCriteria: [],
      deliverable: r.deliverable ?? undefined,
    })),
    openRequests: openRequests.map((r) => ({
      ref: r.ref,
      title: r.title,
      description: r.description,
      status: r.status,
      classification: r.classification ?? undefined,
    })),
    approvedChanges: approvedChangeOrders.map((co) => ({
      number: co.number,
      title: co.title,
      description: co.summary ?? '',
      addedRequirementKeys: (co.relatedRequirements ?? []).map((r) => r.key ?? ''),
      addedDeliverables: (co.scopeAdditions ?? []).map((s) => s.title),
    })),
    revisionPolicies,
    hasEvidence,
  };

  const deterministic = classifyRequest(engineInput);

  // ── Optional AI pass ───────────────────────────────────────────────────────
  const aiEnabled = input.useAi === false ? false : Boolean(org?.ai?.enabled) || input.useAi === true;
  let aiBlock = {
    provider: 'none',
    model: '',
    attempted: false,
    succeeded: false,
    rawOutput: '',
    droppedCitations: [] as string[],
    degraded: false,
    degradeReason: '',
    latencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    suggestedCategory: '',
    suggestedQuestionAdditions: [] as string[],
  };
  let extraQuestions: string[] = [];
  let extraMissing: string[] = [];

  if (aiEnabled) {
    const { provider, reason, degradedFrom } = resolveAiProvider(
      (org?.ai?.provider as 'heuristic' | 'openai' | 'anthropic' | undefined) ?? undefined,
    );

    // Budget guard: refuse external calls once the monthly budget is spent.
    let budgetExceeded = false;
    if (provider.requiresNetwork) {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const spentAgg = await AiUsage.aggregate([
        { $match: { org: new mongoose.Types.ObjectId(input.orgId), createdAt: { $gte: monthStart } } },
        { $group: { _id: null, cost: { $sum: '$costUsd' } } },
      ]);
      const budget = org?.ai?.monthlyBudgetUsd ?? 25;
      if ((spentAgg[0]?.cost ?? 0) >= budget) {
        budgetExceeded = true;
        aiBlock = {
          ...aiBlock,
          provider: provider.name,
          model: provider.model,
          attempted: false,
          degraded: true,
          degradeReason: `Monthly AI budget of $${budget} has been reached; the deterministic result is shown instead.`,
        };
        await AiUsage.create({
          org: input.orgId,
          user: input.actor.userId,
          feature: 'scope_analysis',
          provider: provider.name,
          model: provider.model,
          outcome: 'budget_exceeded',
          relatedTo: { type: 'ChangeRequest', id: request._id },
        });
      }
    }

    if (!budgetExceeded) {
      const aiInput: AnalyzeScopeInput = {
        requestTitle: request.title,
        requestText: request.description,
        projectName: project.name,
        clientName: '',
        currency: project.currency,
        requirements: engineInput.requirements.map((r) => ({
          key: r.key,
          kind: r.kind,
          title: r.title,
          description: r.description,
          acceptanceCriteria: r.acceptanceCriteria,
          deliverable: r.deliverable,
        })),
        deterministic: {
          category: deterministic.category,
          confidence: deterministic.confidence,
          evidenceRefs: deterministic.evidence.map((e) => e.ref),
          checks: deterministic.checks.map((c) => ({ id: c.id, outcome: c.outcome, detail: c.detail })),
          missingInformation: deterministic.missingInformation,
        },
      };

      const result = await provider.analyzeScope(aiInput);
      aiBlock = {
        provider: result.usage.provider,
        model: result.usage.model,
        attempted: true,
        succeeded: result.ok,
        rawOutput: '',
        droppedCitations: [],
        degraded: result.degraded,
        degradeReason: result.ok ? (degradedFrom ? reason : '') : result.error.message,
        latencyMs: result.usage.latencyMs,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costUsd: result.usage.costUsd,
        suggestedCategory: '',
        suggestedQuestionAdditions: [],
      };

      await AiUsage.create({
        org: input.orgId,
        user: input.actor.userId,
        feature: 'scope_analysis',
        provider: result.usage.provider,
        model: result.usage.model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costUsd: result.usage.costUsd,
        latencyMs: result.usage.latencyMs,
        outcome: result.ok ? 'success' : 'error',
        errorCode: result.ok ? '' : result.error.code,
        inputChars: JSON.stringify(aiInput).length,
        relatedTo: { type: 'ChangeRequest', id: request._id },
      });

      if (result.ok) {
        // ── Evidence verification ────────────────────────────────────────────
        // Any cited key that does not exist in the baseline is dropped and recorded.
        const validKeys = new Set([...engineInput.requirements.map((r) => r.key), ...engineInput.exclusions.map((r) => r.key)]);
        const allCited = [...result.output.citedRequirementKeys, ...result.output.citedExclusionKeys];
        const dropped = allCited.filter((k) => !validKeys.has(k.toUpperCase()));
        const keptRequirements = result.output.citedRequirementKeys.filter((k) => validKeys.has(k.toUpperCase()));
        const keptExclusions = result.output.citedExclusionKeys.filter((k) => validKeys.has(k.toUpperCase()));

        aiBlock.droppedCitations = dropped;
        aiBlock.suggestedCategory = result.output.suggestedCategory;
        aiBlock.suggestedQuestionAdditions = result.output.additionalQuestions.slice(0, 10);

        // Citations the model legitimately added become evidence entries (excerpts from the baseline).
        for (const key of [...keptRequirements, ...keptExclusions]) {
          const source = engineInput.requirements.find((r) => r.key === key.toUpperCase()) ?? engineInput.exclusions.find((r) => r.key === key.toUpperCase());
          if (!source) continue;
          const exists = deterministic.evidence.some((e) => e.ref === source.key);
          if (!exists) {
            deterministic.evidence.push({
              type: source.kind === 'exclusion' ? 'exclusion' : 'requirement',
              ref: source.key,
              excerpt: `${source.title}. ${source.description}`.slice(0, 220),
              relation: 'supports',
            });
          }
        }
        if (dropped.length > 0) {
          aiBlock.degradeReason = `${dropped.length} citation(s) produced by the model were not present in the baseline and were discarded: ${dropped.join(', ')}.`;
        }
        extraQuestions = result.output.additionalQuestions;
        extraMissing = result.output.missingInformation;
      } else {
        extraQuestions = [];
      }
    }
  }

  const inputHash = sha256(`${request.description}|${request.title}|${baseline?.snapshotHash ?? 'no-baseline'}`);

  const analysis = await ScopeAnalysisCreate({
    org: input.orgId,
    project: project._id as mongoose.Types.ObjectId,
    request: request._id as mongoose.Types.ObjectId,
    baselineVersion: baseline?._id as mongoose.Types.ObjectId | undefined,
    mode: aiBlock.attempted ? (aiBlock.degraded ? 'fallback' : 'hybrid') : 'deterministic',
    engineVersion: deterministic.engineVersion,
    category: deterministic.category,
    confidence: deterministic.confidence,
    confidenceBand: deterministic.confidenceBand,
    confidenceFactors: deterministic.confidenceFactors,
    checks: deterministic.checks,
    evidence: deterministic.evidence,
    missingInformation: [...new Set([...deterministic.missingInformation, ...extraMissing])],
    suggestedQuestions: [...new Set([...deterministic.suggestedQuestions, ...extraQuestions])],
    detectedConcepts: deterministic.detectedConcepts,
    impactHints: deterministic.impactHints,
    nearestRequirements: deterministic.nearestRequirements,
    reviewerSummary: deterministic.reviewerSummary,
    assumptions: deterministic.assumptions,
    injectionSuspected: deterministic.injectionSuspected,
    inputHash,
    ai: aiBlock,
    createdBy: input.actor.userId,
  });

  // Update the request's current classification, preserving history when it changes.
  const previousCategory = request.classification ?? null;
  if (previousCategory !== deterministic.category) {
    request.classificationHistory.push({
      category: deterministic.category,
      previousCategory,
      source: 'engine',
      reason: `Deterministic engine v${deterministic.engineVersion} classified this request.`,
      actor: new mongoose.Types.ObjectId(input.actor.userId),
      actorName: 'ScopeShield engine',
      at: new Date(),
    } as never);
  }
  request.classification = deterministic.category;
  request.classificationConfidence = deterministic.confidence;
  request.classificationAnalysis = analysis._id as mongoose.Types.ObjectId;
  request.flaggedForReview = deterministic.injectionSuspected || request.flaggedForReview;
  if (request.status === 'under_review') request.status = 'classified';
  await request.save();

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.analysisGenerated,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'ChangeRequest', id: String(request._id), label: request.ref },
    meta: {
      analysisId: String(analysis._id),
      mode: analysis.mode,
      category: deterministic.category,
      confidence: deterministic.confidence,
      engineVersion: deterministic.engineVersion,
      aiProvider: aiBlock.provider,
      aiAttempted: aiBlock.attempted,
      droppedCitations: aiBlock.droppedCitations.length,
      injectionSuspected: deterministic.injectionSuspected,
      baselineVersion: baseline?.version ?? null,
    },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });

  logger.info('Scope analysis completed', {
    requestRef: request.ref,
    mode: analysis.mode,
    category: deterministic.category,
    confidence: deterministic.confidence,
  });

  return { analysis, request };
}

/** Human correction. The engine's verdict is preserved; the human's is added on top. */
export async function correctClassification(input: {
  orgId: string;
  requestId: string;
  actor: ActorCtx;
  category: ClassificationCategory;
  reason: string;
}) {
  if (input.reason.trim().length < 10) {
    throw notFound('Please explain the correction in at least 10 characters — this becomes part of the project record.');
  }
  const request = await ChangeRequest.findOne({ _id: input.requestId, org: input.orgId });
  if (!request) throw notFound('Request not found.');

  const previous = request.classification ?? null;
  request.classificationHistory.push({
    category: input.category,
    previousCategory: previous,
    source: 'human',
    reason: input.reason,
    actor: new mongoose.Types.ObjectId(input.actor.userId),
    actorName: input.actor.name,
    at: new Date(),
  } as never);
  request.classification = input.category;
  await request.save();

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.requestClassified,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'ChangeRequest', id: String(request._id), label: request.ref },
    changes: [{ field: 'classification', from: previous ?? '(none)', to: input.category }],
    meta: { reason: input.reason, correctedByHuman: true },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });

  return request;
}

export function categoryMeta(category: ClassificationCategory) {
  return CATEGORY_META[category];
}

// Local alias keeps the model import list tight while reading clearly below.
async function ScopeAnalysisCreate(doc: Record<string, unknown>) {
  const { ScopeAnalysis } = await import('../../models');
  const created = await ScopeAnalysis.create([doc] as never);
  const item = Array.isArray(created) ? created[0] : (created as unknown);
  if (!item) throw notFound('Analysis could not be stored.');
  return item as InstanceType<typeof ScopeAnalysis>;
}
