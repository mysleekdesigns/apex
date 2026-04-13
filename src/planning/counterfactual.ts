/**
 * Counterfactual Reasoning Engine for APEX World Model (Phase 17)
 *
 * "What if" simulation that explores alternative action paths using
 * the action-effect graph. For each step in an episode, evaluates
 * what would have happened with a different action choice.
 *
 * Pure computation — zero LLM calls.
 */

import { generateId } from '../types.js';
import type { Episode } from '../types.js';
import { Logger } from '../utils/logger.js';
import type { WorldModel, ActionNode, PlanPrediction } from './world-model.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single "what if" scenario exploring an alternative action.
 */
export interface CounterfactualScenario {
  /** Unique identifier for this scenario. */
  id: string;

  /** Action type that was actually taken. */
  originalAction: string;

  /** Action type that could have been taken instead. */
  alternativeAction: string;

  /** Which step in the episode this replaces (0-indexed). */
  stepIndex: number;

  /** Outcome metrics for the original action path. */
  originalOutcome: {
    successRate: number;
    description: string;
  };

  /** Predicted outcome metrics for the alternative action path. */
  predictedOutcome: {
    successRate: number;
    description: string;
    /** Percentage change vs original (positive = improvement). */
    improvement: number;
  };

  /** Confidence in this prediction (0–1). */
  confidence: number;
}

/**
 * Full counterfactual analysis for an episode.
 */
export interface CounterfactualAnalysis {
  /** Unique identifier for this analysis. */
  id: string;

  /** ID of the episode that was analysed. */
  episodeId: string;

  /** Task description from the episode. */
  task: string;

  /** Overall success rate of the original action sequence. */
  originalSuccessRate: number;

  /** All viable counterfactual scenarios discovered. */
  scenarios: CounterfactualScenario[];

  /** Scenario with the highest improvement, or `null` if none found. */
  bestAlternative: CounterfactualScenario | null;

  /** Scenario with the lowest improvement, or `null` if none found. */
  worstAlternative: CounterfactualScenario | null;

  /** Unix-epoch millisecond timestamp of when the analysis was produced. */
  timestamp: number;
}

/**
 * Configuration options for the {@link CounterfactualEngine}.
 */
export interface CounterfactualEngineOptions {
  /** Optional logger instance. */
  logger?: Logger;

  /** Maximum number of alternative actions to evaluate per step (default 3). */
  maxAlternativesPerStep?: number;

  /** Minimum improvement percentage to include a scenario (default 5). */
  minImprovementThreshold?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ALTERNATIVES = 3;
const DEFAULT_MIN_IMPROVEMENT = 5;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Counterfactual reasoning engine.
 *
 * Given an episode and a {@link WorldModel}, generates "what if" scenarios
 * that explore how the outcome would have changed with different action
 * choices at each step.
 */
export class CounterfactualEngine {
  private readonly logger?: Logger;
  private readonly maxAlternativesPerStep: number;
  private readonly minImprovementThreshold: number;

