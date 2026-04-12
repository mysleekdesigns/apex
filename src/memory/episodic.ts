/**
 * Episodic Memory — the "RAM" tier of APEX's memory system.
 *
 * Stores recent experience episodes with segment-paged storage,
 * heat-based eviction, and two-stage retrieval. Capacity defaults
 * to 1000 entries.
 */

import { generateId, type MemoryEntry, type SearchResult } from '../types.js';
import { getEmbedding, getEmbeddingAsync, type EmbeddingResult } from '../utils/embeddings.js';
import { combinedSimilarity } from '../utils/similarity.js';
import { type FileStore } from '../utils/file-store.js';
import { type Logger } from '../utils/logger.js';
import { type EventBus } from '../utils/event-bus.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A topical segment that groups related episodic entries. */
export interface Segment {
  /** Unique identifier for this segment. */
  id: string;
  /** Human-readable topic label. */
  label: string;
  /** IDs of entries belonging to this segment. */
  entryIds: string[];
  /** Aggregated embedding computed from member content. */
  embedding: EmbeddingResult;
}

/** Heat-score weight configuration. */
export interface HeatWeights {
  /** Weight for visit-count component (default 0.4). */
  alpha: number;
  /** Weight for interaction-length component (default 0.3). */
  beta: number;
  /** Weight for recency component (default 0.3). */
  gamma: number;
}

/** Per-entry metadata tracked for heat computation. */
interface EntryMeta {
  /** Number of times this entry has been accessed. */
  visitCount: number;
}

/** Constructor options for {@link EpisodicMemory}. */
export interface EpisodicMemoryOptions {
  /** Maximum number of entries before eviction (default 1000). */
  capacity?: number;
  /** Persistence layer. */
  fileStore?: FileStore;
  /** Event bus for cross-system communication. */
  eventBus?: EventBus;
  /** Logger instance. */
  logger?: Logger;
  /** Custom heat-score weights. */
  heatWeights?: Partial<HeatWeights>;
}

/** Statistics snapshot for the episodic tier. */
export interface EpisodicStats {
  /** Total number of entries. */
  entryCount: number;
  /** Total number of segments. */
  segmentCount: number;
  /** Average heat score across all entries. */
  avgHeatScore: number;
  /** Fraction of capacity currently used (0-1). */
  capacityUtilization: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CAPACITY = 1000;
const DEFAULT_HEAT_WEIGHTS: HeatWeights = { alpha: 0.4, beta: 0.3, gamma: 0.3 };
const DEFAULT_SEGMENT_THRESHOLD = 0.4;

/** Recency decay parameter (lambda). */
const RECENCY_LAMBDA = 0.1;

/** Visit-count saturation point (log scale). */
const VISIT_SATURATION = 50;

/** FileStore collection names. */
const EPISODES_COLLECTION = 'episodes';
const SEGMENT_INDEX_COLLECTION = 'segment-index';
const ENTRY_META_COLLECTION = 'entry-meta';

// ---------------------------------------------------------------------------
// EpisodicMemory
// ---------------------------------------------------------------------------

/**
 * Episodic Memory manages recent experience episodes with segment-paged
 * storage and heat-based eviction.
 *
 * Entries are grouped into topical segments based on embedding similarity.
 * When capacity is exceeded, entries with the lowest heat scores are evicted.
 * Retrieval uses a two-stage process: first find the most relevant segments,
 * then rank individual entries within those segments.
 */
export class EpisodicMemory {
  private readonly capacity: number;
  private readonly fileStore?: FileStore;
  private readonly eventBus?: EventBus;
  private readonly logger?: Logger;
  private readonly heatWeights: HeatWeights;
  private readonly segmentThreshold: number;

  /** In-memory entry store keyed by entry ID. */
  private entries: Map<string, MemoryEntry> = new Map();

  /** In-memory segment index keyed by segment ID. */
  private segments: Map<string, Segment> = new Map();

  /** Per-entry metadata for heat computation. */
  private entryMeta: Map<string, EntryMeta> = new Map();

