/**
 * APEX Curriculum Generator
 *
 * Generates task suggestions based on the agent's current skill level using
 * Zone of Proximal Development (ZPD) targeting and domain coverage tracking.
 * Ensures the agent works on tasks that are neither too easy nor too hard,
 * while maintaining breadth across problem domains.
 */

import type { Episode, Skill, Task } from '../types.js';
import { generateId } from '../types.js';
import type { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FileStore collection for persisted curriculum data. */
const CURRICULUM_COLLECTION = 'curriculum';

/** Key for persisted domain progress records. */
const DOMAIN_PROGRESS_KEY = 'domain-progress';

/** Default lower bound of the Zone of Proximal Development window. */
const DEFAULT_ZPD_LOWER = 0.3;

/** Default upper bound of the Zone of Proximal Development window. */
const DEFAULT_ZPD_UPPER = 0.7;

/** Default coverage decay period: 7 days in milliseconds. */
const DEFAULT_COVERAGE_DECAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Ideal offset above current level for ZPD targeting. */
const ZPD_DELTA = 0.15;

// ---------------------------------------------------------------------------
// Domain keyword mapping
// ---------------------------------------------------------------------------

/**
 * Maps keywords found in task descriptions to canonical domain names.
 * Used for automatic domain detection when episodes lack explicit domains.
 */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  testing: ['test', 'spec', 'assert', 'coverage', 'mock', 'stub', 'fixture', 'jest', 'vitest'],
  refactoring: ['refactor', 'rename', 'extract', 'inline', 'restructure', 'reorganize', 'simplify'],
  debugging: ['fix', 'bug', 'error', 'debug', 'issue', 'crash', 'broken', 'fault', 'defect'],
  documentation: ['doc', 'readme', 'comment', 'jsdoc', 'docstring', 'wiki', 'guide'],
  devops: ['deploy', 'ci', 'pipeline', 'docker', 'kubernetes', 'build', 'release', 'cd'],
  'type-system': ['type', 'interface', 'generic', 'typing', 'typecheck', 'schema', 'validate'],
  'api-design': ['api', 'endpoint', 'route', 'handler', 'middleware', 'rest', 'graphql'],
  'data-modeling': ['model', 'schema', 'database', 'migration', 'entity', 'relation', 'query'],
  performance: ['perf', 'optimize', 'cache', 'latency', 'throughput', 'benchmark', 'memory'],
  security: ['auth', 'security', 'permission', 'token', 'encrypt', 'sanitize', 'csrf', 'xss'],
  'error-handling': ['catch', 'throw', 'exception', 'retry', 'fallback', 'recovery', 'resilience'],
  architecture: ['architecture', 'pattern', 'module', 'component', 'layer', 'dependency', 'design'],
};

// ---------------------------------------------------------------------------
// Task templates for ZPD generation
// ---------------------------------------------------------------------------

/**
 * Template task descriptions per domain, ordered roughly by difficulty.
 * The generator interpolates these to produce ZPD-appropriate tasks.
 */
