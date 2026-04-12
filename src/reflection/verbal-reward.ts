/**
 * Verbal Reward Signal Generator
 *
 * Converts episodic experience into natural-language reward signals that
 * capture *why* an approach succeeded or failed. Also generates contrastive
 * pairs linking a failed attempt with a successful one for the same task
 * type, enabling the agent to learn from differential feedback.
 *
 * Part of Phase 12: Verbal Reinforcement Learning / Reflexion.
 *
 * Zero LLM calls — pure data infrastructure.
 */

import type { Episode, Action } from '../types.js';
import { generateId } from '../types.js';
import type { FileStore } from '../utils/file-store.js';
import type { SemanticMemory } from '../memory/semantic.js';
import { getEmbedding } from '../utils/embeddings.js';
import { combinedSimilarity } from '../utils/similarity.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FileStore collection for persisting verbal rewards. */
const REWARDS_COLLECTION = 'verbal-rewards';

/** FileStore collection for persisting contrastive pairs. */
const PAIRS_COLLECTION = 'contrastive-pairs';

/** Default similarity threshold for contrastive pair matching. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.3;

/** Maximum number of actions to include in a signal summary. */
const DEFAULT_MAX_ACTIONS = 5;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A verbal reward signal derived from an episode. */
export interface VerbalReward {
  /** Unique ID for this reward signal. */
  id: string;

  /** The source episode ID. */
  episodeId: string;

  /** Natural language reward signal. */
  signal: string;

  /** Scalar reward value from the episode (0-1). */
  reward: number;

  /** Whether the episode was successful. */
  success: boolean;

  /** Task category/type extracted from the episode. */
  taskType: string;

  /** Timestamp of creation. */
  timestamp: number;
}

/** A contrastive pair linking a failed approach with a successful one. */
export interface ContrastivePair {
  /** ID of the failed episode. */
  failedEpisodeId: string;

  /** ID of the successful episode. */
  successEpisodeId: string;

  /** Natural language description of what differed. */
  contrastiveSignal: string;

  /** The task type both episodes share. */
  taskType: string;

  /** Timestamp of creation. */
  timestamp: number;
}

/** Configuration for the {@link VerbalRewardGenerator}. */
export interface VerbalRewardGeneratorOptions {
  /** FileStore instance for persistence. */
  fileStore: FileStore;

  /** SemanticMemory instance for storing reward signals as searchable memory. */
  semanticMemory: SemanticMemory;

  /** Optional logger instance. */
  logger?: Logger;

  /** Minimum similarity for contrastive pair matching (default 0.3). */
  similarityThreshold?: number;
}

// ---------------------------------------------------------------------------
// VerbalRewardGenerator
// ---------------------------------------------------------------------------

/**
 * Generates natural-language reward signals from episodes and stores them
 * for future retrieval. Supports contrastive pair generation to highlight
 * what differentiates successful from failed approaches.
 */
export class VerbalRewardGenerator {
  private readonly fileStore: FileStore;
  private readonly semanticMemory: SemanticMemory;
  private readonly logger: Logger;
  private readonly similarityThreshold: number;

