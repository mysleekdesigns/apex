/**
 * Tests for EpisodeDetector (Phase 20 — Real-Time Learning Signals)
 *
 * Verifies pattern matching, default rule inventory, episode detection from
 * tool-call sequences, overlap resolution, and task/success inference.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EpisodeDetector, DetectionRule } from './episode-detector.js';
import type { TelemetryEvent } from './telemetry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

let seqCounter = 0;

function makeEvent(toolName: string, success = true, args?: Record<string, unknown>): TelemetryEvent {
  seqCounter++;
  return {
    id: `evt-${seqCounter}-${Math.random().toString(36).slice(2, 8)}`,
    toolName,
    timestamp: Date.now() + seqCounter,
    durationMs: 100,
    success,
    args,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EpisodeDetector', () => {
  let detector: EpisodeDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    seqCounter = 0;
    detector = new EpisodeDetector({ logger: createMockLogger() });
  });

  // 1
  it('getRules returns at least 5 default rules', () => {
    const rules = detector.getRules();
    expect(rules.length).toBeGreaterThanOrEqual(5);
    // Verify each rule has required fields
    for (const rule of rules) {
      expect(rule.id).toBeDefined();
      expect(rule.name).toBeDefined();
      expect(rule.pattern.length).toBeGreaterThan(0);
      expect(rule.minConfidence).toBeGreaterThan(0);
    }
  });

  // 2
  it('addRule increases the rule count', () => {
    const initialCount = detector.getRules().length;
    const customRule: DetectionRule = {
      id: 'custom-test',
      name: 'Custom Test Rule',
      description: 'A custom rule for testing',
      pattern: ['tool_a', 'tool_b'],
      minConfidence: 0.5,
    };

    detector.addRule(customRule);

    expect(detector.getRules().length).toBe(initialCount + 1);
    expect(detector.getRules().find((r) => r.id === 'custom-test')).toBeDefined();
  });

  // 3
  it('matchesPattern handles exact match', () => {
    expect(detector.matchesPattern('apex_recall', 'apex_recall')).toBe(true);
    expect(detector.matchesPattern('apex_recall', 'apex_record')).toBe(false);
  });

  // 4
  it('matchesPattern wildcard * matches anything', () => {
    expect(detector.matchesPattern('apex_recall', '*')).toBe(true);
    expect(detector.matchesPattern('any_tool_name', '*')).toBe(true);
    expect(detector.matchesPattern('', '*')).toBe(true);
  });

  // 5
  it('matchesPattern prefix wildcard matches tool names starting with prefix', () => {
    expect(detector.matchesPattern('apex_reflect_store', 'apex_reflect_*')).toBe(true);
    expect(detector.matchesPattern('apex_reflect_get', 'apex_reflect_*')).toBe(true);
    expect(detector.matchesPattern('apex_record', 'apex_reflect_*')).toBe(false);
  });

  // 6
  it('detect finds recall-plan-execute pattern', () => {
    const events = [
      makeEvent('apex_recall'),
      makeEvent('apex_plan_context'),
      makeEvent('apex_record'),
    ];

    const episodes = detector.detect(events);

    expect(episodes.length).toBeGreaterThanOrEqual(1);
    const rpe = episodes.find((e) => e.ruleId === 'recall-plan-execute');
    expect(rpe).toBeDefined();
    expect(rpe!.events.length).toBe(3);
    expect(rpe!.startIndex).toBe(0);
    expect(rpe!.endIndex).toBe(2);
  });

  // 7
  it('detect finds record-reflect pattern', () => {
    const events = [
      makeEvent('apex_record'),
      makeEvent('apex_reflect_store'),
    ];

    const episodes = detector.detect(events);

    expect(episodes.length).toBeGreaterThanOrEqual(1);
    const rr = episodes.find((e) => e.ruleId === 'record-reflect');
    expect(rr).toBeDefined();
    expect(rr!.events.length).toBe(2);
  });

  // 8
  it('detect returns empty array for non-matching sequences', () => {
    const events = [
      makeEvent('some_random_tool'),
      makeEvent('another_random_tool'),
      makeEvent('yet_another_tool'),
    ];

    const episodes = detector.detect(events);
    expect(episodes).toEqual([]);
  });

  // 9
  it('detect resolves overlapping matches without duplication', () => {
    // Sequence: recall, plan, record, reflect_store
    // recall-plan-execute could match [0..2]
    // record-reflect could match [2..3] but index 2 is claimed
    const events = [
      makeEvent('apex_recall'),
      makeEvent('apex_plan_context'),
      makeEvent('apex_record'),
      makeEvent('apex_reflect_store'),
    ];

    const episodes = detector.detect(events);

    // Collect all claimed indices
    const claimedIndices = new Set<number>();
    for (const ep of episodes) {
      for (let i = ep.startIndex; i <= ep.endIndex; i++) {
        expect(claimedIndices.has(i)).toBe(false);
        claimedIndices.add(i);
      }
    }
    // No index is claimed more than once (verified above)
  });

  // 10
  it('detect infers task from args and success from last event', () => {
    const events = [
      makeEvent('apex_recall', true, { query: 'fix authentication bug' }),
      makeEvent('apex_plan_context', true),
      makeEvent('apex_record', false),
    ];

    const episodes = detector.detect(events);

    const rpe = episodes.find((e) => e.ruleId === 'recall-plan-execute');
    expect(rpe).toBeDefined();
    // Task inferred from first event's query arg
    expect(rpe!.task).toBe('fix authentication bug');
    // Success is based on last event
    expect(rpe!.success).toBe(false);
  });
});
