import { bestMatch, bestSegmentMatch, similarity, tokenize, type SimilarityScore } from './similarity';
import {
  countLanguageSignals,
  detectConcepts,
  matchesAny,
  type ConceptRule,
  type EffortCategory,
} from './lexicon';
import { BRAND } from '../config/brand';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DETERMINISTIC SCOPE CLASSIFICATION ENGINE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This engine answers, from evidence that exists in the database, the question:
 *   "What kind of request is this, and what exactly is the evidence?"
 *
 * It is intentionally NOT an AI system. It is reproducible, unit-testable, and
 * available with zero external services. The AI layer (see src/ai) may add semantic
 * nuance on top, but it may never override these facts and the product remains fully
 * usable if the AI provider is unreachable.
 *
 * Non-negotiable rules encoded here:
 *   R1. A request that matches an agreed requirement WITH acceptance criteria and
 *       describes malfunction → POSSIBLE DEFECT. It is never auto-priced.
 *   R2. A request already covered by an approved change order is IN SCOPE
 *       (covered by CO-x). It must not be re-charged — that is double billing.
 *   R3. An explicit exclusion quoted from the approved baseline is the strongest
 *       evidence available; nothing weaker may override it.
 *   R4. Contradictory strong evidence → CLARIFICATION REQUIRED, never a verdict.
 *   R5. Absence of evidence → NOT ENOUGH INFORMATION. The engine never invents a fact.
 */

export type ClassificationCategory =
  | 'duplicate_request'
  | 'covered_by_approved_change'
  | 'possible_defect'
  | 'in_scope'
  | 'included_revision'
  | 'revision_allowance_exceeded'
  | 'out_of_scope_evidenced'
  | 'scope_tradeoff'
  | 'clarification_required'
  | 'not_enough_information'
  | 'potential_scope_change';

export interface CategoryMeta {
  id: ClassificationCategory;
  label: string;
  /** Short internal explanation shown to reviewers. */
  description: string;
  /**
   * Default commercial posture. 'review' means: a human must decide; the system has no
   * opinion on whether money is owed. NOTHING here is an invoice.
   */
  defaultPosture: 'no_charge' | 'no_charge_after_delivery' | 'charge_candidate' | 'review';
  tone: 'neutral' | 'positive' | 'warning' | 'critical' | 'info';
  /** Actions the reviewer is nudged toward. */
  recommendedNextSteps: string[];
}

export const CATEGORY_META: Record<ClassificationCategory, CategoryMeta> = {
  duplicate_request: {
    id: 'duplicate_request',
    label: 'Duplicate request',
    description: 'An open request on this project already covers the same ground.',
    defaultPosture: 'no_charge',
    tone: 'neutral',
    recommendedNextSteps: ['Merge with the existing request or close as duplicate'],
  },
  covered_by_approved_change: {
    id: 'covered_by_approved_change',
    label: 'Already covered by an approved change',
    description: 'An approved change order already includes this work. Re-quoting would be double billing.',
    defaultPosture: 'no_charge_after_delivery',
    tone: 'info',
    recommendedNextSteps: ['Confirm against the approved change order', 'Track delivery, do not re-price'],
  },
  possible_defect: {
    id: 'possible_defect',
    label: 'Possible defect or omission',
    description:
      'Behaviour appears to fall short of an agreed requirement or its acceptance criteria. Investigate before discussing money.',
    defaultPosture: 'no_charge',
    tone: 'warning',
    recommendedNextSteps: [
      'Reproduce against the acceptance criteria',
      'Confirm whether it is a defect, a regression, or a misunderstanding',
      'Only if it is genuinely additional work, re-classify with a written reason',
    ],
  },
  in_scope: {
    id: 'in_scope',
    label: 'In scope',
    description: 'Covered by an approved requirement in the current baseline.',
    defaultPosture: 'no_charge',
    tone: 'positive',
    recommendedNextSteps: ['Assign and deliver within the agreed timeline'],
  },
  included_revision: {
    id: 'included_revision',
    label: 'Included revision',
    description: 'A revision that falls within the contractually included revision allowance.',
    defaultPosture: 'no_charge',
    tone: 'positive',
    recommendedNextSteps: ['Record the round against the allowance', 'Note remaining rounds for the client'],
  },
  revision_allowance_exceeded: {
    id: 'revision_allowance_exceeded',
    label: 'Revision allowance exceeded',
    description: 'Further revisions beyond the included rounds are a legitimate charge/extension candidate.',
    defaultPosture: 'charge_candidate',
    tone: 'warning',
    recommendedNextSteps: [
      'Confirm rounds already used with the project record',
      'Offer options: paid round, timeline extension, or deferral',
    ],
  },
  out_of_scope_evidenced: {
    id: 'out_of_scope_evidenced',
    label: 'Outside scope (explicit exclusion)',
    description: 'The approved baseline explicitly excludes this work.',
    defaultPosture: 'charge_candidate',
    tone: 'critical',
    recommendedNextSteps: ['Quote the exclusion to the client verbatim', 'Offer add / defer / substitute options'],
  },
  scope_tradeoff: {
    id: 'scope_tradeoff',
    label: 'Scope trade-off',
    description: 'The request replaces rather than adds. Often no money needs to change hands.',
    defaultPosture: 'review',
    tone: 'info',
    recommendedNextSteps: [
      'Compare effort of the incoming item against the item it replaces',
      'Offer a substitution at equal or adjusted value',
    ],
  },
  clarification_required: {
    id: 'clarification_required',
    label: 'Clarification required',
    description: 'The evidence is contradictory or the request is too vague to price responsibly.',
    defaultPosture: 'review',
    tone: 'warning',
    recommendedNextSteps: ['Send the suggested questions', 'Do not price until answered'],
  },
  not_enough_information: {
    id: 'not_enough_information',
    label: 'Not enough information',
    description: 'There is not yet enough detail to classify against the baseline.',
    defaultPosture: 'review',
    tone: 'neutral',
    recommendedNextSteps: ['Ask for the missing detail', 'Attach the original conversation or email'],
  },
  potential_scope_change: {
    id: 'potential_scope_change',
    label: 'Potential scope change',
    description: 'New work that no approved requirement or change order covers.',
    defaultPosture: 'charge_candidate',
    tone: 'warning',
    recommendedNextSteps: ['Estimate', 'Offer the trade-off menu', 'Send a change order for approval'],
  },
};

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface RequirementLike {
  key: string;
  kind: 'requirement' | 'exclusion';
  title: string;
  description: string;
  /** Stable acceptance criteria; their presence is what makes a defect claim checkable. */
  acceptanceCriteria: string[];
  category?: string;
  deliverable?: string;
  estimatedHours?: number;
}

