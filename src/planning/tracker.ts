/**
 * Plan Tracker — execution tracking and success-rate analysis for APEX plans.
 *
 * Records plans proposed by Claude, tracks step-by-step execution progress,
 * links plan outcomes back to the episode and action-tree history, and
 * computes per-task-type success rates for experience-informed planning.
 */

import { generateId } from '../types.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FileStore collection for tracked plans. */
const PLANNING_COLLECTION = 'planning';

/** Key prefix for individual plan records. */
const PLAN_PREFIX = 'plan-';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Overall lifecycle status of a plan. */
export type PlanStatus = 'proposed' | 'in_progress' | 'completed' | 'failed' | 'abandoned';

/** Status of an individual step within a plan. */
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/** A single step in a tracked plan. */
export interface PlanStep {
  /** Unique identifier for this step. */
  id: string;

  /** Human-readable description of what this step does. */
  description: string;

  /** Current execution status. */
  status: StepStatus;

  /** Unix-epoch ms timestamp when execution of this step began. */
  startedAt?: number;

  /** Unix-epoch ms timestamp when execution of this step finished. */
  completedAt?: number;

  /** Textual outcome or result of the step. */
  outcome?: string;

  /** ID of the episode that executed this step, if any. */
  linkedEpisodeId?: string;
}

/** A fully-tracked plan with steps, links, and outcome metadata. */
export interface TrackedPlan {
  /** Unique identifier for this plan. */
  id: string;

  /** The task description or goal the plan addresses. */
  task: string;

  /** Categorised task type for grouping and success-rate analysis. */
  taskType: string;

  /** Ordered list of steps that make up the plan. */
  steps: PlanStep[];

  /** Overall lifecycle status. */
  status: PlanStatus;

  /** Unix-epoch ms timestamp when the plan was created. */
  createdAt: number;

  /** Unix-epoch ms timestamp of the most recent update. */
  updatedAt: number;

  /** Unix-epoch ms timestamp when the plan reached a terminal status. */
  completedAt?: number;

  /** Episode IDs linked to this plan. */
  linkedEpisodeIds: string[];

  /** Action-tree node IDs linked to this plan. */
  actionTreeNodeIds: string[];

  /** Final outcome summary, set when the plan is completed or failed. */
  outcome?: { success: boolean; description: string };

  /** Arbitrary additional metadata. */
  metadata?: Record<string, unknown>;
}

/** Aggregated success-rate statistics for a single task type. */
export interface PlanSuccessRate {
  /** The task type these stats apply to. */
  taskType: string;

  /** Total number of plans with this task type. */
  totalPlans: number;

  /** Number of plans that completed successfully. */
  successfulPlans: number;

  /** Number of plans that failed. */
  failedPlans: number;

  /** Ratio of successful to total terminal plans, in [0, 1]. */
  successRate: number;

  /** Average percentage of steps completed across all plans, in [0, 1]. */
  avgCompletionRate: number;
}

/** Configuration for {@link PlanTracker}. */
export interface PlanTrackerOptions {
  /** FileStore instance for persistence. */
  fileStore: FileStore;

  /** Optional logger (defaults to a logger with prefix `plan-tracker`). */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build the storage key for a plan. */
function planKey(id: string): string {
  return `${PLAN_PREFIX}${id}`;
}

/**
 * Compute the step-completion rate for a plan.
 *
 * @returns A value in [0, 1] representing the proportion of steps that
 *          reached a terminal status (`completed` or `skipped`).
 */
function stepCompletionRate(plan: TrackedPlan): number {
  if (plan.steps.length === 0) return 0;
  const done = plan.steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped',
  ).length;
  return done / plan.steps.length;
}

// ---------------------------------------------------------------------------
// PlanTracker class
// ---------------------------------------------------------------------------

/**
 * Tracks plan lifecycle from proposal through execution to outcome.
 *
 * Plans are stored in the `planning` FileStore collection keyed by
 * `plan-{id}`. The tracker provides CRUD operations on plans and their
 * steps, linking to episodes and action-tree nodes, and computes
 * per-task-type success rates.
 *
 * @example
 * ```ts
 * const tracker = new PlanTracker({ fileStore });
 * const plan = await tracker.createPlan(
 *   'Refactor auth module',
 *   'refactoring',
 *   ['Extract interfaces', 'Split into files', 'Update imports'],
 * );
 * await tracker.updateStep(plan.id, plan.steps[0].id, 'completed', 'Done');
 * await tracker.completePlan(plan.id, { success: true, description: 'All good' });
 * ```
 */
