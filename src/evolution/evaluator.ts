/**
 * Self-Evaluation Module for APEX Evolution Engine
 *
 * Scores episode outcomes using multiple heuristic signals:
 * - Binary success/fail from the outcome record
 * - Continuous quality score derived from action success rates and reward
 * - Completeness estimate based on action progression
 * - Efficiency score comparing action count to a configurable baseline
 * - Novelty detection via keyword similarity to past episodes
 * - Reference comparison when a known-good solution is available
 *
 * Also assembles structured data ("judge prompt data") that Claude Code
 * can use for LLM-as-judge evaluation. This module itself makes zero
 * LLM API calls — it is a pure data/computation layer.
 */

import type { Episode, Outcome } from '../types.js';
import { Logger } from '../utils/logger.js';
import { jaccardSimilarity } from '../utils/similarity.js';
import { extractKeywords } from '../utils/embeddings.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Complete evaluation result for a single episode. */
export interface EvaluationResult {
  /** The episode that was evaluated. */
  episodeId: string;

  /** Whether the episode achieved its goal. */
  binarySuccess: boolean;

  /** Continuous quality score in [0, 1]. */
  qualityScore: number;

  /** Estimated fraction of the task that was completed, in [0, 1]. */
  completeness: number;

  /** How efficiently the task was performed, in [0, 1] (fewer actions = better). */
  efficiency: number;

  /** How novel this task was relative to past episodes, in [0, 1] (1 = completely novel). */
  novelty: number;

  /** Confidence in this evaluation, in [0, 1]. */
  confidence: number;

  /** Breakdown of individual scoring signals for transparency. */
  signals: Record<string, number>;
}

/**
 * Structured data prepared for Claude Code to perform LLM-as-judge evaluation.
 *
 * This module assembles the data; the actual LLM call happens in Claude Code's
 * conversation context, not here.
 */
export interface JudgePromptData {
  /** The original task description. */
  taskDescription: string;

  /** Summarised descriptions of each action taken during the episode. */
  actionsSummary: string[];

  /** The episode's outcome record. */
  outcome: Outcome;

  /** The heuristic quality score computed by this module. */
  heuristicScore: number;

  /** Expected solution description, if a reference was provided. */
  referenceSolution?: string;

  /** Outcomes from similar past episodes for comparative context. */
  similarPastOutcomes: Array<{ task: string; reward: number; success: boolean }>;
}

/** A reference solution used for comparison-based scoring. */
export interface ReferenceSolution {
  /** Regex or keyword pattern that identifies which tasks this reference applies to. */
  taskPattern: string;

  /** Description of what a successful outcome looks like. */
  expectedOutcome: string;

  /** Rubric items that define quality criteria. */
  qualityCriteria: string[];
}

/** Configuration options for the SelfEvaluator. */
export interface EvaluatorOptions {
  /** Expected number of actions for a "normal" task. Used as the efficiency baseline. Default: 10. */
  efficiencyBaseline?: number;

  /** Similarity below this threshold means the task is considered novel. Default: 0.15. */
  noveltyThreshold?: number;

  /** Logger instance for debug output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default expected action count for efficiency scoring. */
const DEFAULT_EFFICIENCY_BASELINE = 10;

/** Default similarity threshold below which a task is considered novel. */
const DEFAULT_NOVELTY_THRESHOLD = 0.15;

/** Minimum keyword overlap to consider an episode "similar" for historical context. */
const SIMILARITY_THRESHOLD = 0.1;

/** Number of similar past episodes needed for full evaluation confidence. */
const FULL_CONFIDENCE_EPISODE_COUNT = 10;

/** Maximum number of similar past outcomes to include in judge prompt data. */
const MAX_SIMILAR_OUTCOMES = 5;

// ---------------------------------------------------------------------------
// Standalone pure functions
// ---------------------------------------------------------------------------

/**
 * Clamp a number to the [0, 1] range.
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// SelfEvaluator class
// ---------------------------------------------------------------------------

/**
 * Evaluates episode outcomes using heuristic scoring signals and
 * prepares structured data for LLM-as-judge evaluation.
 *
 * All methods are synchronous pure computations — no I/O, no LLM calls.
 */
export class SelfEvaluator {
  private readonly efficiencyBaseline: number;
  private readonly noveltyThreshold: number;
  private readonly logger: Logger;

