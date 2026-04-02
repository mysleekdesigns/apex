/**
 * Benchmark: Full loop throughput for the evolution engine.
 *
 * Measures iterations per second for the record -> reflect -> consolidate
 * cycle of the EvolutionLoop controller.
 */

import { describe, bench } from 'vitest';
import { EvolutionLoop } from '../evolution/loop.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeLoop(budget?: { maxIterations?: number; timeLimitMs?: number }): Promise<EvolutionLoop> {
  const dir = await mkdtemp(join(tmpdir(), 'apex-bench-loop-'));
  const loop = new EvolutionLoop({
    dataDir: dir,
    budget: {
      maxIterations: budget?.maxIterations ?? 1000,
      timeLimitMs: budget?.timeLimitMs ?? 600_000,
    },
  });
  await loop.initialize();
  return loop;
}

// ---------------------------------------------------------------------------
// Phase advancement benchmarks
// ---------------------------------------------------------------------------

describe('EvolutionLoop phase management', () => {
  bench('advancePhase through full cycle x100', async () => {
    const loop = await makeLoop();
    const phases = [
      'task-selection',
      'planning',
      'execution',
      'reflection',
      'consolidation',
      'idle',
    ] as const;

    for (let i = 0; i < 100; i++) {
      for (const phase of phases) {
        loop.advancePhase(phase);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Iteration recording benchmarks
// ---------------------------------------------------------------------------

describe('EvolutionLoop iteration recording', () => {
  bench('recordIteration x10', async () => {
    const loop = await makeLoop({ maxIterations: 100 });
    for (let i = 0; i < 10; i++) {
      loop.recordIteration({
        taskId: `task-${i}`,
        taskDescription: `Benchmark task number ${i}`,
        outcome: { success: Math.random() > 0.3, reward: Math.random() },
        startedAt: Date.now() - 5000,
        completedAt: Date.now(),
        duration: 5000,
      });
    }
  });

  bench('recordIteration x100', async () => {
    const loop = await makeLoop({ maxIterations: 200 });
    for (let i = 0; i < 100; i++) {
      loop.recordIteration({
        taskId: `task-${i}`,
        taskDescription: `Benchmark task number ${i}`,
        outcome: { success: Math.random() > 0.3, reward: Math.random() },
        startedAt: Date.now() - 5000,
        completedAt: Date.now(),
        duration: 5000,
      });
    }
  });

  bench('recordIteration x1000', async () => {
    const loop = await makeLoop({ maxIterations: 2000 });
    for (let i = 0; i < 1000; i++) {
      loop.recordIteration({
        taskId: `task-${i}`,
        taskDescription: `Benchmark task number ${i}`,
        outcome: { success: Math.random() > 0.3, reward: Math.random() },
        startedAt: Date.now() - 5000,
        completedAt: Date.now(),
        duration: 5000,
      });
    }
  }, { iterations: 3 });
});

// ---------------------------------------------------------------------------
// Budget checking benchmarks
// ---------------------------------------------------------------------------

describe('EvolutionLoop budget checks', () => {
  bench('budgetExhausted check x10000', async () => {
    const loop = await makeLoop();
    for (let i = 0; i < 10_000; i++) {
      loop.budgetExhausted();
    }
  });

  bench('budgetRemaining check x10000', async () => {
    const loop = await makeLoop();
    for (let i = 0; i < 10_000; i++) {
      loop.budgetRemaining();
    }
  });
});

// ---------------------------------------------------------------------------
// Metrics computation benchmarks
// ---------------------------------------------------------------------------

describe('EvolutionLoop metrics computation', () => {
  bench('getMetrics after 100 iterations', async () => {
    const loop = await makeLoop({ maxIterations: 200 });
    for (let i = 0; i < 100; i++) {
      loop.recordIteration({
        outcome: { success: Math.random() > 0.3, reward: Math.random() },
        duration: Math.random() * 10_000,
      });
    }
    loop.getMetrics();
  }, { iterations: 10 });

  bench('getMetrics after 1000 iterations', async () => {
    const loop = await makeLoop({ maxIterations: 2000 });
    for (let i = 0; i < 1000; i++) {
      loop.recordIteration({
        outcome: { success: Math.random() > 0.3, reward: Math.random() },
        duration: Math.random() * 10_000,
      });
    }
    loop.getMetrics();
  }, { iterations: 3 });
});

// ---------------------------------------------------------------------------
// Full loop cycle: record -> advance -> check budget -> get state
// ---------------------------------------------------------------------------

describe('Full loop cycle throughput', () => {
  bench('record + advance + budgetCheck + getState x100', async () => {
    const loop = await makeLoop({ maxIterations: 200 });
    const phases = [
      'task-selection',
      'planning',
      'execution',
      'reflection',
      'consolidation',
      'idle',
    ] as const;

    for (let i = 0; i < 100; i++) {
      for (const phase of phases) {
        loop.advancePhase(phase);
      }
      loop.recordIteration({
        outcome: { success: Math.random() > 0.3, reward: Math.random() },
        duration: 5000,
      });
      loop.budgetExhausted();
      loop.getState();
    }
  }, { iterations: 3 });

  bench('record + advance + save x50 (with I/O)', async () => {
    const loop = await makeLoop({ maxIterations: 100 });

    for (let i = 0; i < 50; i++) {
      loop.advancePhase('execution');
      loop.recordIteration({
        outcome: { success: true, reward: 0.8 },
        duration: 1000,
      });
      await loop.save();
    }
  }, { iterations: 3 });
});
