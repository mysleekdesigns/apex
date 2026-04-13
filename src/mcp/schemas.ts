/**
 * APEX MCP Input Validation Schemas
 *
 * Zod schemas for all 40 MCP tool handlers.
 * Each schema matches the JSON Schema `inputSchema` defined in tools.ts.
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Validate raw MCP args against a Zod schema.
 * Returns typed data on success, or a structured `CallToolResult` error.
 */
export function validateArgs<T>(
  schema: z.ZodSchema<T>,
  args: Record<string, unknown>,
): { success: true; data: T } | { success: false; error: CallToolResult } {
  const result = schema.safeParse(args);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });

  return {
    success: false,
    error: {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Invalid input',
            details: issues,
          }),
        },
      ],
      isError: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. apex_recall
// ---------------------------------------------------------------------------

export const RecallSchema = z.object({
  query: z.string().min(1, 'query must be a non-empty string'),
  context: z.string().optional(),
  limit: z.number().optional(),
});
export type RecallInput = z.infer<typeof RecallSchema>;

// ---------------------------------------------------------------------------
// 2. apex_record
// ---------------------------------------------------------------------------

const ActionItemSchema = z.object({
  type: z.string().min(1, 'action type is required'),
  description: z.string().min(1, 'action description is required'),
  success: z.boolean(),
});

const OutcomeSchema = z.object({
  success: z.boolean(),
  description: z.string().min(1, 'outcome description is required'),
  errorType: z.string().optional(),
  duration: z.number(),
});

export const RecordSchema = z.object({
  task: z.string().min(1, 'task must be a non-empty string'),
  actions: z.array(ActionItemSchema),
  outcome: OutcomeSchema,
  reward: z.number().optional(),
});
export type RecordInput = z.infer<typeof RecordSchema>;

// ---------------------------------------------------------------------------
// 3. apex_reflect_get
// ---------------------------------------------------------------------------

export const ReflectGetSchema = z.object({
  scope: z.enum(['recent', 'similar', 'errors']),
  episodeIds: z.array(z.string()).optional(),
  taskType: z.string().optional(),
  limit: z.number().optional(),
});
export type ReflectGetInput = z.infer<typeof ReflectGetSchema>;

// ---------------------------------------------------------------------------
// 4. apex_reflect_store
// ---------------------------------------------------------------------------

export const ReflectStoreSchema = z.object({
  level: z.enum(['micro', 'meso', 'macro']),
  content: z.string().min(1, 'content must be a non-empty string'),
  errorTypes: z.array(z.string()).optional(),
  actionableInsights: z.array(z.string()).optional(),
  sourceEpisodes: z.array(z.string()).optional(),
});
export type ReflectStoreInput = z.infer<typeof ReflectStoreSchema>;

// ---------------------------------------------------------------------------
// 5. apex_plan_context
// ---------------------------------------------------------------------------

export const PlanContextSchema = z.object({
  task: z.string().min(1, 'task must be a non-empty string'),
  includeSkills: z.boolean().optional(),
  includePitfalls: z.boolean().optional(),
});
export type PlanContextInput = z.infer<typeof PlanContextSchema>;

// ---------------------------------------------------------------------------
// 6. apex_skills
// ---------------------------------------------------------------------------

export const SkillsSchema = z.object({
  query: z.string().optional(),
  action: z.enum(['list', 'search']).optional(),
  limit: z.number().optional(),
});
export type SkillsInput = z.infer<typeof SkillsSchema>;

// ---------------------------------------------------------------------------
// 7. apex_skill_store
// ---------------------------------------------------------------------------

export const SkillStoreSchema = z.object({
  name: z.string().min(1, 'name must be a non-empty string'),
  description: z.string().min(1, 'description must be a non-empty string'),
  preconditions: z.array(z.string()).optional(),
  pattern: z.string().min(1, 'pattern must be a non-empty string'),
  tags: z.array(z.string()).optional(),
});
export type SkillStoreInput = z.infer<typeof SkillStoreSchema>;

// ---------------------------------------------------------------------------
// 8. apex_status
// ---------------------------------------------------------------------------

export const StatusSchema = z.object({});
export type StatusInput = z.infer<typeof StatusSchema>;

// ---------------------------------------------------------------------------
// 9. apex_consolidate
// ---------------------------------------------------------------------------

export const ConsolidateSchema = z.object({});
export type ConsolidateInput = z.infer<typeof ConsolidateSchema>;

// ---------------------------------------------------------------------------
// 10. apex_curriculum
// ---------------------------------------------------------------------------

