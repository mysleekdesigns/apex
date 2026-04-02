/**
 * Difficulty Estimator for APEX Curriculum Engine
 *
 * Estimates the difficulty of tasks using multiple signals:
 * - Task complexity: text analysis (word count, technical terms, constraints)
 * - Historical difficulty: success rate across similar past attempts
 * - Novelty: similarity distance to previously attempted tasks
 *
 * Produces a composite difficulty score combining all signals, with
 * confidence-weighted blending so that complexity dominates when
 * historical data is sparse.
 *
 * Pure computation module — no I/O, no FileStore dependency.
 */

import type { Episode } from '../types.js';
import { jaccardSimilarity } from '../utils/similarity.js';
import { extractKeywords } from '../utils/embeddings.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Full difficulty estimate for a task. */
export interface DifficultyEstimate {
  /** Text-derived complexity score (0–1). */
  taskComplexity: number;

  /** Difficulty inferred from past episode outcomes (0–1). */
  historicalDifficulty: number;

  /** How different this task is from anything seen before (0–1, 1 = completely novel). */
  novelty: number;

  /** Weighted composite difficulty score (0–1). */
  composite: number;

  /** Reliability of the estimate (0–1). Higher when more historical data is available. */
  confidence: number;

  /** Individual signal values for transparency and debugging. */
  signals: Record<string, number>;
}

/** Configuration options for the DifficultyEstimator. */
export interface DifficultyEstimatorOptions {
  /** Weight given to text-based complexity in the composite score. Default: 0.3. */
  complexityWeight?: number;

  /** Weight given to historical performance in the composite score. Default: 0.5. */
  historicalWeight?: number;

  /** Weight given to novelty in the composite score. Default: 0.2. */
  noveltyWeight?: number;

  /** Logger instance for debug output. */
  logger?: Logger;
}

/** Result from historical difficulty analysis. */
interface HistoricalResult {
  /** Difficulty score derived from past failures (0–1). */
  difficulty: number;

  /** Confidence in the historical estimate (0–1). */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Word count at which complexity saturates to 1.0. */
const HIGH_COMPLEXITY_WORD_COUNT = 100;

/** Minimum keyword overlap to consider an episode "similar". */
const SIMILARITY_THRESHOLD = 0.1;

/** Number of similar episodes needed for full historical confidence. */
const FULL_CONFIDENCE_EPISODE_COUNT = 10;

/**
 * Regex patterns that indicate technical complexity.
 * Matches common code patterns, framework references, and system terms.
 */
const TECHNICAL_TERM_PATTERN =
  /\b(?:api|async|await|callback|class|component|config|database|db|debug|deploy|docker|endpoint|error|function|graphql|hook|http|import|interface|json|jwt|kubernetes|lambda|middleware|module|mutation|node|oauth|package|param|parser|plugin|promise|proxy|query|react|redux|regex|render|resolver|rest|route|runtime|schema|sdk|server|service|socket|sql|ssr|state|stream|template|test|token|transform|type|typescript|url|validation|variable|webpack|websocket|worker|xml|yaml)\b/gi;

/**
 * Patterns that indicate multi-step or conditional logic.
 */
const MULTI_STEP_PATTERN =
  /\b(?:first|then|after|before|next|finally|step\s*\d|phase\s*\d|once\s+(?:that|this|done)|followed\s+by|make\s+sure|ensure\s+that|if\s+.*then|when\s+.*should|must\s+not|do\s+not|never|always|unless|except|only\s+if|provided\s+that)\b/gi;

/**
 * Negation / constraint indicators that add difficulty.
 */
const NEGATION_PATTERN =
  /\b(?:must\s+not|do\s+not|don't|cannot|can't|never|without|no\s+\w+\s+should|avoid|exclude|prevent|disallow)\b/gi;

// ---------------------------------------------------------------------------
// Standalone pure functions
// ---------------------------------------------------------------------------

/**
 * Count unique regex matches in a string.
 *
 * @param text    - The text to search.
 * @param pattern - A global regex to apply.
 * @returns The number of matches found.
 */
function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/**
 * Clamp a number to the [0, 1] range.
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// DifficultyEstimator class
// ---------------------------------------------------------------------------

/**
 * Estimates task difficulty by combining text analysis, historical
 * performance, and novelty scoring.
 *
 * All methods are synchronous pure computations.
 */
export class DifficultyEstimator {
  private readonly complexityWeight: number;
  private readonly historicalWeight: number;
  private readonly noveltyWeight: number;
  private readonly logger: Logger;

