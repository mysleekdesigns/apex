/**
 * Passive Telemetry Collector for APEX Real-Time Learning Signals (Phase 20)
 *
 * Tracks MCP tool call sequences in a lightweight ring buffer. Records
 * timing, success/failure, and argument summaries for every tool call
 * without requiring manual recording.
 *
 * Used by the Episode Detector and Implicit Reward modules to derive
 * learning signals from raw tool call patterns.
 *
 * Pure data operations — zero LLM calls.
 */

import { generateId } from '../types.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single tool call record in the telemetry stream. */
export interface TelemetryEvent {
  id: string;
  toolName: string;
  timestamp: number;
  durationMs: number;
  success: boolean;
  /** Sanitized arguments — no large payloads. */
  args?: Record<string, unknown>;
  /** Short summary of the result, not the full output. */
  resultSummary?: string;
}

/** Aggregated stats for a tool over a time window. */
export interface ToolStats {
  toolName: string;
  callCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  lastCalledAt: number;
}

/** Session-level telemetry summary. */
export interface TelemetrySummary {
  sessionId: string;
  startTime: number;
  durationMs: number;
  totalEvents: number;
  /** Ordered list of tool names called. */
  toolSequence: string[];
  toolStats: ToolStats[];
  errorsEncountered: number;
  /** Maximum calls per minute observed across 60-second windows. */
  peakCallRate: number;
}

/** Options for constructing a TelemetryCollector. */
export interface TelemetryCollectorOptions {
  fileStore: FileStore;
  logger?: Logger;
  /** Maximum number of events in the ring buffer (default: 100). */
  maxBufferSize?: number;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TELEMETRY_COLLECTION = 'telemetry';
const DEFAULT_BUFFER_SIZE = 100;
const MAX_STRING_LENGTH = 200;
const ONE_MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// TelemetryCollector
// ---------------------------------------------------------------------------

export class TelemetryCollector {
  private readonly store: FileStore;
  private readonly logger: Logger;
  private readonly maxBufferSize: number;
  private readonly buffer: TelemetryEvent[] = [];

  readonly sessionId: string;
  readonly startTime: number;

