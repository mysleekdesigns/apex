/**
 * Metrics & Telemetry Module for APEX Evolution Engine (Phase 6)
 *
 * Tracks per-iteration performance statistics, computes rolling aggregates
 * over a configurable window, monitors memory tier pressure, and exports
 * learning-curve data in CSV and JSON formats.
 *
 * Pure computation and data aggregation — no LLM calls, no external services.
 * Async methods are used only for disk I/O via FileStore.
 */

import type { MemoryTier } from '../types.js';
import { Logger } from '../utils/logger.js';
import { FileStore } from '../utils/file-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-iteration performance record. */
export interface IterationStats {
  /** Monotonically increasing iteration counter. */
  iteration: number;

  /** Unix-epoch millisecond timestamp of when the iteration completed. */
  timestamp: number;

  /** Estimated difficulty of the task attempted (0-1). */
  taskDifficulty: number;

  /** Whether the task succeeded and the reward received. */
  outcome: { success: boolean; reward: number };

  /** Time spent in the planning phase (ms). */
  planningTimeMs: number;

  /** Time spent in the execution phase (ms). */
  executionTimeMs: number;

  /** Number of actions the agent performed during the iteration. */
  actionsCount: number;

  /** Number of entries in each memory tier at iteration time. */
  memoryUsage: Record<MemoryTier, number>;

  /** Total number of skills in the skill library at iteration time. */
  skillCount: number;
}

/** Rolling aggregate statistics computed over a sliding window. */
export interface RollingAggregates {
  /** Size of the sliding window used for computation. */
  windowSize: number;

  /** Fraction of iterations that succeeded within the window (0-1). */
  successRate: number;

  /** Mean reward across iterations in the window. */
  avgReward: number;

  /** Mean task difficulty across iterations in the window. */
  avgDifficulty: number;

  /** Mean number of actions per iteration in the window. */
  avgActionsPerTask: number;

  /** Rate of skill growth (skills added per iteration) over the window. */
  skillGrowthRate: number;

  /** Direction the reward trend is moving based on linear regression. */
  rewardTrend: 'improving' | 'stable' | 'declining';
}

/** Memory pressure indicators for the tiered memory system. */
export interface MemoryPressure {
  /** Per-tier utilization with absolute counts and percentage. */
  tierUtilization: Record<MemoryTier, { used: number; limit: number; percentage: number }>;

  /** Average evictions per consolidation pass. */
  evictionRate: number;

  /** Percentage of entries with heat score above threshold. */
  hotEntryPercentage: number;

  /** Percentage of entries flagged as stale. */
  staleEntryPercentage: number;
}

/** A single data point on the learning curve. */
export interface LearningCurvePoint {
  /** Iteration number. */
  iteration: number;

  /** Unix-epoch millisecond timestamp. */
  timestamp: number;

  /** Rolling success rate at this point. */
  successRate: number;

  /** Rolling average reward at this point. */
  avgReward: number;

  /** Skill library size at this point. */
  skillCount: number;

  /** Task difficulty at this point. */
  difficulty: number;
}

/** Complete metrics snapshot for persistence and export. */
export interface MetricsSnapshot {
  /** Unix-epoch millisecond timestamp of when the snapshot was captured. */
  capturedAt: number;

  /** Total number of iterations recorded. */
  totalIterations: number;

  /** Current rolling aggregates. */
  rolling: RollingAggregates;

  /** Current memory pressure indicators. */
  pressure: MemoryPressure;

  /** Full learning curve data. */
  learningCurve: LearningCurvePoint[];

  /** All recorded iteration stats. */
  allStats: IterationStats[];
}

/** Configuration options for the MetricsTracker. */
export interface MetricsOptions {
  /** Size of the sliding window for rolling aggregates. Default: 50. */
  rollingWindowSize?: number;

  /** Base directory for the FileStore (typically the .apex-data path). */
  dataDir: string;

  /** Logger instance for debug output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default rolling window size. */
const DEFAULT_WINDOW_SIZE = 50;

/** FileStore collection name for metrics persistence. */
const METRICS_COLLECTION = 'metrics';

/** FileStore document ID for the canonical metrics record. */
const METRICS_DOC_ID = 'tracker';

/** Minimum absolute slope to classify a trend as improving or declining. */
const TREND_SLOPE_THRESHOLD = 0.005;

/** Minimum number of data points needed to compute a meaningful trend. */
const MIN_TREND_POINTS = 3;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a number to the [0, 1] range.
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// MetricsTracker class
// ---------------------------------------------------------------------------

/**
 * Tracks per-iteration performance metrics, computes rolling aggregates,
 * monitors memory pressure, and exports learning-curve data.
 *
 * Synchronous methods perform pure computation over the in-memory stats
 * array. Async methods (`save`, `load`) handle disk persistence via FileStore.
 */
export class MetricsTracker {
  private readonly windowSize: number;
  private readonly store: FileStore;
  private readonly logger: Logger;

  /** Ordered list of all recorded iteration stats. */
  private stats: IterationStats[] = [];