  constructor(options: DifficultyEstimatorOptions = {}) {
    this.complexityWeight = options.complexityWeight ?? 0.3;
    this.historicalWeight = options.historicalWeight ?? 0.5;
    this.noveltyWeight = options.noveltyWeight ?? 0.2;
    this.logger = options.logger ?? new Logger({ prefix: 'difficulty-estimator' });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Produce a full difficulty estimate for a task.
   *
   * @param taskDescription - The task text to evaluate.
   * @param pastEpisodes    - Historical episodes to compare against.
   * @param constraints     - Optional explicit constraints on the task.
   * @returns A complete {@link DifficultyEstimate}.
   */
  estimate(
    taskDescription: string,
    pastEpisodes: Episode[],
    constraints?: string[],
  ): DifficultyEstimate {
    const taskComplexity = this.estimateTaskComplexity(taskDescription, constraints);
    const historical = this.estimateHistoricalDifficulty(taskDescription, pastEpisodes);
    const novelty = this.estimateNovelty(taskDescription, pastEpisodes);
    const composite = this.computeComposite(
      taskComplexity,
      historical.difficulty,
      novelty,
      historical.confidence,
    );

    const estimate: DifficultyEstimate = {
      taskComplexity,
      historicalDifficulty: historical.difficulty,
      novelty,
      composite,
      confidence: historical.confidence,
      signals: {
        wordCount: taskDescription.split(/\s+/).filter(Boolean).length,
        technicalTerms: countMatches(taskDescription, TECHNICAL_TERM_PATTERN),
        multiStepIndicators: countMatches(taskDescription, MULTI_STEP_PATTERN),
        negations: countMatches(taskDescription, NEGATION_PATTERN),
        constraintCount: constraints?.length ?? 0,
        similarEpisodes: this.countSimilarEpisodes(taskDescription, pastEpisodes),
        historicalConfidence: historical.confidence,
      },
    };

    this.logger.debug('Difficulty estimate computed', {
      taskDescription: taskDescription.slice(0, 80),
      estimate,
    });

    return estimate;
  }

  // -----------------------------------------------------------------------
  // Task complexity (text analysis)
  // -----------------------------------------------------------------------

  /**
   * Estimate task complexity from text signals alone.
   *
   * Analyses word count, technical term density, multi-step indicators,
   * negation/constraint density, and explicit constraint count.
   *
   * @param description - The task description text.
   * @param constraints - Optional explicit constraints.
   * @returns A complexity score in [0, 1].
   */
  estimateTaskComplexity(description: string, constraints?: string[]): number {
    const words = description.split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    // --- Individual signals, each normalized to [0, 1] ---

    // Word count: more words generally means a more complex task
    const wordCountSignal = clamp01(wordCount / HIGH_COMPLEXITY_WORD_COUNT);

    // Technical term density: ratio of technical terms to total words
    const technicalTermCount = countMatches(description, TECHNICAL_TERM_PATTERN);
    const technicalDensity = wordCount > 0
      ? clamp01(technicalTermCount / (wordCount * 0.3))
      : 0;

    // Multi-step indicators: presence of sequencing language
    const multiStepCount = countMatches(description, MULTI_STEP_PATTERN);
    const multiStepSignal = clamp01(multiStepCount / 5);

    // Negation / constraint language
    const negationCount = countMatches(description, NEGATION_PATTERN);
    const negationSignal = clamp01(negationCount / 3);

    // Explicit constraint count
    const constraintCount = constraints?.length ?? 0;
    const constraintSignal = clamp01(constraintCount / 5);

    // --- Weighted combination ---
    const complexity =
      0.25 * wordCountSignal +
      0.25 * technicalDensity +
      0.20 * multiStepSignal +
      0.15 * negationSignal +
      0.15 * constraintSignal;

    return clamp01(complexity);
  }

  // -----------------------------------------------------------------------
  // Historical difficulty (past episodes)
  // -----------------------------------------------------------------------

  /**
   * Estimate difficulty based on success/failure rates of similar past tasks.
   *
   * Finds episodes with keyword overlap above the similarity threshold,
   * then computes a similarity-weighted failure rate.
   *
   * @param taskDescription - The current task text.
   * @param pastEpisodes    - Historical episodes to compare against.
   * @returns Difficulty score and confidence.
   */
  estimateHistoricalDifficulty(
    taskDescription: string,
    pastEpisodes: Episode[],
  ): HistoricalResult {
    if (pastEpisodes.length === 0) {
      return { difficulty: 0.5, confidence: 0 };
    }

    const taskKeywords = new Set(extractKeywords(taskDescription));
    if (taskKeywords.size === 0) {
      return { difficulty: 0.5, confidence: 0 };
    }

    let weightedFailureSum = 0;
    let weightSum = 0;

    for (const episode of pastEpisodes) {
      const episodeKeywords = new Set(extractKeywords(episode.task));
      const similarity = jaccardSimilarity(taskKeywords, episodeKeywords);

      if (similarity < SIMILARITY_THRESHOLD) continue;

      // failure rate = 1 - reward (reward is 0–1 where 1 = perfect success)
      const failureRate = 1 - episode.reward;
      weightedFailureSum += similarity * failureRate;
      weightSum += similarity;
    }

    if (weightSum === 0) {
      return { difficulty: 0.5, confidence: 0 };
    }

    const difficulty = clamp01(weightedFailureSum / weightSum);

    // Confidence scales with the number of similar episodes found
    const similarCount = this.countSimilarEpisodes(taskDescription, pastEpisodes);
    const confidence = clamp01(similarCount / FULL_CONFIDENCE_EPISODE_COUNT);

    return { difficulty, confidence };
  }

  // -----------------------------------------------------------------------
  // Novelty estimation
  // -----------------------------------------------------------------------

  /**
   * Estimate how novel a task is compared to past episodes.
   *
   * Computes the maximum keyword similarity to any past episode task,
   * then returns `1 - maxSimilarity` so that completely new tasks score 1.0.
   *
   * @param taskDescription - The current task text.
   * @param pastEpisodes    - Historical episodes to compare against.
   * @returns Novelty score in [0, 1]. 1 = completely novel, 0 = exact match seen before.
   */
  estimateNovelty(taskDescription: string, pastEpisodes: Episode[]): number {
    if (pastEpisodes.length === 0) return 1.0;

    const taskKeywords = new Set(extractKeywords(taskDescription));
    if (taskKeywords.size === 0) return 1.0;

    let maxSimilarity = 0;

    for (const episode of pastEpisodes) {
      const episodeKeywords = new Set(extractKeywords(episode.task));
      const similarity = jaccardSimilarity(taskKeywords, episodeKeywords);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
      }
    }

    return clamp01(1 - maxSimilarity);
  }