export const CurriculumSchema = z.object({
  domain: z.string().optional(),
  skillLevel: z.number().optional(),
});
export type CurriculumInput = z.infer<typeof CurriculumSchema>;

// ---------------------------------------------------------------------------
// 11. apex_setup
// ---------------------------------------------------------------------------

export const SetupSchema = z.object({
  projectPath: z.string().optional(),
});
export type SetupInput = z.infer<typeof SetupSchema>;

// ---------------------------------------------------------------------------
// 12. apex_snapshot
// ---------------------------------------------------------------------------

export const SnapshotSchema = z.object({
  name: z.string().optional(),
});
export type SnapshotInput = z.infer<typeof SnapshotSchema>;

// ---------------------------------------------------------------------------
// 13. apex_rollback
// ---------------------------------------------------------------------------

export const RollbackSchema = z.object({
  snapshotId: z.string().optional(),
  latest: z.boolean().optional(),
});
export type RollbackInput = z.infer<typeof RollbackSchema>;

// ---------------------------------------------------------------------------
// 14. apex_promote
// ---------------------------------------------------------------------------

export const PromoteSchema = z.object({
  skillId: z.string().min(1, 'skillId must be a non-empty string'),
});
export type PromoteInput = z.infer<typeof PromoteSchema>;

// ---------------------------------------------------------------------------
// 15. apex_import
// ---------------------------------------------------------------------------

export const ImportSchema = z.object({
  source: z.string().min(1, 'source must be a non-empty string'),
});
export type ImportInput = z.infer<typeof ImportSchema>;

// ---------------------------------------------------------------------------
// 16. apex_foresight_predict
// ---------------------------------------------------------------------------

export const ForesightPredictSchema = z.object({
  taskId: z.string().min(1, 'taskId must be a non-empty string'),
  predictedSuccess: z.boolean(),
  expectedDuration: z.number(),
  expectedSteps: z.number(),
  riskFactors: z.array(z.string()).optional(),
  confidence: z.number().optional(),
});
export type ForesightPredictInput = z.infer<typeof ForesightPredictSchema>;

// ---------------------------------------------------------------------------
// 17. apex_foresight_check
// ---------------------------------------------------------------------------

export const ForesightCheckSchema = z.object({
  predictionId: z.string().min(1, 'predictionId must be a non-empty string'),
  stepIndex: z.number(),
  stepSuccess: z.boolean(),
  elapsedMs: z.number(),
  completedSteps: z.number(),
  stepDescription: z.string().optional(),
});
export type ForesightCheckInput = z.infer<typeof ForesightCheckSchema>;

// ---------------------------------------------------------------------------
// 18. apex_foresight_resolve
// ---------------------------------------------------------------------------

const ActualOutcomeSchema = z.object({
  success: z.boolean(),
  description: z.string().min(1, 'actualOutcome.description is required'),
  errorType: z.string().optional(),
  duration: z.number(),
});

export const ForesightResolveSchema = z.object({
  predictionId: z.string().min(1, 'predictionId must be a non-empty string'),
  actualOutcome: ActualOutcomeSchema,
  episodeId: z.string().optional(),
});
export type ForesightResolveInput = z.infer<typeof ForesightResolveSchema>;

// ---------------------------------------------------------------------------
// 19. apex_population_status
// ---------------------------------------------------------------------------

export const PopulationStatusSchema = z.object({});
export type PopulationStatusInput = z.infer<typeof PopulationStatusSchema>;

// ---------------------------------------------------------------------------
// 20. apex_population_evolve
// ---------------------------------------------------------------------------

export const PopulationEvolveSchema = z.object({
  taskId: z.string().optional(),
  taskDomain: z.string().optional(),
  taskReward: z.number().optional(),
  taskSuccess: z.boolean().optional(),
});
export type PopulationEvolveInput = z.infer<typeof PopulationEvolveSchema>;

// ---------------------------------------------------------------------------
// 21. apex_tool_propose
// ---------------------------------------------------------------------------

export const ToolProposeSchema = z.object({
  minFrequency: z.number().optional(),
  minSuccessRate: z.number().optional(),
});
export type ToolProposeInput = z.infer<typeof ToolProposeSchema>;

// ---------------------------------------------------------------------------
// 22. apex_tool_verify
// ---------------------------------------------------------------------------

export const ToolVerifySchema = z.object({
  toolId: z.string().min(1, 'toolId must be a non-empty string'),
});
export type ToolVerifyInput = z.infer<typeof ToolVerifySchema>;

