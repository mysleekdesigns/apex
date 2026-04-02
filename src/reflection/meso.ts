/**
 * Meso-level reflection data assembler for APEX.
 *
 * Groups episodes by task type / similarity, retrieves cross-attempt data,
 * includes existing error taxonomy, and formats episode clusters for
 * pattern detection. Claude does the reasoning; this module provides the data.
 */

import type { Episode, Reflection } from '../types.js';
import type { FileStore } from '../utils/file-store.js';
import { getEmbedding, type EmbeddingResult } from '../utils/embeddings.js';
import { combinedSimilarity } from '../utils/similarity.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Input parameters for a meso-level reflection assembly.
 */
export interface MesoReflectionInput {
  /** Task description or type to analyze across episodes. */
  taskQuery: string;
  /** Max episodes to include (default 20). */
  limit?: number;
}

/**
 * A cluster of episodes with similar tasks.
 */
export interface EpisodeCluster {
  /** Representative task description for this cluster. */
  representativeTask: string;
  /** Episodes grouped into this cluster. */
  episodes: Array<{
    id: string;
    task: string;
    success: boolean;
    errorType?: string;
    reward: number;
    actionCount: number;
    timestamp: number;
  }>;
  /** Success rate within this cluster (0-1). */
  successRate: number;
  /** Common error types observed in this cluster. */
  commonErrorTypes: string[];
}

/**
 * Assembled data for meso-level reflection.
 *
 * Contains clustered episodes, aggregate statistics, existing error taxonomy,
 * and a prompt-ready analysis request for Claude to reason over.
 */
export interface MesoReflectionData {
  level: 'meso';
  /** The task query used to retrieve episodes. */
  taskQuery: string;
  /** Grouped episode clusters ordered by size (largest first). */
  clusters: EpisodeCluster[];
  /** Overall statistics across all matched episodes. */
  stats: {
    totalEpisodes: number;
    successRate: number;
    uniqueErrorTypes: string[];
    avgReward: number;
  };
  /** Existing error taxonomy from prior reflections. */
  existingTaxonomy: Array<{ errorType: string; count: number; insights: string[] }>;
  /** Prompt-ready analysis request for Claude. */
  analysisPrompt: string;
}

/**
 * Options for constructing a {@link MesoAssembler}.
 */
