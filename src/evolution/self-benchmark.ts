/**
 * Self-Benchmarking Harness for APEX Self-Improvement Loop (Phase 16)
 *
 * Standardized benchmark suite that evaluates APEX's performance across
 * multiple dimensions: recall accuracy, reflection quality, skill reuse,
 * planning effectiveness, and consolidation efficiency.
 *
 * Used by the self-modification pipeline to measure whether proposed
 * changes improve or degrade system performance.
 *
 * Pure computation + FileStore persistence — zero LLM calls.
 */

import { generateId } from '../types.js';
import { Logger } from '../utils/logger.js';
import { FileStore } from '../utils/file-store.js';
import type { Episode, Reflection, Skill } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BenchmarkDimension {
  name: string;
  description: string;
  weight: number; // 0-1, weights sum to 1.0
}

export interface DimensionScore {
  dimension: string;
  score: number; // 0-1
  details: string;
  sampleSize: number;
}

export interface BenchmarkResult {
  id: string;
  timestamp: number;
  generation: number;
  dimensionScores: DimensionScore[];
  compositeScore: number;
  configSnapshot: Record<string, unknown>;
}

export interface BenchmarkComparison {
  baselineId: string;
  candidateId: string;
  baselineScore: number;
  candidateScore: number;
  improvement: number; // percentage
  dimensionDeltas: Array<{ dimension: string; delta: number; degraded: boolean }>;
  anyDimensionDegraded: boolean;
  maxDegradation: number; // worst single-dimension degradation %
}

export interface SelfBenchmarkOptions {
  fileStore: FileStore;
  logger?: Logger;
  maxHistory?: number; // default 50
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'self-benchmark';

const DEFAULT_MAX_HISTORY = 50;

const SYNTHETIC_DOMAINS = ['typescript', 'react', 'testing', 'debugging', 'refactoring'] as const;

const SYNTHETIC_ACTIONS = [
  'file_edit', 'command', 'code_review', 'test_run', 'refactor',
  'search', 'dependency_update', 'config_change',
] as const;

// ---------------------------------------------------------------------------
// SelfBenchmark
// ---------------------------------------------------------------------------

/**
 * Standardized benchmark suite that evaluates APEX performance across
 * multiple dimensions and persists results for trend analysis.
 */
export class SelfBenchmark {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly maxHistory: number;
  private readonly dimensions: BenchmarkDimension[];

  constructor(options: SelfBenchmarkOptions) {
    this.fileStore = options.fileStore;
    this.logger = options.logger ?? new Logger({ prefix: 'apex:self-benchmark' });
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;

    this.dimensions = [
      {
        name: 'recall-accuracy',
        description: 'How well recall finds relevant memories',
        weight: 0.25,
      },
      {
        name: 'reflection-quality',
        description: 'How actionable reflections are',
        weight: 0.20,
      },
      {
        name: 'skill-reuse-rate',
        description: 'How often skills are successfully reused',
        weight: 0.20,
      },
      {
        name: 'planning-effectiveness',
        description: 'Success rate of plans',
        weight: 0.20,
      },
      {
        name: 'consolidation-efficiency',
        description: 'Quality of memory consolidation',
        weight: 0.15,
      },
    ];
  }

  /**
   * Run the full benchmark suite against the provided data.
   *
   * Evaluates each dimension, computes a weighted composite score,
   * persists the result, and prunes old history beyond `maxHistory`.
   *
   * @param episodes - All episodes to evaluate
   * @param reflections - All reflections to evaluate
   * @param skills - All skills to evaluate
   * @param config - Current configuration snapshot to store alongside the result
   * @returns The benchmark result with per-dimension and composite scores
   */
  async runSuite(
    episodes: Episode[],
    reflections: Reflection[],
    skills: Skill[],
    config: Record<string, unknown>,
  ): Promise<BenchmarkResult> {
    this.logger.info('Running self-benchmark suite', {
      episodes: episodes.length,
      reflections: reflections.length,
      skills: skills.length,
    });

    const dimensionScores: DimensionScore[] = [
      this.scoreRecallAccuracy(episodes),
      this.scoreReflectionQuality(reflections),
      this.scoreSkillReuseRate(skills),
      this.scorePlanningEffectiveness(episodes),
      this.scoreConsolidationEfficiency(episodes),
    ];

    const compositeScore = this.computeComposite(dimensionScores);

    // Determine generation number
    const existingIds = await this.fileStore.list(COLLECTION);
    const generation = existingIds.length + 1;

    const result: BenchmarkResult = {
      id: generateId(),
      timestamp: Date.now(),
      generation,
      dimensionScores,
      compositeScore,
      configSnapshot: config,
    };

    // Persist
    await this.fileStore.write(COLLECTION, result.id, result);

    this.logger.info('Benchmark complete', {
      generation,
      compositeScore: compositeScore.toFixed(4),
    });

    // Prune old results beyond maxHistory
    await this.pruneHistory();

    return result;
  }

