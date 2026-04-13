/**
 * APEX MCP Tool Handlers
 *
 * Connects MCP tool calls to the memory, reflection, planning, and
 * cross-project learning subsystems.
 */

import path from 'node:path';
import os from 'node:os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Episode, Action, Outcome, Reflection, Snapshot } from '../types.js';
import { generateId } from '../types.js';
import { MemoryManager } from '../memory/manager.js';
import { ReflectionCoordinator } from '../reflection/coordinator.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';
import { scanProject } from '../utils/project-scanner.js';
import { PlanContextBuilder } from '../planning/context.js';
import { ActionTree } from '../planning/action-tree.js';
import { PlanTracker } from '../planning/tracker.js';
import { ValueEstimator } from '../planning/value.js';
import { CurriculumGenerator } from '../curriculum/generator.js';
import { DifficultyEstimator } from '../curriculum/difficulty.js';
import { SkillExtractor } from '../curriculum/skill-extractor.js';
import { GlobalStoreManager } from '../memory/global-store.js';
import { CrossProjectQuery } from '../memory/cross-project.js';
import { PortabilityManager } from '../memory/portability.js';
import { ProjectSimilarityIndex } from '../memory/project-index.js';
import { SkillPromotionPipeline } from '../evolution/promotion.js';
import { EffectivenessTracker } from '../integration/effectiveness-tracker.js';
import { ArchitectureSearch } from '../evolution/architecture-search.js';
import { ForesightEngine } from '../reflection/foresight.js';
import { AgentPopulation } from '../evolution/multi-agent.js';
import { ToolFactory } from '../evolution/tool-creation.js';
import { PromptModuleRegistry } from './dynamic-descriptions.js';
import { ABTestManager } from '../integration/ab-testing.js';
import { PromptOptimizer } from '../evolution/prompt-optimizer.js';
import { FewShotCurator } from '../evolution/few-shot-curator.js';
import { RegressionDetector } from '../evolution/regression-detector.js';
import { ActivationEngine } from '../cognitive/activation.js';
import { CognitiveCycle } from '../cognitive/cycle.js';
import { GoalStack } from '../cognitive/goal-stack.js';
import { ProductionRuleEngine } from '../cognitive/production-rules.js';
import { SelfBenchmark } from '../evolution/self-benchmark.js';
import { SelfModifier } from '../evolution/self-modify.js';
import { TelemetryCollector } from '../integration/telemetry.js';
import { EpisodeDetector } from '../integration/episode-detector.js';
import { ImplicitRewardEngine } from '../integration/implicit-rewards.js';
import { WorldModel } from '../planning/world-model.js';
import { CounterfactualEngine } from '../planning/counterfactual.js';
import { KnowledgeTier } from '../team/knowledge-tier.js';
import { ProposalManager } from '../team/proposal.js';
import { FederationEngine } from '../team/federation.js';
import type { ToolDefinitionApex } from '../types.js';
import {
  validateArgs,
  RecallSchema,
  PromptOptimizeSchema,
  PromptModuleSchema,
  RecordSchema,
  ReflectGetSchema,
  ReflectStoreSchema,
  PlanContextSchema,
  SkillsSchema,
  SkillStoreSchema,
  StatusSchema,
  ConsolidateSchema,
  CurriculumSchema,
  SetupSchema,
  SnapshotSchema,
  RollbackSchema,
  PromoteSchema,
  ImportSchema,
  ForesightPredictSchema,
  ForesightCheckSchema,
  ForesightResolveSchema,
  PopulationStatusSchema,
  PopulationEvolveSchema,
  ToolProposeSchema,
  ToolVerifySchema,
  ToolListSchema,
  ToolComposeSchema,
  ArchStatusSchema,
  ArchMutateSchema,
  ArchSuggestSchema,
  GoalsSchema,
  CognitiveStatusSchema,
  SelfBenchmarkSchema,
  SelfModifySchema,
  TelemetrySchema,
  WorldModelSchema,
  TeamProposeSchema,
  TeamReviewSchema,
  TeamStatusSchema,
  TeamSyncSchema,
  TeamLogSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function stub(toolName: string, args: Record<string, unknown>): CallToolResult {
  return ok({
    status: 'not_yet_implemented',
    tool: toolName,
    message: `${toolName} handler is stubbed. Implementation pending.`,
    receivedArgs: args,
  });
}

function fail(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Singleton memory manager (initialised lazily by apex_setup or first use)
// ---------------------------------------------------------------------------

let memoryManager: MemoryManager | null = null;
let reflectionCoordinator: ReflectionCoordinator | null = null;
let planContextBuilder: PlanContextBuilder | null = null;
let actionTree: ActionTree | null = null;
let planTracker: PlanTracker | null = null;
let valueEstimator: ValueEstimator | null = null;
let curriculumGenerator: CurriculumGenerator | null = null;
let globalStoreManager: GlobalStoreManager | null = null;
let crossProjectQuery: CrossProjectQuery | null = null;
let projectIndex: ProjectSimilarityIndex | null = null;
let effectivenessTracker: EffectivenessTracker | null = null;
let foresightEngine: ForesightEngine | null = null;
let agentPopulation: AgentPopulation | null = null;
let toolFactory: ToolFactory | null = null;
let architectureSearch: ArchitectureSearch | null = null;
let promptModuleRegistry: PromptModuleRegistry | null = null;
let abTestManager: ABTestManager | null = null;
let promptOptimizer: PromptOptimizer | null = null;
let fewShotCurator: FewShotCurator | null = null;
let regressionDetector: RegressionDetector | null = null;
let activationEngine: ActivationEngine | null = null;
let cognitiveCycle: CognitiveCycle | null = null;
let goalStack: GoalStack | null = null;
let productionRuleEngine: ProductionRuleEngine | null = null;
let selfBenchmark: SelfBenchmark | null = null;
let selfModifier: SelfModifier | null = null;
let telemetryCollector: TelemetryCollector | null = null;
let episodeDetector: EpisodeDetector | null = null;
let implicitRewardEngine: ImplicitRewardEngine | null = null;
let worldModel: WorldModel | null = null;
let counterfactualEngine: CounterfactualEngine | null = null;
let knowledgeTier: KnowledgeTier | null = null;
let proposalManager: ProposalManager | null = null;
let federationEngine: FederationEngine | null = null;
const logger = new Logger({ prefix: 'apex:handlers' });

function getProjectDataPath(projectPath: string): string {
  return path.join(projectPath, '.apex-data');
}

function getGlobalDataPath(): string {
  return path.join(os.homedir(), '.apex');
}

async function getOrCreateManager(projectPath?: string): Promise<MemoryManager> {
  if (memoryManager) return memoryManager;

  const root = projectPath ?? process.cwd();
  memoryManager = new MemoryManager({
    projectDataPath: getProjectDataPath(root),
    globalDataPath: getGlobalDataPath(),
    projectPath: root,
    logger,
  });
  await memoryManager.init();
  return memoryManager;
}

async function getOrCreatePlanningSubsystems(projectPath?: string): Promise<{
  contextBuilder: PlanContextBuilder;
  tree: ActionTree;
  tracker: PlanTracker;
  estimator: ValueEstimator;
}> {
  const root = projectPath ?? process.cwd();
  const mgr = await getOrCreateManager(root);
  const store = new FileStore(getProjectDataPath(root));
  await store.init();

  if (!actionTree) {
    actionTree = new ActionTree({ fileStore: store, logger });
    await actionTree.load();
  }
  if (!planTracker) {
    planTracker = new PlanTracker({ fileStore: store, logger });
  }
  if (!valueEstimator) {
    valueEstimator = new ValueEstimator({ logger });
  }
  if (!planContextBuilder) {
    planContextBuilder = new PlanContextBuilder({ fileStore: store, memoryManager: mgr, logger });
  }

  return {
    contextBuilder: planContextBuilder,
    tree: actionTree,
    tracker: planTracker,
    estimator: valueEstimator,
  };
}

async function getOrCreateReflectionCoordinator(projectPath?: string): Promise<ReflectionCoordinator> {
  if (reflectionCoordinator) return reflectionCoordinator;

  const root = projectPath ?? process.cwd();
  const mgr = await getOrCreateManager(root);
  const store = new FileStore(getProjectDataPath(root));
  await store.init();

  reflectionCoordinator = new ReflectionCoordinator({
    fileStore: store,
    semanticMemory: mgr.getSemanticMemory(),
    logger,
  });
  return reflectionCoordinator;
}

async function getOrCreateGlobalStore(): Promise<GlobalStoreManager> {
  if (globalStoreManager) return globalStoreManager;
  globalStoreManager = new GlobalStoreManager({ globalDataPath: getGlobalDataPath(), logger });
  await globalStoreManager.init();
  return globalStoreManager;
}

async function getOrCreateCrossProjectQuery(projectPath?: string): Promise<CrossProjectQuery> {
  if (crossProjectQuery) return crossProjectQuery;
  const root = projectPath ?? process.cwd();
  const projectStore = new FileStore(getProjectDataPath(root));
  await projectStore.init();
  const globalStore = new FileStore(getGlobalDataPath());
  await globalStore.init();
  crossProjectQuery = new CrossProjectQuery({ projectStore, globalStore, logger });
  return crossProjectQuery;
}

async function getOrCreateProjectIndex(): Promise<ProjectSimilarityIndex> {
  if (projectIndex) return projectIndex;
  const globalStore = new FileStore(getGlobalDataPath());
  await globalStore.init();
  projectIndex = new ProjectSimilarityIndex({ globalStore, logger });
  return projectIndex;
}

async function getOrCreateEffectivenessTracker(projectPath?: string): Promise<EffectivenessTracker> {
  if (effectivenessTracker) return effectivenessTracker;
  const root = projectPath ?? process.cwd();
  const store = new FileStore(getProjectDataPath(root));
  await store.init();
  effectivenessTracker = new EffectivenessTracker(store);
  return effectivenessTracker;
}

async function getOrCreatePromptSubsystems(projectPath?: string): Promise<{
  registry: PromptModuleRegistry;
  abManager: ABTestManager;
  optimizer: PromptOptimizer;
  curator: FewShotCurator;
  detector: RegressionDetector;
}> {
  const root = projectPath ?? process.cwd();
  const store = new FileStore(getProjectDataPath(root));
  await store.init();

  if (!promptModuleRegistry) {
    promptModuleRegistry = new PromptModuleRegistry({ fileStore: store, logger });
    await promptModuleRegistry.init();
  }
  if (!abTestManager) {
    abTestManager = new ABTestManager({ fileStore: store, logger });
    await abTestManager.init();
  }
  if (!promptOptimizer) {
    promptOptimizer = new PromptOptimizer({ fileStore: store, logger });
    await promptOptimizer.init();
  }
  if (!fewShotCurator) {
    fewShotCurator = new FewShotCurator({ fileStore: store, logger });
    await fewShotCurator.init();
  }
  if (!regressionDetector) {
    regressionDetector = new RegressionDetector({ fileStore: store, logger });
    await regressionDetector.init();
  }

  return {
    registry: promptModuleRegistry,
    abManager: abTestManager,
    optimizer: promptOptimizer,
    curator: fewShotCurator,
    detector: regressionDetector,
  };
}

async function getOrCreateCognitiveSubsystems(projectPath?: string): Promise<{
  activation: ActivationEngine;
  cycle: CognitiveCycle;
  goals: GoalStack;
  rules: ProductionRuleEngine;
}> {
  const root = projectPath ?? process.cwd();
  const store = new FileStore(getProjectDataPath(root));
  await store.init();

  if (!activationEngine) {
    activationEngine = new ActivationEngine({ fileStore: store, logger });
    await activationEngine.init();
  }
  if (!cognitiveCycle) {
    cognitiveCycle = new CognitiveCycle({ fileStore: store, logger });
    await cognitiveCycle.init();
  }
  if (!goalStack) {
    goalStack = new GoalStack({ fileStore: store, logger });
    await goalStack.init();
  }
  if (!productionRuleEngine) {
    productionRuleEngine = new ProductionRuleEngine({ fileStore: store, logger });
    await productionRuleEngine.init();
  }

  return {
    activation: activationEngine,
    cycle: cognitiveCycle,
    goals: goalStack,
    rules: productionRuleEngine,
  };
}

async function getOrCreateSelfImprovementSubsystems(projectPath?: string): Promise<{
  benchmark: SelfBenchmark;
  modifier: SelfModifier;
}> {
  const root = projectPath ?? process.cwd();
  const store = new FileStore(getProjectDataPath(root));
  await store.init();

  if (!selfBenchmark) {
    selfBenchmark = new SelfBenchmark({ fileStore: store, logger });
  }
  if (!selfModifier) {
    selfModifier = new SelfModifier({ fileStore: store, logger });
  }

  return { benchmark: selfBenchmark, modifier: selfModifier };
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

async function handleRecall(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(RecallSchema, args);
  if (!v.success) return v.error;
  const { query, limit: rawLimit } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_recall');

  const limit = rawLimit ?? 10;
  const mgr = await getOrCreateManager();
  const results = await mgr.recall(query, limit);

  tracker.recordRecallHit(results.length > 0);

  return ok({
    status: 'ok',
    query,
    resultCount: results.length,
    results: results.map((r) => ({
      content: r.entry.content,
      score: Math.round(r.score * 1000) / 1000,
      tier: r.sourceTier,
      source: r.source,
      confidence: r.entry.confidence,
      stale: r.entry.stale ?? false,
    })),
  });
}

async function handleRecord(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(RecordSchema, args);
  if (!v.success) return v.error;
  const { task, actions: rawActions, outcome: rawOutcome, reward: rawReward } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_record');

  const now = Date.now();
  const actions: Action[] = rawActions.map((a) => ({
    type: a.type,
    description: a.description,
    success: a.success,
    timestamp: now,
  }));

  const outcome: Outcome = {
    success: rawOutcome.success,
    description: rawOutcome.description,
    errorType: rawOutcome.errorType,
    duration: rawOutcome.duration,
  };

  const reward = rawReward ?? (outcome.success ? 1.0 : 0.0);

  const episode: Episode = {
    id: generateId(),
    task,
    actions,
    outcome,
    reward,
    timestamp: now,
    sourceFiles: undefined,
  };

  const mgr = await getOrCreateManager();

  // Record as episodic memory entry
  const content = `Task: ${task}\nOutcome: ${outcome.success ? 'SUCCESS' : 'FAILURE'} — ${outcome.description}`;
  const entry = await mgr.addToEpisodic(content);

  // Also store the full episode in the file store
  const store = new FileStore(getProjectDataPath(process.cwd()));
  await store.write('episodes', episode.id, episode);

  return ok({
    status: 'ok',
    episodeId: episode.id,
    memoryEntryId: entry.id,
    task,
    success: outcome.success,
  });
}

async function handleReflectGet(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ReflectGetSchema, args);
  if (!v.success) return v.error;
  const { scope, episodeIds, taskType, limit: rawLimit } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_reflect_get');

  const coordinator = await getOrCreateReflectionCoordinator();

  if (scope === 'recent') {
    const limit = rawLimit ?? 20;
    // Use first episodeId if provided, otherwise return metrics
    const episodeId = episodeIds?.[0];
    if (episodeId) {
      const data = await coordinator.getMicroData(episodeId);
      return ok({ status: 'ok', ...data });
    }
    // Fallback: return metrics and unreflected episode count
    const metrics = await coordinator.metrics();
    const unreflected = await coordinator.getUnreflectedEpisodes();
    return ok({
      status: 'ok',
      metrics,
      unreflectedEpisodeCount: unreflected.length,
      hint: 'Provide episodeIds for detailed micro-level data, or use scope "similar" with taskType for meso-level data.',
    });
  }

  if (scope === 'similar') {
    const limit = rawLimit ?? 20;
    if (taskType) {
      const data = await coordinator.getMesoData(taskType, limit);
      return ok({ status: 'ok', ...data });
    }
    const metrics = await coordinator.metrics();
    return ok({
      status: 'ok',
      metrics,
      hint: 'Provide taskType to filter by similar tasks.',
    });
  }

  if (scope === 'errors') {
    const data = await coordinator.getMacroData(undefined, undefined);
    return ok({ status: 'ok', ...data });
  }

  // Fallback: return metrics and unreflected episode count
  const metrics = await coordinator.metrics();
  const unreflected = await coordinator.getUnreflectedEpisodes();
  return ok({
    status: 'ok',
    metrics,
    unreflectedEpisodeCount: unreflected.length,
    hint: 'Use scope: "recent", "similar" (+ taskType), or "errors" for structured reflection data.',
  });
}

async function handleReflectStore(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ReflectStoreSchema, args);
  if (!v.success) return v.error;
  const { level, content, errorTypes, actionableInsights, sourceEpisodes } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_reflect_store');

  const coordinator = await getOrCreateReflectionCoordinator();

  const result = await coordinator.storeReflection({
    level,
    content,
    errorTypes: errorTypes ?? undefined,
    actionableInsights: actionableInsights ?? undefined,
    sourceEpisodes: sourceEpisodes ?? undefined,
    confidence: undefined,
  });

  return ok({
    status: 'ok',
    reflectionId: result.reflection.id,
    level,
    isDuplicate: result.isDuplicate,
    actionabilityScore: Math.round(result.actionabilityScore * 1000) / 1000,
    storedInsights: result.reflection.actionableInsights.length,
    semanticEntryId: result.semanticEntryId,
  });
}

async function handlePlanContext(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(PlanContextSchema, args);
  if (!v.success) return v.error;
  const { task } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_plan_context');

  const { contextBuilder, tree, estimator } = await getOrCreatePlanningSubsystems();
  const context = await contextBuilder.getContext(task);

  // Augment with action tree best path if available
  let bestActionPath: string[] | null = null;
  const root = tree.getRoot();
  if (root) {
    const path = tree.getBestPath(root.id);
    if (path.length > 0) {
      bestActionPath = path.map((n) => n.action);
    }
  }

  return ok({
    status: 'ok',
    task,
    confidence: Math.round(context.confidence * 1000) / 1000,
    suggestedApproach: context.suggestedApproach,
    pastAttempts: context.pastAttempts.map((a) => ({
      episodeId: a.episodeId,
      task: a.task,
      success: a.outcome.success,
      reward: a.reward,
      similarity: Math.round(a.similarity * 1000) / 1000,
      actionCount: a.actions.length,
    })),
    knownPitfalls: context.knownPitfalls.map((p) => ({
      description: p.description,
      errorType: p.errorType,
      frequency: p.frequency,
    })),
    applicableSkills: context.applicableSkills.map((s) => ({
      name: s.name,
      description: s.description,
      successRate: s.successRate,
      confidence: s.confidence,
      relevance: Math.round(s.relevance * 1000) / 1000,
    })),
    relevantInsights: context.relevantInsights,
    bestActionPath,
  });
}

async function handleSkills(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(SkillsSchema, args);
  if (!v.success) return v.error;
  const { query, action: rawAction, limit: rawLimit } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_skills');

  const action = rawAction ?? 'list';
  const limit = rawLimit ?? 20;
  const mgr = await getOrCreateManager();

  if (action === 'search' && query) {
    const results = await mgr.searchSkills(query, limit);
    return ok({
      status: 'ok',
      action: 'search',
      query,
      resultCount: results.length,
      skills: results.map((r) => ({
        id: r.skill.id,
        name: r.skill.name,
        description: r.skill.description,
        successRate: r.skill.successRate,
        confidence: r.skill.confidence,
        usageCount: r.skill.usageCount,
        tags: r.skill.tags,
        score: Math.round(r.score * 1000) / 1000,
      })),
    });
  }

  // Default: list all
  const allSkills = await mgr.listSkills();
  return ok({
    status: 'ok',
    action: 'list',
    skillCount: allSkills.length,
    skills: allSkills.slice(0, limit).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      successRate: s.successRate,
      confidence: s.confidence,
      usageCount: s.usageCount,
      tags: s.tags,
    })),
  });
}

