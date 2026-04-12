/**
 * Safe Self-Modification Pipeline for APEX Self-Improvement Loop (Phase 16)
 *
 * Analyzes benchmark weak spots, proposes config/parameter changes,
 * evaluates proposals against strict performance gates, and tracks
 * modification history. Implements the Darwin-Godel Machine pattern:
 * self-modification only when provably beneficial.
 *
 * Performance gates:
 * - Composite score must improve by >=5%
 * - No individual dimension may degrade by >2%
 * - Auto-rollback if performance drops >10% from best-ever
 *
 * Pure computation + FileStore persistence -- zero LLM calls.
 */

import { generateId } from '../types.js';
import { Logger } from '../utils/logger.js';
import { FileStore } from '../utils/file-store.js';
import type { AgentConfig } from '../types.js';
import type { BenchmarkResult, DimensionScore } from './self-benchmark.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A proposed modification to APEX's configuration. */
export interface ModificationProposal {
  id: string;
  type: 'config' | 'parameter';
  target: string;
  currentValue: unknown;
  proposedValue: unknown;
  expectedImpact: number;
  rationale: string;
  weakDimension: string;
  timestamp: number;
}

/** Result of testing a modification proposal. */
export interface ModificationResult {
  id: string;
  proposalId: string;
  applied: boolean;
  baselineScore: number;
  postScore: number;
  improvement: number;
  dimensionDeltas: Array<{ dimension: string; delta: number }>;
  rolledBack: boolean;
  reason: string;
  timestamp: number;
}

/** Decision on whether to auto-rollback. */
export interface RollbackDecision {
  shouldRollback: boolean;
  currentScore: number;
  bestScore: number;
  degradation: number;
  episodesSinceLast: number;
  reason: string;
}

