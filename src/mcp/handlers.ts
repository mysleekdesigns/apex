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
import type { ToolDefinitionApex } from '../types.js';

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

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

async function handleRecall(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = args.query as string;
  if (!query) return fail('Missing required parameter: query');

  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_recall');

  const limit = (args.limit as number) ?? 10;
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_record');

  const task = args.task as string;
  if (!task) return fail('Missing required parameter: task');

  const rawActions = (args.actions ?? []) as Array<{
    type: string;
    description: string;
    success: boolean;
  }>;
  const rawOutcome = args.outcome as {
    success: boolean;
    description: string;
    errorType?: string;
    duration: number;
  };
  if (!rawOutcome) return fail('Missing required parameter: outcome');

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

  const reward = (args.reward as number) ?? (outcome.success ? 1.0 : 0.0);

  const episode: Episode = {
    id: generateId(),
    task,
    actions,
    outcome,
    reward,
    timestamp: now,
    sourceFiles: (args.sourceFiles as string[]) ?? undefined,
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_reflect_get');

  const level = args.level as string;
  const coordinator = await getOrCreateReflectionCoordinator();

  if (level === 'micro') {
    const episodeId = args.episodeId as string;
    if (!episodeId) return fail('Missing required parameter: episodeId (for micro-level reflection)');
    const data = await coordinator.getMicroData(episodeId);
    return ok({ status: 'ok', ...data });
  }

  if (level === 'meso') {
    const taskQuery = args.taskQuery as string;
    if (!taskQuery) return fail('Missing required parameter: taskQuery (for meso-level reflection)');
    const limit = (args.limit as number) ?? 20;
    const data = await coordinator.getMesoData(taskQuery, limit);
    return ok({ status: 'ok', ...data });
  }

  if (level === 'macro') {
    const errorTypes = (args.errorTypes as string[]) ?? undefined;
    const limitPerCluster = (args.limitPerCluster as number) ?? undefined;
    const data = await coordinator.getMacroData(errorTypes, limitPerCluster);
    return ok({ status: 'ok', ...data });
  }

  // Fallback: return metrics and unreflected episode count
  const metrics = await coordinator.metrics();
  const unreflected = await coordinator.getUnreflectedEpisodes();
  return ok({
    status: 'ok',
    metrics,
    unreflectedEpisodeCount: unreflected.length,
    hint: 'Specify level: "micro" (+ episodeId), "meso" (+ taskQuery), or "macro" (+ optional errorTypes) for structured reflection data.',
  });
}

async function handleReflectStore(args: Record<string, unknown>): Promise<CallToolResult> {
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_reflect_store');

  const level = args.level as 'micro' | 'meso' | 'macro';
  const content = args.content as string;
  if (!level || !content) return fail('Missing required parameters: level, content');

  const coordinator = await getOrCreateReflectionCoordinator();

  const result = await coordinator.storeReflection({
    level,
    content,
    errorTypes: (args.errorTypes as string[]) ?? undefined,
    actionableInsights: (args.actionableInsights as string[]) ?? undefined,
    sourceEpisodes: (args.sourceEpisodes as string[]) ?? undefined,
    confidence: (args.confidence as number) ?? undefined,
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_plan_context');

  const task = args.task as string;
  if (!task) return fail('Missing required parameter: task');

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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_skills');

  const action = (args.action as string) ?? 'list';
  const limit = (args.limit as number) ?? 20;
  const mgr = await getOrCreateManager();

  if (action === 'search' && args.query) {
    const results = await mgr.searchSkills(args.query as string, limit);
    return ok({
      status: 'ok',
      action: 'search',
      query: args.query,
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_skill_store');

  const name = args.name as string;
  const description = args.description as string;
  const pattern = args.pattern as string;
  if (!name || !description || !pattern) {
    return fail('Missing required parameters: name, description, pattern');
  }

  const mgr = await getOrCreateManager();
  const skill = await mgr.addSkill({
    name,
    description,
    pattern,
    preconditions: (args.preconditions as string[]) ?? [],
    tags: (args.tags as string[]) ?? [],
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

async function handleStatus(_args: Record<string, unknown>): Promise<CallToolResult> {
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

    return ok({
      status: 'ok',
      tool: 'apex_status',
      memory: {
        working: stats.working,
        episodic: stats.episodic,
        semantic: stats.semantic,
        procedural: stats.procedural,
      },
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

async function handleConsolidate(_args: Record<string, unknown>): Promise<CallToolResult> {
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_curriculum');

  const root = (args.projectPath as string) ?? process.cwd();
  const mgr = await getOrCreateManager(root);

  const store = new FileStore(getProjectDataPath(root));
  await store.init();

  if (!curriculumGenerator) {
    curriculumGenerator = new CurriculumGenerator({ fileStore: store, logger });
  }

  const episodes = await store.readAll<Episode>('episodes');
  const skills = await mgr.listSkills();

  const suggestions = curriculumGenerator.suggest(episodes, skills, {
    domain: args.domain as string | undefined,
    count: (args.count as number) ?? 3,
  });

  return ok({
    status: 'ok',
    suggestions,
  });
}

async function handleSetup(args: Record<string, unknown>): Promise<CallToolResult> {
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_setup');

  const projectPath = (args.projectPath as string) ?? process.cwd();
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_snapshot');

  const mgr = await getOrCreateManager();
  const name = args.name as string | undefined;
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_rollback');

  const mgr = await getOrCreateManager();
  const snapshotId = args.latest ? 'latest' : (args.snapshotId as string);
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_promote');

  const skillId = args.skillId as string;
  if (!skillId) return fail('Missing required parameter: skillId');

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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_import');

  const source = args.source as string;
  if (!source) return fail('Missing required parameter: source');

  const root = process.cwd();
  const targetStore = new FileStore(getProjectDataPath(root));
  await targetStore.init();

  const strategy = (args.strategy as 'skip-duplicates' | 'overwrite' | 'keep-higher-confidence') ?? 'skip-duplicates';

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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_foresight_predict');

  const taskId = args.taskId as string;
  const predictedSuccess = args.predictedSuccess as boolean;
  const expectedDuration = args.expectedDuration as number;
  const expectedSteps = args.expectedSteps as number;
  if (!taskId || predictedSuccess === undefined || !expectedDuration || !expectedSteps) {
    return fail('Missing required parameters: taskId, predictedSuccess, expectedDuration, expectedSteps');
  }

  const engine = await getOrCreateForesightEngine();
  const prediction = await engine.predict({
    taskId,
    predictedSuccess,
    expectedDuration,
    expectedSteps,
    riskFactors: (args.riskFactors as string[]) ?? [],
    confidence: (args.confidence as number) ?? 0.5,
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_foresight_check');

  const predictionId = args.predictionId as string;
  const stepIndex = args.stepIndex as number;
  const stepSuccess = args.stepSuccess as boolean;
  const elapsedMs = args.elapsedMs as number;
  const completedSteps = args.completedSteps as number;
  if (!predictionId || stepIndex === undefined || stepSuccess === undefined || !elapsedMs || !completedSteps) {
    return fail('Missing required parameters: predictionId, stepIndex, stepSuccess, elapsedMs, completedSteps');
  }

  const engine = await getOrCreateForesightEngine();

  try {
    const signal = await engine.check({
      predictionId,
      stepIndex,
      stepSuccess,
      elapsedMs,
      completedSteps,
      stepDescription: (args.stepDescription as string) ?? undefined,
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_foresight_resolve');

  const predictionId = args.predictionId as string;
  const rawOutcome = args.actualOutcome as {
    success: boolean;
    description: string;
    errorType?: string;
    duration: number;
  };
  if (!predictionId || !rawOutcome) {
    return fail('Missing required parameters: predictionId, actualOutcome');
  }

  const engine = await getOrCreateForesightEngine();

  try {
    const result = await engine.resolve({
      predictionId,
      actualOutcome: {
        success: rawOutcome.success,
        description: rawOutcome.description,
        errorType: rawOutcome.errorType,
        duration: rawOutcome.duration,
      },
      episodeId: (args.episodeId as string) ?? undefined,
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

async function handlePopulationStatus(_args: Record<string, unknown>): Promise<CallToolResult> {
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_population_evolve');

  const pop = await getOrCreatePopulation();

  // If task details are provided, run a competitive evaluation first
  const taskId = args.taskId as string | undefined;
  if (taskId) {
    const taskDomain = args.taskDomain as string;
    const taskReward = args.taskReward as number;
    const taskSuccess = args.taskSuccess as boolean;
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

  // Allow overriding thresholds per-call
  const minFrequency = (args.minFrequency as number) ?? undefined;
  const minSuccessRate = (args.minSuccessRate as number) ?? undefined;

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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_tool_verify');

  const toolId = args.toolId as string;
  if (!toolId) return fail('Missing required parameter: toolId');

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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_tool_list');

  const factory = await getOrCreateToolFactory();
  const status = args.status as ToolDefinitionApex['verificationStatus'] | undefined;
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

  // If specific tool IDs provided, filter to those
  const requestedIds = args.toolIds as string[] | undefined;
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

async function handleArchStatus(_args: Record<string, unknown>): Promise<CallToolResult> {
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
  const tracker = await getOrCreateEffectivenessTracker();
  tracker.recordToolCall('apex_arch_mutate');

  const search = await getOrCreateArchitectureSearch();
  const biased = (args.biased as boolean) ?? false;
  const mutationType = args.mutationType as string | undefined;

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

async function handleArchSuggest(_args: Record<string, unknown>): Promise<CallToolResult> {
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
]);