  constructor(options: TelemetryCollectorOptions) {
    this.store = options.fileStore;
    this.logger = options.logger ?? new Logger({ prefix: 'apex:telemetry' });
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_BUFFER_SIZE;
    this.sessionId = options.sessionId ?? `telemetry-${Date.now()}`;
    this.startTime = Date.now();
    this.logger.debug('Telemetry collector initialised', { sessionId: this.sessionId });
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------

  /**
   * Record a pre-built telemetry event. Assigns an ID and appends it to
   * the ring buffer, evicting the oldest entry if the buffer is full.
   */
  recordEvent(event: Omit<TelemetryEvent, 'id'>): TelemetryEvent {
    const full: TelemetryEvent = { id: generateId(), ...event };

    this.buffer.push(full);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    this.logger.debug('Telemetry event recorded', {
      tool: full.toolName,
      success: full.success,
      durationMs: full.durationMs,
    });

    return full;
  }

  /**
   * Convenience method to record a tool call. Sanitizes args (truncates
   * string values exceeding 200 characters) and caps resultSummary length.
   */
  recordToolCall(
    toolName: string,
    durationMs: number,
    success: boolean,
    args?: Record<string, unknown>,
    resultSummary?: string,
  ): TelemetryEvent {
    const sanitizedArgs = args ? this.sanitizeArgs(args) : undefined;
    const truncatedSummary = resultSummary
      ? this.truncate(resultSummary, MAX_STRING_LENGTH)
      : undefined;

    return this.recordEvent({
      toolName,
      timestamp: Date.now(),
      durationMs,
      success,
      args: sanitizedArgs,
      resultSummary: truncatedSummary,
    });
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Return recent events from the buffer, newest first.
   *
   * @param limit - Maximum number of events to return. Defaults to all.
   */
  getRecentEvents(limit?: number): TelemetryEvent[] {
    const reversed = [...this.buffer].reverse();
    return limit !== undefined ? reversed.slice(0, limit) : reversed;
  }

  /** Return the ordered sequence of tool names from the buffer. */
  getToolSequence(): string[] {
    return this.buffer.map((e) => e.toolName);
  }

  /**
   * Aggregate per-tool statistics from the current buffer.
   * Returns results sorted by callCount descending.
   */
  getToolStats(): ToolStats[] {
    const map = new Map<string, { durations: number[]; successes: number; failures: number; lastCalled: number }>();

    for (const event of this.buffer) {
      let entry = map.get(event.toolName);
      if (!entry) {
        entry = { durations: [], successes: 0, failures: 0, lastCalled: 0 };
        map.set(event.toolName, entry);
      }
      entry.durations.push(event.durationMs);
      if (event.success) {
        entry.successes++;
      } else {
        entry.failures++;
      }
      if (event.timestamp > entry.lastCalled) {
        entry.lastCalled = event.timestamp;
      }
    }

    const stats: ToolStats[] = [];
    for (const [toolName, entry] of map) {
      const callCount = entry.durations.length;
      const avgDurationMs = entry.durations.reduce((a, b) => a + b, 0) / callCount;
      stats.push({
        toolName,
        callCount,
        successCount: entry.successes,
        failureCount: entry.failures,
        successRate: callCount > 0 ? entry.successes / callCount : 0,
        avgDurationMs: Math.round(avgDurationMs * 100) / 100,
        lastCalledAt: entry.lastCalled,
      });
    }

    stats.sort((a, b) => b.callCount - a.callCount);
    return stats;
  }

  /** Build a full session-level telemetry summary. */
  getSummary(): TelemetrySummary {
    return {
      sessionId: this.sessionId,
      startTime: this.startTime,
      durationMs: Date.now() - this.startTime,
      totalEvents: this.buffer.length,
      toolSequence: this.getToolSequence(),
      toolStats: this.getToolStats(),
      errorsEncountered: this.buffer.filter((e) => !e.success).length,
      peakCallRate: this.computePeakCallRate(),
    };
  }

  /**
   * Compute the number of events per minute within a recent time window.
   *
   * @param windowMs - Time window in milliseconds (default: 60 000).
   */
  getCallRate(windowMs: number = ONE_MINUTE_MS): number {
    const cutoff = Date.now() - windowMs;
    const count = this.buffer.filter((e) => e.timestamp >= cutoff).length;
    return (count / windowMs) * ONE_MINUTE_MS;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Persist the current buffer and summary to FileStore. Does NOT clear
   * the buffer — it remains available for live analysis.
   */
  async flush(): Promise<void> {
    const summary = this.getSummary();
    await this.store.write(TELEMETRY_COLLECTION, this.sessionId, {
      sessionId: this.sessionId,
      events: [...this.buffer],
      summary,
    });
    this.logger.info('Telemetry flushed', {
      sessionId: this.sessionId,
      eventCount: this.buffer.length,
    });
  }

  // -----------------------------------------------------------------------
  // Buffer access
  // -----------------------------------------------------------------------

  /** Return the current buffer as a readonly array. */
  getBuffer(): readonly TelemetryEvent[] {
    return this.buffer;
  }

  /** Clear the ring buffer. */
  clear(): void {
    this.buffer.length = 0;
    this.logger.debug('Telemetry buffer cleared', { sessionId: this.sessionId });
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Sanitize argument values: replace any string value longer than
   * MAX_STRING_LENGTH with '[truncated]'.
   */
  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
        sanitized[key] = '[truncated]';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /** Truncate a string to the given maximum length. */
  private truncate(str: string, maxLength: number): string {
    return str.length > maxLength ? str.slice(0, maxLength) : str;
  }

  /**
   * Compute peak call rate by sliding a 60-second window across all
   * buffered events and returning the maximum count observed.
   */
  private computePeakCallRate(): number {
    if (this.buffer.length === 0) return 0;

    // Sort timestamps for sliding window
    const timestamps = this.buffer.map((e) => e.timestamp).sort((a, b) => a - b);

    let maxCount = 0;
    let windowStart = 0;

    for (let windowEnd = 0; windowEnd < timestamps.length; windowEnd++) {
      // Advance start pointer past the 60-second window
      while (timestamps[windowEnd] - timestamps[windowStart] > ONE_MINUTE_MS) {
        windowStart++;
      }
      const count = windowEnd - windowStart + 1;
      if (count > maxCount) {
        maxCount = count;
      }
    }

    return maxCount;
  }
}
