/**
 * Skill Transfer Benchmark Tests
 *
 * Validates that the skill transfer benchmark runs correctly and
 * produces well-formed results. Uses small counts for CI speed.
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
  getSemanticEmbedder: vi.fn(() => {
    throw new Error('L2 not available');
  }),
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
  BM25Index: vi.fn().mockImplementation(() => ({
    addDocument: vi.fn(),
    search: vi.fn(() => []),
  })),
  hybridSearch: vi.fn(() => []),
  computeMRR: vi.fn(() => 0),
  computeRecallAtK: vi.fn(() => 0),
  computePrecision: vi.fn(() => 0),
}));

vi.mock('../utils/hashing.js', () => ({
  contentHash: vi.fn((text: string) => String(text.length)),
}));

describe('Skill Transfer Benchmark', () => {
  it('runs with small config and returns valid result shape', async () => {
    const { runSkillTransferBenchmark } = await import('./skill-transfer.js');

    const result = await runSkillTransferBenchmark({
      skillCount: 5,
      queryCount: 5,
      domains: ['typescript', 'testing', 'debugging'],
    });

    expect(result).toBeDefined();
    expect(result.totalSkillsCreated).toBe(5);
    expect(result.totalQueriesRun).toBe(5);
  });

  it('discovery rate is between 0 and 1', async () => {
    const { runSkillTransferBenchmark } = await import('./skill-transfer.js');

    const result = await runSkillTransferBenchmark({
      skillCount: 5,
      queryCount: 5,
      domains: ['typescript', 'python', 'testing'],
    });

    expect(result.discoveryRate).toBeGreaterThanOrEqual(0);
    expect(result.discoveryRate).toBeLessThanOrEqual(1);
  });

  it('adaptation accuracy is populated', async () => {
    const { runSkillTransferBenchmark } = await import('./skill-transfer.js');

    const result = await runSkillTransferBenchmark({
      skillCount: 5,
      queryCount: 5,
      domains: ['react', 'api', 'security'],
    });

    expect(typeof result.adaptationAccuracy).toBe('number');
    expect(result.adaptationAccuracy).toBeGreaterThanOrEqual(0);
  });

  it('domain results array is non-empty', async () => {
    const { runSkillTransferBenchmark } = await import('./skill-transfer.js');

    const result = await runSkillTransferBenchmark({
      skillCount: 6,
      queryCount: 6,
      domains: ['typescript', 'python', 'deployment'],
    });

    expect(result.domainResults.length).toBeGreaterThan(0);
    for (const dr of result.domainResults) {
      expect(dr.sourceDomain).toBeTruthy();
      expect(dr.targetDomain).toBeTruthy();
      expect(dr.discoveryRate).toBeGreaterThanOrEqual(0);
      expect(dr.discoveryRate).toBeLessThanOrEqual(1);
      expect(typeof dr.avgRelevanceScore).toBe('number');
    }
  });

  it('latency metrics exist and are non-negative', async () => {
    const { runSkillTransferBenchmark } = await import('./skill-transfer.js');

    const result = await runSkillTransferBenchmark({
      skillCount: 5,
      queryCount: 5,
      domains: ['database', 'debugging'],
    });

    expect(typeof result.avgLatencyMs).toBe('number');
    expect(result.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('confidence calibration is a finite number', async () => {
    const { runSkillTransferBenchmark } = await import('./skill-transfer.js');

    const result = await runSkillTransferBenchmark({
      skillCount: 5,
      queryCount: 5,
      domains: ['typescript', 'testing', 'api'],
    });

    expect(typeof result.confidenceCalibration).toBe('number');
    expect(Number.isFinite(result.confidenceCalibration)).toBe(true);
  });
});
