/**
 * Benchmark: Embedding storage size with different quantization options.
 *
 * Compares memory footprint of:
 * - Full float32 representation
 * - Int8 scalar quantization (expected 4x compression)
 * - Binary quantization (expected 32x compression)
 *
 * Verifies compression ratios match expectations.
 */

import { describe, bench, expect, it } from 'vitest';
import { EmbeddingStore } from '../memory/embedding-store.js';
import { mkdtemp, stat } from 'node:fs/promises';
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

function float32Size(dim: number, count: number): number {
  return dim * 4 * count;
}

function int8Size(dim: number, count: number): number {
  return (dim + 8) * count;
}

function binarySize(dim: number, count: number): number {
  return Math.ceil(dim / 8) * count;
}

// ---------------------------------------------------------------------------
// Storage size validation
// ---------------------------------------------------------------------------

describe('Embedding storage size comparison', () => {
  const dims = [128, 384, 768] as const;
  const count = 10_000;

  for (const dim of dims) {
    it(`compression ratios at dim=${dim}, count=${count.toLocaleString()}`, () => {
      const f32Bytes = float32Size(dim, count);
      const i8Bytes = int8Size(dim, count);
      const binBytes = binarySize(dim, count);

      const int8Ratio = f32Bytes / i8Bytes;
      const binaryRatio = f32Bytes / binBytes;

      console.log(
        `dim=${dim}: float32=${(f32Bytes / 1024 / 1024).toFixed(2)}MB ` +
        `int8=${(i8Bytes / 1024 / 1024).toFixed(2)}MB (${int8Ratio.toFixed(1)}x) ` +
        `binary=${(binBytes / 1024 / 1024).toFixed(2)}MB (${binaryRatio.toFixed(1)}x)`,
      );

      // Int8: expect ~4x compression (dim*4 / (dim+8) approaches 4 for large dim)
      expect(int8Ratio).toBeGreaterThan(3.5);
      expect(int8Ratio).toBeLessThan(4.1);

      // Binary: expect ~32x compression (dim*4 / ceil(dim/8) = 32 for dim divisible by 8)
      expect(binaryRatio).toBeGreaterThan(30);
      expect(binaryRatio).toBeLessThan(33);
    });
  }
});

// ---------------------------------------------------------------------------
// Quantization throughput benchmarks
// ---------------------------------------------------------------------------

describe('Quantization throughput', () => {
  const store = new EmbeddingStore();
  const dim = 384;

  bench('quantizeBinary 384-dim x100', () => {
    for (let i = 0; i < 100; i++) {
      store.quantizeBinary(randomEmbedding(dim));
    }
  });

  bench('quantizeInt8 384-dim x100', () => {
    for (let i = 0; i < 100; i++) {
      store.quantizeInt8(randomEmbedding(dim));
    }
  });

  bench('dequantizeInt8 384-dim x100', () => {
    const quantized = store.quantizeInt8(randomEmbedding(dim));
    for (let i = 0; i < 100; i++) {
      store.dequantizeInt8(quantized);
    }
  });
});

// ---------------------------------------------------------------------------
// Actual memory footprint via EmbeddingStore.stats()
// ---------------------------------------------------------------------------

describe('EmbeddingStore.stats() memory estimation', () => {
  const dim = 128;

  for (const count of [100, 1_000, 10_000]) {
    bench(`populate and stat ${count.toLocaleString()} entries (dim=${dim})`, () => {
      const store = new EmbeddingStore();
      for (let i = 0; i < count; i++) {
        store.set(`id-${i}`, randomEmbedding(dim));
      }
      const stats = store.stats();

      if (stats.entryCount !== count) {
        throw new Error(`Expected ${count} entries, got ${stats.entryCount}`);
      }
      if (stats.dimension !== dim) {
        throw new Error(`Expected dim=${dim}, got ${stats.dimension}`);
      }
    }, { iterations: 1 });
  }
});

// ---------------------------------------------------------------------------
// File-backed persistence size
// ---------------------------------------------------------------------------

describe('Serialization size', () => {
  const dim = 128;
  const count = 1_000;

  it('save/load round-trip preserves data and file size matches expectations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apex-bench-embed-'));
    const filePath = join(dir, 'embeddings.bin');

    const store = new EmbeddingStore();
    for (let i = 0; i < count; i++) {
      store.set(`entry-${i}`, randomEmbedding(dim));
    }

    await store.save(filePath);

    const fileInfo = await stat(filePath);
    const expectedMinBytes = count * dim * 4;
    const overhead = count * 20;

    console.log(
      `File size: ${(fileInfo.size / 1024).toFixed(1)}KB ` +
      `(expected ~${((expectedMinBytes + overhead) / 1024).toFixed(1)}KB)`,
    );

    expect(fileInfo.size).toBeGreaterThan(expectedMinBytes);
    expect(fileInfo.size).toBeLessThan(expectedMinBytes * 2);

    const loaded = new EmbeddingStore();
    await loaded.load(filePath);
    const loadedStats = loaded.stats();
    expect(loadedStats.entryCount).toBe(count);
    expect(loadedStats.dimension).toBe(dim);
  });
});
