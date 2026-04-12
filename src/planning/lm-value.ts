/**
 * LM Value Function Interface for MCTS Planning
 *
 * Provides a language-model-assisted value function that:
 * 1. Generates structured prompt templates for plan evaluation
 * 2. Caches and stores evaluation results
 * 3. Tracks accuracy of LM predictions vs actual outcomes
 *
 * This is a pure data module — it does NOT call an LLM. It generates prompts
 * that the agent (Claude) can use to evaluate plans, and records the results.
 */

import { generateId } from '../types.js';
import type { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_MAX_SIZE = 500;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
const CALIBRATION_RANGES: Array<[number, number]> = [
  [0.0, 0.2],
  [0.2, 0.4],
  [0.4, 0.6],
  [0.6, 0.8],
  [0.8, 1.0],
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A structured prompt for LM plan evaluation. */
export interface LMValuePrompt {
  /** Unique ID for this evaluation request. */
  id: string;
  /** The state being evaluated. */
  stateDescription: string;
  /** The candidate action. */
  action: string;
  /** Context: relevant past outcomes for similar actions. */
  historicalContext: string[];
  /** The formatted prompt text for Claude to evaluate (score 0-1). */
  promptText: string;
  /** When this prompt was generated. */
  createdAt: number;
}

/** A cached LM evaluation result. */
export interface LMValueEvaluation {
  /** Links back to the prompt. */
  promptId: string;
  /** The state that was evaluated. */
  stateDescription: string;
  /** The action that was evaluated. */
  action: string;
  /** The LM-assigned value score [0, 1]. */
  value: number;
  /** Optional reasoning provided by the LM. */
  reasoning?: string;
  /** When this evaluation was recorded. */
  evaluatedAt: number;
  /** How long the evaluation took (ms). */
  latencyMs?: number;
}

/** Accuracy tracking for LM predictions. */
export interface LMValueAccuracy {
  /** Total predictions tracked. */
  totalPredictions: number;
  /** Mean absolute error between predicted and actual values. */
  meanAbsoluteError: number;
  /** Correlation between predicted and actual values. */
  correlation: number;
  /** Predictions grouped by value range for calibration analysis. */
  calibrationBuckets: Array<{
    range: [number, number];
    predictedMean: number;
    actualMean: number;
    count: number;
  }>;
  /** Last updated timestamp. */
  updatedAt: number;
}

/** Options for constructing an LMValueFunction. */
export interface LMValueFunctionOptions {
  /** FileStore instance for persistence. */
  fileStore: FileStore;
  /** Logger instance. */
  logger?: Logger;
  /** Maximum number of cached evaluations. Default: 500. */
  cacheMaxSize?: number;
  /** Time-to-live for cache entries in ms. Default: 24 hours. */
  cacheTTLMs?: number;
  /** Jaccard similarity threshold for cache hits. Default: 0.85. */
  similarityThreshold?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Internal cache entry with metadata for eviction. */
interface CacheEntry {
  evaluation: LMValueEvaluation;
  keywords: string[];
  cachedAt: number;
}

/** Paired prediction + actual for accuracy tracking. */
interface PredictionPair {
  promptId: string;
  predicted: number;
  actual: number;
}

/** Internal persisted cache structure. */
interface PersistedCache {
  entries: CacheEntry[];
}

/** Internal persisted accuracy structure. */
interface PersistedAccuracy {
  pairs: PredictionPair[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract simple keywords from text by lowercasing and splitting on
 * whitespace and punctuation. Self-contained — no external dependencies.
 *
 * @param text - The input text to extract keywords from.
 * @returns A set of lowercase keyword tokens.
 */
export function extractSimpleKeywords(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[\s\-_.,;:!?'"()\[\]{}<>/\\|@#$%^&*+=~`]+/)
    .filter((t) => t.length > 1);
  return new Set(tokens);
}

/**
 * Compute Jaccard similarity between two sets.
 *
 * @param a - First set.
 * @param b - Second set.
 * @returns Similarity score in [0, 1].
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Compute Pearson correlation coefficient between two arrays.
 *
 * @param xs - First array of values.
 * @param ys - Second array of values.
 * @returns Correlation in [-1, 1], or 0 if insufficient data.
 */
function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;

  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  return denom === 0 ? 0 : numerator / denom;
}

// ---------------------------------------------------------------------------
// LMValueFunction
// ---------------------------------------------------------------------------

/**
 * Language Model value function for MCTS planning.
 *
 * Generates structured evaluation prompts, caches results, and tracks
 * prediction accuracy. This is a pure data module — it does not invoke
 * any LLM directly.
 */
export class LMValueFunction {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly cacheMaxSize: number;
  private readonly cacheTTLMs: number;
  private readonly similarityThreshold: number;

  /** In-memory evaluation cache. */
  private cache: CacheEntry[] = [];

  /** Prompt ID -> evaluation mapping for linking predictions to actuals. */
  private prompts: Map<string, LMValuePrompt> = new Map();

  /** Paired predictions for accuracy tracking. */
  private predictionPairs: PredictionPair[] = [];

  constructor(opts: LMValueFunctionOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'lm-value' });
    this.cacheMaxSize = opts.cacheMaxSize ?? DEFAULT_CACHE_MAX_SIZE;
    this.cacheTTLMs = opts.cacheTTLMs ?? DEFAULT_CACHE_TTL_MS;
    this.similarityThreshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  }

  /**
   * Generate a structured prompt for Claude to evaluate a candidate plan.
   * Returns the prompt text that the agent should use to score the plan 0-1.
   *
   * @param stateDescription - Description of the current planning state.
   * @param action - The candidate action to evaluate.
   * @param historicalOutcomes - Optional array of past outcomes for similar actions.
   * @returns A structured evaluation prompt.
   */
  generatePrompt(
    stateDescription: string,
    action: string,
    historicalOutcomes?: Array<{ action: string; value: number; description: string }>,
  ): LMValuePrompt {
    const id = generateId();

    const historicalContext: string[] = [];
    let historicalSection = 'No historical data available.';

    if (historicalOutcomes && historicalOutcomes.length > 0) {
      const lines: string[] = [];
      for (const outcome of historicalOutcomes) {
        const line = `- Action: "${outcome.action}" | Value: ${outcome.value.toFixed(2)} | ${outcome.description}`;
        lines.push(line);
        historicalContext.push(line);
      }
      historicalSection = lines.join('\n');
    }

    const promptText = [
      'Evaluate this candidate action for the given planning state.',
      '',
      `State: ${stateDescription}`,
      `Candidate Action: ${action}`,
      '',
      'Historical context for similar actions:',
      historicalSection,
      '',
      'Score this action from 0.0 (certain failure) to 1.0 (certain success).',
      'Consider: likelihood of success, expected quality, and alignment with the task goal.',
      '',
      'Respond with a JSON object: { "value": <number>, "reasoning": "<brief explanation>" }',
    ].join('\n');

    const prompt: LMValuePrompt = {
      id,
      stateDescription,
      action,
      historicalContext,
      promptText,
      createdAt: Date.now(),
    };

    this.prompts.set(id, prompt);

    this.logger.debug('Generated LM value prompt', { id, action });

    return prompt;
  }

  /**
   * Record an LM evaluation result (called after the agent evaluates a prompt).
   *
   * @param promptId - The ID of the prompt that was evaluated.
   * @param value - The LM-assigned value score [0, 1].
   * @param reasoning - Optional reasoning provided by the LM.
   * @param latencyMs - Optional evaluation latency in milliseconds.
   * @returns The recorded evaluation.
   */
  async recordEvaluation(
    promptId: string,
    value: number,
    reasoning?: string,
    latencyMs?: number,
  ): Promise<LMValueEvaluation> {
    const prompt = this.prompts.get(promptId);

    const evaluation: LMValueEvaluation = {
      promptId,
      stateDescription: prompt?.stateDescription ?? '',
      action: prompt?.action ?? '',
      value: Math.max(0, Math.min(1, value)),
      reasoning,
      evaluatedAt: Date.now(),
      latencyMs,
    };

    // Persist the individual evaluation
    await this.fileStore.write('lm-value', `lm-eval-${promptId}`, evaluation);

    // Add to cache
    const keywords = [
      ...extractSimpleKeywords(evaluation.stateDescription),
      ...extractSimpleKeywords(evaluation.action),
    ];

    const entry: CacheEntry = {
      evaluation,
      keywords,
      cachedAt: Date.now(),
    };

    this.cache.push(entry);
    this.evictIfNeeded();

    this.logger.debug('Recorded LM evaluation', { promptId, value });

    return evaluation;
  }

  /**
   * Look up a cached evaluation for a similar state+action pair.
   * Returns null if no sufficiently similar cached result exists.
   *
   * @param stateDescription - Description of the current planning state.
   * @param action - The candidate action to look up.
   * @returns A cached evaluation or null.
   */
  async getCachedValue(
    stateDescription: string,
    action: string,
  ): Promise<LMValueEvaluation | null> {
    const queryKeywords = new Set([
      ...extractSimpleKeywords(stateDescription),
      ...extractSimpleKeywords(action),
    ]);

    const now = Date.now();
    let bestMatch: LMValueEvaluation | null = null;
    let bestSimilarity = 0;

    for (const entry of this.cache) {
      // Skip expired entries
      if (now - entry.cachedAt > this.cacheTTLMs) continue;

      const entryKeywords = new Set(entry.keywords);
      const similarity = jaccardSimilarity(queryKeywords, entryKeywords);

      if (similarity >= this.similarityThreshold && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = entry.evaluation;
      }
    }

    if (bestMatch) {
      this.logger.debug('Cache hit for LM value', {
        action,
        similarity: bestSimilarity,
      });
    }

    return bestMatch;
  }

  /**
   * Record the actual outcome for a previously predicted state+action,
   * updating accuracy tracking.
   *
   * @param promptId - The ID of the prompt whose actual outcome is being recorded.
   * @param actualValue - The actual outcome value [0, 1].
   */
  async recordActualOutcome(
    promptId: string,
    actualValue: number,
  ): Promise<void> {
    // Find the evaluation for this prompt
    const cachedEntry = this.cache.find(
      (e) => e.evaluation.promptId === promptId,
    );

    let predicted: number | undefined;

    if (cachedEntry) {
      predicted = cachedEntry.evaluation.value;
    } else {
      // Try loading from persistence
      const evaluation = await this.fileStore.read<LMValueEvaluation>(
        'lm-value',
        `lm-eval-${promptId}`,
      );
      if (evaluation) {
        predicted = evaluation.value;
      }
    }

    if (predicted === undefined) {
      this.logger.warn('No evaluation found for prompt', { promptId });
      return;
    }

    this.predictionPairs.push({
      promptId,
      predicted,
      actual: Math.max(0, Math.min(1, actualValue)),
    });

    this.logger.debug('Recorded actual outcome', {
      promptId,
      predicted,
      actual: actualValue,
    });
  }

  /**
   * Get accuracy metrics for LM predictions vs actual outcomes.
   *
   * @returns Accuracy metrics including MAE, correlation, and calibration buckets.
   */
  async getAccuracy(): Promise<LMValueAccuracy> {
    const pairs = this.predictionPairs;

    if (pairs.length === 0) {
      return {
        totalPredictions: 0,
        meanAbsoluteError: 0,
        correlation: 0,
        calibrationBuckets: CALIBRATION_RANGES.map((range) => ({
          range,
          predictedMean: 0,
          actualMean: 0,
          count: 0,
        })),
        updatedAt: Date.now(),
      };
    }

    // Compute MAE
    const errors = pairs.map((p) => Math.abs(p.predicted - p.actual));
    const mae = errors.reduce((s, e) => s + e, 0) / errors.length;

    // Compute Pearson correlation
    const predicted = pairs.map((p) => p.predicted);
    const actual = pairs.map((p) => p.actual);
    const correlation = pearsonCorrelation(predicted, actual);

    // Compute calibration buckets
    const calibrationBuckets = CALIBRATION_RANGES.map((range) => {
      const [lo, hi] = range;
      const bucket = pairs.filter(
        (p) => p.predicted >= lo && (hi === 1.0 ? p.predicted <= hi : p.predicted < hi),
      );

      if (bucket.length === 0) {
        return { range, predictedMean: 0, actualMean: 0, count: 0 };
      }

      const predictedMean =
        bucket.reduce((s, p) => s + p.predicted, 0) / bucket.length;
      const actualMean =
        bucket.reduce((s, p) => s + p.actual, 0) / bucket.length;

      return { range, predictedMean, actualMean, count: bucket.length };
    });

    return {
      totalPredictions: pairs.length,
      meanAbsoluteError: mae,
      correlation,
      calibrationBuckets,
      updatedAt: Date.now(),
    };
  }

  /**
   * Persist all state (cache + accuracy data) to the FileStore.
   */
  async save(): Promise<void> {
    const cacheData: PersistedCache = { entries: this.cache };
    await this.fileStore.write('lm-value', 'lm-value-cache', cacheData);

    const accuracyData: PersistedAccuracy = { pairs: this.predictionPairs };
    await this.fileStore.write('lm-value', 'lm-value-accuracy', accuracyData);

    this.logger.info('LM value function state saved', {
      cacheSize: this.cache.length,
      predictionPairs: this.predictionPairs.length,
    });
  }

  /**
   * Load persisted state from the FileStore.
   */
  async load(): Promise<void> {
    const cacheData = await this.fileStore.read<PersistedCache>(
      'lm-value',
      'lm-value-cache',
    );
    if (cacheData && Array.isArray(cacheData.entries)) {
      this.cache = cacheData.entries;
    }

    const accuracyData = await this.fileStore.read<PersistedAccuracy>(
      'lm-value',
      'lm-value-accuracy',
    );
    if (accuracyData && Array.isArray(accuracyData.pairs)) {
      this.predictionPairs = accuracyData.pairs;
    }

    this.logger.info('LM value function state loaded', {
      cacheSize: this.cache.length,
      predictionPairs: this.predictionPairs.length,
    });
  }

  /**
   * Clear all cached evaluations and accuracy data.
   */
  async clear(): Promise<void> {
    this.cache = [];
    this.predictionPairs = [];
    this.prompts.clear();

    await this.fileStore.delete('lm-value', 'lm-value-cache');
    await this.fileStore.delete('lm-value', 'lm-value-accuracy');

    this.logger.info('LM value function state cleared');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Evict oldest cache entries when the cache exceeds its maximum size.
   */
  private evictIfNeeded(): void {
    if (this.cache.length <= this.cacheMaxSize) return;

    // Sort by cachedAt ascending (oldest first) and remove excess
    this.cache.sort((a, b) => a.cachedAt - b.cachedAt);
    const excess = this.cache.length - this.cacheMaxSize;
    this.cache.splice(0, excess);

    this.logger.debug('Evicted cache entries', { evicted: excess });
  }
}
