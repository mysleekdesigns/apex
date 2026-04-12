/**
 * Tests for TelemetryCollector (Phase 20 — Real-Time Learning Signals)
 *
 * Verifies ring-buffer behaviour, stats aggregation, call-rate computation,
 * argument sanitisation, and FileStore persistence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelemetryCollector, TelemetryEvent } from './telemetry.js';

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

function makeEvent(toolName: string, success = true, durationMs = 100): Omit<TelemetryEvent, 'id'> {
  return { toolName, timestamp: Date.now(), durationMs, success };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelemetryCollector', () => {
  let fileStore: ReturnType<typeof createMockFileStore>;
  let logger: ReturnType<typeof createMockLogger>;
  let collector: TelemetryCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    fileStore = createMockFileStore();
    logger = createMockLogger();
    collector = new TelemetryCollector({
      fileStore: fileStore as any,
      logger,
      sessionId: 'test-session',
      maxBufferSize: 10,
    });
  });

  // 1
  it('recordToolCall creates event with correct fields', () => {
    const event = collector.recordToolCall('apex_recall', 42, true, { query: 'test' }, 'found 3 results');

    expect(event.id).toBeDefined();
    expect(event.toolName).toBe('apex_recall');
    expect(event.durationMs).toBe(42);
    expect(event.success).toBe(true);
    expect(event.args).toEqual({ query: 'test' });
    expect(event.resultSummary).toBe('found 3 results');
    expect(event.timestamp).toBeGreaterThan(0);
  });

  // 2
  it('recordToolCall sanitizes args by truncating long string values', () => {
    const longValue = 'x'.repeat(300);
    const event = collector.recordToolCall('apex_record', 10, true, {
      short: 'ok',
      long: longValue,
      num: 42,
    });

    expect(event.args!.short).toBe('ok');
    expect(event.args!.long).toBe('[truncated]');
    expect(event.args!.num).toBe(42);
  });

  // 3
  it('ring buffer enforces maxBufferSize, dropping oldest events', () => {
    // maxBufferSize is 10
    for (let i = 0; i < 15; i++) {
      collector.recordToolCall(`tool-${i}`, 10, true);
    }

    const buffer = collector.getBuffer();
    expect(buffer.length).toBe(10);
    // Oldest events (0-4) should have been evicted
    expect(buffer[0].toolName).toBe('tool-5');
    expect(buffer[9].toolName).toBe('tool-14');
  });

  // 4
  it('getRecentEvents returns newest first and respects limit', () => {
    collector.recordToolCall('first', 10, true);
    collector.recordToolCall('second', 10, true);
    collector.recordToolCall('third', 10, true);

    const all = collector.getRecentEvents();
    expect(all[0].toolName).toBe('third');
    expect(all[2].toolName).toBe('first');

    const limited = collector.getRecentEvents(2);
    expect(limited).toHaveLength(2);
    expect(limited[0].toolName).toBe('third');
    expect(limited[1].toolName).toBe('second');
  });

  // 5
  it('getToolSequence returns ordered tool names', () => {
    collector.recordToolCall('apex_recall', 10, true);
    collector.recordToolCall('apex_plan_context', 20, true);
    collector.recordToolCall('apex_record', 30, true);

    expect(collector.getToolSequence()).toEqual([
      'apex_recall',
      'apex_plan_context',
      'apex_record',
    ]);
  });

  // 6
  it('getToolStats returns correct aggregation per tool', () => {
    collector.recordToolCall('apex_recall', 100, true);
    collector.recordToolCall('apex_recall', 200, false);
    collector.recordToolCall('apex_record', 50, true);

    const stats = collector.getToolStats();
    const recallStats = stats.find((s) => s.toolName === 'apex_recall')!;
    const recordStats = stats.find((s) => s.toolName === 'apex_record')!;

    expect(recallStats.callCount).toBe(2);
    expect(recallStats.successCount).toBe(1);
    expect(recallStats.failureCount).toBe(1);
    expect(recallStats.successRate).toBe(0.5);
    expect(recallStats.avgDurationMs).toBe(150);

    expect(recordStats.callCount).toBe(1);
    expect(recordStats.successCount).toBe(1);
    expect(recordStats.successRate).toBe(1);

    // Sorted by callCount descending
    expect(stats[0].toolName).toBe('apex_recall');
  });

  // 7
  it('getSummary populates all fields correctly', () => {
    collector.recordToolCall('apex_recall', 100, true);
    collector.recordToolCall('apex_record', 50, false);

    const summary = collector.getSummary();

    expect(summary.sessionId).toBe('test-session');
    expect(summary.startTime).toBeGreaterThan(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary.totalEvents).toBe(2);
    expect(summary.toolSequence).toEqual(['apex_recall', 'apex_record']);
    expect(summary.toolStats).toHaveLength(2);
    expect(summary.errorsEncountered).toBe(1);
    expect(typeof summary.peakCallRate).toBe('number');
  });

  // 8
  it('getCallRate computes events per minute within the window', () => {
    // Record events with current timestamps (all within the default 60s window)
    collector.recordToolCall('tool-a', 10, true);
    collector.recordToolCall('tool-b', 10, true);
    collector.recordToolCall('tool-c', 10, true);

    const rate = collector.getCallRate();
    // 3 events within the 60s window => 3 per minute
    expect(rate).toBe(3);
  });

  // 9
  it('flush persists buffer and summary to FileStore', async () => {
    collector.recordToolCall('apex_recall', 100, true);
    collector.recordToolCall('apex_record', 50, true);

    await collector.flush();

    expect(fileStore.write).toHaveBeenCalledTimes(1);
    expect(fileStore.write).toHaveBeenCalledWith(
      'telemetry',
      'test-session',
      expect.objectContaining({
        sessionId: 'test-session',
        events: expect.any(Array),
        summary: expect.objectContaining({
          sessionId: 'test-session',
          totalEvents: 2,
        }),
      }),
    );
  });

  // 10
  it('clear empties the buffer', () => {
    collector.recordToolCall('apex_recall', 10, true);
    collector.recordToolCall('apex_record', 20, true);
    expect(collector.getBuffer().length).toBe(2);

    collector.clear();

    expect(collector.getBuffer().length).toBe(0);
    expect(collector.getRecentEvents()).toEqual([]);
    expect(collector.getToolSequence()).toEqual([]);
  });
});
