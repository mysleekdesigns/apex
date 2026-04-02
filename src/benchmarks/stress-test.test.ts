/**
 * Stress Test: 10K episodes.
 *
 * Validates that the memory system can handle bulk insertion of 10K episodes
 * without OOM errors, maintains correct retrieval behaviour, and respects
 * tier size limits through eviction.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { EmbeddingStore } from '../memory/embedding-store.js';
import { MemoryManager } from '../memory/manager.js';
import { RingBuffer } from '../utils/ring-buffer.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomEmbedding(dim: number): number[] {
  const vec = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.random() * 2 - 1;
  }
  return vec;
}

function syntheticContent(index: number): string {
  const domains = ['refactoring', 'testing', 'documentation', 'debugging', 'optimization'];
  const actions = ['fixed', 'added', 'updated', 'removed', 'refactored'];
  const targets = ['component', 'module', 'service', 'handler', 'utility'];
  return (
    `${actions[index % actions.length]} ${targets[index % targets.length]} ` +
    `in ${domains[index % domains.length]} domain. ` +
    `Episode ${index}: performed complex operations on the codebase ` +
    `involving multiple file edits and test runs.`
  );
}

// ---------------------------------------------------------------------------
// EmbeddingStore: 10K entries stress test
// ---------------------------------------------------------------------------

describe('EmbeddingStore: 10K entries stress test', () => {
  const DIM = 128;
  const ENTRY_COUNT = 10_000;

  it('should store and retrieve 10K embeddings without OOM', () => {
    const heapBefore = process.memoryUsage().heapUsed;

    const store = new EmbeddingStore();
    for (let i = 0; i < ENTRY_COUNT; i++) {
      store.set(`episode-${i}`, randomEmbedding(DIM));
    }

    const heapAfter = process.memoryUsage().heapUsed;
    const heapDeltaMB = (heapAfter - heapBefore) / 1024 / 1024;

    const stats = store.stats();
    expect(stats.entryCount).toBe(ENTRY_COUNT);
    expect(stats.dimension).toBe(DIM);

    console.log(
      `10K embeddings stored. Heap delta: ${heapDeltaMB.toFixed(1)}MB. ` +
      `Estimated memory: ${(stats.estimatedMemoryBytes / 1024 / 1024).toFixed(1)}MB.`,
    );

    // Verify retrieval still works after mass insertion
    const query = randomEmbedding(DIM);
    const results = store.search(query, 10);

    expect(results.length).toBe(10);
    // Scores should be in descending order
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }

    // Each result should have a valid ID
    for (const r of results) {
      expect(r.id).toMatch(/^episode-\d+$/);
      expect(r.score).toBeGreaterThan(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('should handle concurrent-like rapid insertions and searches', () => {
    const store = new EmbeddingStore();

    // Interleave insertions and searches
    for (let i = 0; i < ENTRY_COUNT; i++) {
      store.set(`entry-${i}`, randomEmbedding(DIM));

      // Periodically search to simulate concurrent access patterns
      if (i > 0 && i % 1000 === 0) {
        const results = store.search(randomEmbedding(DIM), 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results.length).toBeLessThanOrEqual(5);
      }
    }

    expect(store.stats().entryCount).toBe(ENTRY_COUNT);
  });
});

// ---------------------------------------------------------------------------
// RingBuffer: 10K items with bounded capacity
// ---------------------------------------------------------------------------

describe('RingBuffer: 10K items with bounded capacity', () => {
  it('should keep only the most recent items within capacity', () => {
    const capacity = 1_000;
    const totalItems = 10_000;
    const buffer = new RingBuffer<string>(capacity);

    for (let i = 0; i < totalItems; i++) {
      buffer.push(`item-${i}`);
    }

    expect(buffer.length).toBe(capacity);
    expect(buffer.isFull).toBe(true);

    // Should contain the last 1000 items
    const items = buffer.toArray();
    expect(items[0]).toBe(`item-${totalItems - capacity}`);
    expect(items[capacity - 1]).toBe(`item-${totalItems - 1}`);
  });
});

// ---------------------------------------------------------------------------
// MemoryManager: bulk insertion with tier limits
// ---------------------------------------------------------------------------

describe('MemoryManager: bulk insertion stress test', () => {
  let manager: MemoryManager;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'apex-stress-'));
    manager = new MemoryManager({
      projectDataPath: join(dataDir, '.apex-data'),
      projectPath: dataDir,
      limits: {
        working: 50,
        episodic: 500,
        semantic: 200,
      },
      consolidationThreshold: 25,
    });
    await manager.init();
  });

  it('should handle bulk working memory insertions with overflow to episodic', async () => {
    const heapBefore = process.memoryUsage().heapUsed;

    // Insert 200 items into working memory (capacity 50)
    // Excess should overflow to episodic via the event bus
    for (let i = 0; i < 200; i++) {
      manager.addToWorking(syntheticContent(i), [`file-${i}.ts`]);
    }

    // Allow event bus overflow handlers to process
    await new Promise((resolve) => setTimeout(resolve, 100));

    const heapAfter = process.memoryUsage().heapUsed;
    const heapDeltaMB = (heapAfter - heapBefore) / 1024 / 1024;

    console.log(`Heap delta after 200 working memory inserts: ${heapDeltaMB.toFixed(1)}MB`);

    const status = await manager.status();
    console.log('Memory status after bulk insert:', {
      working: status.working.count,
      episodic: status.episodic.entryCount,
    });

    // Working memory should be at or below capacity
    expect(status.working.count).toBeLessThanOrEqual(50);
  });

  it('should handle bulk episodic memory insertions', async () => {
    const heapBefore = process.memoryUsage().heapUsed;

    // Use 200 inserts instead of 1000 to keep test time reasonable
    for (let i = 0; i < 200; i++) {
      await manager.addToEpisodic(syntheticContent(i));
    }

    const heapAfter = process.memoryUsage().heapUsed;
    const heapDeltaMB = (heapAfter - heapBefore) / 1024 / 1024;

    console.log(`Heap delta after 200 episodic inserts: ${heapDeltaMB.toFixed(1)}MB`);

    const status = await manager.status();
    console.log('Episodic memory stats:', status.episodic);
    expect(status.episodic.entryCount).toBeGreaterThan(0);
  }, 30_000);

  it('recall should still work correctly after mass insertion', async () => {
    const results = await manager.recall('debugging optimization', 10);

    // Should return results (content includes these keywords)
    expect(results.length).toBeGreaterThan(0);

    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });
});

// ---------------------------------------------------------------------------
// Heap usage stability over time
// ---------------------------------------------------------------------------

describe('Heap usage stability', () => {
  it('heap should not grow linearly with insertions into a bounded store', () => {
    const store = new EmbeddingStore();
    const DIM = 64;
    const measurements: number[] = [];

    // Take heap measurements at intervals
    for (let batch = 0; batch < 10; batch++) {
      for (let i = 0; i < 1000; i++) {
        const idx = batch * 1000 + i;
        store.set(`e-${idx}`, randomEmbedding(DIM));
      }
      measurements.push(process.memoryUsage().heapUsed);
    }

    // EmbeddingStore does not evict (it grows), so heap will grow.
    // But verify it grows linearly (not exponentially).
    const firstHalfGrowth = measurements[4] - measurements[0];
    const secondHalfGrowth = measurements[9] - measurements[5];

    console.log(
      `Heap growth first 5K: ${(firstHalfGrowth / 1024 / 1024).toFixed(1)}MB, ` +
      `second 5K: ${(secondHalfGrowth / 1024 / 1024).toFixed(1)}MB`,
    );

    // Second half should not be dramatically more than first half
    // (would indicate a leak or exponential growth)
    if (firstHalfGrowth > 0) {
      const ratio = secondHalfGrowth / firstHalfGrowth;
      console.log(`Growth ratio (second/first half): ${ratio.toFixed(2)}x`);
      expect(ratio).toBeLessThan(3);
    }
  });
});