  constructor(options: EvaluatorOptions = {}) {
    this.efficiencyBaseline = options.efficiencyBaseline ?? DEFAULT_EFFICIENCY_BASELINE;
    this.noveltyThreshold = options.noveltyThreshold ?? DEFAULT_NOVELTY_THRESHOLD;
    this.logger = options.logger ?? new Logger({ prefix: 'self-evaluator' });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Produce a full evaluation of an episode.
   *
   * Combines binary success, continuous quality, completeness, efficiency,
   * novelty, and optional reference comparison into a single result with
   * a confidence score and signal breakdown.
   *
   * @param episode       - The episode to evaluate.
   * @param pastEpisodes  - Historical episodes for novelty and confidence calculation.
   * @param reference     - Optional reference solution to score against.
   * @returns A complete {@link EvaluationResult}.
   */
  evaluate(
    episode: Episode,
    pastEpisodes: Episode[],
    reference?: ReferenceSolution,
  ): EvaluationResult {
    const binarySuccess = this.scoreBinary(episode.outcome);
    const quality = this.scoreQuality(episode);
    const completeness = this.scoreCompleteness(episode);
    const efficiency = this.scoreEfficiency(episode);
    const novelty = this.detectNovelty(episode, pastEpisodes);
    const referenceScore = reference
      ? this.compareToReference(episode, reference)
      : undefined;

    // Confidence is based on how much historical data is available.
    // More similar episodes = higher confidence in the evaluation.
    const similarCount = this.countSimilarEpisodes(episode, pastEpisodes);
    const historicalConfidence = clamp01(similarCount / FULL_CONFIDENCE_EPISODE_COUNT);

    // Base confidence from the episode's own signals
    const hasActions = episode.actions.length > 0;
    const hasOutcome = episode.outcome.description.length > 0;
    const intrinsicConfidence = (hasActions ? 0.4 : 0) + (hasOutcome ? 0.4 : 0) + 0.2;

    // Blend intrinsic and historical confidence
    const confidence = clamp01(0.6 * intrinsicConfidence + 0.4 * historicalConfidence);

    // Composite quality score: blend heuristic quality with reference score if available
    const qualityScore = referenceScore !== undefined
      ? clamp01(0.6 * quality + 0.4 * referenceScore)
      : quality;

    const signals: Record<string, number> = {
      binarySuccess: binarySuccess ? 1 : 0,
      rawQuality: quality,
      completeness,
      efficiency,
      novelty,
      episodeReward: episode.reward,
      actionCount: episode.actions.length,
      successfulActions: episode.actions.filter(a => a.success).length,
      similarEpisodeCount: similarCount,
      historicalConfidence,
      intrinsicConfidence,
    };

    if (referenceScore !== undefined) {
      signals.referenceScore = referenceScore;
    }

    const result: EvaluationResult = {
      episodeId: episode.id,
      binarySuccess,
      qualityScore,
      completeness,
      efficiency,
      novelty,
      confidence,
      signals,
    };

    this.logger.debug('Evaluation complete', {
      episodeId: episode.id,
      task: episode.task.slice(0, 80),
      result,
    });

    return result;
  }

  /**
   * Determine binary success/failure from an outcome.
   *
   * @param outcome - The episode outcome to classify.
   * @returns `true` if the outcome indicates success.
   */
  scoreBinary(outcome: Outcome): boolean {
    return outcome.success;
  }

  /**
   * Compute a continuous quality score from episode heuristics.
   *
   * Blends the episode reward with the action success rate to produce
   * a score that reflects both the final result and the quality of
   * intermediate steps.
   *
   * @param episode - The episode to score.
   * @returns Quality score in [0, 1].
   */
  scoreQuality(episode: Episode): number {
    const reward = episode.reward;

    if (episode.actions.length === 0) {
      // No actions taken — rely solely on the reward signal
      return clamp01(reward);
    }

    const successfulActions = episode.actions.filter(a => a.success).length;
    const actionSuccessRate = successfulActions / episode.actions.length;

    // Weight reward more heavily than action success rate, since the
    // reward captures the overall outcome while action success rate
    // captures process quality.
    return clamp01(0.7 * reward + 0.3 * actionSuccessRate);
  }

  /**
   * Estimate what fraction of the task was completed.
   *
   * Uses a combination of signals:
   * - If the outcome is successful, completeness is at least 0.8
   * - Action success rate indicates partial progress
   * - A penalty applies if the episode ended with an error
   *
   * @param episode - The episode to assess.
   * @returns Completeness estimate in [0, 1].
   */
  scoreCompleteness(episode: Episode): number {
    if (episode.outcome.success) {
      // Successful outcome means at least 80% complete; boost with action rate
      const actionRate = episode.actions.length > 0
        ? episode.actions.filter(a => a.success).length / episode.actions.length
        : 1;
      return clamp01(0.8 + 0.2 * actionRate);
    }

    // Failed outcome — estimate partial completion from actions
    if (episode.actions.length === 0) {
      return 0;
    }

    const successfulActions = episode.actions.filter(a => a.success).length;
    const actionProgress = successfulActions / episode.actions.length;

    // Scale down: even with many successful actions, failure caps completeness
    const errorPenalty = episode.outcome.errorType ? 0.1 : 0;
    return clamp01(actionProgress * 0.6 - errorPenalty);
  }

  /**
   * Score how efficiently the episode was executed.
   *
   * Compares the number of actions taken to the configured efficiency
   * baseline. Fewer actions (relative to the baseline) = higher score.
   * A perfect score means the task was completed in one action.
   *
   * @param episode - The episode to score.
   * @returns Efficiency score in [0, 1].
   */
  scoreEfficiency(episode: Episode): number {
    const actionCount = episode.actions.length;

    if (actionCount === 0) {
      // No actions — ambiguous; return neutral score
      return 0.5;
    }

    // Efficiency decays as action count exceeds the baseline.
    // At baseline count, efficiency is ~0.5. At 1 action, it's ~1.0.
    // Formula: baseline / (baseline + actionCount - 1)
    // This gives a smooth decay that never reaches 0.
    const efficiency = this.efficiencyBaseline / (this.efficiencyBaseline + actionCount - 1);
    return clamp01(efficiency);
  }

  /**
   * Detect how novel an episode's task is compared to past episodes.
   *
   * Uses Jaccard similarity on extracted keywords. If the maximum
   * similarity to any past episode is below the novelty threshold,
   * the task is considered fully novel.
   *
   * @param episode       - The episode to assess.
   * @param pastEpisodes  - Historical episodes to compare against.
   * @returns Novelty score in [0, 1]. 1 = completely novel, 0 = exact match seen before.
   */
  detectNovelty(episode: Episode, pastEpisodes: Episode[]): number {
    if (pastEpisodes.length === 0) return 1.0;

    const taskKeywords = new Set(extractKeywords(episode.task));
    if (taskKeywords.size === 0) return 1.0;

    let maxSimilarity = 0;

    for (const past of pastEpisodes) {
      // Skip self-comparison
      if (past.id === episode.id) continue;

      const pastKeywords = new Set(extractKeywords(past.task));
      const similarity = jaccardSimilarity(taskKeywords, pastKeywords);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
      }
    }

    return clamp01(1 - maxSimilarity);
  }

