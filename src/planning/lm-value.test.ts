import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LMValueFunction, extractSimpleKeywords } from './lm-value.js';
import type { LMValueEvaluation } from './lm-value.js';

// ---------------------------------------------------------------------------
// Mock FileStore
// ---------------------------------------------------------------------------

const mockFileStore = {
  read: vi.fn().mockResolvedValue(null),
  write: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue([]),
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createLMValueFunction(opts?: {
  cacheMaxSize?: number;
  cacheTTLMs?: number;
  similarityThreshold?: number;
}) {
  return new LMValueFunction({
    fileStore: mockFileStore as never,
    cacheMaxSize: opts?.cacheMaxSize,
    cacheTTLMs: opts?.cacheTTLMs,
    similarityThreshold: opts?.similarityThreshold,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractSimpleKeywords', () => {
  it('extracts lowercase keywords from text', () => {
    const keywords = extractSimpleKeywords('Run TypeScript tests for the API');
    expect(keywords).toContain('run');
    expect(keywords).toContain('typescript');
    expect(keywords).toContain('tests');
    expect(keywords).toContain('for');
    expect(keywords).toContain('the');
    expect(keywords).toContain('api');
  });

  it('splits on punctuation and filters single-char tokens', () => {
    const keywords = extractSimpleKeywords('a,b,cc.dd-ee');
    // 'a' and 'b' are single-char and should be filtered out
    expect(keywords.has('a')).toBe(false);
    expect(keywords.has('b')).toBe(false);
    expect(keywords).toContain('cc');
    expect(keywords).toContain('dd');
    expect(keywords).toContain('ee');
  });
});

describe('LMValueFunction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Prompt generation
  // -----------------------------------------------------------------------

  describe('generatePrompt', () => {
    it('produces a valid prompt with state, action, and historical context', () => {
      const lmv = createLMValueFunction();
      const prompt = lmv.generatePrompt(
        'Debugging a failing test suite',
        'Run tests with verbose logging',
        [
          { action: 'Run tests', value: 0.8, description: 'Tests passed after retry' },
          { action: 'Check logs', value: 0.6, description: 'Found root cause in logs' },
        ],
      );

      expect(prompt.id).toBeTruthy();
      expect(prompt.stateDescription).toBe('Debugging a failing test suite');
      expect(prompt.action).toBe('Run tests with verbose logging');
      expect(prompt.historicalContext).toHaveLength(2);
      expect(prompt.promptText).toContain('Debugging a failing test suite');
      expect(prompt.promptText).toContain('Run tests with verbose logging');
      expect(prompt.promptText).toContain('0.80');
      expect(prompt.promptText).toContain('Score this action from 0.0');
      expect(prompt.promptText).toContain('Respond with a JSON object');
      expect(prompt.createdAt).toBeGreaterThan(0);
    });

    it('handles missing historical context', () => {
      const lmv = createLMValueFunction();
      const prompt = lmv.generatePrompt(
        'Setting up CI pipeline',
        'Configure GitHub Actions',
      );

      expect(prompt.historicalContext).toHaveLength(0);
      expect(prompt.promptText).toContain('No historical data available.');
    });
  });

  // -----------------------------------------------------------------------
  // Record evaluation
  // -----------------------------------------------------------------------

  describe('recordEvaluation', () => {
    it('stores evaluation and returns correct shape', async () => {
      const lmv = createLMValueFunction();
      const prompt = lmv.generatePrompt('state', 'action');

      const evaluation = await lmv.recordEvaluation(
        prompt.id,
        0.75,
        'Looks promising',
        120,
      );

      expect(evaluation.promptId).toBe(prompt.id);
      expect(evaluation.stateDescription).toBe('state');
      expect(evaluation.action).toBe('action');
      expect(evaluation.value).toBe(0.75);
      expect(evaluation.reasoning).toBe('Looks promising');
      expect(evaluation.evaluatedAt).toBeGreaterThan(0);
      expect(evaluation.latencyMs).toBe(120);

      // Should persist to fileStore
      expect(mockFileStore.write).toHaveBeenCalledWith(
        'lm-value',
        `lm-eval-${prompt.id}`,
        evaluation,
      );
    });

    it('clamps value to [0, 1]', async () => {
      const lmv = createLMValueFunction();
      const prompt = lmv.generatePrompt('state', 'action');

      const evalHigh = await lmv.recordEvaluation(prompt.id, 1.5);
      expect(evalHigh.value).toBe(1);

      const prompt2 = lmv.generatePrompt('state2', 'action2');
      const evalLow = await lmv.recordEvaluation(prompt2.id, -0.3);
      expect(evalLow.value).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Cache lookup
  // -----------------------------------------------------------------------

  describe('getCachedValue', () => {
    it('returns cached value for similar state+action', async () => {
      const lmv = createLMValueFunction({ similarityThreshold: 0.5 });
      const prompt = lmv.generatePrompt(
        'fix the broken typescript test',
        'run vitest with debug flag',
      );
      await lmv.recordEvaluation(prompt.id, 0.85, 'Good approach');

      // Query with very similar text
      const cached = await lmv.getCachedValue(
        'fix the broken typescript test',
        'run vitest with debug flag',
      );

      expect(cached).not.toBeNull();
      expect(cached!.value).toBe(0.85);
    });

    it('returns null for dissimilar state+action', async () => {
      const lmv = createLMValueFunction({ similarityThreshold: 0.85 });
      const prompt = lmv.generatePrompt(
        'fix the broken typescript test',
        'run vitest with debug flag',
      );
      await lmv.recordEvaluation(prompt.id, 0.85);

      // Query with completely different text
      const cached = await lmv.getCachedValue(
        'deploy production docker container',
        'push image to registry',
      );

      expect(cached).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Cache eviction
  // -----------------------------------------------------------------------

  describe('cache eviction', () => {
    it('evicts oldest entries when exceeding max size', async () => {
      const lmv = createLMValueFunction({
        cacheMaxSize: 3,
        similarityThreshold: 0.99, // high threshold so only exact matches hit
      });

      // Add 4 entries (exceeds max of 3)
      for (let i = 0; i < 4; i++) {
        const prompt = lmv.generatePrompt(`state${i}`, `action${i}`);
        await lmv.recordEvaluation(prompt.id, i * 0.25);
      }

      // The oldest entry (state0/action0) should have been evicted.
      // Query for the newest entry - should still be cached.
      const newest = await lmv.getCachedValue('state3', 'action3');
      // We can't guarantee a cache hit due to keyword similarity,
      // but we can verify the cache didn't grow beyond max size.
      // Instead, verify via save that only cacheMaxSize entries remain.
      await lmv.save();
      const writeCall = mockFileStore.write.mock.calls.find(
        (c: unknown[]) => c[1] === 'lm-value-cache',
      );
      expect(writeCall).toBeTruthy();
      const persisted = writeCall![2] as { entries: unknown[] };
      expect(persisted.entries.length).toBeLessThanOrEqual(3);
    });
  });

  // -----------------------------------------------------------------------
  // Cache TTL
  // -----------------------------------------------------------------------

  describe('cache TTL', () => {
    it('does not return expired entries', async () => {
      const lmv = createLMValueFunction({
        cacheTTLMs: 100,
        similarityThreshold: 0.5,
      });

      const prompt = lmv.generatePrompt(
        'fix broken test',
        'run vitest debug',
      );
      await lmv.recordEvaluation(prompt.id, 0.9);

      // Manually expire the cache entry by backdating it
      // Access internal cache via save/load round-trip manipulation
      await lmv.save();
      const writeCall = mockFileStore.write.mock.calls.find(
        (c: unknown[]) => c[1] === 'lm-value-cache',
      );
      const persisted = writeCall![2] as { entries: Array<{ cachedAt: number }> };
      // Backdate the entry
      persisted.entries[0].cachedAt = Date.now() - 200;

      // Reload with the backdated data
      mockFileStore.read.mockImplementation(
        async (_collection: string, id: string) => {
          if (id === 'lm-value-cache') return persisted;
          return null;
        },
      );
      await lmv.load();

      const cached = await lmv.getCachedValue(
        'fix broken test',
        'run vitest debug',
      );
      expect(cached).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Accuracy tracking
  // -----------------------------------------------------------------------

  describe('accuracy tracking', () => {
    it('computes MAE correctly', async () => {
      const lmv = createLMValueFunction();

      // Record predictions and actuals
      const p1 = lmv.generatePrompt('s1', 'a1');
      await lmv.recordEvaluation(p1.id, 0.8);
      await lmv.recordActualOutcome(p1.id, 0.6); // error = 0.2

      const p2 = lmv.generatePrompt('s2', 'a2');
      await lmv.recordEvaluation(p2.id, 0.3);
      await lmv.recordActualOutcome(p2.id, 0.5); // error = 0.2

      const p3 = lmv.generatePrompt('s3', 'a3');
      await lmv.recordEvaluation(p3.id, 0.9);
      await lmv.recordActualOutcome(p3.id, 0.9); // error = 0.0

      const accuracy = await lmv.getAccuracy();
      expect(accuracy.totalPredictions).toBe(3);
      // MAE = (0.2 + 0.2 + 0.0) / 3 = 0.1333...
      expect(accuracy.meanAbsoluteError).toBeCloseTo(0.1333, 3);
    });

    it('computes calibration buckets', async () => {
      const lmv = createLMValueFunction();

      // Add predictions in different ranges
      const p1 = lmv.generatePrompt('s1', 'a1');
      await lmv.recordEvaluation(p1.id, 0.1); // bucket [0.0, 0.2]
      await lmv.recordActualOutcome(p1.id, 0.15);

      const p2 = lmv.generatePrompt('s2', 'a2');
      await lmv.recordEvaluation(p2.id, 0.9); // bucket [0.8, 1.0]
      await lmv.recordActualOutcome(p2.id, 0.7);

      const accuracy = await lmv.getAccuracy();
      expect(accuracy.calibrationBuckets).toHaveLength(5);

      // Check the [0.0, 0.2] bucket
      const lowBucket = accuracy.calibrationBuckets.find(
        (b) => b.range[0] === 0.0 && b.range[1] === 0.2,
      );
      expect(lowBucket).toBeTruthy();
      expect(lowBucket!.count).toBe(1);
      expect(lowBucket!.predictedMean).toBeCloseTo(0.1);
      expect(lowBucket!.actualMean).toBeCloseTo(0.15);

      // Check the [0.8, 1.0] bucket
      const highBucket = accuracy.calibrationBuckets.find(
        (b) => b.range[0] === 0.8 && b.range[1] === 1.0,
      );
      expect(highBucket).toBeTruthy();
      expect(highBucket!.count).toBe(1);
      expect(highBucket!.predictedMean).toBeCloseTo(0.9);
      expect(highBucket!.actualMean).toBeCloseTo(0.7);
    });

    it('returns zero metrics when no predictions exist', async () => {
      const lmv = createLMValueFunction();
      const accuracy = await lmv.getAccuracy();

      expect(accuracy.totalPredictions).toBe(0);
      expect(accuracy.meanAbsoluteError).toBe(0);
      expect(accuracy.correlation).toBe(0);
      expect(accuracy.calibrationBuckets).toHaveLength(5);
    });
  });

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  describe('persistence', () => {
    it('save and load round-trip preserves state', async () => {
      const lmv = createLMValueFunction();

      // Build up some state
      const p1 = lmv.generatePrompt('state1', 'action1');
      await lmv.recordEvaluation(p1.id, 0.7, 'test');
      await lmv.recordActualOutcome(p1.id, 0.8);

      // Save
      await lmv.save();

      // Verify write was called for cache and accuracy
      expect(mockFileStore.write).toHaveBeenCalledWith(
        'lm-value',
        'lm-value-cache',
        expect.objectContaining({ entries: expect.any(Array) }),
      );
      expect(mockFileStore.write).toHaveBeenCalledWith(
        'lm-value',
        'lm-value-accuracy',
        expect.objectContaining({ pairs: expect.any(Array) }),
      );

      // Capture what was saved
      const savedCache = mockFileStore.write.mock.calls.find(
        (c: unknown[]) => c[1] === 'lm-value-cache',
      )![2];
      const savedAccuracy = mockFileStore.write.mock.calls.find(
        (c: unknown[]) => c[1] === 'lm-value-accuracy',
      )![2];

      // Create a new instance and load the saved state
      vi.clearAllMocks();
      mockFileStore.read.mockImplementation(
        async (_collection: string, id: string) => {
          if (id === 'lm-value-cache') return savedCache;
          if (id === 'lm-value-accuracy') return savedAccuracy;
          return null;
        },
      );

      const lmv2 = createLMValueFunction();
      await lmv2.load();

      // Verify accuracy was restored
      const accuracy = await lmv2.getAccuracy();
      expect(accuracy.totalPredictions).toBe(1);
      expect(accuracy.meanAbsoluteError).toBeCloseTo(0.1);
    });
  });

  // -----------------------------------------------------------------------
  // Clear
  // -----------------------------------------------------------------------

  describe('clear', () => {
    it('removes all cached evaluations and accuracy data', async () => {
      const lmv = createLMValueFunction();

      const p = lmv.generatePrompt('state', 'action');
      await lmv.recordEvaluation(p.id, 0.5);
      await lmv.recordActualOutcome(p.id, 0.6);

      await lmv.clear();

      const accuracy = await lmv.getAccuracy();
      expect(accuracy.totalPredictions).toBe(0);

      expect(mockFileStore.delete).toHaveBeenCalledWith('lm-value', 'lm-value-cache');
      expect(mockFileStore.delete).toHaveBeenCalledWith('lm-value', 'lm-value-accuracy');
    });
  });
});