const DOMAIN_TASK_TEMPLATES: Record<string, Array<{ description: string; baseDifficulty: number }>> = {
  testing: [
    { description: 'Add unit tests for a single pure function', baseDifficulty: 0.1 },
    { description: 'Write tests for a module with external dependencies using mocks', baseDifficulty: 0.3 },
    { description: 'Achieve >90% branch coverage for a complex module', baseDifficulty: 0.5 },
    { description: 'Create integration tests with database and API interactions', baseDifficulty: 0.7 },
    { description: 'Design a comprehensive test strategy for a multi-module system', baseDifficulty: 0.9 },
  ],
  refactoring: [
    { description: 'Rename variables for clarity in a single file', baseDifficulty: 0.1 },
    { description: 'Extract a reusable utility function from duplicated code', baseDifficulty: 0.25 },
    { description: 'Decompose a large function into smaller, focused functions', baseDifficulty: 0.4 },
    { description: 'Restructure a module to follow the single-responsibility principle', baseDifficulty: 0.6 },
    { description: 'Refactor a tightly coupled subsystem to use dependency injection', baseDifficulty: 0.8 },
  ],
  debugging: [
    { description: 'Diagnose and fix a simple type error', baseDifficulty: 0.1 },
    { description: 'Debug a failing test caused by incorrect mock setup', baseDifficulty: 0.3 },
    { description: 'Trace and fix a race condition in async code', baseDifficulty: 0.5 },
    { description: 'Diagnose a memory leak in a long-running process', baseDifficulty: 0.7 },
    { description: 'Debug a non-deterministic failure across distributed components', baseDifficulty: 0.9 },
  ],
  documentation: [
    { description: 'Add JSDoc comments to exported functions in a module', baseDifficulty: 0.1 },
    { description: 'Write a usage guide for a utility library', baseDifficulty: 0.3 },
    { description: 'Create architecture decision records for key design choices', baseDifficulty: 0.5 },
    { description: 'Document a complex API with examples and edge cases', baseDifficulty: 0.7 },
    { description: 'Write a comprehensive onboarding guide for a large codebase', baseDifficulty: 0.9 },
  ],
  devops: [
    { description: 'Add a linting step to the CI pipeline', baseDifficulty: 0.15 },
    { description: 'Configure automated test runs on pull requests', baseDifficulty: 0.3 },
    { description: 'Set up Docker-based development environment', baseDifficulty: 0.5 },
    { description: 'Implement blue-green deployment with rollback', baseDifficulty: 0.7 },
    { description: 'Design a multi-environment CI/CD pipeline with canary releases', baseDifficulty: 0.9 },
  ],
  'type-system': [
    { description: 'Add explicit type annotations to function parameters', baseDifficulty: 0.1 },
    { description: 'Create interfaces for data transfer objects', baseDifficulty: 0.25 },
    { description: 'Implement generic utility types for common patterns', baseDifficulty: 0.5 },
    { description: 'Design a type-safe event system using discriminated unions', baseDifficulty: 0.7 },
    { description: 'Build advanced conditional types for a plugin architecture', baseDifficulty: 0.9 },
  ],
  'api-design': [
    { description: 'Define a simple CRUD endpoint with input validation', baseDifficulty: 0.15 },
    { description: 'Implement error handling middleware with proper HTTP status codes', baseDifficulty: 0.3 },
    { description: 'Design a paginated list endpoint with filtering and sorting', baseDifficulty: 0.5 },
    { description: 'Implement rate limiting and authentication for an API', baseDifficulty: 0.7 },
    { description: 'Design a versioned API with backward compatibility strategy', baseDifficulty: 0.9 },
  ],
  'data-modeling': [
    { description: 'Define a simple entity schema with basic validations', baseDifficulty: 0.1 },
    { description: 'Model a one-to-many relationship with proper foreign keys', baseDifficulty: 0.3 },
    { description: 'Design a normalized schema for a multi-entity domain', baseDifficulty: 0.5 },
    { description: 'Implement a migration strategy for schema evolution', baseDifficulty: 0.7 },
    { description: 'Design a polyglot persistence strategy for mixed workloads', baseDifficulty: 0.9 },
  ],
  performance: [
    { description: 'Identify and eliminate an obvious N+1 query', baseDifficulty: 0.15 },
    { description: 'Add caching to reduce redundant computations', baseDifficulty: 0.3 },
    { description: 'Profile and optimize a slow function', baseDifficulty: 0.5 },
    { description: 'Implement lazy loading and pagination for large datasets', baseDifficulty: 0.7 },
    { description: 'Design a performance monitoring and alerting system', baseDifficulty: 0.9 },
  ],
  security: [
    { description: 'Sanitize user input to prevent injection attacks', baseDifficulty: 0.2 },
    { description: 'Implement token-based authentication', baseDifficulty: 0.35 },
    { description: 'Add role-based access control to API endpoints', baseDifficulty: 0.5 },
    { description: 'Implement secure secret management and rotation', baseDifficulty: 0.7 },
    { description: 'Conduct a security audit and remediate findings', baseDifficulty: 0.9 },
  ],
  'error-handling': [
    { description: 'Add try-catch blocks with meaningful error messages', baseDifficulty: 0.1 },
    { description: 'Implement a centralized error handling strategy', baseDifficulty: 0.3 },
    { description: 'Add retry logic with exponential backoff for transient failures', baseDifficulty: 0.5 },
    { description: 'Implement circuit breaker pattern for external service calls', baseDifficulty: 0.7 },
    { description: 'Design a fault-tolerant system with graceful degradation', baseDifficulty: 0.9 },
  ],
  architecture: [
    { description: 'Extract a shared utility module from duplicated code', baseDifficulty: 0.15 },
    { description: 'Introduce a service layer to separate business logic from handlers', baseDifficulty: 0.3 },
    { description: 'Implement the repository pattern for data access abstraction', baseDifficulty: 0.5 },
    { description: 'Design an event-driven architecture with pub/sub messaging', baseDifficulty: 0.7 },
    { description: 'Architect a plugin system with hot-reloading capability', baseDifficulty: 0.9 },
  ],
};

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