  constructor(options: CounterfactualEngineOptions = {}) {
    this.logger = options.logger;
    this.maxAlternativesPerStep = options.maxAlternativesPerStep ?? DEFAULT_MAX_ALTERNATIVES;
    this.minImprovementThreshold = options.minImprovementThreshold ?? DEFAULT_MIN_IMPROVEMENT;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Analyse an episode and generate counterfactual scenarios.
   *
   * For each action in the episode, considers alternative actions that could
   * have been taken and predicts their effect on the overall outcome using
   * the world model's causal graph.
   *
   * @param episode - The episode to analyse.
   * @param worldModel - The world model providing causal predictions.
   * @returns A complete counterfactual analysis.
   */
  analyze(episode: Episode, worldModel: WorldModel): CounterfactualAnalysis {
    const actionTypes = episode.actions.map((a) => a.type);
    const originalPrediction = worldModel.predictPlan(actionTypes);
    const originalSuccessRate = originalPrediction.overallSuccessRate;

    this.logger?.debug('Starting counterfactual analysis', {
      episodeId: episode.id,
      actionCount: actionTypes.length,
      originalSuccessRate,
    });

    const scenarios: CounterfactualScenario[] = [];

    for (let i = 0; i < episode.actions.length; i++) {
      const action = episode.actions[i];
      const alternatives = this.findAlternatives(action.type, i, actionTypes, worldModel);

      for (const alt of alternatives.slice(0, this.maxAlternativesPerStep)) {
        const modifiedSequence = [...actionTypes];
        modifiedSequence[i] = alt.actionType;

        const altPrediction = worldModel.predictPlan(modifiedSequence);
        const improvement = originalSuccessRate > 0
          ? ((altPrediction.overallSuccessRate - originalSuccessRate) / originalSuccessRate) * 100
          : altPrediction.overallSuccessRate > 0 ? 100 : 0;

        if (improvement >= this.minImprovementThreshold) {
          scenarios.push({
            id: generateId(),
            originalAction: action.type,
            alternativeAction: alt.actionType,
            stepIndex: i,
            originalOutcome: {
              successRate: originalPrediction.steps[i]?.predictedSuccessRate ?? originalSuccessRate,
              description: `Original action '${action.type}' at step ${i}`,
            },
            predictedOutcome: {
              successRate: altPrediction.overallSuccessRate,
              description: `Replace '${action.type}' with '${alt.actionType}' at step ${i}`,
              improvement: Math.round(improvement * 100) / 100,
            },
            confidence: altPrediction.confidence,
          });
        }
      }
    }

    // Sort by improvement descending for best/worst selection.
    scenarios.sort((a, b) => b.predictedOutcome.improvement - a.predictedOutcome.improvement);

    const bestAlternative = scenarios.length > 0 ? scenarios[0] : null;
    const worstAlternative = scenarios.length > 0 ? scenarios[scenarios.length - 1] : null;

    this.logger?.debug('Counterfactual analysis complete', {
      episodeId: episode.id,
      scenarioCount: scenarios.length,
      bestImprovement: bestAlternative?.predictedOutcome.improvement ?? 0,
    });

    return {
      id: generateId(),
      episodeId: episode.id,
      task: episode.task,
      originalSuccessRate,
      scenarios,
      bestAlternative,
      worstAlternative,
      timestamp: Date.now(),
    };
  }

  /**
   * Suggest alternative actions for a given action type.
   *
   * Scans the world model for all known action types that have a higher
   * success rate than the given action and returns the top-K alternatives
   * sorted by improvement.
   *
   * @param actionType - The action type to find alternatives for.
   * @param worldModel - The world model to query.
   * @param topK - Maximum number of alternatives to return (default 3).
   * @returns Alternatives sorted by improvement descending.
   */
  suggestAlternatives(
    actionType: string,
    worldModel: WorldModel,
    topK: number = 3,
  ): Array<{ actionType: string; predictedSuccessRate: number; improvement: number }> {
    const allNodes = worldModel.getNodes();
    const currentNode = allNodes.find((n) => n.actionType === actionType);
    const currentSuccessRate = currentNode?.successRate ?? 0;

    const alternatives: Array<{
      actionType: string;
      predictedSuccessRate: number;
      improvement: number;
    }> = [];

    for (const node of allNodes) {
      if (node.actionType === actionType) continue;
      if (node.successRate <= currentSuccessRate) continue;

      const improvement = currentSuccessRate > 0
        ? ((node.successRate - currentSuccessRate) / currentSuccessRate) * 100
        : node.successRate > 0 ? 100 : 0;

      alternatives.push({
        actionType: node.actionType,
        predictedSuccessRate: node.successRate,
        improvement: Math.round(improvement * 100) / 100,
      });
    }

    alternatives.sort((a, b) => b.improvement - a.improvement);
    return alternatives.slice(0, topK);
  }

  /**
   * Compare two action plans and recommend the better one.
   *
   * Uses the world model to predict both plans and returns a side-by-side
   * comparison with a recommendation.
   *
   * @param plan1 - First plan (array of action types).
   * @param plan2 - Second plan (array of action types).
   * @param worldModel - The world model to query.
   * @returns Comparison result with predictions and recommendation.
   */
  compareStrategies(
    plan1: string[],
    plan2: string[],
    worldModel: WorldModel,
  ): {
    plan1Prediction: PlanPrediction;
    plan2Prediction: PlanPrediction;
    recommendation: string;
    improvementPercent: number;
  } {
    const plan1Prediction = worldModel.predictPlan(plan1);
    const plan2Prediction = worldModel.predictPlan(plan2);

    const rate1 = plan1Prediction.overallSuccessRate;
    const rate2 = plan2Prediction.overallSuccessRate;

    let recommendation: string;
    let improvementPercent: number;

    if (rate1 > rate2) {
      improvementPercent = rate2 > 0
        ? Math.round(((rate1 - rate2) / rate2) * 100 * 100) / 100
        : rate1 > 0 ? 100 : 0;
      recommendation = `Plan 1 is recommended (${improvementPercent}% higher success rate)`;
    } else if (rate2 > rate1) {
      improvementPercent = rate1 > 0
        ? Math.round(((rate2 - rate1) / rate1) * 100 * 100) / 100
        : rate2 > 0 ? 100 : 0;
      recommendation = `Plan 2 is recommended (${improvementPercent}% higher success rate)`;
    } else {
      improvementPercent = 0;
      recommendation = 'Both plans have equivalent predicted success rates';
    }

    this.logger?.debug('Strategy comparison complete', {
      plan1Rate: rate1,
      plan2Rate: rate2,
      recommendation,
    });

    return { plan1Prediction, plan2Prediction, recommendation, improvementPercent };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Find alternative actions for a given step in an action sequence.
   *
   * Strategy:
   * 1. If there is a next step, find all actions that have causal edges
   *    leading to the next action type (i.e. plausible predecessors).
   * 2. Otherwise (last step), return all nodes with high success rates.
   * 3. Always exclude the original action itself.
   */
  private findAlternatives(
    currentActionType: string,
    stepIndex: number,
    fullSequence: string[],
    worldModel: WorldModel,
  ): Array<{ actionType: string; successRate: number }> {
    const allNodes = worldModel.getNodes();
    const candidates: Array<{ actionType: string; successRate: number }> = [];
    const seen = new Set<string>();

    // If there is a next step, prefer actions that connect to it.
    if (stepIndex < fullSequence.length - 1) {
      const nextActionType = fullSequence[stepIndex + 1];

      for (const node of allNodes) {
        if (node.actionType === currentActionType) continue;
        if (seen.has(node.actionType)) continue;

        const edge = worldModel.getEdge(node.actionType, nextActionType);
        if (edge && edge.weight > 0) {
          candidates.push({ actionType: node.actionType, successRate: node.successRate });
          seen.add(node.actionType);
        }
      }
    }

    // If we did not find enough predecessors (or this is the last step),
    // fall back to all nodes sorted by success rate.
    if (candidates.length < this.maxAlternativesPerStep) {
      for (const node of allNodes) {
        if (node.actionType === currentActionType) continue;
        if (seen.has(node.actionType)) continue;

        candidates.push({ actionType: node.actionType, successRate: node.successRate });
        seen.add(node.actionType);
      }
    }

    // Sort by success rate descending so the best alternatives come first.
    candidates.sort((a, b) => b.successRate - a.successRate);
    return candidates;
  }
}
