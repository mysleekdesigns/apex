import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../utils/file-store.js';
import { ReflectionQualityTracker } from './quality-tracker.js';
import type { Episode } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let fileStore: FileStore;

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

function createTracker(): ReflectionQualityTracker {
  return new ReflectionQualityTracker({ fileStore });
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

describe('ReflectionQualityTracker', () => {
  describe('recordApplication', () => {
    it('creates a new record on first call', async () => {
      const tracker = createTracker();
      const record = await tracker.recordApplication('ref-1', true);

      expect(record.reflectionId).toBe('ref-1');
      expect(record.applicationCount).toBe(1);
      expect(record.successCount).toBe(1);
      expect(record.pruned).toBe(false);
      expect(record.promoted).toBe(false);
    });

    it('increments counts correctly on subsequent calls', async () => {
      const tracker = createTracker();

      await tracker.recordApplication('ref-1', true);
      await tracker.recordApplication('ref-1', false);
      const record = await tracker.recordApplication('ref-1', true);

      expect(record.applicationCount).toBe(3);
      expect(record.successCount).toBe(2);
    });

    it('computes quality score as success_rate minus baseline', async () => {
      const tracker = createTracker();

      // With no episodes, baseline is 0.5
      // 1 success out of 1 application => success_rate = 1.0
      // quality = 1.0 - 0.5 = 0.5
      const record = await tracker.recordApplication('ref-1', true);
      expect(record.qualityScore).toBeCloseTo(0.5, 5);
      expect(record.baselineSuccessRate).toBe(0.5);
    });
  });

  describe('computeBaselineSuccessRate', () => {
    it('returns 0.5 with no episodes', async () => {
      const tracker = createTracker();
      const rate = await tracker.computeBaselineSuccessRate();
      expect(rate).toBe(0.5);
    });

    it('computes correctly with mixed episodes', async () => {
      const tracker = createTracker();

      // Store 3 success and 1 failure episode
      await fileStore.write('episodes', 'ep-1', makeEpisode({ id: 'ep-1' }));
      await fileStore.write('episodes', 'ep-2', makeEpisode({ id: 'ep-2' }));
      await fileStore.write('episodes', 'ep-3', makeEpisode({ id: 'ep-3' }));
      await fileStore.write(
        'episodes',
        'ep-4',
        makeEpisode({
          id: 'ep-4',
          outcome: { success: false, description: 'Failed', duration: 10000 },
        }),
      );

      const rate = await tracker.computeBaselineSuccessRate();
      expect(rate).toBeCloseTo(0.75, 5); // 3/4
    });
  });

  describe('getQualityRecord', () => {
    it('returns null for unknown reflection', async () => {
      const tracker = createTracker();
      const record = await tracker.getQualityRecord('nonexistent');
      expect(record).toBeNull();
    });

    it('returns persisted record after recordApplication', async () => {
      const tracker = createTracker();
      await tracker.recordApplication('ref-1', true);

      const record = await tracker.getQualityRecord('ref-1');
      expect(record).not.toBeNull();
      expect(record!.reflectionId).toBe('ref-1');
      expect(record!.applicationCount).toBe(1);
    });
  });

  describe('runMaintenance', () => {
    it('prunes low-quality reflections after threshold applications', async () => {
      const tracker = createTracker();

      // Record 5 failures for ref-1 => quality will be very low
      // baseline is 0.5 (no episodes), success_rate = 0/5 = 0
      // quality = 0 - 0.5 = -0.5 < 0.1 threshold, and 5 >= MIN_APPLICATIONS_FOR_PRUNE
      for (let i = 0; i < 5; i++) {
        await tracker.recordApplication('ref-prune', false);
      }

      const result = await tracker.runMaintenance();
      expect(result.pruned).toContain('ref-prune');

      const record = await tracker.getQualityRecord('ref-prune');
      expect(record!.pruned).toBe(true);
    });

    it('promotes high-quality reflections after threshold applications', async () => {
      const tracker = createTracker();

      // Record 3 successes for ref-1 => quality will be high
      // baseline = 0.5 (no episodes), success_rate = 3/3 = 1.0
      // quality = 1.0 - 0.5 = 0.5, not strictly > 0.5 for promote threshold
      // Need quality > 0.5, so let's add some failed episodes to lower baseline
      await fileStore.write(
        'episodes',
        'ep-f1',
        makeEpisode({
          id: 'ep-f1',
          outcome: { success: false, description: 'Failed', duration: 5000 },
        }),
      );
      await fileStore.write(
        'episodes',
        'ep-f2',
        makeEpisode({
          id: 'ep-f2',
          outcome: { success: false, description: 'Failed', duration: 5000 },
        }),
      );
      // baseline = 0/2 = 0.0
      // quality = 1.0 - 0.0 = 1.0 > 0.5 and 3 >= MIN_APPLICATIONS_FOR_PROMOTE

      for (let i = 0; i < 3; i++) {
        await tracker.recordApplication('ref-promote', true);
      }

      const result = await tracker.runMaintenance();
      expect(result.promoted).toContain('ref-promote');

      const record = await tracker.getQualityRecord('ref-promote');
      expect(record!.promoted).toBe(true);
    });
  });

  describe('getReport', () => {
    it('aggregates report correctly', async () => {
      const tracker = createTracker();

      // Create a few tracked reflections
      await tracker.recordApplication('ref-a', true);
      await tracker.recordApplication('ref-a', true);
      await tracker.recordApplication('ref-b', false);

      const report = await tracker.getReport();
      expect(report.totalTracked).toBe(2);
      expect(report.prunedCount).toBe(0);
      expect(report.promotedCount).toBe(0);
      expect(typeof report.avgQualityScore).toBe('number');
    });
  });
});