// ---------------------------------------------------------------------------
// 23. apex_tool_list
// ---------------------------------------------------------------------------

export const ToolListSchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected', 'deprecated']).optional(),
});
export type ToolListInput = z.infer<typeof ToolListSchema>;

// ---------------------------------------------------------------------------
// 24. apex_tool_compose
// ---------------------------------------------------------------------------

export const ToolComposeSchema = z.object({
  toolIds: z.array(z.string()).optional(),
});
export type ToolComposeInput = z.infer<typeof ToolComposeSchema>;

// ---------------------------------------------------------------------------
// 25. apex_arch_status
// ---------------------------------------------------------------------------

export const ArchStatusSchema = z.object({});
export type ArchStatusInput = z.infer<typeof ArchStatusSchema>;

// ---------------------------------------------------------------------------
// 26. apex_arch_mutate
// ---------------------------------------------------------------------------

export const ArchMutateSchema = z.object({
  mutationType: z
    .enum([
      'toggle-subsystem',
      'adjust-reflection-frequency',
      'adjust-consolidation-frequency',
      'adjust-memory-capacity',
      'adjust-exploration-rate',
      'adjust-consolidation-threshold',
      'adjust-performance-window',
    ])
    .optional(),
  biased: z.boolean().optional(),
});
export type ArchMutateInput = z.infer<typeof ArchMutateSchema>;

// ---------------------------------------------------------------------------
// 27. apex_arch_suggest
// ---------------------------------------------------------------------------

export const ArchSuggestSchema = z.object({});
export type ArchSuggestInput = z.infer<typeof ArchSuggestSchema>;

// ---------------------------------------------------------------------------
// 28. apex_prompt_optimize
// ---------------------------------------------------------------------------

export const PromptOptimizeSchema = z.object({
  action: z.enum(['optimize', 'status', 'conclude-experiments']),
});
export type PromptOptimizeInput = z.infer<typeof PromptOptimizeSchema>;

// ---------------------------------------------------------------------------
// 29. apex_prompt_module
// ---------------------------------------------------------------------------

export const PromptModuleSchema = z.object({
  action: z.enum(['register', 'list', 'get', 'hot-swap', 'add-variant', 'examples']),
  name: z.string().min(1).optional(),
  category: z.enum(['tool-description', 'behavior', 'few-shot']).optional(),
  content: z.string().min(1).optional(),
  mutationType: z
    .enum(['rephrase', 'add-example', 'remove-example', 'adjust-emphasis', 'simplify', 'elaborate'])
    .optional(),
});
export type PromptModuleInput = z.infer<typeof PromptModuleSchema>;

// ---------------------------------------------------------------------------
// 30. apex_goals
// ---------------------------------------------------------------------------

export const GoalsSchema = z.object({
  action: z.enum(['add', 'list', 'get', 'update', 'complete', 'block', 'abandon', 'search']),
  goalId: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  parentId: z.string().min(1).optional(),
  deadline: z.string().min(1).optional(),
  context: z.string().optional(),
  tags: z.array(z.string()).optional(),
  query: z.string().min(1).optional(),
  cascade: z.boolean().optional(),
});
export type GoalsInput = z.infer<typeof GoalsSchema>;

// ---------------------------------------------------------------------------
// 31. apex_cognitive_status
// ---------------------------------------------------------------------------

export const CognitiveStatusSchema = z.object({});
export type CognitiveStatusInput = z.infer<typeof CognitiveStatusSchema>;

// ---------------------------------------------------------------------------
// 32. apex_self_benchmark
// ---------------------------------------------------------------------------

export const SelfBenchmarkSchema = z.object({
  action: z.enum(['run', 'history', 'compare', 'seed']),
  baselineId: z.string().min(1).optional(),
  candidateId: z.string().min(1).optional(),
  seedCount: z.number().optional(),
});
export type SelfBenchmarkInput = z.infer<typeof SelfBenchmarkSchema>;

// ---------------------------------------------------------------------------
// 33. apex_self_modify
// ---------------------------------------------------------------------------

export const SelfModifySchema = z.object({
  action: z.enum(['analyze', 'evaluate', 'history', 'rollback-check', 'stats']),
  benchmarkId: z.string().min(1).optional(),
  proposalId: z.string().min(1).optional(),
  baselineBenchmarkId: z.string().min(1).optional(),
  candidateBenchmarkId: z.string().min(1).optional(),
});
export type SelfModifyInput = z.infer<typeof SelfModifySchema>;

// ---------------------------------------------------------------------------
// 34. apex_telemetry
// ---------------------------------------------------------------------------

