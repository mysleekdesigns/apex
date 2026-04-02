/**
 * Reflection Store — structured persistence for APEX reflections.
 *
 * Accepts structured reflections from Claude (insights, error types,
 * strategies), deduplicates against existing reflections using content
 * hashing + embedding similarity, scores them by actionability, merges
 * into Semantic Memory with proportional heat scoring, and maintains
 * an error taxonomy index.
 */

import type { Reflection } from '../types.js';
import { generateId } from '../types.js';
import { contentHash } from '../utils/hashing.js';
import { getEmbedding, type EmbeddingResult } from '../utils/embeddings.js';
import { combinedSimilarity } from '../utils/similarity.js';
import { FileStore } from '../utils/file-store.js';
import { SemanticMemory } from '../memory/semantic.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FileStore collection for reflection records. */
const REFLECTIONS_COLLECTION = 'reflections';

/** FileStore collection for the taxonomy index. */
const TAXONOMY_COLLECTION = 'taxonomy';

/** Document ID for the single taxonomy index document. */
const TAXONOMY_ID = 'error-taxonomy';

/** Default similarity threshold above which a reflection is a duplicate. */
const DEFAULT_DUPLICATE_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Input accepted by {@link ReflectionStore.store}. */
export interface ReflectionInput {
  level: 'micro' | 'meso' | 'macro';
  content: string;
  errorTypes?: string[];
  actionableInsights?: string[];
  sourceEpisodes?: string[];
  confidence?: number;
}

/** Result returned by {@link ReflectionStore.store}. */
export interface StoredReflection {
  reflection: Reflection;
  semanticEntryId: string;
  isDuplicate: boolean;
  actionabilityScore: number;
}

/** A single entry in the error taxonomy index. */
export interface ErrorTaxonomyEntry {
  errorType: string;
  count: number;
  reflectionIds: string[];
  insights: string[];
  lastUpdated: number;
}

/** Configuration for {@link ReflectionStore}. */
export interface ReflectionStoreOptions {
  fileStore: FileStore;
  semanticMemory: SemanticMemory;
  logger?: Logger;
  /** Similarity threshold for duplicate detection (default 0.85). */
  duplicateThreshold?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute an actionability score in [0, 1] for a reflection.
 *
 * Factors:
 *  - Number of actionable insights (each adds 0.15, capped contribution 0.45)
 *  - Specificity of error types  (each adds 0.10, capped contribution 0.30)
 *  - Confidence (contributes up to 0.25)
 */
function computeActionabilityScore(
  actionableInsights: string[],
  errorTypes: string[],
  confidence: number,
): number {
  const insightScore = Math.min(actionableInsights.length * 0.15, 0.45);
  const errorScore = Math.min(errorTypes.length * 0.10, 0.30);
  const confidenceScore = confidence * 0.25;
  return Math.min(1.0, insightScore + errorScore + confidenceScore);
}

// ---------------------------------------------------------------------------
// ReflectionStore class
// ---------------------------------------------------------------------------

/**
 * Manages storage, deduplication, scoring, and taxonomy indexing of
 * structured reflections produced by the APEX reflection engine.
 *
 * @example
 * ```ts
 * const store = new ReflectionStore({ fileStore, semanticMemory });
 * const result = await store.store({
 *   level: 'micro',
 *   content: 'Missing null check caused TypeError in handler.',
 *   errorTypes: ['type-error'],
 *   actionableInsights: ['Always guard nullable params before use.'],
 *   sourceEpisodes: ['ep-abc123'],
 *   confidence: 0.8,
 * });
 * ```
 */
export class ReflectionStore {
  private readonly fileStore: FileStore;
  private readonly semanticMemory: SemanticMemory;
  private readonly logger: Logger;
  private readonly duplicateThreshold: number;

  constructor(options: ReflectionStoreOptions) {
    this.fileStore = options.fileStore;
    this.semanticMemory = options.semanticMemory;
    this.logger = options.logger ?? new Logger({ prefix: 'reflection-store' });
    this.duplicateThreshold = options.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD;
  }

  // -----------------------------------------------------------------------
  // Main API
  // -----------------------------------------------------------------------