  constructor(options: MetricsOptions) {
    this.windowSize = options.rollingWindowSize ?? DEFAULT_WINDOW_SIZE;
    this.store = new FileStore(options.dataDir);
    this.logger = options.logger ?? new Logger({ prefix: 'metrics-tracker' });
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------

  /**
   * Append a new iteration's statistics to the tracker.
   *
   * @param stats - The iteration stats to record.
   */
  recordIteration(stats: IterationStats): void {
    this.stats.push(stats);
    this.logger.debug('Iteration recorded', {
      iteration: stats.iteration,
      success: stats.outcome.success,
      reward: stats.outcome.reward,
      totalRecorded: this.stats.length,
    });
  }

  // -----------------------------------------------------------------------
  // Rolling aggregates
  // -----------------------------------------------------------------------

  /**
   * Compute rolling aggregate statistics over the most recent window.
   *
   * If fewer iterations than the window size have been recorded, the
   * available iterations are used (the window shrinks to fit).
   *
   * @returns The computed rolling aggregates.
   */
  getRollingAggregates(): RollingAggregates {
    const window = this.stats.slice(-this.windowSize);
    const n = window.length;

    if (n === 0) {
      return {
        windowSize: this.windowSize,
        successRate: 0,
        avgReward: 0,
        avgDifficulty: 0,
        avgActionsPerTask: 0,
        skillGrowthRate: 0,
        rewardTrend: 'stable',
      };
    }

    const successCount = window.filter((s) => s.outcome.success).length;
    const totalReward = window.reduce((sum, s) => sum + s.outcome.reward, 0);
    const totalDifficulty = window.reduce((sum, s) => sum + s.taskDifficulty, 0);
    const totalActions = window.reduce((sum, s) => sum + s.actionsCount, 0);

    // Skill growth rate: difference in skill count across the window,
    // divided by the number of iterations in the window.
    const firstSkillCount = window[0].skillCount;
    const lastSkillCount = window[n - 1].skillCount;
    const skillGrowthRate = n > 1 ? (lastSkillCount - firstSkillCount) / (n - 1) : 0;

    const rewards = window.map((s) => s.outcome.reward);
    const rewardTrend = this.detectTrend(rewards);

    return {
      windowSize: this.windowSize,
      successRate: clamp01(successCount / n),
      avgReward: totalReward / n,
      avgDifficulty: totalDifficulty / n,
      avgActionsPerTask: totalActions / n,
      skillGrowthRate,
      rewardTrend,
    };
  }

  // -----------------------------------------------------------------------
  // Memory pressure
  // -----------------------------------------------------------------------

  /**
   * Compute memory pressure indicators from tier sizes and counts.
   *
   * @param tierSizes     - Current number of entries in each memory tier.
   * @param tierLimits    - Maximum allowed entries per tier.
   * @param evictionCount - Number of evictions in the most recent consolidation pass.
   * @param hotCount      - Number of entries with heat score above threshold.
   * @param staleCount    - Number of entries flagged as stale.
   * @param totalEntries  - Total number of entries across all tiers.
   * @returns The computed memory pressure indicators.
   */
  getMemoryPressure(
    tierSizes: Record<MemoryTier, number>,
    tierLimits: Record<MemoryTier, number>,
    evictionCount: number,
    hotCount: number,
    staleCount: number,
    totalEntries: number,
  ): MemoryPressure {
    const tiers: MemoryTier[] = ['working', 'episodic', 'semantic', 'procedural'];

    const tierUtilization = {} as Record<
      MemoryTier,
      { used: number; limit: number; percentage: number }
    >;

    for (const tier of tiers) {
      const used = tierSizes[tier] ?? 0;
      const limit = tierLimits[tier] ?? 1;
      tierUtilization[tier] = {
        used,
        limit,
        percentage: limit > 0 ? clamp01(used / limit) * 100 : 0,
      };
    }

    const safeTotalEntries = totalEntries > 0 ? totalEntries : 1;

    return {
      tierUtilization,
      evictionRate: evictionCount,
      hotEntryPercentage: clamp01(hotCount / safeTotalEntries) * 100,
      staleEntryPercentage: clamp01(staleCount / safeTotalEntries) * 100,
    };
  }

  // -----------------------------------------------------------------------
  // Learning curve
  // -----------------------------------------------------------------------

  /**
   * Compute learning-curve data points from all recorded iterations.
   *
   * Each point includes the rolling success rate and average reward
   * computed up to that iteration (using the configured window size).
   *
   * @returns An array of learning curve data points.
   */
  getLearningCurve(): LearningCurvePoint[] {
    const points: LearningCurvePoint[] = [];

    for (let i = 0; i < this.stats.length; i++) {
      const windowStart = Math.max(0, i + 1 - this.windowSize);
      const window = this.stats.slice(windowStart, i + 1);
      const n = window.length;

      const successCount = window.filter((s) => s.outcome.success).length;
      const totalReward = window.reduce((sum, s) => sum + s.outcome.reward, 0);

      const stat = this.stats[i];
      points.push({
        iteration: stat.iteration,
        timestamp: stat.timestamp,
        successRate: clamp01(successCount / n),
        avgReward: totalReward / n,
        skillCount: stat.skillCount,
        difficulty: stat.taskDifficulty,
      });
    }

    return points;
  }

  // -----------------------------------------------------------------------
  // Snapshot
  // -----------------------------------------------------------------------

  /**
   * Produce a complete metrics snapshot including rolling aggregates,
   * memory pressure (with default zero values for eviction/hot/stale),
   * learning curve, and all raw stats.
   *
   * @param tierSizes  - Current number of entries per memory tier.
   * @param tierLimits - Maximum allowed entries per memory tier.
   * @returns A full metrics snapshot.
   */
  getSnapshot(
    tierSizes: Record<MemoryTier, number>,
    tierLimits: Record<MemoryTier, number>,
  ): MetricsSnapshot {
    const totalEntries = Object.values(tierSizes).reduce((a, b) => a + b, 0);

    return {
      capturedAt: Date.now(),
      totalIterations: this.stats.length,
      rolling: this.getRollingAggregates(),
      pressure: this.getMemoryPressure(tierSizes, tierLimits, 0, 0, 0, totalEntries),
      learningCurve: this.getLearningCurve(),
      allStats: [...this.stats],
    };
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  /**
   * Export the learning curve as a CSV string.
   *
   * Columns: iteration, timestamp, successRate, avgReward, skillCount, difficulty
   *
   * @returns A CSV-formatted string with header row.
   */
  exportCSV(): string {
    const curve = this.getLearningCurve();
    const header = 'iteration,timestamp,successRate,avgReward,skillCount,difficulty';

    if (curve.length === 0) {
      return header;
    }

    const rows = curve.map(
      (p) =>
        `${p.iteration},${p.timestamp},${p.successRate.toFixed(4)},${p.avgReward.toFixed(4)},${p.skillCount},${p.difficulty.toFixed(4)}`,
    );

    return [header, ...rows].join('\n');
  }

  /**
   * Export full metrics as a formatted JSON string.
   *
   * Includes all recorded iteration stats, rolling aggregates, and the
   * learning curve. Memory pressure is omitted since tier data is not
   * stored internally; use {@link getSnapshot} for a complete picture.
   *
   * @returns A pretty-printed JSON string.
   */
  exportJSON(): string {
    return JSON.stringify(
      {
        exportedAt: Date.now(),
        totalIterations: this.stats.length,
        rolling: this.getRollingAggregates(),
        learningCurve: this.getLearningCurve(),
        allStats: this.stats,
      },
      null,
      2,
    );
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Persist all recorded metrics to disk via FileStore.
   *
   * Writes the stats array to the `metrics` collection under a fixed
   * document ID so that subsequent loads retrieve the same data.
   */
  async save(): Promise<void> {
    await this.store.write(METRICS_COLLECTION, METRICS_DOC_ID, {
      windowSize: this.windowSize,
      stats: this.stats,
    });
    this.logger.info('Metrics saved', { iterations: this.stats.length });
  }

  /**
   * Load previously persisted metrics from disk.
   *
   * Restores the in-memory stats array from the FileStore. If no
   * persisted data is found, the tracker remains empty.
   *
   * @returns `true` if data was loaded successfully, `false` otherwise.
   */
  async load(): Promise<boolean> {
    const data = await this.store.read<{ stats: IterationStats[] }>(
      METRICS_COLLECTION,
      METRICS_DOC_ID,
    );

    if (data && Array.isArray(data.stats)) {
      this.stats = data.stats;
      this.logger.info('Metrics loaded', { iterations: this.stats.length });
      return true;
    }

    this.logger.debug('No persisted metrics found');
    return false;
  }

  // -----------------------------------------------------------------------
  // Trend detection
  // -----------------------------------------------------------------------

  /**
   * Detect the trend direction of a numeric series using linear regression.
   *
   * Fits a least-squares line to the values (indexed 0..n-1) and classifies
   * the slope:
   * - **improving** if slope > threshold
   * - **declining** if slope < -threshold
   * - **stable** otherwise
   *
   * @param values - Ordered numeric values to analyse.
   * @returns The classified trend direction.
   */
  detectTrend(values: number[]): 'improving' | 'stable' | 'declining' {
    if (values.length < MIN_TREND_POINTS) {
      return 'stable';
    }

    const n = values.length;

    // Compute means
    const meanX = (n - 1) / 2; // mean of 0..n-1
    let meanY = 0;
    for (let i = 0; i < n; i++) {
      meanY += values[i];
    }
    meanY /= n;

    // Compute slope via least-squares: slope = sum((xi - meanX)(yi - meanY)) / sum((xi - meanX)^2)
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
      const dx = i - meanX;
      numerator += dx * (values[i] - meanY);
      denominator += dx * dx;
    }

    if (denominator === 0) {
      return 'stable';
    }

    const slope = numerator / denominator;

    if (slope > TREND_SLOPE_THRESHOLD) {
      return 'improving';
    } else if (slope < -TREND_SLOPE_THRESHOLD) {
      return 'declining';
    }
    return 'stable';
  }
}
