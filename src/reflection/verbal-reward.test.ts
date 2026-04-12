import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../utils/file-store.js';
import { VerbalRewardGenerator } from './verbal-reward.js';
import type { Episode } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let fileStore: FileStore;

const mockSemanticMemory = {
  add: async (_content: string, _opts?: unknown) =>
    `sem-${Math.random().toString(36).slice(2, 8)}`,
  search: async (_query: string, _topK?: number) => [],
  load: async () => {},
  stats: () => ({ entryCount: 0, capacity: 5000, dedupHitCount: 0 }),
  all: () => [],
  remove: async () => false,
};

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: `ep-${Math.random().toString(36).slice(2, 8)}`,
    task: 'fix authentication bug',
    actions: [
      { type: 'code_edit', description: 'edited auth.ts', timestamp: Date.now(), success: true },
      { type: 'command', description: 'ran tests', timestamp: Date.now(), success: true },
    ],
    outcome: { success: true, description: 'Bug fixed', duration: 30000 },
    reward: 0.8,
    timestamp: Date.now(),
    ...overrides,
  };
}

function createGenerator(): VerbalRewardGenerator {
  return new VerbalRewardGenerator({
    fileStore,
    semanticMemory: mockSemanticMemory as any,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'apex-test-'));
  fileStore = new FileStore(tmpDir);
  await fileStore.init();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VerbalRewardGenerator', () => {
  describe('generateReward', () => {
    it('produces correct signal for a successful episode', () => {
      const gen = createGenerator();
      const episode = makeEpisode();
      const reward = gen.generateReward(episode);

      expect(reward.success).toBe(true);
      expect(reward.reward).toBe(0.8);
      expect(reward.signal).toContain('succeeded');
      expect(reward.signal).toContain('fix authentication bug');
      expect(reward.episodeId).toBe(episode.id);
      expect(reward.id).toBeTruthy();
      expect(reward.timestamp).toBeGreaterThan(0);
    });

    it('produces correct signal for a failed episode', () => {
      const gen = createGenerator();
      const episode = makeEpisode({
        outcome: {
          success: false,
          description: 'Tests still failing',
          errorType: 'type-error',
          duration: 15000,
        },
        reward: 0.2,
        actions: [
          { type: 'code_edit', description: 'edited auth.ts', timestamp: Date.now(), success: true },
          { type: 'command', description: 'ran tests', timestamp: Date.now(), success: false },
        ],
      });
      const reward = gen.generateReward(episode);

      expect(reward.success).toBe(false);
      expect(reward.reward).toBe(0.2);
      expect(reward.signal).toContain('failed');
      expect(reward.signal).toContain('type-error');
      expect(reward.signal).toContain('Avoid');
    });

    it('extractTaskType produces first 4 keywords', () => {
      const gen = createGenerator();
      const episode = makeEpisode({ task: 'fix the authentication bug in login' });
      const reward = gen.generateReward(episode);

      // extractTaskType lowercases, strips non-alphanum, takes first 4 words > 1 char
      expect(reward.taskType).toBe('fix the authentication bug');
    });
  });

  describe('generateContrastivePair', () => {
    it('returns null for a success episode', async () => {
      const gen = createGenerator();
      const episode = makeEpisode(); // success by default
      const pair = await gen.generateContrastivePair(episode);
      expect(pair).toBeNull();
    });

    it('returns null when no matching success episode exists', async () => {
      const gen = createGenerator();
      const failed = makeEpisode({
        outcome: { success: false, description: 'Failed', duration: 10000 },
        reward: 0.1,
      });
      // No episodes in the store at all
      const pair = await gen.generateContrastivePair(failed);
      expect(pair).toBeNull();
    });

    it('finds matching success episode and generates contrastive signal', async () => {
      const gen = createGenerator();

      // Store a successful episode with a similar task
      const successEp = makeEpisode({
        id: 'ep-success-1',
        task: 'fix authentication bug in login',
        outcome: { success: true, description: 'Auth bug resolved', duration: 20000 },
        reward: 0.9,
        actions: [
          { type: 'code_edit', description: 'edited auth.ts', timestamp: Date.now(), success: true },
          { type: 'test', description: 'verified with integration tests', timestamp: Date.now(), success: true },
        ],
      });
      await fileStore.write('episodes', successEp.id, successEp);

      const failed = makeEpisode({
        id: 'ep-failed-1',
        task: 'fix authentication bug in login page',
        outcome: {
          success: false,
          description: 'Still broken',
          errorType: 'logic-error',
          duration: 15000,
        },
        reward: 0.1,
        actions: [
          { type: 'code_edit', description: 'edited auth.ts', timestamp: Date.now(), success: false },
        ],
      });

      const pair = await gen.generateContrastivePair(failed);
      expect(pair).not.toBeNull();
      expect(pair!.failedEpisodeId).toBe('ep-failed-1');
      expect(pair!.successEpisodeId).toBe('ep-success-1');
      expect(pair!.contrastiveSignal).toContain('failed because');
      expect(pair!.contrastiveSignal).toContain('succeeded because');
    });
  });

  describe('storeRewardAsMemory', () => {
    it('persists reward to FileStore and SemanticMemory', async () => {
      const gen = createGenerator();
      const episode = makeEpisode();
      const reward = gen.generateReward(episode);

      const entryId = await gen.storeRewardAsMemory(reward);

      expect(entryId).toBeTruthy();
      expect(entryId).toMatch(/^sem-/);

      // Verify it was persisted to the FileStore
      const stored = await fileStore.read('verbal-rewards', reward.id);
      expect(stored).not.toBeNull();
      expect((stored as any).signal).toBe(reward.signal);
    });
  });

  describe('getRewardsForTaskType', () => {
    it('filters rewards by task type', async () => {
      const gen = createGenerator();

      // Create rewards for different task types
      const ep1 = makeEpisode({ task: 'fix authentication bug' });
      const ep2 = makeEpisode({ task: 'fix authentication issue' });
      const ep3 = makeEpisode({ task: 'write new tests for parser' });

      const r1 = gen.generateReward(ep1);
      const r2 = gen.generateReward(ep2);
      const r3 = gen.generateReward(ep3);

      await gen.storeRewardAsMemory(r1);
      await gen.storeRewardAsMemory(r2);
      await gen.storeRewardAsMemory(r3);

      const authRewards = await gen.getRewardsForTaskType(r1.taskType);
      // r1 and r2 share the same taskType (fix authentication bug / fix authentication issue -> first 4 words)
      // r1.taskType = "fix authentication bug", r2.taskType = "fix authentication issue"
      // They are different task types, so only one match each
      expect(authRewards.length).toBeGreaterThanOrEqual(1);
      expect(authRewards.every((r) => r.taskType === r1.taskType)).toBe(true);

      const testRewards = await gen.getRewardsForTaskType(r3.taskType);
      expect(testRewards.length).toBe(1);
      expect(testRewards[0].taskType).toBe(r3.taskType);
    });
  });
});
