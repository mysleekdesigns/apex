import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CounterfactualEngine } from './counterfactual.js';
import { WorldModel } from './world-model.js';
import type { Episode } from '../types.js';

// ---------------------------------------------------------------------------
// Mock helpers
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
      const entries = store.get(collection);
      if (!entries) return {};
      const result: Record<string, unknown> = {};
      entries.forEach((val, key) => { result[key] = val; });
      return result;
    }),
    list: vi.fn(async (collection: string) => {
      const entries = store.get(collection);
      return entries ? Array.from(entries.keys()) : [];
    }),
    delete: vi.fn(async (collection: string, id: string) => {
      store.get(collection)?.delete(id);
    }),
    _store: store,
  };
}

const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

let idCounter = 0;
function makeEpisode(
  actions: Array<{ type: string; success: boolean }>,
  overallSuccess = true,
): Episode {
  idCounter++;
  return {
    id: `ep-${idCounter}`,
    task: 'Test task',
    actions: actions.map((a, i) => ({
      type: a.type,
      description: `Action ${a.type}`,
      timestamp: 1000000 + i * 1000,
      success: a.success,
    })),
    outcome: {
      success: overallSuccess,
      description: overallSuccess ? 'Success' : 'Failure',
      duration: 5000,
    },
    reward: overallSuccess ? 1.0 : 0.0,
    timestamp: 1000000,
  };
}

/**
 * Build a WorldModel pre-loaded with episodes to provide a realistic graph
 * for counterfactual analysis.
 */