/**
 * A single curriculum suggestion combining a task with metadata about
 * why it was chosen and how well it fits the agent's learning zone.
 */
export interface CurriculumSuggestion {
  /** The suggested task to attempt. */
  task: Task;

  /** Human-readable explanation of why this task was suggested. */
  reason: string;

  /**
   * How well this task fits the Zone of Proximal Development.
   * `1.0` = perfect fit, `0.0` = far outside the ideal range.
   */
  zpdScore: number;

  /** If this suggestion targets a known weakness, describes which one. */
  targetWeakness?: string;
}

/**
 * Tracks the agent's progress within a single problem domain.
 */
export interface DomainProgress {
  /** Canonical domain name (e.g. `"testing"`, `"debugging"`). */
  domain: string;

  /** Total number of episodes attempted in this domain. */
  episodeCount: number;

  /** Fraction of episodes that succeeded, in `[0, 1]`. */
  successRate: number;

  /** Mean difficulty of episodes attempted in this domain. */
  avgDifficulty: number;

  /** Unix-epoch millisecond timestamp of the most recent attempt. */
  lastAttempted: number;

  /**
   * Estimated current skill level in this domain, in `[0, 1]`.
   * Derived from success rate weighted by average difficulty.
   */
  currentLevel: number;
}

/**
 * A recurring failure pattern identified across episodes.
 */
export interface WeakArea {
  /** The domain where failures concentrate. */
  domain: string;

  /** The error type that recurs. */
  errorType: string;

  /** Fraction of episodes in this domain that fail with this error type. */
  failureRate: number;
}

/**
 * Configuration options for the {@link CurriculumGenerator}.
 */
export interface CurriculumGeneratorOptions {
  /** Shared file store for persistence. */
  fileStore?: FileStore;

  /** Optional logger instance. */
  logger?: Logger;

  /**
   * Lower bound of the ZPD window. Tasks with difficulty below
   * `currentLevel - zpdLower` are considered too easy.
   * @default 0.3
   */
  zpdLower?: number;

  /**
   * Upper bound of the ZPD window. Tasks with difficulty above
   * `currentLevel + zpdUpper` are considered too hard.
   * @default 0.7
   */
  zpdUpper?: number;

  /**
   * Domains not practiced within this period receive a priority boost
   * to encourage breadth of learning.
   * @default 604800000 (7 days in ms)
   */
  coverageDecayMs?: number;
}

// ---------------------------------------------------------------------------
// CurriculumGenerator
// ---------------------------------------------------------------------------

/**
 * Generates task suggestions using Zone of Proximal Development targeting,
 * domain coverage tracking, and failure-directed curriculum planning.
 *
 * The generator analyzes the agent's episode history to identify skill levels
 * per domain, find recurring failure patterns, and propose tasks that sit
 * in the optimal learning zone -- challenging enough to grow, but achievable
 * enough to avoid frustration.
 */
export class CurriculumGenerator {
  private readonly fileStore: FileStore | null;
  private readonly logger: Logger;
  private readonly zpdLower: number;
  private readonly zpdUpper: number;
  private readonly coverageDecayMs: number;

