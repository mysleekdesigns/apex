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

export interface SimilarityInput {
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

// ---------------------------------------------------------------------------
// BM25 Scoring
// ---------------------------------------------------------------------------

/** Configuration for BM25 scoring parameters. */
export interface BM25Config {
  /** Term frequency saturation parameter (default 1.2). */
  k1?: number;
  /** Length normalization parameter (default 0.75). */
  b?: number;
}

/**
 * BM25 (Best Matching 25) index for keyword-based document scoring.
 *
 * Supports incremental add/remove of documents and efficient scoring of
 * queries against the indexed corpus.
 */
export class BM25Index {
  private documents: Map<string, string[]> = new Map();
  private df: Map<string, number> = new Map();
  private avgDl: number = 0;
  private N: number = 0;
  private totalTerms: number = 0;
  private readonly k1: number;
  private readonly b: number;

  constructor(config?: BM25Config) {
    this.k1 = config?.k1 ?? 1.2;
    this.b = config?.b ?? 0.75;
  }

  /** Number of documents in the index. */
  get size(): number {
    return this.N;
  }

  /** Add a single document to the index. */
  addDocument(id: string, terms: string[]): void {
    // If the doc already exists, remove it first to keep counts consistent.
    if (this.documents.has(id)) {
      this.removeDocument(id);
    }

    this.documents.set(id, terms);
    this.N++;
    this.totalTerms += terms.length;
    this.avgDl = this.totalTerms / this.N;

    // Update document frequencies (count each unique term once per doc).
    const seen = new Set<string>();
    for (const term of terms) {
      if (!seen.has(term)) {
        seen.add(term);
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
  }

  /** Remove a document from the index. */
  removeDocument(id: string): void {
    const terms = this.documents.get(id);
    if (!terms) return;

    // Decrement document frequencies.
    const seen = new Set<string>();
    for (const term of terms) {
      if (!seen.has(term)) {
        seen.add(term);
        const count = (this.df.get(term) ?? 1) - 1;
        if (count <= 0) {
          this.df.delete(term);
        } else {
          this.df.set(term, count);
        }
      }
    }

    this.totalTerms -= terms.length;
    this.N--;
    this.avgDl = this.N === 0 ? 0 : this.totalTerms / this.N;
    this.documents.delete(id);
  }

  /** Add multiple documents at once. */
  addDocuments(docs: Array<{ id: string; terms: string[] }>): void {
    for (const doc of docs) {
      this.addDocument(doc.id, doc.terms);
    }
  }

  /**
   * Score all indexed documents against the given query terms.
   * Returns a map of document ID to BM25 score.
   */
  score(queryTerms: string[]): Map<string, number> {
    const scores = new Map<string, number>();
    for (const [id] of this.documents) {
      const s = this.scoreDocument(queryTerms, id);
      if (s > 0) {
        scores.set(id, s);
      }
    }
    return scores;
  }

  /**
   * Score a specific document against the given query terms.
   * Returns 0 if the document does not exist.
   */
  scoreDocument(queryTerms: string[], docId: string): number {
    const doc = this.documents.get(docId);
    if (!doc) return 0;

    const dl = doc.length;

    // Build term frequency map for the document.
    const tf = new Map<string, number>();
    for (const term of doc) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }

    let totalScore = 0;
    for (const qi of queryTerms) {
      const n = this.df.get(qi) ?? 0;
      const f = tf.get(qi) ?? 0;
      if (f === 0) continue;

      // IDF with "+1" variant to avoid negative values.
      const idf = Math.log((this.N - n + 0.5) / (n + 0.5) + 1);

      const numerator = f * (this.k1 + 1);
      const denominator =
        f + this.k1 * (1 - this.b + this.b * (dl / (this.avgDl || 1)));

      totalScore += idf * (numerator / denominator);
    }

    return totalScore;
  }
}

// ---------------------------------------------------------------------------
// Hybrid Retrieval
// ---------------------------------------------------------------------------

/** Weight configuration for hybrid search scoring components. */
export interface HybridWeights {
  /** Dense vector similarity weight (default 0.6). */
  vector?: number;
  /** BM25 keyword relevance weight (default 0.3). */
  bm25?: number;
  /** Recency decay weight (default 0.1). */
  recency?: number;
}

/** Input for hybrid search — extends SimilarityInput with id and timestamp. */
export interface HybridInput {
  id: string;
  keywords: string[];
  simhash: bigint;
  embedding?: number[];
  /** Unix timestamp in milliseconds for recency scoring. */
  timestamp?: number;
}

/** A single result from hybrid search with component score breakdown. */
export interface HybridResult {
  id: string;
  score: number;
  components: {
    vector: number;
    bm25: number;
    recency: number;
  };
}

/**
 * Perform hybrid search combining dense vector similarity, BM25 keyword
 * scoring, and recency decay.
 *
 * @param query - The query item to search for.
 * @param candidates - The candidate items to rank.
 * @param weights - Optional weight overrides for each scoring component.
 * @param bm25Index - Optional pre-built BM25 index. If omitted a temporary
 *   index is built from the candidates' keywords.
 * @returns Results sorted by descending hybrid score.
 */
export function hybridSearch(
  query: HybridInput,
  candidates: HybridInput[],
  weights?: HybridWeights,
  bm25Index?: BM25Index,
): HybridResult[] {
  const wVector = weights?.vector ?? 0.6;
  const wBm25 = weights?.bm25 ?? 0.3;
  const wRecency = weights?.recency ?? 0.1;

  // Build a BM25 index if one was not provided.
  const index = bm25Index ?? new BM25Index();
  if (!bm25Index) {
    for (const c of candidates) {
      index.addDocument(c.id, c.keywords);
    }
  }

  // BM25 scores for the query.
  const bm25Scores = index.score(query.keywords);

  // Normalize BM25 scores to [0, 1].
  let maxBm25 = 0;
  for (const s of bm25Scores.values()) {
    if (s > maxBm25) maxBm25 = s;
  }

  const now = Date.now();
  const LAMBDA = 0.1;
  const MS_PER_DAY = 86_400_000;

  const results: HybridResult[] = [];

  for (const candidate of candidates) {
    // --- Vector score ---
    let vectorScore: number;
    if (query.embedding && candidate.embedding) {
      vectorScore = cosineSimilarity(query.embedding, candidate.embedding);
    } else {
      vectorScore = combinedSimilarity(
        { keywords: query.keywords, simhash: query.simhash, embedding: query.embedding },
        { keywords: candidate.keywords, simhash: candidate.simhash, embedding: candidate.embedding },
      );
    }

    // --- BM25 score (normalized) ---
    const rawBm25 = bm25Scores.get(candidate.id) ?? 0;
    const bm25Score = maxBm25 > 0 ? rawBm25 / maxBm25 : 0;

    // --- Recency score ---
    let recencyScore: number;
    if (candidate.timestamp != null) {
      const daysSince = (now - candidate.timestamp) / MS_PER_DAY;
      recencyScore = Math.exp(-LAMBDA * Math.max(0, daysSince));
    } else {
      recencyScore = 0.5;
    }

    const score =
      wVector * vectorScore + wBm25 * bm25Score + wRecency * recencyScore;

    results.push({
      id: candidate.id,
      score,
      components: {
        vector: vectorScore,
        bm25: bm25Score,
        recency: recencyScore,
      },
    });
  }

  // Sort descending by score.
  results.sort((a, b) => b.score - a.score);

  return results;
}

// ---------------------------------------------------------------------------
// Retrieval Quality Metrics
// ---------------------------------------------------------------------------

/** Aggregated retrieval quality metrics. */
export interface RetrievalMetrics {
  /** Mean Reciprocal Rank. */
  mrr: number;
  /** Recall at K. */
  recallAtK: number;
  /** Precision of results. */
  precision: number;
}

/**
 * Compute Mean Reciprocal Rank (MRR).
 *
 * MRR is the reciprocal of the rank of the first relevant result.
 * Returns 0 if no relevant result appears in the ranked list.
 */
export function computeMRR(
  rankedIds: string[],
  relevantIds: Set<string>,
): number {
  for (let i = 0; i < rankedIds.length; i++) {
    if (relevantIds.has(rankedIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Compute Recall@K — the fraction of relevant items found in the top K results.
 *
 * Returns 0 if there are no relevant items.
 */
export function computeRecallAtK(
  rankedIds: string[],
  relevantIds: Set<string>,
  k: number,
): number {
  if (relevantIds.size === 0) return 0;

  let found = 0;
  const limit = Math.min(k, rankedIds.length);
  for (let i = 0; i < limit; i++) {
    if (relevantIds.has(rankedIds[i])) {
      found++;
    }
  }

  return found / relevantIds.size;
}

/**
 * Compute Precision — the fraction of returned results that are relevant.
 *
 * Returns 0 if the ranked list is empty.
 */
export function computePrecision(
  rankedIds: string[],
  relevantIds: Set<string>,
): number {
  if (rankedIds.length === 0) return 0;

  let relevant = 0;
  for (const id of rankedIds) {
    if (relevantIds.has(id)) {
      relevant++;
    }
  }

  return relevant / rankedIds.length;
}
