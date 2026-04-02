import { describe, it, expect } from 'vitest';
import { cosineSimilarity, jaccardSimilarity } from './similarity.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('handles vectors of different lengths (uses shorter)', () => {
    // [1,2] dot [1,2] = 5, norms = sqrt(5)*sqrt(5) = 5 => 1.0
    expect(cosineSimilarity([1, 2, 999], [1, 2])).toBeCloseTo(1.0);
  });

  it('returns correct value for known vectors', () => {
    // [1,0,1] · [0,1,1] = 1
    // |a| = sqrt(2), |b| = sqrt(2), cos = 1/2 = 0.5
    expect(cosineSimilarity([1, 0, 1], [0, 1, 1])).toBeCloseTo(0.5);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    const s = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(s, s)).toBeCloseTo(1.0);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['c', 'd']);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('returns 0 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it('returns 0 when one set is empty', () => {
    const a = new Set(['x']);
    expect(jaccardSimilarity(a, new Set())).toBeCloseTo(0.0);
  });

  it('computes correct partial overlap', () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} size 2
    // {a,b,c} ∪ {b,c,d} = {a,b,c,d} size 4
    // Jaccard = 2/4 = 0.5
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
  });

  it('handles single-element sets', () => {
    const a = new Set(['x']);
    const b = new Set(['x']);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(1.0);

    const c = new Set(['y']);
    expect(jaccardSimilarity(a, c)).toBeCloseTo(0.0);
  });
});
