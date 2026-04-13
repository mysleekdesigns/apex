/**
 * APEX Planning Engine — barrel exports.
 */

export { ActionTree, type ActionTreeNode, type ActionTreeOptions } from './action-tree.js';
export {
  PlanContextBuilder,
  type PlanContext,
  type PastAttempt,
  type Pitfall,
  type ApplicableSkill,
  type PlanContextOptions,
} from './context.js';
export {
  PlanTracker,
  type TrackedPlan,
  type PlanStep,
  type PlanSuccessRate,
  type PlanTrackerOptions,
  type PlanStatus,
  type StepStatus,
} from './tracker.js';
export {
  ValueEstimator,
  computeUCB1,
  computeRecencyWeight,
  computeSkillBoost,
  type ValueEstimate,
  type ValueEstimatorOptions,
} from './value.js';
export {
  MCTSEngine,
  type MCTSNode,
  type MCTSOptions,
  type MCTSResult,
  type SimulationResult,
} from './mcts.js';
export {
  LMValueFunction,
  extractSimpleKeywords,
  type LMValuePrompt,
  type LMValueEvaluation,
  type LMValueAccuracy,
  type LMValueFunctionOptions,
} from './lm-value.js';
export {
  AdaptiveExploration,
  type DomainExplorationStats,
  type ExplorationBalance,
  type AdaptiveExplorationOptions,
} from './adaptive-exploration.js';
export {
  TreePersistenceManager,
  type SavedSubtree,
  type TreeGrowthMetrics,
  type CompactionResult,
  type TreePersistenceOptions,
} from './tree-persistence.js';

export {
  WorldModel,
  type ActionNode,
  type CausalEdge,
  type CausalChain,
  type PlanPrediction,
  type WorldModelOptions,
} from './world-model.js';

export {
  CounterfactualEngine,
  type CounterfactualScenario,
  type CounterfactualAnalysis,
  type CounterfactualEngineOptions,
} from './counterfactual.js';
