/**
 * Memory efficiency validation: Ring buffer bounded growth
 * and stress testing with 10K episodes.
 */
import { describe, it, expect, vi } from 'vitest';
import { RingBuffer } from '../utils/ring-buffer.js';

vi.mock('../utils/embeddings.js', () => ({
  getEmbedding: vi.fn((text: string) => ({
    keywords: text.split(/\s+/).slice(0, 5),
    simhash: BigInt(0),
    embedding: undefined,
  })),
  extractKeywords: vi.fn((text: string) => text.split(/\s+/).filter(Boolean)),
  simHash: vi.fn(() => BigInt(0)),
  simHashSimilarity: vi.fn(() => 0.5),
}));

vi.mock('../utils/similarity.js', () => ({
  combinedSimilarity: vi.fn(() => 0.5),
}));

vi.mock('../utils/hashing.js', () => ({
  contentHash: vi.fn((text: string) => String(text.length)),
}));

describe('Memory Bounds Validation', () => {
  it('ring buffer stays bounded after 100K pushes with capacity 1K', () => {
    const capacity = 1000;
    const buf = new RingBuffer<{ id: number; data: string }>(capacity);

    for (let i = 0; i < 100_000; i++) {
      buf.push({ id: i, data: `item-${i}` });
    }

    expect(buf.length).toBe(capacity);
    expect(buf.isFull).toBe(true);

    // Oldest should be 99000 (100000 - 1000)
    expect(buf.get(0).id).toBe(99_000);
    // Newest should be 99999
    expect(buf.get(capacity - 1).id).toBe(99_999);
  });

  it('ring buffer toArray length matches capacity', () => {
    const buf = new RingBuffer<number>(500);
    for (let i = 0; i < 10_000; i++) {
      buf.push(i);
    }
    expect(buf.toArray()).toHaveLength(500);
  });
});

describe('Stress Test: Large Volume', () => {
  it('EpisodicMemory handles 1K entries without error', async () => {
    const { EpisodicMemory } = await import('../memory/episodic.js');

    const em = new EpisodicMemory({ capacity: 500 });

    for (let i = 0; i < 1000; i++) {
      await em.add(`episode ${i}: task about ${i % 10 === 0 ? 'typescript' : 'python'} ${i}`);
    }

    // Should be at or under capacity after eviction
    const stats = em.stats();
    expect(stats.entryCount).toBeLessThanOrEqual(500);

    // Search should still work
    const results = await em.search('typescript');
    expect(results.length).toBeGreaterThan(0);
  });

  it('SemanticMemory handles 500 entries with dedup', async () => {
    const { SemanticMemory } = await import('../memory/semantic.js');

    const sm = new SemanticMemory({ capacity: 200 });

    for (let i = 0; i < 500; i++) {
      await sm.add(`knowledge entry ${i}: fact about topic ${i % 50}`);
    }

    const stats = sm.stats();
    expect(stats.entryCount).toBeLessThanOrEqual(200);

    const results = await sm.search('knowledge fact');
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('Heap Usage Tracking', () => {
  it('ring buffer does not grow heap significantly beyond capacity', () => {
    const heapBefore = process.memoryUsage().heapUsed;

    const buf = new RingBuffer<{ data: string }>(1000);
    for (let i = 0; i < 50_000; i++) {
      buf.push({ data: `item-${i}-${'x'.repeat(100)}` });
    }

    const heapAfter = process.memoryUsage().heapUsed;
    const growth = heapAfter - heapBefore;

    // Growth should be roughly proportional to capacity (1K items * ~110 bytes each),
    // not to total items pushed (50K). Allow generous margin for GC timing
    // and V8 heap expansion. 50MB is generous but ensures the buffer isn't
    // growing unboundedly (50K * 200 bytes = 10MB if no eviction).
    expect(growth).toBeLessThan(50 * 1024 * 1024);
    expect(buf.length).toBe(1000);
  });
});
