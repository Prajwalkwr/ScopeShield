/**
 * Deterministic text similarity. No model, no network, fully testable.
 * Used for duplicate detection, requirement/exclusion matching and dedupe hints.
 *
 * Two complementary signals:
 *   - dice(a,b): character-trigram overlap — robust to word order and morphology
 *   - containment(a,b): share of the query's content tokens present in the candidate —
 *     catches "add a booking page" against "booking system is excluded"
 * Both are combined with a weight, and a concept-lexicon bump is applied by callers.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'to', 'of', 'in', 'on', 'at', 'by', 'for',
  'with', 'without', 'from', 'into', 'onto', 'over', 'under', 'about', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might',
  'must', 'we', 'i', 'you', 'they', 'he', 'she', 'it', 'this', 'that', 'these', 'those', 'our', 'your', 'their',
  'my', 'me', 'us', 'them', 'please', 'also', 'just', 'like', 'want', 'need', 'would', 'want', 'new', 'some',
  'any', 'all', 'more', 'most', 'very', 'really', 'now', 'get', 'got', 'make', 'made', 'there', 'here', 'when',
  'what', 'which', 'who', 'how', 'why', 'not', 'no', 'yes', 'ok', 'okay',
]);

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s./+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Crude suffix stripping — good enough to align "booking/bookings/booked". */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suffix of ['ings', 'ing', 'ies', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      const base = token.slice(0, token.length - suffix.length);
      if (suffix === 'ies') return `${base}y`;
      return base;
    }
  }
  return token;
}

export function tokenize(text: string, opts: { keepStopwords?: boolean } = {}): string[] {
  const words = normalise(text)
    .split(/[\s./+-]+/)
    .filter((w) => w.length > 1)
    .map(stem);
  return opts.keepStopwords ? words : words.filter((w) => !STOPWORDS.has(w));
}

function trigrams(text: string): Set<string> {
  const s = ` ${normalise(text).replace(/\s+/g, ' ')} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i += 1) out.add(s.slice(i, i + 3));
  return out;
}

/** Sørensen–Dice coefficient over character trigrams. 0..1 */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return (2 * shared) / (A.size + B.size);
}

/** Fraction of the query's content tokens that appear in the candidate. 0..1 */
export function containment(query: string, candidate: string): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const c = new Set(tokenize(candidate));
  let hit = 0;
  for (const t of q) if (c.has(t)) hit += 1;
  return hit / q.size;
}

export interface SimilarityScore {
  score: number;
  dice: number;
  containment: number;
  matchedTokens: string[];
}

/** Weighted blend. Containment is weighted higher: it reflects topical coverage. */
export function similarity(a: string, b: string): SimilarityScore {
  const d = dice(a, b);
  const c = containment(a, b);
  const cReverse = containment(b, a);
  const coverage = (c + cReverse) / 2;
  return {
    score: Number((0.4 * d + 0.6 * coverage).toFixed(4)),
    dice: Number(d.toFixed(4)),
    containment: Number(coverage.toFixed(4)),
    matchedTokens: tokenize(a).filter((t) => new Set(tokenize(b)).has(t)),
  };
}

export interface Candidate<T> {
  item: T;
  key: string;
  text: string;
}

export interface BestMatch<T> {
  item: T;
  key: string;
  similarity: SimilarityScore;
  /** Extra score contributed by a caller-supplied signal (e.g. lexicon concept hit). */
  boost: number;
  total: number;
}

export function bestMatch<T>(
  query: string,
  candidates: Candidate<T>[],
  opts: { boostFn?: (candidate: Candidate<T>, query: string) => number; limit?: number } = {},
): BestMatch<T>[] {
  const scored = candidates
    .map((candidate) => {
      const sim = similarity(query, candidate.text);
      const boost = opts.boostFn ? opts.boostFn(candidate, query) : 0;
      // A boost may never exceed 0.25 so it can nudge, not override, lexical evidence.
      const boundedBoost = Math.min(boost, 0.25);
      return { item: candidate.item, key: candidate.key, similarity: sim, boost: boundedBoost, total: Number((sim.score + boundedBoost).toFixed(4)) };
    })
    .sort((a, b) => b.total - a.total);
  return opts.limit ? scored.slice(0, opts.limit) : scored;
}

/**
 * Splits a request into clause-level segments.
 *
 * Long client emails bury the signal: a booking request that also mentions launch dates,
 * a second location and a deposit has its one decisive sentence diluted if the whole message is
 * compared as a single string. Matching per segment, and keeping the best segment, is what lets
 * the engine see "can we add online table booking" inside three paragraphs of context.
 */
export function segmentise(text: string, minWords = 4): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+|\s[•·\u2013\u2014-]\s+/)
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter((segment) => segment.split(' ').filter(Boolean).length >= minWords);
}

export interface SegmentMatch<T> extends BestMatch<T> {
  /** The client clause that produced the best score, quoted for the reviewer. */
  segment: string;
}

/**
 * Best match across every (segment × candidate) pair.
 *
 * The returned score is the best pair's score, so a single decisive clause can carry a match
 * that the whole-text comparison would miss. Segment matching never *lowers* a score relative to
 * whole-text matching, because the whole query is always considered as one of the segments.
 */
export function bestSegmentMatch<T>(
  query: string,
  candidates: Candidate<T>[],
  opts: { boostFn?: (candidate: Candidate<T>, segment: string) => number; limit?: number } = {},
): SegmentMatch<T>[] {
  const segments = segmentise(query);
  const queries = [query.replace(/\s+/g, ' ').trim(), ...segments];
  const best = new Map<string, SegmentMatch<T>>();

  for (const segment of queries) {
    for (const candidate of candidates) {
      const sim = similarity(segment, candidate.text);
      const boost = opts.boostFn ? opts.boostFn(candidate, segment) : 0;
      const boundedBoost = Math.min(boost, 0.25);
      const total = Number((sim.score + boundedBoost).toFixed(4));
      const existing = best.get(candidate.key);
      if (!existing || total > existing.total) {
        best.set(candidate.key, {
          item: candidate.item,
          key: candidate.key,
          similarity: sim,
          boost: boundedBoost,
          total,
          segment: segment === queries[0] ? '' : segment,
        });
      }
    }
  }

  const scored = [...best.values()].sort((a, b) => b.total - a.total);
  return opts.limit ? scored.slice(0, opts.limit) : scored;
}

/** True when two strings are near-identical duplicates of one another. */
export function isNearDuplicate(a: string, b: string, threshold = 0.82): boolean {
  return similarity(a, b).score >= threshold;
}
