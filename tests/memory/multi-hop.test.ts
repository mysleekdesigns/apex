import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SearchResult, MemoryEntry } from '../../src/types.js';
import { MultiHopRetriever } from '../../src/memory/multi-hop.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/embeddings.js', () => ({
  extractKeywords: vi.fn((text: string) =>
    text.toLowerCase().split(/\s+/).filter(Boolean),
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(id: string, score: number, content = `content for ${id}`): SearchResult {
  const entry: MemoryEntry = {
    id,
    content,
    heatScore: 1,
    confidence: 1,
    createdAt: Date.now(),
    accessedAt: Date.now(),
    tier: 'episodic',
  };
  return { entry, score, sourceTier: 'episodic', source: 'project' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultiHopRetriever', () => {
  let recallFn: ReturnType<typeof vi.fn>;
  let retriever: MultiHopRetriever;

  beforeEach(() => {
    recallFn = vi.fn();
    retriever = new MultiHopRetriever(recallFn);
  });

  it('does a single hop when results are good', async () => {
    recallFn.mockResolvedValueOnce([
      makeResult('a', 0.9),
      makeResult('b', 0.8),
      makeResult('c', 0.7),
    ]);

    const result = await retriever.retrieve('test query', 3);

    expect(result.hops).toBe(1);
    expect(result.improvement).toBe(0);
    expect(result.refinedQuery).toBeUndefined();
    expect(recallFn).toHaveBeenCalledTimes(1);
    expect(result.hopDetails).toHaveLength(1);
  });

  it('triggers multi-hop when top score is below threshold', async () => {
    recallFn
      .mockResolvedValueOnce([makeResult('a', 0.3), makeResult('b', 0.2)])
      .mockResolvedValueOnce([makeResult('c', 0.6), makeResult('d', 0.5)]);

    const result = await retriever.retrieve('test query', 4);

    expect(result.hops).toBe(2);
    expect(recallFn).toHaveBeenCalledTimes(2);
    expect(result.refinedQuery).toBeDefined();
    expect(result.hopDetails).toHaveLength(2);
  });

  it('triggers multi-hop when result count is below topK/2', async () => {
    // Only 1 result for topK=4 => 1 < 2
    recallFn
      .mockResolvedValueOnce([makeResult('a', 0.8)])
      .mockResolvedValueOnce([makeResult('b', 0.85), makeResult('c', 0.7)]);

    const result = await retriever.retrieve('query', 4);

    expect(result.hops).toBe(2);
    expect(recallFn).toHaveBeenCalledTimes(2);
  });

  it('deduplicates results across hops keeping higher score', async () => {
    recallFn
      .mockResolvedValueOnce([makeResult('a', 0.3), makeResult('b', 0.2)])
      .mockResolvedValueOnce([makeResult('a', 0.7), makeResult('c', 0.6)]);

    const result = await retriever.retrieve('query', 3);

    const ids = result.results.map((r) => r.entry.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
    // 'a' should have the higher score from hop 2
    const a = result.results.find((r) => r.entry.id === 'a')!;
    expect(a.score).toBe(0.7);
    // Results sorted by score descending
    expect(result.results[0].score).toBeGreaterThanOrEqual(result.results[1].score);
  });

  it('respects maxHops cap', async () => {
    recallFn
      .mockResolvedValueOnce([makeResult('a', 0.1)])
      .mockResolvedValueOnce([makeResult('b', 0.1)]);

    // maxHops=1 should prevent second hop even with low scores
    const result = await retriever.retrieve('query', 4, { maxHops: 1 });

    expect(result.hops).toBe(1);
    expect(recallFn).toHaveBeenCalledTimes(1);
  });

  it('tracks stats correctly', async () => {
    // First query: good results, single hop
    recallFn.mockResolvedValueOnce([makeResult('a', 0.9), makeResult('b', 0.8)]);
    await retriever.retrieve('good query', 2);

    // Second query: poor results, triggers multi-hop
    recallFn
      .mockResolvedValueOnce([makeResult('c', 0.2)])
      .mockResolvedValueOnce([makeResult('d', 0.6)]);
    await retriever.retrieve('poor query', 4);

    const stats = retriever.getStats();
    expect(stats.totalQueries).toBe(2);
    expect(stats.multiHopRate).toBe(0.5);
    expect(stats.avgImprovement).toBeGreaterThanOrEqual(0);
  });
});