async function handleSkillStore(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(SkillStoreSchema, args);
  if (!v.success) return v.error;
  const { name, description, pattern, preconditions, tags } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_skill_store');

  const mgr = await getOrCreateManager();
  const skill = await mgr.addSkill({
    name,
    description,
    pattern,
    preconditions: preconditions ?? [],
    tags: tags ?? [],
    sourceProject: process.cwd(),
    sourceFiles: [],
  });

  return ok({
    status: 'ok',
    skillId: skill.id,
    name: skill.name,
    message: 'Skill stored successfully.',
  });
}

async function handleStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(StatusSchema, args);
  if (!v.success) return v.error;

  try {
    const tracker = await getOrCreateEffectivenessTracker();
    tracker.recordToolCall('apex_status');

    const mgr = await getOrCreateManager();
    const stats = await mgr.status();
    const stalenessStats = mgr.stalenessStats();

    // Phase 7: Include global store stats
    let globalStats: Record<string, unknown> = {};
    try {
      const gsm = await getOrCreateGlobalStore();
      const globalSkills = await gsm.listGlobalSkills();
      const profile = await gsm.getProfile();
      const projects = await gsm.listRegisteredProjects();
      globalStats = {
        globalSkills: globalSkills.length,
        registeredProjects: projects.length,
        totalEpisodes: profile.totalEpisodes,
        learningVelocity: profile.learningVelocity,
      };
    } catch {
      // Global store not yet initialised — fine
    }

    // Phase 8: Include effectiveness metrics
    let effectiveness: Record<string, unknown> = {};
    try {
      const report = await tracker.getReport();
      await tracker.persist();
      effectiveness = {
        currentSession: {
          sessionId: report.currentSession.sessionId,
          durationMs: report.currentSession.durationMs,
          totalCalls: report.currentSession.totalCalls,
          toolCalls: report.currentSession.toolCalls,
          recallHitRate: report.currentSession.recallHitRate,
        },
        pastSessionCount: report.pastSessionCount,
        suggestions: report.suggestions,
      };
    } catch {
      // Effectiveness tracker not ready — fine
    }

    // Phase 22: Include memory bounds / usage report
    let memoryUsage: Record<string, unknown> = {};
    try {
      const usageReport = await mgr.getMemoryUsage();
      memoryUsage = {
        tiers: usageReport.tiers,
        totalFileSizeMB: usageReport.totalFileSizeMB,
        alerts: usageReport.alerts,
      };
    } catch {
      // Memory usage report failed — non-critical
    }

    return ok({
      status: 'ok',
      tool: 'apex_status',
      memory: {
        working: stats.working,
        episodic: stats.episodic,
        semantic: stats.semantic,
        procedural: stats.procedural,
      },
      memoryUsage,
      snapshots: stats.snapshots,
      staleness: stalenessStats,
      global: globalStats,
      effectiveness,
    });
  } catch {
    // Fall back to basic status if manager not initialised
    return ok({
      status: 'ok',
      tool: 'apex_status',
      memory: {
        episodes: 0,
        reflections: { micro: 0, meso: 0, macro: 0 },
        skills: 0,
        snapshots: 0,
      },
      message: 'APEX is running. Run apex_setup to initialise the memory system.',
    });
  }
}

