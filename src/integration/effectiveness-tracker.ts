/**
 * CLAUDE.md Effectiveness Tracker (Phase 8)
 *
 * Tracks which APEX tools are called per session, measures recall hit rates,
 * computes utilization metrics, and generates CLAUDE.md improvement suggestions
 * based on usage patterns.
 *
 * Pure data operations — no LLM calls, no external services.
 */

import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-session metrics snapshot. */
export interface SessionMetrics {
  /** Unique session identifier (timestamp-based). */
  sessionId: string;

  /** Unix-epoch millisecond timestamp of session start. */
  startTime: number;

  /** Duration in milliseconds (0 if session is still active). */
  durationMs: number;

  /** Map of tool name to call count for this session. */
  toolCalls: Record<string, number>;

  /** Total number of tool calls in this session. */
  totalCalls: number;

  /** Number of recall calls that returned results. */
  recallHits: number;

  /** Number of recall calls that returned empty. */
  recallMisses: number;

  /** Recall hit rate (0-1), or null if no recalls were made. */
  recallHitRate: number | null;
}

/** A suggestion for improving CLAUDE.md based on usage patterns. */
export interface EffectivenessSuggestion {
  /** Severity: 'info' for mild, 'warning' for notable, 'action' for important. */
  level: 'info' | 'warning' | 'action';

  /** The tool or area this suggestion relates to. */
  tool: string;

  /** Human-readable suggestion text. */
  message: string;
}

/** Aggregated effectiveness data across sessions. */
export interface EffectivenessReport {
  /** Metrics for the current (active) session. */
  currentSession: SessionMetrics;

  /** Number of past sessions tracked. */
  pastSessionCount: number;

