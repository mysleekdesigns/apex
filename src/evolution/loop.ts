/**
 * Evolution Loop Controller for APEX Evolution Engine
 *
 * Tracks and persists the state of the agent's evolution loop:
 * select task -> plan -> execute -> reflect -> consolidate.
 *
 * This is a DATA INFRASTRUCTURE module — it does not make LLM calls or
 * execute tasks. Instead it:
 * - Tracks loop state (current phase, iteration count, budgets remaining)
 * - Serializes / deserializes loop state for pause / resume
 * - Computes progress metrics from completed iteration records
 * - Provides budget-exhaustion checks so Claude Code knows when to stop
 *
 * Claude Code drives the actual loop by calling APEX tools; this module
 * provides the orchestration data layer underneath.
 */

import type { MemoryTier } from '../types.js';
import { generateId } from '../types.js';
import { Logger } from '../utils/logger.js';
import { FileStore } from '../utils/file-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Phases the evolution loop can be in. */
export type LoopPhase =
  | 'idle'
  | 'task-selection'
  | 'planning'
  | 'execution'
  | 'reflection'
  | 'consolidation';

/**
 * Budget constraints that govern how long the loop is allowed to run.
 *
 * Any limit being hit causes {@link EvolutionLoop.budgetExhausted} to
 * return `true`.
 */
export interface IterationBudget {
  /** Maximum number of loop cycles before the loop must stop. */
  maxIterations: number;

  /** Wall-clock time limit in milliseconds. */
  timeLimitMs: number;

  /** Optional upper bound on token consumption. */
  tokenBudget?: number;
}

/**
 * Fully serializable snapshot of the loop's state.
 *
 * Persisted to disk on pause / save and restored on resume / load.
 */
export interface LoopState {
  /** Unique identifier for this loop run. */
  id: string;

  /** Current phase of the loop. */
  phase: LoopPhase;

  /** Zero-based iteration counter (incremented after each full cycle). */
  iteration: number;

  /** Budget configuration governing this loop run. */
  budget: IterationBudget;

  /** Unix-epoch ms timestamp of when the loop was started. */
  startedAt: number;

  /** Unix-epoch ms timestamp of when the loop was paused (if applicable). */
  pausedAt?: number;

  /** Accumulated time in ms spent in a paused state across all pauses. */
  totalPausedMs: number;

  /** Ordered log of completed (or in-progress) iteration records. */
  completedIterations: IterationRecord[];

  /** Aggregate metrics derived from completed iterations. */
  metrics: LoopMetricsSummary;
}

/**
 * Record of a single iteration through the evolution loop.
 */
export interface IterationRecord {
  /** Iteration number (matches the loop counter at the time). */
  iteration: number;

  /** ID of the task that was selected for this iteration. */
  taskId?: string;

  /** Human-readable description of the task attempted. */
  taskDescription?: string;

  /** The phase the loop was in when this record was created. */
  phase: LoopPhase;

  /** Outcome of the iteration, if it completed. */
  outcome?: { success: boolean; reward: number };

  /** Unix-epoch ms timestamp of when the iteration started. */
  startedAt: number;

  /** Unix-epoch ms timestamp of when the iteration completed. */
  completedAt?: number;

  /** Wall-clock duration of the iteration in milliseconds. */
  duration?: number;
}

/**
 * Aggregate metrics summarizing the loop's progress.
 *
 * Recomputed from {@link LoopState.completedIterations} on demand.
 */
export interface LoopMetricsSummary {
  /** Total number of fully completed iterations. */
  totalIterations: number;

  /** Number of iterations that ended with a successful outcome. */
  successCount: number;

  /** Number of iterations that ended with a failed outcome. */
  failureCount: number;

  /** Ratio of successful iterations to total completed (0 when none). */
  successRate: number;

  /** Mean reward across all iterations with an outcome. */
  avgReward: number;

  /** Total wall-clock duration across all completed iterations in ms. */
  totalDurationMs: number;

  /** Number of skills learned during this loop run (externally updated). */
  skillsLearned: number;

  /** Current entry count per memory tier (externally updated). */
  memoryUtilization: Record<MemoryTier, number>;
}

/**
 * Configuration options for the {@link EvolutionLoop}.
 */
export interface EvolutionLoopOptions {
  /** Base directory for persisting loop state (typically the .apex-data dir). */
  dataDir: string;

