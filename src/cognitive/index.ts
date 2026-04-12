/**
 * APEX Cognitive Architecture — barrel exports.
 */

export {
  ActivationEngine,
  type AccessRecord,
  type ActivationEntry,
  type SpreadingActivationResult,
  type ActivationEngineOptions,
  type ActivationStats,
} from './activation.js';

export {
  CognitiveCycle,
  type CognitivePhase,
  type PhaseTransition,
  type CycleMetrics,
  type CycleEvent,
  type CognitiveCycleOptions,
} from './cycle.js';

export {
  GoalStack,
  type Goal,
  type GoalStatus,
  type GoalPriority,
  type GoalStackSummary,
  type GoalStackOptions,
} from './goal-stack.js';

export {
  ProductionRuleEngine,
  type ProductionRule,
  type RuleCondition,
  type RuleAction,
  type RuleMatch,
  type ProductionRuleEngineOptions,
  type RuleStats,
} from './production-rules.js';