  constructor(options: CurriculumGeneratorOptions = {}) {
    this.fileStore = options.fileStore ?? null;
    this.logger = options.logger ?? new Logger({ prefix: 'apex:curriculum' });
    this.zpdLower = options.zpdLower ?? DEFAULT_ZPD_LOWER;
    this.zpdUpper = options.zpdUpper ?? DEFAULT_ZPD_UPPER;
    this.coverageDecayMs = options.coverageDecayMs ?? DEFAULT_COVERAGE_DECAY_MS;
  }

  // -----------------------------------------------------------------------
  // Primary API
  // -----------------------------------------------------------------------

  /**
   * Generate curriculum suggestions based on the agent's episode history
   * and existing skills.
   *
   * @param episodes - All recorded episodes to analyze.
   * @param skills   - All known skills for cross-referencing.
   * @param options  - Optional filters: target domain, result count.
   * @returns Ranked list of curriculum suggestions.
   */
  async suggest(
    episodes: Episode[],
    skills: Skill[],
    options?: { domain?: string; count?: number },
  ): Promise<CurriculumSuggestion[]> {
    const count = options?.count ?? 5;

    this.logger.info('Generating curriculum suggestions', {
      episodeCount: episodes.length,
      skillCount: skills.length,
      targetDomain: options?.domain,
      count,
    });

    // 1. Build domain progress from episode history
    const domainProgress = this.getDomainProgress(episodes);

    // 2. Identify weak areas
    const weakAreas = this.getWeakAreas(episodes);

    // 3. Filter domain progress if a specific domain was requested
    const targetProgress = options?.domain
      ? domainProgress.filter((dp) => dp.domain === options.domain)
      : domainProgress;

    // 4. Generate candidate tasks
    const candidates: Task[] = [];

    if (targetProgress.length === 0) {
      // No history for the requested domain(s) -- generate introductory tasks
      const domains = options?.domain ? [options.domain] : this.getUncoveredDomains(domainProgress);
      for (const domain of domains) {
        candidates.push(...this.generateZPDTasks(0, domain, []));
      }
    } else {
      for (const progress of targetProgress) {
        const domainWeaknesses = weakAreas
          .filter((w) => w.domain === progress.domain)
          .map((w) => w.errorType);
        candidates.push(
          ...this.generateZPDTasks(progress.currentLevel, progress.domain, domainWeaknesses),
        );
      }
    }

    // Also generate tasks for underpracticed domains (coverage boost)
    if (!options?.domain) {
      const underpracticed = this.getUnderpracticedDomains(domainProgress);
      for (const domain of underpracticed) {
        const existing = domainProgress.find((dp) => dp.domain === domain);
        const level = existing?.currentLevel ?? 0;
        candidates.push(...this.generateZPDTasks(level, domain, []));
      }
    }

    // 5. Enrich candidates with skill suggestions
    this.enrichWithSkills(candidates, skills);

    // 6. Rank and return top N
    const ranked = this.rankSuggestions(candidates, domainProgress, weakAreas);

    // Persist updated domain progress
    if (this.fileStore) {
      await this.saveDomainProgress(domainProgress);
    }

    const result = ranked.slice(0, count);
    this.logger.info('Curriculum suggestions generated', { resultCount: result.length });
    return result;
  }

  // -----------------------------------------------------------------------
  // Domain analysis
  // -----------------------------------------------------------------------

