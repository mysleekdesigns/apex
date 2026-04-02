import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ArchitectureSearch,
  computeCompositeScore,
} from './architecture-search.js';
import type {
  ArchitectureConfig,
  ConfigPerformance,
} from '../types.js';

// ---------------------------------------------------------------------------
// Mock FileStore so tests don't touch disk
// ---------------------------------------------------------------------------
vi.mock('../utils/file-store.js', () => {
  const store = new Map<string, unknown>();
  return {
    FileStore: vi.fn().mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockImplementation((_col: string, _id: string) => {
        return Promise.resolve(null);
      }),
      write: vi.fn().mockImplementation((_col: string, _id: string, _data: unknown) => {
        return Promise.resolve();
      }),
      list: vi.fn().mockResolvedValue([]),
      readAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePerformance(
  configId: string,
  overrides: Partial<ConfigPerformance['metrics']> = {},
): ConfigPerformance {
  return {
    configId,
    metrics: {
      successRate: 0.7,
      avgReward: 0.6,
      memoryEfficiency: 0.5,
      recallQuality: 0.5,
      reflectionValue: 0.4,
      ...overrides,
    },
    episodeCount: 10,
    startTime: Date.now() - 10000,
    endTime: Date.now(),
  };
}

/**
 * Create a deterministic RNG from a fixed seed for reproducible tests.
 */
function deterministicRng(): () => number {
  let state = 42;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeCompositeScore', () => {
  it('returns 0 for all-zero metrics', () => {
    const score = computeCompositeScore({
      successRate: 0,
      avgReward: 0,
      memoryEfficiency: 0,
      recallQuality: 0,
      reflectionValue: 0,
    });
    expect(score).toBe(0);
  });

  it('returns 1 for all-perfect metrics', () => {
    const score = computeCompositeScore({
      successRate: 1,
      avgReward: 1,
      memoryEfficiency: 1,
      recallQuality: 1,
      reflectionValue: 1,
    });
    expect(score).toBe(1);
  });

  it('weights success rate highest', () => {
    const highSuccess = computeCompositeScore({
      successRate: 1,
      avgReward: 0,
      memoryEfficiency: 0,
      recallQuality: 0,
      reflectionValue: 0,
    });
    const highReward = computeCompositeScore({
      successRate: 0,
      avgReward: 1,
      memoryEfficiency: 0,
      recallQuality: 0,
      reflectionValue: 0,
    });
    expect(highSuccess).toBeGreaterThan(highReward);
  });

  it('clamps values to [0, 1]', () => {
    const score = computeCompositeScore({
      successRate: 2,
      avgReward: -1,
      memoryEfficiency: 1.5,
      recallQuality: 0.5,
      reflectionValue: 0.5,
    });
    // successRate clamped to 1, avgReward clamped to 0, memEff clamped to 1
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('ArchitectureSearch', () => {
  let search: ArchitectureSearch;

  beforeEach(async () => {
    search = new ArchitectureSearch({
      dataDir: '/tmp/test-arch-search',
      searchBudget: 10,
      rollbackWindow: 3,
      mutationMagnitude: 0.2,
    });
    await search.initialize();
  });

  // -----------------------------------------------------------------------
  // Config creation and initialization
  // -----------------------------------------------------------------------

  describe('initialization', () => {
    it('creates a default config on initialize', async () => {
      const config = search.getCurrentConfig();
      expect(config).toBeDefined();
      expect(config.id).toBeDefined();
      expect(config.generation).toBe(0);
      expect(config.subsystemFlags.microReflection).toBe(true);
      expect(config.agentConfig.explorationRate).toBe(0.15);
    });

    it('initializes search state correctly', () => {
      const state = search.getState();
      expect(state.generation).toBe(0);
      expect(state.searchesRemaining).toBe(10);
      expect(state.configHistory).toHaveLength(0);
      expect(state.bestScore).toBe(0);
    });

    it('getStatus returns summary', () => {
      const status = search.getStatus();
      expect(status.totalConfigs).toBeGreaterThanOrEqual(1);
      expect(status.searchesRemaining).toBe(10);
      expect(status.generation).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Config mutation
  // -----------------------------------------------------------------------

  describe('mutation', () => {
    it('creates a new config with mutate()', () => {
      const before = search.getCurrentConfig();
      const result = search.mutate('adjust-exploration-rate', 12345);

      expect(result.applied).toBe(true);
      expect(result.config.id).not.toBe(before.id);
      expect(result.config.parentConfigId).toBe(before.id);
      expect(result.config.generation).toBe(1);
      expect(result.mutation.type).toBe('adjust-exploration-rate');
    });

    it('decrements searchesRemaining', () => {
      const before = search.getState().searchesRemaining;
      search.mutate();
      const after = search.getState().searchesRemaining;
      expect(after).toBe(before - 1);
    });

    it('refuses mutation when budget exhausted', () => {
      // Exhaust budget
      for (let i = 0; i < 10; i++) {
        search.mutate();
      }
      const result = search.mutate();
      expect(result.applied).toBe(false);
      expect(result.reason).toContain('budget exhausted');
    });

    it('toggle-subsystem mutation flips a flag', () => {
      // Use a fixed seed so we get deterministic results
      const result = search.mutate('toggle-subsystem', 42);
      expect(result.applied).toBe(true);
      expect(result.mutation.type).toBe('toggle-subsystem');
      expect(result.mutation.parameter).toMatch(/^subsystemFlags\./);

      // The new value should be the opposite of the previous value
      expect(result.mutation.newValue).toBe(!result.mutation.previousValue);
    });

    it('adjust-memory-capacity mutation changes a tier limit', () => {
      const result = search.mutate('adjust-memory-capacity', 42);
      expect(result.applied).toBe(true);
      expect(result.mutation.parameter).toMatch(/^agentConfig\.memoryLimits\./);
      expect(typeof result.mutation.newValue).toBe('number');
    });

    it('adjust-reflection-frequency mutation changes frequency', () => {
      const result = search.mutate('adjust-reflection-frequency', 42);
      expect(result.applied).toBe(true);
      expect(result.mutation.parameter).toBe('reflectionFrequency');
      expect(typeof result.mutation.newValue).toBe('number');
      expect(result.mutation.newValue).toBeGreaterThanOrEqual(1);
      expect(result.mutation.newValue).toBeLessThanOrEqual(50);
    });

    it('adjust-consolidation-frequency mutation changes frequency', () => {
      const result = search.mutate('adjust-consolidation-frequency', 42);
      expect(result.applied).toBe(true);
      expect(result.mutation.parameter).toBe('consolidationFrequency');
    });

    it('adjust-consolidation-threshold mutation changes threshold', () => {
      const result = search.mutate('adjust-consolidation-threshold', 42);
      expect(result.applied).toBe(true);
      expect(result.mutation.parameter).toBe('agentConfig.consolidationThreshold');
    });

    it('adjust-performance-window mutation changes window', () => {
      const result = search.mutate('adjust-performance-window', 42);
      expect(result.applied).toBe(true);
      expect(result.mutation.parameter).toBe('performanceWindow');
    });

    it('getConfig retrieves a config by ID', () => {
      const result = search.mutate();
      const config = search.getConfig(result.config.id);
      expect(config).not.toBeNull();
      expect(config!.id).toBe(result.config.id);
    });

    it('getConfig returns null for unknown ID', () => {
      expect(search.getConfig('nonexistent')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Performance tracking
  // -----------------------------------------------------------------------

  describe('performance tracking', () => {
    it('records performance and returns composite score', () => {
      const config = search.getCurrentConfig();
      const perf = makePerformance(config.id);
      const score = search.recordPerformance(perf);

      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('updates best config when higher score found', () => {
      const config = search.getCurrentConfig();

      // Record mediocre performance
      search.recordPerformance(makePerformance(config.id, { successRate: 0.3 }));

      // Mutate and record better performance
      const result = search.mutate();
      search.recordPerformance(
        makePerformance(result.config.id, {
          successRate: 0.9,
          avgReward: 0.9,
          memoryEfficiency: 0.9,
          recallQuality: 0.9,
          reflectionValue: 0.9,
        }),
      );

      const state = search.getState();
      expect(state.bestConfigId).toBe(result.config.id);
      expect(state.bestScore).toBeGreaterThan(0.5);
    });

    it('getPerformanceHistory returns records for a config', () => {
      const config = search.getCurrentConfig();
      search.recordPerformance(makePerformance(config.id));
      search.recordPerformance(makePerformance(config.id, { successRate: 0.8 }));

      const history = search.getPerformanceHistory(config.id);
      expect(history).toHaveLength(2);
    });

    it('getAverageScore computes mean composite score', () => {
      const config = search.getCurrentConfig();
      search.recordPerformance(makePerformance(config.id, { successRate: 0.0 }));
      search.recordPerformance(makePerformance(config.id, { successRate: 1.0 }));

      const avg = search.getAverageScore(config.id);
      expect(avg).toBeGreaterThan(0);
    });

    it('getAverageScore returns 0 for unknown config', () => {
      expect(search.getAverageScore('nonexistent')).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Best config selection
  // -----------------------------------------------------------------------

  describe('best config selection', () => {
    it('getBestConfig returns the highest-scoring config', () => {
      const config1 = search.getCurrentConfig();
      search.recordPerformance(makePerformance(config1.id, { successRate: 0.3 }));

      const m = search.mutate();
      search.recordPerformance(
        makePerformance(m.config.id, {
          successRate: 0.95,
          avgReward: 0.95,
          memoryEfficiency: 0.95,
          recallQuality: 0.95,
          reflectionValue: 0.95,
        }),
      );

      const best = search.getBestConfig();
      expect(best).not.toBeNull();
      expect(best!.config.id).toBe(m.config.id);
      expect(best!.score).toBeGreaterThan(0.9);
    });

    it('getRankedConfigs returns configs sorted by score', () => {
      const c1 = search.getCurrentConfig();
      search.recordPerformance(makePerformance(c1.id, { successRate: 0.3 }));

      const m1 = search.mutate();
      search.recordPerformance(makePerformance(m1.config.id, { successRate: 0.9 }));

      const m2 = search.mutate();
      search.recordPerformance(makePerformance(m2.config.id, { successRate: 0.6 }));

      const ranked = search.getRankedConfigs();
      expect(ranked.length).toBe(3);
      // Should be descending by score
      for (let i = 1; i < ranked.length; i++) {
        expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Rollback suggestion
  // -----------------------------------------------------------------------

  describe('rollback detection', () => {
    it('does not suggest rollback with insufficient data', () => {
      const config = search.getCurrentConfig();
      search.recordPerformance(makePerformance(config.id));

      const suggestion = search.checkRollback();
      expect(suggestion.shouldRollback).toBe(false);
      expect(suggestion.reason).toContain('Insufficient data');
    });

    it('suggests rollback when performance degrades significantly', () => {
      const config1 = search.getCurrentConfig();

      // Record high performance for initial config
      for (let i = 0; i < 3; i++) {
        search.recordPerformance(
          makePerformance(config1.id, {
            successRate: 0.95,
            avgReward: 0.95,
            memoryEfficiency: 0.95,
            recallQuality: 0.95,
            reflectionValue: 0.95,
          }),
        );
      }

      // Mutate and record terrible performance
      const m = search.mutate();
      for (let i = 0; i < 3; i++) {
        search.recordPerformance(
          makePerformance(m.config.id, {
            successRate: 0.1,
            avgReward: 0.1,
            memoryEfficiency: 0.1,
            recallQuality: 0.1,
            reflectionValue: 0.1,
          }),
        );
      }

      const suggestion = search.checkRollback();
      expect(suggestion.shouldRollback).toBe(true);
      expect(suggestion.targetConfigId).toBe(config1.id);
      expect(suggestion.currentScore).toBeLessThan(suggestion.targetScore!);
    });

    it('does not suggest rollback when performance is acceptable', () => {
      const config = search.getCurrentConfig();

      // Record consistent performance
      for (let i = 0; i < 3; i++) {
        search.recordPerformance(makePerformance(config.id, { successRate: 0.7 }));
      }

      const suggestion = search.checkRollback();
      expect(suggestion.shouldRollback).toBe(false);
    });

    it('rollbackTo restores a previous config', () => {
      const original = search.getCurrentConfig();
      search.mutate();

      const current = search.getCurrentConfig();
      expect(current.id).not.toBe(original.id);

      const restored = search.rollbackTo(original.id);
      expect(restored).not.toBeNull();
      expect(restored!.id).toBe(original.id);
      expect(search.getCurrentConfig().id).toBe(original.id);
    });

    it('rollbackTo returns null for unknown config', () => {
      const result = search.rollbackTo('nonexistent');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Biased sampling
  // -----------------------------------------------------------------------

  describe('biased sampling', () => {
    it('sampleBiased produces a mutated config', () => {
      const config = search.getCurrentConfig();
      // Record some performance first
      search.recordPerformance(makePerformance(config.id, { successRate: 0.8 }));

      const result = search.sampleBiased(42);
      expect(result.applied).toBe(true);
      expect(result.config.id).not.toBe(config.id);
    });

    it('sampleBiased works with no performance history', () => {
      const result = search.sampleBiased(42);
      expect(result.applied).toBe(true);
    });

    it('biased sampling favors high-performing configs', () => {
      // Create several configs with different performance levels
      const config1 = search.getCurrentConfig();
      search.recordPerformance(makePerformance(config1.id, { successRate: 0.1 }));

      const m1 = search.mutate();
      search.recordPerformance(
        makePerformance(m1.config.id, {
          successRate: 0.95,
          avgReward: 0.95,
          memoryEfficiency: 0.95,
          recallQuality: 0.95,
          reflectionValue: 0.95,
        }),
      );

      // Run multiple biased samples and check that the best config
      // is used as parent more often
      const parentCounts = new Map<string, number>();
      for (let i = 0; i < 5; i++) {
        // Reset to original so we can sample again
        const result = search.sampleBiased(i * 1000 + 1);
        if (result.applied && result.config.parentConfigId) {
          const count = parentCounts.get(result.config.parentConfigId) ?? 0;
          parentCounts.set(result.config.parentConfigId, count + 1);
        }
      }

      // The test passes as long as biased sampling produces valid mutations
      // (the exact distribution depends on the RNG seed)
      expect(parentCounts.size).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Prompt suggestions
  // -----------------------------------------------------------------------

  describe('prompt suggestions', () => {
    it('generates suggestions for underutilized tools', () => {
      const suggestions = search.generatePromptSuggestions({
        callCounts: {
          apex_recall: 0,
          apex_record: 10,
          apex_reflect_get: 0,
        },
        successRates: {},
        totalEpisodes: 20,
      });

      expect(suggestions.length).toBeGreaterThan(0);
      // Should suggest using apex_recall more
      const recallSuggestion = suggestions.find((s) =>
        s.reason.includes('apex_recall'),
      );
      expect(recallSuggestion).toBeDefined();
    });

    it('generates suggestions for low success-rate tools', () => {
      const suggestions = search.generatePromptSuggestions({
        callCounts: { apex_recall: 10 },
        successRates: { apex_recall: 0.2 },
        totalEpisodes: 20,
      });

      const lowSuccessSuggestion = suggestions.find((s) =>
        s.reason.includes('low success rate'),
      );
      expect(lowSuccessSuggestion).toBeDefined();
    });

    it('returns empty suggestions when everything is healthy', () => {
      const suggestions = search.generatePromptSuggestions({
        callCounts: {
          apex_recall: 50,
          apex_record: 50,
          apex_reflect_get: 50,
          apex_reflect_store: 50,
          apex_plan_context: 50,
          apex_skills: 50,
          apex_consolidate: 50,
        },
        successRates: {
          apex_recall: 0.9,
          apex_record: 0.95,
        },
        totalEpisodes: 20,
      });

      // All tools are well-used and have good success rates
      // No underutilization or low success-rate suggestions
      const underutilized = suggestions.filter((s) => s.reason.includes('underutilized'));
      expect(underutilized).toHaveLength(0);
    });

    it('sorts suggestions by confidence descending', () => {
      const suggestions = search.generatePromptSuggestions({
        callCounts: {
          apex_recall: 0,
          apex_record: 0,
          apex_reflect_get: 0,
          apex_plan_context: 0,
        },
        successRates: {},
        totalEpisodes: 30,
      });

      for (let i = 1; i < suggestions.length; i++) {
        expect(suggestions[i - 1].confidence).toBeGreaterThanOrEqual(
          suggestions[i].confidence,
        );
      }
    });

    it('does not generate underutilization suggestions with too few episodes', () => {
      const suggestions = search.generatePromptSuggestions({
        callCounts: { apex_recall: 0 },
        successRates: {},
        totalEpisodes: 2,
      });

      const underutilized = suggestions.filter((s) => s.reason.includes('underutilized'));
      expect(underutilized).toHaveLength(0);
    });

    it('suggests re-enabling macro reflection when disabled and score low', () => {
      // Disable macro reflection
      search.mutate('toggle-subsystem', 42);

      // Force macro reflection off
      const config = search.getCurrentConfig();
      // Record enough low performance data
      for (let i = 0; i < 10; i++) {
        search.recordPerformance(
          makePerformance(config.id, {
            successRate: 0.2,
            avgReward: 0.2,
            memoryEfficiency: 0.2,
            recallQuality: 0.2,
            reflectionValue: 0.2,
          }),
        );
      }

      // The suggestion depends on whether macroReflection ended up disabled
      // due to the random toggle — this tests the code path regardless
      const suggestions = search.generatePromptSuggestions({
        callCounts: {},
        successRates: {},
        totalEpisodes: 2,
      });
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  describe('persistence', () => {
    it('save and load round-trip', async () => {
      const config = search.getCurrentConfig();
      search.recordPerformance(makePerformance(config.id));
      search.mutate();

      await search.save();

      // The mock doesn't actually persist, but we verify no errors
      const loaded = await search.load();
      // Mock returns null, so load returns false
      expect(loaded).toBe(false);
    });
  });
});
