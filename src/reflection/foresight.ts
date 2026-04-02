/**
 * Foresight-based Reflection Engine
 *
 * Records predictions before multi-step tasks, monitors divergence during
 * execution, and computes surprise scores after completion. When surprise
 * exceeds a configurable threshold, automatically triggers micro-level
 * reflection via the ReflectionCoordinator.
 *
 * Zero LLM calls — pure data infrastructure.
 */

import type { AdaptationSignal, ForesightPrediction, Outcome } from '../types.js';
import { generateId } from '../types.js';
import type { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FileStore collection for persisting predictions. */
const PREDICTIONS_COLLECTION = 'foresight-predictions';

/** Default surprise threshold above which auto-reflection triggers. */
const DEFAULT_SURPRISE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Configuration for the ForesightEngine. */
export interface ForesightEngineOptions {
  /** FileStore instance for persistence. */
  fileStore: FileStore;

  /** Optional logger instance. */
  logger?: Logger;

  /**
   * Surprise score threshold (0-1) above which a micro-level reflection
   * is auto-triggered on resolve. Defaults to `0.5`.
   */
  surpriseThreshold?: number;

  /**
   * Optional callback invoked when surprise exceeds the threshold.
   * Receives the prediction ID and the surprise score.
   */
  onSurpriseTriggered?: (predictionId: string, surpriseScore: number) => Promise<void>;
}

/** Input for creating a new prediction. */
export interface PredictInput {
  /** ID of the task or plan being predicted. */
  taskId: string;

  /** Whether the task is expected to succeed. */
  predictedSuccess: boolean;

  /** Expected wall-clock duration in milliseconds. */
  expectedDuration: number;

  /** Expected number of steps. */
  expectedSteps: number;

  /** Known risk factors. */
  riskFactors?: string[];

  /** Confidence in this prediction (0-1). */
  confidence?: number;
}

/** Input for checking mid-task divergence. */
export interface CheckInput {
  /** ID of the prediction to check against. */
  predictionId: string;

  /** Zero-based index of the current step. */
  stepIndex: number;

  /** Whether the step succeeded. */
  stepSuccess: boolean;

  /** Elapsed time so far in milliseconds. */
  elapsedMs: number;

  /** Total steps completed so far (including this one). */
  completedSteps: number;

  /** Optional description of what happened in this step. */
  stepDescription?: string;
}

/** Input for resolving a prediction against an actual outcome. */
export interface ResolveInput {
  /** ID of the prediction to resolve. */
  predictionId: string;

  /** The actual outcome. */
  actualOutcome: Outcome;

  /** Optional episode ID (used for auto-triggering reflection). */
  episodeId?: string;
}

/** Result returned by the resolve operation. */
export interface ResolveResult {
  /** The updated prediction with surprise score. */
  prediction: ForesightPrediction;

  /** Whether the surprise threshold was exceeded. */
  surpriseTriggered: boolean;

  /** Breakdown of surprise score components. */
  breakdown: SurpriseBreakdown;
}

/** Detailed breakdown of how the surprise score was calculated. */
export interface SurpriseBreakdown {
  /** Contribution from success/failure mismatch (0 or weight). */
  successMismatch: number;

  /** Contribution from duration deviation (0-weight). */
  durationDeviation: number;

  /** Contribution from error type mismatch (0 or weight). */
  errorTypeMismatch: number;

  /** Contribution from step count deviation (0-weight). */
  stepCountDeviation: number;

  /** Final weighted score (0-1). */
  total: number;
}

// ---------------------------------------------------------------------------
// Surprise score weights
// ---------------------------------------------------------------------------

/** Weights for each component of the surprise score. Must sum to 1.0. */
const SURPRISE_WEIGHTS = {
  successMismatch: 0.4,
  durationDeviation: 0.2,
  errorTypeMismatch: 0.15,
  stepCountDeviation: 0.25,
} as const;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Engine for foresight-based reflection.
 *
 * Lifecycle:
 * 1. **predict** — Record what you expect to happen before starting a task.
 * 2. **check** — After each step, evaluate whether execution is diverging.
 * 3. **resolve** — After completion, compare predicted vs actual and score.
 */
export class ForesightEngine {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly surpriseThreshold: number;
  private readonly onSurpriseTriggered?: (predictionId: string, surpriseScore: number) => Promise<void>;

  constructor(options: ForesightEngineOptions) {
    this.fileStore = options.fileStore;
    this.logger = options.logger ?? new Logger({ prefix: 'apex:foresight' });
    this.surpriseThreshold = options.surpriseThreshold ?? DEFAULT_SURPRISE_THRESHOLD;
    this.onSurpriseTriggered = options.onSurpriseTriggered;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Record a prediction before starting a multi-step task.
   *
   * @param input - The prediction parameters.
   * @returns The persisted ForesightPrediction.
   */
  async predict(input: PredictInput): Promise<ForesightPrediction> {
    const prediction: ForesightPrediction = {
      id: generateId(),
      taskId: input.taskId,
      predictedOutcome: {
        success: input.predictedSuccess,
        expectedDuration: input.expectedDuration,
        expectedSteps: input.expectedSteps,
        riskFactors: input.riskFactors ?? [],
        confidence: Math.max(0, Math.min(1, input.confidence ?? 0.5)),
      },
      adaptationSignals: [],
      timestamp: Date.now(),
    };

    await this.fileStore.write(PREDICTIONS_COLLECTION, prediction.id, prediction);

    this.logger.info('Prediction recorded', {
      predictionId: prediction.id,
      taskId: prediction.taskId,
      predictedSuccess: prediction.predictedOutcome.success,
      confidence: prediction.predictedOutcome.confidence,
    });

    return prediction;
  }

  /**
   * Check divergence during task execution and produce an adaptation signal.
   *
   * @param input - Current execution state.
   * @returns The generated AdaptationSignal.
   * @throws If the prediction ID is not found.
   */
  async check(input: CheckInput): Promise<AdaptationSignal> {
    const prediction = await this.fileStore.read<ForesightPrediction>(
      PREDICTIONS_COLLECTION,
      input.predictionId,
    );
    if (!prediction) {
      throw new Error(`Prediction not found: ${input.predictionId}`);
    }

    const divergenceScore = this.calculateDivergence(prediction, input);
    const recommendation = this.deriveRecommendation(divergenceScore, input);
    const reason = this.buildDivergenceReason(prediction, input, divergenceScore);

    const signal: AdaptationSignal = {
      stepIndex: input.stepIndex,
      divergenceScore,
      recommendation,
      reason,
      timestamp: Date.now(),
    };

    // Append the signal to the prediction
    prediction.adaptationSignals.push(signal);
    await this.fileStore.write(PREDICTIONS_COLLECTION, prediction.id, prediction);

    this.logger.debug('Divergence check', {
      predictionId: prediction.id,
      stepIndex: input.stepIndex,
      divergenceScore: Math.round(divergenceScore * 1000) / 1000,
      recommendation,
    });

    return signal;
  }

  /**
   * Resolve a prediction by comparing it against the actual outcome.
   *
   * Calculates the surprise score and, if it exceeds the threshold,
   * invokes the `onSurpriseTriggered` callback (if configured).
   *
   * @param input - The actual outcome and prediction ID.
   * @returns The resolution result with surprise breakdown.
   * @throws If the prediction ID is not found.
   */
  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const prediction = await this.fileStore.read<ForesightPrediction>(
      PREDICTIONS_COLLECTION,
      input.predictionId,
    );
    if (!prediction) {
      throw new Error(`Prediction not found: ${input.predictionId}`);
    }

    const breakdown = this.calculateSurprise(prediction, input.actualOutcome);

    // Update the prediction with actual outcome and surprise score
    prediction.actualOutcome = input.actualOutcome;
    prediction.surpriseScore = breakdown.total;

    await this.fileStore.write(PREDICTIONS_COLLECTION, prediction.id, prediction);

    const surpriseTriggered = breakdown.total > this.surpriseThreshold;

    this.logger.info('Prediction resolved', {
      predictionId: prediction.id,
      surpriseScore: Math.round(breakdown.total * 1000) / 1000,
      surpriseTriggered,
    });

    // Auto-trigger reflection if surprise exceeds threshold
    if (surpriseTriggered && this.onSurpriseTriggered) {
      await this.onSurpriseTriggered(prediction.id, breakdown.total);
    }

    return {
      prediction,
      surpriseTriggered,
      breakdown,
    };
  }

  /**
   * Retrieve a stored prediction by ID.
   *
   * @param predictionId - The prediction ID.
   * @returns The prediction or null if not found.
   */
  async getPrediction(predictionId: string): Promise<ForesightPrediction | null> {
    return this.fileStore.read<ForesightPrediction>(PREDICTIONS_COLLECTION, predictionId);
  }

  /**
   * List all predictions for a given task ID.
   *
   * @param taskId - The task ID to filter by.
   * @returns Array of predictions for the task, sorted by timestamp descending.
   */
  async getPredictionsForTask(taskId: string): Promise<ForesightPrediction[]> {
    const all = await this.fileStore.readAll<ForesightPrediction>(PREDICTIONS_COLLECTION);
    return all
      .filter((p) => p.taskId === taskId)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Calculate how far the current execution has diverged from the prediction.
   * Returns a score between 0 (on track) and 1 (fully diverged).
   */
  private calculateDivergence(prediction: ForesightPrediction, input: CheckInput): number {
    const predicted = prediction.predictedOutcome;
    let score = 0;

    // Time divergence: how far ahead/behind expected pace
    if (predicted.expectedDuration > 0 && predicted.expectedSteps > 0) {
      const expectedTimePerStep = predicted.expectedDuration / predicted.expectedSteps;
      const expectedElapsed = expectedTimePerStep * (input.stepIndex + 1);
      const timeRatio = expectedElapsed > 0 ? input.elapsedMs / expectedElapsed : 1;
      // Deviation from 1.0 (on-pace) — cap at 1.0
      score += Math.min(1, Math.abs(timeRatio - 1)) * 0.4;
    }

    // Step count divergence: are we past expected steps?
    if (predicted.expectedSteps > 0) {
      const stepRatio = input.completedSteps / predicted.expectedSteps;
      if (stepRatio > 1) {
        // Exceeded expected steps
        score += Math.min(1, stepRatio - 1) * 0.3;
      }
    }

    // Failure during expected success
    if (predicted.success && !input.stepSuccess) {
      score += 0.3;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Derive a recommendation from the divergence score and step context.
   */
  private deriveRecommendation(
    divergenceScore: number,
    _input: CheckInput,
  ): AdaptationSignal['recommendation'] {
    if (divergenceScore >= 0.8) return 'abort';
    if (divergenceScore >= 0.5) return 'reflect';
    if (divergenceScore >= 0.3) return 'adjust';
    return 'continue';
  }

  /**
   * Build a human-readable reason string for the divergence.
   */
  private buildDivergenceReason(
    prediction: ForesightPrediction,
    input: CheckInput,
    divergenceScore: number,
  ): string {
    const parts: string[] = [];
    const predicted = prediction.predictedOutcome;

    if (divergenceScore < 0.1) {
      return 'Execution is on track with prediction.';
    }

    // Check time
    if (predicted.expectedDuration > 0 && predicted.expectedSteps > 0) {
      const expectedTimePerStep = predicted.expectedDuration / predicted.expectedSteps;
      const expectedElapsed = expectedTimePerStep * (input.stepIndex + 1);
      if (input.elapsedMs > expectedElapsed * 1.5) {
        parts.push(`Running ${Math.round((input.elapsedMs / expectedElapsed - 1) * 100)}% slower than expected`);
      } else if (input.elapsedMs < expectedElapsed * 0.5) {
        parts.push(`Running ${Math.round((1 - input.elapsedMs / expectedElapsed) * 100)}% faster than expected`);
      }
    }

    // Check steps
    if (predicted.expectedSteps > 0 && input.completedSteps > predicted.expectedSteps) {
      parts.push(`Exceeded expected step count (${input.completedSteps}/${predicted.expectedSteps})`);
    }

    // Check failure
    if (predicted.success && !input.stepSuccess) {
      parts.push('Step failed despite success being predicted');
    }

    return parts.length > 0
      ? parts.join('. ') + '.'
      : `Mild divergence detected (score: ${Math.round(divergenceScore * 100)}%).`;
  }

  /**
   * Calculate the surprise score between a prediction and actual outcome.
   * Returns a breakdown with per-component contributions and a total (0-1).
   */
  private calculateSurprise(
    prediction: ForesightPrediction,
    actual: Outcome,
  ): SurpriseBreakdown {
    const predicted = prediction.predictedOutcome;

    // 1. Success mismatch: binary — predicted success vs actual success
    const successMismatch = predicted.success !== actual.success
      ? SURPRISE_WEIGHTS.successMismatch
      : 0;

    // 2. Duration deviation: how far off the predicted duration
    let durationDeviation = 0;
    if (predicted.expectedDuration > 0) {
      const ratio = actual.duration / predicted.expectedDuration;
      // Deviation from 1.0, capped at 1.0
      const deviation = Math.min(1, Math.abs(ratio - 1));
      durationDeviation = deviation * SURPRISE_WEIGHTS.durationDeviation;
    }

    // 3. Error type mismatch: if failure was predicted but with wrong error type,
    //    or if error occurred unexpectedly
    let errorTypeMismatch = 0;
    if (!actual.success && actual.errorType) {
      // If success was predicted, any error is a full mismatch
      if (predicted.success) {
        errorTypeMismatch = SURPRISE_WEIGHTS.errorTypeMismatch;
      } else {
        // Failure was predicted — check if the error type was in risk factors
        const knownRisk = predicted.riskFactors.some(
          (rf) => rf.toLowerCase().includes(actual.errorType!.toLowerCase()) ||
                  actual.errorType!.toLowerCase().includes(rf.toLowerCase()),
        );
        errorTypeMismatch = knownRisk ? 0 : SURPRISE_WEIGHTS.errorTypeMismatch;
      }
    } else if (!actual.success && !predicted.success) {
      // Both failed, no error type to compare — low surprise
      errorTypeMismatch = 0;
    }

    // 4. Step count deviation: compare actual action count against expected steps
    //    (We infer actual steps from adaptation signals if available, otherwise
    //    we skip this component and redistribute its weight.)
    let stepCountDeviation = 0;
    const signalCount = prediction.adaptationSignals.length;
    if (predicted.expectedSteps > 0 && signalCount > 0) {
      const ratio = signalCount / predicted.expectedSteps;
      const deviation = Math.min(1, Math.abs(ratio - 1));
      stepCountDeviation = deviation * SURPRISE_WEIGHTS.stepCountDeviation;
    }

    const total = Math.max(0, Math.min(1,
      successMismatch + durationDeviation + errorTypeMismatch + stepCountDeviation,
    ));

    return {
      successMismatch,
      durationDeviation: Math.round(durationDeviation * 1000) / 1000,
      errorTypeMismatch,
      stepCountDeviation: Math.round(stepCountDeviation * 1000) / 1000,
      total: Math.round(total * 1000) / 1000,
    };
  }
}
