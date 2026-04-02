/**
 * Semantic Memory — the "SSD" tier of the APEX memory system.
 *
 * Stores distilled knowledge, rules, and error taxonomy entries as
 * {@link MemoryEntry} records with `tier: "semantic"`. Supports
 * embedding-based retrieval, content-hash deduplication, automatic
 * merge of near-duplicates, and LRU + heat-score eviction.
 *
 * Capacity defaults to 5 000 entries.
 */

import type { MemoryEntry, SearchResult } from '../types.js';
import { generateId } from '../types.js';
import { getEmbedding, type EmbeddingResult } from '../utils/embeddings.js';
import { combinedSimilarity } from '../utils/similarity.js';
import { contentHash } from '../utils/hashing.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum number of semantic entries. */
const DEFAULT_CAPACITY = 5_000;

/** Collection name used by FileStore for persistence. */
const COLLECTION = 'memory';

/** Similarity threshold above which two entries are considered near-duplicates. */
const MERGE_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration accepted by the {@link SemanticMemory} constructor. */
export interface SemanticMemoryOptions {
  /** Maximum number of entries before eviction kicks in. */
  capacity?: number;
  /** FileStore instance for persistence (optional — in-memory only if omitted). */
  fileStore?: FileStore;
  /** Logger instance (optional — a default logger is created if omitted). */
  logger?: Logger;
}

/** Statistics exposed by {@link SemanticMemory.stats}. */
export interface SemanticMemoryStats {
  /** Current number of entries in semantic memory. */
  entryCount: number;
  /** Configured maximum capacity. */
  capacity: number;
  /** Number of times a duplicate was detected and merged instead of inserted. */
  dedupHitCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute an eviction score for a memory entry.
 *
 * Score = heat * 0.7 + recencyScore * 0.3
 * where recencyScore is a value in [0, 1] based on how recently the entry was
 * accessed relative to the oldest and newest access timestamps in the set.
 */
function evictionScore(entry: MemoryEntry, now: number, oldestAccess: number): number {
  const range = now - oldestAccess || 1;
  const recency = (entry.accessedAt - oldestAccess) / range;
  return entry.heatScore * 0.7 + recency * 0.3;
}

// ---------------------------------------------------------------------------
// SemanticMemory class
// ---------------------------------------------------------------------------

/**
 * Semantic Memory tier for the APEX learning system.
 *
 * Provides embedding-based retrieval with top-k ranking, content-hash
 * deduplication, near-duplicate merging, and LRU + heat-based eviction.
 *
 * @example
 * ```ts
 * const mem = new SemanticMemory({ fileStore, logger });
 * await mem.load();
 * await mem.add("TypeScript enums should be avoided in favour of const objects.");
 * const results = await mem.search("enum alternatives in TS", 5);
 * ```
 */
export class SemanticMemory {
  private readonly capacity: number;
  private readonly fileStore: FileStore | undefined;
  private readonly logger: Logger;

  /** Primary entry store keyed by entry id. */
  private entries: Map<string, MemoryEntry> = new Map();

  /** Content-hash to entry-id map for O(1) dedup. */
  private hashIndex: Map<string, string> = new Map();

  /** Cached embeddings keyed by entry id. */
  private embeddings: Map<string, EmbeddingResult> = new Map();

  /** Running count of deduplication hits. */
  private dedupHits = 0;