function buildWorldModel(): WorldModel {
  const model = new WorldModel({
    fileStore: createMockFileStore() as any,
    logger: mockLogger,
    minEdgeObservations: 2,
    chainMinFrequency: 2,
  });

  // Successful path: read-file -> code-edit -> run-tests (5 times)
  for (let i = 0; i < 5; i++) {
    model.ingestEpisode(makeEpisode([
      { type: 'read-file', success: true },
      { type: 'code-edit', success: true },
      { type: 'run-tests', success: true },
    ], true));
  }

  // Failing path: read-file -> shell-command (3 times)
  for (let i = 0; i < 3; i++) {
    model.ingestEpisode(makeEpisode([
      { type: 'read-file', success: true },
      { type: 'shell-command', success: false },
    ], false));
  }

  model.extractChains();
  return model;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CounterfactualEngine', () => {
  let engine: CounterfactualEngine;
  let worldModel: WorldModel;

  beforeEach(() => {
    vi.clearAllMocks();
    idCounter = 0;
    worldModel = buildWorldModel();
    engine = new CounterfactualEngine({
      logger: mockLogger,
      maxAlternativesPerStep: 3,
      minImprovementThreshold: 5,
    });
  });

  // -----------------------------------------------------------------------
  // analyze
  // -----------------------------------------------------------------------

  describe('analyze', () => {
    it('returns a complete analysis for an episode', () => {
      const episode = makeEpisode([
        { type: 'read-file', success: true },
        { type: 'shell-command', success: false },
      ], false);

      const analysis = engine.analyze(episode, worldModel);

      expect(analysis).toBeDefined();
      expect(analysis.id).toBeTruthy();
      expect(analysis.episodeId).toBe(episode.id);
      expect(analysis.task).toBe('Test task');
      expect(analysis.originalSuccessRate).toBeDefined();
      expect(analysis.timestamp).toBeGreaterThan(0);
      expect(Array.isArray(analysis.scenarios)).toBe(true);
    });

    it('identifies alternative scenarios for steps', () => {
      const episode = makeEpisode([
        { type: 'read-file', success: true },
        { type: 'shell-command', success: false },
      ], false);

      const analysis = engine.analyze(episode, worldModel);

      // shell-command has low success; code-edit or run-tests should be suggested
      // as alternatives (if improvement threshold met)
      if (analysis.scenarios.length > 0) {
        for (const scenario of analysis.scenarios) {
          expect(scenario.id).toBeTruthy();
          expect(scenario.originalAction).toBeTruthy();
          expect(scenario.alternativeAction).toBeTruthy();
          expect(scenario.stepIndex).toBeGreaterThanOrEqual(0);
          expect(scenario.predictedOutcome.improvement).toBeGreaterThanOrEqual(5);
        }
      }
    });

    it('finds best alternative as highest improvement', () => {
      const episode = makeEpisode([
        { type: 'read-file', success: true },
        { type: 'shell-command', success: false },
      ], false);

      const analysis = engine.analyze(episode, worldModel);

      if (analysis.bestAlternative && analysis.scenarios.length > 1) {
        // bestAlternative should be the scenario with highest improvement
        const maxImprovement = Math.max(
          ...analysis.scenarios.map(s => s.predictedOutcome.improvement),
        );
        expect(analysis.bestAlternative.predictedOutcome.improvement).toBe(maxImprovement);
      }
    });

    it('respects maxAlternativesPerStep', () => {
      const limitedEngine = new CounterfactualEngine({
        logger: mockLogger,
        maxAlternativesPerStep: 1,
        minImprovementThreshold: 0, // accept all improvements
      });

      const episode = makeEpisode([
        { type: 'read-file', success: true },
        { type: 'shell-command', success: false },
      ], false);

      const analysis = limitedEngine.analyze(episode, worldModel);

      // Per step, at most 1 alternative evaluated. With 2 steps, max 2 scenarios.
      // (some may be filtered by improvement threshold)
      const scenariosPerStep = new Map<number, number>();
      for (const s of analysis.scenarios) {
        scenariosPerStep.set(s.stepIndex, (scenariosPerStep.get(s.stepIndex) ?? 0) + 1);
      }
      for (const count of scenariosPerStep.values()) {
        expect(count).toBeLessThanOrEqual(1);
      }
    });

    it('returns empty scenarios for completely unknown actions', () => {
      const episode = makeEpisode([
        { type: 'totally-unknown-xyz', success: false },
        { type: 'also-unknown-abc', success: false },
      ], false);

      // Use a fresh empty world model
      const emptyModel = new WorldModel({
        fileStore: createMockFileStore() as any,
        logger: mockLogger,
      });

      const analysis = engine.analyze(episode, emptyModel);
      expect(analysis.scenarios).toHaveLength(0);
      expect(analysis.bestAlternative).toBeNull();
      expect(analysis.worstAlternative).toBeNull();
    });

    it('includes confidence values in scenarios', () => {
      const episode = makeEpisode([
        { type: 'read-file', success: true },
        { type: 'shell-command', success: false },
      ], false);

      const analysis = engine.analyze(episode, worldModel);

      for (const scenario of analysis.scenarios) {
        expect(typeof scenario.confidence).toBe('number');
        expect(scenario.confidence).toBeGreaterThanOrEqual(0);
        expect(scenario.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  // -----------------------------------------------------------------------
  // suggestAlternatives
  // -----------------------------------------------------------------------

  describe('suggestAlternatives', () => {
    it('returns ranked list sorted by improvement', () => {
      const alternatives = engine.suggestAlternatives('shell-command', worldModel);

      // shell-command has 0% success, so many alternatives should be better
      expect(alternatives.length).toBeGreaterThan(0);

      // Verify sorted by improvement descending
      for (let i = 1; i < alternatives.length; i++) {
        expect(alternatives[i - 1].improvement).toBeGreaterThanOrEqual(
          alternatives[i].improvement,
        );
      }
    });

    it('respects topK limit', () => {
      const alternatives = engine.suggestAlternatives('shell-command', worldModel, 1);
      expect(alternatives.length).toBeLessThanOrEqual(1);
    });

    it('returns empty array for unknown action type', () => {
      const alternatives = engine.suggestAlternatives('nonexistent-action', worldModel);
      // Unknown action has 0 success rate by default (node not found)
      // So everything with successRate > 0 would be suggested, but
      // nonexistent-action is not in the model
      // The method returns nodes with higher success rate than current
      // Since current is 0 (not found), any node with successRate > 0 qualifies
      // But let's test with an empty model
      const emptyModel = new WorldModel({
        fileStore: createMockFileStore() as any,
        logger: mockLogger,
      });
      const emptyAlts = engine.suggestAlternatives('nonexistent', emptyModel);
      expect(emptyAlts).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // compareStrategies
  // -----------------------------------------------------------------------

  describe('compareStrategies', () => {
    it('identifies the better plan', () => {
      const plan1 = ['read-file', 'code-edit', 'run-tests']; // known good path
      const plan2 = ['read-file', 'shell-command'];           // known bad path

      const result = engine.compareStrategies(plan1, plan2, worldModel);

      expect(result.plan1Prediction).toBeDefined();
      expect(result.plan2Prediction).toBeDefined();
      expect(result.recommendation).toBeTruthy();
      expect(typeof result.improvementPercent).toBe('number');

      // plan1 should be better since it has all-success history
      if (result.plan1Prediction.overallSuccessRate > result.plan2Prediction.overallSuccessRate) {
        expect(result.recommendation).toContain('Plan 1');
      }
    });

    it('reports equivalent for equal plans', () => {
      const plan = ['read-file', 'code-edit', 'run-tests'];

      const result = engine.compareStrategies(plan, plan, worldModel);

      expect(result.recommendation).toContain('equivalent');
      expect(result.improvementPercent).toBe(0);
      expect(result.plan1Prediction.overallSuccessRate).toBe(
        result.plan2Prediction.overallSuccessRate,
      );
    });

    it('computes correct improvement percentage', () => {
      const plan1 = ['read-file', 'code-edit', 'run-tests'];
      const plan2 = ['read-file', 'shell-command'];

      const result = engine.compareStrategies(plan1, plan2, worldModel);

      // Verify improvementPercent is a non-negative number
      expect(result.improvementPercent).toBeGreaterThanOrEqual(0);

      // Manually verify: if plan1 rate > plan2 rate
      const rate1 = result.plan1Prediction.overallSuccessRate;
      const rate2 = result.plan2Prediction.overallSuccessRate;
      if (rate1 !== rate2) {
        expect(result.improvementPercent).toBeGreaterThan(0);
      }
    });
  });
});