  /**
   * Store a structured reflection.
   *
   * 1. Check for duplicates (content hash + similarity).
   * 2. If duplicate found, merge insights into the existing reflection.
   * 3. Compute actionability score.
   * 4. Persist to FileStore and Semantic Memory.
   * 5. Update the error taxonomy index.
   *
   * @returns Metadata about the stored (or merged) reflection.
   */
  async store(input: ReflectionInput): Promise<StoredReflection> {
    const errorTypes = input.errorTypes ?? [];
    const actionableInsights = input.actionableInsights ?? [];
    const sourceEpisodes = input.sourceEpisodes ?? [];
    const confidence = input.confidence ?? 0.7;

    // ── Duplicate detection ───────────────────────────────────────────
    const duplicate = await this.findDuplicate(input.content);

    if (duplicate) {
      this.logger.debug('Duplicate reflection detected', { existingId: duplicate.id });
      return this.mergeIntoExisting(
        duplicate,
        input,
        errorTypes,
        actionableInsights,
        sourceEpisodes,
        confidence,
      );
    }

    // ── Create new reflection ─────────────────────────────────────────
    const actionabilityScore = computeActionabilityScore(
      actionableInsights,
      errorTypes,
      confidence,
    );

    const reflection: Reflection = {
      id: generateId(),
      level: input.level,
      content: input.content,
      errorTypes,
      actionableInsights,
      sourceEpisodes,
      timestamp: Date.now(),
      confidence,
    };

    // Persist to FileStore
    await this.fileStore.write(REFLECTIONS_COLLECTION, reflection.id, reflection);

    // Add to Semantic Memory with heat proportional to actionability
    const heatScore = 1.0 + actionabilityScore; // base 1.0 + bonus
    const semanticEntryId = await this.semanticMemory.add(
      `[Reflection:${reflection.level}] ${reflection.content}`,
      { confidence: reflection.confidence, heatScore },
    );

    // Update error taxonomy
    await this.updateTaxonomy(errorTypes, reflection.id, actionableInsights);

    this.logger.info('Stored reflection', {
      id: reflection.id,
      level: reflection.level,
      actionabilityScore,
      isDuplicate: false,
    });

    return {
      reflection,
      semanticEntryId,
      isDuplicate: false,
      actionabilityScore,
    };
  }

  /**
   * Retrieve the current error taxonomy index.
   */
  async getTaxonomy(): Promise<ErrorTaxonomyEntry[]> {
    const doc = await this.fileStore.read<ErrorTaxonomyEntry[]>(TAXONOMY_COLLECTION, TAXONOMY_ID);
    return doc ?? [];
  }

  /**
   * Retrieve all reflections at a given level.
   */
  async getReflectionsByLevel(level: 'micro' | 'meso' | 'macro'): Promise<Reflection[]> {
    const all = await this.fileStore.readAll<Reflection>(REFLECTIONS_COLLECTION);
    return all.filter((r) => r.level === level);
  }

  /**
   * Find all reflections that reference a given episode ID.
   */
  async getReflectionsForEpisode(episodeId: string): Promise<Reflection[]> {
    const all = await this.fileStore.readAll<Reflection>(REFLECTIONS_COLLECTION);
    return all.filter((r) => r.sourceEpisodes.includes(episodeId));
  }

  // -----------------------------------------------------------------------
  // Duplicate detection
  // -----------------------------------------------------------------------

  /**
   * Search existing reflections for a duplicate of the given content.
   *
   * Two-pass approach:
   *  1. Exact match via content hash (fast path).
   *  2. Similarity check via embedding comparison (slow path).
   *
   * @returns The existing reflection if a duplicate is found, otherwise `undefined`.
   */
  private async findDuplicate(content: string): Promise<Reflection | undefined> {
    const hash = contentHash(content);
    const existing = await this.fileStore.readAll<Reflection>(REFLECTIONS_COLLECTION);

    // ── Pass 1: exact content hash ──────────────────────────────────
    for (const r of existing) {
      if (contentHash(r.content) === hash) {
        return r;
      }
    }

    // ── Pass 2: embedding similarity ────────────────────────────────
    const queryEmbed = getEmbedding(content);
    let bestMatch: Reflection | undefined;
    let bestScore = -1;

    for (const r of existing) {
      const targetEmbed = getEmbedding(r.content);
      const score = combinedSimilarity(queryEmbed, targetEmbed);
      if (score > this.duplicateThreshold && score > bestScore) {
        bestScore = score;
        bestMatch = r;
      }
    }

    return bestMatch;
  }

