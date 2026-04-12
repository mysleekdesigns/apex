import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SelfModifier } from './self-modify.js';
import { generateId } from '../types.js';
import type { BenchmarkResult, DimensionScore } from './self-benchmark.js';
import type { ModificationProposal, ModificationResult } from './self-modify.js';

// ---------------------------------------------------------------------------
// Mock FileStore
// ---------------------------------------------------------------------------

function createMockFileStore() {
  const store = new Map<string, Map<string, unknown>>();

  return {
    init: vi.fn(async () => {}),
    write: vi.fn(async (collection: string, id: string, data: unknown) => {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(id, data);
    }),
    read: vi.fn(async (collection: string, id: string) => {
      return store.get(collection)?.get(id) ?? null;
    }),
    readAll: vi.fn(async (collection: string) => {
      const col = store.get(collection);
      if (!col) return [];
      return [...col.values()];
    }),
    list: vi.fn(async (collection: string) => {
      const col = store.get(collection);
      if (!col) return [];
      return [...col.keys()];
    }),
    delete: vi.fn(async (collection: string, id: string) => {
      store.get(collection)?.delete(id);
    }),
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeDimensionScore(dimension: string, score: number): DimensionScore {
  return {
    dimension,
    score,
    details: `Score for ${dimension}`,
    sampleSize: 10,
  };
}

function makeBenchmarkResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    id: generateId(),
    timestamp: Date.now(),
    generation: 1,
    dimensionScores: [
      makeDimensionScore('recall-accuracy', 0.7),
      makeDimensionScore('reflection-quality', 0.7),
      makeDimensionScore('skill-reuse-rate', 0.7),
      makeDimensionScore('planning-effectiveness', 0.7),
      makeDimensionScore('consolidation-efficiency', 0.7),
    ],
    compositeScore: 0.7,
    configSnapshot: {},
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ModificationProposal> = {}): ModificationProposal {
  return {
    id: generateId(),
    type: 'config',
    target: 'memoryLimits.episodic',
    currentValue: 1000,
    proposedValue: 1200,
    expectedImpact: 10,
    rationale: 'Increase episodic memory',
    weakDimension: 'recall-accuracy',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeModificationResult(overrides: Partial<ModificationResult> = {}): ModificationResult {
  return {
    id: generateId(),
    proposalId: generateId(),
    applied: true,
    baselineScore: 0.5,
    postScore: 0.6,
    improvement: 20,
    dimensionDeltas: [
      { dimension: 'recall-accuracy', delta: 10 },
      { dimension: 'reflection-quality', delta: 5 },
    ],
    rolledBack: false,
    reason: 'Accepted',
    timestamp: Date.now(),
    ...overrides,
  };
}

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SelfModifier', () => {
  let fileStore: ReturnType<typeof createMockFileStore>;
  let modifier: SelfModifier;

  beforeEach(() => {
    vi.clearAllMocks();
    fileStore = createMockFileStore();
    modifier = new SelfModifier({
      fileStore: fileStore as any,
      logger: mockLogger,
    });
  });

  // -------------------------------------------------------------------------
  // 1. analyzeWeakSpots with all strong dimensions returns no proposals
  // -------------------------------------------------------------------------
  it('analyzeWeakSpots returns no proposals when all dimensions > 0.6', async () => {
    const result = makeBenchmarkResult({
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.8),
        makeDimensionScore('reflection-quality', 0.75),
        makeDimensionScore('skill-reuse-rate', 0.7),
        makeDimensionScore('planning-effectiveness', 0.65),
        makeDimensionScore('consolidation-efficiency', 0.7),
      ],
    });

    const proposals = await modifier.analyzeWeakSpots(result);
    expect(proposals).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. analyzeWeakSpots with weak recall proposes memory limit increase
  // -------------------------------------------------------------------------
  it('analyzeWeakSpots with weak recall proposes memory limit increase', async () => {
    const result = makeBenchmarkResult({
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.3),
        makeDimensionScore('reflection-quality', 0.8),
        makeDimensionScore('skill-reuse-rate', 0.8),
        makeDimensionScore('planning-effectiveness', 0.8),
        makeDimensionScore('consolidation-efficiency', 0.8),
      ],
      configSnapshot: { memoryLimits: { episodic: 1000 } },
    });

    const proposals = await modifier.analyzeWeakSpots(result);

    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const recallProposal = proposals.find((p) => p.weakDimension === 'recall-accuracy');
    expect(recallProposal).toBeDefined();
    expect(recallProposal!.target).toBe('memoryLimits.episodic');
    expect(recallProposal!.proposedValue).toBe(1200); // 1000 * 1.2
    expect(recallProposal!.type).toBe('config');
  });

  // -------------------------------------------------------------------------
  // 3. analyzeWeakSpots with weak planning proposes exploration rate decrease
  // -------------------------------------------------------------------------
  it('analyzeWeakSpots with weak planning proposes exploration rate decrease', async () => {
    const result = makeBenchmarkResult({
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.8),
        makeDimensionScore('reflection-quality', 0.8),
        makeDimensionScore('skill-reuse-rate', 0.8),
        makeDimensionScore('planning-effectiveness', 0.4),
        makeDimensionScore('consolidation-efficiency', 0.8),
      ],
      configSnapshot: { explorationRate: 0.3 },
    });

    const proposals = await modifier.analyzeWeakSpots(result);

    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const planProposal = proposals.find((p) => p.weakDimension === 'planning-effectiveness');
    expect(planProposal).toBeDefined();
    expect(planProposal!.target).toBe('explorationRate');
    expect(planProposal!.proposedValue).toBe(0.25); // 0.3 - 0.05
    expect(planProposal!.type).toBe('parameter');
  });

  // -------------------------------------------------------------------------
  // 4. analyzeWeakSpots respects maxProposalsPerRound
  // -------------------------------------------------------------------------
  it('analyzeWeakSpots respects maxProposalsPerRound', async () => {
    const limitedModifier = new SelfModifier({
      fileStore: fileStore as any,
      logger: mockLogger,
      maxProposalsPerRound: 1,
    });

    const result = makeBenchmarkResult({
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.2),
        makeDimensionScore('reflection-quality', 0.2),
        makeDimensionScore('skill-reuse-rate', 0.2),
        makeDimensionScore('planning-effectiveness', 0.2),
        makeDimensionScore('consolidation-efficiency', 0.2),
      ],
    });

    const proposals = await limitedModifier.analyzeWeakSpots(result);
    expect(proposals).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 5. analyzeWeakSpots persists proposals to FileStore
  // -------------------------------------------------------------------------
  it('analyzeWeakSpots persists proposals to FileStore', async () => {
    const result = makeBenchmarkResult({
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.3),
        makeDimensionScore('reflection-quality', 0.8),
        makeDimensionScore('skill-reuse-rate', 0.8),
        makeDimensionScore('planning-effectiveness', 0.8),
        makeDimensionScore('consolidation-efficiency', 0.8),
      ],
    });

    const proposals = await modifier.analyzeWeakSpots(result);

    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) {
      expect(fileStore.write).toHaveBeenCalledWith(
        'modification-proposals',
        proposal.id,
        expect.objectContaining({ id: proposal.id }),
      );
    }
  });

  // -------------------------------------------------------------------------
  // 6. evaluateProposal accepts good improvement
  // -------------------------------------------------------------------------
  it('evaluateProposal accepts when improvement >= 5% and no degradation', async () => {
    const proposal = makeProposal();

    const baseline = makeBenchmarkResult({
      compositeScore: 0.5,
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.5),
        makeDimensionScore('reflection-quality', 0.5),
        makeDimensionScore('skill-reuse-rate', 0.5),
        makeDimensionScore('planning-effectiveness', 0.5),
        makeDimensionScore('consolidation-efficiency', 0.5),
      ],
    });

    const candidate = makeBenchmarkResult({
      compositeScore: 0.6,
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.6),
        makeDimensionScore('reflection-quality', 0.6),
        makeDimensionScore('skill-reuse-rate', 0.6),
        makeDimensionScore('planning-effectiveness', 0.6),
        makeDimensionScore('consolidation-efficiency', 0.6),
      ],
    });

    const result = await modifier.evaluateProposal(proposal, baseline, candidate);

    expect(result.applied).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.improvement).toBeCloseTo(20, 5); // (0.6 - 0.5) / 0.5 * 100
    expect(result.proposalId).toBe(proposal.id);
  });

  // -------------------------------------------------------------------------
  // 7. evaluateProposal rejects insufficient improvement
  // -------------------------------------------------------------------------
  it('evaluateProposal rejects when improvement < 5%', async () => {
    const proposal = makeProposal();

    const baseline = makeBenchmarkResult({
      compositeScore: 0.50,
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.50),
        makeDimensionScore('reflection-quality', 0.50),
        makeDimensionScore('skill-reuse-rate', 0.50),
        makeDimensionScore('planning-effectiveness', 0.50),
        makeDimensionScore('consolidation-efficiency', 0.50),
      ],
    });

    const candidate = makeBenchmarkResult({
      compositeScore: 0.51,
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.51),
        makeDimensionScore('reflection-quality', 0.51),
        makeDimensionScore('skill-reuse-rate', 0.51),
        makeDimensionScore('planning-effectiveness', 0.51),
        makeDimensionScore('consolidation-efficiency', 0.51),
      ],
    });

    const result = await modifier.evaluateProposal(proposal, baseline, candidate);

    expect(result.applied).toBe(false);
    expect(result.rolledBack).toBe(true);
    // 2% improvement is below the 5% threshold
    expect(result.improvement).toBeCloseTo(2, 5);
    expect(result.reason).toContain('below threshold');
  });

  // -------------------------------------------------------------------------
  // 8. evaluateProposal rejects with dimension degradation > 2%
  // -------------------------------------------------------------------------
  it('evaluateProposal rejects when any dimension degrades > 2%', async () => {
    const proposal = makeProposal();

    const baseline = makeBenchmarkResult({
      compositeScore: 0.50,
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.50),
        makeDimensionScore('reflection-quality', 0.80),
        makeDimensionScore('skill-reuse-rate', 0.50),
        makeDimensionScore('planning-effectiveness', 0.50),
        makeDimensionScore('consolidation-efficiency', 0.50),
      ],
    });

    // Overall improvement is big enough, but reflection-quality drops significantly
    const candidate = makeBenchmarkResult({
      compositeScore: 0.56,
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.70),
        makeDimensionScore('reflection-quality', 0.60), // -25% degradation
        makeDimensionScore('skill-reuse-rate', 0.55),
        makeDimensionScore('planning-effectiveness', 0.55),
        makeDimensionScore('consolidation-efficiency', 0.55),
      ],
    });

    const result = await modifier.evaluateProposal(proposal, baseline, candidate);

    expect(result.applied).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.reason).toContain('degradation');
  });

  // -------------------------------------------------------------------------
  // 9. evaluateProposal persists result to FileStore
  // -------------------------------------------------------------------------
  it('evaluateProposal persists result to FileStore', async () => {
    const proposal = makeProposal();
    const baseline = makeBenchmarkResult({ compositeScore: 0.5 });
    const candidate = makeBenchmarkResult({ compositeScore: 0.6 });

    const result = await modifier.evaluateProposal(proposal, baseline, candidate);

    expect(fileStore.write).toHaveBeenCalledWith(
      'self-modifications',
      result.id,
      expect.objectContaining({ id: result.id, proposalId: proposal.id }),
    );
  });

  // -------------------------------------------------------------------------
  // 10. getProposalHistory returns sorted proposals
  // -------------------------------------------------------------------------
  it('getProposalHistory returns proposals sorted by timestamp descending', async () => {
    // Seed proposals via analyzeWeakSpots on weak benchmark
    const result1 = makeBenchmarkResult({
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.3),
        makeDimensionScore('reflection-quality', 0.8),
        makeDimensionScore('skill-reuse-rate', 0.8),
        makeDimensionScore('planning-effectiveness', 0.8),
        makeDimensionScore('consolidation-efficiency', 0.8),
      ],
    });
    await modifier.analyzeWeakSpots(result1);

    const history = await modifier.getProposalHistory();
    expect(history.length).toBeGreaterThan(0);

    for (let i = 1; i < history.length; i++) {
      expect(history[i - 1].timestamp).toBeGreaterThanOrEqual(history[i].timestamp);
    }
  });

  // -------------------------------------------------------------------------
  // 11. getModificationHistory returns sorted results
  // -------------------------------------------------------------------------
  it('getModificationHistory returns results sorted by timestamp descending', async () => {
    const proposal = makeProposal();
    const baseline = makeBenchmarkResult({ compositeScore: 0.5 });
    const candidate = makeBenchmarkResult({ compositeScore: 0.6 });

    await modifier.evaluateProposal(proposal, baseline, candidate);
    await modifier.evaluateProposal(makeProposal(), baseline, candidate);

    const history = await modifier.getModificationHistory();
    expect(history).toHaveLength(2);

    for (let i = 1; i < history.length; i++) {
      expect(history[i - 1].timestamp).toBeGreaterThanOrEqual(history[i].timestamp);
    }
  });

  // -------------------------------------------------------------------------
  // 12. autoRollbackCheck triggers rollback when > 10% worse than best
  // -------------------------------------------------------------------------
  it('autoRollbackCheck triggers rollback when > 10% degradation and enough episodes', async () => {
    const bestResult = makeBenchmarkResult({ compositeScore: 0.8 });
    const currentResult = makeBenchmarkResult({ compositeScore: 0.6 }); // 25% degradation

    const decision = await modifier.autoRollbackCheck(currentResult, bestResult, 15);

    expect(decision.shouldRollback).toBe(true);
    expect(decision.degradation).toBeCloseTo(25, 0);
    expect(decision.currentScore).toBe(0.6);
    expect(decision.bestScore).toBe(0.8);
    expect(decision.reason).toContain('auto-rollback recommended');
  });

  // -------------------------------------------------------------------------
  // 13. autoRollbackCheck no rollback when performance is OK
  // -------------------------------------------------------------------------
  it('autoRollbackCheck does not rollback when performance is within range', async () => {
    const bestResult = makeBenchmarkResult({ compositeScore: 0.8 });
    const currentResult = makeBenchmarkResult({ compositeScore: 0.78 }); // 2.5% degradation

    const decision = await modifier.autoRollbackCheck(currentResult, bestResult, 15);

    expect(decision.shouldRollback).toBe(false);
    expect(decision.reason).toContain('within acceptable range');
  });

  // -------------------------------------------------------------------------
  // 14. autoRollbackCheck respects rollbackWindow
  // -------------------------------------------------------------------------
  it('autoRollbackCheck does not trigger if episodesSinceLast < rollbackWindow', async () => {
    const bestResult = makeBenchmarkResult({ compositeScore: 0.8 });
    const currentResult = makeBenchmarkResult({ compositeScore: 0.5 }); // 37.5% degradation

    // Default rollbackWindow is 10, pass only 5 episodes
    const decision = await modifier.autoRollbackCheck(currentResult, bestResult, 5);

    expect(decision.shouldRollback).toBe(false);
    expect(decision.episodesSinceLast).toBe(5);
    expect(decision.reason).toContain('waiting');
  });

  // -------------------------------------------------------------------------
  // 15. getStats aggregates correctly
  // -------------------------------------------------------------------------
  it('getStats computes correct totals and averages', async () => {
    // Seed some proposals
    const weakResult = makeBenchmarkResult({
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.2),
        makeDimensionScore('reflection-quality', 0.8),
        makeDimensionScore('skill-reuse-rate', 0.8),
        makeDimensionScore('planning-effectiveness', 0.8),
        makeDimensionScore('consolidation-efficiency', 0.8),
      ],
    });
    const proposals = await modifier.analyzeWeakSpots(weakResult);

    // Evaluate: one accepted, one rejected
    const baseline = makeBenchmarkResult({
      compositeScore: 0.5,
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.5),
        makeDimensionScore('reflection-quality', 0.5),
        makeDimensionScore('skill-reuse-rate', 0.5),
        makeDimensionScore('planning-effectiveness', 0.5),
        makeDimensionScore('consolidation-efficiency', 0.5),
      ],
    });

    const goodCandidate = makeBenchmarkResult({
      compositeScore: 0.6,
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.6),
        makeDimensionScore('reflection-quality', 0.6),
        makeDimensionScore('skill-reuse-rate', 0.6),
        makeDimensionScore('planning-effectiveness', 0.6),
        makeDimensionScore('consolidation-efficiency', 0.6),
      ],
    });

    const badCandidate = makeBenchmarkResult({
      compositeScore: 0.51,
      dimensionScores: [
        makeDimensionScore('recall-accuracy', 0.51),
        makeDimensionScore('reflection-quality', 0.51),
        makeDimensionScore('skill-reuse-rate', 0.51),
        makeDimensionScore('planning-effectiveness', 0.51),
        makeDimensionScore('consolidation-efficiency', 0.51),
      ],
    });

    const p1 = proposals[0] ?? makeProposal();
    await modifier.evaluateProposal(p1, baseline, goodCandidate); // accepted: 20% improvement
    await modifier.evaluateProposal(makeProposal(), baseline, badCandidate); // rejected: 2% improvement

    const stats = await modifier.getStats();

    expect(stats.totalProposals).toBeGreaterThanOrEqual(1);
    expect(stats.totalApplied).toBe(1);
    expect(stats.totalRolledBack).toBe(1);
    expect(stats.avgImprovement).toBeCloseTo(20, 5); // only applied results count
    expect(stats.successRate).toBe(0.5); // 1 applied out of 2 total
  });
});