  /**
   * Score an episode against a reference solution.
   *
   * Checks whether the episode's outcome description and actions
   * mention the quality criteria from the reference. Each matched
   * criterion contributes equally to the score.
   *
   * @param episode   - The episode to compare.
   * @param reference - The reference solution with quality criteria.
   * @returns Score in [0, 1] indicating how well the episode matches the reference.
   */
  compareToReference(episode: Episode, reference: ReferenceSolution): number {
    if (reference.qualityCriteria.length === 0) {
      // No criteria to check — fall back to binary outcome match
      return episode.outcome.success ? 1.0 : 0.0;
    }

    // Build a searchable text corpus from the episode
    const corpus = [
      episode.task,
      episode.outcome.description,
      ...episode.actions.map(a => a.description),
      ...episode.actions.map(a => a.result ?? ''),
    ].join(' ').toLowerCase();

    let matchedCriteria = 0;

    for (const criterion of reference.qualityCriteria) {
      // Extract meaningful words from the criterion and check if
      // a majority appear in the corpus
      const criterionWords = criterion.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (criterionWords.length === 0) {
        matchedCriteria++;
        continue;
      }

      const matchedWords = criterionWords.filter(word => corpus.includes(word));
      const matchRatio = matchedWords.length / criterionWords.length;

      // Consider the criterion met if at least 50% of its words appear
      if (matchRatio >= 0.5) {
        matchedCriteria++;
      }
    }

    const criteriaScore = matchedCriteria / reference.qualityCriteria.length;

    // Blend criteria match with outcome success
    const outcomeBonus = episode.outcome.success ? 0.2 : 0;
    return clamp01(0.8 * criteriaScore + outcomeBonus);
  }

