import { env } from '../config/env';
import { logger } from '../platform/logger';
import { AnthropicProvider, HeuristicProvider, OpenAiCompatibleProvider } from './providers';
import type { AiProvider } from './types';

export * from './types';
export { aiAnalysisSchema } from './providers';

const heuristic = new HeuristicProvider();

/**
 * Provider selection. Resolution order:
 *   1. The organization setting passed in (admins control this per organization).
 *   2. The deployment default from env.
 *   3. The heuristic provider.
 *
 * A provider that is requested but not configured (missing key) DEGRADES to heuristic and
 * reports why — it never throws, and it never silently pretends a model was consulted.
 */
export function resolveAiProvider(preferred?: 'heuristic' | 'openai' | 'anthropic'): {
  provider: AiProvider;
  degradedFrom: string | null;
  reason: string;
} {
  const wanted = preferred ?? env.aiProvider;

  if (wanted === 'openai') {
    const p = new OpenAiCompatibleProvider(env.openaiApiKey, env.openaiModel, env.openaiBaseUrl);
    if (p.isConfigured()) return { provider: p, degradedFrom: null, reason: 'OpenAI-compatible provider configured.' };
    return { provider: heuristic, degradedFrom: 'openai', reason: 'OPENAI_API_KEY is not set, so the deterministic provider was used.' };
  }
  if (wanted === 'anthropic') {
    const p = new AnthropicProvider(env.anthropicApiKey, env.anthropicModel);
    if (p.isConfigured()) return { provider: p, degradedFrom: null, reason: 'Anthropic provider configured.' };
    return { provider: heuristic, degradedFrom: 'anthropic', reason: 'ANTHROPIC_API_KEY is not set, so the deterministic provider was used.' };
  }

  if (wanted !== 'heuristic') {
    logger.warn('Unknown AI provider requested; using heuristic', { wanted });
  }
  return {
    provider: heuristic,
    degradedFrom: null,
    reason: 'Deterministic provider in use (no external AI service is contacted).',
  };
}

/** Providers that need no network — used by tests and by "no AI" organizations. */
export function heuristicProvider(): AiProvider {
  return heuristic;
}
