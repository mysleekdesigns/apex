/**
 * Implicit Reward Signal Engine for APEX Real-Time Learning Signals (Phase 20)
 *
 * Derives learning reward signals from MCP tool call outcomes without
 * requiring explicit apex_record calls. Maps common patterns (successful
 * recall→record cycles, skill reuse, repeated failures) to positive,
 * negative, or neutral reward signals.
 *
 * Pure computation + FileStore persistence — zero LLM calls.
 */

import { generateId } from '../types.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';
import type { TelemetryEvent } from './telemetry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A signal derived from tool call outcomes. */
export interface RewardSignal {
  id: string;
  type: 'positive' | 'negative' | 'neutral';
  source: string;
  magnitude: number;
  toolName: string;
  description: string;
  timestamp: number;
  relatedEventIds: string[];
}

/** Aggregated reward for a detected episode. */
export interface EpisodeReward {
  episodeId: string;
  signals: RewardSignal[];
  compositeReward: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
}

/** A session-level summary of all rewards. */
export interface SessionRewardSummary {
  sessionId: string;
  totalSignals: number;
  positiveSignals: number;
  negativeSignals: number;
  neutralSignals: number;
  avgReward: number;
  episodeRewards: EpisodeReward[];
  toolsUsed: string[];
  errorsEncountered: string[];
  durationMs: number;
}

export interface ImplicitRewardOptions {
  fileStore: FileStore;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// ImplicitRewardEngine
// ---------------------------------------------------------------------------

export class ImplicitRewardEngine {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private signals: RewardSignal[] = [];

  constructor(options: ImplicitRewardOptions) {
    this.fileStore = options.fileStore;
    this.logger = options.logger ?? new Logger({ prefix: 'apex:implicit-rewards' });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Process a batch of telemetry events and extract reward signals.
   *
   * Applies the following signal rules:
   * 1. Successful record after recall → positive (0.8)
   * 2. Failed tool call → negative (0.5)
   * 3. Skill library interaction → positive (0.6)
   * 4. Reflection stored → positive (0.7)
   * 5. Consolidation completed → positive (0.5)
   * 6. Rapid repeated failures (3+) → negative (0.9)
   * 7. Slow tool execution (>30s) → neutral (0.3)
   *
   * @returns Only the newly created signals from this batch.
   */
  deriveSignals(events: TelemetryEvent[]): RewardSignal[] {
    const newSignals: RewardSignal[] = [];

    // Track consecutive failures for rule 6
    let consecutiveFailures = 0;
    let consecutiveFailureStart = -1;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      // Rule 1: Successful record after recall
      if (
        event.toolName === 'apex_record' &&
        event.success &&
        this.hasPrecedingTool(events, i, 'apex_recall')
      ) {
        newSignals.push(this.createSignal(
          'positive',
          'recall-record-cycle',
          0.8,
          event.toolName,
          'Successful recall-record cycle',
          event.timestamp,
          [event.id, this.findPrecedingEventId(events, i, 'apex_recall')],
        ));
      }

      // Rule 2: Failed tool call
      if (!event.success) {
        newSignals.push(this.createSignal(
          'negative',
          'tool-failure',
          0.5,
          event.toolName,
          `Tool call failed: ${event.toolName}`,
          event.timestamp,
          [event.id],
        ));
      }

      // Rule 3: Skill library interaction
      if (
        (event.toolName === 'apex_skills' || event.toolName === 'apex_skill_store') &&
        event.success
      ) {
        newSignals.push(this.createSignal(
          'positive',
          'skill-interaction',
          0.6,
          event.toolName,
          'Skill library interaction',
          event.timestamp,
          [event.id],
        ));
      }

      // Rule 4: Reflection stored
      if (event.toolName === 'apex_reflect_store' && event.success) {
        newSignals.push(this.createSignal(
          'positive',
          'reflection-captured',
          0.7,
          event.toolName,
          'Reflection captured',
          event.timestamp,
          [event.id],
        ));
      }

      // Rule 5: Consolidation completed
      if (event.toolName === 'apex_consolidate' && event.success) {
        newSignals.push(this.createSignal(
          'positive',
          'consolidation',
          0.5,
          event.toolName,
          'Memory consolidated',
          event.timestamp,
          [event.id],
        ));
      }

      // Rule 6: Track consecutive failures
      if (!event.success) {
        if (consecutiveFailures === 0) consecutiveFailureStart = i;
        consecutiveFailures++;

        if (consecutiveFailures >= 3) {
          const failedIds = events
            .slice(consecutiveFailureStart, i + 1)
            .map((e) => e.id);
          newSignals.push(this.createSignal(
            'negative',
            'repeated-failures',
            0.9,
            event.toolName,
            'Repeated failures detected',
            event.timestamp,
            failedIds,
          ));
          // Reset so we don't fire again for each subsequent failure in the same run
          consecutiveFailures = 0;
          consecutiveFailureStart = -1;
        }
      } else {
        consecutiveFailures = 0;
        consecutiveFailureStart = -1;
      }

      // Rule 7: Long duration warning
      if (event.durationMs > 30_000) {
        newSignals.push(this.createSignal(
          'neutral',
          'slow-execution',
          0.3,
          event.toolName,
          'Slow tool execution',
          event.timestamp,
          [event.id],
        ));
      }
    }

    this.signals.push(...newSignals);
    this.logger.debug('Derived reward signals', {
      newCount: newSignals.length,
      totalCount: this.signals.length,
    });

    return newSignals;
  }

