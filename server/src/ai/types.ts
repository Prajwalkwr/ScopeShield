import type { ClassificationCategory } from '../domain/classification';

/**
 * AI contract. Providers are swappable, and the product is fully usable when none is
 * configured (the heuristic provider satisfies this interface with zero network access).
 */
export interface AnalyzeScopeInput {
  requestTitle: string;
  requestText: string;
  projectName: string;
  clientName: string;
  currency: string;
  requirements: {
    key: string;
    kind: 'requirement' | 'exclusion';
    title: string;
    description: string;
    acceptanceCriteria: string[];
    deliverable?: string;
  }[];
  /** What the deterministic engine concluded. The model must respect it as prior evidence. */
  deterministic: {
    category: ClassificationCategory;
    confidence: number;
    evidenceRefs: string[];
    checks: { id: string; outcome: string; detail: string }[];
    missingInformation: string[];
  };
}

export interface AiAnalysisOutput {
  /** A suggestion only. The engine's category stands unless a human overrides it. */
  suggestedCategory: ClassificationCategory | '';
  /** Why, in plain language, referencing the keys above. */
  explanation: string;
  /** Only keys that exist in the input; anything else is dropped by verification. */
  citedRequirementKeys: string[];
  citedExclusionKeys: string[];
  additionalQuestions: string[];
  missingInformation: string[];
  /** Draft wording the agency may adapt when talking to the client. Never auto-sent. */
  clientFacingNote: string;
  confidenceNote: string;
}

export interface AiUsageInfo {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export type AiResult =
  | { ok: true; output: AiAnalysisOutput; usage: AiUsageInfo; degraded: false }
  | { ok: false; error: { code: string; message: string }; usage: AiUsageInfo; degraded: true };

export interface AiProvider {
  readonly name: 'heuristic' | 'openai' | 'anthropic';
  readonly model: string;
  readonly requiresNetwork: boolean;
  isConfigured(): boolean;
  analyzeScope(input: AnalyzeScopeInput): Promise<AiResult>;
}