  /**
   * Analyze episodes to build per-domain progress statistics.
   *
   * @param episodes - Episodes to analyze.
   * @returns Array of domain progress records, one per detected domain.
   */
  getDomainProgress(episodes: Episode[]): DomainProgress[] {
    const domainMap = new Map<
      string,
      { successes: number; total: number; difficulties: number[]; lastTs: number }
    >();

    for (const ep of episodes) {
      const domain = this.detectDomain(ep.task);

      let stats = domainMap.get(domain);
      if (!stats) {
        stats = { successes: 0, total: 0, difficulties: [], lastTs: 0 };
        domainMap.set(domain, stats);
      }

      stats.total += 1;
      if (ep.outcome.success) {
        stats.successes += 1;
      }
      // Use reward as a proxy for difficulty when metadata is absent
      const difficulty = (ep.metadata?.difficulty as number) ?? ep.reward;
      stats.difficulties.push(difficulty);
      stats.lastTs = Math.max(stats.lastTs, ep.timestamp);
    }

    const progress: DomainProgress[] = [];

    for (const [domain, stats] of domainMap) {
      const successRate = stats.total > 0 ? stats.successes / stats.total : 0;
      const avgDifficulty =
        stats.difficulties.length > 0
          ? stats.difficulties.reduce((a, b) => a + b, 0) / stats.difficulties.length
          : 0;

      // Skill level estimation: success rate weighted by average difficulty,
      // with a small bonus for volume (more episodes = more confidence).
      const volumeFactor = Math.min(1, stats.total / 20); // saturates at 20 episodes
      const currentLevel = Math.min(1, successRate * avgDifficulty * 0.8 + successRate * 0.2 * volumeFactor);

      progress.push({
        domain,
        episodeCount: stats.total,
        successRate,
        avgDifficulty,
        lastAttempted: stats.lastTs,
        currentLevel: Math.round(currentLevel * 100) / 100,
      });
    }

    return progress.sort((a, b) => b.episodeCount - a.episodeCount);
  }

  /**
   * Find recurring failure patterns across episodes.
   *
   * @param episodes - Episodes to analyze.
   * @returns Array of weak areas with domain, error type, and failure rate.
   */
  getWeakAreas(episodes: Episode[]): WeakArea[] {
    // Group failed episodes by domain and error type
    const failureMap = new Map<string, Map<string, number>>();
    const domainTotals = new Map<string, number>();

    for (const ep of episodes) {
      const domain = this.detectDomain(ep.task);
      domainTotals.set(domain, (domainTotals.get(domain) ?? 0) + 1);

      if (!ep.outcome.success) {
        const errorType = ep.outcome.errorType ?? 'unknown';
        let domainErrors = failureMap.get(domain);
        if (!domainErrors) {
          domainErrors = new Map();
          failureMap.set(domain, domainErrors);
        }
        domainErrors.set(errorType, (domainErrors.get(errorType) ?? 0) + 1);
      }
    }

    const weakAreas: WeakArea[] = [];

    for (const [domain, errors] of failureMap) {
      const total = domainTotals.get(domain) ?? 1;
      for (const [errorType, count] of errors) {
        const failureRate = count / total;
        // Only report patterns with at least 2 occurrences and >20% failure rate
        if (count >= 2 && failureRate > 0.2) {
          weakAreas.push({
            domain,
            errorType,
            failureRate: Math.round(failureRate * 100) / 100,
          });
        }
      }
    }

    return weakAreas.sort((a, b) => b.failureRate - a.failureRate);
  }

  // -----------------------------------------------------------------------
  // Task generation
  // -----------------------------------------------------------------------

  /**
   * Generate task descriptions targeting the Zone of Proximal Development.
   *
   * For a given skill level L, the ideal task difficulty is approximately
   * L + delta (where delta is ~0.15). Tasks are generated from domain
   * templates with difficulty adjusted to the ZPD range.
   *
   * @param currentLevel - The agent's current skill level in `[0, 1]`.
   * @param domain       - The target problem domain.
   * @param weaknesses   - Error types the agent struggles with (for targeted tasks).
   * @returns Array of generated tasks within the ZPD window.
   */
  generateZPDTasks(currentLevel: number, domain: string, weaknesses: string[]): Task[] {
    const idealDifficulty = Math.min(1, currentLevel + ZPD_DELTA);
    const lower = Math.max(0, idealDifficulty - (this.zpdUpper - this.zpdLower) / 2);
    const upper = Math.min(1, idealDifficulty + (this.zpdUpper - this.zpdLower) / 2);

    const templates = DOMAIN_TASK_TEMPLATES[domain];
    const tasks: Task[] = [];

    if (templates) {
      // Select templates whose difficulty falls within the ZPD window
      for (const tmpl of templates) {
        if (tmpl.baseDifficulty >= lower && tmpl.baseDifficulty <= upper) {
          tasks.push({
            id: generateId(),
            description: tmpl.description,
            difficulty: tmpl.baseDifficulty,
            domain,
            constraints: [],
            suggestedSkills: [],
          });
        }
      }
    }

    // If no templates matched (domain unknown or ZPD window too narrow),
    // generate a generic task at the ideal difficulty
    if (tasks.length === 0) {
      tasks.push({
        id: generateId(),
        description: `Practice ${domain} skills at intermediate difficulty`,
        difficulty: idealDifficulty,
        domain,
        constraints: [],
        suggestedSkills: [],
      });
    }

    // Generate weakness-targeted tasks
    for (const weakness of weaknesses) {
      tasks.push({
        id: generateId(),
        description: `Fix a ${weakness} issue in the ${domain} domain`,
        difficulty: Math.min(1, currentLevel + 0.1),
        domain,
        constraints: [`Must handle ${weakness} correctly`],
        suggestedSkills: [],
      });
    }

    return tasks;
  }

