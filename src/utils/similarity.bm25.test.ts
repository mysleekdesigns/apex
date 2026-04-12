import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BM25Index,
  hybridSearch,
  computeMRR,
  computeRecallAtK,
  computePrecision,
} from './similarity.js';
import type { HybridInput, HybridWeights } from './similarity.js';

// ---------------------------------------------------------------------------
// BM25Index
// ---------------------------------------------------------------------------

describe('BM25Index', () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
  });

  describe('empty index', () => {
    it('scoring returns empty map', () => {
      const scores = index.score(['hello', 'world']);
      expect(scores.size).toBe(0);
    });

    it('size is 0', () => {
      expect(index.size).toBe(0);
    });
  });

  describe('single document', () => {
    it('scores a matching query positively', () => {
      index.addDocument('doc1', ['hello', 'world', 'hello']);
      const scores = index.score(['hello']);
      expect(scores.size).toBe(1);
      expect(scores.get('doc1')).toBeGreaterThan(0);
    });

    it('scores a non-matching query as 0 (absent from map)', () => {
      index.addDocument('doc1', ['hello', 'world']);
      const scores = index.score(['missing']);
      expect(scores.has('doc1')).toBe(false);
    });
  });

  describe('multiple documents — ranking', () => {
    it('ranks relevant doc higher than irrelevant', () => {
      index.addDocument('relevant', ['machine', 'learning', 'deep', 'learning']);
      index.addDocument('irrelevant', ['cooking', 'recipe', 'pasta', 'sauce']);
      index.addDocument('partial', ['machine', 'cooking']);

      const scores = index.score(['machine', 'learning']);
      expect(scores.get('relevant')).toBeGreaterThan(scores.get('partial') ?? 0);
      expect(scores.has('irrelevant')).toBe(false);
    });
  });

  describe('term frequency saturation', () => {
    it('high TF does not blow up score due to k1 control', () => {
      // Document with term repeated 100 times vs 2 times
      const manyTerms = new Array(100).fill('test');
      const fewTerms = ['test', 'test'];
      index.addDocument('many', manyTerms);
      index.addDocument('few', fewTerms);

      const scores = index.score(['test']);
      const manyScore = scores.get('many') ?? 0;
      const fewScore = scores.get('few') ?? 0;

      // Both should be positive
      expect(manyScore).toBeGreaterThan(0);
      expect(fewScore).toBeGreaterThan(0);

      // Score should NOT scale linearly with TF (50x more terms != 50x more score)
      // With k1=1.2 the ratio should be much less than 50
      expect(manyScore / fewScore).toBeLessThan(10);
    });
  });

  describe('length normalization', () => {
    it('shorter relevant doc scores higher than long one with same matching terms', () => {
      // Short doc: 2 relevant terms out of 3 total
      index.addDocument('short', ['machine', 'learning', 'intro']);
      // Long doc: same 2 relevant terms buried in many irrelevant ones
      const longTerms = ['machine', 'learning', ...new Array(50).fill('filler')];
      index.addDocument('long', longTerms);

      const scores = index.score(['machine', 'learning']);
      expect(scores.get('short')).toBeGreaterThan(scores.get('long') ?? 0);
    });
  });

  describe('removeDocument', () => {
    it('removes a document from scoring', () => {
      index.addDocument('a', ['hello']);
      index.addDocument('b', ['world']);
      expect(index.size).toBe(2);

      index.removeDocument('a');
      expect(index.size).toBe(1);

      const scores = index.score(['hello']);
      expect(scores.has('a')).toBe(false);
    });

    it('is a no-op for non-existent id', () => {
      index.addDocument('a', ['hello']);
      index.removeDocument('nope');
      expect(index.size).toBe(1);
    });
  });

  describe('custom k1 and b parameters', () => {
    it('accepts custom k1 and b', () => {
      const custom = new BM25Index({ k1: 2.0, b: 0.5 });
      custom.addDocument('d1', ['test', 'test', 'other']);
      const scores = custom.score(['test']);
      expect(scores.get('d1')).toBeGreaterThan(0);
    });

    it('b=0 disables length normalization', () => {
      const noBnorm = new BM25Index({ k1: 1.2, b: 0 });
      // With b=0, doc length should not affect the score
      noBnorm.addDocument('short', ['term']);
      noBnorm.addDocument('long', ['term', ...new Array(100).fill('filler')]);

      const scores = noBnorm.score(['term']);
      // With b=0, the length normalization denominator term vanishes,
      // so both docs have TF=1 for 'term' and should score identically.
      expect(scores.get('short')).toBeCloseTo(scores.get('long') ?? 0, 5);
    });
  });

  describe('addDocuments (bulk)', () => {
    it('adds multiple documents at once', () => {
      index.addDocuments([
        { id: 'a', terms: ['hello'] },
        { id: 'b', terms: ['world'] },
        { id: 'c', terms: ['hello', 'world'] },
      ]);
      expect(index.size).toBe(3);
      const scores = index.score(['hello']);
      expect(scores.has('a')).toBe(true);
      expect(scores.has('c')).toBe(true);
    });
  });

  describe('IDF effect', () => {
    it('rare terms score higher than common terms', () => {
      // 'common' appears in all 3 docs, 'rare' appears in only 1
      index.addDocuments([
        { id: 'd1', terms: ['common', 'rare'] },
        { id: 'd2', terms: ['common', 'other'] },
        { id: 'd3', terms: ['common', 'stuff'] },
      ]);

      const rareScore = index.scoreDocument(['rare'], 'd1');
      const commonScore = index.scoreDocument(['common'], 'd1');
      expect(rareScore).toBeGreaterThan(commonScore);
    });
  });
});