  /**
   * Compute an aggregated reward for a detected episode.
   *
   * Derives signals from the given events and returns a composite reward
   * clamped to [-1, 1].
   */
  computeEpisodeReward(episodeId: string, events: TelemetryEvent[]): EpisodeReward {
    const signals = this.deriveSignals(events);
    return this.buildEpisodeReward(episodeId, signals);
  }

  /**
   * Build a session-level summary of all accumulated reward signals.
   */
  getSessionSummary(sessionId: string, durationMs: number): SessionRewardSummary {
    const positive = this.signals.filter((s) => s.type === 'positive');
    const negative = this.signals.filter((s) => s.type === 'negative');
    const neutral = this.signals.filter((s) => s.type === 'neutral');

    const totalMagnitude = this.signals.reduce((sum, s) => {
      if (s.type === 'positive') return sum + s.magnitude;
      if (s.type === 'negative') return sum - s.magnitude;
      return sum;
    }, 0);

    const avgReward = this.signals.length > 0 ? totalMagnitude / this.signals.length : 0;

    const toolsUsed = Array.from(new Set(this.signals.map((s) => s.toolName)));
    const errorsEncountered = negative.map((s) => s.description);

    return {
      sessionId,
      totalSignals: this.signals.length,
      positiveSignals: positive.length,
      negativeSignals: negative.length,
      neutralSignals: neutral.length,
      avgReward: Math.max(-1, Math.min(1, avgReward)),
      episodeRewards: [],
      toolsUsed,
      errorsEncountered,
      durationMs,
    };
  }

  /** Return all signals accumulated in the current session. */
  getSignals(): readonly RewardSignal[] {
    return this.signals;
  }

  /**
   * Persist accumulated signals and session summary to FileStore.
   *
   * @param sessionId - Identifier for the current session (used as document ID).
   */
  async flush(sessionId: string): Promise<void> {
    const durationMs =
      this.signals.length > 0
        ? this.signals[this.signals.length - 1].timestamp - this.signals[0].timestamp
        : 0;

    const summary = this.getSessionSummary(sessionId, durationMs);
    const payload = {
      sessionId,
      signals: [...this.signals],
      summary,
    };

    await this.fileStore.write('implicit-rewards', sessionId, payload);
    this.logger.info('Flushed implicit rewards to store', {
      sessionId,
      signalCount: this.signals.length,
    });
  }

  /** Clear all accumulated signals for the current session. */
  clear(): void {
    this.signals = [];
    this.logger.debug('Cleared implicit reward signals');
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Create a RewardSignal with a unique ID. */
  private createSignal(
    type: RewardSignal['type'],
    source: string,
    magnitude: number,
    toolName: string,
    description: string,
    timestamp: number,
    relatedEventIds: string[],
  ): RewardSignal {
    return {
      id: generateId(),
      type,
      source,
      magnitude,
      toolName,
      description,
      timestamp,
      relatedEventIds,
    };
  }

  /** Check if a tool with the given name appears before index `i` in the events. */
  private hasPrecedingTool(events: TelemetryEvent[], i: number, toolName: string): boolean {
    for (let j = i - 1; j >= 0; j--) {
      if (events[j].toolName === toolName && events[j].success) return true;
    }
    return false;
  }

  /** Find the ID of the most recent preceding event with the given tool name. */
  private findPrecedingEventId(events: TelemetryEvent[], i: number, toolName: string): string {
    for (let j = i - 1; j >= 0; j--) {
      if (events[j].toolName === toolName) return events[j].id;
    }
    return '';
  }

  /** Build an EpisodeReward from a set of signals. */
  private buildEpisodeReward(episodeId: string, signals: RewardSignal[]): EpisodeReward {
    const positiveSum = signals
      .filter((s) => s.type === 'positive')
      .reduce((sum, s) => sum + s.magnitude, 0);
    const negativeSum = signals
      .filter((s) => s.type === 'negative')
      .reduce((sum, s) => sum + s.magnitude, 0);

    const total = Math.max(1, signals.length);
    const raw = (positiveSum - negativeSum) / total;
    const compositeReward = Math.max(-1, Math.min(1, raw));

    return {
      episodeId,
      signals,
      compositeReward,
      positiveCount: signals.filter((s) => s.type === 'positive').length,
      negativeCount: signals.filter((s) => s.type === 'negative').length,
      neutralCount: signals.filter((s) => s.type === 'neutral').length,
    };
  }
}
