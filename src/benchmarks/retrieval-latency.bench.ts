/**
 * Benchmark: Memory retrieval latency at various store sizes.
 *
 * Measures the time to search/recall across embedding stores at 1K, 10K,
 * and 100K entry scales.
 *
 * Target: < 100ms at 10K entries.
 */

import { describe, bench, beforeAll } from 'vitest';
import { EmbeddingStore } from '../memory/embedding-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random float32 vector of the given dimension. */
function randomEmbedding(dim: number): number[] {
  const vec = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.random() * 2 - 1;
  }
  return vec;
}

/**
 * Populate an EmbeddingStore with N entries of the given dimension.
 */
function populateEmbeddingStore(count: number, dim: number): EmbeddingStore {
  const store = new EmbeddingStore();
  for (let i = 0; i < count; i++) {
    store.set(`entry-${i}`, randomEmbedding(dim));
  }
  return store;
}

// ---------------------------------------------------------------------------
// Manual percentile computation
// ---------------------------------------------------------------------------

interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
}

function computeLatencyStats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const len = sorted.length;
  return {
    p50: sorted[Math.floor(len * 0.5)],
    p95: sorted[Math.floor(len * 0.95)],
    p99: sorted[Math.floor(len * 0.99)],
    mean: sorted.reduce((a, b) => a + b, 0) / len,
    min: sorted[0],
    max: sorted[len - 1],
  };
}

// ---------------------------------------------------------------------------
// Benchmarks using vitest bench API
// ---------------------------------------------------------------------------

const DIM = 128;

describe('EmbeddingStore.search latency - 1K entries', () => {
  let store: EmbeddingStore;
  let query: number[];

  beforeAll(() => {
    store = populateEmbeddingStore(1_000, DIM);
    query = randomEmbedding(DIM);
  });

  bench('search top-10 in 1K entries', () => {
    store.search(query, 10);
  });
});

describe('EmbeddingStore.search latency - 10K entries', () => {
  let store: EmbeddingStore;
  let query: number[];

  beforeAll(() => {
    store = populateEmbeddingStore(10_000, DIM);
    query = randomEmbedding(DIM);
  });

  bench('search top-10 in 10K entries', () => {
    store.search(query, 10);
  });
});

describe('EmbeddingStore.search latency - 100K entries', () => {
  let store: EmbeddingStore;
  let query: number[];

  beforeAll(() => {
    store = populateEmbeddingStore(100_000, DIM);
    query = randomEmbedding(DIM);
  });

  bench('search top-10 in 100K entries', () => {
    store.search(query, 10);
  });
});

// ---------------------------------------------------------------------------
// Manual timing with percentile reporting
// ---------------------------------------------------------------------------

describe('Retrieval latency percentiles (manual timing)', () => {
  const sizes = [1_000, 10_000, 100_000] as const;

  for (const size of sizes) {
    bench(`p50/p95/p99 latency at ${size.toLocaleString()} entries`, () => {
      const store = populateEmbeddingStore(size, DIM);
      const iterations = Math.min(100, Math.max(10, Math.floor(10_000 / size)));
      const samples: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const q = randomEmbedding(DIM);
        const start = performance.now();
        store.search(q, 10);
        const elapsed = performance.now() - start;
        samples.push(elapsed);
      }

      const stats = computeLatencyStats(samples);

      console.log(
        `[${size.toLocaleString()} entries] ` +
        `p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms ` +
        `p99=${stats.p99.toFixed(2)}ms mean=${stats.mean.toFixed(2)}ms`,
      );

      // Assert target: p95 < 100ms at 10K
      if (size === 10_000 && stats.p95 > 100) {
        console.warn(
          `WARNING: p95 latency at 10K entries (${stats.p95.toFixed(2)}ms) exceeds 100ms target`,
        );
      }
    }, { iterations: 1 });
  }
});
