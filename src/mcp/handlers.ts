/**
 * APEX MCP Tool Handlers
 *
 * Connects MCP tool calls to the memory, reflection, and planning subsystems.
 * Handlers that depend on subsystems not yet built (curriculum,
 * evolution) remain stubbed.
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

// ---------------------------------------------------------------------------
// Handler implementations — Phase 2 (memory-backed)
// ---------------------------------------------------------------------------

async function handleRecall(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = args.query as string;
  if (!query) return fail('Missing required parameter: query');

  const limit = (args.limit as number) ?? 10;
  const mgr = await getOrCreateManager();
  const results = await mgr.recall(query, limit);

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
    const mgr = await getOrCreateManager();
    const stats = await mgr.status();
    const stalenessStats = mgr.stalenessStats();

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
  // Phase 5 — curriculum engine not yet built
  return stub('apex_curriculum', args);
}

async function handleSetup(args: Record<string, unknown>): Promise<CallToolResult> {
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
    message: 'APEX initialised successfully.',
  });
}

async function handleSnapshot(args: Record<string, unknown>): Promise<CallToolResult> {
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
  const skillId = args.skillId as string;
  if (!skillId) return fail('Missing required parameter: skillId');

  const mgr = await getOrCreateManager();
  const skill = await mgr.getSkill(skillId);
  if (!skill) return fail(`Skill not found: ${skillId}`);

  // Copy skill to global store
  const globalStore = new FileStore(getGlobalDataPath());
  await globalStore.init();
  await globalStore.write('skills', skill.id, {
    ...skill,
    sourceProject: process.cwd(),
  });

  return ok({
    status: 'ok',
    skillId: skill.id,
    name: skill.name,
    message: `Skill "${skill.name}" promoted to global store.`,
  });
}

async function handleImport(args: Record<string, unknown>): Promise<CallToolResult> {
  const source = args.source as string;
  if (!source) return fail('Missing required parameter: source');

  const sourcePath = path.resolve(source);
  const sourceDataPath = path.join(sourcePath, '.apex-data');
  const sourceStore = new FileStore(sourceDataPath);

  // Read skills from source project
  const skillIds = await sourceStore.list('skills');
  if (skillIds.length === 0) {
    return ok({
      status: 'ok',
      imported: 0,
      message: `No skills found in ${sourcePath}`,
    });
  }

  const mgr = await getOrCreateManager();
  let imported = 0;

  for (const id of skillIds) {
    const skill = await sourceStore.read<Record<string, unknown>>('skills', id);
    if (skill) {
      await mgr.addSkill({
        name: skill.name as string,
        description: skill.description as string,
        pattern: skill.pattern as string,
        preconditions: (skill.preconditions as string[]) ?? [],
        tags: (skill.tags as string[]) ?? [],
        sourceProject: sourcePath,
        sourceFiles: (skill.sourceFiles as string[]) ?? [],
      });
      imported++;
    }
  }

  return ok({
    status: 'ok',
    source: sourcePath,
    imported,
    message: `Imported ${imported} skills from ${sourcePath}.`,
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
]);
