import { describe, it, expect, vi } from 'vitest';
import {
  computeUCB1,
  computeRecencyWeight,
  computeSkillBoost,
  ValueEstimator,
} from './value.js';
import type { ActionTreeNode } from './action-tree.js';

// Mock similarity and embeddings
vi.mock('../utils/similarity.js', () => ({
  jaccardSimilarity: vi.fn((a: Set<string>, b: Set<string>) => {
    let intersection = 0;
    for (const item of a) if (b.has(item)) intersection++;
    const union = new Set([...a, ...b]).size;
    return union > 0 ? intersection / union : 0;
  }),
}));

vi.mock('../utils/embeddings.js', () => ({
  extractKeywords: vi.fn((text: string) =>
    text.toLowerCase().split(/\s+/).filter(Boolean),
  ),
}));

describe('computeUCB1', () => {
  it('returns Infinity for unvisited nodes', () => {
    expect(computeUCB1(0.5, 10, 0)).toBe(Infinity);
  });

  it('returns avgValue when parentVisits is 0', () => {
    expect(computeUCB1(0.7, 0, 5)).toBeCloseTo(0.7);
  });

  it('computes correct UCB1 formula', () => {
    // avgValue + c * sqrt(ln(parentVisits) / childVisits)
    // 0.5 + sqrt(2) * sqrt(ln(10) / 5)
    const expected = 0.5 + Math.SQRT2 * Math.sqrt(Math.log(10) / 5);
    expect(computeUCB1(0.5, 10, 5)).toBeCloseTo(expected);
  });

  it('exploration bonus decreases with more child visits', () => {
    const few = computeUCB1(0.5, 100, 5);
    const many = computeUCB1(0.5, 100, 50);
    expect(few).toBeGreaterThan(many);
  });

  it('accepts custom exploration constant', () => {
    const c1 = computeUCB1(0.5, 10, 5, 1.0);
    const c2 = computeUCB1(0.5, 10, 5, 2.0);
    expect(c2).toBeGreaterThan(c1);
  });
});

describe('computeRecencyWeight', () => {
  it('returns 1.0 for current timestamp', () => {
    const now = Date.now();
    expect(computeRecencyWeight(now, 7 * 86400000, now)).toBeCloseTo(1.0);
  });

  it('returns 0.5 at exactly one half-life', () => {
    const halfLife = 7 * 86400000;
    const now = Date.now();
    const oneHalfLifeAgo = now - halfLife;
    expect(computeRecencyWeight(oneHalfLifeAgo, halfLife, now)).toBeCloseTo(0.5);
  });

  it('returns 0.25 at two half-lives', () => {
    const halfLife = 7 * 86400000;
    const now = Date.now();
    const twoHalfLivesAgo = now - 2 * halfLife;
    expect(computeRecencyWeight(twoHalfLivesAgo, halfLife, now)).toBeCloseTo(0.25);
  });

  it('clamps future timestamps to 1.0', () => {
    const now = Date.now();
    expect(computeRecencyWeight(now + 10000, 86400000, now)).toBe(1.0);
  });
});

describe('computeSkillBoost', () => {
  it('returns 0 when no skills provided', () => {
    expect(computeSkillBoost('some action', [])).toBe(0);
  });

  it('returns non-zero for matching skills', () => {
    const skills = [
      {
        id: 'sk-1',
        name: 'typescript error handling',
        description: 'Handle typescript errors',
        tags: ['typescript', 'error'],
        successRate: 0.9,
        confidence: 0.8,
        archived: false,
        pattern: '',
        preconditions: [],
        usageCount: 5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceProject: '',
        sourceFiles: [],
      },
    ];
    const boost = computeSkillBoost('typescript error handling pattern', skills as any);
    expect(boost).toBeGreaterThan(0);
  });

  it('skips archived skills', () => {
    const skills = [
      {
        id: 'sk-1',
        name: 'typescript patterns',
        description: 'ts patterns',
        tags: ['typescript'],
        successRate: 0.9,
        confidence: 0.8,
        archived: true,
        pattern: '',
        preconditions: [],
        usageCount: 5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceProject: '',
        sourceFiles: [],
      },
    ];
    expect(computeSkillBoost('typescript patterns', skills as any)).toBe(0);
  });
});

describe('ValueEstimator', () => {
  const estimator = new ValueEstimator();

  function makeNode(overrides: Partial<ActionTreeNode> = {}): ActionTreeNode {
    return {
      id: 'node-1',
      parentId: null,
      stateDescription: 'test state',
      action: 'test action',
      totalValue: 5,
      visitCount: 10,
      avgValue: 0.5,
      children: [],
      depth: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  it('returns Infinity UCB1 for unvisited nodes', () => {
    const node = makeNode({ visitCount: 0, avgValue: 0, totalValue: 0 });
    const est = estimator.estimateValue(node, 10);
    expect(est.ucb1Score).toBe(Infinity);
  });

  it('returns a finite score for visited nodes', () => {
    const node = makeNode();
    const est = estimator.estimateValue(node, 100);
    expect(est.ucb1Score).toBeGreaterThan(0);
    expect(isFinite(est.ucb1Score)).toBe(true);
  });

  it('rankChildren sorts by ucb1Score descending', () => {
    const nodes = [
      makeNode({ id: 'a', avgValue: 0.1, visitCount: 10, totalValue: 1 }),
      makeNode({ id: 'b', avgValue: 0.9, visitCount: 10, totalValue: 9 }),
      makeNode({ id: 'c', avgValue: 0.5, visitCount: 10, totalValue: 5 }),
    ];

    const ranked = estimator.rankChildren(nodes, 30);
    expect(ranked[0].nodeId).toBe('b'); // highest avg value
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].ucb1Score).toBeGreaterThanOrEqual(ranked[i].ucb1Score);
    }
  });

  it('puts unvisited nodes first in ranking', () => {
    const nodes = [
      makeNode({ id: 'visited', avgValue: 0.9, visitCount: 100, totalValue: 90 }),
      makeNode({ id: 'unvisited', avgValue: 0, visitCount: 0, totalValue: 0 }),
    ];

    const ranked = estimator.rankChildren(nodes, 100);
    expect(ranked[0].nodeId).toBe('unvisited');
    expect(ranked[0].ucb1Score).toBe(Infinity);
  });
});