  // -----------------------------------------------------------------------
  // Ranking
  // -----------------------------------------------------------------------

  /**
   * Score and rank candidate tasks by ZPD fit, domain coverage, and
   * weakness targeting.
   *
   * @param tasks          - Candidate tasks to rank.
   * @param domainProgress - Current per-domain progress stats.
   * @param weakAreas      - Known failure patterns.
   * @returns Sorted array of curriculum suggestions, best first.
   */
  rankSuggestions(
    tasks: Task[],
    domainProgress: DomainProgress[],
    weakAreas: WeakArea[],
  ): CurriculumSuggestion[] {
    const now = Date.now();
    const progressMap = new Map(domainProgress.map((dp) => [dp.domain, dp]));
    const weakMap = new Map<string, WeakArea[]>();

    for (const wa of weakAreas) {
      const existing = weakMap.get(wa.domain) ?? [];
      existing.push(wa);
      weakMap.set(wa.domain, existing);
    }

    const scored: CurriculumSuggestion[] = tasks.map((task) => {
      const progress = progressMap.get(task.domain);
      const currentLevel = progress?.currentLevel ?? 0;

      // --- ZPD score ---
      const idealDifficulty = Math.min(1, currentLevel + ZPD_DELTA);
      const distance = Math.abs(task.difficulty - idealDifficulty);
      const zpdScore = Math.max(0, 1 - distance * 3); // peaks at ideal, drops off

      // --- Coverage score ---
      let coverageBoost = 0;
      if (!progress) {
        // Never attempted domain gets a large boost
        coverageBoost = 0.3;
      } else {
        const timeSincePractice = now - progress.lastAttempted;
        if (timeSincePractice > this.coverageDecayMs) {
          // Decayed domain gets a proportional boost
          const decayRatio = Math.min(2, timeSincePractice / this.coverageDecayMs);
          coverageBoost = 0.15 * decayRatio;
        }
      }

      // --- Weakness score ---
      let weaknessBoost = 0;
      let targetWeakness: string | undefined;
      const domainWeakAreas = weakMap.get(task.domain) ?? [];
      if (domainWeakAreas.length > 0) {
        // Check if this task's constraints reference any weakness
        const constraintText = (task.constraints ?? []).join(' ').toLowerCase();
        for (const wa of domainWeakAreas) {
          if (constraintText.includes(wa.errorType.toLowerCase())) {
            weaknessBoost = 0.2 * wa.failureRate;
            targetWeakness = `${wa.domain}/${wa.errorType} (${Math.round(wa.failureRate * 100)}% failure rate)`;
            break;
          }
        }
        // Even without direct match, domain with weak areas gets a small boost
        if (weaknessBoost === 0) {
          weaknessBoost = 0.05;
        }
      }

      // --- Combined score ---
      const combinedScore = zpdScore * 0.5 + coverageBoost + weaknessBoost;

      // --- Build reason ---
      const reasons: string[] = [];
      if (zpdScore >= 0.7) {
        reasons.push('well-matched to current skill level');
      } else if (zpdScore >= 0.4) {
        reasons.push('moderately challenging');
      } else {
        reasons.push('stretches beyond comfort zone');
      }
      if (coverageBoost > 0.15) {
        reasons.push('underpracticed domain');
      }
      if (targetWeakness) {
        reasons.push('targets known weakness');
      }

      return {
        task,
        reason: reasons.join('; '),
        zpdScore: Math.round(zpdScore * 100) / 100,
        targetWeakness,
        _score: combinedScore,
      };
    });

    // Sort by combined score descending, then deduplicate by description
    scored.sort((a, b) => (b as unknown as Record<string, number>)._score - (a as unknown as Record<string, number>)._score);

    // Deduplicate by task description
    const seen = new Set<string>();
    const deduped: CurriculumSuggestion[] = [];
    for (const s of scored) {
      if (!seen.has(s.task.description)) {
        seen.add(s.task.description);
        // Strip internal _score before returning
        deduped.push({
          task: s.task,
          reason: s.reason,
          zpdScore: s.zpdScore,
          targetWeakness: s.targetWeakness,
        });
      }
    }

    return deduped;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Persist domain progress to the file store.
   *
   * @param progress - Array of domain progress records to save.
   */
  async saveDomainProgress(progress: DomainProgress[]): Promise<void> {
    if (!this.fileStore) {
      this.logger.debug('No file store configured, skipping domain progress save');
      return;
    }

    await this.fileStore.write(CURRICULUM_COLLECTION, DOMAIN_PROGRESS_KEY, { progress });
    this.logger.debug('Domain progress saved', { domainCount: progress.length });
  }

  /**
   * Load previously persisted domain progress from the file store.
   *
   * @returns Array of domain progress records, or empty array if none found.
   */
  async loadDomainProgress(): Promise<DomainProgress[]> {
    if (!this.fileStore) {
      this.logger.debug('No file store configured, returning empty domain progress');
      return [];
    }

    const data = await this.fileStore.read<{ progress: DomainProgress[] }>(
      CURRICULUM_COLLECTION,
      DOMAIN_PROGRESS_KEY,
    );
    return data?.progress ?? [];
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Detect the problem domain from a task description using keyword matching.
   *
   * @param taskText - The task description text.
   * @returns The most likely domain, or `"general"` if no keywords match.
   */
  private detectDomain(taskText: string): string {
    const lower = taskText.toLowerCase();
    let bestDomain = 'general';
    let bestScore = 0;

    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestDomain = domain;
      }
    }

    return bestDomain;
  }

