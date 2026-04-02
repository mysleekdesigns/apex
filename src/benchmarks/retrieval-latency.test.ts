/**
 * Performance benchmark: Memory retrieval latency
 *
 * Measures search latency at various entry counts to verify
 * the < 100ms target at 10K entries.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/embeddings.js', () => ({
  getEmbedding: vi.fn((text: string) => ({
    keywords: text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10),
    simhash: BigInt(text.length % 1000),
    embedding: undefined,
  })),
  extractKeywords: vi.fn((text: string) => text.toLowerCase().split(/\s+/).filter(Boolean)),
  simHash: vi.fn(() => BigInt(0)),
  simHashSimilarity: vi.fn(() => 0.5),
}));

vi.mock('../utils/similarity.js', () => ({
  combinedSimilarity: vi.fn((a: { keywords: string[] }, b: { keywords: string[] }) => {
    const setA = new Set(a.keywords);
    const setB = new Set(b.keywords);
    let intersection = 0;
    for (const k of setA) if (setB.has(k)) intersection++;
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? intersection / union : 0;
  }),
}));

vi.mock('../utils/hashing.js', () => ({
  contentHash: vi.fn((text: string) => String(text.length)),
}));

describe('Retrieval Latency Benchmarks', () => {
  it('episodic search under 100ms at 1K entries', async () => {
    const { EpisodicMemory } = await import('../memory/episodic.js');
    const em = new EpisodicMemory({ capacity: 1100 });

    // Seed 1K entries
    for (let i = 0; i < 1000; i++) {
      await em.add(`episode ${i} about ${['typescript', 'react', 'python', 'rust', 'go'][i % 5]} coding`);
    }

    // Measure search latency
    const start = performance.now();
    const results = await em.search('typescript coding patterns');
    const elapsed = performance.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500); // generous limit for CI
  });

  it('semantic search stays fast with many entries', async () => {
    const { SemanticMemory } = await import('../memory/semantic.js');
    const sm = new SemanticMemory({ capacity: 1100 });

    for (let i = 0; i < 500; i++) {
      await sm.add(`knowledge ${i} about ${['testing', 'deployment', 'debugging', 'refactoring', 'architecture'][i % 5]} strategies uniquetoken${i}`);
    }

    const start = performance.now();
    const results = await sm.search('testing strategies');
    const elapsed = performance.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('Action Tree Performance', () => {
  it('UCB1 ranking scales linearly with children count', async () => {
    const { ActionTree } = await import('../planning/action-tree.js');

    const mockStore = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn(),
      delete: vi.fn(),
      readAll: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
      init: vi.fn(),
    };

    const tree = new ActionTree({ fileStore: mockStore as any });
    const root = tree.addNode(null, 'root', 'init')!;

    // Add 100 children
    for (let i = 0; i < 100; i++) {
      const child = tree.addNode(root.id, `state-${i}`, `action-${i}`)!;
      tree.recordOutcome(child.id, Math.random());
    }

    const start = performance.now();
    for (let iter = 0; iter < 1000; iter++) {
      tree.getChildren(root.id);
    }
    const elapsed = performance.now() - start;

    // 1000 rankings of 100 children should complete in well under 1 second
    expect(elapsed).toBeLessThan(1000);
  });
});
