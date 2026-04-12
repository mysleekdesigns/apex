/**
 * APEX Reflection Coordinator
 *
 * Orchestrates the full reflection pipeline: get (assemble data) -> Claude
 * reasons -> store (persist reflection). Tracks which episodes have been
 * reflected on, maintains the taxonomy index, and provides metrics.
 */

import type { Episode } from '../types.js';
import type { FileStore } from '../utils/file-store.js';
import type { SemanticMemory } from '../memory/semantic.js';
import { Logger } from '../utils/logger.js';
import { MicroAssembler, type MicroReflectionData } from './micro.js';
import { MesoAssembler, type MesoReflectionData } from './meso.js';
import { MacroAssembler, type MacroReflectionData } from './macro.js';
import { ReflectionStore, type ReflectionInput, type StoredReflection } from './store.js';
import {
  ReflectionQualityTracker,
  type ReflectionQualityRecord,
  type QualityReport,
} from './quality-tracker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FileStore collection used to track which episodes have been reflected on. */
const TRACKING_COLLECTION = 'reflection-tracking';

/** Key under which the set of reflected episode IDs is persisted. */
const REFLECTED_IDS_KEY = 'reflected-episode-ids';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Aggregated metrics about the reflection system.
 */
export interface ReflectionMetrics {
  /** Total number of stored reflections across all levels. */
  totalReflections: number;

  /** Breakdown of reflections by level. */
  byLevel: { micro: number; meso: number; macro: number };

  /** Number of distinct error types in the taxonomy. */
  taxonomySize: number;

  /** Total actionable insights across all reflections. */
  totalInsights: number;

  /** Average actionable insights per reflection (0 if no reflections). */
  insightDensity: number;

  /** Number of episodes that have at least one associated reflection. */
  reflectedEpisodeCount: number;

  /** Number of episodes that have not yet been reflected on. */
  unreflectedEpisodeCount: number;

  /** Average quality score (if quality tracking data exists). */
  avgQualityScore?: number;

  /** Number of reflections pruned for low quality. */
  prunedReflectionCount?: number;
}

/**
 * Configuration options for the {@link ReflectionCoordinator}.
 */
export interface ReflectionCoordinatorOptions {
  /** Shared file store for persistence. */
  fileStore: FileStore;

  /** Semantic memory instance for reflection storage. */
  semanticMemory: SemanticMemory;

  /** Optional logger instance. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Persisted tracking shape
// ---------------------------------------------------------------------------

/** Shape of the tracking document persisted to FileStore. */
interface ReflectedIdsRecord {
  /** Array of episode IDs that have been reflected on. */
  ids: string[];
}

// ---------------------------------------------------------------------------
// ReflectionCoordinator
// ---------------------------------------------------------------------------

/**
 * Central orchestrator for the APEX reflection engine.
 *
 * Holds instances of the three assemblers (micro, meso, macro) and the
 * reflection store. Provides convenience methods to assemble data at each
 * level, persist reflections, track reflected episodes, and compute metrics.
 */
export class ReflectionCoordinator {
  private readonly micro: MicroAssembler;
  private readonly meso: MesoAssembler;
  private readonly macro: MacroAssembler;
  private readonly store: ReflectionStore;
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly qualityTracker: ReflectionQualityTracker;

  constructor(opts: ReflectionCoordinatorOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:reflection' });

    this.micro = new MicroAssembler({ fileStore: opts.fileStore, logger: this.logger });
    this.meso = new MesoAssembler({ fileStore: opts.fileStore, logger: this.logger });
    this.macro = new MacroAssembler({ fileStore: opts.fileStore, logger: this.logger });
    this.store = new ReflectionStore({ fileStore: opts.fileStore, semanticMemory: opts.semanticMemory, logger: this.logger });
    this.qualityTracker = new ReflectionQualityTracker({ fileStore: opts.fileStore, logger: this.logger });
  }

  // -----------------------------------------------------------------------
  // Data assembly (the "get" half of the pipeline)
  // -----------------------------------------------------------------------

  /**
   * Assemble micro-level reflection data for a single episode.
   *
   * @param episodeId - The episode to reflect on.
   * @returns Assembled data including the failed episode, optional contrastive
   *   episode, prior insights, and an analysis prompt for Claude.
   */
  async getMicroData(episodeId: string): Promise<MicroReflectionData> {
    this.logger.debug('Assembling micro reflection data', { episodeId });
    return this.micro.assemble({ episodeId });
  }

  /**
   * Assemble meso-level reflection data for a cluster of related tasks.
   *
   * @param taskQuery - Free-text query describing the task domain.
   * @param limit     - Maximum number of episodes to include in the cluster.
   * @returns Assembled data including clusters, stats, existing taxonomy, and
   *   an analysis prompt for Claude.
   */
  async getMesoData(taskQuery: string, limit?: number): Promise<MesoReflectionData> {
    this.logger.debug('Assembling meso reflection data', { taskQuery, limit });
    return this.meso.assemble({ taskQuery, limit });
  }

  /**
   * Assemble macro-level reflection data across error clusters.
   *
   * @param errorTypes       - Optional list of error types to focus on.
   * @param limitPerCluster  - Maximum episodes per error cluster.
   * @returns Assembled data including clusters, co-occurrences, stats, and an
   *   analysis prompt for Claude.
   */
  async getMacroData(errorTypes?: string[], limitPerCluster?: number): Promise<MacroReflectionData> {
    this.logger.debug('Assembling macro reflection data', { errorTypes, limitPerCluster });
    return this.macro.assemble({ errorTypes, limitPerCluster });
  }

