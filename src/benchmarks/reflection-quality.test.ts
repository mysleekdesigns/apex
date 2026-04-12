/**
 * Tests for the Reflection Quality Benchmark
 *
 * Runs with small counts to keep execution fast, then validates that
 * all result metrics are populated and within expected ranges.
 */
import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must precede dynamic imports
// ---------------------------------------------------------------------------

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
}));

vi.mock('../utils/similarity.js', () => ({
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
}));

vi.mock('../utils/hashing.js', () => ({
  contentHash: vi.fn((text: string) => String(text.length)),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Reflection Quality Benchmark', () => {
  it('runs with small counts and returns populated result', async () => {
    const { runReflectionQualityBenchmark } = await import(
      './reflection-quality.js'
    );

    const result = await runReflectionQualityBenchmark({
      episodeCount: 10,
      reflectionCount: 5,
      ageSimulationDays: 14,
    });

    // ── Structure exists ────────────────────────────────────────────
    expect(result).toBeDefined();
    expect(result.reflectionImpact).toBeDefined();
    expect(result.actionability).toBeDefined();
    expect(result.freshness).toBeDefined();

    // ── Total counts ────────────────────────────────────────────────
    expect(result.totalEpisodes).toBe(10);
    expect(result.totalReflections).toBe(5);
  });

  it('reflectionImpact metrics are all numbers', async () => {
    const { runReflectionQualityBenchmark } = await import(
      './reflection-quality.js'
    );

    const result = await runReflectionQualityBenchmark({
      episodeCount: 10,
      reflectionCount: 5,
    });

    const { reflectionImpact } = result;
    expect(typeof reflectionImpact.baselineSuccessRate).toBe('number');
    expect(typeof reflectionImpact.reflectedSuccessRate).toBe('number');
    expect(typeof reflectionImpact.improvement).toBe('number');
    expect(reflectionImpact.improvement).toBeCloseTo(
      reflectionImpact.reflectedSuccessRate - reflectionImpact.baselineSuccessRate,
      10,
    );
  });

  it('actionability scores are in [0, 1]', async () => {
    const { runReflectionQualityBenchmark } = await import(
      './reflection-quality.js'
    );

    const result = await runReflectionQualityBenchmark({
      episodeCount: 10,
      reflectionCount: 5,
    });

    const { actionability } = result;
    expect(actionability.avgActionabilityScore).toBeGreaterThanOrEqual(0);
    expect(actionability.avgActionabilityScore).toBeLessThanOrEqual(1);
    expect(actionability.fractionWithInsights).toBeGreaterThanOrEqual(0);
    expect(actionability.fractionWithInsights).toBeLessThanOrEqual(1);
    expect(actionability.fractionWithErrorTypes).toBeGreaterThanOrEqual(0);
    expect(actionability.fractionWithErrorTypes).toBeLessThanOrEqual(1);
    expect(actionability.avgInsightCount).toBeGreaterThanOrEqual(0);
  });

  it('freshness age groups exist and have valid scores', async () => {
    const { runReflectionQualityBenchmark } = await import(
      './reflection-quality.js'
    );

    const result = await runReflectionQualityBenchmark({
      episodeCount: 10,
      reflectionCount: 5,
      ageSimulationDays: 30,
    });

    const { freshness } = result;
    expect(freshness.ageGroups.length).toBeGreaterThan(0);

    for (const group of freshness.ageGroups) {
      expect(typeof group.ageDays).toBe('number');
      expect(group.ageDays).toBeGreaterThan(0);
      expect(typeof group.avgRelevanceScore).toBe('number');
      expect(group.avgRelevanceScore).toBeGreaterThanOrEqual(0);
      expect(typeof group.matchRate).toBe('number');
      expect(group.matchRate).toBeGreaterThanOrEqual(0);
      expect(group.matchRate).toBeLessThanOrEqual(1);
    }

    expect(typeof freshness.halfLifeDays).toBe('number');
    expect(freshness.halfLifeDays).toBeGreaterThan(0);
  });

  it('latency is measured and positive', async () => {
    const { runReflectionQualityBenchmark } = await import(
      './reflection-quality.js'
    );

    const result = await runReflectionQualityBenchmark({
      episodeCount: 10,
      reflectionCount: 5,
    });

    expect(result.avgLatencyMs).toBeGreaterThan(0);
  });

  it('reflected success rate is at least as high as baseline', async () => {
    const { runReflectionQualityBenchmark } = await import(
      './reflection-quality.js'
    );

    const result = await runReflectionQualityBenchmark({
      episodeCount: 10,
      reflectionCount: 5,
    });

    // With our mock similarity, reflected queries should match stored
    // reflections better than unrelated baseline queries
    expect(result.reflectionImpact.improvement).toBeGreaterThanOrEqual(0);
  });

  it('freshness scores decay with age', async () => {
    const { runReflectionQualityBenchmark } = await import(
      './reflection-quality.js'
    );

    const result = await runReflectionQualityBenchmark({
      episodeCount: 10,
      reflectionCount: 5,
      ageSimulationDays: 30,
    });

    const groups = result.freshness.ageGroups;
    if (groups.length >= 2) {
      // The youngest group should have a relevance score at least as high
      // as the oldest group due to simulated exponential decay
      const youngest = groups[0];
      const oldest = groups[groups.length - 1];
      expect(youngest.avgRelevanceScore).toBeGreaterThanOrEqual(
        oldest.avgRelevanceScore,
      );
    }
  });
});