  // -----------------------------------------------------------------------
  // Merge
  // -----------------------------------------------------------------------

  /**
   * Merge new reflection data into an existing duplicate reflection.
   *
   * - Appends new content with a separator.
   * - Unions error types, actionable insights, and source episodes.
   * - Boosts confidence (capped at 1.0).
   * - Recomputes actionability and re-indexes in Semantic Memory.
   */
  private async mergeIntoExisting(
    existing: Reflection,
    input: ReflectionInput,
    errorTypes: string[],
    actionableInsights: string[],
    sourceEpisodes: string[],
    confidence: number,
  ): Promise<StoredReflection> {
    // Merge content
    existing.content = `${existing.content}\n---\n${input.content}`;

    // Union arrays (deduplicated)
    existing.errorTypes = [...new Set([...existing.errorTypes, ...errorTypes])];
    existing.actionableInsights = [...new Set([...existing.actionableInsights, ...actionableInsights])];
    existing.sourceEpisodes = [...new Set([...existing.sourceEpisodes, ...sourceEpisodes])];

    // Boost confidence
    existing.confidence = Math.min(1.0, existing.confidence + 0.1);

    // Update timestamp
    existing.timestamp = Date.now();

    // Recompute actionability
    const actionabilityScore = computeActionabilityScore(
      existing.actionableInsights,
      existing.errorTypes,
      existing.confidence,
    );

    // Persist updated reflection
    await this.fileStore.write(REFLECTIONS_COLLECTION, existing.id, existing);

    // Re-add to Semantic Memory (SemanticMemory handles its own dedup/merge)
    const heatScore = 1.0 + actionabilityScore;
    const semanticEntryId = await this.semanticMemory.add(
      `[Reflection:${existing.level}] ${existing.content}`,
      { confidence: existing.confidence, heatScore },
    );

    // Update taxonomy with any new error types
    await this.updateTaxonomy(errorTypes, existing.id, actionableInsights);

    this.logger.info('Merged duplicate reflection', {
      id: existing.id,
      level: existing.level,
      actionabilityScore,
    });

    return {
      reflection: existing,
      semanticEntryId,
      isDuplicate: true,
      actionabilityScore,
    };
  }

  // -----------------------------------------------------------------------
  // Taxonomy index
  // -----------------------------------------------------------------------

  /**
   * Update the error taxonomy index with new error types and insights.
   *
   * The taxonomy is stored as a single JSON array document in the
   * `taxonomy` collection under the id `error-taxonomy`.
   */
  private async updateTaxonomy(
    errorTypes: string[],
    reflectionId: string,
    insights: string[],
  ): Promise<void> {
    if (errorTypes.length === 0) return;

    const taxonomy = await this.getTaxonomy();
    const indexMap = new Map<string, ErrorTaxonomyEntry>();
    for (const entry of taxonomy) {
      indexMap.set(entry.errorType, entry);
    }

    const now = Date.now();

    for (const errorType of errorTypes) {
      const existing = indexMap.get(errorType);

      if (existing) {
        existing.count += 1;
        if (!existing.reflectionIds.includes(reflectionId)) {
          existing.reflectionIds.push(reflectionId);
        }
        // Merge insights (deduplicated)
        const insightSet = new Set(existing.insights);
        for (const insight of insights) {
          insightSet.add(insight);
        }
        existing.insights = [...insightSet];
        existing.lastUpdated = now;
      } else {
        indexMap.set(errorType, {
          errorType,
          count: 1,
          reflectionIds: [reflectionId],
          insights: [...insights],
          lastUpdated: now,
        });
      }
    }

    await this.fileStore.write(TAXONOMY_COLLECTION, TAXONOMY_ID, [...indexMap.values()]);
  }
}
