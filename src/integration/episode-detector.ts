/**
 * Automatic Episode Detector for APEX Real-Time Learning Signals (Phase 20)
 *
 * Detects natural task boundaries from MCP tool call sequences using
 * configurable pattern rules. Patterns like "recall → plan → execute"
 * indicate one complete episode without requiring manual apex_record calls.
 *
 * Pure computation — zero LLM calls.
 */

import { generateId } from '../types.js';
import { Logger } from '../utils/logger.js';
import type { TelemetryEvent } from './telemetry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A detection rule that matches a sequence of tool calls. */
export interface DetectionRule {
  id: string;
  name: string;
  description: string;
  /** Tool name patterns in order. Supports '*' wildcard and 'tool+' for one-or-more. */
  pattern: string[];
  /** Minimum confidence to trigger (0-1). */
  minConfidence: number;
}

/** A detected episode boundary. */
export interface DetectedEpisode {
  id: string;
  ruleId: string;
  ruleName: string;
  startIndex: number;
  endIndex: number;
  events: TelemetryEvent[];
  confidence: number;
  task: string;
  success: boolean;
  timestamp: number;
}

export interface EpisodeDetectorOptions {
  logger?: Logger;
  customRules?: DetectionRule[];
}

// ---------------------------------------------------------------------------
// Default Rules
// ---------------------------------------------------------------------------

const DEFAULT_RULES: DetectionRule[] = [
  {
    id: 'recall-plan-execute',
    name: 'Recall-Plan-Execute',
    description: 'Recall context, plan, then execute actions',
    pattern: ['apex_recall', 'apex_plan_context', '*'],
    minConfidence: 0.7,
  },
  {
    id: 'record-reflect',
    name: 'Record-Reflect',
    description: 'Record an episode then reflect on it',
    pattern: ['apex_record', 'apex_reflect_*'],
    minConfidence: 0.8,
  },
  {
    id: 'recall-record',
    name: 'Recall-Record',
    description: 'Recall context then record outcome',
    pattern: ['apex_recall', '*', 'apex_record'],
    minConfidence: 0.6,
  },
  {
    id: 'skill-search-store',
    name: 'Skill-Search-Store',
    description: 'Search skills then store a new one',
    pattern: ['apex_skills', '*', 'apex_skill_store'],
    minConfidence: 0.7,
  },
  {
    id: 'setup-recall',
    name: 'Setup-Recall',
    description: 'Initialize project then recall context',
    pattern: ['apex_setup', 'apex_recall'],
    minConfidence: 0.9,
  },
];

// ---------------------------------------------------------------------------
// EpisodeDetector
// ---------------------------------------------------------------------------

export class EpisodeDetector {
  private readonly rules: DetectionRule[];
  private readonly logger: Logger;

  constructor(options: EpisodeDetectorOptions = {}) {
    this.logger = options.logger ?? new Logger({ prefix: 'apex:episode-detector' });
    this.rules = [...DEFAULT_RULES, ...(options.customRules ?? [])];
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Scan a sequence of telemetry events and detect episode boundaries.
   *
   * Returns non-overlapping matches sorted by startIndex. Earlier matches
   * take priority when overlaps occur.
   */
  detect(events: TelemetryEvent[]): DetectedEpisode[] {
    if (events.length === 0) return [];

    const allMatches: DetectedEpisode[] = [];

    for (const rule of this.rules) {
      const ruleMatches = this.findRuleMatches(events, rule);
      allMatches.push(...ruleMatches);
    }

    // Sort by startIndex, then by confidence descending for tie-breaking
    allMatches.sort((a, b) => a.startIndex - b.startIndex || b.confidence - a.confidence);

    // Remove overlapping matches (earlier / higher-confidence takes priority)
    const result: DetectedEpisode[] = [];
    const claimed = new Set<number>();

    for (const match of allMatches) {
      let overlaps = false;
      for (let i = match.startIndex; i <= match.endIndex; i++) {
        if (claimed.has(i)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      for (let i = match.startIndex; i <= match.endIndex; i++) {
        claimed.add(i);
      }
      result.push(match);
    }

    return result.sort((a, b) => a.startIndex - b.startIndex);
  }

  /**
   * Test whether a tool name matches a single pattern element.
   *
   * - Exact match: `pattern === toolName`
   * - Wildcard: `pattern === '*'` matches anything
   * - Prefix wildcard: pattern ends with `*` and toolName starts with the prefix
   */
  matchesPattern(toolName: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
      return toolName.startsWith(pattern.slice(0, -1));
    }
    return pattern === toolName;
  }

  /** Return all currently registered rules. */
  getRules(): DetectionRule[] {
    return [...this.rules];
  }

  /** Add a custom detection rule. */
  addRule(rule: DetectionRule): void {
    this.rules.push(rule);
    this.logger.debug('Added custom detection rule', { ruleId: rule.id, name: rule.name });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Find all matches for a single rule across the event sequence using a
   * sliding-window approach.
   */
  private findRuleMatches(events: TelemetryEvent[], rule: DetectionRule): DetectedEpisode[] {
    const matches: DetectedEpisode[] = [];
    const pattern = rule.pattern;
    if (pattern.length === 0) return matches;

    let eventIdx = 0;
    while (eventIdx < events.length) {
      const matchResult = this.tryMatchAt(events, eventIdx, pattern);
      if (matchResult !== null) {
        const { endIndex } = matchResult;
        const matchedEvents = events.slice(eventIdx, endIndex + 1);
        const successCount = matchedEvents.filter((e) => e.success).length;
        const confidence = rule.minConfidence * (successCount / matchedEvents.length);

        const firstEvent = matchedEvents[0];
        const lastEvent = matchedEvents[matchedEvents.length - 1];
        const task = this.inferTask(firstEvent);

        matches.push({
          id: generateId(),
          ruleId: rule.id,
          ruleName: rule.name,
          startIndex: eventIdx,
          endIndex,
          events: matchedEvents,
          confidence,
          task,
          success: lastEvent.success,
          timestamp: firstEvent.timestamp,
        });

        // Advance past this match
        eventIdx = endIndex + 1;
      } else {
        eventIdx++;
      }
    }

    return matches;
  }

  /**
   * Attempt to match the pattern starting at `startIdx` in the event array.
   * Returns the endIndex (inclusive) if matched, or null.
   */
  private tryMatchAt(
    events: TelemetryEvent[],
    startIdx: number,
    pattern: string[],
  ): { endIndex: number } | null {
    let eventIdx = startIdx;

    for (let patIdx = 0; patIdx < pattern.length; patIdx++) {
      if (eventIdx >= events.length) return null;

      let pat = pattern[patIdx];
      const isOneOrMore = pat.endsWith('+');
      if (isOneOrMore) {
        pat = pat.slice(0, -1);
      }

      if (isOneOrMore) {
        // Must match at least one event
        if (!this.matchesPattern(events[eventIdx].toolName, pat)) return null;
        eventIdx++;
        // Consume additional consecutive matches
        while (eventIdx < events.length && this.matchesPattern(events[eventIdx].toolName, pat)) {
          eventIdx++;
        }
      } else {
        if (!this.matchesPattern(events[eventIdx].toolName, pat)) return null;
        eventIdx++;
      }
    }

    return { endIndex: eventIdx - 1 };
  }

  /** Infer a task description from the first event's arguments or tool name. */
  private inferTask(event: TelemetryEvent): string {
    if (event.args) {
      if (typeof event.args.task === 'string' && event.args.task) return event.args.task;
      if (typeof event.args.query === 'string' && event.args.query) return event.args.query;
    }
    return event.toolName;
  }
}
