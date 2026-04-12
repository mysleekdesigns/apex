/**
 * LoCoMo-Adapted Recall Accuracy Benchmark — Tests
 *
 * Uses depth=10 for fast CI execution. Validates that the benchmark
 * produces meaningful metrics for all match types.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock embeddings — keyword-based matching only, no L2
vi.mock('../utils/embeddings.js', () => ({
  getEmbedding: vi.fn((text: string) => ({
    keywords: text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10),
    simhash: BigInt(text.length % 1000),
    embedding: undefined,
  })),
  getEmbeddingAsync: vi.fn(async (text: string) => ({
    keywords: text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10),
    simhash: BigInt(text.length % 1000),
    embedding: undefined,
  })),
  getSemanticEmbedder: vi.fn(() => ({
    embed: vi.fn(async () => { throw new Error('L2 not available in tests'); }),
    embedBatch: vi.fn(async () => { throw new Error('L2 not available in tests'); }),
    isLoaded: vi.fn(() => false),
  })),
  extractKeywords: vi.fn((text: string) =>
    text.toLowerCase().split(/\s+/).filter(Boolean),
  ),
  simHash: vi.fn((text: string) => BigInt(text.length % 1000)),
  simHashSimilarity: vi.fn(() => 0.5),
}));

vi.mock('../utils/similarity.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/similarity.js')>('../utils/similarity.js');

  // Minimal BM25Index mock for fast tests
  class MockBM25Index {
    private docs = new Map<string, string[]>();
    get size() { return this.docs.size; }
    addDocument(id: string, terms: string[]) { this.docs.set(id, terms); }
    removeDocument(id: string) { this.docs.delete(id); }
    addDocuments(docs: Array<{ id: string; terms: string[] }>) {
      for (const d of docs) this.addDocument(d.id, d.terms);
    }
    score(queryTerms: string[]) {
      const scores = new Map<string, number>();
      const querySet = new Set(queryTerms);
      for (const [id, terms] of this.docs) {
        let s = 0;
        for (const t of terms) if (querySet.has(t)) s++;
        if (s > 0) scores.set(id, s);
      }
      return scores;
    }
    scoreDocument(queryTerms: string[], docId: string) {
      const terms = this.docs.get(docId);
      if (!terms) return 0;
      const querySet = new Set(queryTerms);
      let s = 0;
      for (const t of terms) if (querySet.has(t)) s++;
      return s;
    }
  }

  const combinedSimilarity = vi.fn(
    (a: { keywords: string[] }, b: { keywords: string[] }) => {
      const setA = new Set(a.keywords);
      const setB = new Set(b.keywords);
      let intersection = 0;
      for (const k of setA) if (setB.has(k)) intersection++;
      const union = new Set([...setA, ...setB]).size;
      return union > 0 ? intersection / union : 0;
    },
  );

  const hybridSearch = vi.fn((query: any, candidates: any[]) => {
    return candidates
      .map((c: any) => ({
        id: c.id,
        score: combinedSimilarity(
          { keywords: query.keywords },
          { keywords: c.keywords },
        ),
        components: { vector: 0, bm25: 0, recency: 0.5 },
      }))
      .sort((a: any, b: any) => b.score - a.score);
  });

  return {
    // Keep the real metric functions so the benchmark uses them
    computeMRR: actual.computeMRR,
    computeRecallAtK: actual.computeRecallAtK,
    computePrecision: actual.computePrecision,
    // Mock the similarity/search infrastructure
    combinedSimilarity,
    cosineSimilarity: vi.fn(() => 0),
    jaccardSimilarity: actual.jaccardSimilarity,
    BM25Index: MockBM25Index,
    hybridSearch,
  };
});

vi.mock('../utils/vector-index.js', () => ({
  HNSWIndex: vi.fn(),
}));

vi.mock('../utils/hashing.js', () => ({
  contentHash: vi.fn((text: string) => {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return hash.toString(16);
  }),
}));

import { runRecallBenchmark, type RecallBenchmarkResult } from './locomo-adapt.js';

describe('LoCoMo-Adapted Recall Benchmark', () => {
  let results: RecallBenchmarkResult[];

  // Run the benchmark once at depth=10 for all tests
  it('completes without errors at depth 10', async () => {
    results = await runRecallBenchmark({
      depths: [10],
      queriesPerDepth: 10,
      topK: 10,
    });

    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  });

  it('returns results for all three match types', () => {
    const matchTypes = results.map((r) => r.matchType);
    expect(matchTypes).toContain('exact');
    expect(matchTypes).toContain('semantic');
    expect(matchTypes).toContain('partial');
  });

  it('reports depth correctly', () => {
    for (const r of results) {
      expect(r.depth).toBe(10);
    }
  });

  describe('exact match', () => {
    it('has recall@1 > 0', () => {
      const exact = results.find((r) => r.matchType === 'exact');
      expect(exact).toBeDefined();
      expect(exact!.metrics.recall1).toBeGreaterThan(0);
    });

    it('has MRR > 0', () => {
      const exact = results.find((r) => r.matchType === 'exact');
      expect(exact).toBeDefined();
      expect(exact!.metrics.mrr).toBeGreaterThan(0);
    });
  });

  describe('semantic match', () => {
    it('has MRR > 0', () => {
      const semantic = results.find((r) => r.matchType === 'semantic');
      expect(semantic).toBeDefined();
      expect(semantic!.metrics.mrr).toBeGreaterThan(0);
    });
  });

  describe('partial match', () => {
    it('has MRR > 0', () => {
      const partial = results.find((r) => r.matchType === 'partial');
      expect(partial).toBeDefined();
      expect(partial!.metrics.mrr).toBeGreaterThan(0);
    });
  });

  describe('metrics validity', () => {
    it('false positive rate is < 1.0 for all match types', () => {
      for (const r of results) {
        expect(r.metrics.falsePositiveRate).toBeLessThan(1.0);
      }
    });

    it('latency metrics are populated (> 0)', () => {
      for (const r of results) {
        expect(r.metrics.avgLatencyMs).toBeGreaterThan(0);
      }
    });

    it('all recall metrics are between 0 and 1', () => {
      for (const r of results) {
        expect(r.metrics.recall1).toBeGreaterThanOrEqual(0);
        expect(r.metrics.recall1).toBeLessThanOrEqual(1);
        expect(r.metrics.recall5).toBeGreaterThanOrEqual(0);
        expect(r.metrics.recall5).toBeLessThanOrEqual(1);
        expect(r.metrics.recall10).toBeGreaterThanOrEqual(0);
        expect(r.metrics.recall10).toBeLessThanOrEqual(1);
      }
    });

    it('MRR is between 0 and 1', () => {
      for (const r of results) {
        expect(r.metrics.mrr).toBeGreaterThanOrEqual(0);
        expect(r.metrics.mrr).toBeLessThanOrEqual(1);
      }
    });

    it('false positive rate is between 0 and 1', () => {
      for (const r of results) {
        expect(r.metrics.falsePositiveRate).toBeGreaterThanOrEqual(0);
        expect(r.metrics.falsePositiveRate).toBeLessThanOrEqual(1);
      }
    });
  });
});