  // -----------------------------------------------------------------------
  // Composite scoring
  // -----------------------------------------------------------------------

  /**
   * Compute the composite difficulty score from individual signals.
   *
   * When historical confidence is low, the composite shifts weight from
   * historical difficulty toward complexity (the text-only signal that is
   * always available). Specifically, the "missing" historical weight is
   * redistributed to complexity proportionally.
   *
   * @param complexity  - Text-derived complexity (0–1).
   * @param historical  - Historical difficulty from past episodes (0–1).
   * @param novelty     - Novelty score (0–1).
   * @param confidence  - Confidence in the historical estimate (0–1).
   * @returns Composite difficulty score in [0, 1].
   */
  computeComposite(
    complexity: number,
    historical: number,
    novelty: number,
    confidence: number,
  ): number {
    // Scale historical weight by confidence; redistribute unconfident
    // portion to complexity since it requires no historical data.
    const effectiveHistoricalWeight = this.historicalWeight * confidence;
    const redistributed = this.historicalWeight * (1 - confidence);
    const effectiveComplexityWeight = this.complexityWeight + redistributed;

    const composite =
      effectiveComplexityWeight * complexity +
      effectiveHistoricalWeight * historical +
      this.noveltyWeight * novelty;

    return clamp01(composite);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Count episodes whose keyword overlap with the task exceeds the
   * similarity threshold.
   */
  private countSimilarEpisodes(
    taskDescription: string,
    pastEpisodes: Episode[],
  ): number {
    const taskKeywords = new Set(extractKeywords(taskDescription));
    if (taskKeywords.size === 0) return 0;

    let count = 0;
    for (const episode of pastEpisodes) {
      const episodeKeywords = new Set(extractKeywords(episode.task));
      if (jaccardSimilarity(taskKeywords, episodeKeywords) >= SIMILARITY_THRESHOLD) {
        count++;
      }
    }
    return count;
  }
}
