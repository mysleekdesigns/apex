import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SelfBenchmark } from './self-benchmark.js';
import { generateId } from '../types.js';
import type { Episode, Reflection, Skill } from '../types.js';

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

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: generateId(),
    task: 'A meaningful test task description',
    actions: [
      { type: 'code_edit', description: 'Edit file', timestamp: Date.now(), success: true },
    ],
    outcome: { success: true, description: 'Completed', duration: 5000 },
    reward: 0.8,
    timestamp: Date.now(),
    embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    ...overrides,
  };
}

function makeReflection(overrides: Partial<Reflection> = {}): Reflection {
  return {
    id: generateId(),
    level: 'micro',
    content: 'This approach worked well because of X',
    errorTypes: [],
    actionableInsights: ['Use approach X for similar tasks'],
    sourceEpisodes: ['ep-1'],
    timestamp: Date.now(),
    confidence: 0.8,
    ...overrides,
  };
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: generateId(),
    name: 'test-skill',
    description: 'A test skill',
    preconditions: ['has-tests'],
    pattern: 'Run tests first, then refactor',
    successRate: 0.9,
    usageCount: 10,
    confidence: 0.85,
    sourceProject: 'test-project',
    sourceFiles: ['src/index.ts'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags: ['testing'],
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

describe('SelfBenchmark', () => {
  let fileStore: ReturnType<typeof createMockFileStore>;
  let benchmark: SelfBenchmark;

  beforeEach(() => {
    vi.clearAllMocks();
    fileStore = createMockFileStore();
    benchmark = new SelfBenchmark({
      fileStore: fileStore as any,
      logger: mockLogger,
    });
  });

  // -------------------------------------------------------------------------
  // 1. getDimensions returns 5 dimensions with weights summing to 1.0
  // -------------------------------------------------------------------------
  it('getDimensions returns 5 dimensions with weights summing to 1.0', () => {
    const dims = benchmark.getDimensions();
    expect(dims).toHaveLength(5);

    const weightSum = dims.reduce((sum, d) => sum + d.weight, 0);
    expect(weightSum).toBeCloseTo(1.0, 10);

    for (const dim of dims) {
      expect(dim.name).toBeTruthy();
      expect(dim.description).toBeTruthy();
      expect(dim.weight).toBeGreaterThan(0);
      expect(dim.weight).toBeLessThanOrEqual(1);
    }
  });

  // -------------------------------------------------------------------------
  // 2. runSuite with empty data returns scores of 0
  // -------------------------------------------------------------------------
  it('runSuite with empty data returns scores of 0', async () => {
    const result = await benchmark.runSuite([], [], [], {});

    expect(result.compositeScore).toBe(0);
    for (const ds of result.dimensionScores) {
      expect(ds.score).toBe(0);
      expect(ds.sampleSize).toBe(0);
    }
    expect(result.generation).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3. runSuite with good data produces high scores
  // -------------------------------------------------------------------------
  it('runSuite with good data produces high scores', async () => {
    const episodes = Array.from({ length: 10 }, () =>
      makeEpisode({
        outcome: { success: true, description: 'Done', duration: 3000 },
        reward: 0.9,
        embedding: [0.1, 0.2, 0.3],
      }),
    );
    const reflections = Array.from({ length: 5 }, () =>
      makeReflection({ confidence: 0.9, actionableInsights: ['Insight A', 'Insight B'] }),
    );
    const skills = Array.from({ length: 3 }, () =>
      makeSkill({ successRate: 0.95, usageCount: 20 }),
    );

    const result = await benchmark.runSuite(episodes, reflections, skills, {});

    expect(result.compositeScore).toBeGreaterThan(0.7);
    for (const ds of result.dimensionScores) {
      expect(ds.score).toBeGreaterThan(0.5);
    }
  });

  // -------------------------------------------------------------------------
  // 4. runSuite with mixed data produces moderate scores
  // -------------------------------------------------------------------------
  it('runSuite with mixed data produces moderate scores', async () => {
    const episodes = [
      makeEpisode({ outcome: { success: true, description: 'OK', duration: 1000 }, reward: 0.9, embedding: [0.1] }),
      makeEpisode({ outcome: { success: false, description: 'Failed', errorType: 'test', duration: 2000 }, reward: 0.2, embedding: undefined }),
      makeEpisode({ outcome: { success: true, description: 'OK', duration: 1000 }, reward: 0.3, embedding: [0.5] }),
      makeEpisode({ outcome: { success: false, description: 'Failed', errorType: 'test', duration: 2000 }, reward: 0.1, embedding: undefined }),
    ];
    const reflections = [
      makeReflection({ confidence: 0.9, actionableInsights: ['Good insight'] }),
      makeReflection({ confidence: 0.3, actionableInsights: [] }),
    ];
    const skills = [
      makeSkill({ successRate: 0.9, usageCount: 10 }),
      makeSkill({ successRate: 0.3, usageCount: 5 }),
    ];

    const result = await benchmark.runSuite(episodes, reflections, skills, {});

    expect(result.compositeScore).toBeGreaterThan(0.2);
    expect(result.compositeScore).toBeLessThan(0.8);
  });

  // -------------------------------------------------------------------------
  // 5. runSuite compositeScore is a weighted sum of dimension scores
  // -------------------------------------------------------------------------
  it('runSuite compositeScore is a weighted sum of dimension scores', async () => {
    const episodes = Array.from({ length: 5 }, () => makeEpisode());
    const reflections = [makeReflection()];
    const skills = [makeSkill()];

    const result = await benchmark.runSuite(episodes, reflections, skills, {});

    const dims = benchmark.getDimensions();
    let expectedComposite = 0;
    for (const dim of dims) {
      const ds = result.dimensionScores.find((s) => s.dimension === dim.name);
      expectedComposite += (ds?.score ?? 0) * dim.weight;
    }
    expectedComposite = Math.round(expectedComposite * 10000) / 10000;

    expect(result.compositeScore).toBe(expectedComposite);
  });

  // -------------------------------------------------------------------------
  // 6. runSuite persists result to FileStore
  // -------------------------------------------------------------------------
  it('runSuite persists result to FileStore', async () => {
    const result = await benchmark.runSuite([makeEpisode()], [], [], {});

    expect(fileStore.write).toHaveBeenCalledWith(
      'self-benchmark',
      result.id,
      expect.objectContaining({ id: result.id, compositeScore: expect.any(Number) }),
    );
  });

  // -------------------------------------------------------------------------
  // 7. runSuite increments generation
  // -------------------------------------------------------------------------
  it('runSuite increments generation with each run', async () => {
    const r1 = await benchmark.runSuite([], [], [], {});
    expect(r1.generation).toBe(1);

    const r2 = await benchmark.runSuite([], [], [], {});
    expect(r2.generation).toBe(2);

    const r3 = await benchmark.runSuite([], [], [], {});
    expect(r3.generation).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 8. getHistory returns results sorted by timestamp descending
  // -------------------------------------------------------------------------
  it('getHistory returns results sorted by timestamp descending', async () => {
    // Run three suites with slight delays to ensure different timestamps
    const r1 = await benchmark.runSuite([], [], [], {});
    const r2 = await benchmark.runSuite([], [], [], {});
    const r3 = await benchmark.runSuite([], [], [], {});

    const history = await benchmark.getHistory();

    expect(history).toHaveLength(3);
    // Newest first
    expect(history[0].timestamp).toBeGreaterThanOrEqual(history[1].timestamp);
    expect(history[1].timestamp).toBeGreaterThanOrEqual(history[2].timestamp);
  });

  // -------------------------------------------------------------------------
  // 9. getHistory with no data returns empty array
  // -------------------------------------------------------------------------
  it('getHistory with no data returns empty array', async () => {
    const history = await benchmark.getHistory();
    expect(history).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 10. getLatest returns most recent result
  // -------------------------------------------------------------------------
  it('getLatest returns most recent result', async () => {
    const r1 = await benchmark.runSuite([], [], [], {});

    // Manually adjust timestamp so r1 is clearly older
    const storedR1 = await fileStore.read('self-benchmark', r1.id) as any;
    storedR1.timestamp = Date.now() - 10000;
    await fileStore.write('self-benchmark', r1.id, storedR1);

    const r2 = await benchmark.runSuite([makeEpisode()], [], [], { v: 2 });

    const latest = await benchmark.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(r2.id);
  });

  // -------------------------------------------------------------------------
  // 11. getLatest with no data returns null
  // -------------------------------------------------------------------------
  it('getLatest with no data returns null', async () => {
    const latest = await benchmark.getLatest();
    expect(latest).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 12. compareBenchmarks correct improvement and dimension deltas
  // -------------------------------------------------------------------------
  it('compareBenchmarks computes correct improvement and dimension deltas', async () => {
    // Baseline: low scores (empty data)
    const baseline = await benchmark.runSuite([], [], [], {});

    // Candidate: good data
    const candidate = await benchmark.runSuite(
      Array.from({ length: 10 }, () => makeEpisode()),
      [makeReflection()],
      [makeSkill()],
      {},
    );

    const comparison = await benchmark.compareBenchmarks(baseline.id, candidate.id);

    expect(comparison.baselineId).toBe(baseline.id);
    expect(comparison.candidateId).toBe(candidate.id);
    expect(comparison.baselineScore).toBe(baseline.compositeScore);
    expect(comparison.candidateScore).toBe(candidate.compositeScore);
    // Candidate should be better than empty baseline
    expect(comparison.improvement).toBeGreaterThanOrEqual(0);
    expect(comparison.dimensionDeltas).toHaveLength(5);
  });

  // -------------------------------------------------------------------------
  // 13. compareBenchmarks degradation detection
  // -------------------------------------------------------------------------
  it('compareBenchmarks flags dimension degradation > 2%', async () => {
    // Create a good baseline
    const baseline = await benchmark.runSuite(
      Array.from({ length: 10 }, () => makeEpisode()),
      Array.from({ length: 5 }, () => makeReflection()),
      Array.from({ length: 3 }, () => makeSkill()),
      {},
    );

    // Create a worse candidate (no data = zero scores)
    const candidate = await benchmark.runSuite([], [], [], {});

    const comparison = await benchmark.compareBenchmarks(baseline.id, candidate.id);

    expect(comparison.anyDimensionDegraded).toBe(true);
    expect(comparison.maxDegradation).toBeGreaterThan(2);

    const degradedDims = comparison.dimensionDeltas.filter((d) => d.degraded);
    expect(degradedDims.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 14. seedSyntheticData generates correct count with varied data
  // -------------------------------------------------------------------------
  it('seedSyntheticData generates correct count with varied data', async () => {
    const episodes = await benchmark.seedSyntheticData(20);

    expect(episodes).toHaveLength(20);

    // Each episode has required fields
    for (const ep of episodes) {
      expect(ep.id).toBeTruthy();
      expect(ep.task).toBeTruthy();
      expect(ep.actions.length).toBeGreaterThanOrEqual(2);
      expect(ep.outcome).toBeDefined();
      expect(typeof ep.reward).toBe('number');
      expect(ep.metadata?.synthetic).toBe(true);
    }

    // Domains should cycle across the 5 synthetic domains
    const domains = new Set(episodes.map((e) => (e.metadata as any).domain));
    expect(domains.size).toBe(5);

    // Should have a mix of successes and failures (deterministic ~70% success)
    const successes = episodes.filter((e) => e.outcome.success).length;
    expect(successes).toBeGreaterThan(0);
    expect(successes).toBeLessThan(episodes.length);
  });

  // -------------------------------------------------------------------------
  // 15. maxHistory pruning removes oldest results
  // -------------------------------------------------------------------------
  it('maxHistory pruning removes oldest results when exceeding limit', async () => {
    const smallBenchmark = new SelfBenchmark({
      fileStore: fileStore as any,
      logger: mockLogger,
      maxHistory: 3,
    });

    // Run 5 suites — should prune down to 3
    await smallBenchmark.runSuite([], [], [], {});
    await smallBenchmark.runSuite([], [], [], {});
    await smallBenchmark.runSuite([], [], [], {});
    await smallBenchmark.runSuite([], [], [], {});
    await smallBenchmark.runSuite([], [], [], {});

    // fileStore.delete should have been called for pruned entries
    expect(fileStore.delete).toHaveBeenCalled();

    const history = await smallBenchmark.getHistory();
    expect(history.length).toBeLessThanOrEqual(3);
  });
});