async function handleConsolidate(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ConsolidateSchema, args);
  if (!v.success) return v.error;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_consolidate');

  const mgr = await getOrCreateManager();
  const report = await mgr.consolidate();

  return ok({
    status: 'ok',
    report: {
      timestamp: new Date(report.timestamp).toISOString(),
      movedToEpisodic: report.movedToEpisodic,
      movedToSemantic: report.movedToSemantic,
      evicted: report.evicted,
      merged: report.merged,
    },
  });
}

async function handleCurriculum(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(CurriculumSchema, args);
  if (!v.success) return v.error;
  const { domain } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_curriculum');

  const root = process.cwd();
  const mgr = await getOrCreateManager(root);

  const store = new FileStore(getProjectDataPath(root));
  await store.init();

  if (!curriculumGenerator) {
    curriculumGenerator = new CurriculumGenerator({ fileStore: store, logger });
  }

  const episodes = await store.readAll<Episode>('episodes');
  const skills = await mgr.listSkills();

  const suggestions = curriculumGenerator.suggest(episodes, skills, {
    domain,
    count: 3,
  });

  return ok({
    status: 'ok',
    suggestions,
  });
}

async function handleSetup(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(SetupSchema, args);
  if (!v.success) return v.error;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_setup');

  const projectPath = v.data.projectPath ?? process.cwd();
  const dataPath = getProjectDataPath(projectPath);
  const globalPath = getGlobalDataPath();

  // Initialise project data store
  const projectStore = new FileStore(dataPath);
  await projectStore.init();

  // Initialise global store
  const globalStore = new FileStore(globalPath);
  await globalStore.init();

  // Scan project for profile
  const profile = await scanProject(projectPath);

  // Save project config
  await projectStore.write('', 'config', {
    projectPath,
    profile,
    createdAt: new Date().toISOString(),
    version: '0.1.0',
  });

  // Create/update memory manager
  memoryManager = new MemoryManager({
    projectDataPath: dataPath,
    globalDataPath: globalPath,
    projectPath,
    logger,
  });
  await memoryManager.init();

  // Phase 7: Register project in global store and similarity index
  const gsm = await getOrCreateGlobalStore();
  await gsm.registerProject(projectPath, profile.name);

  const idx = await getOrCreateProjectIndex();
  const fingerprint = await idx.upsertFingerprint(profile);
  const similarProjects = await idx.findSimilar(profile, 3);

  // Set current project on cross-project query for tech-stack boosting
  const cpq = await getOrCreateCrossProjectQuery(projectPath);
  cpq.setCurrentProject(profile);

  return ok({
    status: 'ok',
    projectPath,
    dataPath,
    globalPath,
    profile: {
      name: profile.name,
      type: profile.type,
      techStack: profile.techStack,
      dependencies: profile.dependencies.length,
    },
    similarProjects: similarProjects.map((s) => ({
      name: s.fingerprint.projectName,
      path: s.fingerprint.projectPath,
      similarity: Math.round(s.overallScore * 1000) / 1000,
    })),
    message: 'APEX initialised successfully.',
  });
}

async function handleSnapshot(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(SnapshotSchema, args);
  if (!v.success) return v.error;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_snapshot');

  const mgr = await getOrCreateManager();
  const name = v.data.name;
  const snapshot = await mgr.createSnapshot(name);

  return ok({
    status: 'ok',
    snapshotId: snapshot.id,
    name: snapshot.name,
    timestamp: new Date(snapshot.timestamp).toISOString(),
    tierSizes: snapshot.tierSizes,
  });
}

