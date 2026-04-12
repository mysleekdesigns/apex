/**
 * Adaptive Exploration Constants for MCTS Planning
 *
 * Replaces the fixed UCB1 exploration constant (Math.SQRT2) with
 * per-domain learned constants that adapt based on observed rewards.
 * As confidence increases, exploration decays toward a minimum,
 * implementing an explore-then-exploit strategy.
 *
 * Integration point: `createEstimator(domain)` returns a ValueEstimator
 * configured with the learned constant for that domain.
 */

import { ValueEstimator } from './value.js';
import type { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-domain exploration statistics. */
export interface DomainExplorationStats {
  /** Task domain identifier (e.g., "refactoring", "testing", "debugging"). */
  domain: string;
  /** Current learned exploration constant for this domain. */
  explorationConstant: number;
  /** Number of completed episodes used to learn this constant. */
  episodeCount: number;
  /** Running average reward when exploration was high (c > median). */
  highExplorationReward: number;
  /** Running average reward when exploration was low (c <= median). */
  lowExplorationReward: number;
  /** Number of high-exploration episodes. */
  highExplorationCount: number;
  /** Number of low-exploration episodes. */
  lowExplorationCount: number;
  /** Current confidence in this domain's learned constant [0, 1]. */
  confidence: number;
  /** Last updated timestamp. */
  updatedAt: number;
}

/** Exploration balance metrics. */
export interface ExplorationBalance {
  /** Overall exploration ratio: fraction of actions that were exploratory. */
  overallExplorationRatio: number;
  /** Per-domain breakdown. */
  perDomain: Array<{
    domain: string;
    explorationRatio: number;
    isOverExploring: boolean;
    isUnderExploring: boolean;
  }>;
  /** Recommendation for adjustment. */
  recommendation: string;
}

/** Configuration options for the adaptive exploration system. */
export interface AdaptiveExplorationOptions {
  /** FileStore instance for persistence. */
  fileStore: FileStore;
  /** Logger instance for debug output. */
  logger?: Logger;
  /** Default exploration constant. Default: Math.SQRT2. */
  defaultConstant?: number;
  /** How fast to adapt. Default: 0.1. */
  learningRate?: number;
  /** Floor for exploration constant. Default: 0.1. */
  minConstant?: number;
  /** Ceiling for exploration constant. Default: 3.0. */
  maxConstant?: number;
  /** Exploration decay rate per episode. Default: 0.995. */
  decayRate?: number;
  /** Minimum episodes before adapting. Default: 5. */
  minEpisodesForLearning?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'adaptive-exploration';
const STATS_ID = 'exploration-stats';
const OVER_EXPLORING_THRESHOLD = 0.7;
const UNDER_EXPLORING_THRESHOLD = 0.1;
const FULL_CONFIDENCE_EPISODES = 50;
const DECAY_CONFIDENCE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// AdaptiveExploration class
// ---------------------------------------------------------------------------

/**
 * Manages per-domain adaptive exploration constants for UCB1.
 *
 * Learns the optimal exploration constant for each task domain by tracking
 * whether high or low exploration produces better rewards. As confidence
 * in the learned constant grows, exploration decays toward a minimum.
 */
export class AdaptiveExploration {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly defaultConstant: number;
  private readonly learningRate: number;
  private readonly minConstant: number;
  private readonly maxConstant: number;
  private readonly decayRate: number;
  private readonly minEpisodesForLearning: number;

  /** In-memory map of domain -> stats. */
  private domainStats: Map<string, DomainExplorationStats> = new Map();

  constructor(opts: AdaptiveExplorationOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'adaptive-exploration' });
    this.defaultConstant = opts.defaultConstant ?? Math.SQRT2;
    this.learningRate = opts.learningRate ?? 0.1;
    this.minConstant = opts.minConstant ?? 0.1;
    this.maxConstant = opts.maxConstant ?? 3.0;
    this.decayRate = opts.decayRate ?? 0.995;
    this.minEpisodesForLearning = opts.minEpisodesForLearning ?? 5;
  }

  /**
   * Get the current exploration constant for a domain.
   * Returns the learned constant if enough data exists, otherwise the default.
   *
   * @param domain - Task domain identifier.
   * @returns The exploration constant to use for this domain.
   */
  getExplorationConstant(domain: string): number {
    const stats = this.domainStats.get(domain);
    if (!stats || stats.episodeCount < this.minEpisodesForLearning) {
      return this.defaultConstant;
    }
    return stats.explorationConstant;
  }

  /**
   * Record the outcome of an episode for a given domain.
   * Updates the learned exploration constant based on whether high or low
   * exploration produced better rewards.
   *
   * @param domain - Task domain identifier.
   * @param reward - Outcome reward [0, 1].
   * @param explorationLevel - The exploration constant that was used.
   */
  recordOutcome(domain: string, reward: number, explorationLevel: number): void {
    let stats = this.domainStats.get(domain);
    if (!stats) {
      stats = this.createDefaultStats(domain);
      this.domainStats.set(domain, stats);
    }

    stats.episodeCount++;

    // Determine if exploration level was "high" or "low" relative to current constant
    const median = stats.explorationConstant;
    const isHighExploration = explorationLevel > median;

    if (isHighExploration) {
      // Update running average for high exploration reward
      stats.highExplorationCount++;
      stats.highExplorationReward =
        stats.highExplorationReward +
        (reward - stats.highExplorationReward) / stats.highExplorationCount;
    } else {
      // Update running average for low exploration reward
      stats.lowExplorationCount++;
      stats.lowExplorationReward =
        stats.lowExplorationReward +
        (reward - stats.lowExplorationReward) / stats.lowExplorationCount;
    }

    // Adapt the constant if we have enough data
    if (stats.episodeCount >= this.minEpisodesForLearning) {
      const highReward = stats.highExplorationReward;
      const lowReward = stats.lowExplorationReward;

      if (highReward > lowReward) {
        // High exploration is better — increase constant
        stats.explorationConstant += this.learningRate * (highReward - lowReward);
      } else if (lowReward > highReward) {
        // Low exploration is better — decrease constant
        stats.explorationConstant -= this.learningRate * (lowReward - highReward);
      }

      // Clamp to [minConstant, maxConstant]
      stats.explorationConstant = Math.max(
        this.minConstant,
        Math.min(this.maxConstant, stats.explorationConstant),
      );
    }

    // Update confidence: linear ramp to 1.0 at FULL_CONFIDENCE_EPISODES
    stats.confidence = Math.min(1.0, stats.episodeCount / FULL_CONFIDENCE_EPISODES);
    stats.updatedAt = Date.now();

    this.logger.debug('Recorded outcome', {
      domain,
      reward,
      explorationLevel,
      isHighExploration,
      newConstant: stats.explorationConstant,
      confidence: stats.confidence,
    });
  }

  /**
   * Apply exploration decay for a domain.
   * Called periodically to reduce exploration as confidence increases.
   * The constant approaches but never goes below minConstant.
   *
   * @param domain - Task domain identifier.
   */
  applyDecay(domain: string): void {
    const stats = this.domainStats.get(domain);
    if (!stats) return;

    // Only apply decay when we have enough confidence
    if (stats.confidence <= DECAY_CONFIDENCE_THRESHOLD) {
      this.logger.debug('Skipping decay — insufficient confidence', {
        domain,
        confidence: stats.confidence,
      });
      return;
    }

    stats.explorationConstant = Math.max(
      this.minConstant,
      stats.explorationConstant * this.decayRate,
    );
    stats.updatedAt = Date.now();

    this.logger.debug('Applied decay', {
      domain,
      newConstant: stats.explorationConstant,
    });
  }

  /**
   * Get exploration-exploitation balance metrics across all domains.
   *
   * @returns Balance metrics with per-domain breakdown and recommendation.
   */
  getBalance(): ExplorationBalance {
    const domains = Array.from(this.domainStats.values());

    let totalHighCount = 0;
    let totalLowCount = 0;

    const perDomain = domains.map((stats) => {
      const total = stats.highExplorationCount + stats.lowExplorationCount;
      const explorationRatio = total > 0 ? stats.highExplorationCount / total : 0.5;

      totalHighCount += stats.highExplorationCount;
      totalLowCount += stats.lowExplorationCount;

      return {
        domain: stats.domain,
        explorationRatio,
        isOverExploring: explorationRatio > OVER_EXPLORING_THRESHOLD,
        isUnderExploring: explorationRatio < UNDER_EXPLORING_THRESHOLD,
      };
    });

    const totalCount = totalHighCount + totalLowCount;
    const overallExplorationRatio = totalCount > 0 ? totalHighCount / totalCount : 0.5;

    // Generate recommendation
    const overExploring = perDomain.filter((d) => d.isOverExploring);
    const underExploring = perDomain.filter((d) => d.isUnderExploring);

    let recommendation = 'Exploration-exploitation balance is healthy.';
    if (overExploring.length > 0 && underExploring.length > 0) {
      recommendation =
        `Over-exploring in: ${overExploring.map((d) => d.domain).join(', ')}. ` +
        `Under-exploring in: ${underExploring.map((d) => d.domain).join(', ')}. ` +
        'Consider rebalancing exploration constants.';
    } else if (overExploring.length > 0) {
      recommendation =
        `Over-exploring in: ${overExploring.map((d) => d.domain).join(', ')}. ` +
        'Consider reducing exploration constants or applying decay.';
    } else if (underExploring.length > 0) {
      recommendation =
        `Under-exploring in: ${underExploring.map((d) => d.domain).join(', ')}. ` +
        'Consider increasing exploration constants.';
    }

    return {
      overallExplorationRatio,
      perDomain,
      recommendation,
    };
  }

  /**
   * Get stats for a specific domain.
   *
   * @param domain - Task domain identifier.
   * @returns The domain stats, or null if not tracked.
   */
  getDomainStats(domain: string): DomainExplorationStats | null {
    return this.domainStats.get(domain) ?? null;
  }

  /**
   * Get stats for all tracked domains.
   *
   * @returns Array of all domain exploration stats.
   */
  getAllStats(): DomainExplorationStats[] {
    return Array.from(this.domainStats.values());
  }

  /**
   * Create a ValueEstimator configured with the learned constant for a domain.
   * This is the primary integration point — callers get a domain-tuned estimator.
   *
   * @param domain - Task domain identifier.
   * @returns A ValueEstimator with the domain's exploration constant.
   */
  createEstimator(domain: string): ValueEstimator {
    const c = this.getExplorationConstant(domain);
    return new ValueEstimator({ explorationConstant: c });
  }

  /**
   * Persist all domain stats to the file store.
   */
  async save(): Promise<void> {
    const allStats = Array.from(this.domainStats.values());
    await this.fileStore.write(COLLECTION, STATS_ID, allStats);
    this.logger.debug('Saved exploration stats', { domainCount: allStats.length });
  }

  /**
   * Load persisted domain stats from the file store.
   */
  async load(): Promise<void> {
    const data = await this.fileStore.read<DomainExplorationStats[]>(COLLECTION, STATS_ID);
    if (data && Array.isArray(data)) {
      this.domainStats.clear();
      for (const stats of data) {
        this.domainStats.set(stats.domain, stats);
      }
      this.logger.debug('Loaded exploration stats', { domainCount: data.length });
    }
  }

  /**
   * Clear all learned data.
   */
  async clear(): Promise<void> {
    this.domainStats.clear();
    await this.fileStore.delete(COLLECTION, STATS_ID);
    this.logger.debug('Cleared all exploration stats');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Create default stats for a new domain.
   */
  private createDefaultStats(domain: string): DomainExplorationStats {
    return {
      domain,
      explorationConstant: this.defaultConstant,
      episodeCount: 0,
      highExplorationReward: 0,
      lowExplorationReward: 0,
      highExplorationCount: 0,
      lowExplorationCount: 0,
      confidence: 0,
      updatedAt: Date.now(),
    };
  }
}
