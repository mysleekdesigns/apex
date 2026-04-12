import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../utils/file-store.js';
import { ABTestManager } from './ab-testing.js';

describe('ABTestManager', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let manager: ABTestManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apex-test-'));
    fileStore = new FileStore(tmpDir);
    await fileStore.init();
    manager = new ABTestManager({ fileStore });
    await manager.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create an experiment with correct initial state', async () => {
    const exp = await manager.createExperiment({
      name: 'prompt-v1-vs-v2',
      description: 'Test prompt variants',
      controlContent: 'You are a helpful assistant.',
      treatmentContent: 'You are an expert assistant.',
    });

    expect(exp.name).toBe('prompt-v1-vs-v2');
    expect(exp.status).toBe('running');
    expect(exp.winner).toBeNull();
    expect(exp.controlMetrics.exposures).toBe(0);
    expect(exp.treatmentMetrics.exposures).toBe(0);
    expect(exp.controlMetrics.successRate).toBe(0);
    expect(exp.concludedAt).toBeNull();
    expect(exp.minSampleSize).toBe(30);
    expect(exp.significanceLevel).toBe(0.05);

    const retrieved = manager.getExperiment('prompt-v1-vs-v2');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(exp.id);
  });

  it('should return roughly 50/50 variant assignment', async () => {
    await manager.createExperiment({
      name: 'split-test',
      description: 'Verify random split',
      controlContent: 'control',
      treatmentContent: 'treatment',
    });

    let controlCount = 0;
    let treatmentCount = 0;
    const iterations = 1000;

    for (let i = 0; i < iterations; i++) {
      const variant = manager.getVariant('split-test');
      expect(variant).not.toBeNull();
      if (variant!.group === 'control') controlCount++;
      else treatmentCount++;
    }

    // Expect roughly 50/50 with generous tolerance (40-60%)
    const controlRatio = controlCount / iterations;
    expect(controlRatio).toBeGreaterThan(0.4);
    expect(controlRatio).toBeLessThan(0.6);
  });

  it('should update metrics correctly when recording outcomes', async () => {
    await manager.createExperiment({
      name: 'metrics-test',
      description: 'Test metric updates',
      controlContent: 'control',
      treatmentContent: 'treatment',
    });

    await manager.recordOutcome('metrics-test', 'control', true, 1.0);
    await manager.recordOutcome('metrics-test', 'control', true, 0.8);
    await manager.recordOutcome('metrics-test', 'control', false, 0.0);
    await manager.recordOutcome('metrics-test', 'treatment', true, 1.0);
    await manager.recordOutcome('metrics-test', 'treatment', false, 0.2);

    const exp = manager.getExperiment('metrics-test')!;

    expect(exp.controlMetrics.exposures).toBe(3);
    expect(exp.controlMetrics.successes).toBe(2);
    expect(exp.controlMetrics.failures).toBe(1);
    expect(exp.controlMetrics.totalReward).toBeCloseTo(1.8);
    expect(exp.controlMetrics.avgReward).toBeCloseTo(0.6);
    expect(exp.controlMetrics.successRate).toBeCloseTo(2 / 3);

    expect(exp.treatmentMetrics.exposures).toBe(2);
    expect(exp.treatmentMetrics.successes).toBe(1);
    expect(exp.treatmentMetrics.failures).toBe(1);
    expect(exp.treatmentMetrics.totalReward).toBeCloseTo(1.2);
    expect(exp.treatmentMetrics.avgReward).toBeCloseTo(0.6);
    expect(exp.treatmentMetrics.successRate).toBeCloseTo(0.5);
  });

  it('should detect statistically significant differences with chi-squared', async () => {
    await manager.createExperiment({
      name: 'significant-test',
      description: 'Clearly significant difference',
      controlContent: 'control',
      treatmentContent: 'treatment',
      minSampleSize: 20,
    });

    // Control: 20% success rate (4/20)
    for (let i = 0; i < 4; i++) {
      await manager.recordOutcome('significant-test', 'control', true);
    }
    for (let i = 0; i < 16; i++) {
      await manager.recordOutcome('significant-test', 'control', false);
    }

    // Treatment: 70% success rate (14/20)
    for (let i = 0; i < 14; i++) {
      await manager.recordOutcome('significant-test', 'treatment', true);
    }
    for (let i = 0; i < 6; i++) {
      await manager.recordOutcome('significant-test', 'treatment', false);
    }

    const result = manager.evaluateExperiment('significant-test');
    expect(result).not.toBeNull();
    expect(result!.significant).toBe(true);
    expect(result!.winner).toBe('treatment');
    expect(result!.chiSquared).toBeGreaterThan(3.841);
    expect(result!.pValue).toBeLessThanOrEqual(0.05);
    expect(result!.sampleSizeSufficient).toBe(true);
    expect(result!.liftPercent).toBeGreaterThan(0);
  });

  it('should report non-significant differences correctly', async () => {
    await manager.createExperiment({
      name: 'non-significant',
      description: 'Similar performance',
      controlContent: 'control',
      treatmentContent: 'treatment',
      minSampleSize: 20,
    });

    // Control: 50% success (10/20)
    for (let i = 0; i < 10; i++) {
      await manager.recordOutcome('non-significant', 'control', true);
    }
    for (let i = 0; i < 10; i++) {
      await manager.recordOutcome('non-significant', 'control', false);
    }

    // Treatment: 55% success (11/20)
    for (let i = 0; i < 11; i++) {
      await manager.recordOutcome('non-significant', 'treatment', true);
    }
    for (let i = 0; i < 9; i++) {
      await manager.recordOutcome('non-significant', 'treatment', false);
    }

    const result = manager.evaluateExperiment('non-significant');
    expect(result).not.toBeNull();
    expect(result!.significant).toBe(false);
    expect(result!.winner).toBe('no-difference');
    expect(result!.chiSquared).toBeLessThan(3.841);
    expect(result!.sampleSizeSufficient).toBe(true);
  });

  it('should conclude experiment and declare the correct winner', async () => {
    await manager.createExperiment({
      name: 'conclude-test',
      description: 'Test conclusion flow',
      controlContent: 'control',
      treatmentContent: 'treatment',
      minSampleSize: 20,
    });

    // Control: 30% (6/20)
    for (let i = 0; i < 6; i++) {
      await manager.recordOutcome('conclude-test', 'control', true);
    }
    for (let i = 0; i < 14; i++) {
      await manager.recordOutcome('conclude-test', 'control', false);
    }

    // Treatment: 80% (16/20)
    for (let i = 0; i < 16; i++) {
      await manager.recordOutcome('conclude-test', 'treatment', true);
    }
    for (let i = 0; i < 4; i++) {
      await manager.recordOutcome('conclude-test', 'treatment', false);
    }

    const result = await manager.concludeExperiment('conclude-test');
    expect(result).not.toBeNull();
    expect(result!.significant).toBe(true);
    expect(result!.winner).toBe('treatment');

    const exp = manager.getExperiment('conclude-test')!;
    expect(exp.status).toBe('concluded');
    expect(exp.winner).toBe('treatment');
    expect(exp.concludedAt).not.toBeNull();

    // getVariant should return null for concluded experiments
    const variant = manager.getVariant('conclude-test');
    expect(variant).toBeNull();
  });

  it('should auto-evaluate and only conclude sufficient+significant experiments', async () => {
    // Experiment 1: sufficient sample + significant => should conclude
    await manager.createExperiment({
      name: 'auto-conclude',
      description: 'Should be auto-concluded',
      controlContent: 'c',
      treatmentContent: 't',
      minSampleSize: 20,
    });
    for (let i = 0; i < 3; i++) {
      await manager.recordOutcome('auto-conclude', 'control', true);
    }
    for (let i = 0; i < 17; i++) {
      await manager.recordOutcome('auto-conclude', 'control', false);
    }
    for (let i = 0; i < 15; i++) {
      await manager.recordOutcome('auto-conclude', 'treatment', true);
    }
    for (let i = 0; i < 5; i++) {
      await manager.recordOutcome('auto-conclude', 'treatment', false);
    }

    // Experiment 2: insufficient sample => should NOT conclude
    await manager.createExperiment({
      name: 'too-small',
      description: 'Not enough data',
      controlContent: 'c',
      treatmentContent: 't',
      minSampleSize: 100,
    });
    for (let i = 0; i < 5; i++) {
      await manager.recordOutcome('too-small', 'control', true);
    }
    for (let i = 0; i < 5; i++) {
      await manager.recordOutcome('too-small', 'treatment', false);
    }

    // Experiment 3: sufficient sample but not significant => should NOT conclude
    await manager.createExperiment({
      name: 'not-sig',
      description: 'Not significant',
      controlContent: 'c',
      treatmentContent: 't',
      minSampleSize: 20,
    });
    for (let i = 0; i < 10; i++) {
      await manager.recordOutcome('not-sig', 'control', true);
    }
    for (let i = 0; i < 10; i++) {
      await manager.recordOutcome('not-sig', 'control', false);
    }
    for (let i = 0; i < 11; i++) {
      await manager.recordOutcome('not-sig', 'treatment', true);
    }
    for (let i = 0; i < 9; i++) {
      await manager.recordOutcome('not-sig', 'treatment', false);
    }

    const results = await manager.autoEvaluate();

    expect(results).toHaveLength(1);
    expect(results[0].experimentId).toBe(
      manager.getExperiment('auto-conclude')!.id,
    );

    expect(manager.getExperiment('auto-conclude')!.status).toBe('concluded');
    expect(manager.getExperiment('too-small')!.status).toBe('running');
    expect(manager.getExperiment('not-sig')!.status).toBe('running');
  });

  it('should persist and reload experiments from FileStore', async () => {
    await manager.createExperiment({
      name: 'persist-test',
      description: 'Persistence check',
      controlContent: 'control-prompt',
      treatmentContent: 'treatment-prompt',
    });

    await manager.recordOutcome('persist-test', 'control', true, 1.0);
    await manager.recordOutcome('persist-test', 'treatment', false, 0.0);
    await manager.persist();

    // Create a new manager with the same store
    const manager2 = new ABTestManager({ fileStore });
    await manager2.init();

    const reloaded = manager2.getExperiment('persist-test');
    expect(reloaded).not.toBeNull();
    expect(reloaded!.name).toBe('persist-test');
    expect(reloaded!.controlContent).toBe('control-prompt');
    expect(reloaded!.controlMetrics.exposures).toBe(1);
    expect(reloaded!.controlMetrics.successes).toBe(1);
    expect(reloaded!.treatmentMetrics.exposures).toBe(1);
    expect(reloaded!.treatmentMetrics.failures).toBe(1);

    const report = manager2.getReport();
    expect(report.running).toBe(1);
    expect(report.concluded).toBe(0);
    expect(report.experiments).toHaveLength(1);
  });
});