  constructor(options: VerbalRewardGeneratorOptions) {
    this.fileStore = options.fileStore;
    this.semanticMemory = options.semanticMemory;
    this.logger = options.logger ?? new Logger({ prefix: 'apex:verbal-reward' });
    this.similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  /**
   * Convert an episode into a verbal reward signal.
   *
   * For successful episodes the signal highlights which actions led to
   * success. For failures it explains the cause and warns against the
   * failing actions.
   */
  generateReward(episode: Episode): VerbalReward {
    const taskType = this.extractTaskType(episode.task);
    const actionSummary = this.summarizeActions(episode.actions);
    let signal: string;

    if (episode.outcome.success) {
      signal =
        `When ${episode.task}, the approach of ${actionSummary} succeeded. ` +
        `The outcome was: ${episode.outcome.description}. ` +
        `Reward: ${episode.reward}.`;
    } else {
      const reason = episode.outcome.errorType ?? episode.outcome.description;
      const failedActions = this.summarizeActions(
        episode.actions.filter((a) => !a.success),
      );
      signal =
        `When ${episode.task}, the approach of ${actionSummary} failed because ${reason}. ` +
        `Avoid: ${failedActions || 'the attempted approach'}. ` +
        `Reward: ${episode.reward}.`;
    }

    const reward: VerbalReward = {
      id: generateId(),
      episodeId: episode.id,
      signal,
      reward: episode.reward,
      success: episode.outcome.success,
      taskType,
      timestamp: Date.now(),
    };

    this.logger.debug('Generated verbal reward', {
      episodeId: episode.id,
      success: reward.success,
      taskType,
    });

    return reward;
  }

  /**
   * Find a successful episode with a similar task to the given failed episode
   * and generate a contrastive signal describing what differed.
   *
   * Returns `null` if no matching successful episode is found above the
   * similarity threshold.
   */
  async generateContrastivePair(failedEpisode: Episode): Promise<ContrastivePair | null> {
    if (failedEpisode.outcome.success) {
      this.logger.debug('Skipping contrastive pair — episode is not a failure', {
        episodeId: failedEpisode.id,
      });
      return null;
    }

    const successEpisode = await this.findContrastiveEpisode(failedEpisode);
    if (!successEpisode) {
      this.logger.debug('No matching success episode found for contrastive pair', {
        episodeId: failedEpisode.id,
      });
      return null;
    }

    const taskType = this.extractTaskType(failedEpisode.task);
    const failedActions = this.summarizeActions(failedEpisode.actions);
    const successActions = this.summarizeActions(successEpisode.actions);
    const failReason = failedEpisode.outcome.errorType ?? failedEpisode.outcome.description;
    const successReason = successEpisode.outcome.description;

    const contrastiveSignal =
      `For ${taskType}: approach A (${failedActions}) failed because ${failReason}, ` +
      `while approach B (${successActions}) succeeded because ${successReason}. ` +
      `Key difference: ${this.describeKeyDifference(failedEpisode, successEpisode)}.`;

    const pair: ContrastivePair = {
      failedEpisodeId: failedEpisode.id,
      successEpisodeId: successEpisode.id,
      contrastiveSignal,
      taskType,
      timestamp: Date.now(),
    };

    // Persist the contrastive pair
    await this.fileStore.write(PAIRS_COLLECTION, `${pair.failedEpisodeId}-${pair.successEpisodeId}`, pair);

    this.logger.debug('Generated contrastive pair', {
      failedEpisodeId: failedEpisode.id,
      successEpisodeId: successEpisode.id,
      taskType,
    });

    return pair;
  }

  /**
   * Store a verbal reward in both the FileStore and semantic memory for
   * future retrieval.
   *
   * @returns The semantic memory entry ID.
   */
  async storeRewardAsMemory(reward: VerbalReward): Promise<string> {
    // Persist in FileStore
    await this.fileStore.write(REWARDS_COLLECTION, reward.id, reward);

    // Store in semantic memory with a tagged prefix for easy filtering
    const label = reward.success ? 'success' : 'failure';
    const content = `[VerbalReward:${label}] ${reward.signal}`;
    const confidence = reward.reward;

    const entryId = await this.semanticMemory.add(content, { confidence });

    this.logger.debug('Stored verbal reward in semantic memory', {
      rewardId: reward.id,
      entryId,
      confidence,
    });

    return entryId;
  }

  /**
   * Generate verbal rewards for multiple episodes in batch.
   */
  async generateBatchRewards(episodes: Episode[]): Promise<VerbalReward[]> {
    const rewards: VerbalReward[] = [];
    for (const episode of episodes) {
      const reward = this.generateReward(episode);
      rewards.push(reward);
    }
    return rewards;
  }

  /**
   * Retrieve stored verbal rewards for a given task type.
   *
   * @param taskType - The task category to filter by.
   * @param limit - Maximum number of rewards to return (default: all).
   */
  async getRewardsForTaskType(taskType: string, limit?: number): Promise<VerbalReward[]> {
    const allRewards = await this.fileStore.readAll<VerbalReward>(REWARDS_COLLECTION);
    const normalised = taskType.toLowerCase();

    const filtered = allRewards.filter(
      (r) => r.taskType.toLowerCase() === normalised,
    );

    // Sort by timestamp descending (newest first)
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    if (limit !== undefined && limit > 0) {
      return filtered.slice(0, limit);
    }

    return filtered;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Extract a short task type from the episode task description by taking
   * the first few meaningful keywords.
   */
  private extractTaskType(task: string): string {
    const words = task
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);

    return words.slice(0, 4).join(' ') || 'unknown';
  }

  /**
   * Summarise a list of actions into a human-readable string.
   *
   * @param actions - The actions to summarise.
   * @param maxActions - Maximum number of actions to include (default 5).
   */
  private summarizeActions(actions: Action[], maxActions: number = DEFAULT_MAX_ACTIONS): string {
    if (actions.length === 0) return 'no recorded actions';

    const limited = actions.slice(0, maxActions);
    const descriptions = limited.map((a) => a.description);
    const summary = descriptions.join(', ');

    if (actions.length > maxActions) {
      return `${summary}, and ${actions.length - maxActions} more action(s)`;
    }

    return summary;
  }

  /**
   * Find the best matching successful episode for a given failed episode
   * using embedding-based similarity.
   *
   * Returns `null` if no episode exceeds the similarity threshold.
   */
  private async findContrastiveEpisode(failedEpisode: Episode): Promise<Episode | null> {
    const allEpisodes = await this.fileStore.readAll<Episode>('episodes');

    // Only consider successful episodes
    const successEpisodes = allEpisodes.filter((e) => e.outcome.success);
    if (successEpisodes.length === 0) return null;

    const failedEmbedding = getEmbedding(failedEpisode.task);

    let bestEpisode: Episode | null = null;
    let bestScore = -1;

    for (const candidate of successEpisodes) {
      const candidateEmbedding = getEmbedding(candidate.task);
      const score = combinedSimilarity(
        { keywords: failedEmbedding.keywords, simhash: failedEmbedding.simhash },
        { keywords: candidateEmbedding.keywords, simhash: candidateEmbedding.simhash },
      );

      if (score > bestScore && score >= this.similarityThreshold) {
        bestScore = score;
        bestEpisode = candidate;
      }
    }

    return bestEpisode;
  }

  /**
   * Describe the key difference between a failed and a successful episode
   * by comparing their action types.
   */
  private describeKeyDifference(failed: Episode, success: Episode): string {
    const failedTypes = new Set(failed.actions.map((a) => a.type));
    const successTypes = new Set(success.actions.map((a) => a.type));

    const onlyInSuccess = [...successTypes].filter((t) => !failedTypes.has(t));
    const onlyInFailed = [...failedTypes].filter((t) => !successTypes.has(t));

    const parts: string[] = [];
    if (onlyInSuccess.length > 0) {
      parts.push(`the successful approach included ${onlyInSuccess.join(', ')}`);
    }
    if (onlyInFailed.length > 0) {
      parts.push(`the failed approach relied on ${onlyInFailed.join(', ')}`);
    }

    if (parts.length === 0) {
      return 'the approaches used similar action types but differed in execution';
    }

    return parts.join(' while ');
  }
}