  /**
   * Retrieve all benchmark results, sorted by timestamp descending (newest first).
   */
  async getHistory(): Promise<BenchmarkResult[]> {
    const results = await this.fileStore.readAll<BenchmarkResult>(COLLECTION);
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Retrieve the most recent benchmark result, or `null` if none exist.
   */
  async getLatest(): Promise<BenchmarkResult | null> {
    const history = await this.getHistory();
    return history.length > 0 ? history[0] : null;
  }

  /**
   * Compare two benchmark results and compute deltas across all dimensions.
   *
   * @param baselineId - ID of the baseline (before) result
   * @param candidateId - ID of the candidate (after) result
   * @returns Comparison with improvement %, per-dimension deltas, and degradation flags
   * @throws If either benchmark result is not found
   */
  async compareBenchmarks(baselineId: string, candidateId: string): Promise<BenchmarkComparison> {
    const baseline = await this.fileStore.read<BenchmarkResult>(COLLECTION, baselineId);
    if (!baseline) {
      throw new Error(`Baseline benchmark not found: ${baselineId}`);
    }

    const candidate = await this.fileStore.read<BenchmarkResult>(COLLECTION, candidateId);
    if (!candidate) {
      throw new Error(`Candidate benchmark not found: ${candidateId}`);
    }

    const improvement = baseline.compositeScore === 0
      ? (candidate.compositeScore > 0 ? 100 : 0)
      : ((candidate.compositeScore - baseline.compositeScore) / baseline.compositeScore) * 100;

    const dimensionDeltas = this.dimensions.map((dim) => {
      const baseScore = baseline.dimensionScores.find((s) => s.dimension === dim.name)?.score ?? 0;
      const candScore = candidate.dimensionScores.find((s) => s.dimension === dim.name)?.score ?? 0;
      const delta = baseScore === 0
        ? (candScore > 0 ? 100 : 0)
        : ((candScore - baseScore) / baseScore) * 100;
      return {
        dimension: dim.name,
        delta,
        degraded: delta < -2, // flag if degraded more than 2%
      };
    });

    const anyDimensionDegraded = dimensionDeltas.some((d) => d.degraded);
    const maxDegradation = Math.min(0, ...dimensionDeltas.map((d) => d.delta));

    return {
      baselineId,
      candidateId,
      baselineScore: baseline.compositeScore,
      candidateScore: candidate.compositeScore,
      improvement,
      dimensionDeltas,
      anyDimensionDegraded,
      maxDegradation: Math.abs(maxDegradation),
    };
  }

  /**
   * Return the list of benchmark dimensions and their weights.
   */
  getDimensions(): BenchmarkDimension[] {
    return [...this.dimensions];
  }

  /**
   * Generate synthetic episodes for testing and bootstrapping benchmarks.
   *
   * Episodes span multiple domains with varied actions and outcomes.
   * Approximately 70% will be successful. The episodes are returned
   * but NOT persisted — the caller is responsible for storage.
   *
   * @param count - Number of synthetic episodes to generate
   * @returns Array of generated episodes
   */
  async seedSyntheticData(count: number): Promise<Episode[]> {
    const episodes: Episode[] = [];

    for (let i = 0; i < count; i++) {
      const domain = SYNTHETIC_DOMAINS[i % SYNTHETIC_DOMAINS.length];
      const success = Math.random() < 0.7;
      const actionCount = 2 + Math.floor(Math.random() * 7); // 2-8 actions

      const actions = Array.from({ length: actionCount }, (_, j) => {
        const actionType = SYNTHETIC_ACTIONS[j % SYNTHETIC_ACTIONS.length];
        const actionSuccess = success || Math.random() < 0.5;
        return {
          type: actionType,
          description: `${actionType} in ${domain} context (step ${j + 1})`,
          timestamp: Date.now() - (count - i) * 60_000 + j * 1000,
          success: actionSuccess,
        };
      });

      const reward = success
        ? 0.5 + Math.random() * 0.5  // 0.5-1.0 for successes
        : Math.random() * 0.4;        // 0.0-0.4 for failures

      const hasEmbedding = Math.random() < 0.6;

      episodes.push({
        id: generateId(),
        task: `${domain}: ${success ? 'successful' : 'failed'} task #${i + 1}`,
        actions,
        outcome: {
          success,
          description: success
            ? `Completed ${domain} task successfully`
            : `Failed ${domain} task — encountered errors`,
          errorType: success ? undefined : 'synthetic-error',
          duration: 5000 + Math.floor(Math.random() * 55_000),
        },
        reward,
        timestamp: Date.now() - (count - i) * 60_000,
        embedding: hasEmbedding ? Array.from({ length: 8 }, () => Math.random()) : undefined,
        metadata: { synthetic: true, domain },
      });
    }

    return episodes;
  }

  // ---------------------------------------------------------------------------
  // Dimension scoring (private)
  // ---------------------------------------------------------------------------

  /**
   * Recall accuracy: proxy for how retrievable episodes are.
   * Score = fraction with embeddings * 0.6 + fraction with non-trivial tasks * 0.4
   */
  private scoreRecallAccuracy(episodes: Episode[]): DimensionScore {
    if (episodes.length === 0) {
      return { dimension: 'recall-accuracy', score: 0, details: 'No episodes to evaluate', sampleSize: 0 };
    }

    const withEmbeddings = episodes.filter((e) => e.embedding && e.embedding.length > 0).length;
    const withNonTrivialTask = episodes.filter((e) => e.task && e.task.trim().length > 10).length;

    const embeddingFraction = withEmbeddings / episodes.length;
    const taskFraction = withNonTrivialTask / episodes.length;
    const score = embeddingFraction * 0.6 + taskFraction * 0.4;

    return {
      dimension: 'recall-accuracy',
      score,
      details: `${withEmbeddings}/${episodes.length} with embeddings, ${withNonTrivialTask}/${episodes.length} with rich tasks`,
      sampleSize: episodes.length,
    };
  }

  /**
   * Reflection quality: fraction of reflections with >= 1 actionable insight AND confidence > 0.5.
   */
  private scoreReflectionQuality(reflections: Reflection[]): DimensionScore {
    if (reflections.length === 0) {
      return { dimension: 'reflection-quality', score: 0, details: 'No reflections to evaluate', sampleSize: 0 };
    }

    const highQuality = reflections.filter(
      (r) => r.actionableInsights.length >= 1 && r.confidence > 0.5,
    ).length;
    const score = highQuality / reflections.length;

    return {
      dimension: 'reflection-quality',
      score,
      details: `${highQuality}/${reflections.length} reflections meet quality threshold`,
      sampleSize: reflections.length,
    };
  }

  /**
   * Skill reuse rate: weighted average successRate by usageCount.
   */
  private scoreSkillReuseRate(skills: Skill[]): DimensionScore {
    if (skills.length === 0) {
      return { dimension: 'skill-reuse-rate', score: 0, details: 'No skills to evaluate', sampleSize: 0 };
    }

    const totalUsage = skills.reduce((sum, s) => sum + s.usageCount, 0);
    if (totalUsage === 0) {
      return { dimension: 'skill-reuse-rate', score: 0, details: 'No skills have been used', sampleSize: skills.length };
    }

    const weightedSum = skills.reduce((sum, s) => sum + s.successRate * s.usageCount, 0);
    const score = weightedSum / totalUsage;

    return {
      dimension: 'skill-reuse-rate',
      score,
      details: `Weighted success rate across ${skills.length} skills (${totalUsage} total uses)`,
      sampleSize: skills.length,
    };
  }

  /**
   * Planning effectiveness: overall episode success rate.
   */
  private scorePlanningEffectiveness(episodes: Episode[]): DimensionScore {
    if (episodes.length === 0) {
      return { dimension: 'planning-effectiveness', score: 0, details: 'No episodes to evaluate', sampleSize: 0 };
    }

    const successful = episodes.filter((e) => e.outcome.success).length;
    const score = successful / episodes.length;

    return {
      dimension: 'planning-effectiveness',
      score,
      details: `${successful}/${episodes.length} episodes succeeded`,
      sampleSize: episodes.length,
    };
  }

  /**
   * Consolidation efficiency: fraction of episodes with reward > 0.5,
   * indicating a good consolidation signal.
   */
  private scoreConsolidationEfficiency(episodes: Episode[]): DimensionScore {
    if (episodes.length === 0) {
      return { dimension: 'consolidation-efficiency', score: 0, details: 'No episodes to evaluate', sampleSize: 0 };
    }

    const wellRewarded = episodes.filter((e) => e.reward > 0.5).length;
    const score = wellRewarded / episodes.length;

    return {
      dimension: 'consolidation-efficiency',
      score,
      details: `${wellRewarded}/${episodes.length} episodes with reward > 0.5`,
      sampleSize: episodes.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers (private)
  // ---------------------------------------------------------------------------

  /** Compute composite score as weighted sum of dimension scores. */
  private computeComposite(scores: DimensionScore[]): number {
    let composite = 0;
    for (const dim of this.dimensions) {
      const ds = scores.find((s) => s.dimension === dim.name);
      if (ds) {
        composite += ds.score * dim.weight;
      }
    }
    return Math.round(composite * 10000) / 10000; // 4 decimal places
  }

  /** Remove oldest results when history exceeds maxHistory. */
  private async pruneHistory(): Promise<void> {
    const history = await this.getHistory(); // sorted newest-first
    if (history.length <= this.maxHistory) return;

    const toRemove = history.slice(this.maxHistory);
    for (const result of toRemove) {
      await this.fileStore.delete(COLLECTION, result.id);
    }

    this.logger.info('Pruned benchmark history', {
      removed: toRemove.length,
      remaining: this.maxHistory,
    });
  }
}