  constructor(options: SemanticMemoryOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.fileStore = options.fileStore;
    this.logger = options.logger ?? new Logger({ prefix: 'semantic-memory' });
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Load all semantic entries from persistent storage.
   *
   * Call this once after construction to hydrate in-memory state.
   * If no FileStore was provided the method is a no-op.
   */
  async load(): Promise<void> {
    if (!this.fileStore) return;

    const ids = await this.fileStore.list(COLLECTION);
    let loaded = 0;

    for (const id of ids) {
      const entry = await this.fileStore.read<MemoryEntry>(COLLECTION, id);
      if (entry && entry.tier === 'semantic') {
        this.entries.set(entry.id, entry);
        this.hashIndex.set(contentHash(entry.content), entry.id);
        this.embeddings.set(entry.id, getEmbedding(entry.content));
        loaded++;
      }
    }

    this.logger.info(`Loaded ${loaded} semantic entries from storage`);
  }

  /**
   * Persist a single entry to the FileStore.
   *
   * No-op when no FileStore is configured.
   */
  private async persist(entry: MemoryEntry): Promise<void> {
    if (!this.fileStore) return;
    await this.fileStore.write(COLLECTION, entry.id, entry);
  }

  /**
   * Remove a single entry from the FileStore.
   *
   * No-op when no FileStore is configured.
   */
  private async unpersist(id: string): Promise<void> {
    if (!this.fileStore) return;
    await this.fileStore.delete(COLLECTION, id);
  }

  // -----------------------------------------------------------------------
  // Add / merge
  // -----------------------------------------------------------------------

  /**
   * Add a knowledge entry to semantic memory.
   *
   * If an exact content-hash duplicate exists the call is a no-op (dedup hit).
   * If a near-duplicate exists (similarity > 0.85), the new content is merged
   * into the existing entry instead of creating a new record.
   *
   * When the store exceeds capacity after insertion, eviction runs
   * automatically.
   *
   * @param content  - The textual knowledge to store.
   * @param metadata - Optional metadata: sourceFiles, confidence, heatScore.
   * @returns The id of the created or merged entry.
   */
  async add(
    content: string,
    metadata: {
      sourceFiles?: string[];
      confidence?: number;
      heatScore?: number;
    } = {},
  ): Promise<string> {
    const hash = contentHash(content);

    // ── Exact dedup via content hash ──────────────────────────────────
    const existingId = this.hashIndex.get(hash);
    if (existingId && this.entries.has(existingId)) {
      this.dedupHits++;
      this.logger.debug('Exact dedup hit', { hash, existingId });

      // Touch the existing entry so it stays warm.
      const existing = this.entries.get(existingId)!;
      existing.accessedAt = Date.now();
      existing.heatScore += 0.05;
      await this.persist(existing);
      return existingId;
    }

    // ── Near-duplicate detection ─────────────────────────────────────
    const queryEmbed = getEmbedding(content);
    const nearDup = this.findNearDuplicate(queryEmbed);

    if (nearDup) {
      this.dedupHits++;
      this.logger.debug('Near-duplicate merge', { targetId: nearDup.id });
      return this.mergeInto(nearDup, content, queryEmbed, metadata);
    }

    // ── Create new entry ─────────────────────────────────────────────
    const now = Date.now();
    const entry: MemoryEntry = {
      id: generateId(),
      content,
      heatScore: metadata.heatScore ?? 1.0,
      confidence: metadata.confidence ?? 0.5,
      createdAt: now,
      accessedAt: now,
      sourceFiles: metadata.sourceFiles,
      tier: 'semantic',
    };

    this.entries.set(entry.id, entry);
    this.hashIndex.set(hash, entry.id);
    this.embeddings.set(entry.id, queryEmbed);
    await this.persist(entry);

    this.logger.debug('Added semantic entry', { id: entry.id });

    // Evict if over capacity
    if (this.entries.size > this.capacity) {
      await this.evict();
    }

    return entry.id;
  }

  /**
   * Find the best near-duplicate entry above the merge threshold.
   *
   * @returns The matching entry or `undefined` if none qualifies.
   */
  private findNearDuplicate(queryEmbed: EmbeddingResult): MemoryEntry | undefined {
    let bestEntry: MemoryEntry | undefined;
    let bestScore = -1;

    for (const [id, embed] of this.embeddings) {
      const score = combinedSimilarity(queryEmbed, embed);
      if (score > MERGE_THRESHOLD && score > bestScore) {
        bestScore = score;
        bestEntry = this.entries.get(id);
      }
    }

    return bestEntry;
  }

  /**
   * Merge new content into an existing entry.
   *
   * - Appends new insights to existing content.
   * - Boosts confidence by 0.1 (capped at 1.0).
   * - Boosts heat score.
   * - Updates accessedAt and re-indexes the hash/embedding.
   *
   * @returns The id of the merged entry.
   */
  private async mergeInto(
    existing: MemoryEntry,
    newContent: string,
    newEmbed: EmbeddingResult,
    metadata: { sourceFiles?: string[]; confidence?: number; heatScore?: number },
  ): Promise<string> {
    // Remove old hash index entry
    const oldHash = contentHash(existing.content);
    this.hashIndex.delete(oldHash);

    // Combine content
    existing.content = `${existing.content}\n---\n${newContent}`;

    // Boost confidence
    existing.confidence = Math.min(1.0, existing.confidence + 0.1);

    // Boost heat
    existing.heatScore += 0.2;

    // Update access timestamp
    existing.accessedAt = Date.now();

    // Merge source files
    if (metadata.sourceFiles) {
      const merged = new Set(existing.sourceFiles ?? []);
      for (const f of metadata.sourceFiles) merged.add(f);
      existing.sourceFiles = [...merged];
    }

    // Re-index with new content hash and embedding
    const newHash = contentHash(existing.content);
    this.hashIndex.set(newHash, existing.id);
    this.embeddings.set(existing.id, getEmbedding(existing.content));

    await this.persist(existing);

    return existing.id;
  }

  // -----------------------------------------------------------------------
  // Retrieval
  // -----------------------------------------------------------------------

  /**
   * Search semantic memory by text similarity and return the top-k results.
   *
   * Computes a combined similarity score (keyword Jaccard + SimHash, and
   * optionally cosine on dense embeddings) against every stored entry, then
   * returns the highest-scoring entries sorted descending.
   *
   * Retrieved entries have their heat score and accessedAt timestamp bumped
   * so they remain warm.
   *
   * @param query - Free-text search query.
   * @param topK  - Maximum number of results to return (default 10).
   * @returns Ranked array of {@link SearchResult}.
   */
  async search(query: string, topK = 10): Promise<SearchResult[]> {
    const queryEmbed = getEmbedding(query);

    const scored: { entry: MemoryEntry; score: number }[] = [];

    for (const [id, embed] of this.embeddings) {
      const entry = this.entries.get(id);
      if (!entry) continue;

      const score = combinedSimilarity(queryEmbed, embed);
      scored.push({ entry, score });
    }

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    const results: SearchResult[] = [];
    const now = Date.now();

    for (const { entry, score } of scored.slice(0, topK)) {
      // Warm up retrieved entries
      entry.heatScore += 0.05;
      entry.accessedAt = now;
      // Fire-and-forget persist; do not block the response
      void this.persist(entry);

      results.push({
        entry,
        score,
        sourceTier: 'semantic',
        source: 'project',
      });
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Eviction
  // -----------------------------------------------------------------------

  /**
   * Evict lowest-scoring entries until the store is at or below capacity.
   *
   * Eviction score = heatScore * 0.7 + recencyScore * 0.3
   */
  private async evict(): Promise<void> {
    const excess = this.entries.size - this.capacity;
    if (excess <= 0) return;

    const now = Date.now();
    let oldestAccess = now;
    for (const entry of this.entries.values()) {
      if (entry.accessedAt < oldestAccess) {
        oldestAccess = entry.accessedAt;
      }
    }

    // Build scored list
    const scored = [...this.entries.values()]
      .map((entry) => ({ entry, score: evictionScore(entry, now, oldestAccess) }))
      .sort((a, b) => a.score - b.score);

    const toEvict = scored.slice(0, excess);

    for (const { entry } of toEvict) {
      this.entries.delete(entry.id);
      this.embeddings.delete(entry.id);

      // Remove from hash index
      const hash = contentHash(entry.content);
      if (this.hashIndex.get(hash) === entry.id) {
        this.hashIndex.delete(hash);
      }

      await this.unpersist(entry.id);
    }

    this.logger.info(`Evicted ${toEvict.length} semantic entries`);
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /**
   * Retrieve a single entry by id, or `undefined` if not found.
   */
  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Return all entries currently held in semantic memory.
   */
  all(): MemoryEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Return current statistics for the semantic memory tier.
   */
  stats(): SemanticMemoryStats {
    return {
      entryCount: this.entries.size,
      capacity: this.capacity,
      dedupHitCount: this.dedupHits,
    };
  }
}
