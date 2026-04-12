/**
 * Reflection Quality Tracker — measures the effectiveness of reflections
 * by tracking whether episodes that follow reflection application succeed
 * at a higher rate than the baseline.
 *
 * Part of Phase 12: Verbal Reinforcement Learning / Reflexion.
 */

import type { Episode } from '../types.js';
import type { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Quality score below which a reflection is pruned (after sufficient applications). */
const PRUNE_THRESHOLD = 0.1;

/** Quality score above which a reflection is promoted (after sufficient applications). */
const PROMOTE_THRESHOLD = 0.5;

/** Minimum number of applications before a reflection can be pruned. */
const MIN_APPLICATIONS_FOR_PRUNE = 5;

/** Minimum number of applications before a reflection can be promoted. */
const MIN_APPLICATIONS_FOR_PROMOTE = 3;

/** FileStore collection for quality tracking records. */
const QUALITY_COLLECTION = 'reflection-quality';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Tracks the effectiveness of a single reflection's insights. */
export interface ReflectionQualityRecord {
  /** The reflection ID being tracked. */
  reflectionId: string;
  /** Number of times this reflection's insights were applied (episode completed after recall). */
  applicationCount: number;
  /** Number of times the subsequent episode succeeded after applying this reflection. */
  successCount: number;
  /** Computed quality score: (success_rate_after - baseline_success_rate). */
  qualityScore: number;
  /** Baseline success rate at the time quality was computed. */
  baselineSuccessRate: number;
  /** Whether this reflection has been pruned. */
  pruned: boolean;
  /** Whether this reflection has been promoted to semantic memory. */
  promoted: boolean;
  /** Timestamp of last update. */
  lastUpdated: number;
}

export interface QualityTrackerOptions {
  fileStore: FileStore;
  logger?: Logger;
}

export interface QualityReport {
  /** Total tracked reflections. */
  totalTracked: number;
  /** Average quality score across all tracked reflections. */
  avgQualityScore: number;
  /** Number of reflections pruned for low quality. */
  prunedCount: number;
  /** Number of reflections promoted for high quality. */
  promotedCount: number;
  /** Top performing reflections (by quality score). */
  topReflections: Array<{ reflectionId: string; qualityScore: number; applicationCount: number }>;
  /** Reflections pending pruning (low score, sufficient applications). */
  pendingPrune: Array<{ reflectionId: string; qualityScore: number; applicationCount: number }>;
}

// ---------------------------------------------------------------------------
// ReflectionQualityTracker
// ---------------------------------------------------------------------------

/**
 * Tracks the quality of reflections by measuring whether episodes that apply
 * a reflection's insights succeed at a higher rate than the overall baseline.
 *
 * Quality score = (successCount / applicationCount) - baselineSuccessRate
 *
 * Reflections that consistently help are flagged for promotion; those that
 * don't improve outcomes after sufficient trials are flagged for pruning.
 */
export class ReflectionQualityTracker {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;

  constructor(opts: QualityTrackerOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:quality-tracker' });
  }

  // -----------------------------------------------------------------------
  // Core API
  // -----------------------------------------------------------------------

  /**
   * Record that a reflection was applied and whether the subsequent episode
   * succeeded.
   *
   * Loads or creates the quality record, increments counts, and recomputes
   * the quality score against the current baseline success rate.
   */
  async recordApplication(
    reflectionId: string,
    subsequentSuccess: boolean,
  ): Promise<ReflectionQualityRecord> {
    const existing = await this.fileStore.read<ReflectionQualityRecord>(
      QUALITY_COLLECTION,
      reflectionId,
    );

    const baseline = await this.computeBaselineSuccessRate();

    const record: ReflectionQualityRecord = existing ?? {
      reflectionId,
      applicationCount: 0,
      successCount: 0,
      qualityScore: 0,
      baselineSuccessRate: baseline,
      pruned: false,
      promoted: false,
      lastUpdated: Date.now(),
    };

    record.applicationCount += 1;
    if (subsequentSuccess) {
      record.successCount += 1;
    }

    record.baselineSuccessRate = baseline;
    record.qualityScore =
      record.applicationCount > 0
        ? record.successCount / record.applicationCount - baseline
        : 0;
    record.lastUpdated = Date.now();

    await this.fileStore.write(QUALITY_COLLECTION, reflectionId, record);

    this.logger.debug('Recorded reflection application', {
      reflectionId,
      subsequentSuccess,
      qualityScore: record.qualityScore,
      applicationCount: record.applicationCount,
    });

    return record;
  }

  /**
   * Compute the overall success rate across all episodes in the FileStore.
   *
   * Returns 0.5 as a default if no episodes exist.
   */
  async computeBaselineSuccessRate(): Promise<number> {
    const episodes = await this.fileStore.readAll<Episode>('episodes');
    if (episodes.length === 0) return 0.5;

    const successCount = episodes.filter((ep) => ep.outcome.success).length;
    return successCount / episodes.length;
  }

  /**
   * Load a specific quality record by reflection ID.
   *
   * @returns The quality record, or `null` if no tracking data exists for
   *   this reflection.
   */
  async getQualityRecord(reflectionId: string): Promise<ReflectionQualityRecord | null> {
    return this.fileStore.read<ReflectionQualityRecord>(QUALITY_COLLECTION, reflectionId);
  }

  /**
   * Generate a comprehensive quality report across all tracked reflections.
   */
  async getReport(): Promise<QualityReport> {
    const records = await this.getAllRecords();

    const totalTracked = records.length;
    const prunedCount = records.filter((r) => r.pruned).length;
    const promotedCount = records.filter((r) => r.promoted).length;

    const avgQualityScore =
      totalTracked > 0
        ? records.reduce((sum, r) => sum + r.qualityScore, 0) / totalTracked
        : 0;

    const topReflections = records
      .filter((r) => r.qualityScore > 0.3)
      .sort((a, b) => b.qualityScore - a.qualityScore)
      .map((r) => ({
        reflectionId: r.reflectionId,
        qualityScore: r.qualityScore,
        applicationCount: r.applicationCount,
      }));

    const pendingPrune = records
      .filter(
        (r) =>
          r.qualityScore < PRUNE_THRESHOLD &&
          r.applicationCount >= MIN_APPLICATIONS_FOR_PRUNE &&
          !r.pruned,
      )
      .map((r) => ({
        reflectionId: r.reflectionId,
        qualityScore: r.qualityScore,
        applicationCount: r.applicationCount,
      }));

    return {
      totalTracked,
      avgQualityScore,
      prunedCount,
      promotedCount,
      topReflections,
      pendingPrune,
    };
  }

  /**
   * Run maintenance: auto-prune low-quality reflections and auto-flag
   * high-quality reflections for promotion.
   *
   * - Prune: qualityScore < PRUNE_THRESHOLD after MIN_APPLICATIONS_FOR_PRUNE
   * - Promote: qualityScore > PROMOTE_THRESHOLD after MIN_APPLICATIONS_FOR_PROMOTE
   *
   * Pruning sets the `pruned` flag (does not delete the record). Promotion
   * sets the `promoted` flag.
   *
   * @returns IDs of reflections that were pruned and promoted in this run.
   */
  async runMaintenance(): Promise<{ pruned: string[]; promoted: string[] }> {
    const records = await this.getAllRecords();

    const pruned: string[] = [];
    const promoted: string[] = [];

    for (const record of records) {
      let changed = false;

      // Auto-prune
      if (
        !record.pruned &&
        record.applicationCount >= MIN_APPLICATIONS_FOR_PRUNE &&
        record.qualityScore < PRUNE_THRESHOLD
      ) {
        record.pruned = true;
        record.lastUpdated = Date.now();
        changed = true;
        pruned.push(record.reflectionId);
      }

      // Auto-promote
      if (
        !record.promoted &&
        record.applicationCount >= MIN_APPLICATIONS_FOR_PROMOTE &&
        record.qualityScore > PROMOTE_THRESHOLD
      ) {
        record.promoted = true;
        record.lastUpdated = Date.now();
        changed = true;
        promoted.push(record.reflectionId);
      }

      if (changed) {
        await this.fileStore.write(QUALITY_COLLECTION, record.reflectionId, record);
      }
    }

    if (pruned.length > 0 || promoted.length > 0) {
      this.logger.info('Quality maintenance completed', {
        pruned: pruned.length,
        promoted: promoted.length,
      });
    }

    return { pruned, promoted };
  }

  /**
   * Load all quality tracking records.
   */
  async getAllRecords(): Promise<ReflectionQualityRecord[]> {
    return this.fileStore.readAll<ReflectionQualityRecord>(QUALITY_COLLECTION);
  }
}