  /**
   * Assemble structured data for Claude Code to perform LLM-as-judge evaluation.
   *
   * Collects the task description, action summaries, outcome, heuristic score,
   * optional reference solution, and similar past outcomes into a single object
   * that can be presented to Claude in a conversation turn.
   *
   * @param episode       - The episode to prepare judge data for.
   * @param pastEpisodes  - Historical episodes for comparative context.
   * @param reference     - Optional reference solution.
   * @returns Structured {@link JudgePromptData} ready for LLM consumption.
   */
  assembleJudgeData(
    episode: Episode,
    pastEpisodes: Episode[],
    reference?: ReferenceSolution,
  ): JudgePromptData {
    const heuristicScore = this.scoreQuality(episode);

    // Summarise actions into concise descriptions
    const actionsSummary = episode.actions.map((action, index) => {
      const status = action.success ? 'OK' : 'FAIL';
      const result = action.result ? ` -> ${action.result.slice(0, 100)}` : '';
      return `[${index + 1}] (${status}) ${action.type}: ${action.description}${result}`;
    });

    // Find similar past outcomes for comparative context
    const similarPastOutcomes = this.findSimilarOutcomes(episode, pastEpisodes);

    const judgeData: JudgePromptData = {
      taskDescription: episode.task,
      actionsSummary,
      outcome: episode.outcome,
      heuristicScore,
      similarPastOutcomes,
    };

    if (reference) {
      judgeData.referenceSolution = [
        `Expected: ${reference.expectedOutcome}`,
        `Criteria: ${reference.qualityCriteria.join('; ')}`,
      ].join('\n');
    }

    this.logger.debug('Judge prompt data assembled', {
      episodeId: episode.id,
      actionCount: actionsSummary.length,
      similarOutcomeCount: similarPastOutcomes.length,
    });

    return judgeData;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Count episodes whose keyword overlap with the current episode exceeds
   * the similarity threshold.
   */
  private countSimilarEpisodes(
    episode: Episode,
    pastEpisodes: Episode[],
  ): number {
    const taskKeywords = new Set(extractKeywords(episode.task));
    if (taskKeywords.size === 0) return 0;

    let count = 0;
    for (const past of pastEpisodes) {
      if (past.id === episode.id) continue;
      const pastKeywords = new Set(extractKeywords(past.task));
      if (jaccardSimilarity(taskKeywords, pastKeywords) >= SIMILARITY_THRESHOLD) {
        count++;
      }
    }
    return count;
  }

  /**
   * Find past episodes with similar tasks and return their outcomes
   * for inclusion in judge prompt data.
   *
   * Returns up to {@link MAX_SIMILAR_OUTCOMES} results, sorted by
   * descending similarity.
   */
  private findSimilarOutcomes(
    episode: Episode,
    pastEpisodes: Episode[],
  ): Array<{ task: string; reward: number; success: boolean }> {
    const taskKeywords = new Set(extractKeywords(episode.task));
    if (taskKeywords.size === 0) return [];

    const scored: Array<{
      similarity: number;
      task: string;
      reward: number;
      success: boolean;
    }> = [];

    for (const past of pastEpisodes) {
      if (past.id === episode.id) continue;

      const pastKeywords = new Set(extractKeywords(past.task));
      const similarity = jaccardSimilarity(taskKeywords, pastKeywords);

      if (similarity >= SIMILARITY_THRESHOLD) {
        scored.push({
          similarity,
          task: past.task,
          reward: past.reward,
          success: past.outcome.success,
        });
      }
    }

    // Sort by descending similarity and take the top results
    scored.sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, MAX_SIMILAR_OUTCOMES).map(({ task, reward, success }) => ({
      task,
      reward,
      success,
    }));
  }
}
