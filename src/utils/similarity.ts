/**
 * Similarity metrics for APEX retrieval.
 */

import { simHashSimilarity } from './embeddings.js';

/**
 * Cosine similarity between two numeric vectors.
 * Returns 0 if either vector is zero-length or all zeros.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Jaccard similarity between two string sets.
 * Returns |A ∩ B| / |A ∪ B|, or 0 if both sets are empty.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;

  for (const item of smaller) {
    if (larger.has(item)) {
      intersection++;
    }
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface SimilarityInput {
  keywords: string[];
  simhash: bigint;
  embedding?: number[];
}

/**
 * Combined similarity using a weighted combination of available metrics.
 *
 * Weights (when all metrics available):
 *   - Keyword Jaccard: 0.3
 *   - SimHash: 0.3
 *   - Cosine (embedding): 0.4
 *
 * When embeddings are unavailable, Jaccard and SimHash share the weight equally (0.5 each).
 */
export function combinedSimilarity(
  query: SimilarityInput,
  target: SimilarityInput,
): number {
  const jaccard = jaccardSimilarity(
    new Set(query.keywords),
    new Set(target.keywords),
  );
  const simhash = simHashSimilarity(query.simhash, target.simhash);

  const hasEmbeddings = query.embedding && target.embedding;

  if (hasEmbeddings) {
    const cosine = cosineSimilarity(query.embedding!, target.embedding!);
    return 0.3 * jaccard + 0.3 * simhash + 0.4 * cosine;
  }

  return 0.5 * jaccard + 0.5 * simhash;
}