async function handleRollback(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(RollbackSchema, args);
  if (!v.success) return v.error;
  const { snapshotId: rawSnapshotId, latest } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_rollback');

  const mgr = await getOrCreateManager();
  const snapshotId = latest ? 'latest' : rawSnapshotId;
  if (!snapshotId) return fail('Provide snapshotId or set latest: true');

  const snapshot = await mgr.rollback(snapshotId);

  return ok({
    status: 'ok',
    restoredSnapshot: snapshot.id,
    name: snapshot.name,
    timestamp: new Date(snapshot.timestamp).toISOString(),
    tierSizes: snapshot.tierSizes,
  });
}

async function handlePromote(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(PromoteSchema, args);
  if (!v.success) return v.error;
  const { skillId } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_promote');

  const root = process.cwd();
  const projectStore = new FileStore(getProjectDataPath(root));
  await projectStore.init();
  const globalStore = new FileStore(getGlobalDataPath());
  await globalStore.init();

  const pipeline = new SkillPromotionPipeline({
    projectStore,
    globalStore,
    logger,
  });

  const projectName = path.basename(root);
  const result = await pipeline.manualPromote(skillId, root, projectName);

  if (!result.promoted) {
    return fail(result.reason);
  }

  // Also register in global store manager
  const gsm = await getOrCreateGlobalStore();
  await gsm.registerProject(root, projectName);

  return ok({
    status: 'ok',
    skillId: result.skillId,
    globalSkillId: result.globalSkillId,
    name: result.skillName,
    message: result.reason,
  });
}

async function handleImport(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ImportSchema, args);
  if (!v.success) return v.error;
  const { source } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_import');

  const root = process.cwd();
  const targetStore = new FileStore(getProjectDataPath(root));
  await targetStore.init();

  const strategy = 'skip-duplicates' as const;

  // Check if source is a JSON bundle file or a project path
  const sourcePath = path.resolve(source);

  const portability = new PortabilityManager({
    projectStore: targetStore,
    projectName: path.basename(root),
    projectPath: root,
    logger,
  });

  const result = await portability.importFromProject(sourcePath, targetStore, strategy);

  return ok({
    status: 'ok',
    source: sourcePath,
    strategy,
    total: result.total,
    imported: result.imported,
    skipped: result.skipped,
    conflicts: result.conflicts.length,
    errors: result.errors,
    message: `Imported ${result.imported} skills from ${sourcePath} (${result.skipped} skipped, ${result.conflicts.length} conflicts).`,
  });
}

// ---------------------------------------------------------------------------
// Foresight handlers
// ---------------------------------------------------------------------------

async function getOrCreateForesightEngine(projectPath?: string): Promise<ForesightEngine> {
  if (foresightEngine) return foresightEngine;
  const root = projectPath ?? process.cwd();
  const store = new FileStore(getProjectDataPath(root));
  await store.init();
  foresightEngine = new ForesightEngine({
    fileStore: store,
    logger,
    onSurpriseTriggered: async (predictionId, surpriseScore) => {
      logger.info('Surprise threshold exceeded — auto-reflection recommended', {
        predictionId,
        surpriseScore,
      });
    },
  });
  return foresightEngine;
}

async function handleForesightPredict(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ForesightPredictSchema, args);
  if (!v.success) return v.error;
  const { taskId, predictedSuccess, expectedDuration, expectedSteps, riskFactors, confidence } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_foresight_predict');

  const engine = await getOrCreateForesightEngine();
  const prediction = await engine.predict({
    taskId,
    predictedSuccess,
    expectedDuration,
    expectedSteps,
    riskFactors: riskFactors ?? [],
    confidence: confidence ?? 0.5,
  });

  return ok({
    status: 'ok',
    predictionId: prediction.id,
    taskId: prediction.taskId,
    predictedSuccess: prediction.predictedOutcome.success,
    confidence: prediction.predictedOutcome.confidence,
    message: 'Prediction recorded. Use apex_foresight_check during execution and apex_foresight_resolve after completion.',
  });
}

async function handleForesightCheck(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ForesightCheckSchema, args);
  if (!v.success) return v.error;
  const { predictionId, stepIndex, stepSuccess, elapsedMs, completedSteps, stepDescription } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_foresight_check');

  const engine = await getOrCreateForesightEngine();

  try {
    const signal = await engine.check({
      predictionId,
      stepIndex,
      stepSuccess,
      elapsedMs,
      completedSteps,
      stepDescription: stepDescription ?? undefined,
    });

    return ok({
      status: 'ok',
      predictionId,
      stepIndex: signal.stepIndex,
      divergenceScore: Math.round(signal.divergenceScore * 1000) / 1000,
      recommendation: signal.recommendation,
      reason: signal.reason,
    });
  } catch (err) {
    return fail((err as Error).message);
  }
}

async function handleForesightResolve(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ForesightResolveSchema, args);
  if (!v.success) return v.error;
  const { predictionId, actualOutcome, episodeId } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_foresight_resolve');

  const engine = await getOrCreateForesightEngine();

  try {
    const result = await engine.resolve({
      predictionId,
      actualOutcome: {
        success: actualOutcome.success,
        description: actualOutcome.description,
        errorType: actualOutcome.errorType,
        duration: actualOutcome.duration,
      },
      episodeId: episodeId ?? undefined,
    });

    return ok({
      status: 'ok',
      predictionId,
      surpriseScore: Math.round(result.prediction.surpriseScore! * 1000) / 1000,
      surpriseTriggered: result.surpriseTriggered,
      breakdown: result.breakdown,
      adaptationSignalCount: result.prediction.adaptationSignals.length,
      message: result.surpriseTriggered
        ? 'High surprise detected — consider running apex_reflect_store with a micro-level reflection.'
        : 'Outcome was within expected range.',
    });
  } catch (err) {
    return fail((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Multi-agent population handlers
// ---------------------------------------------------------------------------

async function getOrCreatePopulation(projectPath?: string): Promise<AgentPopulation> {
  if (agentPopulation) return agentPopulation;
  const root = projectPath ?? process.cwd();
  agentPopulation = new AgentPopulation({
    dataDir: getProjectDataPath(root),
    logger,
  });
  const loaded = await agentPopulation.load();
  if (!loaded) {
    await agentPopulation.initialize();
  }
  return agentPopulation;
}

async function handlePopulationStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(PopulationStatusSchema, args);
  if (!v.success) return v.error;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_population_status');

  const pop = await getOrCreatePopulation();
  const status = pop.getStatus();

  return ok({
    status: 'ok',
    population: {
      size: status.size,
      generation: status.generation,
      competitiveResults: status.competitiveResults,
      config: status.config,
      agents: status.agents,
    },
  });
}

async function handlePopulationEvolve(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(PopulationEvolveSchema, args);
  if (!v.success) return v.error;
  const { taskId, taskDomain, taskReward, taskSuccess } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_population_evolve');

  const pop = await getOrCreatePopulation();

  // If task details are provided, run a competitive evaluation first
  if (taskId) {
    if (!taskDomain || taskReward === undefined || taskSuccess === undefined) {
      return fail('When taskId is provided, taskDomain, taskReward, and taskSuccess are also required');
    }

    // Get skill IDs from the skill library
    const mgr = await getOrCreateManager();
    const allSkills = await mgr.listSkills();
    const skillIds = allSkills.map((s) => s.id);

    pop.evaluateCompetitively(taskId, taskDomain, skillIds, taskReward, taskSuccess);
  }

  // Get available skills for cross-pollination
  const mgr = await getOrCreateManager();
  const availableSkills = await mgr.listSkills();

  const result = await pop.evolve(availableSkills);

  return ok({
    status: 'ok',
    generation: result.generation,
    eliteCount: result.eliteIds.length,
    bredCount: result.bredIds.length,
    skillTransfers: result.skillTransfers,
    mutations: result.mutations,
    fitness: result.fitnessSummary,
  });
}

// ---------------------------------------------------------------------------
// Tool creation handlers
// ---------------------------------------------------------------------------

async function getOrCreateToolFactory(projectPath?: string): Promise<ToolFactory> {
  if (toolFactory) return toolFactory;
  const root = projectPath ?? process.cwd();
  const store = new FileStore(getProjectDataPath(root));
  await store.init();
  toolFactory = new ToolFactory({ fileStore: store, logger });
  return toolFactory;
}

async function handleToolPropose(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ToolProposeSchema, args);
  if (!v.success) return v.error;
  const { minFrequency, minSuccessRate } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_tool_propose');

  const root = process.cwd();
  const store = new FileStore(getProjectDataPath(root));
  await store.init();

  const factory = await getOrCreateToolFactory(root);
  const episodes = await store.readAll<Episode>('episodes');

  if (episodes.length === 0) {
    return ok({
      status: 'ok',
      proposedCount: 0,
      tools: [],
      message: 'No episodes found. Record some episodes first with apex_record.',
    });
  }

  // Create a temporary factory with custom thresholds if provided
  let factoryToUse = factory;
  if (minFrequency !== undefined || minSuccessRate !== undefined) {
    factoryToUse = new ToolFactory({
      fileStore: store,
      minFrequency,
      minSuccessRate,
      logger,
    });
  }

  const proposed = factoryToUse.proposeTools(episodes);

  // Save all proposed tools
  for (const tool of proposed) {
    await factory.saveTool(tool);
  }

  return ok({
    status: 'ok',
    proposedCount: proposed.length,
    episodesAnalysed: episodes.length,
    tools: proposed.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      parameterCount: t.inputSchema.parameters.length,
      sourceEpisodeCount: t.sourceEpisodes.length,
      verificationStatus: t.verificationStatus,
    })),
    message: proposed.length > 0
      ? `Proposed ${proposed.length} tools. Use apex_tool_verify to verify them.`
      : 'No recurring patterns found meeting the frequency/success-rate thresholds.',
  });
}