export class PlanTracker {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;

  constructor(options: PlanTrackerOptions) {
    this.fileStore = options.fileStore;
    this.logger = options.logger ?? new Logger({ prefix: 'plan-tracker' });
  }

  // -----------------------------------------------------------------------
  // Plan CRUD
  // -----------------------------------------------------------------------

  /**
   * Create a new tracked plan from a task description and step list.
   *
   * The plan starts in `proposed` status with all steps `pending`.
   *
   * @param task      - Human-readable task description.
   * @param taskType  - Categorised task type for grouping (e.g. `"refactoring"`).
   * @param steps     - Ordered list of step descriptions.
   * @param metadata  - Optional additional metadata to attach.
   * @returns The newly created {@link TrackedPlan}.
   */
  async createPlan(
    task: string,
    taskType: string,
    steps: string[],
    metadata?: Record<string, unknown>,
  ): Promise<TrackedPlan> {
    const now = Date.now();

    const plan: TrackedPlan = {
      id: generateId(),
      task,
      taskType,
      steps: steps.map((description) => ({
        id: generateId(),
        description,
        status: 'pending' as StepStatus,
      })),
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
      linkedEpisodeIds: [],
      actionTreeNodeIds: [],
      metadata,
    };

    await this.fileStore.write(PLANNING_COLLECTION, planKey(plan.id), plan);

    this.logger.info('Created plan', {
      id: plan.id,
      taskType,
      stepCount: steps.length,
    });

    return plan;
  }

  /**
   * Retrieve a single plan by ID.
   *
   * @returns The plan, or `null` if not found.
   */
  async getPlan(planId: string): Promise<TrackedPlan | null> {
    return this.fileStore.read<TrackedPlan>(PLANNING_COLLECTION, planKey(planId));
  }

  // -----------------------------------------------------------------------
  // Step updates
  // -----------------------------------------------------------------------

  /**
   * Update the status (and optionally the outcome) of a single plan step.
   *
   * When the first step transitions away from `pending`, the plan status
   * is automatically promoted to `in_progress`.
   *
   * @param planId  - The plan containing the step.
   * @param stepId  - The step to update.
   * @param status  - New step status.
   * @param outcome - Optional textual outcome for the step.
   * @returns The updated plan.
   * @throws If the plan or step is not found.
   */
  async updateStep(
    planId: string,
    stepId: string,
    status: StepStatus,
    outcome?: string,
  ): Promise<TrackedPlan> {
    const plan = await this.requirePlan(planId);

    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) {
      throw new Error(`Step ${stepId} not found in plan ${planId}`);
    }

    const now = Date.now();
    step.status = status;

    if (status === 'in_progress' && !step.startedAt) {
      step.startedAt = now;
    }

    if (status === 'completed' || status === 'failed' || status === 'skipped') {
      step.completedAt = now;
    }

    if (outcome !== undefined) {
      step.outcome = outcome;
    }

    // Auto-promote plan status when work begins
    if (plan.status === 'proposed') {
      plan.status = 'in_progress';
    }

    plan.updatedAt = now;
    await this.fileStore.write(PLANNING_COLLECTION, planKey(planId), plan);

    this.logger.debug('Updated step', { planId, stepId, status });

