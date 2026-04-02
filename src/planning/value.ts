/**
 * Value Estimation for MCTS Planning Engine
 *
 * Computes UCB1-based value estimates for action tree nodes, combining:
 * - Exploitation: historical average value (Q-value)
 * - Exploration: UCB1 exploration bonus
 * - Skill-informed priors: boost for actions matching learned skills
 * - Recency weighting: exponential decay for old data
 *
 * Pure computation module — no I/O, no FileStore dependency.
 */

import type { ActionTreeNode } from './action-tree.js';
import type { StoredSkill } from '../memory/procedural.js';
import { jaccardSimilarity } from '../utils/similarity.js';
import { extractKeywords } from '../utils/embeddings.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Full value estimate for a single node. */
export interface ValueEstimate {
  /** Node identifier. */
  nodeId: string;
  /** The action string from the node. */
  action: string;
  /** Exploitation term: average value from past visits. */
  qValue: number;
  /** Exploration term: UCB1 exploration bonus. */
  explorationBonus: number;
  /** Bonus from matching learned skills. */
  skillBoost: number;
  /** Decay factor based on node age (0–1, 1 = fully recent). */
  recencyWeight: number;
  /** Final combined score: (qValue + skillBoost) * recencyWeight + explorationBonus. */
  ucb1Score: number;
}