export interface OpenRequestLike {
  ref: string;
  title: string;
  description: string;
  status: string;
  classification?: string;
}

export interface ApprovedChangeLike {
  number: string;
  title: string;
  description: string;
  addedRequirementKeys: string[];
  addedDeliverables: string[];
}

export interface RevisionPolicyLike {
  deliverable: string;
  included: number;
  used: number;
}

export interface ClassificationInput {
  text: string;
  title?: string;
  requirements: RequirementLike[];
  exclusions: RequirementLike[];
  openRequests?: OpenRequestLike[];
  approvedChanges?: ApprovedChangeLike[];
  revisionPolicies?: RevisionPolicyLike[];
  /** True when the requester supplied an attachment or quoted source evidence. */
  hasEvidence?: boolean;
}

// ── Outputs ──────────────────────────────────────────────────────────────────

export type CheckOutcome = 'match' | 'no_match' | 'partial' | 'unknown';

export interface CheckResult {
  id: string;
  label: string;
  outcome: CheckOutcome;
  /** Human-readable explanation of how this outcome was reached. */
  detail: string;
  score?: number;
  evidence: EvidenceRef[];
  /** Weight this check carries when deriving the category. Higher wins ties. */
  strength: number;
}

export interface EvidenceRef {
  type: 'requirement' | 'exclusion' | 'request' | 'change_order' | 'policy' | 'document' | 'text';
  /** Stable identifier, e.g. REQ-002, EXC-003, CR-2026-0014, CO-0002. */
  ref: string;
  /** Verbatim excerpt from the source record. Never generated prose. */
  excerpt: string;
  relation: 'supports' | 'contradicts' | 'related';
}

export interface ConfidenceFactor {
  label: string;
  delta: number;
  detail: string;
}

export interface ImpactHint {
  conceptId: string;
  label: string;
  /** Explicitly a suggestion for a human to confirm — never a price. */
  basis: 'SUGGESTED_UNVERIFIED';
  suggestedHours: Partial<Record<EffortCategory, number>>;
  totalHours: number;
}

export interface ClassificationResult {
  engineVersion: string;
  analysedAt: string;
  category: ClassificationCategory;
  categoryMeta: CategoryMeta;
  /**
   * Heuristic score 0..1 derived from the check outcomes below.
   * NOT a calibrated probability. Displayed as a band, never as a percentage claim.
   */
  confidence: number;
  confidenceBand: 'low' | 'medium' | 'high';
  confidenceFactors: ConfidenceFactor[];
  /** Every factor behind the score, so a reviewer can disagree with the arithmetic. */
  checks: CheckResult[];
  evidence: EvidenceRef[];
  missingInformation: string[];
  suggestedQuestions: string[];
  /** Concepts detected in the request, with the questions each one raises. */
  detectedConcepts: string[];
  impactHints: ImpactHint[];
  /** Highest-similarity baseline items, for the review screen. */
  nearestRequirements: { key: string; title: string; score: number }[];
  /** True when the input contained instruction-like text aimed at an automated system. */
  injectionSuspected: boolean;
  /**
   * Names of the guards that withheld a commercial posture. Empty means the category's default
   * posture was returned unchanged. Surfaced so the UI can explain WHY, rather than silently
   * showing a softer recommendation.
   */
  postureGuards: string[];
  /** Plain-language note a reviewer can adapt when talking to the client. */
  reviewerSummary: string;
  assumptions: string[];
}

// ── Thresholds (documented, versioned with engineVersion) ────────────────────

export const THRESHOLDS = {
  duplicate: 0.72,
  approvedCoverage: 0.62,
  exclusion: 0.34,
  exclusionStrong: 0.5,
  requirement: 0.3,
  requirementStrong: 0.45,
  vague: 0.35,
} as const;

const MIN_USEFUL_LENGTH = 24;
/** Below this many content words there is nothing to compare against a baseline. */
const MIN_CONTENT_TOKENS = 4;
/** Words that carry no request meaning; excluded when judging sufficiency. */
const STOPWORD_SET = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'we', 'you',
  'they', 'he', 'she', 'i', 'me', 'us', 'them', 'our', 'your', 'their', 'my', 'hi', 'hello', 'hey', 'please',
  'thanks', 'thank', 'quick', 'one', 'see', 'below', 'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could',
  'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'there', 'here', 'as', 'by', 'from', 'about',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function excerptOf(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function band(confidence: number): 'low' | 'medium' | 'high' {
  if (confidence >= 0.72) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

function conceptBoost(query: string, candidateText: string, concepts: ConceptRule[]): number {
  let boost = 0;
  for (const concept of concepts) {
    const inQuery = concept.keywords.some((k) => query.toLowerCase().includes(k.slice(0, Math.min(6, k.length))));
    const inCandidate = concept.keywords.some((k) => candidateText.toLowerCase().includes(k.slice(0, Math.min(6, k.length))));
    if (inQuery && inCandidate) boost += 0.06;
  }
  return boost;
}

// ── The engine ───────────────────────────────────────────────────────────────

