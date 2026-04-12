import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveExploration } from './adaptive-exploration.js';
import { ValueEstimator } from './value.js';

// Mock similarity and embeddings (required by ValueEstimator transitive imports)
vi.mock('../utils/similarity.js', () => ({
  jaccardSimilarity: vi.fn(() => 0),
}));

vi.mock('../utils/embeddings.js', () => ({
  extractKeywords: vi.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Mock FileStore
// ---------------------------------------------------------------------------

function createMockFileStore() {
  let storage: Record<string, unknown> = {};
  return {
    read: vi.fn(async (_collection: string, id: string) => {
      return storage[id] ?? null;
    }),
    write: vi.fn(async (_collection: string, id: string, data: unknown) => {
      storage[id] = data;
    }),
    delete: vi.fn(async (_collection: string, id: string) => {
      delete storage[id];
    }),
    list: vi.fn(async () => []),
    _storage: storage,
    _reset() {
      storage = {};
      this._storage = storage;
    },
  };
}

describe('AdaptiveExploration', () => {
  let mockFileStore: ReturnType<typeof createMockFileStore>;
  let explorer: AdaptiveExploration;

  beforeEach(() => {
    mockFileStore = createMockFileStore();
    explorer = new AdaptiveExploration({
      fileStore: mockFileStore as never,
      learningRate: 0.1,
      minConstant: 0.1,
      maxConstant: 3.0,
      decayRate: 0.995,
      minEpisodesForLearning: 5,
    });
  });

  // -------------------------------------------------------------------------
  // 1. Default constant
  // -------------------------------------------------------------------------

  it('returns Math.SQRT2 for unknown domain', () => {
    expect(explorer.getExplorationConstant('unknown')).toBe(Math.SQRT2);
  });

  // -------------------------------------------------------------------------
  // 2. Learning: constant increases when high exploration yields better rewards
  // -------------------------------------------------------------------------

  it('increases constant when high exploration yields better rewards', () => {
    const domain = 'refactoring';

    // Record 5 episodes: high exploration episodes get reward 0.9
    // low exploration episodes get reward 0.3
    // Use explorationLevel > SQRT2 for high, < SQRT2 for low
    for (let i = 0; i < 3; i++) {
      explorer.recordOutcome(domain, 0.9, Math.SQRT2 + 0.5); // high exploration
    }
    for (let i = 0; i < 3; i++) {
      explorer.recordOutcome(domain, 0.3, Math.SQRT2 - 0.5); // low exploration
    }

    const c = explorer.getExplorationConstant(domain);
    expect(c).toBeGreaterThan(Math.SQRT2);
  });

  // -------------------------------------------------------------------------
  // 3. Learning: constant decreases when low exploration yields better rewards
  // -------------------------------------------------------------------------

  it('decreases constant when low exploration yields better rewards', () => {
    const domain = 'testing';

    // Low exploration episodes get better rewards
    for (let i = 0; i < 3; i++) {
      explorer.recordOutcome(domain, 0.3, Math.SQRT2 + 0.5); // high exploration, bad reward
    }
    for (let i = 0; i < 3; i++) {
      explorer.recordOutcome(domain, 0.9, Math.SQRT2 - 0.5); // low exploration, good reward
    }

    const c = explorer.getExplorationConstant(domain);
    expect(c).toBeLessThan(Math.SQRT2);
  });

  // -------------------------------------------------------------------------
  // 4. Clamping: constant never goes below minConstant or above maxConstant
  // -------------------------------------------------------------------------

  it('clamps constant to [minConstant, maxConstant]', () => {
    const domain = 'clamping';

    // Push constant very high with extreme high-exploration rewards
    for (let i = 0; i < 100; i++) {
      explorer.recordOutcome(domain, 1.0, 10.0); // high exploration, max reward
      explorer.recordOutcome(domain, 0.0, 0.01); // low exploration, no reward
    }

    const stats = explorer.getDomainStats(domain);
    expect(stats).not.toBeNull();
    expect(stats!.explorationConstant).toBeLessThanOrEqual(3.0);
    expect(stats!.explorationConstant).toBeGreaterThanOrEqual(0.1);
  });

  // -------------------------------------------------------------------------
  // 5. Min episodes: doesn't adapt until minEpisodesForLearning reached
  // -------------------------------------------------------------------------

  it('does not adapt until minEpisodesForLearning episodes reached', () => {
    const domain = 'early';

    // Only 4 episodes (below minEpisodesForLearning = 5)
    for (let i = 0; i < 2; i++) {
      explorer.recordOutcome(domain, 0.9, Math.SQRT2 + 0.5);
    }
    for (let i = 0; i < 2; i++) {
      explorer.recordOutcome(domain, 0.1, Math.SQRT2 - 0.5);
    }

    // Should still return default because episodeCount = 4 < 5
    expect(explorer.getExplorationConstant(domain)).toBe(Math.SQRT2);
  });

  // -------------------------------------------------------------------------
  // 6. Decay: applyDecay reduces constant toward minConstant
  // -------------------------------------------------------------------------

  it('applyDecay reduces constant toward minConstant', () => {
    const domain = 'decaying';

    // Build up enough episodes for confidence > 0.5 (need > 25 episodes)
    for (let i = 0; i < 30; i++) {
      explorer.recordOutcome(domain, 0.5, Math.SQRT2 + 0.1);
    }

    const before = explorer.getDomainStats(domain)!.explorationConstant;
    explorer.applyDecay(domain);
    const after = explorer.getDomainStats(domain)!.explorationConstant;

    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(0.1);
  });

  // -------------------------------------------------------------------------
  // 7. Decay guard: decay doesn't apply when confidence < 0.5
  // -------------------------------------------------------------------------

  it('does not apply decay when confidence is below threshold', () => {
    const domain = 'low-confidence';

    // Only a few episodes — confidence will be < 0.5
    for (let i = 0; i < 5; i++) {
      explorer.recordOutcome(domain, 0.5, Math.SQRT2 + 0.1);
    }

    const stats = explorer.getDomainStats(domain)!;
    expect(stats.confidence).toBeLessThanOrEqual(0.5);

    const before = stats.explorationConstant;
    explorer.applyDecay(domain);
    const after = explorer.getDomainStats(domain)!.explorationConstant;

    expect(after).toBe(before);
  });

  // -------------------------------------------------------------------------
  // 8. Balance detection: identifies over-exploring domain
  // -------------------------------------------------------------------------

  it('identifies over-exploring domain', () => {
    const domain = 'over-exploring';

    // All episodes use high exploration levels
    for (let i = 0; i < 10; i++) {
      explorer.recordOutcome(domain, 0.5, Math.SQRT2 + 1.0);
    }

    const balance = explorer.getBalance();
    const domainBalance = balance.perDomain.find((d) => d.domain === domain);

    expect(domainBalance).toBeDefined();
    expect(domainBalance!.isOverExploring).toBe(true);
    expect(domainBalance!.explorationRatio).toBeGreaterThan(0.7);
  });

  // -------------------------------------------------------------------------
  // 9. Balance detection: identifies under-exploring domain
  // -------------------------------------------------------------------------

  it('identifies under-exploring domain', () => {
    const domain = 'under-exploring';

    // All episodes use low exploration levels
    for (let i = 0; i < 10; i++) {
      explorer.recordOutcome(domain, 0.5, Math.SQRT2 - 1.0);
    }

    const balance = explorer.getBalance();
    const domainBalance = balance.perDomain.find((d) => d.domain === domain);

    expect(domainBalance).toBeDefined();
    expect(domainBalance!.isUnderExploring).toBe(true);
    expect(domainBalance!.explorationRatio).toBeLessThan(0.1);
  });

  // -------------------------------------------------------------------------
  // 10. createEstimator: returns ValueEstimator with learned constant
  // -------------------------------------------------------------------------

  it('creates ValueEstimator with learned constant', () => {
    const domain = 'estimator-test';

    // Record enough episodes to learn a constant
    for (let i = 0; i < 3; i++) {
      explorer.recordOutcome(domain, 0.9, Math.SQRT2 + 0.5);
    }
    for (let i = 0; i < 3; i++) {
      explorer.recordOutcome(domain, 0.3, Math.SQRT2 - 0.5);
    }

    const estimator = explorer.createEstimator(domain);
    expect(estimator).toBeInstanceOf(ValueEstimator);

    // The estimator should use the learned constant, not the default
    // We can verify by checking UCB1 computation differs from default
    const learnedC = explorer.getExplorationConstant(domain);
    const defaultEstimator = new ValueEstimator();

    // UCB1 with learned constant vs default constant
    const learnedScore = estimator.computeUCB1(0.5, 100, 10);
    const defaultScore = defaultEstimator.computeUCB1(0.5, 100, 10);

    // Learned constant should be higher (high exploration was better)
    expect(learnedC).toBeGreaterThan(Math.SQRT2);
    expect(learnedScore).toBeGreaterThan(defaultScore);
  });

  // -------------------------------------------------------------------------
  // 11. Persistence: save and load round-trip preserves domain stats
  // -------------------------------------------------------------------------

  it('save and load round-trip preserves domain stats', async () => {
    const domain = 'persistent';

    // Record some data
    for (let i = 0; i < 6; i++) {
      explorer.recordOutcome(domain, 0.7, Math.SQRT2 + 0.2);
    }

    const statsBefore = explorer.getDomainStats(domain)!;
    await explorer.save();

    // Create a new instance with the same file store
    const explorer2 = new AdaptiveExploration({
      fileStore: mockFileStore as never,
      minEpisodesForLearning: 5,
    });

    await explorer2.load();

    const statsAfter = explorer2.getDomainStats(domain);
    expect(statsAfter).not.toBeNull();
    expect(statsAfter!.domain).toBe(statsBefore.domain);
    expect(statsAfter!.explorationConstant).toBe(statsBefore.explorationConstant);
    expect(statsAfter!.episodeCount).toBe(statsBefore.episodeCount);
    expect(statsAfter!.highExplorationCount).toBe(statsBefore.highExplorationCount);
    expect(statsAfter!.lowExplorationCount).toBe(statsBefore.lowExplorationCount);
    expect(statsAfter!.confidence).toBe(statsBefore.confidence);
  });

  // -------------------------------------------------------------------------
  // 12. getAllStats returns all tracked domains
  // -------------------------------------------------------------------------

  it('getAllStats returns all tracked domains', () => {
    explorer.recordOutcome('alpha', 0.5, 1.0);
    explorer.recordOutcome('beta', 0.6, 1.5);
    explorer.recordOutcome('gamma', 0.7, 2.0);

    const all = explorer.getAllStats();
    expect(all).toHaveLength(3);

    const domains = all.map((s) => s.domain).sort();
    expect(domains).toEqual(['alpha', 'beta', 'gamma']);
  });

  // -------------------------------------------------------------------------
  // 13. clear removes all learned data
  // -------------------------------------------------------------------------

  it('clear removes all learned data', async () => {
    explorer.recordOutcome('test-domain', 0.5, 1.0);
    expect(explorer.getAllStats()).toHaveLength(1);

    await explorer.clear();

    expect(explorer.getAllStats()).toHaveLength(0);
    expect(explorer.getDomainStats('test-domain')).toBeNull();
    expect(mockFileStore.delete).toHaveBeenCalledWith('adaptive-exploration', 'exploration-stats');
  });
});