  constructor(options: EpisodicMemoryOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.fileStore = options.fileStore;
    this.eventBus = options.eventBus;
    this.logger = options.logger;
    this.heatWeights = { ...DEFAULT_HEAT_WEIGHTS, ...options.heatWeights };
    this.segmentThreshold = DEFAULT_SEGMENT_THRESHOLD;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Add an entry to episodic memory.
   *
   * Accepts a full {@link MemoryEntry} or a plain content string (which
   * will be wrapped into a new entry automatically). The entry is assigned
   * to the most similar existing segment, or a new segment is created.
   *
   * @param input - A MemoryEntry or a content string.
   * @returns The stored MemoryEntry.
   */
  async add(input: MemoryEntry | string): Promise<MemoryEntry> {
    const entry = typeof input === 'string' ? this.createEntry(input) : { ...input, tier: 'episodic' as const };

    this.entries.set(entry.id, entry);
    this.entryMeta.set(entry.id, { visitCount: 1 });

    // Compute embedding for segment assignment
    const embedding = getEmbedding(entry.content);

    // Assign to best-matching segment or create a new one
    this.assignToSegment(entry, embedding);

    // Persist
    await this.persistEntry(entry);
    await this.persistSegments();
    await this.persistEntryMeta();

    // Evict if over capacity
    if (this.entries.size > this.capacity) {
      await this.evict(this.entries.size - this.capacity);
    }

    // Try to enhance with L2 embedding (non-blocking)
    void this.enhanceWithL2(entry).catch(() => {/* graceful degradation */});

    this.logger?.debug('Episodic entry added', { id: entry.id, segments: this.segments.size });

    return entry;
  }

  /**
   * Two-stage retrieval: find relevant segments, then rank entries within them.
   *
   * @param query - The search query string.
   * @param topK - Maximum number of results to return (default 10).
   * @param topSegments - Number of top segments to search within (default 3).
   * @returns Ranked search results.
   */
  async search(query: string, topK = 10, topSegments = 3): Promise<SearchResult[]> {
    if (this.entries.size === 0) return [];

    // Try async embedding first (may include L2 dense vector), fall back to sync
    let queryEmbedding: EmbeddingResult;
    try {
      queryEmbedding = await getEmbeddingAsync(query, 'auto');
    } catch {
      queryEmbedding = getEmbedding(query);
    }

    // Stage 1: rank segments by similarity to query
    const segmentScores: Array<{ segment: Segment; score: number }> = [];
    for (const segment of this.segments.values()) {
      const score = combinedSimilarity(queryEmbedding, segment.embedding);
      segmentScores.push({ segment, score });
    }
    segmentScores.sort((a, b) => b.score - a.score);

    const selectedSegments = segmentScores.slice(0, topSegments);

    // Stage 2: rank individual entries within selected segments
    const candidateScores: Array<{ entry: MemoryEntry; score: number }> = [];

    for (const { segment } of selectedSegments) {
      for (const entryId of segment.entryIds) {
        const entry = this.entries.get(entryId);
        if (!entry) continue;

        const entryEmbedding = getEmbedding(entry.content);
        const score = combinedSimilarity(queryEmbedding, entryEmbedding);
        candidateScores.push({ entry, score });
      }
    }

    candidateScores.sort((a, b) => b.score - a.score);

    const results: SearchResult[] = [];
    for (const { entry, score } of candidateScores.slice(0, topK)) {
      // Bump heat on access
      this.bumpHeat(entry.id);

      results.push({
        entry,
        score,
        sourceTier: 'episodic',
        source: 'project',
      });
    }

    // Persist updated heat scores and meta
    await this.persistEntryMeta();

    return results;
  }

  /**
   * Remove an entry by ID.
   *
   * @param id - The entry ID to remove.
   */
  async remove(id: string): Promise<void> {
    this.entries.delete(id);
    this.entryMeta.delete(id);

    // Remove from segments
    for (const segment of this.segments.values()) {
      const idx = segment.entryIds.indexOf(id);
      if (idx !== -1) {
        segment.entryIds.splice(idx, 1);
        // Remove empty segments
        if (segment.entryIds.length === 0) {
          this.segments.delete(segment.id);
        }
        break;
      }
    }

    if (this.fileStore) {
      await this.fileStore.delete(EPISODES_COLLECTION, id);
      await this.fileStore.delete(ENTRY_META_COLLECTION, id);
    }
    await this.persistSegments();
  }

  /**
   * Get an entry by ID, bumping its heat score on access.
   *
   * @param id - The entry ID.
   * @returns The entry, or null if not found.
   */
  async get(id: string): Promise<MemoryEntry | null> {
    const entry = this.entries.get(id) ?? null;
    if (entry) {
      this.bumpHeat(id);
    }
    return entry;
  }

  /**
   * Return all entries currently in episodic memory.
   */
  getAll(): MemoryEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Load persisted state from the FileStore.
   */
  async load(): Promise<void> {
    if (!this.fileStore) return;

    // Load entries
    const entries = await this.fileStore.readAll<MemoryEntry>(EPISODES_COLLECTION);
    this.entries.clear();
    for (const entry of entries) {
      if (entry.tier === 'episodic') {
        this.entries.set(entry.id, entry);
      }
    }

    // Load segment index
    const segmentData = await this.fileStore.read<Segment[]>(SEGMENT_INDEX_COLLECTION, 'segments');
    this.segments.clear();
    if (segmentData) {
      for (const seg of segmentData) {
        // Restore bigint from serialised form
        if (seg.embedding && typeof seg.embedding.simhash === 'string') {
          seg.embedding.simhash = BigInt(seg.embedding.simhash as unknown as string);
        }
        // Prune any entry IDs that no longer exist
        seg.entryIds = seg.entryIds.filter((id) => this.entries.has(id));
        if (seg.entryIds.length > 0) {
          this.segments.set(seg.id, seg);
        }
      }
    }

    // Load entry meta
    const metaItems = await this.fileStore.readAll<EntryMeta & { id: string }>(ENTRY_META_COLLECTION);
    this.entryMeta.clear();
    for (const item of metaItems) {
      if (this.entries.has(item.id)) {
        this.entryMeta.set(item.id, { visitCount: item.visitCount });
      }
    }

    this.logger?.info('Episodic memory loaded', {
      entries: this.entries.size,
      segments: this.segments.size,
    });
  }

  /**
   * Persist all entries, segments, and metadata to the FileStore.
   */
  async save(): Promise<void> {
    if (!this.fileStore) return;

    for (const entry of this.entries.values()) {
      await this.fileStore.write(EPISODES_COLLECTION, entry.id, entry);
    }
    await this.persistSegments();
    await this.persistEntryMeta();

    this.logger?.debug('Episodic memory saved', { entries: this.entries.size });
  }

  /**
   * Return statistics about the episodic memory tier.
   */
  stats(): EpisodicStats {
    const entries = [...this.entries.values()];
    const totalHeat = entries.reduce((sum, e) => sum + e.heatScore, 0);

    return {
      entryCount: entries.length,
      segmentCount: this.segments.size,
      avgHeatScore: entries.length > 0 ? totalHeat / entries.length : 0,
      capacityUtilization: entries.length / this.capacity,
    };
  }

  /**
   * Recompute heat scores for all entries based on current metadata.
   * Useful after loading from disk or after time has passed.
   */
  recomputeHeatScores(): void {
    const now = Date.now();
    const maxVisits = this.getMaxVisitCount();

    for (const [id, entry] of this.entries) {
      const meta = this.entryMeta.get(id);
      entry.heatScore = this.computeHeat(meta?.visitCount ?? 1, maxVisits, entry.accessedAt, now);
    }
  }

  // -----------------------------------------------------------------------
  // Heat Score Computation
  // -----------------------------------------------------------------------

  /**
   * Compute the heat score for an entry.
   *
   * Heat = alpha * N_visit + beta * L_interaction + gamma * R_recency
   *
   * - N_visit: log-scaled visit count, saturating at {@link VISIT_SATURATION}
   * - L_interaction: normalized interaction length (visitCount / maxVisitCount)
   * - R_recency: exponential decay from last access
   *
   * @param visitCount - Number of times the entry has been accessed.
   * @param maxVisits - Maximum visit count across all entries (for normalization).
   * @param lastAccessedAt - Timestamp of last access (ms).
   * @param now - Current timestamp (ms).
   * @returns Heat score in [0, 1].
   */
  private computeHeat(visitCount: number, maxVisits: number, lastAccessedAt: number, now: number): number {
    const { alpha, beta, gamma } = this.heatWeights;

    // N_visit: log-scaled, saturating at VISIT_SATURATION
    const nVisit = Math.min(Math.log(visitCount + 1) / Math.log(VISIT_SATURATION + 1), 1);

    // L_interaction: normalized interaction length
    const lInteraction = maxVisits > 0 ? visitCount / maxVisits : 0;

    // R_recency: exponential decay based on days since last access
    const daysSinceAccess = (now - lastAccessedAt) / (1000 * 60 * 60 * 24);
    const rRecency = Math.exp(-RECENCY_LAMBDA * daysSinceAccess);

    return alpha * nVisit + beta * lInteraction + gamma * rRecency;
  }

  /**
   * Bump the heat score of an entry after it is accessed.
   *
   * Increments visit count, updates accessedAt, and recomputes the heat score.
   */
  private bumpHeat(id: string): void {
    const entry = this.entries.get(id);
    const meta = this.entryMeta.get(id);
    if (!entry || !meta) return;

    meta.visitCount += 1;
    entry.accessedAt = Date.now();

    const maxVisits = this.getMaxVisitCount();
    entry.heatScore = this.computeHeat(meta.visitCount, maxVisits, entry.accessedAt, Date.now());
  }

  /** Get the maximum visit count across all entries. */
  private getMaxVisitCount(): number {
    let max = 0;
    for (const meta of this.entryMeta.values()) {
      if (meta.visitCount > max) max = meta.visitCount;
    }
    return max;
  }

  // -----------------------------------------------------------------------
  // Segment Management
  // -----------------------------------------------------------------------

  /**
   * Assign an entry to the most similar existing segment, or create a new one.
   */
  private assignToSegment(entry: MemoryEntry, embedding: EmbeddingResult): void {
    let bestSegment: Segment | null = null;
    let bestScore = -1;

    for (const segment of this.segments.values()) {
      const score = combinedSimilarity(embedding, segment.embedding);
      if (score > bestScore) {
        bestScore = score;
        bestSegment = segment;
      }
    }

    if (bestSegment && bestScore >= this.segmentThreshold) {
      // Add to existing segment
      bestSegment.entryIds.push(entry.id);
      // Recompute segment embedding from all member content
      this.recomputeSegmentEmbedding(bestSegment);
    } else {
      // Create new segment
      const label = entry.content.slice(0, 60).replace(/\n/g, ' ').trim();
      const segment: Segment = {
        id: generateId(),
        label,
        entryIds: [entry.id],
        embedding,
      };
      this.segments.set(segment.id, segment);
    }
  }

  /**
   * Recompute a segment's embedding from the concatenated content of its members.
   */
  private recomputeSegmentEmbedding(segment: Segment): void {
    const texts: string[] = [];
    for (const id of segment.entryIds) {
      const entry = this.entries.get(id);
      if (entry) texts.push(entry.content);
    }
    if (texts.length > 0) {
      segment.embedding = getEmbedding(texts.join(' '));
    }
  }

  // -----------------------------------------------------------------------
  // L2 Embedding Enhancement
  // -----------------------------------------------------------------------

  /**
   * Try to enhance an entry with an L2 dense vector embedding.
   * Non-blocking, fire-and-forget — failures are silently ignored.
   */
  private async enhanceWithL2(entry: MemoryEntry): Promise<void> {
    try {
      const result = await getEmbeddingAsync(entry.content, 'auto');
      if (result.embedding) {
        entry.embedding = result.embedding;
        await this.persistEntry(entry);
      }
    } catch {
      // L2 not available, no-op
    }
  }

  // -----------------------------------------------------------------------
  // Eviction
  // -----------------------------------------------------------------------

  /**
   * Evict the entries with the lowest heat scores.
   *
   * Before eviction, emits a `'memory:episodic-evict'` event with each entry.
   *
   * @param count - Number of entries to evict.
   */
  private async evict(count: number): Promise<void> {
    // Recompute all heat scores before eviction
    this.recomputeHeatScores();

    // Sort entries by heat score ascending (coldest first)
    const sorted = [...this.entries.values()].sort((a, b) => a.heatScore - b.heatScore);

    const toEvict = sorted.slice(0, count);
    for (const entry of toEvict) {
      this.logger?.debug('Evicting episodic entry', { id: entry.id, heat: entry.heatScore });

      // Emit event before eviction so listeners can promote the entry
      this.eventBus?.emit('memory:episodic-evict', entry);

      await this.remove(entry.id);
    }

    this.logger?.info('Episodic eviction complete', {
      evicted: toEvict.length,
      remaining: this.entries.size,
    });
  }

  // -----------------------------------------------------------------------
  // Entry creation helper
  // -----------------------------------------------------------------------

  /**
   * Create a new MemoryEntry from a plain content string.
   */
  private createEntry(content: string): MemoryEntry {
    const now = Date.now();
    return {
      id: generateId(),
      content,
      heatScore: 0,
      confidence: 1,
      createdAt: now,
      accessedAt: now,
      tier: 'episodic',
    };
  }

  // -----------------------------------------------------------------------
  // Persistence helpers
  // -----------------------------------------------------------------------

  /** Persist a single entry to the FileStore. */
  private async persistEntry(entry: MemoryEntry): Promise<void> {
    if (!this.fileStore) return;
    await this.fileStore.write(EPISODES_COLLECTION, entry.id, entry);
  }

  /** Persist the segment index to the FileStore. */
  private async persistSegments(): Promise<void> {
    if (!this.fileStore) return;

    // Serialize segments with bigint converted to string for JSON compat
    const segmentArray = [...this.segments.values()].map((seg) => ({
      ...seg,
      embedding: {
        ...seg.embedding,
        simhash: seg.embedding.simhash.toString(),
      },
    }));

    await this.fileStore.write(SEGMENT_INDEX_COLLECTION, 'segments', segmentArray);
  }

  /** Persist all entry metadata to the FileStore. */
  private async persistEntryMeta(): Promise<void> {
    if (!this.fileStore) return;

    for (const [id, meta] of this.entryMeta) {
      await this.fileStore.write(ENTRY_META_COLLECTION, id, { id, ...meta });
    }
  }
}