    return plan;
  }

  // -----------------------------------------------------------------------
  // Plan completion
  // -----------------------------------------------------------------------

  /**
   * Mark a plan as completed or failed with an outcome summary.
   *
   * @param planId  - The plan to finalise.
   * @param outcome - Success flag and description.
   * @returns The updated plan.
   * @throws If the plan is not found.
   */
  async completePlan(
    planId: string,
    outcome: { success: boolean; description: string },
  ): Promise<TrackedPlan> {
    const plan = await this.requirePlan(planId);
    const now = Date.now();

    plan.status = outcome.success ? 'completed' : 'failed';
    plan.outcome = outcome;
    plan.completedAt = now;
    plan.updatedAt = now;

    await this.fileStore.write(PLANNING_COLLECTION, planKey(planId), plan);

    this.logger.info('Completed plan', {
      id: planId,
      success: outcome.success,
      completionRate: stepCompletionRate(plan),
    });

    return plan;
  }

  // -----------------------------------------------------------------------
  // Linking
  // -----------------------------------------------------------------------

  /**
   * Link a plan to an episode.
   *
   * @param planId    - The plan to link.
   * @param episodeId - The episode ID to associate.
   * @returns The updated plan.
   * @throws If the plan is not found.
   */
  async linkToEpisode(planId: string, episodeId: string): Promise<TrackedPlan> {
    const plan = await this.requirePlan(planId);

    if (!plan.linkedEpisodeIds.includes(episodeId)) {
      plan.linkedEpisodeIds.push(episodeId);
      plan.updatedAt = Date.now();
      await this.fileStore.write(PLANNING_COLLECTION, planKey(planId), plan);

      this.logger.debug('Linked plan to episode', { planId, episodeId });
    }

    return plan;
  }

  /**
   * Link a plan to an action-tree node.
   *
   * @param planId - The plan to link.
   * @param nodeId - The action-tree node ID to associate.
   * @returns The updated plan.
   * @throws If the plan is not found.
   */
  async linkToActionTree(planId: string, nodeId: string): Promise<TrackedPlan> {
    const plan = await this.requirePlan(planId);

    if (!plan.actionTreeNodeIds.includes(nodeId)) {
      plan.actionTreeNodeIds.push(nodeId);
      plan.updatedAt = Date.now();
      await this.fileStore.write(PLANNING_COLLECTION, planKey(planId), plan);

      this.logger.debug('Linked plan to action tree node', { planId, nodeId });
    }

    return plan;
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Retrieve all plans with a given task type.
   *
   * @param taskType - The task type to filter by.
   * @returns Plans matching the task type, sorted newest-first.
   */
  async getPlansForTask(taskType: string): Promise<TrackedPlan[]> {
    const all = await this.getAllPlans();
    return all
      .filter((p) => p.taskType === taskType)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Retrieve the most recently created plans.
   *
   * @param limit - Maximum number of plans to return (default 10).
   * @returns Plans sorted newest-first, up to `limit` entries.
   */
  async getRecentPlans(limit: number = 10): Promise<TrackedPlan[]> {
    const all = await this.getAllPlans();
    return all
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /**
   * Compute per-task-type success rates across all tracked plans.
   *
   * Only plans in a terminal status (`completed`, `failed`, or `abandoned`)
   * contribute to the success/failure counts. All plans contribute to the
   * average step-completion rate.
   *
   * @returns An array of {@link PlanSuccessRate} entries, one per task type.
   */
  async getSuccessRates(): Promise<PlanSuccessRate[]> {
    const all = await this.getAllPlans();

    // Group by task type
    const groups = new Map<string, TrackedPlan[]>();
    for (const plan of all) {
      const existing = groups.get(plan.taskType);
      if (existing) {
        existing.push(plan);
      } else {
        groups.set(plan.taskType, [plan]);
      }
    }

    const rates: PlanSuccessRate[] = [];

    for (const [taskType, plans] of groups) {
      const terminal = plans.filter(
        (p) => p.status === 'completed' || p.status === 'failed' || p.status === 'abandoned',
      );
      const successful = terminal.filter((p) => p.status === 'completed' && p.outcome?.success);
      const failed = terminal.filter(
        (p) => p.status === 'failed' || (p.status === 'completed' && !p.outcome?.success),
      );

      const totalCompletionRate = plans.reduce(
        (sum, p) => sum + stepCompletionRate(p),
        0,
      );

      rates.push({
        taskType,
        totalPlans: plans.length,
        successfulPlans: successful.length,
        failedPlans: failed.length,
        successRate: terminal.length > 0 ? successful.length / terminal.length : 0,
        avgCompletionRate: plans.length > 0 ? totalCompletionRate / plans.length : 0,
      });
    }

    return rates;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Load all plans from the FileStore.
   */
  private async getAllPlans(): Promise<TrackedPlan[]> {
    return this.fileStore.readAll<TrackedPlan>(PLANNING_COLLECTION);
  }

  /**
   * Load a plan or throw if it does not exist.
   */
  private async requirePlan(planId: string): Promise<TrackedPlan> {
    const plan = await this.getPlan(planId);
    if (!plan) {
      throw new Error(`Plan ${planId} not found`);
    }
    return plan;
  }
}