// ---------------------------------------------------------------------------
// hybridSearch
// ---------------------------------------------------------------------------

describe('hybridSearch', () => {
  const now = Date.now();

  function makeCandidate(
    id: string,
    keywords: string[],
    opts?: { embedding?: number[]; timestamp?: number },
  ): HybridInput {
    return {
      id,
      keywords,
      simhash: 0n,
      embedding: opts?.embedding,
      timestamp: opts?.timestamp,
    };
  }

  const query: HybridInput = {
    id: 'q',
    keywords: ['machine', 'learning'],
    simhash: 0n,
    embedding: [1, 0, 0],
    timestamp: now,
  };

  describe('default weights', () => {
    it('uses vector=0.6, bm25=0.3, recency=0.1 by default', () => {
      const candidates = [
        makeCandidate('c1', ['machine', 'learning'], {
          embedding: [1, 0, 0],
          timestamp: now,
        }),
      ];
      const results = hybridSearch(query, candidates);
      expect(results).toHaveLength(1);
      // vector=1.0, bm25=1.0 (only doc, normalized), recency ~1.0
      // score ~ 0.6*1 + 0.3*1 + 0.1*1 = 1.0
      expect(results[0].score).toBeCloseTo(1.0, 1);
    });
  });

  describe('custom weights', () => {
    it('respects weight overrides', () => {
      const candidates = [
        makeCandidate('c1', ['machine', 'learning'], {
          embedding: [1, 0, 0],
          timestamp: now,
        }),
      ];

      const weightsA: HybridWeights = { vector: 1.0, bm25: 0.0, recency: 0.0 };
      const weightsB: HybridWeights = { vector: 0.0, bm25: 1.0, recency: 0.0 };

      const resA = hybridSearch(query, candidates, weightsA);
      const resB = hybridSearch(query, candidates, weightsB);

      // vector-only score = cosine(same vector) = 1.0
      expect(resA[0].score).toBeCloseTo(1.0, 5);
      // bm25-only score = 1.0 (single doc, normalized max)
      expect(resB[0].score).toBeCloseTo(1.0, 5);
    });
  });

  describe('with embeddings — cosine similarity', () => {
    it('uses cosine similarity when both have embeddings', () => {
      const candidates = [
        makeCandidate('close', ['other'], { embedding: [0.9, 0.1, 0] }),
        makeCandidate('far', ['other'], { embedding: [0, 0, 1] }),
      ];

      const results = hybridSearch(query, candidates, { vector: 1, bm25: 0, recency: 0 });
      expect(results[0].id).toBe('close');
      expect(results[0].components.vector).toBeGreaterThan(results[1].components.vector);
    });
  });

  describe('without embeddings — fallback', () => {
    it('falls back to combinedSimilarity when no embeddings', () => {
      const q: HybridInput = { id: 'q', keywords: ['test'], simhash: 0n };
      const candidates = [
        makeCandidate('c1', ['test']),
      ];

      const results = hybridSearch(q, candidates, { vector: 1, bm25: 0, recency: 0 });
      expect(results).toHaveLength(1);
      // Without embeddings, combinedSimilarity uses jaccard+simhash
      expect(results[0].components.vector).toBeGreaterThanOrEqual(0);
    });
  });

  describe('recency scoring', () => {
    it('newer items score higher on recency component', () => {
      const msPerDay = 86_400_000;
      const candidates = [
        makeCandidate('new', ['kw'], { timestamp: now }),
        makeCandidate('old', ['kw'], { timestamp: now - 30 * msPerDay }),
      ];

      const results = hybridSearch(query, candidates, { vector: 0, bm25: 0, recency: 1 });
      const newResult = results.find((r) => r.id === 'new')!;
      const oldResult = results.find((r) => r.id === 'old')!;
      expect(newResult.components.recency).toBeGreaterThan(oldResult.components.recency);
    });
  });

  describe('no timestamp', () => {
    it('defaults to 0.5 recency when timestamp is missing', () => {
      const candidates = [makeCandidate('notime', ['kw'])];
      const results = hybridSearch(query, candidates);
      expect(results[0].components.recency).toBeCloseTo(0.5, 5);
    });
  });

  describe('pre-built BM25 index', () => {
    it('works when a pre-built BM25 index is passed', () => {
      const bm25 = new BM25Index();
      bm25.addDocument('c1', ['machine', 'learning']);
      bm25.addDocument('c2', ['cooking']);

      const candidates = [
        makeCandidate('c1', ['machine', 'learning'], { timestamp: now }),
        makeCandidate('c2', ['cooking'], { timestamp: now }),
      ];

      const results = hybridSearch(query, candidates, undefined, bm25);
      expect(results.length).toBe(2);
      const c1 = results.find((r) => r.id === 'c1')!;
      const c2 = results.find((r) => r.id === 'c2')!;
      expect(c1.components.bm25).toBeGreaterThan(c2.components.bm25);
    });
  });

  describe('results sorted', () => {
    it('returns results in descending score order', () => {
      const candidates = [
        makeCandidate('low', ['cooking'], { embedding: [0, 0, 1], timestamp: now - 86_400_000 * 100 }),
        makeCandidate('high', ['machine', 'learning'], { embedding: [1, 0, 0], timestamp: now }),
      ];

      const results = hybridSearch(query, candidates);
      expect(results[0].id).toBe('high');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });
  });

  describe('component breakdown', () => {
    it('provides correct component scores', () => {
      const candidates = [
        makeCandidate('c1', ['machine', 'learning'], {
          embedding: [1, 0, 0],
          timestamp: now,
        }),
      ];

      const results = hybridSearch(query, candidates);
      const c = results[0].components;

      // All components should be between 0 and 1
      expect(c.vector).toBeGreaterThanOrEqual(0);
      expect(c.vector).toBeLessThanOrEqual(1);
      expect(c.bm25).toBeGreaterThanOrEqual(0);
      expect(c.bm25).toBeLessThanOrEqual(1);
      expect(c.recency).toBeGreaterThanOrEqual(0);
      expect(c.recency).toBeLessThanOrEqual(1);

      // Score should equal weighted sum of components
      const expected = 0.6 * c.vector + 0.3 * c.bm25 + 0.1 * c.recency;
      expect(results[0].score).toBeCloseTo(expected, 5);
    });
  });
});

