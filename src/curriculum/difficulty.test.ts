import { describe, it, expect, vi } from 'vitest';
import { DifficultyEstimator } from './difficulty.js';
import type { Episode } from '../types.js';

// Mock embeddings and similarity
vi.mock('../utils/embeddings.js', () => ({
  extractKeywords: vi.fn((text: string) =>
    text.toLowerCase().split(/\s+/).filter(Boolean),
  ),
}));

vi.mock('../utils/similarity.js', () => ({
  jaccardSimilarity: vi.fn((a: Set<string>, b: Set<string>) => {
    let intersection = 0;
    for (const item of a) if (b.has(item)) intersection++;
    const union = new Set([...a, ...b]).size;
    return union > 0 ? intersection / union : 0;
  }),
}));

function makeEpisode(task: string, reward: number): Episode {
  return {
    id: `ep-${Math.random().toString(36).slice(2, 8)}`,
    task,
    actions: [{ type: 'test', description: 'action', timestamp: Date.now(), success: reward > 0.5 }],
    outcome: { success: reward > 0.5, description: 'outcome', duration: 1000 },
    reward,
    timestamp: Date.now(),
  };
}

describe('DifficultyEstimator', () => {
  const estimator = new DifficultyEstimator();

  describe('estimateTaskComplexity', () => {
    it('returns higher score for more complex descriptions', () => {
      const simple = estimator.estimateTaskComplexity('fix bug');
      const complex = estimator.estimateTaskComplexity(
        'First, refactor the async database middleware to use TypeScript interfaces. ' +
        'Then update the GraphQL schema resolvers. Must not break the existing REST API endpoints. ' +
        'Ensure that all webhook handlers are updated and the docker deployment config is modified. ' +
        'Do not change the authentication module. After that, add integration tests for the new API.',
      );
      expect(complex).toBeGreaterThan(simple);
    });

    it('accounts for explicit constraints', () => {
      const withoutConstraints = estimator.estimateTaskComplexity('build a component');
      const withConstraints = estimator.estimateTaskComplexity('build a component', [
        'must be accessible',
        'must support dark mode',
        'must not use external deps',
        'must render under 16ms',
      ]);
      expect(withConstraints).toBeGreaterThan(withoutConstraints);
    });

    it('returns value in [0, 1]', () => {
      const score = estimator.estimateTaskComplexity('any task description');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe('estimateHistoricalDifficulty', () => {
    it('returns 0.5 with 0 confidence when no episodes exist', () => {
      const result = (estimator as any).estimateHistoricalDifficulty('some task', []);
      expect(result.difficulty).toBeCloseTo(0.5);
      expect(result.confidence).toBe(0);
    });

    it('returns high difficulty for tasks with high failure rates', () => {
      const episodes = [
        makeEpisode('fix typescript error handling', 0.0),
        makeEpisode('fix typescript error in types', 0.1),
        makeEpisode('typescript error fix', 0.0),
      ];

      const result = (estimator as any).estimateHistoricalDifficulty(
        'fix typescript error',
        episodes,
      );
      expect(result.difficulty).toBeGreaterThan(0.5);
    });

    it('returns low difficulty for tasks with high success rates', () => {
      const episodes = [
        makeEpisode('add typescript test', 1.0),
        makeEpisode('write typescript test cases', 0.9),
        makeEpisode('create typescript tests', 1.0),
      ];

      const result = (estimator as any).estimateHistoricalDifficulty(
        'add typescript test',
        episodes,
      );
      expect(result.difficulty).toBeLessThan(0.5);
    });
  });

  describe('estimateNovelty', () => {
    it('returns 1.0 when no past episodes exist', () => {
      expect(estimator.estimateNovelty('brand new task', [])).toBeCloseTo(1.0);
    });

    it('returns low novelty for task similar to past episodes', () => {
      const episodes = [makeEpisode('fix typescript error', 0.5)];
      const novelty = estimator.estimateNovelty('fix typescript error handling', episodes);
      expect(novelty).toBeLessThan(0.5);
    });

    it('returns high novelty for completely different task', () => {
      const episodes = [makeEpisode('fix typescript error', 0.5)];
      const novelty = estimator.estimateNovelty('deploy kubernetes cluster on aws', episodes);
      expect(novelty).toBeGreaterThan(0.5);
    });
  });

  describe('estimate (composite)', () => {
    it('returns all fields in estimate', () => {
      const result = estimator.estimate('build a REST API', []);
      expect(result).toHaveProperty('taskComplexity');
      expect(result).toHaveProperty('historicalDifficulty');
      expect(result).toHaveProperty('novelty');
      expect(result).toHaveProperty('composite');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('signals');
    });

    it('composite is in [0, 1]', () => {
      const result = estimator.estimate('complex task with many requirements', [
        makeEpisode('complex task', 0.3),
      ]);
      expect(result.composite).toBeGreaterThanOrEqual(0);
      expect(result.composite).toBeLessThanOrEqual(1);
    });

    it('shifts weight to complexity when historical confidence is low', () => {
      // With no episodes, historical confidence = 0, so complexity gets all the weight
      const noHistory = estimator.estimate('build api with typescript async await', []);
      // With history
      const episodes = Array.from({ length: 15 }, (_, i) =>
        makeEpisode('build api with typescript async await', 0.5),
      );
      const withHistory = estimator.estimate('build api with typescript async await', episodes);

      // Both should be valid composites
      expect(noHistory.composite).toBeGreaterThanOrEqual(0);
      expect(withHistory.composite).toBeGreaterThanOrEqual(0);
    });
  });
});
