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

export {
  PromptOptimizer,
  type MutationType as PromptMutationType,
  type MutationRecord as PromptMutationRecord,
  type OptimizationRound,
  type PromptOptimizerOptions,
} from './prompt-optimizer.js';

export {
  FewShotCurator,
  type FewShotExample,
  type FewShotCuratorOptions,
} from './few-shot-curator.js';

export {
  RegressionDetector,
  type PerformanceMetrics,
  type PerformanceSnapshot,
  type RegressionAlert,
  type LearningCurvePoint as RegressionLearningCurvePoint,
  type RegressionDetectorOptions,
} from './regression-detector.js';
