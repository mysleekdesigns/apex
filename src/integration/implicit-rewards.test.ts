/**
 * Tests for ImplicitRewardEngine (Phase 20 — Real-Time Learning Signals)
 *
 * Verifies reward signal derivation from tool-call telemetry, episode-level
 * composite reward computation, session summary aggregation, and persistence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImplicitRewardEngine } from './implicit-rewards.js';
import type { TelemetryEvent } from './telemetry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFileStore() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    init: vi.fn(async () => {}),
    write: vi.fn(async (collection: string, id: string, data: unknown) => {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(id, data);
    }),
    read: vi.fn(async (collection: string, id: string) => {
      return store.get(collection)?.get(id) ?? null;
    }),
    readAll: vi.fn(async (collection: string) => {
      const entries = store.get(collection);
      if (!entries) return {};
      const result: Record<string, unknown> = {};
      entries.forEach((val, key) => { result[key] = val; });
      return result;
    }),
    list: vi.fn(async (collection: string) => {
      const entries = store.get(collection);
      return entries ? Array.from(entries.keys()) : [];
    }),
    delete: vi.fn(async (collection: string, id: string) => {
      store.get(collection)?.delete(id);
    }),
    _store: store,
  };
}

function createMockLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

let seqCounter = 0;

function makeEvent(toolName: string, success = true, durationMs = 100): TelemetryEvent {
  seqCounter++;
  return {
    id: `evt-${seqCounter}-${Math.random().toString(36).slice(2, 8)}`,
    toolName,
    timestamp: Date.now() + seqCounter,
    durationMs,
    success,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImplicitRewardEngine', () => {
  let fileStore: ReturnType<typeof createMockFileStore>;
  let logger: ReturnType<typeof createMockLogger>;
  let engine: ImplicitRewardEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    seqCounter = 0;
    fileStore = createMockFileStore();
    logger = createMockLogger();
    engine = new ImplicitRewardEngine({
      fileStore: fileStore as any,
      logger,
    });
  });

  // 1
  it('deriveSignals emits positive signal for successful recall-record sequence', () => {
    const events = [
      makeEvent('apex_recall', true),
      makeEvent('apex_record', true),
    ];

    const signals = engine.deriveSignals(events);

    expect(signals.length).toBeGreaterThan(0);
    const positive = signals.filter((s) => s.type === 'positive');
    expect(positive.length).toBeGreaterThan(0);
    expect(positive[0].magnitude).toBeGreaterThan(0);
    expect(positive[0].source).toBeDefined();
  });

  // 2
  it('deriveSignals emits negative signal for failed tool call', () => {
    const events = [
      makeEvent('apex_recall', false),
    ];

    const signals = engine.deriveSignals(events);

    expect(signals.length).toBeGreaterThan(0);
    const negative = signals.filter((s) => s.type === 'negative');
    expect(negative.length).toBeGreaterThan(0);
    expect(negative[0].magnitude).toBeGreaterThan(0);
    expect(negative[0].toolName).toBe('apex_recall');
  });

  // 3
  it('deriveSignals emits positive signal for skill interactions', () => {
    const events = [
      makeEvent('apex_skills', true),
      makeEvent('apex_skill_store', true),
    ];

    const signals = engine.deriveSignals(events);

    expect(signals.length).toBeGreaterThan(0);
    const positive = signals.filter((s) => s.type === 'positive');
    expect(positive.length).toBeGreaterThan(0);
  });

  // 4
  it('deriveSignals emits positive signal for reflection', () => {
    const events = [
      makeEvent('apex_reflect_store', true),
    ];

    const signals = engine.deriveSignals(events);

    expect(signals.length).toBeGreaterThan(0);
    const positive = signals.filter((s) => s.type === 'positive');
    expect(positive.length).toBeGreaterThan(0);
  });

  // 5
  it('deriveSignals emits high-magnitude negative signal for repeated failures', () => {
    const events = [
      makeEvent('apex_recall', false),
      makeEvent('apex_recall', false),
      makeEvent('apex_recall', false),
    ];

    const signals = engine.deriveSignals(events);

    const negative = signals.filter((s) => s.type === 'negative');
    expect(negative.length).toBeGreaterThan(0);

    // Repeated failures should produce higher total magnitude than a single failure
    const singleFailSignals = engine.deriveSignals([makeEvent('apex_recall', false)]);
    const singleNegMag = singleFailSignals
      .filter((s) => s.type === 'negative')
      .reduce((sum, s) => sum + s.magnitude, 0);
    const repeatedNegMag = negative.reduce((sum, s) => sum + s.magnitude, 0);

    expect(repeatedNegMag).toBeGreaterThan(singleNegMag);
  });

  // 6
  it('deriveSignals handles slow execution as neutral or negative signal', () => {
    const events = [
      makeEvent('apex_recall', true, 31000), // 31 seconds — unusually slow
    ];

    const signals = engine.deriveSignals(events);

    expect(signals.length).toBeGreaterThan(0);
    // Slow but successful call should generate a neutral or negative timing signal
    const timingSignal = signals.find(
      (s) => s.type === 'neutral' || s.type === 'negative',
    );
    expect(timingSignal).toBeDefined();
  });

  // 7
  it('computeEpisodeReward returns positive compositeReward for successful episode', () => {
    const events = [
      makeEvent('apex_recall', true),
      makeEvent('apex_plan_context', true),
      makeEvent('apex_record', true),
    ];

    const reward = engine.computeEpisodeReward('ep-1', events);

    expect(reward.episodeId).toBe('ep-1');
    expect(reward.compositeReward).toBeGreaterThan(0);
    expect(reward.positiveCount).toBeGreaterThan(0);
    expect(reward.signals.length).toBeGreaterThan(0);
  });

  // 8
  it('computeEpisodeReward returns negative compositeReward for failed episode', () => {
    const events = [
      makeEvent('apex_recall', false),
      makeEvent('apex_record', false),
    ];

    const reward = engine.computeEpisodeReward('ep-2', events);

    expect(reward.episodeId).toBe('ep-2');
    expect(reward.compositeReward).toBeLessThan(0);
    expect(reward.negativeCount).toBeGreaterThan(0);
  });

  // 9
  it('getSessionSummary aggregates signals correctly', () => {
    // Derive some signals first
    const events1 = [makeEvent('apex_recall', true), makeEvent('apex_record', true)];
    const events2 = [makeEvent('apex_recall', false)];
    engine.deriveSignals(events1);
    engine.deriveSignals(events2);

    const summary = engine.getSessionSummary('session-1', 60000);

    expect(summary.sessionId).toBe('session-1');
    expect(summary.durationMs).toBe(60000);
    expect(summary.totalSignals).toBeGreaterThan(0);
    expect(summary.totalSignals).toBe(
      summary.positiveSignals + summary.negativeSignals + summary.neutralSignals,
    );
    expect(typeof summary.avgReward).toBe('number');
  });

  // 10
  it('flush persists session reward data to FileStore', async () => {
    const events = [makeEvent('apex_recall', true), makeEvent('apex_record', true)];
    engine.deriveSignals(events);

    await engine.flush('session-1');

    expect(fileStore.write).toHaveBeenCalled();
    const [collection, id] = fileStore.write.mock.calls[0];
    expect(collection).toContain('reward');
    expect(id).toBe('session-1');
  });
});