export const TelemetrySchema = z.object({
  action: z.enum(['summary', 'events', 'episodes', 'rewards', 'flush']),
  limit: z.number().optional(),
});
export type TelemetryInput = z.infer<typeof TelemetrySchema>;

// ---------------------------------------------------------------------------
// 35. apex_world_model
// ---------------------------------------------------------------------------

export const WorldModelSchema = z.object({
  action: z.enum(['build', 'predict', 'chains', 'counterfactual', 'compare', 'stats']),
  planSteps: z.array(z.string()).optional(),
  planSteps2: z.array(z.string()).optional(),
  episodeId: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().optional(),
});
export type WorldModelInput = z.infer<typeof WorldModelSchema>;

// ---------------------------------------------------------------------------
// 36. apex_team_propose
// ---------------------------------------------------------------------------

export const TeamProposeSchema = z.object({
  title: z.string().min(1, 'title is required'),
  description: z.string().min(1, 'description is required'),
  category: z.enum(['skill', 'knowledge', 'error-taxonomy']),
  content: z.string().min(1, 'content is required'),
  tags: z.array(z.string()).optional(),
  confidence: z.number().optional(),
});
export type TeamProposeInput = z.infer<typeof TeamProposeSchema>;

// ---------------------------------------------------------------------------
// 37. apex_team_review
// ---------------------------------------------------------------------------

export const TeamReviewSchema = z.object({
  proposalId: z.string().min(1, 'proposalId is required'),
  decision: z.enum(['accept', 'reject']),
  comment: z.string().optional(),
});
export type TeamReviewInput = z.infer<typeof TeamReviewSchema>;

// ---------------------------------------------------------------------------
// 38. apex_team_status
// ---------------------------------------------------------------------------

export const TeamStatusSchema = z.object({});
export type TeamStatusInput = z.infer<typeof TeamStatusSchema>;

// ---------------------------------------------------------------------------
// 39. apex_team_sync
// ---------------------------------------------------------------------------

export const TeamSyncSchema = z.object({});
export type TeamSyncInput = z.infer<typeof TeamSyncSchema>;

// ---------------------------------------------------------------------------
// 40. apex_team_log
// ---------------------------------------------------------------------------

export const TeamLogSchema = z.object({
  limit: z.number().optional(),
});
export type TeamLogInput = z.infer<typeof TeamLogSchema>;

// ---------------------------------------------------------------------------
// Schema map — keyed by tool name for dynamic lookup
// ---------------------------------------------------------------------------

export const schemaMap: Record<string, z.ZodSchema> = {
  apex_recall: RecallSchema,
  apex_record: RecordSchema,
  apex_reflect_get: ReflectGetSchema,
  apex_reflect_store: ReflectStoreSchema,
  apex_plan_context: PlanContextSchema,
  apex_skills: SkillsSchema,
  apex_skill_store: SkillStoreSchema,
  apex_status: StatusSchema,
  apex_consolidate: ConsolidateSchema,
  apex_curriculum: CurriculumSchema,
  apex_setup: SetupSchema,
  apex_snapshot: SnapshotSchema,
  apex_rollback: RollbackSchema,
  apex_promote: PromoteSchema,
  apex_import: ImportSchema,
  apex_foresight_predict: ForesightPredictSchema,
  apex_foresight_check: ForesightCheckSchema,
  apex_foresight_resolve: ForesightResolveSchema,
  apex_population_status: PopulationStatusSchema,
  apex_population_evolve: PopulationEvolveSchema,
  apex_tool_propose: ToolProposeSchema,
  apex_tool_verify: ToolVerifySchema,
  apex_tool_list: ToolListSchema,
  apex_tool_compose: ToolComposeSchema,
  apex_arch_status: ArchStatusSchema,
  apex_arch_mutate: ArchMutateSchema,
  apex_arch_suggest: ArchSuggestSchema,
  apex_prompt_optimize: PromptOptimizeSchema,
  apex_prompt_module: PromptModuleSchema,
  apex_goals: GoalsSchema,
  apex_cognitive_status: CognitiveStatusSchema,
  apex_self_benchmark: SelfBenchmarkSchema,
  apex_self_modify: SelfModifySchema,
  apex_telemetry: TelemetrySchema,
  apex_world_model: WorldModelSchema,
  apex_team_propose: TeamProposeSchema,
  apex_team_review: TeamReviewSchema,
  apex_team_status: TeamStatusSchema,
  apex_team_sync: TeamSyncSchema,
  apex_team_log: TeamLogSchema,
};
