import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../utils/file-store.js';
import { CognitiveCycle } from './cycle.js';
import type { CognitivePhase } from './cycle.js';

describe('CognitiveCycle', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let cycle: CognitiveCycle;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apex-test-'));
    fileStore = new FileStore(tmpDir);
    await fileStore.init();
    cycle = new CognitiveCycle({ fileStore });
    await cycle.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. classifyTool maps tools to correct phases
  // -----------------------------------------------------------------------
  it('classifies tools to correct cognitive phases', () => {
    expect(cycle.classifyTool('apex_recall')).toBe('perceive');
    expect(cycle.classifyTool('apex_skills')).toBe('perceive');
    expect(cycle.classifyTool('apex_status')).toBe('perceive');
    expect(cycle.classifyTool('apex_reflect_get')).toBe('perceive');
    expect(cycle.classifyTool('apex_foresight_check')).toBe('perceive');

    expect(cycle.classifyTool('apex_plan_context')).toBe('decide');
    expect(cycle.classifyTool('apex_foresight_predict')).toBe('decide');
    expect(cycle.classifyTool('apex_curriculum')).toBe('decide');

    expect(cycle.classifyTool('apex_record')).toBe('act');
    expect(cycle.classifyTool('apex_skill_store')).toBe('act');
    expect(cycle.classifyTool('apex_snapshot')).toBe('act');

    expect(cycle.classifyTool('apex_foresight_resolve')).toBe('learn');
    expect(cycle.classifyTool('apex_population_evolve')).toBe('learn');
    expect(cycle.classifyTool('apex_tool_propose')).toBe('learn');

    // Unknown tools default to 'act'
    expect(cycle.classifyTool('apex_unknown_tool')).toBe('act');
  });

  // -----------------------------------------------------------------------
  // 2. recordToolCall tracks phase transitions
  // -----------------------------------------------------------------------
  it('records tool calls and tracks phase transitions', () => {
    expect(cycle.getCurrentPhase()).toBe('idle');

    cycle.recordToolCall('apex_recall', 50);
    expect(cycle.getCurrentPhase()).toBe('perceive');

    cycle.recordToolCall('apex_plan_context', 30);
    expect(cycle.getCurrentPhase()).toBe('decide');

    const events = cycle.getCurrentCycleEvents();
    expect(events).toHaveLength(2);
    expect(events[0].phase).toBe('perceive');
    expect(events[1].phase).toBe('decide');
  });

  // -----------------------------------------------------------------------
  // 3. Full cycle detection
  // -----------------------------------------------------------------------
  it('detects a full perceive→decide→act→learn cycle', () => {
    cycle.recordToolCall('apex_recall', 10);
    cycle.recordToolCall('apex_plan_context', 10);
    cycle.recordToolCall('apex_record', 10);

    // Before learn, should be partial
    const metricsBefore = cycle.getMetrics();
    expect(metricsBefore.completedCycles).toBe(0);

    cycle.recordToolCall('apex_foresight_resolve', 10);

    // After learn, cycle should be complete
    const metricsAfter = cycle.getMetrics();
    expect(metricsAfter.completedCycles).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 4. Cycle quality score for perfect sequence
  // -----------------------------------------------------------------------
  it('returns quality 1.0 for perfect canonical sequence', () => {
    cycle.recordToolCall('apex_recall', 10);
    cycle.recordToolCall('apex_plan_context', 10);
    cycle.recordToolCall('apex_record', 10);
    cycle.recordToolCall('apex_foresight_resolve', 10);

    expect(cycle.getCycleQuality()).toBe(1.0);
  });

  // -----------------------------------------------------------------------
  // 5. Cycle quality score for incomplete/out-of-order sequence
  // -----------------------------------------------------------------------
  it('penalizes incomplete and out-of-order sequences', () => {
    // Only perceive — missing 3 phases = 1.0 - 0.75 = 0.25
    cycle.recordToolCall('apex_recall', 10);
    expect(cycle.getCycleQuality()).toBeCloseTo(0.25, 2);

    // Add act (skipping decide) — missing 2 phases, 0 out-of-order penalty
    // phases seen: perceive, act => missing decide, learn => 1.0 - 0.50 = 0.50
    cycle.recordToolCall('apex_record', 10);
    expect(cycle.getCycleQuality()).toBeCloseTo(0.5, 2);

    // Now add decide (out of order after act)
    // phases seen: perceive, act, decide => missing learn => 1.0 - 0.25 = 0.75
    // out-of-order: decide came after act => -0.1
    cycle.recordToolCall('apex_plan_context', 10);
    expect(cycle.getCycleQuality()).toBeCloseTo(0.65, 2);
  });

  // -----------------------------------------------------------------------
  // 6. suggestNextPhase returns correct tools for each phase
  // -----------------------------------------------------------------------
  it('suggests correct next phase and tools', () => {
    // idle → perceive
    let suggestion = cycle.suggestNextPhase();
    expect(suggestion.phase).toBe('perceive');
    expect(suggestion.suggestedTools).toContain('apex_recall');

    // perceive → decide
    cycle.recordToolCall('apex_recall');
    suggestion = cycle.suggestNextPhase();
    expect(suggestion.phase).toBe('decide');
    expect(suggestion.suggestedTools).toContain('apex_plan_context');

    // decide → act
    cycle.recordToolCall('apex_plan_context');
    suggestion = cycle.suggestNextPhase();
    expect(suggestion.phase).toBe('act');
    expect(suggestion.suggestedTools).toContain('apex_record');

    // act → learn
    cycle.recordToolCall('apex_record');
    suggestion = cycle.suggestNextPhase();
    expect(suggestion.phase).toBe('learn');
    expect(suggestion.suggestedTools).toContain('apex_reflect_store');

    // learn → perceive (new cycle)
    cycle.recordToolCall('apex_foresight_resolve');
    suggestion = cycle.suggestNextPhase();
    expect(suggestion.phase).toBe('perceive');
    expect(suggestion.suggestedTools).toContain('apex_recall');
  });

  // -----------------------------------------------------------------------
  // 7. Idle timeout resets cycle
  // -----------------------------------------------------------------------
  it('resets to idle when idle timeout is exceeded', () => {
    const shortCycle = new CognitiveCycle({
      fileStore,
      idleTimeout: 100, // 100ms
    });

    shortCycle.recordToolCall('apex_recall', 10);
    expect(shortCycle.getCurrentPhase()).toBe('perceive');

    // Simulate time passing by manipulating internals via a second call
    // We need the timestamp gap to exceed 100ms — use a real small wait
    // Instead, we create a cycle with 0 timeout to guarantee reset
    const zeroCycle = new CognitiveCycle({
      fileStore,
      idleTimeout: 0,
    });

    zeroCycle.recordToolCall('apex_recall', 10);
    expect(zeroCycle.getCurrentPhase()).toBe('perceive');

    // Next call will see timestamp gap > 0ms timeout, triggering reset
    zeroCycle.recordToolCall('apex_plan_context', 10);
    // The cycle should have been reset before processing the new call
    // So the new call starts a fresh cycle from idle→decide
    expect(zeroCycle.getCurrentPhase()).toBe('decide');

    // The previous cycle should have been finalized as partial
    const metrics = zeroCycle.getMetrics();
    expect(metrics.partialCycles).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // 8. getPhaseContext returns meaningful context string
  // -----------------------------------------------------------------------
  it('returns meaningful phase context strings', () => {
    // Idle context
    const idleCtx = cycle.getPhaseContext();
    expect(idleCtx).toContain('IDLE');
    expect(idleCtx).toContain('perception');

    // After perceive
    cycle.recordToolCall('apex_recall', 10);
    const perceiveCtx = cycle.getPhaseContext();
    expect(perceiveCtx).toContain('PERCEIVE');
    expect(perceiveCtx).toContain('DECIDE');
    expect(perceiveCtx).toContain('apex_recall');

    // After decide
    cycle.recordToolCall('apex_plan_context', 10);
    const decideCtx = cycle.getPhaseContext();
    expect(decideCtx).toContain('DECIDE');
    expect(decideCtx).toContain('quality');
  });

  // -----------------------------------------------------------------------
  // 9. getMetrics aggregates correctly
  // -----------------------------------------------------------------------
  it('aggregates metrics correctly across tool calls', () => {
    cycle.recordToolCall('apex_recall', 100);
    cycle.recordToolCall('apex_recall', 200);
    cycle.recordToolCall('apex_plan_context', 50);
    cycle.recordToolCall('apex_record', 30);
    cycle.recordToolCall('apex_foresight_resolve', 20);

    const metrics = cycle.getMetrics();

    // Average phase time for perceive: (100+200)/2 = 150
    expect(metrics.avgPhaseTime.perceive).toBe(150);
    expect(metrics.avgPhaseTime.decide).toBe(50);
    expect(metrics.avgPhaseTime.act).toBe(30);
    expect(metrics.avgPhaseTime.learn).toBe(20);

    expect(metrics.completedCycles).toBe(1);
    expect(metrics.currentPhase).toBe('learn');

    // Tool counts
    expect(metrics.toolsPerPhase.perceive['apex_recall']).toBe(2);
    expect(metrics.toolsPerPhase.decide['apex_plan_context']).toBe(1);

    // Transition counts
    expect(metrics.phaseTransitionCounts['idle→perceive']).toBe(1);
    expect(metrics.phaseTransitionCounts['perceive→decide']).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 10. persist and reload preserves state
  // -----------------------------------------------------------------------
  it('persists and reloads state correctly', async () => {
    cycle.recordToolCall('apex_recall', 100);
    cycle.recordToolCall('apex_plan_context', 50);
    cycle.recordToolCall('apex_record', 30);
    cycle.recordToolCall('apex_foresight_resolve', 20);

    await cycle.persist();

    // Create a new cycle instance and load from same store
    const cycle2 = new CognitiveCycle({ fileStore });
    await cycle2.init();

    const metrics = cycle2.getMetrics();
    expect(metrics.completedCycles).toBe(1);
    expect(metrics.avgPhaseTime.perceive).toBe(100);

    // Events should be preserved
    const history = cycle2.getCycleHistory();
    expect(history).toHaveLength(4);
    expect(history[0].toolName).toBe('apex_recall');
  });
});
