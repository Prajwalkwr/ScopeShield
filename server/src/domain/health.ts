/**
 * Explainable scope-health indicator.
 *
 * This is a weighted checklist of things an agency can act on — NOT a prediction and
 * NOT a benchmark against other projects. Every point of the score is attributable to a
 * named factor with the underlying counts shown, so a project manager can argue with it.
 */

export interface HealthInput {
  requirementCount: number;
  requirementsWithoutAcceptanceCriteria: number;
  exclusionCount: number;
  ambiguousRequirementCount: number;
  unresolvedRequestCount: number;
  unapprovedWorkHours: number;
  approvedChangeCount: number;
  revisionsExhaustedDeliverables: number;
  estimateVariancePct: number | null;
  pendingClientDecisions: number;
  averageApprovalTurnaroundDays: number | null;
  hasApprovedBaseline: boolean;
}

export interface HealthFactor {
  id: string;
  label: string;
  /** Points removed from 100. */
  penalty: number;
  maxPenalty: number;
  detail: string;
  advice: string;
  severity: 'low' | 'medium' | 'high';
}

export interface HealthResult {
  score: number;
  band: 'healthy' | 'watch' | 'at_risk' | 'critical';
  factors: HealthFactor[];
  summary: string;
  /** Stated limitation of the metric. */
  caveat: string;
}

export function computeScopeHealth(input: HealthInput): HealthResult {
  const factors: HealthFactor[] = [];
  const penalty = (
    id: string,
    label: string,
    raw: number,
    maxPenalty: number,
    detail: string,
    advice: string,
    severity: HealthFactor['severity'],
  ) => {
    const p = Math.min(Math.max(raw, 0), maxPenalty);
    if (p <= 0) return;
    factors.push({ id, label, penalty: Number(p.toFixed(1)), maxPenalty, detail, advice, severity });
  };

  if (!input.hasApprovedBaseline) {
    penalty(
      'no_baseline', 'No approved baseline', 25, 25,
      'Nothing has been frozen, so there is no authoritative record of the agreed scope.',
      'Approve a baseline version as soon as the scope is agreed.', 'high',
    );
  }

  if (input.requirementCount > 0) {
    const ratio = input.requirementsWithoutAcceptanceCriteria / input.requirementCount;
    penalty(
      'missing_criteria', 'Requirements without acceptance criteria', ratio * 18, 18,
      `${input.requirementsWithoutAcceptanceCriteria} of ${input.requirementCount} requirements cannot be objectively checked as done.`,
      'Add measurable acceptance criteria to the highest-value requirements first.', ratio > 0.5 ? 'high' : 'medium',
    );
  } else if (input.hasApprovedBaseline) {
    penalty(
      'no_requirements', 'Baseline has no structured requirements', 12, 12,
      'The baseline exists but contains no individually identifiable requirements, so comparisons cannot cite anything.',
      'Break the scope into numbered requirements and exclusions.', 'medium',
    );
  }

  if (input.exclusionCount === 0 && input.hasApprovedBaseline) {
    penalty(
      'no_exclusions', 'No exclusions recorded', 8, 8,
      'Without explicit exclusions, "that was never agreed" cannot be evidenced.',
      'Record the things you are explicitly not delivering.', 'medium',
    );
  }

  penalty(
    'ambiguous', 'Ambiguous requirements', input.ambiguousRequirementCount * 2, 12,
    `${input.ambiguousRequirementCount} requirement(s) contain subjective wording that cannot be verified.`,
    'Replace subjective wording with observable outcomes.', 'medium',
  );

  penalty(
    'unresolved', 'Unresolved requests', input.unresolvedRequestCount * 1.5, 15,
    `${input.unresolvedRequestCount} request(s) are sitting without a decision.`,
    'Clear the review queue; unresolved requests become untracked work.', input.unresolvedRequestCount > 4 ? 'high' : 'low',
  );

  if (input.unapprovedWorkHours > 0) {
    penalty(
      'unapproved_work', 'Work logged without an approval', Math.min(input.unapprovedWorkHours * 0.6, 20), 20,
      `${input.unapprovedWorkHours.toFixed(1)} hour(s) are logged against requests that have not been approved.`,
      'Either obtain a decision or write the hours off deliberately — do not leave them invisible.',
      input.unapprovedWorkHours > 16 ? 'high' : 'medium',
    );
  }

  penalty(
    'revisions', 'Revision allowances exhausted', input.revisionsExhaustedDeliverables * 4, 12,
    `${input.revisionsExhaustedDeliverables} deliverable(s) have no included rounds left.`,
    'Agree how further rounds will be handled before the next one arrives.', 'low',
  );

  if (input.pendingClientDecisions > 0) {
    penalty(
      'pending_decisions', 'Client decisions outstanding', input.pendingClientDecisions * 2.5, 15,
      `${input.pendingClientDecisions} proposal(s) are waiting on the client.`,
      'Chase the oldest first; a stalled decision is usually a stalled project.', input.pendingClientDecisions > 3 ? 'high' : 'medium',
    );
  }

  if (input.estimateVariancePct !== null && input.estimateVariancePct > 15) {
    penalty(
      'variance', 'Effort running over estimate', Math.min((input.estimateVariancePct - 15) * 0.8, 15), 15,
      `Logged effort is ${input.estimateVariancePct.toFixed(0)}% above estimate.`,
      'Check whether the estimate was wrong or the scope quietly grew — the answer changes your next quote.',
      input.estimateVariancePct > 40 ? 'high' : 'medium',
    );
  }

  if (input.averageApprovalTurnaroundDays !== null && input.averageApprovalTurnaroundDays > 7) {
    penalty(
      'turnaround', 'Slow approval turnaround', Math.min((input.averageApprovalTurnaroundDays - 7) * 0.7, 10), 10,
      `Approvals take ${input.averageApprovalTurnaroundDays.toFixed(1)} days on average.`,
      'Shorten the proposal: options beat explanations.', 'low',
    );
  }

  const score = Math.max(0, Math.round(100 - factors.reduce((s, f) => s + f.penalty, 0)));
  const band: HealthResult['band'] = score >= 85 ? 'healthy' : score >= 70 ? 'watch' : score >= 50 ? 'at_risk' : 'critical';

  const top = [...factors].sort((a, b) => b.penalty - a.penalty).slice(0, 2);
  const summary =
    factors.length === 0
      ? 'No scope-control weaknesses detected in the recorded data.'
      : `Biggest contributors: ${top.map((f) => f.label.toLowerCase()).join(' and ')}.`;

  return {
    score,
    band,
    factors: factors.sort((a, b) => b.penalty - a.penalty),
    summary,
    caveat:
      'This is a checklist of scope-control hygiene, not a prediction of project outcome, and it is not comparable between organisations.',
  };
}
