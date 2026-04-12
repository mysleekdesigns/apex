import { describe, it, expect, beforeEach } from 'vitest';
import { HNSWIndex } from './vector-index.js';
import type { HNSWConfig, SearchResult } from './vector-index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unit vector along a single axis in n-dimensional space. */
function basisVector(dim: number, axis: number): number[] {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

/** Create a random (but seeded-ish) vector using a simple LCG. */
function pseudoRandomVector(dim: number, seed: number): number[] {
  let s = seed;
  const v: number[] = [];
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    v.push(s / 0x7fffffff - 0.5); // range roughly [-0.5, 0.5]
  }
  return v;
}

/** Normalize a vector to unit length. */
function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HNSWIndex', () => {
  // ── Construction ────────────────────────────────────────────────────

  describe('construction', () => {
    it('creates an index with default config', () => {
      const index = new HNSWIndex(128);
      expect(index.getDimensions()).toBe(128);
      expect(index.size).toBe(0);
    });

    it('creates an index with custom config', () => {
      const config: HNSWConfig = {
        M: 32,
        efConstruction: 400,
        ef: 100,
        distanceFunction: 'euclidean',
      };
      const index = new HNSWIndex(64, config);
      expect(index.getDimensions()).toBe(64);
      expect(index.size).toBe(0);
    });

    it('throws on invalid dimensions', () => {
      expect(() => new HNSWIndex(0)).toThrow();
      expect(() => new HNSWIndex(-5)).toThrow();
      expect(() => new HNSWIndex(3.7)).toThrow();
    });
  });

  // ── Insert & Search ────────────────────────────────────────────────

  describe('insert and search', () => {
    it('inserts a vector and finds it as nearest neighbor', () => {
      const index = new HNSWIndex(3);
      index.insert('a', [1, 0, 0]);
      const results = index.search([1, 0, 0], 1);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('a');
      expect(results[0].distance).toBeCloseTo(0, 5);
    });

    it('finds the closest among several vectors', () => {
      const index = new HNSWIndex(3);
      index.insert('x', [1, 0, 0]);
      index.insert('y', [0, 1, 0]);
      index.insert('z', [0, 0, 1]);

      // Query closest to x-axis
      const results = index.search([0.9, 0.1, 0], 1);
      expect(results[0].id).toBe('x');
    });

    it('returns k results sorted by distance ascending', () => {
      const index = new HNSWIndex(3);
      index.insert('a', normalize([1, 0, 0]));
      index.insert('b', normalize([1, 1, 0]));
      index.insert('c', normalize([0, 1, 0]));

      const results = index.search(normalize([1, 0, 0]), 3);
      expect(results).toHaveLength(3);
      // Distances should be non-decreasing
      for (let i = 1; i < results.length; i++) {
        expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
      }
      // Closest should be 'a' (exact match)
      expect(results[0].id).toBe('a');
    });

    it('throws on dimension mismatch for insert', () => {
      const index = new HNSWIndex(3);
      expect(() => index.insert('bad', [1, 2])).toThrow('dimension mismatch');
    });

    it('throws on dimension mismatch for search', () => {
      const index = new HNSWIndex(3);
      index.insert('a', [1, 0, 0]);
      expect(() => index.search([1, 0], 1)).toThrow('dimension mismatch');
    });
  });

  // ── Distance functions ─────────────────────────────────────────────

  describe('cosine distance', () => {
    it('returns 0 distance for identical normalized vectors', () => {
      const index = new HNSWIndex(3, { distanceFunction: 'cosine' });
      index.insert('a', normalize([1, 2, 3]));
      const results = index.search(normalize([1, 2, 3]), 1);
      expect(results[0].distance).toBeCloseTo(0, 5);
    });

    it('returns distance ~1 for orthogonal vectors', () => {
      const index = new HNSWIndex(2, { distanceFunction: 'cosine' });
      index.insert('a', [1, 0]);
      index.insert('b', [0, 1]);
      const results = index.search([1, 0], 2);
      // Self should be ~0, orthogonal should be ~1
      expect(results[0].distance).toBeCloseTo(0, 5);
      expect(results[1].distance).toBeCloseTo(1, 5);
    });
  });

  describe('euclidean distance', () => {
    it('returns correct nearest neighbors', () => {
      const index = new HNSWIndex(2, { distanceFunction: 'euclidean' });
      index.insert('origin', [0, 0]);
      index.insert('near', [1, 0]);
      index.insert('far', [10, 10]);

      const results = index.search([0, 0], 3);
      expect(results[0].id).toBe('origin');
      expect(results[0].distance).toBeCloseTo(0, 5);
      expect(results[1].id).toBe('near');
      expect(results[1].distance).toBeCloseTo(1, 5);
      expect(results[2].id).toBe('far');
      expect(results[2].distance).toBeCloseTo(Math.sqrt(200), 3);
    });
  });

  describe('dot product distance', () => {
    it('ranks higher dot-product vectors as closer (lower distance)', () => {
      const index = new HNSWIndex(2, { distanceFunction: 'dotProduct' });
      // dot product distance = -dot, so higher dot => lower distance
      index.insert('big', [10, 10]);
      index.insert('small', [1, 1]);
      index.insert('neg', [-5, -5]);

      const results = index.search([1, 1], 3);
      // [1,1].[10,10] = 20, distance = -20
      // [1,1].[1,1]   = 2,  distance = -2
      // [1,1].[-5,-5] = -10, distance = 10
      expect(results[0].id).toBe('big');
      expect(results[1].id).toBe('small');
      expect(results[2].id).toBe('neg');
    });
  });

  // ── Batch insert ───────────────────────────────────────────────────

  describe('insertBatch', () => {
    it('adds multiple vectors at once', () => {
      const index = new HNSWIndex(3);
      index.insertBatch([
        { id: 'a', vector: [1, 0, 0] },
        { id: 'b', vector: [0, 1, 0] },
        { id: 'c', vector: [0, 0, 1] },
      ]);
      expect(index.size).toBe(3);
      expect(index.has('a')).toBe(true);
      expect(index.has('b')).toBe(true);
      expect(index.has('c')).toBe(true);
    });
  });

  // ── Delete ─────────────────────────────────────────────────────────

  describe('delete', () => {
    it('excludes deleted nodes from search results', () => {
      const index = new HNSWIndex(3);
      index.insert('a', [1, 0, 0]);
      index.insert('b', [0, 1, 0]);
      expect(index.size).toBe(2);

      const deleted = index.delete('a');
      expect(deleted).toBe(true);
      expect(index.size).toBe(1);
      expect(index.has('a')).toBe(false);

      const results = index.search([1, 0, 0], 5);
      const ids = results.map((r) => r.id);
      expect(ids).not.toContain('a');
    });

    it('returns false for non-existent id', () => {
      const index = new HNSWIndex(3);
      expect(index.delete('missing')).toBe(false);
    });

    it('returns false for already-deleted id', () => {
      const index = new HNSWIndex(3);
      index.insert('a', [1, 0, 0]);
      index.delete('a');
      expect(index.delete('a')).toBe(false);
    });
  });

  // ── Size & has ─────────────────────────────────────────────────────

  describe('size and has', () => {
    it('tracks size correctly through inserts and deletes', () => {
      const index = new HNSWIndex(2);
      expect(index.size).toBe(0);

      index.insert('a', [1, 0]);
      expect(index.size).toBe(1);

      index.insert('b', [0, 1]);
      expect(index.size).toBe(2);

      index.delete('a');
      expect(index.size).toBe(1);

      index.delete('b');
      expect(index.size).toBe(0);
    });

    it('has returns correct values', () => {
      const index = new HNSWIndex(2);
      expect(index.has('x')).toBe(false);

      index.insert('x', [1, 0]);
      expect(index.has('x')).toBe(true);

      index.delete('x');
      expect(index.has('x')).toBe(false);
    });
  });

  // ── getDimensions ──────────────────────────────────────────────────

  describe('getDimensions', () => {
    it('returns the configured dimensionality', () => {
      expect(new HNSWIndex(3).getDimensions()).toBe(3);
      expect(new HNSWIndex(384).getDimensions()).toBe(384);
      expect(new HNSWIndex(1).getDimensions()).toBe(1);
    });
  });

  // ── Empty index ────────────────────────────────────────────────────

  describe('empty index', () => {
    it('search returns empty array on empty index', () => {
      const index = new HNSWIndex(3);
      const results = index.search([1, 0, 0], 5);
      expect(results).toEqual([]);
    });

    it('search returns empty after all items deleted', () => {
      const index = new HNSWIndex(3);
      index.insert('a', [1, 0, 0]);
      index.delete('a');
      const results = index.search([1, 0, 0], 5);
      expect(results).toEqual([]);
    });
  });

  // ── Serialization round-trip ───────────────────────────────────────

  describe('serialization', () => {
    it('round-trips correctly: serialize then deserialize', () => {
      const index = new HNSWIndex(4, { distanceFunction: 'cosine', M: 8, ef: 30 });
      index.insert('a', normalize([1, 0, 0, 0]));
      index.insert('b', normalize([0, 1, 0, 0]));
      index.insert('c', normalize([1, 1, 0, 0]));
      index.insert('d', normalize([0, 0, 1, 0]));

      const serialized = index.serialize();
      expect(serialized).toBeInstanceOf(Uint8Array);
      expect(serialized.length).toBeGreaterThan(0);

      const restored = HNSWIndex.deserialize(serialized);
      expect(restored.getDimensions()).toBe(4);
      expect(restored.size).toBe(4);
      expect(restored.has('a')).toBe(true);
      expect(restored.has('d')).toBe(true);

      // Search on restored index should find the same results
      const query = normalize([1, 0, 0, 0]);
      const origResults = index.search(query, 2);
      const restoredResults = restored.search(query, 2);

      expect(restoredResults.map((r) => r.id)).toEqual(origResults.map((r) => r.id));
      for (let i = 0; i < origResults.length; i++) {
        expect(restoredResults[i].distance).toBeCloseTo(origResults[i].distance, 5);
      }
    });

    it('preserves deleted nodes correctly', () => {
      const index = new HNSWIndex(3);
      index.insert('a', [1, 0, 0]);
      index.insert('b', [0, 1, 0]);
      index.delete('a');

      const restored = HNSWIndex.deserialize(index.serialize());
      expect(restored.size).toBe(1);
      expect(restored.has('a')).toBe(false);
      expect(restored.has('b')).toBe(true);
    });
  });

  // ── Scaling test ───────────────────────────────────────────────────

  describe('scaling', () => {
    it('correctly retrieves nearest neighbors among 1000+ vectors', () => {
      const dim = 32;
      const index = new HNSWIndex(dim, { M: 16, efConstruction: 100, ef: 50 });

      // Insert 1000 pseudo-random vectors
      for (let i = 0; i < 1000; i++) {
        index.insert(`v${i}`, pseudoRandomVector(dim, i + 1));
      }
      expect(index.size).toBe(1000);

      // Insert a known vector and search for it
      const knownVec = new Array(dim).fill(0);
      knownVec[0] = 1;
      index.insert('target', normalize(knownVec));

      const results = index.search(normalize(knownVec), 5);
      expect(results.length).toBe(5);
      // The exact vector should be the top result
      expect(results[0].id).toBe('target');
      expect(results[0].distance).toBeCloseTo(0, 4);
    });
  });

  // ── Duplicate ID insert ────────────────────────────────────────────

  describe('duplicate ID insert', () => {
    it('replaces the old vector when inserting with the same ID', () => {
      const index = new HNSWIndex(3);
      index.insert('dup', [1, 0, 0]);
      expect(index.size).toBe(1);

      // Re-insert with a different vector
      index.insert('dup', [0, 1, 0]);
      expect(index.size).toBe(1);
      expect(index.has('dup')).toBe(true);

      // Searching near the NEW vector should find it
      const results = index.search([0, 1, 0], 1);
      expect(results[0].id).toBe('dup');
      expect(results[0].distance).toBeCloseTo(0, 5);
    });
  });

  // ── Search with custom ef ──────────────────────────────────────────

  describe('search with custom ef', () => {
    it('accepts an ef parameter and returns valid results', () => {
      const dim = 8;
      const index = new HNSWIndex(dim, { ef: 10 });

      for (let i = 0; i < 50; i++) {
        index.insert(`v${i}`, pseudoRandomVector(dim, i + 100));
      }

      const query = pseudoRandomVector(dim, 999);

      // Search with small ef
      const smallEf = index.search(query, 5, 10);
      // Search with large ef (more exploration, potentially better results)
      const largeEf = index.search(query, 5, 200);

      expect(smallEf.length).toBe(5);
      expect(largeEf.length).toBe(5);

      // The large ef results should have distances <= the small ef results
      // (or at least no worse for the top-1)
      expect(largeEf[0].distance).toBeLessThanOrEqual(smallEf[0].distance + 1e-9);
    });
  });
});