async function handleToolVerify(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ToolVerifySchema, args);
  if (!v.success) return v.error;
  const { toolId } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_tool_verify');

  const factory = await getOrCreateToolFactory();
  const tool = await factory.loadTool(toolId);

  if (!tool) {
    return fail(`Tool not found: ${toolId}`);
  }

  const verified = factory.verify(tool);
  await factory.saveTool(verified);

  return ok({
    status: 'ok',
    toolId: verified.id,
    name: verified.name,
    verificationStatus: verified.verificationStatus,
    verificationScore: Math.round(verified.verificationScore * 1000) / 1000,
    message: `Tool ${verified.name} is now ${verified.verificationStatus} (score: ${Math.round(verified.verificationScore * 100)}%).`,
  });
}

async function handleToolList(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ToolListSchema, args);
  if (!v.success) return v.error;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_tool_list');

  const factory = await getOrCreateToolFactory();
  const status = v.data.status as ToolDefinitionApex['verificationStatus'] | undefined;
  const tools = await factory.listTools(status);
  const compositions = await factory.listCompositions();

  return ok({
    status: 'ok',
    toolCount: tools.length,
    compositionCount: compositions.length,
    tools: tools.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      verificationStatus: t.verificationStatus,
      verificationScore: Math.round(t.verificationScore * 1000) / 1000,
      masteryMetrics: {
        usageCount: t.masteryMetrics.usageCount,
        successRate: Math.round(t.masteryMetrics.successRate * 1000) / 1000,
        avgDuration: Math.round(t.masteryMetrics.avgDuration),
        failureContextCount: t.masteryMetrics.failureContexts.length,
      },
      tags: t.tags,
    })),
    compositions: compositions.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      stepCount: c.steps.length,
      successRate: Math.round(c.successRate * 1000) / 1000,
      usageCount: c.usageCount,
    })),
  });
}

async function handleToolCompose(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ToolComposeSchema, args);
  if (!v.success) return v.error;
  const { toolIds: requestedIds } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_tool_compose');

  const root = process.cwd();
  const store = new FileStore(getProjectDataPath(root));
  await store.init();

  const factory = await getOrCreateToolFactory(root);
  const episodes = await store.readAll<Episode>('episodes');
  const tools = await factory.listTools('verified');

  if (tools.length < 2) {
    return ok({
      status: 'ok',
      compositionCount: 0,
      compositions: [],
      message: 'Need at least 2 verified tools to detect compositions. Verify more tools first.',
    });
  }
  const toolsToCompose = requestedIds
    ? tools.filter((t) => requestedIds.includes(t.id))
    : tools;

  const compositions = factory.composeTools(toolsToCompose, episodes);

  for (const comp of compositions) {
    await factory.saveComposition(comp);
  }

  return ok({
    status: 'ok',
    compositionCount: compositions.length,
    compositions: compositions.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      stepCount: c.steps.length,
      successRate: Math.round(c.successRate * 1000) / 1000,
      usageCount: c.usageCount,
    })),
    message: compositions.length > 0
      ? `Created ${compositions.length} composite tools from detected pipelines.`
      : 'No recurring tool chains detected in recent episodes.',
  });
}

// ---------------------------------------------------------------------------
// Architecture search handlers
// ---------------------------------------------------------------------------

async function getOrCreateArchitectureSearch(projectPath?: string): Promise<ArchitectureSearch> {
  if (architectureSearch) return architectureSearch;
  const root = projectPath ?? process.cwd();
  architectureSearch = new ArchitectureSearch({
    dataDir: getProjectDataPath(root),
    logger,
  });
  const loaded = await architectureSearch.load();
  if (!loaded) {
    await architectureSearch.initialize();
  }
  return architectureSearch;
}

async function getOrCreateTelemetrySubsystems(projectPath?: string): Promise<{
  telemetry: TelemetryCollector;
  detector: EpisodeDetector;
  rewards: ImplicitRewardEngine;
}> {
  const root = projectPath ?? process.cwd();
  const store = new FileStore(getProjectDataPath(root));
  await store.init();

  if (!telemetryCollector) {
    telemetryCollector = new TelemetryCollector({ fileStore: store, logger });
  }
  if (!episodeDetector) {
    episodeDetector = new EpisodeDetector({ logger });
  }
  if (!implicitRewardEngine) {
    implicitRewardEngine = new ImplicitRewardEngine({ fileStore: store, logger });
  }

  return { telemetry: telemetryCollector, detector: episodeDetector, rewards: implicitRewardEngine };
}

async function getOrCreateWorldModelSubsystems(projectPath?: string): Promise<{
  model: WorldModel;
  counterfactual: CounterfactualEngine;
}> {
  const root = projectPath ?? process.cwd();
  const store = new FileStore(getProjectDataPath(root));
  await store.init();

  if (!worldModel) {
    worldModel = new WorldModel({ fileStore: store, logger });
    await worldModel.load();
  }
  if (!counterfactualEngine) {
    counterfactualEngine = new CounterfactualEngine({ logger });
  }

  return { model: worldModel, counterfactual: counterfactualEngine };
}

async function getOrCreateTeamSubsystems(projectPath?: string): Promise<{
  tier: KnowledgeTier;
  proposals: ProposalManager;
  federation: FederationEngine;
}> {
  const root = projectPath ?? process.cwd();

  if (!knowledgeTier) {
    knowledgeTier = new KnowledgeTier({ projectPath: root, logger });
    await knowledgeTier.init();
  }
  if (!proposalManager) {
    proposalManager = new ProposalManager({ knowledgeTier, logger });
  }
  if (!federationEngine) {
    federationEngine = new FederationEngine({ knowledgeTier, logger });
  }

  return { tier: knowledgeTier, proposals: proposalManager, federation: federationEngine };
}

async function handleArchStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ArchStatusSchema, args);
  if (!v.success) return v.error;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_arch_status');

  const search = await getOrCreateArchitectureSearch();
  const status = search.getStatus();
  const currentConfig = search.getCurrentConfig();
  const bestConfig = search.getBestConfig();
  const ranked = search.getRankedConfigs();

  return ok({
    status: 'ok',
    currentConfig: {
      id: currentConfig.id,
      generation: currentConfig.generation,
      subsystemFlags: currentConfig.subsystemFlags,
      reflectionFrequency: currentConfig.reflectionFrequency,
      consolidationFrequency: currentConfig.consolidationFrequency,
      performanceWindow: currentConfig.performanceWindow,
      explorationRate: currentConfig.agentConfig.explorationRate,
      memoryLimits: currentConfig.agentConfig.memoryLimits,
      consolidationThreshold: currentConfig.agentConfig.consolidationThreshold,
    },
    bestConfig: bestConfig ? {
      id: bestConfig.config.id,
      score: Math.round(bestConfig.score * 1000) / 1000,
      generation: bestConfig.config.generation,
    } : null,
    search: {
      generation: status.generation,
      searchesRemaining: status.searchesRemaining,
      totalConfigs: status.totalConfigs,
      totalPerformanceRecords: status.totalPerformanceRecords,
    },
    rankedConfigs: ranked.slice(0, 5).map((r) => ({
      configId: r.configId,
      score: Math.round(r.score * 1000) / 1000,
      generation: r.generation,
    })),
  });
}

async function handleArchMutate(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ArchMutateSchema, args);
  if (!v.success) return v.error;
  const { mutationType, biased: rawBiased } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_arch_mutate');

  const search = await getOrCreateArchitectureSearch();
  const biased = rawBiased ?? false;

  const result = biased
    ? search.sampleBiased()
    : search.mutate(mutationType as Parameters<typeof search.mutate>[0]);

  if (!result.applied) {
    return ok({
      status: 'ok',
      applied: false,
      reason: result.reason,
    });
  }

  await search.save();

  return ok({
    status: 'ok',
    applied: true,
    newConfigId: result.config.id,
    generation: result.config.generation,
    mutation: {
      type: result.mutation.type,
      description: result.mutation.description,
      parameter: result.mutation.parameter,
      previousValue: result.mutation.previousValue,
      newValue: result.mutation.newValue,
    },
    message: `Config mutated: ${result.mutation.description}. Use apex_arch_status to see the full new config.`,
  });
}

