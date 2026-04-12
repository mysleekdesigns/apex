import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../utils/file-store.js';
import {
  RegressionDetector,
  PerformanceMetrics,
} from './regression-detector.js';

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    successRate: 0.8,
    avgReward: 0.7,
    recallHitRate: 0.75,
    avgLatency: 50,
    sampleSize: 20,
    ...overrides,
  };
}

describe('RegressionDetector', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let detector: RegressionDetector;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apex-test-'));
    fileStore = new FileStore(tmpDir);
    await fileStore.init();
    detector = new RegressionDetector({ fileStore });
    await detector.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Record snapshot and verify storage
  it('should record a snapshot and store it', async () => {
    const snap = await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics(),
      changeDescription: 'initial baseline',
    });

    expect(snap.id).toBeDefined();
    expect(snap.moduleName).toBe('recall');
    expect(snap.metrics.successRate).toBe(0.8);
    expect(snap.changeDescription).toBe('initial baseline');
    expect(snap.timestamp).toBeDefined();
  });

  // 2. getBaseline returns highest-scoring snapshot
  it('should return the highest-scoring snapshot as baseline', async () => {
    await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics({ successRate: 0.6 }),
      changeDescription: 'low performer',
    });

    const bestSnap = await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics({ successRate: 0.95, avgReward: 0.9, recallHitRate: 0.9 }),
      changeDescription: 'best performer',
    });

    await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics({ successRate: 0.7 }),
      changeDescription: 'medium performer',
    });

    const baseline = detector.getBaseline('recall');
    expect(baseline).not.toBeNull();
    expect(baseline!.id).toBe(bestSnap.id);
  });

  // 3. checkForRegression with degraded metrics produces warning alert
  it('should detect warning-level regression', async () => {
    await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics({ successRate: 0.8 }),
      changeDescription: 'baseline',
    });

    // successRate drops from 0.8 to 0.72 = 10% degradation (> 5% warning threshold)
    const alerts = detector.checkForRegression(
      'recall',
      makeMetrics({ successRate: 0.72 }),
    );

    expect(alerts.length).toBeGreaterThan(0);
    const successAlert = alerts.find((a) => a.metric === 'successRate');
    expect(successAlert).toBeDefined();
    expect(successAlert!.severity).toBe('warning');
    expect(successAlert!.degradationPercent).toBeGreaterThan(5);
  });

  // 4. checkForRegression with severely degraded metrics produces critical alert
  it('should detect critical-level regression', async () => {
    await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics({ successRate: 0.8 }),
      changeDescription: 'baseline',
    });

    // successRate drops from 0.8 to 0.5 = 37.5% degradation (> 15% critical threshold)
    const alerts = detector.checkForRegression(
      'recall',
      makeMetrics({ successRate: 0.5 }),
    );

    const successAlert = alerts.find((a) => a.metric === 'successRate');
    expect(successAlert).toBeDefined();
    expect(successAlert!.severity).toBe('critical');
  });

  // 5. No regression alert when within threshold
  it('should not alert when metrics are within threshold', async () => {
    await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics({ successRate: 0.8 }),
      changeDescription: 'baseline',
    });

    // successRate drops from 0.8 to 0.78 = 2.5% degradation (< 5% warning threshold)
    const alerts = detector.checkForRegression(
      'recall',
      makeMetrics({ successRate: 0.78 }),
    );

    const successAlert = alerts.find((a) => a.metric === 'successRate');
    expect(successAlert).toBeUndefined();
  });

  // 6. shouldRollback true on critical regression
  it('should recommend rollback on critical regression', async () => {
    const baseline = await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics({ successRate: 0.8 }),
      changeDescription: 'baseline',
    });

    const result = detector.shouldRollback(
      'recall',
      makeMetrics({ successRate: 0.5 }),
    );

    expect(result.rollback).toBe(true);
    expect(result.reason).toContain('Critical regression');
    expect(result.rollbackTo).not.toBeNull();
    expect(result.rollbackTo!.id).toBe(baseline.id);
  });

  // 7. computeTrend: improving scenario
  it('should detect improving trend', async () => {
    for (let i = 0; i < 5; i++) {
      await detector.recordSnapshot({
        moduleName: 'recall',
        metrics: makeMetrics({
          successRate: 0.5 + i * 0.1,
          avgReward: 0.5 + i * 0.1,
          recallHitRate: 0.5 + i * 0.1,
        }),
        changeDescription: `iteration ${i}`,
      });
    }

    expect(detector.computeTrend('recall')).toBe('improving');
  });

  // 8. computeTrend: degrading scenario
  it('should detect degrading trend', async () => {
    for (let i = 0; i < 5; i++) {
      await detector.recordSnapshot({
        moduleName: 'recall',
        metrics: makeMetrics({
          successRate: 0.9 - i * 0.1,
          avgReward: 0.9 - i * 0.1,
          recallHitRate: 0.9 - i * 0.1,
        }),
        changeDescription: `iteration ${i}`,
      });
    }

    expect(detector.computeTrend('recall')).toBe('degrading');
  });

  // 9. Learning curve returns chronological snapshots
  it('should return learning curve in chronological order', async () => {
    await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics({ successRate: 0.6 }),
      changeDescription: 'v1',
    });
    await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics({ successRate: 0.7 }),
      changeDescription: 'v2',
    });
    await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics({ successRate: 0.8 }),
      changeDescription: 'v3',
    });

    const curve = detector.getLearningCurve('recall');
    expect(curve).toHaveLength(3);
    expect(curve[0].changeDescription).toBe('v1');
    expect(curve[1].changeDescription).toBe('v2');
    expect(curve[2].changeDescription).toBe('v3');
    expect(curve[0].successRate).toBe(0.6);
    expect(curve[2].successRate).toBe(0.8);
  });

  // 10. Persist and reload preserves state
  it('should persist and reload state correctly', async () => {
    await detector.recordSnapshot({
      moduleName: 'recall',
      metrics: makeMetrics({ successRate: 0.85 }),
      changeDescription: 'persisted snapshot',
    });

    // Create alerts via checkForRegression
    detector.checkForRegression(
      'recall',
      makeMetrics({ successRate: 0.5 }),
    );

    await detector.persist();

    // Create new detector from same fileStore
    const detector2 = new RegressionDetector({ fileStore });
    await detector2.init();

    const baseline = detector2.getBaseline('recall');
    expect(baseline).not.toBeNull();
    expect(baseline!.metrics.successRate).toBe(0.85);

    const alerts = detector2.getAlerts();
    expect(alerts.length).toBeGreaterThan(0);
  });
});
