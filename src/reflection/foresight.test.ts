import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForesightEngine, type ForesightEngineOptions } from './foresight.js';
import type { Outcome, ForesightPrediction } from '../types.js';

// ---------------------------------------------------------------------------
// Mock FileStore
// ---------------------------------------------------------------------------

function createMockFileStore() {
  const store = new Map<string, unknown>();
  return {
    read: vi.fn(async (_col: string, key: string) => store.get(key) ?? null),
    write: vi.fn(async (_col: string, key: string, data: unknown) => {
      store.set(key, data);
    }),
    readAll: vi.fn(async (_col: string) => [...store.values()]),
    delete: vi.fn(async (_col: string, key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => [...store.keys()]),
    init: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEngine(
  mockStore: ReturnType<typeof createMockFileStore>,
  overrides?: Partial<ForesightEngineOptions>,
): ForesightEngine {
  return new ForesightEngine({
    fileStore: mockStore as any,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ForesightEngine', () => {
  let mockStore: ReturnType<typeof createMockFileStore>;
  let engine: ForesightEngine;

  beforeEach(() => {
    mockStore = createMockFileStore();
    engine = buildEngine(mockStore);
  });

  // ── predict ─────────────────────────────────────────────────────

  describe('predict', () => {
    it('creates a prediction with the given parameters', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 10_000,
        expectedSteps: 5,
        riskFactors: ['timeout'],
        confidence: 0.8,
      });

      expect(prediction.id).toBeDefined();
      expect(prediction.taskId).toBe('task-1');
      expect(prediction.predictedOutcome.success).toBe(true);
      expect(prediction.predictedOutcome.expectedDuration).toBe(10_000);
      expect(prediction.predictedOutcome.expectedSteps).toBe(5);
      expect(prediction.predictedOutcome.riskFactors).toEqual(['timeout']);
      expect(prediction.predictedOutcome.confidence).toBe(0.8);
      expect(prediction.adaptationSignals).toEqual([]);
      expect(prediction.timestamp).toBeGreaterThan(0);
    });

    it('persists the prediction to the file store', async () => {
      const prediction = await engine.predict({
        taskId: 'task-2',
        predictedSuccess: false,
        expectedDuration: 5000,
        expectedSteps: 3,
      });

      expect(mockStore.write).toHaveBeenCalledWith(
        'foresight-predictions',
        prediction.id,
        expect.objectContaining({ taskId: 'task-2' }),
      );
    });

    it('clamps confidence to [0, 1]', async () => {
      const p1 = await engine.predict({
        taskId: 'task-a',
        predictedSuccess: true,
        expectedDuration: 1000,
        expectedSteps: 1,
        confidence: 1.5,
      });
      expect(p1.predictedOutcome.confidence).toBe(1);

      const p2 = await engine.predict({
        taskId: 'task-b',
        predictedSuccess: true,
        expectedDuration: 1000,
        expectedSteps: 1,
        confidence: -0.3,
      });
      expect(p2.predictedOutcome.confidence).toBe(0);
    });

    it('defaults confidence to 0.5 if omitted', async () => {
      const prediction = await engine.predict({
        taskId: 'task-c',
        predictedSuccess: true,
        expectedDuration: 1000,
        expectedSteps: 1,
      });
      expect(prediction.predictedOutcome.confidence).toBe(0.5);
    });

    it('defaults riskFactors to empty array', async () => {
      const prediction = await engine.predict({
        taskId: 'task-d',
        predictedSuccess: true,
        expectedDuration: 1000,
        expectedSteps: 1,
      });
      expect(prediction.predictedOutcome.riskFactors).toEqual([]);
    });
  });

  // ── check (adaptation signals) ─────────────────────────────────

  describe('check', () => {
    it('returns "continue" when execution is on track', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 10_000,
        expectedSteps: 5,
      });

      const signal = await engine.check({
        predictionId: prediction.id,
        stepIndex: 0,
        stepSuccess: true,
        elapsedMs: 2000,
        completedSteps: 1,
      });

      expect(signal.recommendation).toBe('continue');
      expect(signal.divergenceScore).toBeLessThan(0.3);
      expect(signal.stepIndex).toBe(0);
      expect(signal.timestamp).toBeGreaterThan(0);
    });

    it('returns "adjust" when moderately diverging', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 10_000,
        expectedSteps: 5,
      });

      // Running 3x slower than expected
      const signal = await engine.check({
        predictionId: prediction.id,
        stepIndex: 0,
        stepSuccess: true,
        elapsedMs: 6000,
        completedSteps: 1,
      });

      expect(signal.divergenceScore).toBeGreaterThanOrEqual(0.3);
      expect(['adjust', 'reflect']).toContain(signal.recommendation);
    });

    it('returns high divergence when step fails during expected success', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 10_000,
        expectedSteps: 5,
      });

      const signal = await engine.check({
        predictionId: prediction.id,
        stepIndex: 2,
        stepSuccess: false,
        elapsedMs: 4000,
        completedSteps: 3,
      });

      expect(signal.divergenceScore).toBeGreaterThanOrEqual(0.3);
      expect(signal.reason).toContain('failed');
    });

    it('returns high divergence when exceeding expected steps', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 10_000,
        expectedSteps: 3,
      });

      const signal = await engine.check({
        predictionId: prediction.id,
        stepIndex: 5,
        stepSuccess: true,
        elapsedMs: 8000,
        completedSteps: 6,
      });

      expect(signal.divergenceScore).toBeGreaterThan(0.3);
    });

    it('appends the signal to the prediction', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 10_000,
        expectedSteps: 5,
      });

      await engine.check({
        predictionId: prediction.id,
        stepIndex: 0,
        stepSuccess: true,
        elapsedMs: 2000,
        completedSteps: 1,
      });

      await engine.check({
        predictionId: prediction.id,
        stepIndex: 1,
        stepSuccess: true,
        elapsedMs: 4000,
        completedSteps: 2,
      });

      const stored = await engine.getPrediction(prediction.id);
      expect(stored!.adaptationSignals).toHaveLength(2);
      expect(stored!.adaptationSignals[0].stepIndex).toBe(0);
      expect(stored!.adaptationSignals[1].stepIndex).toBe(1);
    });

    it('throws for unknown prediction ID', async () => {
      await expect(
        engine.check({
          predictionId: 'nonexistent',
          stepIndex: 0,
          stepSuccess: true,
          elapsedMs: 1000,
          completedSteps: 1,
        }),
      ).rejects.toThrow('Prediction not found: nonexistent');
    });
  });

  // ── resolve (surprise score) ───────────────────────────────────

  describe('resolve', () => {
    it('calculates surprise score 0 when prediction matches perfectly', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 10_000,
        expectedSteps: 5,
      });

      const result = await engine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: true,
          description: 'Completed successfully',
          duration: 10_000,
        },
      });

      expect(result.prediction.surpriseScore).toBe(0);
      expect(result.surpriseTriggered).toBe(false);
      expect(result.breakdown.successMismatch).toBe(0);
      expect(result.breakdown.durationDeviation).toBe(0);
    });

    it('calculates high surprise when success prediction is wrong', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 10_000,
        expectedSteps: 5,
      });

      const result = await engine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: false,
          description: 'Failed with type error',
          errorType: 'type-error',
          duration: 10_000,
        },
      });

      // Success mismatch alone is 0.4, plus error type mismatch 0.15
      expect(result.prediction.surpriseScore!).toBeGreaterThanOrEqual(0.5);
      expect(result.surpriseTriggered).toBe(true);
      expect(result.breakdown.successMismatch).toBe(0.4);
      expect(result.breakdown.errorTypeMismatch).toBe(0.15);
    });

    it('calculates complete mismatch with max surprise', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 1000,
        expectedSteps: 2,
      });

      // Add a check signal so step count deviation is measured
      await engine.check({
        predictionId: prediction.id,
        stepIndex: 0,
        stepSuccess: true,
        elapsedMs: 500,
        completedSteps: 1,
      });
      await engine.check({
        predictionId: prediction.id,
        stepIndex: 1,
        stepSuccess: true,
        elapsedMs: 1000,
        completedSteps: 2,
      });
      await engine.check({
        predictionId: prediction.id,
        stepIndex: 2,
        stepSuccess: false,
        elapsedMs: 5000,
        completedSteps: 3,
      });
      await engine.check({
        predictionId: prediction.id,
        stepIndex: 3,
        stepSuccess: false,
        elapsedMs: 10_000,
        completedSteps: 4,
      });

      const result = await engine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: false,
          description: 'Complete failure',
          errorType: 'unknown-error',
          duration: 10_000,
        },
      });

      // Should have high surprise: success mismatch + duration + error + step deviation
      expect(result.prediction.surpriseScore!).toBeGreaterThan(0.7);
      expect(result.surpriseTriggered).toBe(true);
    });

    it('records low surprise when failure was predicted and risk was known', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: false,
        expectedDuration: 5000,
        expectedSteps: 3,
        riskFactors: ['timeout', 'network-error'],
      });

      const result = await engine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: false,
          description: 'Network error occurred',
          errorType: 'network-error',
          duration: 5000,
        },
      });

      expect(result.prediction.surpriseScore!).toBeLessThan(0.3);
      expect(result.surpriseTriggered).toBe(false);
      expect(result.breakdown.successMismatch).toBe(0);
      expect(result.breakdown.errorTypeMismatch).toBe(0);
    });

    it('persists the resolved prediction with actual outcome', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 10_000,
        expectedSteps: 5,
      });

      await engine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: true,
          description: 'Done',
          duration: 10_000,
        },
      });

      const stored = await engine.getPrediction(prediction.id);
      expect(stored!.actualOutcome).toBeDefined();
      expect(stored!.surpriseScore).toBeDefined();
    });

    it('throws for unknown prediction ID', async () => {
      await expect(
        engine.resolve({
          predictionId: 'nonexistent',
          actualOutcome: {
            success: true,
            description: 'Done',
            duration: 1000,
          },
        }),
      ).rejects.toThrow('Prediction not found: nonexistent');
    });

    it('invokes onSurpriseTriggered callback when surprise exceeds threshold', async () => {
      const onSurprise = vi.fn(async () => {});
      const customEngine = buildEngine(mockStore, {
        surpriseThreshold: 0.3,
        onSurpriseTriggered: onSurprise,
      });

      const prediction = await customEngine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 1000,
        expectedSteps: 1,
      });

      await customEngine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: false,
          description: 'Failed',
          errorType: 'type-error',
          duration: 50_000,
        },
      });

      expect(onSurprise).toHaveBeenCalledWith(prediction.id, expect.any(Number));
    });

    it('does NOT invoke onSurpriseTriggered when surprise is below threshold', async () => {
      const onSurprise = vi.fn(async () => {});
      const customEngine = buildEngine(mockStore, {
        surpriseThreshold: 0.5,
        onSurpriseTriggered: onSurprise,
      });

      const prediction = await customEngine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 10_000,
        expectedSteps: 5,
      });

      await customEngine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: true,
          description: 'Done',
          duration: 10_000,
        },
      });

      expect(onSurprise).not.toHaveBeenCalled();
    });
  });

  // ── Duration deviation ─────────────────────────────────────────

  describe('duration deviation', () => {
    it('produces moderate surprise for 2x duration', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 5000,
        expectedSteps: 5,
      });

      const result = await engine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: true,
          description: 'Done but slow',
          duration: 10_000,
        },
      });

      // Duration deviation: |10000/5000 - 1| = 1.0, capped at 1.0 -> 0.2 weight
      expect(result.breakdown.durationDeviation).toBe(0.2);
    });

    it('produces zero duration deviation for exact match', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 5000,
        expectedSteps: 5,
      });

      const result = await engine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: true,
          description: 'Done',
          duration: 5000,
        },
      });

      expect(result.breakdown.durationDeviation).toBe(0);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles zero expected steps gracefully', async () => {
      const prediction = await engine.predict({
        taskId: 'task-0',
        predictedSuccess: true,
        expectedDuration: 1000,
        expectedSteps: 0,
      });

      const result = await engine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: true,
          description: 'Instant',
          duration: 100,
        },
      });

      // Should not throw or produce NaN
      expect(result.prediction.surpriseScore).toBeDefined();
      expect(Number.isNaN(result.prediction.surpriseScore)).toBe(false);
    });

    it('handles zero expected duration gracefully', async () => {
      const prediction = await engine.predict({
        taskId: 'task-0',
        predictedSuccess: true,
        expectedDuration: 0,
        expectedSteps: 3,
      });

      const result = await engine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: true,
          description: 'Done',
          duration: 5000,
        },
      });

      expect(result.prediction.surpriseScore).toBeDefined();
      expect(Number.isNaN(result.prediction.surpriseScore)).toBe(false);
    });

    it('handles missing errorType in actual outcome', async () => {
      const prediction = await engine.predict({
        taskId: 'task-1',
        predictedSuccess: false,
        expectedDuration: 5000,
        expectedSteps: 3,
        riskFactors: ['timeout'],
      });

      const result = await engine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: false,
          description: 'Failed silently',
          duration: 5000,
        },
      });

      // No errorType -> errorTypeMismatch should be 0
      expect(result.breakdown.errorTypeMismatch).toBe(0);
      expect(result.surpriseTriggered).toBe(false);
    });

    it('retrieves predictions for a specific task', async () => {
      await engine.predict({
        taskId: 'task-A',
        predictedSuccess: true,
        expectedDuration: 1000,
        expectedSteps: 1,
      });
      await engine.predict({
        taskId: 'task-B',
        predictedSuccess: false,
        expectedDuration: 2000,
        expectedSteps: 2,
      });
      await engine.predict({
        taskId: 'task-A',
        predictedSuccess: true,
        expectedDuration: 3000,
        expectedSteps: 3,
      });

      const taskAPredictions = await engine.getPredictionsForTask('task-A');
      expect(taskAPredictions).toHaveLength(2);
      expect(taskAPredictions.every((p) => p.taskId === 'task-A')).toBe(true);
      // Should be sorted by timestamp descending
      expect(taskAPredictions[0].timestamp).toBeGreaterThanOrEqual(taskAPredictions[1].timestamp);
    });
  });

  // ── Configurable threshold ─────────────────────────────────────

  describe('configurable threshold', () => {
    it('uses custom surprise threshold', async () => {
      const sensitiveEngine = buildEngine(mockStore, { surpriseThreshold: 0.1 });

      const prediction = await sensitiveEngine.predict({
        taskId: 'task-1',
        predictedSuccess: true,
        expectedDuration: 5000,
        expectedSteps: 5,
      });

      const result = await sensitiveEngine.resolve({
        predictionId: prediction.id,
        actualOutcome: {
          success: true,
          description: 'Done but slow',
          duration: 10_000,  // 2x expected -> duration deviation = 0.2
        },
      });

      // With threshold 0.1, a score of 0.2 should trigger
      expect(result.surpriseTriggered).toBe(true);
    });
  });
});