async function handleArchSuggest(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(ArchSuggestSchema, args);
  if (!v.success) return v.error;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_arch_suggest');

  const search = await getOrCreateArchitectureSearch();

  // Check rollback
  const rollback = search.checkRollback();

  // Generate prompt suggestions from effectiveness tracker data
  let promptSuggestions: unknown[] = [];
  try {
    const report = await tracker.getReport();
    const toolUsage = {
      callCounts: report.currentSession.toolCalls,
      successRates: {} as Record<string, number>,
      totalEpisodes: report.currentSession.totalCalls,
    };

    // Compute success rates from recall hit rate as a proxy
    if (report.currentSession.recallHitRate !== undefined && report.currentSession.recallHitRate !== null) {
      toolUsage.successRates['apex_recall'] = report.currentSession.recallHitRate;
    }

    promptSuggestions = search.generatePromptSuggestions(toolUsage);
  } catch {
    // Effectiveness tracker not ready — skip prompt suggestions
  }

  return ok({
    status: 'ok',
    rollback: {
      shouldRollback: rollback.shouldRollback,
      targetConfigId: rollback.targetConfigId,
      currentScore: Math.round(rollback.currentScore * 1000) / 1000,
      targetScore: rollback.targetScore !== undefined ? Math.round(rollback.targetScore * 1000) / 1000 : undefined,
      reason: rollback.reason,
    },
    promptSuggestions,
    message: rollback.shouldRollback
      ? `Performance degradation detected. Consider rolling back to config ${rollback.targetConfigId}.`
      : 'Architecture performing within acceptable range.',
  });
}

// ── 28. apex_prompt_optimize ──────────────────────────────────────

async function handlePromptOptimize(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(PromptOptimizeSchema, args);
  if (!v.success) return v.error;
  const { action } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_prompt_optimize');

  const { registry, abManager, optimizer, detector } = await getOrCreatePromptSubsystems();

  if (action === 'status') {
    const modules = registry.listModules();
    const experiments = abManager.getReport();
    const mutationStats = optimizer.getMutationStats();
    const regressionReport = detector.getReport();

    return ok({
      status: 'ok',
      modules: modules.map((m) => ({
        name: m.name,
        category: m.category,
        version: m.version,
        metrics: m.metrics,
        variantCount: m.variants.length,
        activeVariant: m.activeVariantId,
      })),
      experiments,
      mutationStats,
      regressionReport,
    });
  }

  if (action === 'conclude-experiments') {
    const results = await abManager.autoEvaluate();
    await abManager.persist();
    return ok({
      status: 'ok',
      concluded: results.length,
      results: results.map((r) => ({
        experimentId: r.experimentId,
        winner: r.winner,
        significant: r.significant,
        pValue: Math.round(r.pValue * 10000) / 10000,
        liftPercent: Math.round(r.liftPercent * 100) / 100,
      })),
    });
  }

  // action === 'optimize'
  const modules = registry.listModules();
  const moduleInputs = modules.map((m) => ({
    name: m.name,
    content: registry.getActiveContent(m.name) ?? m.content,
    metrics: {
      successRate: m.metrics.successRate,
      avgReward: m.metrics.avgReward,
      exposures: m.metrics.totalExposures,
    },
  }));

  const round = await optimizer.runOptimizationRound(moduleInputs);
  const suggestions = optimizer.getSuggestions();

  // Record performance snapshots for regression detection
  for (const mod of modules) {
    await detector.recordSnapshot({
      moduleName: mod.name,
      metrics: {
        successRate: mod.metrics.successRate,
        avgReward: mod.metrics.avgReward,
        recallHitRate: mod.metrics.successRate, // proxy
        avgLatency: 0,
        sampleSize: mod.metrics.totalExposures,
      },
      changeDescription: `optimization round ${round.id}`,
    });
  }

  await optimizer.persist();
  await detector.persist();

  return ok({
    status: 'ok',
    round: {
      id: round.id,
      mutationCount: round.mutations.length,
      baselineScore: Math.round(round.baselineScore * 1000) / 1000,
      mutations: round.mutations.map((m) => ({
        moduleName: m.moduleName,
        type: m.mutationType,
        expectedImpact: Math.round(m.expectedImpact * 1000) / 1000,
        preview: m.mutatedText.slice(0, 100) + (m.mutatedText.length > 100 ? '...' : ''),
      })),
    },
    suggestions: suggestions.slice(0, 5),
    regressionAlerts: detector.getAlerts({ severity: 'critical' }),
  });
}

// ── 29. apex_prompt_module ───────────────────────────────────────

async function handlePromptModule(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(PromptModuleSchema, args);
  if (!v.success) return v.error;
  const { action, name, category, content, mutationType } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_prompt_module');

  const { registry, curator } = await getOrCreatePromptSubsystems();

  if (action === 'list') {
    const modules = registry.listModules();
    return ok({
      status: 'ok',
      count: modules.length,
      modules: modules.map((m) => ({
        name: m.name,
        category: m.category,
        version: m.version,
        activeVariant: m.activeVariantId,
        metrics: m.metrics,
      })),
    });
  }

  if (action === 'register') {
    if (!name || !category || !content) {
      return fail('register requires name, category, and content');
    }
    const mod = await registry.register({ name, category, content });
    await registry.persist();
    return ok({ status: 'ok', module: { id: mod.id, name: mod.name, category: mod.category, version: mod.version } });
  }

  if (action === 'get') {
    if (!name) return fail('get requires name');
    const activeContent = registry.getActiveContent(name);
    const metrics = registry.getMetrics(name);
    if (!activeContent) return fail(`module "${name}" not found`);
    return ok({ status: 'ok', name, content: activeContent, metrics });
  }

  if (action === 'hot-swap') {
    if (!name || !content) return fail('hot-swap requires name and content');
    await registry.hotSwap(name, content);
    await registry.persist();
    return ok({ status: 'ok', message: `Module "${name}" hot-swapped successfully` });
  }

  if (action === 'add-variant') {
    if (!name || !content) return fail('add-variant requires name and content');
    const mt = mutationType ?? 'rephrase';
    const variant = await registry.addVariant(name, content, mt);
    await registry.persist();
    return ok({ status: 'ok', variant: { id: variant.id, mutationType: variant.mutationType } });
  }

  if (action === 'examples') {
    if (!name) return fail('examples requires name (tool name)');
    const examples = curator.getExamplesForTool(name);
    const formatted = curator.formatForInjection(name);
    const stats = curator.getStats();
    return ok({ status: 'ok', toolName: name, examples, formatted, stats });
  }

  return fail(`unknown action: ${action}`);
}

// ── 30. apex_goals ───────────────────────────────────────────────

async function handleGoals(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(GoalsSchema, args);
  if (!v.success) return v.error;
  const { action, goalId, description, priority, parentId, deadline, context, tags, query, cascade } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_goals');

  const { goals } = await getOrCreateCognitiveSubsystems();

  if (action === 'add') {
    if (!description) return fail('add requires description');
    const goal = await goals.addGoal({ description, priority, parentId, deadline, context, tags });
    await goals.persist();
    return ok({ status: 'ok', goal });
  }

  if (action === 'list') {
    const summary = goals.getSummary();
    return ok({ status: 'ok', summary });
  }

  if (action === 'get') {
    if (!goalId) return fail('get requires goalId');
    const goal = goals.getGoal(goalId);
    if (!goal) return fail(`goal "${goalId}" not found`);
    const subGoals = goals.getSubGoals(goalId);
    return ok({ status: 'ok', goal, subGoals });
  }

  if (action === 'update') {
    if (!goalId) return fail('update requires goalId');
    const updates: Record<string, unknown> = {};
    if (description !== undefined) updates.description = description;
    if (priority !== undefined) updates.priority = priority;
    if (deadline !== undefined) updates.deadline = deadline;
    if (context !== undefined) updates.context = context;
    if (tags !== undefined) updates.tags = tags;
    const goal = await goals.updateGoal(goalId, updates);
    if (!goal) return fail(`goal "${goalId}" not found`);
    await goals.persist();
    return ok({ status: 'ok', goal });
  }

  if (action === 'complete') {
    if (!goalId) return fail('complete requires goalId');
    const goal = await goals.completeGoal(goalId);
    if (!goal) return fail(`goal "${goalId}" not found`);
    await goals.persist();
    return ok({ status: 'ok', goal });
  }

  if (action === 'block') {
    if (!goalId) return fail('block requires goalId');
    const goal = await goals.blockGoal(goalId, context);
    if (!goal) return fail(`goal "${goalId}" not found`);
    await goals.persist();
    return ok({ status: 'ok', goal });
  }

  if (action === 'abandon') {
    if (!goalId) return fail('abandon requires goalId');
    const goal = await goals.abandonGoal(goalId, cascade);
    if (!goal) return fail(`goal "${goalId}" not found`);
    await goals.persist();
    return ok({ status: 'ok', goal });
  }

  if (action === 'search') {
    if (!query) return fail('search requires query');
    const results = goals.searchGoals(query);
    return ok({ status: 'ok', results });
  }

  return fail(`unknown action: ${action}`);
}

