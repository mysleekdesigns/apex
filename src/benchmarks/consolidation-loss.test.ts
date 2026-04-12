/**
 * Consolidation Loss Benchmark Tests
 *
 * Validates that the consolidation loss benchmark produces correct,
 * well-bounded metrics and that information retention is measurable
 * across memory tier promotions.
 */

import { describe, it, expect, vi } from 'vitest';

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
  extractKeywords: vi.fn((text: string) =>
    text.toLowerCase().split(/\s+/).filter(Boolean),
  ),
  simHash: vi.fn(() => BigInt(0)),
  simHashSimilarity: vi.fn(() => 0.5),
  getSemanticEmbedder: vi.fn(() => ({
    embed: vi.fn(async () => { throw new Error('L2 not available'); }),
  })),
}));

vi.mock('../utils/similarity.js', async () => {
  const actual: Record<string, unknown> = {};
  return {
    ...actual,
    combinedSimilarity: vi.fn(
      (a: { keywords: string[] }, b: { keywords: string[] }) => {
        const setA = new Set(a.keywords);
        const setB = new Set(b.keywords);
        let intersection = 0;
        for (const k of setA) if (setB.has(k)) intersection++;
        const union = new Set([...setA, ...setB]).size;
        return union > 0 ? intersection / union : 0;
      },
    ),
    BM25Index: vi.fn().mockImplementation(() => ({
      addDocument: vi.fn(),
      search: vi.fn(() => []),
      clear: vi.fn(),
    })),
    hybridSearch: vi.fn(
      (
        _query: unknown,
        inputs: Array<{ id: string }>,
      ) => inputs.map((inp) => ({ id: inp.id, score: 0.5 })),
    ),
    computeRecallAtK: vi.fn(() => 0),
    computeMRR: vi.fn(() => 0),
  };
});

vi.mock('../utils/hashing.js', () => ({
  contentHash: vi.fn((text: string) => String(text.length)),
}));

describe('Consolidation Loss Benchmark', () => {
  it('produces valid metrics with small entry count', async () => {
    const { runConsolidationLossBenchmark } = await import(
      './consolidation-loss.js'
    );

    const result = await runConsolidationLossBenchmark({
      entryCount: 10,
      queriesPerEntry: 2,
      consolidationCycles: 1,
    });

    // Retention rates must be in [0, 1]
    expect(result.promotionRetention.workingToEpisodic).toBeGreaterThanOrEqual(0);
    expect(result.promotionRetention.workingToEpisodic).toBeLessThanOrEqual(1);
    expect(result.promotionRetention.episodicToSemantic).toBeGreaterThanOrEqual(0);
    expect(result.promotionRetention.episodicToSemantic).toBeLessThanOrEqual(1);
    expect(result.promotionRetention.overallRetention).toBeGreaterThanOrEqual(0);
    expect(result.promotionRetention.overallRetention).toBeLessThanOrEqual(1);
  }, 30_000);

  it('query answerability scores are populated', async () => {
    const { runConsolidationLossBenchmark } = await import(
      './consolidation-loss.js'
    );

    const result = await runConsolidationLossBenchmark({
      entryCount: 10,
      queriesPerEntry: 2,
      consolidationCycles: 1,
    });

    // Pre/post scores should be in [0, 1]
    expect(result.queryAnswerability.preConsolidation).toBeGreaterThanOrEqual(0);
    expect(result.queryAnswerability.preConsolidation).toBeLessThanOrEqual(1);
    expect(result.queryAnswerability.postConsolidation).toBeGreaterThanOrEqual(0);
    expect(result.queryAnswerability.postConsolidation).toBeLessThanOrEqual(1);

    // Delta should be the difference
    expect(result.queryAnswerability.answerabilityDelta).toBeCloseTo(
      result.queryAnswerability.postConsolidation -
        result.queryAnswerability.preConsolidation,
      10,
    );
  }, 30_000);

  it('merge quality metrics exist and are bounded', async () => {
    const { runConsolidationLossBenchmark } = await import(
      './consolidation-loss.js'
    );

    const result = await runConsolidationLossBenchmark({
      entryCount: 10,
      queriesPerEntry: 1,
      consolidationCycles: 2,
    });

    expect(result.mergeQuality.factPreservation).toBeGreaterThanOrEqual(0);
    expect(result.mergeQuality.factPreservation).toBeLessThanOrEqual(1);
    expect(result.mergeQuality.avgContentSimilarity).toBeGreaterThanOrEqual(0);
    expect(result.mergeQuality.avgContentSimilarity).toBeLessThanOrEqual(1);
    expect(result.mergeQuality.entriesMerged).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('tracks latency and counts', async () => {
    const { runConsolidationLossBenchmark } = await import(
      './consolidation-loss.js'
    );

    const result = await runConsolidationLossBenchmark({
      entryCount: 10,
      queriesPerEntry: 2,
      consolidationCycles: 1,
    });

    expect(result.totalEntriesSeeded).toBe(10);
    expect(result.totalQueriesRun).toBeGreaterThan(0);
    expect(result.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.avgLatencyMs).toBeLessThan(5000); // sanity check
  }, 30_000);

  it('handles minimum entry count of 1', async () => {
    const { runConsolidationLossBenchmark } = await import(
      './consolidation-loss.js'
    );

    const result = await runConsolidationLossBenchmark({
      entryCount: 1,
      queriesPerEntry: 1,
      consolidationCycles: 1,
    });

    expect(result.totalEntriesSeeded).toBe(1);
    expect(result.promotionRetention.workingToEpisodic).toBeGreaterThanOrEqual(0);
    expect(result.promotionRetention.workingToEpisodic).toBeLessThanOrEqual(1);
  }, 30_000);

  it('multiple consolidation cycles do not crash', async () => {
    const { runConsolidationLossBenchmark } = await import(
      './consolidation-loss.js'
    );

    const result = await runConsolidationLossBenchmark({
      entryCount: 10,
      queriesPerEntry: 2,
      consolidationCycles: 3,
    });

    // Should complete without error and produce valid metrics
    expect(result.promotionRetention.overallRetention).toBeGreaterThanOrEqual(0);
    expect(result.totalQueriesRun).toBeGreaterThan(0);
  }, 60_000);
});