  /** Partial budget overrides — missing fields use defaults. */
  budget?: Partial<IterationBudget>;

  /** Logger instance for debug output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum number of loop iterations. */
const DEFAULT_MAX_ITERATIONS = 50;

/** Default wall-clock time limit: 30 minutes. */
const DEFAULT_TIME_LIMIT_MS = 30 * 60 * 1000;

/** FileStore collection name for evolution loop state. */
const LOOP_STATE_COLLECTION = 'evolution';

/** FileStore document ID for the current loop state. */
const LOOP_STATE_ID = 'loop-state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a default {@link LoopMetricsSummary} with zeroed counters.
 */
function emptyMetrics(): LoopMetricsSummary {
  return {
    totalIterations: 0,
    successCount: 0,
    failureCount: 0,
    successRate: 0,
    avgReward: 0,
    totalDurationMs: 0,
    skillsLearned: 0,
    memoryUtilization: {
      working: 0,
      episodic: 0,
      semantic: 0,
      procedural: 0,
    },
  };
}

/**
 * Merge partial budget overrides with defaults to produce a complete budget.
 */
function resolveBudget(partial?: Partial<IterationBudget>): IterationBudget {
  return {
    maxIterations: partial?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    timeLimitMs: partial?.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
    tokenBudget: partial?.tokenBudget,
  };
}

// ---------------------------------------------------------------------------
// EvolutionLoop class
// ---------------------------------------------------------------------------

/**
 * Manages the state and lifecycle of the APEX evolution loop.
 *
 * The loop progresses through phases:
 *   idle -> task-selection -> planning -> execution -> reflection -> consolidation -> idle
 *
 * This class tracks which phase the loop is in, how many iterations have
 * completed, whether budget limits have been reached, and exposes methods
 * to serialize / deserialize the full state for pause / resume across
 * Claude Code sessions.
 *
 * All computation is pure; file I/O is limited to {@link FileStore} calls
 * in `save()`, `load()`, `pause()`, and `resume()`.
 */
export class EvolutionLoop {
  private state: LoopState;
  private readonly store: FileStore;
  private readonly logger: Logger;