// ── 31. apex_cognitive_status ────────────────────────────────────

async function handleCognitiveStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(CognitiveStatusSchema, args);
  if (!v.success) return v.error;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_cognitive_status');

  const { activation, cycle, goals, rules } = await getOrCreateCognitiveSubsystems();

  return ok({
    status: 'ok',
    cognitivePhase: {
      current: cycle.getCurrentPhase(),
      quality: Math.round(cycle.getCycleQuality() * 100) / 100,
      metrics: cycle.getMetrics(),
      context: cycle.getPhaseContext(),
      suggestedNext: cycle.suggestNextPhase(),
    },
    activation: activation.getStats(),
    goals: goals.getSummary(),
    productionRules: rules.getStats(),
  });
}

// ── 32. apex_self_benchmark ────────────────────────────────────────

async function handleSelfBenchmark(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(SelfBenchmarkSchema, args);
  if (!v.success) return v.error;
  const { action, baselineId, candidateId, seedCount } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_self_benchmark');

  const { benchmark } = await getOrCreateSelfImprovementSubsystems();

  if (action === 'run') {
    const mgr = await getOrCreateManager();
    const stats = await mgr.status();
    const store = new FileStore(getProjectDataPath(process.cwd()));
    await store.init();

    // Gather data from memory tiers
    const episodes = await store.readAll<Episode>('episodes');
    const reflections = await store.readAll<Reflection>('reflections');
    const skills = await store.readAll<any>('skills');

    const config = stats as unknown as Record<string, unknown>;
    const result = await benchmark.runSuite(
      Object.values(episodes),
      Object.values(reflections),
      Object.values(skills),
      config,
    );

    return ok({
      status: 'ok',
      benchmarkResult: {
        id: result.id,
        generation: result.generation,
        compositeScore: Math.round(result.compositeScore * 1000) / 1000,
        dimensions: result.dimensionScores.map((d) => ({
          dimension: d.dimension,
          score: Math.round(d.score * 1000) / 1000,
          details: d.details,
        })),
      },
    });
  }

  if (action === 'history') {
    const history = await benchmark.getHistory();
    return ok({
      status: 'ok',
      history: history.map((r) => ({
        id: r.id,
        generation: r.generation,
        compositeScore: Math.round(r.compositeScore * 1000) / 1000,
        timestamp: new Date(r.timestamp).toISOString(),
      })),
    });
  }

  if (action === 'compare') {
    if (!baselineId || !candidateId) {
      return fail('compare requires baselineId and candidateId');
    }
    const comparison = await benchmark.compareBenchmarks(baselineId, candidateId);
    return ok({ status: 'ok', comparison });
  }

  if (action === 'seed') {
    const count = seedCount ?? 20;
    const episodes = await benchmark.seedSyntheticData(count);

    // Record them via direct file store write (same pattern as handleRecord)
    const store2 = new FileStore(getProjectDataPath(process.cwd()));
    await store2.init();
    for (const ep of episodes) {
      await store2.write('episodes', ep.id, ep);
    }

    return ok({
      status: 'ok',
      seeded: episodes.length,
      message: `Generated and recorded ${episodes.length} synthetic episodes for benchmarking.`,
    });
  }

  return fail(`unknown action: ${action}`);
}

// ── 33. apex_self_modify ───────────────────────────────────────────

async function handleSelfModify(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(SelfModifySchema, args);
  if (!v.success) return v.error;
  const { action, benchmarkId, proposalId, baselineBenchmarkId, candidateBenchmarkId } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_self_modify');

  const { benchmark, modifier } = await getOrCreateSelfImprovementSubsystems();

  if (action === 'analyze') {
    if (!benchmarkId) return fail('analyze requires benchmarkId');
    const history = await benchmark.getHistory();
    const result = history.find((r) => r.id === benchmarkId);
    if (!result) return fail(`benchmark result ${benchmarkId} not found`);

    const proposals = await modifier.analyzeWeakSpots(result);
    return ok({
      status: 'ok',
      proposals: proposals.map((p) => ({
        id: p.id,
        target: p.target,
        currentValue: p.currentValue,
        proposedValue: p.proposedValue,
        expectedImpact: `${p.expectedImpact.toFixed(1)}%`,
        rationale: p.rationale,
        weakDimension: p.weakDimension,
      })),
    });
  }

  if (action === 'evaluate') {
    if (!proposalId || !baselineBenchmarkId || !candidateBenchmarkId) {
      return fail('evaluate requires proposalId, baselineBenchmarkId, and candidateBenchmarkId');
    }
    const history = await benchmark.getHistory();
    const baseline = history.find((r) => r.id === baselineBenchmarkId);
    const candidate = history.find((r) => r.id === candidateBenchmarkId);
    if (!baseline) return fail(`baseline benchmark ${baselineBenchmarkId} not found`);
    if (!candidate) return fail(`candidate benchmark ${candidateBenchmarkId} not found`);

    const proposals = await modifier.getProposalHistory();
    const proposal = proposals.find((p) => p.id === proposalId);
    if (!proposal) return fail(`proposal ${proposalId} not found`);

    const result = await modifier.evaluateProposal(proposal, baseline, candidate);
    return ok({
      status: 'ok',
      result: {
        applied: result.applied,
        improvement: `${result.improvement.toFixed(1)}%`,
        rolledBack: result.rolledBack,
        reason: result.reason,
        dimensionDeltas: result.dimensionDeltas,
      },
    });
  }

  if (action === 'history') {
    const modifications = await modifier.getModificationHistory();
    return ok({
      status: 'ok',
      modifications: modifications.map((m) => ({
        id: m.id,
        proposalId: m.proposalId,
        applied: m.applied,
        improvement: `${m.improvement.toFixed(1)}%`,
        rolledBack: m.rolledBack,
        reason: m.reason,
        timestamp: new Date(m.timestamp).toISOString(),
      })),
    });
  }

  if (action === 'rollback-check') {
    const history = await benchmark.getHistory();
    if (history.length < 2) {
      return ok({ status: 'ok', message: 'Not enough benchmark history for rollback check', shouldRollback: false });
    }
    const current = history[0];
    const best = history.reduce((a, b) => (a.compositeScore > b.compositeScore ? a : b));
    const decision = await modifier.autoRollbackCheck(current, best, history.length);
    return ok({ status: 'ok', decision });
  }

  if (action === 'stats') {
    const stats = await modifier.getStats();
    return ok({ status: 'ok', stats });
  }

  return fail(`unknown action: ${action}`);
}

// ── 34. apex_telemetry ─────────────────────────────────────────────

async function handleTelemetry(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(TelemetrySchema, args);
  if (!v.success) return v.error;
  const { action, limit } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_telemetry');

  const { telemetry, detector, rewards } = await getOrCreateTelemetrySubsystems();

  if (action === 'summary') {
    const summary = telemetry.getSummary();
    return ok({
      status: 'ok',
      summary: {
        sessionId: summary.sessionId,
        durationMs: summary.durationMs,
        totalEvents: summary.totalEvents,
        toolSequence: summary.toolSequence.slice(-(limit ?? 20)),
        errorsEncountered: summary.errorsEncountered,
        peakCallRate: Math.round(summary.peakCallRate * 10) / 10,
        toolStats: summary.toolStats.slice(0, limit ?? 10),
      },
    });
  }

  if (action === 'events') {
    const events = telemetry.getRecentEvents(limit ?? 20);
    return ok({
      status: 'ok',
      events: events.map((e) => ({
        toolName: e.toolName,
        success: e.success,
        durationMs: e.durationMs,
        timestamp: new Date(e.timestamp).toISOString(),
        resultSummary: e.resultSummary,
      })),
    });
  }

  if (action === 'episodes') {
    const events = telemetry.getRecentEvents();
    const detected = detector.detect(events);
    return ok({
      status: 'ok',
      detectedEpisodes: detected.slice(0, limit ?? 10).map((ep) => ({
        id: ep.id,
        rule: ep.ruleName,
        task: ep.task,
        success: ep.success,
        confidence: Math.round(ep.confidence * 100) / 100,
        eventCount: ep.events.length,
        timestamp: new Date(ep.timestamp).toISOString(),
      })),
    });
  }

  if (action === 'rewards') {
    const signals = rewards.getSignals();
    const recent = signals.slice(-(limit ?? 20));
    return ok({
      status: 'ok',
      rewards: [...recent].reverse().map((s) => ({
        type: s.type,
        source: s.source,
        magnitude: s.magnitude,
        toolName: s.toolName,
        description: s.description,
        timestamp: new Date(s.timestamp).toISOString(),
      })),
    });
  }

  if (action === 'flush') {
    await telemetry.flush();
    await rewards.flush(telemetry.getSummary().sessionId);
    return ok({
      status: 'ok',
      message: 'Telemetry and reward signals flushed to disk.',
    });
  }

  return fail(`unknown action: ${action}`);
}

// ── 35. apex_world_model ───────────────────────────────────────────