  // -----------------------------------------------------------------------
  // Storing reflections (the "store" half of the pipeline)
  // -----------------------------------------------------------------------

  /**
   * Persist a reflection and mark its source episodes as reflected.
   *
   * @param input - The reflection content, level, and metadata.
   * @returns The stored reflection record along with dedup and scoring info.
   */
  async storeReflection(input: ReflectionInput): Promise<StoredReflection> {
    this.logger.info('Storing reflection', { level: input.level });

    const result = await this.store.store(input);

    // Mark source episodes as reflected
    if (input.sourceEpisodes && input.sourceEpisodes.length > 0) {
      await this.markReflected(input.sourceEpisodes);
    }

    this.logger.info('Reflection stored', {
      reflectionId: result.reflection.id,
      isDuplicate: result.isDuplicate,
      actionabilityScore: result.actionabilityScore,
    });

    return result;
  }

  // -----------------------------------------------------------------------
  // Episode tracking
  // -----------------------------------------------------------------------

  /**
   * Return the set of episode IDs that have already been reflected on.
   */
  async getReflectedEpisodeIds(): Promise<Set<string>> {
    const record = await this.fileStore.read<ReflectedIdsRecord>(
      TRACKING_COLLECTION,
      REFLECTED_IDS_KEY,
    );
    return new Set(record?.ids ?? []);
  }

  /**
   * Return all episodes that have *not* yet been reflected on.
   */
  async getUnreflectedEpisodes(): Promise<Episode[]> {
    const [allEpisodes, reflectedIds] = await Promise.all([
      this.fileStore.readAll<Episode>('episodes'),
      this.getReflectedEpisodeIds(),
    ]);

    return allEpisodes.filter((ep) => !reflectedIds.has(ep.id));
  }

  /**
   * Mark the given episode IDs as having been reflected on.
   *
   * @param episodeIds - Episode IDs to mark.
   */
  async markReflected(episodeIds: string[]): Promise<void> {
    if (episodeIds.length === 0) return;

    const existing = await this.getReflectedEpisodeIds();
    for (const id of episodeIds) {
      existing.add(id);
    }

    const record: ReflectedIdsRecord = { ids: [...existing] };
    await this.fileStore.write(TRACKING_COLLECTION, REFLECTED_IDS_KEY, record);

    this.logger.debug('Marked episodes as reflected', { count: episodeIds.length });
  }

  // -----------------------------------------------------------------------
  // Quality tracking
  // -----------------------------------------------------------------------

  /**
   * Record that a reflection was applied and whether the subsequent episode
   * succeeded. Delegates to the internal {@link ReflectionQualityTracker}.
   *
   * @param reflectionId - The reflection whose insights were applied.
   * @param success      - Whether the subsequent episode succeeded.
   */
  async trackReflectionApplication(
    reflectionId: string,
    success: boolean,
  ): Promise<ReflectionQualityRecord> {
    return this.qualityTracker.recordApplication(reflectionId, success);
  }

  /**
   * Generate a comprehensive quality report across all tracked reflections.
   * Delegates to the internal {@link ReflectionQualityTracker}.
   */
  async getQualityReport(): Promise<QualityReport> {
    return this.qualityTracker.getReport();
  }

  /**
   * Run quality maintenance: auto-prune low-quality reflections and
   * auto-flag high-quality reflections for promotion.
   * Delegates to the internal {@link ReflectionQualityTracker}.
   */
  async runQualityMaintenance(): Promise<{ pruned: string[]; promoted: string[] }> {
    return this.qualityTracker.runMaintenance();
  }

  // -----------------------------------------------------------------------
  // Metrics
  // -----------------------------------------------------------------------

  /**
   * Compute aggregated metrics about the reflection system.
   */
  async metrics(): Promise<ReflectionMetrics> {
    const [micro, meso, macro, taxonomy, allEpisodes, reflectedIds] = await Promise.all([
      this.store.getReflectionsByLevel('micro'),
      this.store.getReflectionsByLevel('meso'),
      this.store.getReflectionsByLevel('macro'),
      this.store.getTaxonomy(),
      this.fileStore.readAll<Episode>('episodes'),
      this.getReflectedEpisodeIds(),
    ]);

    const totalReflections = micro.length + meso.length + macro.length;
    const allReflections = [...micro, ...meso, ...macro];
    const totalInsights = allReflections.reduce(
      (sum, r) => sum + (r.actionableInsights?.length ?? 0),
      0,
    );

    const result: ReflectionMetrics = {
      totalReflections,
      byLevel: {
        micro: micro.length,
        meso: meso.length,
        macro: macro.length,
      },
      taxonomySize: taxonomy.length,
      totalInsights,
      insightDensity: totalReflections > 0 ? totalInsights / totalReflections : 0,
      reflectedEpisodeCount: reflectedIds.size,
      unreflectedEpisodeCount: allEpisodes.length - reflectedIds.size,
    };

    // Augment with quality tracking data if available
    const qualityRecords = await this.qualityTracker.getAllRecords();
    if (qualityRecords.length > 0) {
      result.avgQualityScore =
        qualityRecords.reduce((sum, r) => sum + r.qualityScore, 0) / qualityRecords.length;
      result.prunedReflectionCount = qualityRecords.filter((r) => r.pruned).length;
    }

    return result;
  }
}
