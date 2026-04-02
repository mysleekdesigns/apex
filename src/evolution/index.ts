/**
 * APEX Evolution Engine — barrel exports.
 */

export {
  EvolutionLoop,
  type LoopPhase,
  type IterationBudget,
  type LoopState,
  type IterationRecord,
  type LoopMetricsSummary,
  type EvolutionLoopOptions,
} from './loop.js';

export {
  SelfEvaluator,
  type EvaluationResult,
  type JudgePromptData,
  type ReferenceSolution,
  type EvaluatorOptions,
} from './evaluator.js';

export {
  KnowledgeDistiller,
  type SemanticEntry,
  type ExtractedRule,
  type SkillCandidate,
  type DistillationStats,
  type DistillationResult,
  type DecayOptions,
  type DistillationOptions,
} from './distillation.js';

export {
  MetricsTracker,
  type IterationStats,
  type RollingAggregates,
  type MemoryPressure,
  type LearningCurvePoint,
  type MetricsSnapshot,
  type MetricsOptions,
} from './metrics.js';

export {
  SkillPromotionPipeline,
  type PromotionRule,
  type PromotionCandidate,
  type PromotionResult,
  type PromotionPipelineOptions,
} from './promotion.js';

export {
  AgentPopulation,
  type AgentPopulationOptions,
  type EvolutionCycleResult,
  type PopulationStatus,
} from './multi-agent.js';

export {
  ToolFactory,
  type ToolFactoryOptions,
} from './tool-creation.js';

export {
  ArchitectureSearch,
  computeCompositeScore,
  type MutationType,
  type MutationRecord,
  type MutationResult,
  type RollbackSuggestion,
  type ToolUsageStats,
  type ArchitectureSearchOptions,
} from './architecture-search.js';