/** Configuration options for the ValueEstimator. */
export interface ValueEstimatorOptions {
  /** Exploration constant 'c' in UCB1. Default: sqrt(2). */
  explorationConstant?: number;
  /** Half-life in ms for exponential recency decay. Default: 7 days. */
  recencyHalfLifeMs?: number;
  /** Weight applied to skill matching boost. Default: 0.2. */
  skillBoostWeight?: number;
  /** Logger instance for debug output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SQRT_2 = Math.SQRT2;
const MS_PER_DAY = 86_400_000;
const DEFAULT_HALF_LIFE_MS = 7 * MS_PER_DAY;
const DEFAULT_SKILL_BOOST_WEIGHT = 0.2;

// ---------------------------------------------------------------------------
// Standalone pure functions
// ---------------------------------------------------------------------------

/**
 * Compute the UCB1 score for a single child node.
 *
 * Formula: `avgValue + c * sqrt(ln(parentVisits) / childVisits)`
 *
 * If `childVisits` is 0 the node is unexplored and receives `Infinity`
 * so it is always selected first (standard UCB1 behaviour).
 *
 * @param avgValue       - Mean reward observed at this node (Q-value).
 * @param parentVisits   - Total visit count of the parent node.
 * @param childVisits    - Visit count of this child node.
 * @param explorationConstant - The 'c' constant controlling exploration. Default sqrt(2).
 * @returns The UCB1 score.
 */
export function computeUCB1(
  avgValue: number,
  parentVisits: number,
  childVisits: number,
  explorationConstant: number = SQRT_2,
): number {
  if (childVisits === 0) return Infinity;
  if (parentVisits <= 0) return avgValue;

  const explorationTerm =
    explorationConstant * Math.sqrt(Math.log(parentVisits) / childVisits);
  return avgValue + explorationTerm;
}

/**
 * Compute an exponential recency weight for a timestamp.
 *
 * Uses the formula `0.5 ^ (age / halfLife)` so that data exactly one
 * half-life old is weighted at 0.5, two half-lives at 0.25, etc.
 * Future timestamps (negative age) are clamped to weight 1.0.
 *
 * @param timestamp   - The Unix-ms timestamp to evaluate.
 * @param halfLifeMs  - Half-life in milliseconds.
 * @param now         - Current time in Unix-ms (defaults to Date.now()).
 * @returns A weight in (0, 1].
 */
export function computeRecencyWeight(
  timestamp: number,
  halfLifeMs: number = DEFAULT_HALF_LIFE_MS,
  now: number = Date.now(),
): number {
  const ageMs = now - timestamp;
  if (ageMs <= 0) return 1.0;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/**
 * Compute a skill-matching boost for an action string.
 *
 * Extracts keywords from the action and each skill's name + description,
 * then takes the maximum Jaccard similarity across all skills, scaled
 * by the skill's own success rate and the given weight.
 *
 * @param action  - The action string to evaluate.
 * @param skills  - Array of stored skills to match against.
 * @param weight  - Multiplicative weight for the boost. Default 0.2.
 * @returns A non-negative boost value.
 */
export function computeSkillBoost(
  action: string,
  skills: StoredSkill[],
  weight: number = DEFAULT_SKILL_BOOST_WEIGHT,
): number {
  if (skills.length === 0) return 0;

  const actionKeywords = new Set(extractKeywords(action));
  if (actionKeywords.size === 0) return 0;

  let maxWeightedSimilarity = 0;

  for (const skill of skills) {
    if (skill.archived) continue;

    const skillText = `${skill.name} ${skill.description} ${skill.tags.join(' ')}`;
    const skillKeywords = new Set(extractKeywords(skillText));
    if (skillKeywords.size === 0) continue;

    const similarity = jaccardSimilarity(actionKeywords, skillKeywords);
    // Weight by the skill's own empirical success rate and confidence
    const weighted = similarity * skill.successRate * skill.confidence;
    if (weighted > maxWeightedSimilarity) {
      maxWeightedSimilarity = weighted;
    }
  }

  return maxWeightedSimilarity * weight;
}

// ---------------------------------------------------------------------------
// ValueEstimator class
// ---------------------------------------------------------------------------

/**
 * Stateless value estimator for MCTS action-tree nodes.
 *
 * Combines UCB1 exploration/exploitation scoring with skill-informed
 * priors and exponential recency decay. All methods are synchronous
 * pure computations.
 */
export class ValueEstimator {
  private readonly explorationConstant: number;
  private readonly recencyHalfLifeMs: number;
  private readonly skillBoostWeight: number;
  private readonly logger: Logger;

  constructor(options: ValueEstimatorOptions = {}) {
    this.explorationConstant = options.explorationConstant ?? SQRT_2;
    this.recencyHalfLifeMs = options.recencyHalfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    this.skillBoostWeight = options.skillBoostWeight ?? DEFAULT_SKILL_BOOST_WEIGHT;
    this.logger = options.logger ?? new Logger({ prefix: 'value-estimator' });
  }

  /**
   * Compute a full value estimate for a single action-tree node.
   *
   * The final score combines exploitation (Q-value), exploration (UCB1 term),
   * and skill boosting, all modulated by recency:
   *
   *   ucb1Score = (qValue + skillBoost) * recencyWeight + explorationBonus
   *
   * The exploration bonus is *not* decayed so that old but unvisited nodes
   * still receive exploration pressure.
   *
   * @param node              - The action-tree node to evaluate.
   * @param parentVisitCount  - Total visits of the parent node.
   * @param matchingSkills    - Optional skills to compute a boost from.
   * @param now               - Optional current timestamp for recency (default Date.now()).
   * @returns A complete {@link ValueEstimate}.
   */
  estimateValue(
    node: ActionTreeNode,
    parentVisitCount: number,
    matchingSkills: StoredSkill[] = [],
    now: number = Date.now(),
  ): ValueEstimate {
    const qValue = node.avgValue;

    const explorationBonus =
      node.visitCount === 0
        ? Infinity
        : this.explorationConstant *
          Math.sqrt(Math.log(Math.max(1, parentVisitCount)) / node.visitCount);

    const skillBoost = computeSkillBoost(
      node.action,
      matchingSkills,
      this.skillBoostWeight,
    );

    const recencyWeight = computeRecencyWeight(
      node.updatedAt,
      this.recencyHalfLifeMs,
      now,
    );

    // Combine: decay the exploitation + skill component, keep exploration undecayed
    const ucb1Score = (qValue + skillBoost) * recencyWeight + explorationBonus;

    this.logger.debug('Value estimate computed', {
      nodeId: node.id,
      action: node.action,
      qValue,
      explorationBonus,
      skillBoost,
      recencyWeight,
      ucb1Score,
    });

    return {
      nodeId: node.id,
      action: node.action,
      qValue,
      explorationBonus,
      skillBoost,
      recencyWeight,
      ucb1Score,
    };
  }

  /**
   * Rank a list of child nodes by their UCB1 scores (descending).
   *
   * @param children          - Array of action-tree nodes to rank.
   * @param parentVisitCount  - Total visits of the parent node.
   * @param matchingSkills    - Optional skills to compute boosts from.
   * @param now               - Optional current timestamp for recency.
   * @returns Sorted array of {@link ValueEstimate}, highest score first.
   */
  rankChildren(
    children: ActionTreeNode[],
    parentVisitCount: number,
    matchingSkills: StoredSkill[] = [],
    now: number = Date.now(),
  ): ValueEstimate[] {
    const estimates = children.map((child) =>
      this.estimateValue(child, parentVisitCount, matchingSkills, now),
    );

    // Sort descending by ucb1Score.
    // Infinity values (unvisited nodes) sort first; among ties, maintain
    // insertion order via a stable sort.
    estimates.sort((a, b) => {
      // Handle Infinity comparison explicitly
      if (a.ucb1Score === Infinity && b.ucb1Score === Infinity) return 0;
      if (a.ucb1Score === Infinity) return -1;
      if (b.ucb1Score === Infinity) return 1;
      return b.ucb1Score - a.ucb1Score;
    });

    this.logger.debug('Children ranked', {
      count: estimates.length,
      topAction: estimates[0]?.action ?? '(none)',
      topScore: estimates[0]?.ucb1Score ?? 0,
    });

    return estimates;
  }

  /**
   * Compute recency weight using this estimator's configured half-life.
   *
   * @param timestamp - Unix-ms timestamp to evaluate.
   * @param now       - Optional current time (default Date.now()).
   * @returns Weight in (0, 1].
   */
  computeRecencyWeight(
    timestamp: number,
    now: number = Date.now(),
  ): number {
    return computeRecencyWeight(timestamp, this.recencyHalfLifeMs, now);
  }

  /**
   * Compute pure UCB1 score using this estimator's exploration constant.
   *
   * @param avgValue      - Mean reward at the node.
   * @param parentVisits  - Parent visit count.
   * @param childVisits   - Child visit count.
   * @returns UCB1 score.
   */
  computeUCB1(
    avgValue: number,
    parentVisits: number,
    childVisits: number,
  ): number {
    return computeUCB1(avgValue, parentVisits, childVisits, this.explorationConstant);
  }

  /**
   * Compute skill boost using this estimator's configured weight.
   *
   * @param action - Action string to evaluate.
   * @param skills - Skills to match against.
   * @returns Non-negative boost value.
   */
  computeSkillBoost(
    action: string,
    skills: StoredSkill[],
  ): number {
    return computeSkillBoost(action, skills, this.skillBoostWeight);
  }
}
