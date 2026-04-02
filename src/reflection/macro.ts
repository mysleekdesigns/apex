/**
 * Macro-Level Reflection Data Assembler
 *
 * Clusters episodes by error-type tags (from stored reflections and episode
 * outcomes), retrieves cross-task episode groups sharing failure patterns,
 * and formats clustered data so Claude can extract transferable insights.
 *
 * This module is a **data assembler** — it gathers and structures information
 * but performs no reasoning itself. Claude does the reasoning using the
 * `analysisPrompt` included in the output.
 */

import { type Episode, type Reflection } from '../types.js';
import { type FileStore } from '../utils/file-store.js';
import { type Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Input parameters for macro-level reflection assembly.
 */
export interface MacroReflectionInput {
  /** Optional: focus on specific error types. If omitted, analyze all. */
  errorTypes?: string[];

  /** Max episodes per error-type cluster (default 10). */
  limitPerCluster?: number;
}

/**
 * A cluster of episodes grouped by a shared error type.
 */
export interface ErrorCluster {
  /** The error type label. */
  errorType: string;

  /** Episodes that exhibited this error type. */
  episodes: Array<{
    id: string;
    task: string;
    errorDescription: string;
    reward: number;
    timestamp: number;
  }>;

  /** Existing reflections about this error type. */
  priorReflections: Array<{
    id: string;
    level: string;
    insights: string[];
    confidence: number;
  }>;

  /** Diversity: how many distinct task types share this error. */
  taskDiversity: number;
}

/**
 * Assembled macro-reflection data ready for Claude's analysis.
 */
export interface MacroReflectionData {
  level: 'macro';

  /** Error-type clusters. */
  clusters: ErrorCluster[];

  /** Cross-cutting patterns (error types that co-occur). */
  coOccurrences: Array<{ errorTypes: string[]; episodeCount: number }>;

  /** Overall stats. */
  stats: {
    totalErrorTypes: number;
    totalFailedEpisodes: number;
    mostCommonError: string | null;
    avgClusterSize: number;
  };

  /** Prompt-ready analysis request. */
  analysisPrompt: string;
}

/**
 * Constructor options for {@link MacroAssembler}.
 */
export interface MacroAssemblerOptions {
  /** The file store instance to read episodes and reflections from. */
  fileStore: FileStore;

  /** Optional logger. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a coarse "task type" from a task description.
 *
 * Uses the first meaningful segment of the task string so that episodes
 * with similar high-level goals are grouped together for diversity counting.
 */
function taskTypeKey(task: string): string {
  // Normalise whitespace and lowercase, then take the first 60 chars.
  return task.trim().toLowerCase().slice(0, 60);
}

/**
 * Build a deterministic key for a set of error types (for co-occurrence
 * deduplication).  Sorts alphabetically and joins with `|`.
 */
function coOccurrenceKey(types: string[]): string {
  return [...types].sort().join('|');
}

// ---------------------------------------------------------------------------
// MacroAssembler
// ---------------------------------------------------------------------------

/**
 * Assembles macro-level reflection data by clustering episodes around shared
 * error types and detecting cross-cutting failure patterns.
 *
 * Usage:
 * ```ts
 * const assembler = new MacroAssembler({ fileStore, logger });
 * const data = await assembler.assemble({ errorTypes: ['type-error'] });
 * // → hand data.analysisPrompt + data to Claude for reasoning
 * ```
 */
export class MacroAssembler {
  private readonly fileStore: FileStore;
  private readonly logger?: Logger;

  constructor(options: MacroAssemblerOptions) {
    this.fileStore = options.fileStore;
    this.logger = options.logger;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Assemble macro-level reflection data.
   *
   * @param input - Optional filters and limits.
   * @returns Structured data containing error clusters, co-occurrences,
   *   stats, and a prompt for Claude to reason over.
   */
  async assemble(input: MacroReflectionInput = {}): Promise<MacroReflectionData> {
    const limitPerCluster = input.limitPerCluster ?? 10;

    this.logger?.info('Macro assembler: loading reflections and episodes');

    // Load all reflections and episodes in parallel.
    const [reflections, episodes] = await Promise.all([
      this.fileStore.readAll<Reflection>('reflections'),
      this.fileStore.readAll<Episode>('episodes'),
    ]);

    this.logger?.debug('Macro assembler: loaded data', {
      reflections: reflections.length,
      episodes: episodes.length,
    });

    // Index episodes by ID for fast lookup.
    const episodeById = new Map<string, Episode>();
    for (const ep of episodes) {
      episodeById.set(ep.id, ep);
    }

    // -----------------------------------------------------------------
    // Step 1: Build error-type → episode-id mapping from reflections
    // -----------------------------------------------------------------

    /** Maps errorType → Set<episodeId>. */
    const errorToEpisodeIds = new Map<string, Set<string>>();

    /** Maps errorType → relevant Reflection[]. */
    const errorToReflections = new Map<string, Reflection[]>();

    for (const ref of reflections) {
      for (const errorType of ref.errorTypes) {
        // Track reflections per error type.
        if (!errorToReflections.has(errorType)) {
          errorToReflections.set(errorType, []);
        }
        errorToReflections.get(errorType)!.push(ref);

        // Map error type → episode IDs via the reflection's sourceEpisodes.
        if (!errorToEpisodeIds.has(errorType)) {
          errorToEpisodeIds.set(errorType, new Set());
        }
        const idSet = errorToEpisodeIds.get(errorType)!;
        for (const epId of ref.sourceEpisodes) {
          idSet.add(epId);
        }
      }
    }

    // -----------------------------------------------------------------
    // Step 2: Also scan episodes directly for outcome.errorType
    //         (catches episodes not yet reflected on)
    // -----------------------------------------------------------------

    for (const ep of episodes) {
      if (ep.outcome.errorType) {
        const errorType = ep.outcome.errorType;
        if (!errorToEpisodeIds.has(errorType)) {
          errorToEpisodeIds.set(errorType, new Set());
        }
        errorToEpisodeIds.get(errorType)!.add(ep.id);
      }
    }

    // -----------------------------------------------------------------
    // Step 3: Filter to requested error types (if specified)
    // -----------------------------------------------------------------

    let targetErrorTypes: string[];

    if (input.errorTypes && input.errorTypes.length > 0) {
      targetErrorTypes = input.errorTypes.filter((et) => errorToEpisodeIds.has(et));
    } else {
      targetErrorTypes = [...errorToEpisodeIds.keys()];
    }

    // -----------------------------------------------------------------
    // Step 4: Build ErrorCluster for each error type
    // -----------------------------------------------------------------

    const clusters: ErrorCluster[] = [];
    /** Track per-episode error types for co-occurrence detection. */
    const episodeErrorTypes = new Map<string, Set<string>>();

    for (const errorType of targetErrorTypes) {
      const epIds = errorToEpisodeIds.get(errorType) ?? new Set<string>();

      // Resolve episodes (skip missing ones).
      const resolvedEpisodes: Episode[] = [];
      for (const id of epIds) {
        const ep = episodeById.get(id);
        if (ep) resolvedEpisodes.push(ep);
      }

      // Sort by timestamp descending (most recent first), then limit.
      resolvedEpisodes.sort((a, b) => b.timestamp - a.timestamp);
      const limited = resolvedEpisodes.slice(0, limitPerCluster);

      // Map episode data for output.
      const clusterEpisodes = limited.map((ep) => ({
        id: ep.id,
        task: ep.task,
        errorDescription: ep.outcome.description,
        reward: ep.reward,
        timestamp: ep.timestamp,
      }));

      // Gather prior reflections for this error type.
      const refs = errorToReflections.get(errorType) ?? [];
      const priorReflections = refs.map((ref) => ({
        id: ref.id,
        level: ref.level,
        insights: ref.actionableInsights,
        confidence: ref.confidence,
      }));

      // Compute task diversity — count of distinct task-type keys.
      const taskTypes = new Set(resolvedEpisodes.map((ep) => taskTypeKey(ep.task)));

      clusters.push({
        errorType,
        episodes: clusterEpisodes,
        priorReflections,
        taskDiversity: taskTypes.size,
      });

      // Track per-episode error types for co-occurrence detection.
      for (const id of epIds) {
        if (!episodeErrorTypes.has(id)) {
          episodeErrorTypes.set(id, new Set());
        }
        episodeErrorTypes.get(id)!.add(errorType);
      }
    }

    // Sort clusters by number of episodes descending (most impactful first).
    clusters.sort((a, b) => b.episodes.length - a.episodes.length);

    // -----------------------------------------------------------------
    // Step 5: Detect co-occurring error types
    // -----------------------------------------------------------------

    const coOccurrenceMap = new Map<string, number>();

    for (const [, types] of episodeErrorTypes) {
      if (types.size < 2) continue;
      const key = coOccurrenceKey([...types]);
      coOccurrenceMap.set(key, (coOccurrenceMap.get(key) ?? 0) + 1);
    }

    const coOccurrences = [...coOccurrenceMap.entries()]
      .map(([key, count]) => ({
        errorTypes: key.split('|'),
        episodeCount: count,
      }))
      .sort((a, b) => b.episodeCount - a.episodeCount);

    // -----------------------------------------------------------------
    // Step 6: Compute stats
    // -----------------------------------------------------------------

    const totalFailedEpisodes = new Set<string>();
    for (const [, ids] of errorToEpisodeIds) {
      for (const id of ids) {
        totalFailedEpisodes.add(id);
      }
    }

    const mostCommonError =
      clusters.length > 0 ? clusters[0].errorType : null;

    const avgClusterSize =
      clusters.length > 0
        ? clusters.reduce((sum, c) => sum + c.episodes.length, 0) / clusters.length
        : 0;

    const stats = {
      totalErrorTypes: targetErrorTypes.length,
      totalFailedEpisodes: totalFailedEpisodes.size,
      mostCommonError,
      avgClusterSize: Math.round(avgClusterSize * 100) / 100,
    };

    // -----------------------------------------------------------------
    // Step 7: Generate analysis prompt
    // -----------------------------------------------------------------

    const analysisPrompt = this.buildAnalysisPrompt(clusters, coOccurrences, stats);

    this.logger?.info('Macro assembler: complete', {
      clusters: clusters.length,
      coOccurrences: coOccurrences.length,
      totalFailedEpisodes: stats.totalFailedEpisodes,
    });

    return {
      level: 'macro',
      clusters,
      coOccurrences,
      stats,
      analysisPrompt,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build a structured prompt that guides Claude to extract transferable
   * strategies from the assembled macro-reflection data.
   */
  private buildAnalysisPrompt(
    clusters: ErrorCluster[],
    coOccurrences: Array<{ errorTypes: string[]; episodeCount: number }>,
    stats: { totalErrorTypes: number; totalFailedEpisodes: number; mostCommonError: string | null; avgClusterSize: number },
  ): string {
    const lines: string[] = [];

    lines.push('## Macro-Level Reflection Analysis');
    lines.push('');
    lines.push('You are reviewing cross-task failure patterns to extract transferable strategies.');
    lines.push(`There are ${stats.totalErrorTypes} distinct error types across ${stats.totalFailedEpisodes} failed episodes.`);

    if (stats.mostCommonError) {
      lines.push(`The most frequent error type is "${stats.mostCommonError}".`);
    }

    lines.push('');
    lines.push('### Error Clusters');
    lines.push('');

    for (const cluster of clusters) {
      lines.push(`**${cluster.errorType}** — ${cluster.episodes.length} episodes across ${cluster.taskDiversity} distinct task types`);

      if (cluster.priorReflections.length > 0) {
        const insights = cluster.priorReflections.flatMap((r) => r.insights);
        if (insights.length > 0) {
          lines.push(`  Prior insights: ${insights.slice(0, 5).join('; ')}`);
        }
      }

      lines.push('');
    }

    if (coOccurrences.length > 0) {
      lines.push('### Co-occurring Error Types');
      lines.push('');
      for (const co of coOccurrences.slice(0, 10)) {
        lines.push(`- [${co.errorTypes.join(', ')}] — ${co.episodeCount} episodes`);
      }
      lines.push('');
    }

    lines.push('### Requested Analysis');
    lines.push('');
    lines.push('For each error cluster, provide:');
    lines.push('1. **Root cause hypothesis** — what systemic issue likely causes this error across different tasks?');
    lines.push('2. **Transferable prevention strategy** — a concrete, reusable approach to avoid this error in future tasks.');
    lines.push('3. **Detection heuristic** — how to recognise early in a task that this error pattern is likely to occur.');
    lines.push('');
    lines.push('For co-occurring error types, explain:');
    lines.push('- Why these errors tend to appear together.');
    lines.push('- Whether addressing one would reduce the other.');
    lines.push('');
    lines.push('Conclude with a ranked list of the top 3 highest-impact improvements, considering both frequency and task diversity.');

    return lines.join('\n');
  }
}