// ---------------------------------------------------------------------------
// Retrieval Quality Metrics
// ---------------------------------------------------------------------------

describe('computeMRR', () => {
  it('returns 1.0 when first result is relevant', () => {
    expect(computeMRR(['a', 'b', 'c'], new Set(['a']))).toBe(1.0);
  });

  it('returns 0.5 when first relevant is at position 2', () => {
    expect(computeMRR(['a', 'b', 'c'], new Set(['b']))).toBeCloseTo(0.5, 5);
  });

  it('returns 1/3 when first relevant is at position 3', () => {
    expect(computeMRR(['a', 'b', 'c'], new Set(['c']))).toBeCloseTo(1 / 3, 5);
  });

  it('returns 0 when no relevant results found', () => {
    expect(computeMRR(['a', 'b', 'c'], new Set(['x']))).toBe(0);
  });

  it('returns 0 for empty ranked list', () => {
    expect(computeMRR([], new Set(['a']))).toBe(0);
  });

  it('returns 0 for empty relevant set', () => {
    expect(computeMRR(['a', 'b'], new Set())).toBe(0);
  });
});

describe('computeRecallAtK', () => {
  it('returns 1.0 when all relevant items found within k', () => {
    expect(computeRecallAtK(['a', 'b', 'c'], new Set(['a', 'b']), 5)).toBeCloseTo(1.0, 5);
  });

  it('returns correct fraction when some relevant found', () => {
    // 3 relevant items, only 2 found in top 5
    expect(computeRecallAtK(['a', 'x', 'b', 'y', 'z'], new Set(['a', 'b', 'c']), 5)).toBeCloseTo(
      2 / 3,
      5,
    );
  });

  it('returns 0 when no relevant items found', () => {
    expect(computeRecallAtK(['x', 'y', 'z'], new Set(['a', 'b']), 3)).toBe(0);
  });

  it('returns 0 for empty relevant set', () => {
    expect(computeRecallAtK(['a', 'b'], new Set(), 5)).toBe(0);
  });

  it('respects k limit', () => {
    // 'c' is relevant but at position 3, with k=2 it's not counted
    expect(computeRecallAtK(['x', 'y', 'c'], new Set(['c']), 2)).toBe(0);
    expect(computeRecallAtK(['x', 'y', 'c'], new Set(['c']), 3)).toBeCloseTo(1.0, 5);
  });

  it('handles empty ranked list', () => {
    expect(computeRecallAtK([], new Set(['a']), 5)).toBe(0);
  });
});

describe('computePrecision', () => {
  it('returns 1.0 when all returned are relevant', () => {
    expect(computePrecision(['a', 'b'], new Set(['a', 'b', 'c']))).toBeCloseTo(1.0, 5);
  });

  it('returns correct fraction for partial relevance', () => {
    // 3 relevant out of 10 returned
    const ranked = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const relevant = new Set(['a', 'e', 'j']);
    expect(computePrecision(ranked, relevant)).toBeCloseTo(0.3, 5);
  });

  it('returns 0 when no results are relevant', () => {
    expect(computePrecision(['x', 'y', 'z'], new Set(['a', 'b']))).toBe(0);
  });

  it('returns 0 for empty ranked list', () => {
    expect(computePrecision([], new Set(['a']))).toBe(0);
  });

  it('returns 0 for empty relevant set', () => {
    expect(computePrecision(['a', 'b'], new Set())).toBe(0);
  });
});