async function handleWorldModel(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(WorldModelSchema, args);
  if (!v.success) return v.error;
  const { action, planSteps, planSteps2, episodeId, query, limit } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_world_model');

  const { model, counterfactual } = await getOrCreateWorldModelSubsystems();

  if (action === 'build') {
    const store = new FileStore(getProjectDataPath(process.cwd()));
    await store.init();
    const episodeData = await store.readAll<Episode>('episodes');
    const episodes = Object.values(episodeData);
    model.ingestEpisodes(episodes);
    await model.save();
    const stats = model.getStats();
    return ok({
      status: 'ok',
      message: `World model built from ${episodes.length} episodes.`,
      stats,
    });
  }

  if (action === 'predict') {
    if (!planSteps || planSteps.length === 0) {
      return fail('predict requires planSteps array');
    }
    const prediction = model.predictPlan(planSteps);
    return ok({
      status: 'ok',
      prediction: {
        steps: prediction.steps.map((s) => ({
          actionType: s.actionType,
          predictedSuccessRate: Math.round(s.predictedSuccessRate * 100) / 100,
          riskLevel: s.riskLevel,
        })),
        overallSuccessRate: Math.round(prediction.overallSuccessRate * 100) / 100,
        highRiskSteps: prediction.highRiskSteps,
        confidence: Math.round(prediction.confidence * 100) / 100,
      },
    });
  }

  if (action === 'chains') {
    const allChains = query
      ? model.getRelevantChains(query)
      : model.getChains();
    const chains = allChains.slice(0, limit ?? 10);
    return ok({
      status: 'ok',
      chains: chains.map((c) => ({
        id: c.id,
        steps: c.steps.map((s) => s.actionType),
        frequency: c.frequency,
        confidence: Math.round(c.confidence * 100) / 100,
        length: c.length,
      })),
    });
  }

  if (action === 'counterfactual') {
    if (!episodeId) return fail('counterfactual requires episodeId');
    const store = new FileStore(getProjectDataPath(process.cwd()));
    await store.init();
    const episode = await store.read<Episode>('episodes', episodeId);
    if (!episode) return fail(`episode ${episodeId} not found`);

    const analysis = counterfactual.analyze(episode, model);
    return ok({
      status: 'ok',
      analysis: {
        episodeId: analysis.episodeId,
        task: analysis.task,
        originalSuccessRate: Math.round(analysis.originalSuccessRate * 100) / 100,
        scenarioCount: analysis.scenarios.length,
        bestAlternative: analysis.bestAlternative
          ? {
              step: analysis.bestAlternative.stepIndex,
              original: analysis.bestAlternative.originalAction,
              alternative: analysis.bestAlternative.alternativeAction,
              improvement: `${analysis.bestAlternative.predictedOutcome.improvement.toFixed(1)}%`,
            }
          : null,
      },
    });
  }

  if (action === 'compare') {
    if (!planSteps || !planSteps2) {
      return fail('compare requires planSteps and planSteps2');
    }
    const comparison = counterfactual.compareStrategies(planSteps, planSteps2, model);
    return ok({
      status: 'ok',
      comparison: {
        plan1SuccessRate: Math.round(comparison.plan1Prediction.overallSuccessRate * 100) / 100,
        plan2SuccessRate: Math.round(comparison.plan2Prediction.overallSuccessRate * 100) / 100,
        recommendation: comparison.recommendation,
        improvementPercent: Math.round(comparison.improvementPercent * 10) / 10,
      },
    });
  }

  if (action === 'stats') {
    const stats = model.getStats();
    return ok({ status: 'ok', stats });
  }

  return fail(`unknown action: ${action}`);
}

// ── 36. apex_team_propose ──────────────────────────────────────────

async function handleTeamPropose(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(TeamProposeSchema, args);
  if (!v.success) return v.error;
  const { title, description, category, content, tags, confidence } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_team_propose');

  const { proposals } = await getOrCreateTeamSubsystems();
  const proposal = await proposals.propose({
    title,
    description,
    category,
    content,
    author: 'current-user',
    sourceProject: process.cwd(),
    tags: tags ?? [],
    confidence: confidence ?? 0.7,
  });

  return ok({
    status: 'ok',
    proposal: {
      id: proposal.id,
      title: proposal.title,
      category: proposal.category,
      status: proposal.status,
      createdAt: new Date(proposal.createdAt).toISOString(),
    },
  });
}

// ── 37. apex_team_review ───────────────────────────────────────────

async function handleTeamReview(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(TeamReviewSchema, args);
  if (!v.success) return v.error;
  const { proposalId, decision, comment } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_team_review');

  const { proposals } = await getOrCreateTeamSubsystems();
  const updated = await proposals.review(proposalId, decision, 'current-reviewer', comment);

  return ok({
    status: 'ok',
    proposal: {
      id: updated.id,
      title: updated.title,
      status: updated.status,
      reviewedBy: updated.reviewedBy,
      reviewComment: updated.reviewComment,
    },
  });
}

// ── 38. apex_team_status ───────────────────────────────────────────

async function handleTeamStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(TeamStatusSchema, args);
  if (!v.success) return v.error;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_team_status');

  const { proposals, federation } = await getOrCreateTeamSubsystems();
  const teamStatus = await proposals.getTeamStatus();
  const metrics = await federation.computeMetrics();

  return ok({
    status: 'ok',
    team: {
      proposals: {
        pending: teamStatus.pendingProposals,
        accepted: teamStatus.acceptedProposals,
        rejected: teamStatus.rejectedProposals,
        total: teamStatus.totalProposals,
      },
      leaderboard: metrics.leaderboard.slice(0, 5),
      topSkillTags: metrics.topSkillTags.slice(0, 10),
      avgConfidence: Math.round(metrics.avgTeamConfidence * 100) / 100,
      totalContributions: metrics.totalContributions,
      recentActivity: teamStatus.recentActivity.slice(0, 5),
    },
  });
}

// ── 39. apex_team_sync ─────────────────────────────────────────────

async function handleTeamSync(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(TeamSyncSchema, args);
  if (!v.success) return v.error;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_team_sync');

  const { proposals } = await getOrCreateTeamSubsystems();
  const syncResult = await proposals.sync();

  return ok({
    status: 'ok',
    sync: {
      totalEntries: syncResult.newEntries,
      categories: syncResult.categories,
      message: `Team knowledge base contains ${syncResult.newEntries} shared entries.`,
    },
  });
}

// ── 40. apex_team_log ──────────────────────────────────────────────

async function handleTeamLog(args: Record<string, unknown>): Promise<CallToolResult> {
  const v = validateArgs(TeamLogSchema, args);
  if (!v.success) return v.error;
  const { limit } = v.data;

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_team_log');

  const { proposals } = await getOrCreateTeamSubsystems();
  const log = await proposals.getLog(limit ?? 20);

  return ok({
    status: 'ok',
    changelog: log.map((entry) => ({
      ...entry,
      timestamp: new Date(entry.timestamp).toISOString(),
    })),
  });
}

// ── Exported handler map ──────────────────────────────────────────

export const handlers = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>([
  ['apex_recall', handleRecall],
  ['apex_record', handleRecord],
  ['apex_reflect_get', handleReflectGet],
  ['apex_reflect_store', handleReflectStore],
  ['apex_plan_context', handlePlanContext],
  ['apex_skills', handleSkills],
  ['apex_skill_store', handleSkillStore],
  ['apex_status', handleStatus],
  ['apex_consolidate', handleConsolidate],
  ['apex_curriculum', handleCurriculum],
  ['apex_setup', handleSetup],
  ['apex_snapshot', handleSnapshot],
  ['apex_rollback', handleRollback],
  ['apex_promote', handlePromote],
  ['apex_import', handleImport],
  ['apex_foresight_predict', handleForesightPredict],
  ['apex_foresight_check', handleForesightCheck],
  ['apex_foresight_resolve', handleForesightResolve],
  ['apex_population_status', handlePopulationStatus],
  ['apex_population_evolve', handlePopulationEvolve],
  ['apex_tool_propose', handleToolPropose],
  ['apex_tool_verify', handleToolVerify],
  ['apex_tool_list', handleToolList],
  ['apex_tool_compose', handleToolCompose],
  ['apex_arch_status', handleArchStatus],
  ['apex_arch_mutate', handleArchMutate],
  ['apex_arch_suggest', handleArchSuggest],
  ['apex_prompt_optimize', handlePromptOptimize],
  ['apex_prompt_module', handlePromptModule],
  ['apex_goals', handleGoals],
  ['apex_cognitive_status', handleCognitiveStatus],
  ['apex_self_benchmark', handleSelfBenchmark],
  ['apex_self_modify', handleSelfModify],
  ['apex_telemetry', handleTelemetry],
  ['apex_world_model', handleWorldModel],
  ['apex_team_propose', handleTeamPropose],
  ['apex_team_review', handleTeamReview],
  ['apex_team_status', handleTeamStatus],
  ['apex_team_sync', handleTeamSync],
  ['apex_team_log', handleTeamLog],
]);
