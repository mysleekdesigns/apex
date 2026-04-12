/**
 * Production Rules Engine — Phase 15: Cognitive Architecture Integration
 *
 * Converts high-confidence skills into fast O(1) pattern-matchable if-then
 * production rules, inspired by SOAR/ACT-R cognitive architectures.
 */

import { randomUUID } from 'node:crypto';
import type { FileStore } from '../utils/file-store.js';
import type { Logger } from '../utils/logger.js';
import type { Skill } from '../types.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RuleCondition {
  /** Keyword patterns to match against task description. */
  patterns: string[];
  /** Task type filters (e.g., "debugging", "testing", "refactoring"). */
  taskTypes: string[];
  /** Tags that must be present in the query. */
  requiredTags: string[];
  /** Patterns to match against context/error messages. */
  contextPatterns: string[];
}

export interface RuleAction {
  /** What to do. */
  description: string;
  /** Ordered steps. */
  steps: string[];
  /** Recommended APEX tools to use. */
  toolSuggestions: string[];
  /** What NOT to do. */
  avoidPatterns: string[];
}

export interface ProductionRule {
  id: string;
  name: string;
  condition: RuleCondition;
  action: RuleAction;
  confidence: number;
  sourceSkillId: string | null;
  priority: number;
  hitCount: number;
  fireCount: number;
  successCount: number;
  accuracy: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuleMatch {
  rule: ProductionRule;
  matchScore: number;
  matchedPatterns: string[];
}

export interface ProductionRuleEngineOptions {
  fileStore: FileStore;
  logger?: Logger;
  minConfidenceForExtraction?: number;
  minUsageForExtraction?: number;
  maxRules?: number;
}

export interface RuleStats {
  totalRules: number;
  enabledRules: number;
  avgAccuracy: number;
  avgHitRate: number;
  totalFires: number;
  topRules: Array<{ name: string; accuracy: number; fireCount: number }>;
  lowAccuracyRules: Array<{ name: string; accuracy: number; fireCount: number }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'production-rules';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or',
  'nor', 'not', 'so', 'if', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'his', 'our', 'their', 'what', 'which',
  'who', 'when', 'where', 'how', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'any', 'only',
  'own', 'same', 'than', 'too', 'very', 'just', 'about', 'up',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tokenize a string into lowercase keywords, removing stopwords. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Extract unique keywords from text. */
function extractKeywords(text: string): string[] {
  return [...new Set(tokenize(text))];
}

/** Extract step list from a pattern string. */
function extractSteps(pattern: string): string[] {
  // Split by numbered items or newlines
  const lines = pattern
    .split(/\n/)
    .map((l) => l.replace(/^\s*\d+[\.\)]\s*/, '').trim())
    .filter((l) => l.length > 0);
  return lines;
}

/** Scan text for apex_ tool names. */
function extractToolSuggestions(text: string): string[] {
  const matches = text.match(/apex_\w+/g);
  return matches ? [...new Set(matches)] : [];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ProductionRuleEngine {
  private readonly fileStore: FileStore;
  private readonly logger: Logger | undefined;
  private readonly minConfidence: number;
  private readonly minUsage: number;
  private readonly maxRules: number;

  /** In-memory rule store. */
  private rules: Map<string, ProductionRule> = new Map();

  /** Inverted index: keyword -> Set<ruleId>. */
  private invertedIndex: Map<string, Set<string>> = new Map();

  /** Total number of match() calls, for hit-rate stats. */
  private totalQueries = 0;

  constructor(opts: ProductionRuleEngineOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger;
    this.minConfidence = opts.minConfidenceForExtraction ?? 0.8;
    this.minUsage = opts.minUsageForExtraction ?? 10;
    this.maxRules = opts.maxRules ?? 200;
  }

  /** Load persisted rules into memory and rebuild the index. */
  async init(): Promise<void> {
    const stored = await this.fileStore.readAll<ProductionRule>(COLLECTION);
    for (const rule of stored) {
      this.rules.set(rule.id, rule);
    }
    this.rebuildIndex();
    this.logger?.debug('ProductionRuleEngine initialized', {
      ruleCount: this.rules.size,
    });
  }

  // -------------------------------------------------------------------------
  // Skill extraction
  // -------------------------------------------------------------------------

  /**
   * Extract production rules from high-confidence, high-usage skills.
   * Returns the newly created rules (does NOT auto-persist).
   */
  extractFromSkills(skills: Skill[]): ProductionRule[] {
    const eligible = skills.filter(
      (s) => s.confidence >= this.minConfidence && s.usageCount >= this.minUsage,
    );

    const created: ProductionRule[] = [];

    for (const skill of eligible) {
      if (this.rules.size >= this.maxRules) break;

      const descriptionKeywords = extractKeywords(skill.description);
      const preconditionKeywords = extractKeywords(skill.preconditions.join(' '));
      const allPatterns = [...new Set([...descriptionKeywords, ...preconditionKeywords])];

      const taskTypes = skill.tags.filter((t) =>
        ['debugging', 'testing', 'refactoring', 'documentation', 'deployment',
         'performance', 'security', 'configuration', 'migration', 'api',
         'authentication', 'database', 'ui', 'infrastructure'].includes(t.toLowerCase()),
      );

      const condition: RuleCondition = {
        patterns: allPatterns,
        taskTypes: taskTypes.length > 0 ? taskTypes : skill.tags,
        requiredTags: [],
        contextPatterns: skill.preconditions,
      };

      const steps = extractSteps(skill.pattern);
      const toolSuggestions = extractToolSuggestions(skill.pattern);

      const action: RuleAction = {
        description: skill.description,
        steps,
        toolSuggestions,
        avoidPatterns: [],
      };

      const now = new Date().toISOString();
      const rule: ProductionRule = {
        id: randomUUID(),
        name: skill.name,
        condition,
        action,
        confidence: skill.successRate,
        sourceSkillId: skill.id,
        priority: Math.round(skill.confidence * 100),
        hitCount: 0,
        fireCount: 0,
        successCount: 0,
        accuracy: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };

      this.rules.set(rule.id, rule);
      created.push(rule);
    }

    if (created.length > 0) {
      this.rebuildIndex();
    }

    this.logger?.info('Extracted production rules from skills', {
      eligible: eligible.length,
      created: created.length,
    });

    return created;
  }

  // -------------------------------------------------------------------------
  // Manual rule management
  // -------------------------------------------------------------------------

  async addRule(input: {
    name: string;
    condition: RuleCondition;
    action: RuleAction;
    confidence?: number;
    priority?: number;
    sourceSkillId?: string;
  }): Promise<ProductionRule> {
    const now = new Date().toISOString();
    const rule: ProductionRule = {
      id: randomUUID(),
      name: input.name,
      condition: input.condition,
      action: input.action,
      confidence: input.confidence ?? 0.5,
      sourceSkillId: input.sourceSkillId ?? null,
      priority: input.priority ?? 50,
      hitCount: 0,
      fireCount: 0,
      successCount: 0,
      accuracy: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    this.rules.set(rule.id, rule);
    this.rebuildIndex();
    await this.fileStore.write(COLLECTION, rule.id, rule);

    this.logger?.debug('Added production rule', { id: rule.id, name: rule.name });
    return rule;
  }

  // -------------------------------------------------------------------------
  // Pattern matching
  // -------------------------------------------------------------------------

  /**
   * Match rules against a task description and optional context.
   * Uses an inverted index for fast keyword lookup.
   */
  match(input: {
    taskDescription: string;
    taskType?: string;
    tags?: string[];
    context?: string;
  }): RuleMatch[] {
    this.totalQueries++;

    const queryKeywords = tokenize(input.taskDescription);
    const contextKeywords = input.context ? tokenize(input.context) : [];

    // Collect candidate rule IDs from the inverted index
    const ruleScores = new Map<string, { matchedPatterns: Set<string>; score: number }>();

    for (const keyword of queryKeywords) {
      const ruleIds = this.invertedIndex.get(keyword);
      if (!ruleIds) continue;
      for (const ruleId of ruleIds) {
        const rule = this.rules.get(ruleId);
        if (!rule || !rule.enabled) continue;
        let entry = ruleScores.get(ruleId);
        if (!entry) {
          entry = { matchedPatterns: new Set(), score: 0 };
          ruleScores.set(ruleId, entry);
        }
        entry.matchedPatterns.add(keyword);
      }
    }

    // Also check context patterns
    if (contextKeywords.length > 0) {
      for (const keyword of contextKeywords) {
        const ruleIds = this.invertedIndex.get(keyword);
        if (!ruleIds) continue;
        for (const ruleId of ruleIds) {
          const rule = this.rules.get(ruleId);
          if (!rule || !rule.enabled) continue;
          let entry = ruleScores.get(ruleId);
          if (!entry) {
            entry = { matchedPatterns: new Set(), score: 0 };
            ruleScores.set(ruleId, entry);
          }
          entry.matchedPatterns.add(keyword);
        }
      }
    }

    // Build matches
    const matches: RuleMatch[] = [];

    for (const [ruleId, entry] of ruleScores) {
      const rule = this.rules.get(ruleId)!;
      const patternCount = rule.condition.patterns.length || 1;
      let matchScore = entry.matchedPatterns.size / patternCount;

      // Boost for taskType match
      if (input.taskType && rule.condition.taskTypes.length > 0) {
        const taskTypeLower = input.taskType.toLowerCase();
        if (rule.condition.taskTypes.some((t) => t.toLowerCase() === taskTypeLower)) {
          matchScore = Math.min(1, matchScore + 0.2);
        }
      }

      // Boost for tag match
      if (input.tags && input.tags.length > 0 && rule.condition.requiredTags.length > 0) {
        const queryTags = new Set(input.tags.map((t) => t.toLowerCase()));
        const tagMatches = rule.condition.requiredTags.filter((t) =>
          queryTags.has(t.toLowerCase()),
        ).length;
        if (tagMatches > 0) {
          matchScore = Math.min(1, matchScore + 0.1 * tagMatches);
        }
      }

      // Context pattern matching (string-level)
      if (input.context && rule.condition.contextPatterns.length > 0) {
        const ctxLower = input.context.toLowerCase();
        const ctxMatches = rule.condition.contextPatterns.filter((p) =>
          ctxLower.includes(p.toLowerCase()),
        ).length;
        if (ctxMatches > 0) {
          matchScore = Math.min(1, matchScore + 0.15 * ctxMatches);
        }
      }

      matchScore = Math.min(1, matchScore);

      // Increment hit count
      rule.hitCount++;

      matches.push({
        rule,
        matchScore,
        matchedPatterns: [...entry.matchedPatterns],
      });
    }

    // Sort by composite score: priority * matchScore * confidence
    matches.sort((a, b) => {
      const scoreA = a.rule.priority * a.matchScore * a.rule.confidence;
      const scoreB = b.rule.priority * b.matchScore * b.rule.confidence;
      return scoreB - scoreA;
    });

    return matches;
  }

  // -------------------------------------------------------------------------
  // Fire / outcome tracking
  // -------------------------------------------------------------------------

  async recordFire(ruleId: string): Promise<void> {
    const rule = this.rules.get(ruleId);
    if (!rule) return;
    rule.fireCount++;
    rule.updatedAt = new Date().toISOString();
    await this.fileStore.write(COLLECTION, rule.id, rule);
  }

  async recordOutcome(ruleId: string, success: boolean): Promise<void> {
    const rule = this.rules.get(ruleId);
    if (!rule) return;
    if (success) {
      rule.successCount++;
    }
    rule.accuracy = rule.successCount / Math.max(rule.fireCount, 1);
    rule.updatedAt = new Date().toISOString();
    await this.fileStore.write(COLLECTION, rule.id, rule);
  }

  // -------------------------------------------------------------------------
  // Rule queries
  // -------------------------------------------------------------------------

  getRule(id: string): ProductionRule | null {
    return this.rules.get(id) ?? null;
  }

  listRules(filter?: { enabled?: boolean; minAccuracy?: number }): ProductionRule[] {
    let results = [...this.rules.values()];
    if (filter) {
      if (filter.enabled !== undefined) {
        results = results.filter((r) => r.enabled === filter.enabled);
      }
      if (filter.minAccuracy !== undefined) {
        results = results.filter((r) => r.accuracy >= filter.minAccuracy!);
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Enable / disable / prune
  // -------------------------------------------------------------------------

  async disableRule(id: string): Promise<void> {
    const rule = this.rules.get(id);
    if (!rule) return;
    rule.enabled = false;
    rule.updatedAt = new Date().toISOString();
    this.rebuildIndex();
    await this.fileStore.write(COLLECTION, rule.id, rule);
  }

  async enableRule(id: string): Promise<void> {
    const rule = this.rules.get(id);
    if (!rule) return;
    rule.enabled = true;
    rule.updatedAt = new Date().toISOString();
    this.rebuildIndex();
    await this.fileStore.write(COLLECTION, rule.id, rule);
  }

  /**
   * Disable rules with accuracy < 0.3 after 10+ fires.
   * Returns IDs of pruned rules.
   */
  async autoPrune(): Promise<string[]> {
    const pruned: string[] = [];
    for (const rule of this.rules.values()) {
      if (rule.enabled && rule.fireCount >= 10 && rule.accuracy < 0.3) {
        rule.enabled = false;
        rule.updatedAt = new Date().toISOString();
        pruned.push(rule.id);
        await this.fileStore.write(COLLECTION, rule.id, rule);
      }
    }
    if (pruned.length > 0) {
      this.rebuildIndex();
      this.logger?.info('Auto-pruned low-accuracy rules', { count: pruned.length });
    }
    return pruned;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): RuleStats {
    const allRules = [...this.rules.values()];
    const enabled = allRules.filter((r) => r.enabled);
    const totalFires = allRules.reduce((sum, r) => sum + r.fireCount, 0);

    const avgAccuracy =
      allRules.length > 0
        ? allRules.reduce((sum, r) => sum + r.accuracy, 0) / allRules.length
        : 0;

    const avgHitRate =
      allRules.length > 0 && this.totalQueries > 0
        ? allRules.reduce((sum, r) => sum + r.hitCount, 0) /
          (allRules.length * this.totalQueries)
        : 0;

    const sorted = [...allRules].sort((a, b) => b.accuracy - a.accuracy);

    const topRules = sorted
      .filter((r) => r.fireCount > 0)
      .slice(0, 5)
      .map((r) => ({ name: r.name, accuracy: r.accuracy, fireCount: r.fireCount }));

    const lowAccuracyRules = sorted
      .filter((r) => r.fireCount >= 5 && r.accuracy < 0.5)
      .reverse()
      .slice(0, 5)
      .map((r) => ({ name: r.name, accuracy: r.accuracy, fireCount: r.fireCount }));

    return {
      totalRules: allRules.length,
      enabledRules: enabled.length,
      avgAccuracy,
      avgHitRate,
      totalFires,
      topRules,
      lowAccuracyRules,
    };
  }

  // -------------------------------------------------------------------------
  // Context generation
  // -------------------------------------------------------------------------

  /**
   * Generate a context string for injection into planning.
   * Lists top matching rules formatted for LLM consumption.
   */
  getMatchContext(taskDescription: string): string {
    const matches = this.match({ taskDescription });
    if (matches.length === 0) {
      return '';
    }

    const top = matches.slice(0, 3);
    const lines = top.map((m, i) => {
      const condKeywords = m.matchedPatterns.join(' + ');
      const actionSummary = m.rule.action.steps.slice(0, 2).join(', ');
      return `${i + 1}. [confidence: ${m.rule.confidence.toFixed(2)}] IF ${condKeywords} THEN: ${actionSummary}`;
    });

    return `Applicable rules:\n${lines.join('\n')}`;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  async persist(): Promise<void> {
    for (const rule of this.rules.values()) {
      await this.fileStore.write(COLLECTION, rule.id, rule);
    }
    this.logger?.debug('Persisted production rules', { count: this.rules.size });
  }

  // -------------------------------------------------------------------------
  // Private: Inverted index
  // -------------------------------------------------------------------------

  private rebuildIndex(): void {
    this.invertedIndex.clear();
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      for (const pattern of rule.condition.patterns) {
        let ruleIds = this.invertedIndex.get(pattern);
        if (!ruleIds) {
          ruleIds = new Set();
          this.invertedIndex.set(pattern, ruleIds);
        }
        ruleIds.add(rule.id);
      }
      // Also index context-pattern keywords
      for (const cp of rule.condition.contextPatterns) {
        const keywords = tokenize(cp);
        for (const kw of keywords) {
          let ruleIds = this.invertedIndex.get(kw);
          if (!ruleIds) {
            ruleIds = new Set();
            this.invertedIndex.set(kw, ruleIds);
          }
          ruleIds.add(rule.id);
        }
      }
    }
  }
}