  /** Suggestions for improving CLAUDE.md. */
  suggestions: EffectivenessSuggestion[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EFFECTIVENESS_COLLECTION = 'effectiveness';
const SESSIONS_DOC_ID = 'sessions';

/** All known APEX tools for utilization analysis. */
const ALL_APEX_TOOLS = [
  'apex_recall',
  'apex_record',
  'apex_reflect_get',
  'apex_reflect_store',
  'apex_plan_context',
  'apex_skills',
  'apex_skill_store',
  'apex_status',
  'apex_consolidate',
  'apex_curriculum',
  'apex_setup',
  'apex_snapshot',
  'apex_rollback',
  'apex_promote',
  'apex_import',
] as const;

/** Tools expected in a typical productive session. */
const CORE_TOOLS = [
  'apex_recall',
  'apex_record',
  'apex_reflect_get',
  'apex_reflect_store',
] as const;

// ---------------------------------------------------------------------------
// EffectivenessTracker
// ---------------------------------------------------------------------------

export class EffectivenessTracker {
  private readonly store: FileStore;
  private readonly logger: Logger;

  private readonly sessionId: string;
  private readonly startTime: number;
  private readonly toolCalls: Map<string, number> = new Map();
  private recallHits = 0;
  private recallMisses = 0;

  constructor(store: FileStore) {
    this.store = store;
    this.logger = new Logger({ prefix: 'apex:effectiveness' });
    this.startTime = Date.now();
    this.sessionId = `session-${this.startTime}`;
    this.logger.debug('Effectiveness tracker initialised', { sessionId: this.sessionId });
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------

  /**
   * Record that a tool was called.
   */
  recordToolCall(toolName: string): void {
    const current = this.toolCalls.get(toolName) ?? 0;
    this.toolCalls.set(toolName, current + 1);
    this.logger.debug('Tool call recorded', { tool: toolName, count: current + 1 });
  }

  /**
   * Record a recall event outcome.
   *
   * @param hadResults - Whether the recall returned any results.
   */
  recordRecallHit(hadResults: boolean): void {
    if (hadResults) {
      this.recallHits++;
    } else {
      this.recallMisses++;
    }
    this.logger.debug('Recall event recorded', {
      hadResults,
      hits: this.recallHits,
      misses: this.recallMisses,
    });
  }

  // -----------------------------------------------------------------------
  // Metrics
  // -----------------------------------------------------------------------

  /**
   * Get metrics for the current session.
   */
  getSessionMetrics(): SessionMetrics {
    const toolCalls: Record<string, number> = {};
    let totalCalls = 0;

    for (const [name, count] of this.toolCalls) {
      toolCalls[name] = count;
      totalCalls += count;
    }

    const totalRecalls = this.recallHits + this.recallMisses;

    return {
      sessionId: this.sessionId,
      startTime: this.startTime,
      durationMs: Date.now() - this.startTime,
      toolCalls,
      totalCalls,
      recallHits: this.recallHits,
      recallMisses: this.recallMisses,
      recallHitRate: totalRecalls > 0 ? this.recallHits / totalRecalls : null,
    };
  }

  // -----------------------------------------------------------------------
  // Suggestions
  // -----------------------------------------------------------------------

  /**
   * Generate CLAUDE.md improvement suggestions based on current usage patterns.
   */
  getSuggestions(): EffectivenessSuggestion[] {
    const suggestions: EffectivenessSuggestion[] = [];
    const metrics = this.getSessionMetrics();

    // Only generate suggestions if there's been meaningful activity
    if (metrics.totalCalls < 2) {
      return suggestions;
    }

    // Check for underutilised core tools
    for (const tool of CORE_TOOLS) {
      if (!metrics.toolCalls[tool]) {
        suggestions.push(this.suggestForMissingTool(tool));
      }
    }

    // Check recall hit rate
    const totalRecalls = this.recallHits + this.recallMisses;
    if (totalRecalls > 0 && metrics.recallHitRate !== null && metrics.recallHitRate < 0.3) {
      suggestions.push({
        level: 'warning',
        tool: 'apex_recall',
        message:
          `Recall hit rate is low (${Math.round(metrics.recallHitRate * 100)}%). ` +
          'Consider recording more episodes with apex_record so future recalls return useful context.',
      });
    }

    // Check if recording is happening without reflection
    const recordCount = metrics.toolCalls['apex_record'] ?? 0;
    const reflectCount = (metrics.toolCalls['apex_reflect_get'] ?? 0) +
      (metrics.toolCalls['apex_reflect_store'] ?? 0);
    if (recordCount >= 3 && reflectCount === 0) {
      suggestions.push({
        level: 'warning',
        tool: 'apex_reflect_get',
        message:
          `${recordCount} episodes recorded but no reflection performed. ` +
          'Add reflection after significant work or failures to extract reusable insights.',
      });
    }

    // Check if consolidation has been run
    if (metrics.totalCalls >= 10 && !metrics.toolCalls['apex_consolidate']) {
      suggestions.push({
        level: 'info',
        tool: 'apex_consolidate',
        message:
          'Consider running apex_consolidate periodically to reorganise memory tiers ' +
          '(working -> episodic -> semantic).',
      });
    }

    return suggestions;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Persist the current session metrics to the FileStore.
   */
  async persist(): Promise<void> {
    const metrics = this.getSessionMetrics();

    // Load existing sessions
    const existing = await this.store.read<{ sessions: SessionMetrics[] }>(
      EFFECTIVENESS_COLLECTION,
      SESSIONS_DOC_ID,
    );

    const sessions = existing?.sessions ?? [];

    // Keep last 50 sessions to avoid unbounded growth
    if (sessions.length >= 50) {
      sessions.splice(0, sessions.length - 49);
    }

    sessions.push(metrics);

    await this.store.write(EFFECTIVENESS_COLLECTION, SESSIONS_DOC_ID, { sessions });
    this.logger.info('Session metrics persisted', {
      sessionId: this.sessionId,
      totalCalls: metrics.totalCalls,
    });
  }

  /**
   * Get the full effectiveness report including past session count and suggestions.
   */
  async getReport(): Promise<EffectivenessReport> {
    const existing = await this.store.read<{ sessions: SessionMetrics[] }>(
      EFFECTIVENESS_COLLECTION,
      SESSIONS_DOC_ID,
    );

    return {
      currentSession: this.getSessionMetrics(),
      pastSessionCount: existing?.sessions?.length ?? 0,
      suggestions: this.getSuggestions(),
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private suggestForMissingTool(tool: string): EffectivenessSuggestion {
    const suggestions: Record<string, string> = {
      apex_recall:
        'apex_recall was not used this session. Start sessions with apex_recall to get relevant context from past work.',
      apex_record:
        'apex_record was not used this session. Record significant outcomes (successes and failures) to build memory.',
      apex_reflect_get:
        'apex_reflect_get was not used this session. Consider adding reflection after failures to identify patterns.',
      apex_reflect_store:
        'apex_reflect_store was not used this session. Store reflections to capture reusable insights.',
    };

    return {
      level: 'action',
      tool,
      message: suggestions[tool] ?? `${tool} was not used this session.`,
    };
  }
}