export function classifyRequest(input: ClassificationInput): ClassificationResult {
  const question = [input.title ?? '', input.text].join('. ').trim();
  const openRequests = input.openRequests ?? [];
  const approvedChanges = input.approvedChanges ?? [];
  const policies = input.revisionPolicies ?? [];

  const signals = countLanguageSignals(question);
  const concepts = detectConcepts(question);
  const checks: CheckResult[] = [];
  const missingInformation: string[] = [];
  const suggestedQuestions: string[] = [];
  const assumptions: string[] = [];

  /**
   * Sufficiency is measured in content words, not characters. "Hi, quick one — see below." is
   * longer than the character minimum yet contains no request at all, and a character count would
   * wave it through to be classified as if it meant something.
   */
  const contentTokens = tokenize(input.text).filter((t) => !STOPWORD_SET.has(t));
  const hasUsefulDetail = contentTokens.length >= MIN_CONTENT_TOKENS || (signals.addition && contentTokens.length >= 2);

  if (!hasUsefulDetail) {
    missingInformation.push('The request is too short to classify. A description of the desired behaviour is required.');
  }

  // ── Check 1: duplicate against open requests ───────────────────────────────
  let duplicateOf: OpenRequestLike | null = null;
  if (openRequests.length > 0) {
    const ranked = bestMatch(
      question,
      openRequests.map((r) => ({ item: r, key: r.ref, text: `${r.title} ${r.description}` })),
      { limit: 1 },
    )[0];
    if (ranked && ranked.total >= THRESHOLDS.duplicate) {
      duplicateOf = ranked.item;
      checks.push({
        id: 'duplicate_open_request',
        label: 'Duplicate of an open request',
        outcome: 'match',
        score: ranked.total,
        strength: 95,
        detail: `Text similarity ${(ranked.total * 100).toFixed(0)}% with open request ${ranked.item.ref} (${ranked.item.status}).`,
        evidence: [
          {
            type: 'request',
            ref: ranked.item.ref,
            excerpt: excerptOf(`${ranked.item.title} — ${ranked.item.description}`),
            relation: 'related',
          },
        ],
      });
    } else if (ranked) {
      checks.push({
        id: 'duplicate_open_request',
        label: 'Duplicate of an open request',
        outcome: 'no_match',
        score: ranked.total,
        strength: 95,
        detail: `Closest open request (${ranked.item.ref}) scored ${(ranked.total * 100).toFixed(0)}%, below the ${(THRESHOLDS.duplicate * 100).toFixed(0)}% duplicate threshold.`,
        evidence: [],
      });
    }
  }

  // ── Check 2: already covered by an approved change order ───────────────────
  let coveredBy: ApprovedChangeLike | null = null;
  if (approvedChanges.length > 0) {
    const ranked = bestMatch(
      question,
      approvedChanges.map((c) => ({
        item: c,
        key: c.number,
        text: `${c.title} ${c.description} ${c.addedDeliverables.join(' ')}`,
      })),
      {
        limit: 1,
        boostFn: (cand) =>
          cand.item.addedRequirementKeys.filter((k) => question.toUpperCase().includes(k)).length * 0.2,
      },
    )[0];
    if (ranked && ranked.total >= THRESHOLDS.approvedCoverage) {
      coveredBy = ranked.item;
      checks.push({
        id: 'covered_by_approved_change',
        label: 'Covered by an approved change order',
        outcome: 'match',
        score: ranked.total,
        strength: 92,
        detail: `Matches approved change order ${ranked.item.number} (${(ranked.total * 100).toFixed(0)}% similarity). Re-pricing this would be double billing.`,
        evidence: [
          {
            type: 'change_order',
            ref: ranked.item.number,
            excerpt: excerptOf(`${ranked.item.title} — ${ranked.item.addedDeliverables.join(', ')}`),
            relation: 'supports',
          },
        ],
      });
    }
  }

  // ── Check 3: exclusion match (strongest negative evidence) ─────────────────
  let exclusionHit: { key: string; title: string; description: string; score: number; matchedSegment: string } | null = null;
  let exclusionWeak: { key: string; title: string; description: string; score: number } | null = null;
  if (input.exclusions.length > 0) {
    const ranked = bestSegmentMatch(
      question,
      input.exclusions.map((e) => ({
        item: e,
        key: e.key,
        text: `${e.title} ${e.description} ${e.acceptanceCriteria.join(' ')}`,
      })),
      {
        limit: 1,
        // The concept boost is scored against the matched clause, so a booking clause boosts the
        // booking exclusion even when the rest of the message is about something else.
        boostFn: (cand, segment) => conceptBoost(segment, `${cand.item.title} ${cand.item.description}`, concepts),
      },
    )[0];
    /**
     * An exclusion can be confirmed two ways:
     *   1. a strong lexical match against the exclusion wording, or
     *   2. a moderate lexical match PLUS at least one independent concept overlap, e.g. a clause
     *      about booking a table and paying a deposit against an exclusion about "booking,
     *      accounts and payments".
     * The second rule exists because clients rarely reuse an exclusion's exact words, and missing
     * an explicit exclusion is the more damaging error: the agency would deliver the work as if it
     * were included. Both rules still require lexical evidence — concepts alone are never enough.
     */
    const matchedClause = ranked ? ranked.segment || question : '';
    const conceptOverlaps = ranked
      ? concepts.filter(
          (c) =>
            c.keywords.some((k) => matchedClause.toLowerCase().includes(k.slice(0, Math.min(6, k.length)))) &&
            c.keywords.some((k) => `${ranked.item.title} ${ranked.item.description}`.toLowerCase().includes(k.slice(0, Math.min(6, k.length)))),
        ).length
      : 0;
    const exclusionConfirmed =
      Boolean(ranked) &&
      (ranked!.total >= THRESHOLDS.exclusionStrong ||
        (ranked!.total >= THRESHOLDS.exclusion && conceptOverlaps >= 1));

    if (ranked && exclusionConfirmed) {
      exclusionHit = {
        key: ranked.key,
        title: ranked.item.title,
        description: ranked.item.description,
        score: ranked.total,
        matchedSegment: ranked.segment,
      };
      checks.push({
        id: 'exclusion_match',
        label: 'Explicit exclusion in the approved baseline',
        outcome: 'match',
        score: ranked.total,
        strength: ranked.total >= THRESHOLDS.exclusionStrong ? 100 : 84,
        detail: `The approved baseline excludes this work (${ranked.key}, ${(ranked.total * 100).toFixed(0)}% match${conceptOverlaps ? ` plus ${conceptOverlaps} concept overlap(s)` : ''} on the clause ${ranked.segment ? `"${excerptOf(ranked.segment, 120)}"` : '(whole request)'}).`,
        evidence: [
          {
            type: 'exclusion',
            ref: ranked.key,
            excerpt: excerptOf(`${ranked.item.title}. ${ranked.item.description}`),
            relation: 'supports',
          },
        ],
      });
    } else if (ranked && ranked.total >= THRESHOLDS.exclusion) {
      exclusionWeak = { key: ranked.key, title: ranked.item.title, description: ranked.item.description, score: ranked.total };
      checks.push({
        id: 'exclusion_match',
        label: 'Explicit exclusion in the approved baseline',
        outcome: 'partial',
        score: ranked.total,
        strength: 100,
        detail: `Possible overlap with exclusion ${ranked.item.key} (${(ranked.total * 100).toFixed(0)}%), below the strong-evidence threshold — treat as a signal, not a conclusion.`,
        evidence: [
          {
            type: 'exclusion',
            ref: ranked.item.key,
            excerpt: excerptOf(`${ranked.item.title}. ${ranked.item.description}`),
            relation: 'related',
          },
        ],
      });
    } else {
      checks.push({
        id: 'exclusion_match',
        label: 'Explicit exclusion in the approved baseline',
        outcome: 'no_match',
        strength: 100,
        detail: `No exclusion in the approved baseline covers this request (${input.exclusions.length} exclusion(s) checked).`,
        evidence: [],
      });
    }
  } else {
    checks.push({
      id: 'exclusion_match',
      label: 'Explicit exclusion in the approved baseline',
      outcome: 'unknown',
      strength: 100,
      detail: 'The baseline contains no exclusions, so this check cannot rule anything in or out.',
      evidence: [],
    });
    missingInformation.push(
      'The approved baseline has no exclusions recorded. Adding explicit exclusions is what makes future "out of scope" conversations defensible.',
    );
  }

  // ── Check 3b: exclusion aligned to a detected concept ──────────────────────
  /**
   * Clients rarely repeat an exclusion's wording. A request for "French and German versions"
   * against an exclusion reading "no additional languages or localisation" shares almost no
   * trigrams, yet the meaning is identical. This check closes that gap deterministically:
   *
   *   an exclusion is aligned with a detected concept when the EXCLUSION ITSELF names that domain
   *   (at least two of the concept's keywords appear in the exclusion text) and the request
   *   contains the concept's domain language too.
   *
   * It is deliberately narrow: generic concepts ("additional content pages", "notifications")
   * are excluded, because an exclusion mentioning the word "content" is not evidence that it
   * covers a new page. Only domain concepts — booking, accounts, payments, integrations,
   * localisation, media, analytics and similar — can align this way.
   */
  const CONCEPT_ALIGNED_EXCLUSIONS = new Set([
    'booking', 'authentication', 'payments', 'integrations', 'localisation', 'media', 'analytics', 'seo',
    'accessibility', 'hosting_infra', 'mobile_app', 'search', 'dashboard', 'performance',
  ]);

  if (!exclusionHit && input.exclusions.length > 0) {
    for (const exclusion of input.exclusions) {
      const exclusionText = `${exclusion.title} ${exclusion.description}`.toLowerCase();
      for (const concept of concepts) {
        if (!CONCEPT_ALIGNED_EXCLUSIONS.has(concept.id)) continue;
        const keywordsInExclusion = concept.keywords.filter((k) => exclusionText.includes(k.slice(0, Math.min(6, k.length))));
        const keywordsInRequest = concept.keywords.filter((k) => question.toLowerCase().includes(k.slice(0, Math.min(6, k.length))));
        /**
         * Both sides must be substantive: the exclusion must really be about this domain (at least
         * three of the concept's keywords in its text) and the request must actually be asking for
         * it (at least two keywords, so a passing mention — or an injected sentence containing the
         * word "invoice" — cannot trigger an out-of-scope verdict).
         */
        if (keywordsInExclusion.length >= 3 && keywordsInRequest.length >= 2) {
          exclusionHit = {
            key: exclusion.key,
            title: exclusion.title,
            description: exclusion.description,
            score: 0.62,
            matchedSegment: '',
          };
          checks.push({
            id: 'exclusion_concept_match',
            label: 'Explicit exclusion covers this subject',
            outcome: 'match',
            score: 0.62,
            strength: 86,
            detail: `The agreed baseline excludes this subject: ${exclusion.key} — ${exclusion.title}. The request is about ${concept.label}, which is what that exclusion covers.`,
            evidence: [
              {
                type: 'exclusion',
                ref: exclusion.key,
                excerpt: excerptOf(`${exclusion.title}. ${exclusion.description}`),
                relation: 'supports',
              },
            ],
          });
          break;
        }
      }
      if (exclusionHit) break;
    }
  }

  // ── Check 4: requirement match ─────────────────────────────────────────────
  let requirementHit: { req: RequirementLike; score: number; sim: SimilarityScore; matchedSegment: string } | null = null;
  if (input.requirements.length > 0) {
    const ranked = bestSegmentMatch(
      question,
      input.requirements.map((r) => ({
        item: r,
        key: r.key,
        text: `${r.title} ${r.description} ${r.acceptanceCriteria.join(' ')} ${r.deliverable ?? ''}`,
      })),
      {
        limit: 1,
        boostFn: (cand, segment) => conceptBoost(segment, `${cand.item.title} ${cand.item.description}`, concepts),
      },
    )[0];
    if (ranked && ranked.total >= THRESHOLDS.requirement) {
      requirementHit = { req: ranked.item, score: ranked.total, sim: ranked.similarity, matchedSegment: ranked.segment };
      checks.push({
        id: 'requirement_match',
        label: 'Matching approved requirement',
        outcome: ranked.total >= THRESHOLDS.requirementStrong ? 'match' : 'partial',
        score: ranked.total,
        strength: 70,
        detail: `Closest approved requirement is ${ranked.item.key} — ${ranked.item.title} (${(ranked.total * 100).toFixed(0)}% match on the clause ${ranked.segment ? `"${excerptOf(ranked.segment, 120)}"` : '(whole request)'}).`,
        evidence: [
          {
            type: 'requirement',
            ref: ranked.item.key,
            excerpt: excerptOf(`${ranked.item.title}. ${ranked.item.description}`),
            relation: 'supports',
          },
        ],
      });
    } else {
      checks.push({
        id: 'requirement_match',
        label: 'Matching approved requirement',
        outcome: 'no_match',
        score: ranked?.total,
        strength: 70,
        detail: `No approved requirement matches this request (best candidate scored ${((ranked?.total ?? 0) * 100).toFixed(0)}%).`,
        evidence: [],
      });
    }
  } else {
    checks.push({
      id: 'requirement_match',
      label: 'Matching approved requirement',
      outcome: 'unknown',
      strength: 70,
      detail: 'The baseline has no structured requirements, so no comparison was possible.',
      evidence: [],
    });
    missingInformation.push('No approved requirements exist for this project. Establish a baseline before pricing changes.');
  }

  // ── Check 5: defect signal vs. acceptance criteria ─────────────────────────
  const defectEvidence: EvidenceRef[] = [];
  let defectStrength = 0;
  if (signals.defect) {
    const target = requirementHit?.req;
    if (target) {
      defectEvidence.push({
        type: 'requirement',
        ref: target.key,
        excerpt: excerptOf(`${target.title}. ${target.description}`),
        relation: 'supports',
      });
      const hasCriteria = target.acceptanceCriteria.length > 0;
      for (const criterion of target.acceptanceCriteria.slice(0, 3)) {
        defectEvidence.push({ type: 'text', ref: target.key, excerpt: excerptOf(criterion, 160), relation: 'related' });
      }
      defectStrength = hasCriteria ? 88 : 62;
      checks.push({
        id: 'defect_signal',
        label: 'Malfunction described against an agreed requirement',
        outcome: 'match',
        strength: defectStrength,
        detail: hasCriteria
          ? `The request describes something not working, and ${target.key} has recorded acceptance criteria to check it against. Treat as a suspected defect until reproduced.`
          : `The request describes something not working and relates to ${target.key}, but that requirement has no acceptance criteria, so "working as agreed" cannot be objectively tested.`,
        evidence: defectEvidence,
      });
      if (!hasCriteria) {
        missingInformation.push(
          `${target.key} has no acceptance criteria. Without them, whether this is a defect or a change cannot be settled objectively.`,
        );
        suggestedQuestions.push(
          `For ${target.key}, what exactly should happen, step by step, for you to consider it working?`,
        );
      }
    } else {
      // No requirement matched closely enough to name a target. The report is still about
      // something not working, and treating it as a routine change request would invite a
      // charge for repairing our own work. Record it as a suspected defect at a lower strength,
      // flag the missing target, and let a human confirm.
      defectStrength = 52;
      missingInformation.push(
        'The reported fault could not be tied to a specific approved requirement. Confirm which agreed deliverable it affects before discussing cost.',
      );
      checks.push({
        id: 'defect_signal',
        label: 'Malfunction described against an agreed requirement',
        outcome: 'partial',
        strength: defectStrength,
        detail:
          'The request describes something not working, but it does not map to any approved requirement. It may relate to work outside the agreed baseline.',
        evidence: [],
      });
      missingInformation.push(
        'The reported problem does not map to an approved requirement. Clarify which agreed deliverable it affects.',
      );
    }
  } else {
    checks.push({
      id: 'defect_signal',
      label: 'Malfunction described against an agreed requirement',
      outcome: 'no_match',
      strength: 30,
      detail: 'The request does not describe existing behaviour failing.',
      evidence: [],
    });
  }

  // ── Check 6: revision allowance ────────────────────────────────────────────
  /**
   * Revision allowance analysis.
   *
   * Two decisions matter here, and both were wrong in an earlier version:
   *
   *  1. A revision question is only asked when the request is actually about revisions. Any
   *     wording change used to be compared against the design allowance, which turned a one-line
   *     copy edit into "your revision rounds are used up".
   *  2. When the project records allowances per deliverable, the request has to name that
   *     deliverable before its numbers are applied. Falling back to "the first policy" would
   *     attribute a form-copy change to the home page design budget.
   */
  const revisionRelevant =
    (signals.modification || concepts.some((c) => c.id === 'design_change')) && !signals.defect && !signals.addition;

  const policyByName = (): RevisionPolicyLike | null => {
    const lower = question.toLowerCase();
    const matched = policies.find((p) => {
      if (lower.includes(p.deliverable.toLowerCase())) return true;
      const tokens = p.deliverable.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
      const hits = tokens.filter((t) => lower.includes(t)).length;
      return tokens.length > 0 && hits >= Math.min(2, tokens.length);
    });
    if (matched) return matched;
    // The requirement's own deliverable field is a fallback only when it names a real policy.
    const fromRequirement = requirementHit?.req.deliverable?.toLowerCase();
    return fromRequirement ? policies.find((p) => p.deliverable.toLowerCase() === fromRequirement) ?? null : null;
  };

  let revisionOutcome: 'within' | 'exceeded' | 'not_applicable' | 'unclear' = 'not_applicable';
  let revisionNote = '';
  let revisionConfidenceDelta = 0;
  if (revisionRelevant && policies.length > 0) {
    const policy = policies.length === 1 ? policies[0] : policyByName();
    if (!policy) {
      revisionOutcome = 'unclear';
      revisionNote = 'The project records revision allowances per deliverable, and this request does not name one of them.';
      missingInformation.push(
        `Which deliverable does this revise? Recorded allowances: ${policies.map((p) => `${p.deliverable} (${p.used}/${p.included} used)`).join(', ')}.`,
      );
      checks.push({
        id: 'revision_allowance',
        label: 'Included revision rounds',
        outcome: 'unknown',
        strength: 75,
        detail: revisionNote,
        evidence: [],
      });
    } else if (policy.used >= policy.included) {
      revisionOutcome = 'exceeded';
      revisionNote = `${policy.deliverable}: ${policy.used} of ${policy.included} included round(s) used.`;
      checks.push({
        id: 'revision_allowance',
        label: 'Included revision rounds',
        outcome: 'match',
        strength: 80,
        detail: `${revisionNote} A further round is a legitimate charge, extension or deferral candidate.`,
        evidence: [
          {
            type: 'requirement',
            ref: requirementHit?.req.key ?? 'policy',
            excerpt: excerptOf(`${policy.deliverable}: ${policy.included} revision round(s) included, ${policy.used} used.`),
            relation: 'supports',
          },
        ],
      });
      // Applied to the confidence score later, where the factor list is assembled.
      revisionConfidenceDelta = 0.08;
    } else {
      revisionOutcome = 'within';
      revisionNote = `${policy.deliverable}: ${policy.used} of ${policy.included} included round(s) used — ${policy.included - policy.used} remaining.`;
      checks.push({
        id: 'revision_allowance',
        label: 'Included revision rounds',
        outcome: 'partial',
        strength: 70,
        detail: revisionNote,
        evidence: [],
      });
    }
  } else if (revisionRelevant && policies.length === 0) {
    revisionOutcome = 'unclear';
    revisionNote = 'No revision allowance is recorded for this project, so nothing can be compared.';
    missingInformation.push('No revision allowance is recorded. How many revision rounds are included for this deliverable?');
    checks.push({
      id: 'revision_allowance',
      label: 'Included revision rounds',
      outcome: 'unknown',
      strength: 75,
      detail: revisionNote,
      evidence: [],
    });
  } else if (!revisionRelevant) {
    checks.push({
      id: 'revision_allowance',
      label: 'Included revision rounds',
      outcome: 'no_match',
      strength: 75,
      detail: 'The request is not a revision of delivered work, so no revision allowance was consumed.',
      evidence: [],
    });
  }

  // ── Check 8: information sufficiency ───────────────────────────────────────
  const vagueHits = signals.vague;
  const sufficiencyScore =
    (hasUsefulDetail ? 0.5 : 0) +
    (input.hasEvidence ? 0.15 : 0) +
    (input.text.trim().length >= 160 ? 0.2 : 0) +
    (concepts.length > 0 ? 0.15 : 0);
  const insufficient = !hasUsefulDetail || sufficiencyScore < THRESHOLDS.vague;
  checks.push({
    id: 'information_sufficiency',
    label: 'Information sufficiency',
    outcome: insufficient ? 'match' : vagueHits ? 'partial' : 'no_match',
    score: Number(sufficiencyScore.toFixed(2)),
    strength: 55,
    detail: insufficient
      ? 'The description does not yet contain enough specifics to estimate responsibly.'
      : vagueHits
        ? 'The description contains subjective wording ("modern", "clean", "similar to") that will need agreeing before it can be verified.'
        : 'The description contains enough concrete detail to begin estimating.',
    evidence: [],
  });
  if (vagueHits) {
    suggestedQuestions.push(
      'Can you describe the desired outcome in measurable terms (what changes, where, and how we will know it is right)?',
    );
  }

  // ── Check 9: prompt-injection posture (recorded, never acted upon) ─────────
  if (signals.injection) {
    checks.push({
      id: 'instruction_injection',
      label: 'Instruction-like text inside the request',
      outcome: 'match',
      strength: 90,
      detail:
        'The request contains text that appears to instruct an automated system (for example, "mark this as approved"). It has been recorded as data and carried no authority over classification, pricing or approval.',
      evidence: [
        {
          type: 'text',
          ref: 'request.body',
          excerpt: excerptOf(input.text, 180),
          relation: 'contradicts',
        },
      ],
    });
  }

  // ── Derive category by documented precedence ───────────────────────────────
  let category: ClassificationCategory;
  if (duplicateOf) {
    category = 'duplicate_request';
  } else if (coveredBy) {
    category = 'covered_by_approved_change';
  } else if (exclusionHit && signals.defect && requirementHit) {
    // R4: contradictory strong evidence never resolves to a verdict.
    category = 'clarification_required';
    suggestedQuestions.push(
      'You have described something not working, but this area is also listed as excluded from the agreed scope. Which behaviour were you expecting, and when was it agreed?',
    );
    missingInformation.push(
      'Contradictory evidence: the request both (a) describes a failure of agreed behaviour and (b) matches an explicit exclusion.',
    );
  } else if (exclusionHit) {
    category = 'out_of_scope_evidenced';
  } else if (signals.defect && defectStrength >= 50) {
    category = 'possible_defect';
  } else if (revisionOutcome === 'exceeded') {
    category = 'revision_allowance_exceeded';
  } else if (signals.tradeoff && requirementHit) {
    category = 'scope_tradeoff';
  } else if (revisionOutcome === 'within' && requirementHit) {
    category = 'included_revision';
  } else if (requirementHit && requirementHit.score >= THRESHOLDS.requirementStrong && !signals.addition) {
    category = 'in_scope';
  } else if (!hasUsefulDetail && !requirementHit && !exclusionWeak) {
    category = 'not_enough_information';
  } else if (insufficient || (vagueHits && !requirementHit && !exclusionWeak)) {
    category = 'clarification_required';
  } else {
    category = 'potential_scope_change';
  }

  /**
   * Symmetry rule for untrusted content.
   *
   * Injection guards usually protect against text that asks for a FAVOURABLE outcome ("mark this
   * as in scope"). The same text can also be crafted to look like an obvious exclusion match. In
   * both directions the correct behaviour is the same: do not let text that tries to instruct the
   * system decide the commercial question. The evidence is kept and shown, the category softens to
   * "a human must look at this", and nothing is asserted on the strength of it.
   */
  if (signals.injection && category === 'out_of_scope_evidenced') {
    category = 'potential_scope_change';
    missingInformation.push(
      'This request contains text that appears to instruct an automated system. It has been treated as data, but a person must read the original message before any scope decision is recorded.',
    );
  }

  // ── Confidence: additive factors, fully exposed ─────────────────────────────
  const confidenceFactors: ConfidenceFactor[] = [];
  let confidence = 0.35;

  if (revisionConfidenceDelta !== 0) {
    confidenceFactors.push({ label: 'Revision allowance exhausted', delta: revisionConfidenceDelta, detail: revisionNote });
  }

  const strongEvidence = checks
    .flatMap((c) => c.evidence)
    .filter((e) => e.relation === 'supports' && (e.type === 'requirement' || e.type === 'exclusion' || e.type === 'change_order'));

  if (strongEvidence.length > 0) {
    confidence += 0.2;
    confidenceFactors.push({
      label: 'Anchored to baseline evidence',
      delta: 0.2,
      detail: `${strongEvidence.length} direct reference(s) to approved baseline items or change orders.`,
    });
  } else {
    confidence -= 0.12;
    confidenceFactors.push({
      label: 'No direct baseline anchor',
      delta: -0.12,
      detail: 'The result rests on wording analysis rather than a citation from the approved baseline.',
    });
  }

  const topMatch = requirementHit?.score ?? exclusionHit?.score ?? 0;
  if (topMatch >= 0.55) {
    confidence += 0.18;
    confidenceFactors.push({ label: 'Strong textual match', delta: 0.18, detail: `Best match scored ${(topMatch * 100).toFixed(0)}%.` });
  } else if (topMatch >= 0.4) {
    confidence += 0.08;
    confidenceFactors.push({ label: 'Moderate textual match', delta: 0.08, detail: `Best match scored ${(topMatch * 100).toFixed(0)}%.` });
  } else if (topMatch > 0) {
    confidence -= 0.06;
    confidenceFactors.push({ label: 'Weak textual match', delta: -0.06, detail: `Best match scored only ${(topMatch * 100).toFixed(0)}%.` });
  }

  if (exclusionHit) {
    confidence += 0.15;
    confidenceFactors.push({ label: 'Explicit exclusion quoted', delta: 0.15, detail: 'An exclusion in the approved baseline covers this work.' });
  }
  if (category === 'possible_defect') {
    confidence += 0.1;
    confidenceFactors.push({ label: 'Objective failure language', delta: 0.1, detail: 'The request describes behaviour failing, which is checkable against acceptance criteria.' });
  }
  if (category === 'not_enough_information' || category === 'clarification_required') {
    confidence = Math.min(confidence, 0.45);
    confidenceFactors.push({
      label: 'Capped for ambiguous input',
      delta: 0,
      detail: 'Confidence is capped when the outcome is "ask a human", because the system has no verdict to be confident about.',
    });
  }
  if (!hasUsefulDetail) {
    confidence -= 0.15;
    confidenceFactors.push({ label: 'Sparse description', delta: -0.15, detail: `Only ${input.text.trim().length} characters of detail were supplied.` });
  }
  if (concepts.length >= 2) {
    confidence += 0.05;
    confidenceFactors.push({ label: 'Recognisable work category', delta: 0.05, detail: `Detected concepts: ${concepts.map((c) => c.label).join(', ')}.` });
  }
  if (signals.injection) {
    confidenceFactors.push({
      label: 'Untrusted instructions detected',
      delta: 0,
      detail: 'Instruction-like content was ignored for classification purposes; a human should read the original text.',
    });
  }
  confidence = Math.max(0.05, Math.min(0.95, Number(confidence.toFixed(2))));

  // ── Questions & missing information from concepts ──────────────────────────
  for (const concept of concepts) {
    suggestedQuestions.push(...concept.questions);
  }
  if (category === 'potential_scope_change' && concepts.length === 0) {
    suggestedQuestions.push(
      'What is the desired behaviour in detail, and which existing page, screen or document is affected?',
    );
  }
  if (category === 'out_of_scope_evidenced') {
    suggestedQuestions.push('Would you like this quoted as a separate change, deferred to a later phase, or swapped for something of similar size?');
  }
  if (!input.hasEvidence) {
    missingInformation.push('No source evidence (email, message screenshot, meeting note or document) is attached to this request.');
  }

  // ── Impact hints (explicitly unverified) ────────────────────────────────────
  const impactHints: ImpactHint[] = concepts
    .filter((c) => Object.keys(c.suggestedHours).length > 0)
    .map((c) => {
      const entries = Object.entries(c.suggestedHours) as [EffortCategory, number][];
      return {
        conceptId: c.id,
        label: c.label,
        basis: 'SUGGESTED_UNVERIFIED' as const,
        suggestedHours: c.suggestedHours,
        totalHours: entries.reduce((sum, [, h]) => sum + h, 0),
      };
    });

  const nearestRequirements = bestSegmentMatch(
    question,
    input.requirements.map((r) => ({ item: r, key: r.key, text: `${r.title} ${r.description} ${r.acceptanceCriteria.join(' ')}` })),
    { limit: 5 },
  ).map((m) => ({ key: m.key, title: m.item.title, score: m.total }));

  const evidence = dedupeEvidence(checks.flatMap((c) => c.evidence));

  /**
   * Posture guard — the part of the engine that refuses to be clever.
   *
   * Two situations must never produce a "you may be charged" default, however the scoring lands:
   *
   *  1. The request reports something broken. A client reporting a fault is not a client making
   *     a new request, and telling an agency to price it before the fault is reproduced is how
   *     relationships are damaged. The posture becomes `review`: a human decides whether it is a
   *     defect, and nothing about money is discussed with the client until that is settled.
   *
   *  2. The request is a small modification that maps to an agreed requirement, with no new
   *     capability and no exclusion in play. That is exactly where an agency looks careless for
   *     itemising a change: it might be covered by the agreed revision allowance, or it might
   *     not. Again `review`.
   *
   * In both cases the classification itself is untouched — only the recommended commercial
   * posture is withheld, which is the conservative direction for a tool that must never
   * declare that a client owes money.
   */
  const generatedSummary = buildReviewerSummary(category, {
    requirementHit,
    exclusionHit,
    coveredBy,
    duplicateOf,
    revisionNote,
    confidence,
  });

  const supportingRequirement = evidence.some((e) => e.type === 'requirement' && e.relation === 'supports');
  const postureGuards: string[] = [];
  let effectivePosture = CATEGORY_META[category].defaultPosture;

  if (signals.tradeoff && !requirementHit && !exclusionHit && effectivePosture === 'charge_candidate') {
    effectivePosture = 'review';
    postureGuards.push('tradeoff_without_counterparty');
    missingInformation.push(
      'This reads as a substitution, but no matching item was found in the approved baseline. Confirm which agreed deliverable is being swapped before any effort is estimated — a trade-off with nothing to trade against is simply a new request.',
    );
  }

  if (signals.defect && !exclusionHit && effectivePosture === 'charge_candidate') {
    effectivePosture = 'review';
    postureGuards.push('defect_reported');
    missingInformation.push(
      'Confirm which agreed deliverable is affected before any cost is discussed. A reported fault is not priced until someone has reproduced it and judged whether it is a defect, a regression, or a misunderstanding.',
    );
  } else if (
    signals.modification &&
    !signals.addition &&
    !signals.defect &&
    !exclusionHit &&
    supportingRequirement &&
    effectivePosture === 'charge_candidate'
  ) {
    effectivePosture = 'review';
    postureGuards.push('small_modification_may_be_covered');
    missingInformation.push(
      'Check the agreed revision allowance and the acceptance criteria for the related requirement before treating this as a change. It may be covered by what was already agreed.',
    );
  }

  const categoryMeta: CategoryMeta =
    effectivePosture === CATEGORY_META[category].defaultPosture
      ? CATEGORY_META[category]
      : {
          ...CATEGORY_META[category],
          defaultPosture: effectivePosture,
          description: `${CATEGORY_META[category].description} The recommended posture is deliberately withheld pending human review.`,
        };

  /**
   * The reviewer summary must agree with the posture above. A summary telling a reviewer to
   * "estimate it and present the options" while the posture says "review" would be worse than
   * either on its own: the reviewer would read the prose and miss the guard.
   */
  const reviewerSummary = postureGuards.includes('tradeoff_without_counterparty')
    ? 'This reads as a substitution rather than new work, but the baseline does not show what is being given up. Establish which agreed deliverable is being replaced before estimating: if nothing is, this is an addition and should be priced as one.'
    : postureGuards.includes('defect_reported')
    ? 'This reads as something not working rather than as a new request. Reproduce it against the related requirement first: if it is a defect, correcting it is part of what was already agreed, and no cost should be raised with the client until that is settled.'
    : postureGuards.includes('small_modification_may_be_covered')
      ? 'This looks like a small adjustment to something already agreed rather than a new capability. Check the recorded revision allowance and acceptance criteria before treating it as a change — it may already be covered.'
      : generatedSummary;

  return {
    engineVersion: BRAND.engineVersion,
    analysedAt: new Date().toISOString(),
    category,
    categoryMeta,
    postureGuards,
    confidence,
    confidenceBand: band(confidence),
    confidenceFactors,
    checks,
    evidence,
    missingInformation: dedupe(missingInformation),
    suggestedQuestions: dedupe(suggestedQuestions),
    detectedConcepts: concepts.map((c) => c.label),
    impactHints,
    nearestRequirements,
    injectionSuspected: signals.injection,
    reviewerSummary,
    assumptions: buildAssumptions({ hasEvidence: input.hasEvidence ?? false, exclusionCount: input.exclusions.length, requirementCount: input.requirements.length }),
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function dedupeEvidence(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.ref}:${ref.excerpt.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

interface SummaryContext {
  requirementHit: { req: RequirementLike; score: number } | null;
  exclusionHit: { key: string; title: string; description: string; score: number } | null;
  coveredBy: ApprovedChangeLike | null;
  duplicateOf: OpenRequestLike | null;
  revisionNote: string;
  confidence: number;
}

/**
 * A neutral, non-accusatory paragraph a reviewer can adapt. Written to protect the
 * client relationship: it states evidence and asks, rather than asserting entitlement.
 */
function buildReviewerSummary(category: ClassificationCategory, ctx: SummaryContext): string {
  const strength = ctx.confidence >= 0.72 ? 'clear' : ctx.confidence >= 0.5 ? 'reasonable' : 'limited';
  switch (category) {
    case 'duplicate_request':
      return `This looks like the same request as ${ctx.duplicateOf?.ref ?? 'an existing open request'}. The evidence is ${strength}: the wording overlaps substantially. Merging them keeps one decision and one price rather than two.`;
    case 'covered_by_approved_change':
      return `This work appears to be already included in approved change order ${ctx.coveredBy?.number ?? ''}. The evidence is ${strength}. If so, no further charge applies — confirm scope against that order and deliver.`;
    case 'possible_defect':
      return `This reads as something not working rather than a new request. The evidence is ${strength}, and it points at an agreed requirement. Reproduce it against the acceptance criteria first: if it is a defect, the fix is included, and no cost should be discussed with the client until that is settled.`;
    case 'in_scope':
      return `This is covered by ${ctx.requirementHit?.req.key ?? 'an approved requirement'} (${ctx.requirementHit?.req.title ?? ''}). The evidence is ${strength}. It should be delivered as agreed work; no change order is needed.`;
    case 'included_revision':
      return `This is a revision of existing work and the allowance covers it. ${ctx.revisionNote} Recording the round used keeps the remaining allowance visible to both sides.`;
    case 'revision_allowance_exceeded':
      return `This is a further revision and the included rounds are used up. ${ctx.revisionNote} That makes it a fair topic for a paid round, a timeline extension, or deferral — but the decision is the client's, and all three should be offered rather than only the paid option.`;
    case 'out_of_scope_evidenced':
      return `The agreed baseline explicitly excludes this (${ctx.exclusionHit?.key ?? ''}: ${ctx.exclusionHit?.description ?? ''}). The evidence is ${strength}. Quote the exclusion word-for-word, then offer options: add it as a priced change, defer it to a later phase, or swap it for something of similar size.`;
    case 'scope_tradeoff':
      return `This looks like a substitution rather than an addition: something is being replaced rather than added. Comparing the effort of the outgoing and incoming items often removes the need to charge at all.`;
    case 'clarification_required':
      return `The evidence is mixed or the request is too general to price responsibly. The evidence is ${strength}. Asking the prepared questions before estimating protects both sides from a quote that later has to be revised.`;
    case 'not_enough_information':
      return `There is not yet enough detail to compare this against the agreed scope. Asking the prepared questions is the fastest route to a confident answer.`;
    case 'potential_scope_change':
      return `This does not appear in the agreed baseline or in any approved change. The evidence is ${strength}. Estimate it, then present the options — priced addition, timeline extension, substitution, deferral, or a goodwill inclusion — so the client chooses rather than being told.`;
    default:
      return '';
  }
}

function buildAssumptions(input: { hasEvidence: boolean; exclusionCount: number; requirementCount: number }): string[] {
  const out: string[] = [];
  out.push(
    input.requirementCount > 0
      ? `Compared against ${input.requirementCount} approved requirement(s) in the current baseline.`
      : 'No approved requirements were available for comparison.',
  );
  if (input.exclusionCount === 0) out.push('No exclusions are recorded in the baseline; absence of an exclusion is not evidence that work was agreed.');
  if (!input.hasEvidence) out.push('No source evidence was attached, so the request text alone was analysed.');
  out.push('Classification is advisory input to a human review; it is not a contractual determination.');
  return out;
}
