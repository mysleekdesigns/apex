import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptOptimizer } from './prompt-optimizer.js';
import type { MutationRecord, OptimizationRound } from './prompt-optimizer.js';

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
    delete: vi.fn(async () => {}),
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromptOptimizer', () => {
  let fileStore: ReturnType<typeof createMockFileStore>;
  let optimizer: PromptOptimizer;

  beforeEach(async () => {
    fileStore = createMockFileStore();
    optimizer = new PromptOptimizer({
      fileStore: fileStore as never,
      mutationRate: 1.0, // Always mutate for deterministic tests
      maxMutationsPerRound: 3,
    });
    await optimizer.init();
  });

  it('proposeMutations generates mutations for low-performing module', () => {
    const mutations = optimizer.proposeMutations({
      moduleName: 'test-module',
      currentText: 'You should use this tool to check the output',
      currentMetrics: { successRate: 0.3, avgReward: 0.2, exposures: 2 },
    });

    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.length).toBeLessThanOrEqual(3);
    for (const m of mutations) {
      expect(m.moduleName).toBe('test-module');
      expect(m.expectedImpact).toBeGreaterThan(0);
      expect(m.actualImpact).toBeNull();
      expect(m.applied).toBe(false);
    }
  });

  it('applyMutation rephrase swaps synonyms', () => {
    const result = optimizer.applyMutation('You should use this tool', 'rephrase');
    // "should" -> "must" or "use" -> "utilize"
    expect(result).not.toBe('You should use this tool');
    expect(
      result.includes('must') ||
      result.includes('utilize') ||
      result.includes('Must') ||
      result.includes('Utilize'),
    ).toBe(true);
  });

  it('applyMutation simplify removes parentheticals and adverbs', () => {
    const text = 'This is really very important (trust me) and actually works extremely well';
    const result = optimizer.applyMutation(text, 'simplify');
    expect(result).not.toContain('(trust me)');
    expect(result).not.toMatch(/\breally\b/i);
    expect(result).not.toMatch(/\bvery\b/i);
    expect(result).not.toMatch(/\bactually\b/i);
    expect(result).not.toMatch(/\bextremely\b/i);
  });

  it('applyMutation elaborate adds explanation for short text', () => {
    const text = 'Run the tests first.';
    const result = optimizer.applyMutation(text, 'elaborate');
    expect(result).toContain('In other words,');
    expect(result).toContain('run the tests first');
  });

  it('applyMutation adjust-emphasis adds importance markers', () => {
    const text = 'Always validate input before processing.';
    const result = optimizer.applyMutation(text, 'adjust-emphasis');
    expect(result).toContain('Important:');
  });

  it('recordMutationOutcome updates getMutationStats', async () => {
    const mutations = optimizer.proposeMutations({
      moduleName: 'stats-test',
      currentText: 'You should check the output carefully',
      currentMetrics: { successRate: 0.5, avgReward: 0.5, exposures: 10 },
    });

    expect(mutations.length).toBeGreaterThan(0);
    const first = mutations[0];

    await optimizer.recordMutationOutcome(first.id, 0.15);

    const stats = optimizer.getMutationStats();
    const typeStat = stats[first.mutationType];
    expect(typeStat.count).toBeGreaterThanOrEqual(1);
    // The recorded mutation had positive impact, so successRate > 0
    expect(typeStat.successRate).toBeGreaterThan(0);
  });

  it('runOptimizationRound produces ranked proposals', async () => {
    const round = await optimizer.runOptimizationRound([
      {
        name: 'module-a',
        content: 'You should use this tool to create output',
        metrics: { successRate: 0.4, avgReward: 0.3, exposures: 5 },
      },
      {
        name: 'module-b',
        content: 'Check the results and verify correctness',
        metrics: { successRate: 0.8, avgReward: 0.7, exposures: 20 },
      },
    ]);

    expect(round.id).toBeDefined();
    expect(round.baselineScore).toBeCloseTo(0.6, 1);
    expect(round.mutations.length).toBeGreaterThan(0);
    expect(round.postScore).toBeNull();
    expect(round.improvement).toBeNull();
  });

  it('getSuggestions returns PromptSuggestion-compatible objects', () => {
    optimizer.proposeMutations({
      moduleName: 'suggest-test',
      currentText: 'You should use this tool carefully',
      currentMetrics: { successRate: 0.5, avgReward: 0.5, exposures: 10 },
    });

    const suggestions = optimizer.getSuggestions();
    expect(suggestions.length).toBeGreaterThan(0);

    for (const s of suggestions) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('section');
      expect(s).toHaveProperty('currentText');
      expect(s).toHaveProperty('suggestedText');
      expect(s).toHaveProperty('reason');
      expect(s).toHaveProperty('expectedImpact');
      expect(s).toHaveProperty('confidence');
      expect(s).toHaveProperty('timestamp');
      expect(typeof s.confidence).toBe('number');
      expect(typeof s.timestamp).toBe('number');
    }
  });
});