  /**
   * Find domains that have no recorded episodes at all.
   *
   * @param domainProgress - Current domain progress records.
   * @returns Array of domain names with zero episodes.
   */
  private getUncoveredDomains(domainProgress: DomainProgress[]): string[] {
    const covered = new Set(domainProgress.map((dp) => dp.domain));
    return Object.keys(DOMAIN_KEYWORDS).filter((d) => !covered.has(d));
  }

  /**
   * Find domains that have not been practiced recently (within the
   * coverage decay window).
   *
   * @param domainProgress - Current domain progress records.
   * @returns Array of domain names that are underpracticed.
   */
  private getUnderpracticedDomains(domainProgress: DomainProgress[]): string[] {
    const now = Date.now();
    return domainProgress
      .filter((dp) => now - dp.lastAttempted > this.coverageDecayMs)
      .map((dp) => dp.domain);
  }

  /**
   * Enrich candidate tasks with suggested skill IDs by matching task domains
   * and descriptions against available skills.
   *
   * @param tasks  - Tasks to enrich (mutated in place).
   * @param skills - Available skills to match against.
   */
  private enrichWithSkills(tasks: Task[], skills: Skill[]): void {
    for (const task of tasks) {
      const relevant = skills.filter((s) => {
        // Match by tag overlap with domain
        if (s.tags.some((t) => t.toLowerCase() === task.domain.toLowerCase())) {
          return true;
        }
        // Match by description keyword overlap
        const taskWords = new Set(task.description.toLowerCase().split(/\s+/));
        const descWords = s.description.toLowerCase().split(/\s+/);
        const overlap = descWords.filter((w) => taskWords.has(w) && w.length > 3).length;
        return overlap >= 2;
      });

      if (relevant.length > 0) {
        task.suggestedSkills = relevant
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 3)
          .map((s) => s.name);
      }
    }
  }
}