export interface SelfModifierOptions {
  fileStore: FileStore;
  logger?: Logger;
  /** Minimum improvement percentage to accept a proposal (default: 5). */
  improvementThreshold?: number;
  /** Maximum allowed degradation percentage on any single dimension (default: 2). */
  maxDegradation?: number;
  /** Minimum episodes since last check before auto-rollback triggers (default: 10). */
  rollbackWindow?: number;
  /** Maximum number of proposals generated per analysis round (default: 3). */
  maxProposalsPerRound?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROPOSALS_COLLECTION = 'modification-proposals';
const RESULTS_COLLECTION = 'self-modifications';

const WEAK_THRESHOLD = 0.6;
const AUTO_ROLLBACK_DEGRADATION = 10; // percentage

// ---------------------------------------------------------------------------
// Mutation rules
// ---------------------------------------------------------------------------

interface MutationRule {
  target: string;
  type: 'config' | 'parameter';
  /** Extract current value from config snapshot. */
  getCurrent: (config: Record<string, unknown>) => unknown;
  /** Compute proposed value from current value. */
  mutate: (current: unknown) => unknown;
  rationale: string;
}

const MUTATION_RULES: Record<string, MutationRule[]> = {
  'recall-accuracy': [
    {
      target: 'memoryLimits.episodic',
      type: 'config',
      getCurrent: (c) => (c['memoryLimits'] as Record<string, unknown>)?.['episodic'] ?? 1000,
      mutate: (v) => Math.round((v as number) * 1.2),
      rationale: 'Increasing episodic memory capacity to improve recall accuracy by retaining more episodes',
    },
    {
      target: 'embeddingLevel',
      type: 'config',
      getCurrent: (c) => c['embeddingLevel'] ?? 'auto',
      mutate: () => 'full',
      rationale: 'Switching to full embedding level for higher-fidelity recall matching',
    },
  ],
  'reflection-quality': [
    {
      target: 'consolidationThreshold',
      type: 'parameter',
      getCurrent: (c) => c['consolidationThreshold'] ?? 10,
      mutate: (v) => Math.max(1, (v as number) - 2),
      rationale: 'Lowering consolidation threshold to trigger more frequent consolidation, improving reflection quality',
    },
  ],
  'skill-reuse-rate': [
    {
      target: 'memoryLimits.semantic',
      type: 'config',
      getCurrent: (c) => (c['memoryLimits'] as Record<string, unknown>)?.['semantic'] ?? 500,
      mutate: (v) => Math.round((v as number) * 1.2),
      rationale: 'Expanding semantic memory capacity to retain more reusable skill patterns',
    },
  ],
  'planning-effectiveness': [
    {
      target: 'explorationRate',
      type: 'parameter',
      getCurrent: (c) => c['explorationRate'] ?? 0.3,
      mutate: (v) => Math.max(0.01, (v as number) - 0.05),
      rationale: 'Reducing exploration rate to favor exploitation of known-good plans',
    },
  ],
  'consolidation-efficiency': [
    {
      target: 'consolidationThreshold',
      type: 'parameter',
      getCurrent: (c) => c['consolidationThreshold'] ?? 10,
      mutate: (v) => Math.max(1, (v as number) - 2),
      rationale: 'Lowering consolidation threshold to trigger consolidation sooner and improve efficiency',
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate the expected improvement percentage based on how far below
 * the weak threshold a dimension score is. Larger deficits imply more
 * room for improvement.
 */
function estimateImpact(score: number): number {
  const deficit = WEAK_THRESHOLD - score;
  // Map deficit (0..0.6) to impact (5..15)
  return Math.round(5 + (deficit / WEAK_THRESHOLD) * 10);
}

// ---------------------------------------------------------------------------
// SelfModifier
// ---------------------------------------------------------------------------

/**
 * Safe self-modification pipeline for APEX.
 *
 * Analyzes benchmark weak spots, proposes configuration and parameter
 * changes, evaluates them against strict performance gates, and tracks
 * all modification history. A proposal is only marked as applied when it
 * clears both the composite-improvement gate and the per-dimension
 * degradation gate.
 */
export class SelfModifier {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly improvementThreshold: number;
  private readonly maxDegradation: number;
  private readonly rollbackWindow: number;
  private readonly maxProposalsPerRound: number;

  constructor(opts: SelfModifierOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:self-modifier' });
    this.improvementThreshold = opts.improvementThreshold ?? 5;
    this.maxDegradation = opts.maxDegradation ?? 2;
    this.rollbackWindow = opts.rollbackWindow ?? 10;
    this.maxProposalsPerRound = opts.maxProposalsPerRound ?? 3;
  }

  // -----------------------------------------------------------------------
  // Weak-spot analysis & proposal generation
  // -----------------------------------------------------------------------

  /**
   * Analyze a benchmark result for weak dimensions (score < 0.6) and
   * generate targeted modification proposals for each.
   *
   * @param benchmarkResult - The benchmark result to analyze.
   * @returns An array of proposals sorted by expected impact (descending),
   *          limited to `maxProposalsPerRound`.
   */
  async analyzeWeakSpots(benchmarkResult: BenchmarkResult): Promise<ModificationProposal[]> {
    const weakDimensions = benchmarkResult.dimensionScores.filter(
      (d) => d.score < WEAK_THRESHOLD,
    );

    if (weakDimensions.length === 0) {
      this.logger.info('No weak dimensions found; no proposals generated', {
        compositeScore: benchmarkResult.compositeScore,
      });
      return [];
    }

    const proposals: ModificationProposal[] = [];
    const config = benchmarkResult.configSnapshot;

    for (const dim of weakDimensions) {
      const rules = MUTATION_RULES[dim.dimension];
      if (!rules) {
        this.logger.debug('No mutation rules for dimension', { dimension: dim.dimension });
        continue;
      }

      // Pick the first applicable rule for each weak dimension
      const rule = rules[0];
      const currentValue = rule.getCurrent(config);
      const proposedValue = rule.mutate(currentValue);

      // Skip no-op mutations (e.g., embeddingLevel already 'full')
      if (JSON.stringify(currentValue) === JSON.stringify(proposedValue)) {
        // If there's a fallback rule, try it
        if (rules.length > 1) {
          const fallback = rules[1];
          const fbCurrent = fallback.getCurrent(config);
          const fbProposed = fallback.mutate(fbCurrent);
          if (JSON.stringify(fbCurrent) !== JSON.stringify(fbProposed)) {
            proposals.push({
              id: generateId(),
              type: fallback.type,
              target: fallback.target,
              currentValue: fbCurrent,
              proposedValue: fbProposed,
              expectedImpact: estimateImpact(dim.score),
              rationale: fallback.rationale,
              weakDimension: dim.dimension,
              timestamp: Date.now(),
            });
          }
        }
        continue;
      }

      proposals.push({
        id: generateId(),
        type: rule.type,
        target: rule.target,
        currentValue,
        proposedValue,
        expectedImpact: estimateImpact(dim.score),
        rationale: rule.rationale,
        weakDimension: dim.dimension,
        timestamp: Date.now(),
      });
    }

    // Sort by expected impact descending, then limit
    proposals.sort((a, b) => b.expectedImpact - a.expectedImpact);
    const limited = proposals.slice(0, this.maxProposalsPerRound);

    // Persist each proposal
    for (const proposal of limited) {
      await this.fileStore.write(PROPOSALS_COLLECTION, proposal.id, proposal);
    }

    this.logger.info('Generated modification proposals', {
      totalWeak: weakDimensions.length,
      proposalsGenerated: limited.length,
    });

    return limited;
  }

  // -----------------------------------------------------------------------
  // Proposal evaluation
  // -----------------------------------------------------------------------

  /**
   * Evaluate a modification proposal by comparing baseline and candidate
   * benchmark results against strict performance gates.
   *
   * Gates:
   * - Composite score must improve by >= `improvementThreshold` (default 5%).
   * - No individual dimension may degrade by > `maxDegradation` (default 2%).
   *
   * @param proposal - The proposal being evaluated.
   * @param baselineResult - Benchmark result before the modification.
   * @param candidateResult - Benchmark result after the modification.
   * @returns The evaluation result, including whether the proposal was applied.
   */
  async evaluateProposal(
    proposal: ModificationProposal,
    baselineResult: BenchmarkResult,
    candidateResult: BenchmarkResult,
  ): Promise<ModificationResult> {
    const baselineScore = baselineResult.compositeScore;
    const postScore = candidateResult.compositeScore;
    const improvement =
      baselineScore === 0
        ? postScore > 0 ? 100 : 0
        : ((postScore - baselineScore) / baselineScore) * 100;

    // Compute per-dimension deltas
    const dimensionDeltas: Array<{ dimension: string; delta: number }> = [];
    const baselineDimMap = new Map(
      baselineResult.dimensionScores.map((d) => [d.dimension, d.score]),
    );

    for (const candidateDim of candidateResult.dimensionScores) {
      const baselineDimScore = baselineDimMap.get(candidateDim.dimension) ?? 0;
      const delta =
        baselineDimScore === 0
          ? candidateDim.score > 0 ? 100 : 0
          : ((candidateDim.score - baselineDimScore) / baselineDimScore) * 100;
      dimensionDeltas.push({ dimension: candidateDim.dimension, delta });
    }

    // Check performance gates
    const meetsImprovementGate = improvement >= this.improvementThreshold;
    const worstDegradation = Math.min(...dimensionDeltas.map((d) => d.delta));
    const meetsDegradationGate = worstDegradation >= -this.maxDegradation;

    const applied = meetsImprovementGate && meetsDegradationGate;
    const rolledBack = !applied;

    let reason: string;
    if (applied) {
      reason = `Proposal accepted: ${improvement.toFixed(1)}% composite improvement with no dimension degrading beyond ${this.maxDegradation}%`;
    } else if (!meetsImprovementGate) {
      reason = `Rejected: composite improvement ${improvement.toFixed(1)}% below threshold ${this.improvementThreshold}%`;
    } else {
      reason = `Rejected: dimension degradation ${Math.abs(worstDegradation).toFixed(1)}% exceeds maximum ${this.maxDegradation}%`;
    }

    const result: ModificationResult = {
      id: generateId(),
      proposalId: proposal.id,
      applied,
      baselineScore,
      postScore,
      improvement,
      dimensionDeltas,
      rolledBack,
      reason,
      timestamp: Date.now(),
    };

    await this.fileStore.write(RESULTS_COLLECTION, result.id, result);

    this.logger.info('Proposal evaluation complete', {
      proposalId: proposal.id,
      applied,
      improvement: improvement.toFixed(1),
      reason,
    });

    return result;
  }

  // -----------------------------------------------------------------------
  // History
  // -----------------------------------------------------------------------

  /**
   * Retrieve all modification proposals, sorted by timestamp descending.
   */
  async getProposalHistory(): Promise<ModificationProposal[]> {
    const proposals = await this.fileStore.readAll<ModificationProposal>(PROPOSALS_COLLECTION);
    return proposals.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Retrieve all modification results, sorted by timestamp descending.
   */
  async getModificationHistory(): Promise<ModificationResult[]> {
    const results = await this.fileStore.readAll<ModificationResult>(RESULTS_COLLECTION);
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  // -----------------------------------------------------------------------
  // Auto-rollback check
  // -----------------------------------------------------------------------

  /**
   * Check whether the system should auto-rollback to its best-ever
   * configuration. Triggers if current composite score is more than 10%
   * worse than the best-ever score and enough episodes have elapsed.
   *
   * @param currentResult - The most recent benchmark result.
   * @param bestResult - The best-ever benchmark result.
   * @param episodesSinceLast - Number of episodes since the last rollback check.
   * @returns A decision object with rollback recommendation and reasoning.
   */
  async autoRollbackCheck(
    currentResult: BenchmarkResult,
    bestResult: BenchmarkResult,
    episodesSinceLast: number,
  ): Promise<RollbackDecision> {
    const currentScore = currentResult.compositeScore;
    const bestScore = bestResult.compositeScore;
    const degradation =
      bestScore === 0
        ? 0
        : ((bestScore - currentScore) / bestScore) * 100;

    const shouldRollback =
      degradation > AUTO_ROLLBACK_DEGRADATION &&
      episodesSinceLast >= this.rollbackWindow;

    let reason: string;
    if (shouldRollback) {
      reason = `Performance degraded ${degradation.toFixed(1)}% from best (${bestScore.toFixed(3)} -> ${currentScore.toFixed(3)}) over ${episodesSinceLast} episodes; auto-rollback recommended`;
    } else if (degradation > AUTO_ROLLBACK_DEGRADATION) {
      reason = `Performance degraded ${degradation.toFixed(1)}% but only ${episodesSinceLast}/${this.rollbackWindow} episodes elapsed; waiting`;
    } else {
      reason = `Performance within acceptable range (${degradation.toFixed(1)}% from best)`;
    }

    this.logger.debug('Auto-rollback check', {
      currentScore,
      bestScore,
      degradation: degradation.toFixed(1),
      episodesSinceLast,
      shouldRollback,
    });

    return {
      shouldRollback,
      currentScore,
      bestScore,
      degradation,
      episodesSinceLast,
      reason,
    };
  }

  // -----------------------------------------------------------------------
  // Statistics
  // -----------------------------------------------------------------------

  /**
   * Aggregate statistics over the full modification history.
   *
   * @returns Summary stats including totals, success rate, and average improvement.
   */
  async getStats(): Promise<{
    totalProposals: number;
    totalApplied: number;
    totalRolledBack: number;
    avgImprovement: number;
    successRate: number;
  }> {
    const results = await this.fileStore.readAll<ModificationResult>(RESULTS_COLLECTION);
    const proposals = await this.fileStore.readAll<ModificationProposal>(PROPOSALS_COLLECTION);

    const totalProposals = proposals.length;
    const totalApplied = results.filter((r) => r.applied).length;
    const totalRolledBack = results.filter((r) => r.rolledBack).length;

    const appliedResults = results.filter((r) => r.applied);
    const avgImprovement =
      appliedResults.length === 0
        ? 0
        : appliedResults.reduce((sum, r) => sum + r.improvement, 0) / appliedResults.length;

    const successRate =
      results.length === 0 ? 0 : totalApplied / results.length;

    return {
      totalProposals,
      totalApplied,
      totalRolledBack,
      avgImprovement,
      successRate,
    };
  }
}