export interface MesoAssemblerOptions {
  /** FileStore instance for reading episodes and reflections. */
  fileStore: FileStore;
  /** Optional logger. */
  logger?: Logger;
  /** Similarity threshold for grouping episodes into clusters (default 0.4). */
  clusterThreshold?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Summarise an episode into the compact cluster-member shape. */
function summariseEpisode(ep: Episode) {
  return {
    id: ep.id,
    task: ep.task,
    success: ep.outcome.success,
    errorType: ep.outcome.errorType,
    reward: ep.reward,
    actionCount: ep.actions.length,
    timestamp: ep.timestamp,
  };
}

/** Compute the success rate for a list of episodes. */
function successRate(episodes: Array<{ success: boolean }>): number {
  if (episodes.length === 0) return 0;
  const wins = episodes.filter((e) => e.success).length;
  return wins / episodes.length;
}

/** Collect error types from a list of episodes, ordered by frequency. */
function collectErrorTypes(episodes: Array<{ errorType?: string }>): string[] {
  const freq = new Map<string, number>();
  for (const ep of episodes) {
    if (ep.errorType) {
      freq.set(ep.errorType, (freq.get(ep.errorType) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
}

// ---------------------------------------------------------------------------
// MesoAssembler
// ---------------------------------------------------------------------------

/**
 * Assembles meso-level reflection data by grouping episodes by task similarity,
 * building error taxonomy from prior reflections, and formatting the result
 * for Claude to analyze.
 */
export class MesoAssembler {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly clusterThreshold: number;

  constructor(options: MesoAssemblerOptions) {
    this.fileStore = options.fileStore;
    this.logger = options.logger ?? new Logger({ prefix: 'apex:meso' });
    this.clusterThreshold = options.clusterThreshold ?? 0.4;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Assemble meso-level reflection data for a given task query.
   *
   * 1. Loads all episodes and computes similarity to the query.
   * 2. Keeps the top `limit` most-relevant episodes.
   * 3. Clusters them by mutual task similarity.
   * 4. Loads existing error taxonomy from prior reflections.
   * 5. Produces a prompt-ready data packet for Claude.
   */
  async assemble(input: MesoReflectionInput): Promise<MesoReflectionData> {
    const limit = input.limit ?? 20;
    this.logger.info('Assembling meso reflection', { taskQuery: input.taskQuery, limit });

    // 1. Load & score episodes
    const allEpisodes = await this.fileStore.readAll<Episode>('episodes');
    this.logger.debug(`Loaded ${allEpisodes.length} episodes from store`);

    const queryEmbedding = getEmbedding(input.taskQuery);
    const scored = this.scoreEpisodes(allEpisodes, queryEmbedding);

    // 2. Take top-N relevant episodes
    const relevant = scored.slice(0, limit);
    this.logger.info(`Selected ${relevant.length} relevant episodes`);

    if (relevant.length === 0) {
      return this.emptyResult(input.taskQuery);
    }

    // 3. Cluster by mutual task similarity
    const clusters = this.clusterEpisodes(relevant);
    this.logger.info(`Formed ${clusters.length} episode clusters`);

    // 4. Build existing error taxonomy from reflections
    const existingTaxonomy = await this.buildErrorTaxonomy();

    // 5. Compute aggregate stats
    const summaries = relevant.map((r) => summariseEpisode(r.episode));
    const stats = {
      totalEpisodes: summaries.length,
      successRate: successRate(summaries),
      uniqueErrorTypes: collectErrorTypes(summaries),
      avgReward: summaries.reduce((sum, s) => sum + s.reward, 0) / summaries.length,
    };

    // 6. Build analysis prompt
    const analysisPrompt = this.buildAnalysisPrompt(input.taskQuery, clusters, stats, existingTaxonomy);

    return {
      level: 'meso',
      taskQuery: input.taskQuery,
      clusters,
      stats,
      existingTaxonomy,
      analysisPrompt,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Score all episodes against the query embedding, filter out low-relevance
   * episodes (below half the cluster threshold), and sort descending by score.
   */
  private scoreEpisodes(
    episodes: Episode[],
    queryEmbedding: EmbeddingResult,
  ): Array<{ episode: Episode; embedding: EmbeddingResult; score: number }> {
    const minScore = this.clusterThreshold / 2;

    return episodes
      .map((episode) => {
        const embedding = getEmbedding(episode.task);
        const score = combinedSimilarity(queryEmbedding, embedding);
        return { episode, embedding, score };
      })
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Greedy clustering: iterate through scored episodes, assigning each to the
   * first cluster whose representative is sufficiently similar, or creating a
   * new cluster otherwise.
   */
  private clusterEpisodes(
    scored: Array<{ episode: Episode; embedding: EmbeddingResult; score: number }>,
  ): EpisodeCluster[] {
    const clusters: Array<{
      repEmbedding: EmbeddingResult;
      repTask: string;
      members: Array<{ episode: Episode }>;
    }> = [];

    for (const item of scored) {
      let assigned = false;

      for (const cluster of clusters) {
        const sim = combinedSimilarity(item.embedding, cluster.repEmbedding);
        if (sim >= this.clusterThreshold) {
          cluster.members.push({ episode: item.episode });
          assigned = true;
          break;
        }
      }

      if (!assigned) {
        clusters.push({
          repEmbedding: item.embedding,
          repTask: item.episode.task,
          members: [{ episode: item.episode }],
        });
      }
    }

    // Convert to public shape, sorted by cluster size descending
    return clusters
      .map((c) => {
        const summaries = c.members.map((m) => summariseEpisode(m.episode));
        return {
          representativeTask: c.repTask,
          episodes: summaries,
          successRate: successRate(summaries),
          commonErrorTypes: collectErrorTypes(summaries),
        } satisfies EpisodeCluster;
      })
      .sort((a, b) => b.episodes.length - a.episodes.length);
  }

  /**
   * Build an error taxonomy from all existing reflections.
   *
   * Aggregates `errorTypes` and `actionableInsights` from every stored
   * reflection, counting occurrences and collecting associated insights.
   */
  private async buildErrorTaxonomy(): Promise<
    Array<{ errorType: string; count: number; insights: string[] }>
  > {
    const reflections = await this.fileStore.readAll<Reflection>('reflections');
    const taxonomy = new Map<string, { count: number; insights: Set<string> }>();

    for (const ref of reflections) {
      for (const errType of ref.errorTypes) {
        const entry = taxonomy.get(errType) ?? { count: 0, insights: new Set<string>() };
        entry.count += 1;

        // Associate actionable insights from this reflection with the error type
        for (const insight of ref.actionableInsights) {
          entry.insights.add(insight);
        }

        taxonomy.set(errType, entry);
      }
    }

    return [...taxonomy.entries()]
      .map(([errorType, { count, insights }]) => ({
        errorType,
        count,
        insights: [...insights],
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Generate the analysis prompt that guides Claude to detect patterns,
   * extend the error taxonomy, and produce actionable feedback.
   */
  private buildAnalysisPrompt(
    taskQuery: string,
    clusters: EpisodeCluster[],
    stats: MesoReflectionData['stats'],
    taxonomy: MesoReflectionData['existingTaxonomy'],
  ): string {
    const clusterSummaries = clusters
      .map((c, i) => {
        const successes = c.episodes.filter((e) => e.success).length;
        const failures = c.episodes.length - successes;
        const errors = c.commonErrorTypes.length > 0
          ? `Errors: ${c.commonErrorTypes.join(', ')}`
          : 'No errors recorded';
        return `  Cluster ${i + 1}: "${c.representativeTask}" (${c.episodes.length} episodes, ${successes} success / ${failures} failure. ${errors})`;
      })
      .join('\n');

    const taxonomySummary = taxonomy.length > 0
      ? taxonomy
          .map((t) => `  - ${t.errorType} (seen ${t.count}x): ${t.insights.slice(0, 3).join('; ')}`)
          .join('\n')
      : '  (none yet)';

    return [
      `Analyze the following meso-level reflection data for task type: "${taskQuery}"`,
      '',
      `Overall: ${stats.totalEpisodes} episodes, ${(stats.successRate * 100).toFixed(1)}% success rate, avg reward ${stats.avgReward.toFixed(2)}`,
      `Unique error types: ${stats.uniqueErrorTypes.length > 0 ? stats.uniqueErrorTypes.join(', ') : 'none'}`,
      '',
      'Episode clusters:',
      clusterSummaries,
      '',
      'Existing error taxonomy:',
      taxonomySummary,
      '',
      'Please provide:',
      '1. Cross-attempt patterns: What strategies consistently succeed or fail?',
      '2. Error taxonomy updates: New error categories or refinements to existing ones.',
      '3. Improvement strategies: Concrete, actionable recommendations for this task type.',
      '4. Confidence assessment: How confident are you in these findings given the data volume?',
    ].join('\n');
  }

  /**
   * Return an empty result when no relevant episodes are found.
   */
  private emptyResult(taskQuery: string): MesoReflectionData {
    return {
      level: 'meso',
      taskQuery,
      clusters: [],
      stats: {
        totalEpisodes: 0,
        successRate: 0,
        uniqueErrorTypes: [],
        avgReward: 0,
      },
      existingTaxonomy: [],
      analysisPrompt: `No episodes found matching task type: "${taskQuery}". Record some episodes first, then re-run meso reflection.`,
    };
  }
}