  constructor(options: EvolutionLoopOptions) {
    this.store = new FileStore(options.dataDir);
    this.logger = options.logger ?? new Logger({ prefix: 'evolution-loop' });

    // Initialize with a default idle state; callers should use
    // initialize() or resume() before interacting with the loop.
    this.state = {
      id: generateId(),
      phase: 'idle',
      iteration: 0,
      budget: resolveBudget(options.budget),
      startedAt: Date.now(),
      totalPausedMs: 0,
      completedIterations: [],
      metrics: emptyMetrics(),
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialize a new evolution loop run.
   *
   * Creates fresh state with the supplied (or default) budget and persists
   * it to disk. Any previously saved state is overwritten.
   *
   * @param budget - Optional partial budget overrides.
   * @returns The newly created loop state.
   */
  async initialize(budget?: Partial<IterationBudget>): Promise<LoopState> {
    this.state = {
      id: generateId(),
      phase: 'idle',
      iteration: 0,
      budget: resolveBudget(budget),
      startedAt: Date.now(),
      totalPausedMs: 0,
      completedIterations: [],
      metrics: emptyMetrics(),
    };

    await this.save();

    this.logger.info('Evolution loop initialized', {
      id: this.state.id,
      budget: this.state.budget,
    });

    return { ...this.state };
  }

  /**
   * Resume a previously paused loop from persisted state.
   *
   * Loads state from disk, accounts for time spent paused, and moves the
   * phase back to where it left off. Returns `null` if no saved state
   * exists.
   *
   * @returns The restored loop state, or `null` if nothing to resume.
   */
  async resume(): Promise<LoopState | null> {
    const loaded = await this.load();
    if (!loaded) {
      this.logger.info('No saved loop state found — nothing to resume');
      return null;
    }

    // Account for time spent paused
    if (this.state.pausedAt) {
      const pauseDuration = Date.now() - this.state.pausedAt;
      this.state.totalPausedMs += pauseDuration;
      this.state.pausedAt = undefined;
    }

    await this.save();

    this.logger.info('Evolution loop resumed', {
      id: this.state.id,
      phase: this.state.phase,
      iteration: this.state.iteration,
      totalPausedMs: this.state.totalPausedMs,
    });

    return { ...this.state };
  }

  /**
   * Pause the loop and persist its current state to disk.
   *
   * Records the pause timestamp so that elapsed-time budget calculations
   * can exclude time spent paused.
   */
  async pause(): Promise<void> {
    this.state.pausedAt = Date.now();
    await this.save();

    this.logger.info('Evolution loop paused', {
      id: this.state.id,
      phase: this.state.phase,
      iteration: this.state.iteration,
    });
  }

  // -----------------------------------------------------------------------
  // Phase management
  // -----------------------------------------------------------------------

  /**
   * Advance the loop to the specified phase.
   *
   * This is a synchronous state update; call {@link save} afterwards if
   * you need persistence.
   *
   * @param phase - The phase to transition to.
   */
  advancePhase(phase: LoopPhase): void {
    const previous = this.state.phase;
    this.state.phase = phase;

    this.logger.debug('Phase advanced', {
      from: previous,
      to: phase,
      iteration: this.state.iteration,
    });
  }

  // -----------------------------------------------------------------------
  // Iteration tracking
  // -----------------------------------------------------------------------

  /**
   * Record the outcome of a loop iteration.
   *
   * Merges the supplied partial record with defaults, appends it to the
   * completed iterations list, increments the iteration counter, and
   * recomputes metrics.
   *
   * @param record - Partial iteration record. At minimum, provide `outcome`
   *                 for meaningful metrics.
   */
  recordIteration(record: Partial<IterationRecord>): void {
    const now = Date.now();
    const full: IterationRecord = {
      iteration: record.iteration ?? this.state.iteration,
      taskId: record.taskId,
      taskDescription: record.taskDescription,
      phase: record.phase ?? this.state.phase,
      outcome: record.outcome,
      startedAt: record.startedAt ?? now,
      completedAt: record.completedAt ?? now,
      duration: record.duration,
    };

    // Compute duration if not explicitly provided
    if (full.duration === undefined && full.completedAt !== undefined) {
      full.duration = full.completedAt - full.startedAt;
    }

    this.state.completedIterations.push(full);
    this.state.iteration++;
    this.state.metrics = this.computeMetrics();

    this.logger.debug('Iteration recorded', {
      iteration: full.iteration,
      outcome: full.outcome,
      duration: full.duration,
    });
  }

  // -----------------------------------------------------------------------
  // Budget checks
  // -----------------------------------------------------------------------

  /**
   * Check whether any budget limit has been reached.
   *
   * Evaluates three conditions:
   * 1. Iteration count >= maxIterations
   * 2. Elapsed active time >= timeLimitMs (excluding paused time)
   * 3. Token budget exceeded (if tracked externally and set on state)
   *
   * @returns `true` if the loop should stop.
   */
  budgetExhausted(): boolean {
    const { budget, iteration, startedAt, totalPausedMs } = this.state;

    // Iteration limit
    if (iteration >= budget.maxIterations) {
      this.logger.debug('Budget exhausted: iteration limit reached', {
        iteration,
        maxIterations: budget.maxIterations,
      });
      return true;
    }

    // Time limit (excluding paused time)
    const activeTimeMs = Date.now() - startedAt - totalPausedMs;
    if (activeTimeMs >= budget.timeLimitMs) {
      this.logger.debug('Budget exhausted: time limit reached', {
        activeTimeMs,
        timeLimitMs: budget.timeLimitMs,
      });
      return true;
    }

    // Token budget (if configured — externally updated via metrics)
    // Token tracking is not built into this module; callers set it
    // through the budget interface. Here we simply check if defined.
    if (budget.tokenBudget !== undefined && budget.tokenBudget <= 0) {
      this.logger.debug('Budget exhausted: token budget depleted');
      return true;
    }

    return false;
  }

  /**
   * Return the remaining budget as a snapshot.
   *
   * Useful for callers that want to display how much runway is left.
   *
   * @returns Object with remaining iterations, time, and optional tokens.
   */
  budgetRemaining(): { iterations: number; timeMs: number; tokens?: number } {
    const { budget, iteration, startedAt, totalPausedMs } = this.state;
    const activeTimeMs = Date.now() - startedAt - totalPausedMs;

    return {
      iterations: Math.max(0, budget.maxIterations - iteration),
      timeMs: Math.max(0, budget.timeLimitMs - activeTimeMs),
      tokens: budget.tokenBudget !== undefined
        ? Math.max(0, budget.tokenBudget)
        : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // State accessors
  // -----------------------------------------------------------------------

  /**
   * Return a deep copy of the current loop state.
   *
   * The returned object is safe to mutate without affecting internal state.
   */
  getState(): LoopState {
    return structuredClone(this.state);
  }

  /**
   * Compute and return aggregate metrics from completed iterations.
   *
   * This is a pure computation over {@link LoopState.completedIterations}.
   * The `skillsLearned` and `memoryUtilization` fields are preserved from
   * the last externally supplied values.
   */
  getMetrics(): LoopMetricsSummary {
    return this.computeMetrics();
  }

  // -----------------------------------------------------------------------
  // External metric updates
  // -----------------------------------------------------------------------

  /**
   * Update the memory utilization snapshot in the metrics.
   *
   * Called externally after a consolidation pass or memory operation so
   * that the loop state reflects current memory tier sizes.
   *
   * @param utilization - Entry counts keyed by memory tier.
   */
  updateMemoryUtilization(utilization: Record<MemoryTier, number>): void {
    this.state.metrics.memoryUtilization = { ...utilization };

    this.logger.debug('Memory utilization updated', { utilization });
  }

  /**
   * Update the skill count in the metrics.
   *
   * Called externally after a skill is learned or removed.
   *
   * @param count - Current total number of skills.
   */
  updateSkillCount(count: number): void {
    this.state.metrics.skillsLearned = count;

    this.logger.debug('Skill count updated', { count });
  }

  /**
   * Deduct from the token budget.
   *
   * If a token budget is configured, subtracts the given amount.
   * Has no effect if no token budget was set.
   *
   * @param tokens - Number of tokens consumed.
   */
  consumeTokens(tokens: number): void {
    if (this.state.budget.tokenBudget !== undefined) {
      this.state.budget.tokenBudget = Math.max(
        0,
        this.state.budget.tokenBudget - tokens,
      );

      this.logger.debug('Tokens consumed', {
        consumed: tokens,
        remaining: this.state.budget.tokenBudget,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Persist the current loop state to disk via FileStore.
   */
  async save(): Promise<void> {
    await this.store.write<LoopState>(
      LOOP_STATE_COLLECTION,
      LOOP_STATE_ID,
      this.state,
    );

    this.logger.debug('Loop state saved', { id: this.state.id });
  }

  /**
   * Load loop state from disk via FileStore.
   *
   * On success, replaces the in-memory state and returns it.
   * Returns `null` if no persisted state exists.
   *
   * @returns The loaded loop state, or `null`.
   */
  async load(): Promise<LoopState | null> {
    const loaded = await this.store.read<LoopState>(
      LOOP_STATE_COLLECTION,
      LOOP_STATE_ID,
    );

    if (!loaded) {
      this.logger.debug('No persisted loop state found');
      return null;
    }

    this.state = loaded;

    this.logger.debug('Loop state loaded', {
      id: this.state.id,
      phase: this.state.phase,
      iteration: this.state.iteration,
    });

    return { ...this.state };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Recompute aggregate metrics from the completed iterations array.
   *
   * Preserves externally-set fields (`skillsLearned`, `memoryUtilization`)
   * from the current metrics snapshot.
   */
  private computeMetrics(): LoopMetricsSummary {
    const iterations = this.state.completedIterations;
    const withOutcome = iterations.filter((r) => r.outcome !== undefined);

    const successCount = withOutcome.filter((r) => r.outcome!.success).length;
    const failureCount = withOutcome.filter((r) => !r.outcome!.success).length;
    const totalWithOutcome = withOutcome.length;

    const totalReward = withOutcome.reduce(
      (sum, r) => sum + r.outcome!.reward,
      0,
    );

    const totalDurationMs = iterations.reduce(
      (sum, r) => sum + (r.duration ?? 0),
      0,
    );

    return {
      totalIterations: iterations.length,
      successCount,
      failureCount,
      successRate: totalWithOutcome > 0 ? successCount / totalWithOutcome : 0,
      avgReward: totalWithOutcome > 0 ? totalReward / totalWithOutcome : 0,
      totalDurationMs,
      // Preserve externally-managed fields
      skillsLearned: this.state.metrics.skillsLearned,
      memoryUtilization: { ...this.state.metrics.memoryUtilization },
    };
  }
}
