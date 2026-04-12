/**
 * APEX Memory Manager
 *
 * Unified interface across all four memory tiers, with cross-tier retrieval,
 * consolidation pipeline, and persistence orchestration.
 */

import type {
  MemoryEntry,
  MemoryTier,
  SearchResult,
  Skill,
  ConsolidationReport,
  Snapshot,
  AgentConfig,
} from '../types.js';
import { WorkingMemory } from './working.js';
import { EpisodicMemory } from './episodic.js';
import { SemanticMemory } from './semantic.js';
import { ProceduralMemory, type StoredSkill } from './procedural.js';
import { StalenessDetector } from './staleness.js';
import { SnapshotManager } from './snapshots.js';
import { EmbeddingStore } from './embedding-store.js';
import { FileStore } from '../utils/file-store.js';
import { EventBus } from '../utils/event-bus.js';
import { Logger } from '../utils/logger.js';
import { getEmbedding, getEmbeddingAsync, getSemanticEmbedder, extractKeywords, simHash } from '../utils/embeddings.js';
import { HNSWIndex } from '../utils/vector-index.js';
import { BM25Index, hybridSearch, type HybridInput } from '../utils/similarity.js';

// ---------------------------------------------------------------------------
// Options & stats
// ---------------------------------------------------------------------------

export interface MemoryManagerOptions {
  /** Path to `.apex-data/` directory for this project. */
  projectDataPath: string;
  /** Path to `~/.apex/` global directory (optional). */
  globalDataPath?: string;
  /** Project root path (for staleness detection). */
  projectPath: string;
  /** Memory limits per tier. */
  limits?: AgentConfig['memoryLimits'];
  /** Consolidation threshold (working memory entries before auto-consolidate). */
  consolidationThreshold?: number;
  /** Logger instance. */
  logger?: Logger;
}

export interface MemoryStats {
  working: { count: number; capacity: number; isFull: boolean };
  episodic: { entryCount: number; segmentCount: number; avgHeatScore: number; capacityUtilization: number };
  semantic: { entryCount: number; capacity: number; dedupHitCount: number };
  procedural: { total: number; active: number; archived: number; avgConfidence: number; avgSuccessRate: number };
  snapshots: number;
}

// ---------------------------------------------------------------------------
// Memory Manager
// ---------------------------------------------------------------------------

export class MemoryManager {
  private readonly working: WorkingMemory;
  private readonly episodic: EpisodicMemory;
  private readonly semantic: SemanticMemory;
  private readonly procedural: ProceduralMemory;
  private readonly staleness: StalenessDetector;
  private readonly snapshots: SnapshotManager;
  private readonly embeddingStore: EmbeddingStore;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly projectStore: FileStore;
  private readonly globalStore: FileStore | null;
  private readonly consolidationThreshold: number;
  private loaded = false;

  /** HNSW vector index for dense embedding search (null if L2 unavailable). */
  private hnswIndex: HNSWIndex | null = null;
  /** BM25 keyword index for hybrid retrieval. */
  private bm25Index: BM25Index;
  /** Queue of entries pending async embedding. */
  private embeddingQueue: Array<{ id: string; content: string }> = [];
  /** Guard to prevent concurrent queue flushes. */
  private flushingQueue = false;

  constructor(opts: MemoryManagerOptions) {
    const logger = opts.logger ?? new Logger({ prefix: 'apex:memory' });
    const eventBus = new EventBus();
    const projectStore = new FileStore(opts.projectDataPath);
    const globalStore = opts.globalDataPath ? new FileStore(opts.globalDataPath) : null;
    const limits = opts.limits ?? { working: 10, episodic: 1000, semantic: 5000 };

    this.logger = logger;
    this.eventBus = eventBus;
    this.projectStore = projectStore;
    this.globalStore = globalStore;
    this.consolidationThreshold = opts.consolidationThreshold ?? 10;

    this.working = new WorkingMemory({
      capacity: limits.working,
      eventBus,
      logger: new Logger({ prefix: 'apex:working', level: logger['level'] }),
    });

    this.episodic = new EpisodicMemory({
      capacity: limits.episodic,
      fileStore: projectStore,
      eventBus,
      logger: new Logger({ prefix: 'apex:episodic', level: logger['level'] }),
    });

    this.semantic = new SemanticMemory({
      capacity: limits.semantic,
      fileStore: projectStore,
      logger: new Logger({ prefix: 'apex:semantic', level: logger['level'] }),
    });

    this.procedural = new ProceduralMemory({
      fileStore: projectStore,
      logger: new Logger({ prefix: 'apex:procedural', level: logger['level'] }),
    });

    this.staleness = new StalenessDetector({
      projectPath: opts.projectPath,
      logger: new Logger({ prefix: 'apex:staleness', level: logger['level'] }),
    });

    this.snapshots = new SnapshotManager({
      dataPath: opts.projectDataPath,
      fileStore: projectStore,
      logger: new Logger({ prefix: 'apex:snapshots', level: logger['level'] }),
    });

    this.embeddingStore = new EmbeddingStore({
      logger: new Logger({ prefix: 'apex:embeddings', level: logger['level'] }),
    });

    this.bm25Index = new BM25Index();

    // Wire overflow: working -> episodic
    this.eventBus.on('memory:working-overflow', async (entry: unknown) => {
      const memEntry = entry as MemoryEntry;
      memEntry.tier = 'episodic';
      try {
        await this.episodic.add(memEntry);
        this.logger.debug('Working memory overflow -> episodic', { id: memEntry.id });
      } catch (err) {
        this.logger.error('Failed to move overflow entry to episodic', { error: err });
      }
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /** Initialize persistence directories and load existing data. */
  async init(): Promise<void> {
    if (this.loaded) return;
    await this.projectStore.init();
    await Promise.all([
      this.episodic.load(),
      this.semantic.load(),
      this.procedural.load(),
    ]);
    // Build BM25 and HNSW indexes from existing entries (non-blocking for L2)
    await this.buildIndexes();
    this.loaded = true;
    this.logger.info('Memory manager initialized');
  }

  /** Persist all tiers to disk. */
  async save(): Promise<void> {
    await Promise.all([
      this.episodic.save(),
      // semantic persists on write; procedural persists on write
    ]);
    this.logger.info('Memory state saved');
  }

  // ── Recording (apex_record) ──────────────────────────────────────

  /** Record content into working memory (current session). */
  addToWorking(content: string, sourceFiles?: string[]): MemoryEntry {
    const entry = this.working.add(content, sourceFiles);
    // Auto-consolidate if threshold reached
    if (this.working.stats().count >= this.consolidationThreshold) {
      this.logger.info('Consolidation threshold reached in working memory');
    }
    return entry;
  }

  /** Record an episode directly into episodic memory. */
  async addToEpisodic(entry: MemoryEntry | string): Promise<MemoryEntry> {
    const result = await this.episodic.add(entry);
    this.queueEmbedding(result.id, result.content);
    return result;
  }

  /** Add knowledge to semantic memory. Returns the entry ID. */
  async addToSemantic(
    content: string,
    opts?: { sourceFiles?: string[]; confidence?: number },
  ): Promise<string> {
    const id = await this.semantic.add(content, opts);
    this.queueEmbedding(id, content);
    return id;
  }

  /** Store or update a skill in procedural memory. */
  async addSkill(
    data: Partial<StoredSkill> & Pick<StoredSkill, 'name' | 'description' | 'pattern'>,
  ): Promise<StoredSkill> {
    return this.procedural.addSkill(data);
  }

  /** Record skill usage outcome. */
  async recordSkillUsage(skillId: string, success: boolean): Promise<StoredSkill | null> {
    return this.procedural.recordUsage(skillId, success);
  }

  // ── Retrieval (apex_recall) ──────────────────────────────────────

  /**
   * Cross-tier retrieval: query all tiers, merge, rank, and tag staleness.
   * Searches project memory first, then global if available.
   */
  async recall(query: string, topK = 10): Promise<SearchResult[]> {
    await this.ensureLoaded();

    // Search all tiers in parallel
    const [workingResults, episodicResults, semanticResults, skillResults] = await Promise.all([
      this.searchWorking(query, topK),
      this.episodic.search(query, topK),
      this.semantic.search(query, topK),
      this.searchProcedural(query, topK),
    ]);

    // Merge all results
    let merged: SearchResult[] = [
      ...workingResults,
      ...episodicResults,
      ...semanticResults,
      ...skillResults,
    ];

    // Search global store if available
    if (this.globalStore) {
      const globalResults = await this.searchGlobal(query, topK);
      merged.push(...globalResults);
    }

    // Deduplicate by entry ID
    const seen = new Set<string>();
    merged = merged.filter((r) => {
      if (seen.has(r.entry.id)) return false;
      seen.add(r.entry.id);
      return true;
    });

    // Enhance with hybrid scoring if we have enough results
    if (merged.length > 0) {
      try {
        const queryEmbedding = await getEmbeddingAsync(query, 'auto');
        const hybridInputs: HybridInput[] = merged.map((r) => ({
          id: r.entry.id,
          keywords: extractKeywords(r.entry.content),
          simhash: simHash(r.entry.content),
          embedding: this.embeddingStore.get(r.entry.id) ?? undefined,
          timestamp: r.entry.accessedAt,
        }));

        const queryInput: HybridInput = {
          id: 'query',
          keywords: queryEmbedding.keywords,
          simhash: queryEmbedding.simhash,
          embedding: queryEmbedding.embedding,
        };

        const hybridResults = hybridSearch(queryInput, hybridInputs, undefined, this.bm25Index);

        // Re-rank merged results by hybrid score
        const scoreMap = new Map(hybridResults.map((r) => [r.id, r.score]));
        for (const result of merged) {
          const hybridScore = scoreMap.get(result.entry.id);
          if (hybridScore !== undefined) {
            result.score = hybridScore;
          }
        }
      } catch {
        // Hybrid enhancement failed — continue with original scores
      }
    }

    // Sort by score descending
    merged.sort((a, b) => b.score - a.score);

    // Take top-k
    const topResults = merged.slice(0, topK);

    // Tag staleness
    return this.staleness.tagSearchResults(topResults);
  }

  // ── Skills (apex_skills, apex_skill_store) ───────────────────────

  /** Search skills by query text. */
  async searchSkills(query: string, topK = 10): Promise<Array<{ skill: StoredSkill; score: number }>> {
    await this.ensureLoaded();
    return this.procedural.findByQuery(query, topK);
  }

  /** Get a specific skill by ID. */
  async getSkill(id: string): Promise<StoredSkill | null> {
    await this.ensureLoaded();
    return this.procedural.get(id);
  }

  /** List all active skills. */
  async listSkills(): Promise<StoredSkill[]> {
    await this.ensureLoaded();
    return this.procedural.getAll(false);
  }

  // ── Consolidation (apex_consolidate) ─────────────────────────────

  /**
   * Run the full consolidation pipeline:
   * 1. Auto-snapshot before changes
   * 2. Move working -> episodic
   * 3. Promote episodic -> semantic (entries with high heat + age)
   * 4. Extract skills from repeated success patterns (episodic -> procedural)
   * 5. Archive low-confidence skills
   */
  async consolidate(): Promise<ConsolidationReport> {
    await this.ensureLoaded();

    const tierSizes = await this.getTierSizes();

    // Auto-snapshot before consolidation
    await this.snapshots.autoSnapshot(tierSizes);

    const report: ConsolidationReport = {
      timestamp: Date.now(),
      movedToEpisodic: 0,
      movedToSemantic: 0,
      evicted: 0,
      merged: 0,
    };

    // Step 1: Flush working memory to episodic
    const workingEntries = this.working.getAll();
    for (const entry of workingEntries) {
      const episodicEntry: MemoryEntry = {
        ...entry,
        tier: 'episodic',
      };
      await this.episodic.add(episodicEntry);
      report.movedToEpisodic++;
    }
    this.working.clear();

    // Step 2: Promote high-value episodic entries to semantic
    const allEpisodic = this.episodic.getAll();
    const ageThresholdMs = 24 * 60 * 60 * 1000; // 1 day
    const now = Date.now();
    for (const entry of allEpisodic) {
      const age = now - entry.createdAt;
      if (entry.heatScore > 0.7 && age > ageThresholdMs) {
        await this.semantic.add(entry.content, {
          sourceFiles: entry.sourceFiles,
          confidence: entry.confidence,
        });
        report.movedToSemantic++;
      }
    }

    // Step 3: Archive low-confidence skills
    const archived = await this.procedural.runArchival();
    report.evicted += archived;

    // Persist changes
    await this.save();

    this.eventBus.emit('memory:consolidated', report);
    this.logger.info('Consolidation complete', report);

    return report;
  }

  // ── Snapshots (apex_snapshot, apex_rollback) ─────────────────────

  /** Create a named snapshot. */
  async createSnapshot(name?: string): Promise<Snapshot> {
    const tierSizes = await this.getTierSizes();
    if (name) {
      return this.snapshots.createNamedSnapshot(name, tierSizes);
    }
    return this.snapshots.autoSnapshot(tierSizes);
  }

  /** Restore from a snapshot. */
  async rollback(snapshotId: string): Promise<Snapshot> {
    const result = await this.snapshots.rollback(snapshotId);
    // Reload all tiers from disk
    this.loaded = false;
    await this.init();
    return result;
  }

  /** List all snapshots. */
  async listSnapshots(): Promise<Snapshot[]> {
    return this.snapshots.listSnapshots();
  }

  // ── Status (apex_status) ─────────────────────────────────────────

  /** Get comprehensive memory stats. */
  async status(): Promise<MemoryStats> {
    await this.ensureLoaded();

    const [episodicStats, semanticStats, proceduralStats, snapshotList] = await Promise.all([
      Promise.resolve(this.episodic.stats()),
      Promise.resolve(this.semantic.stats()),
      this.procedural.stats(),
      this.snapshots.listSnapshots(),
    ]);

    return {
      working: this.working.stats(),
      episodic: episodicStats,
      semantic: semanticStats,
      procedural: proceduralStats,
      snapshots: snapshotList.length,
    };
  }

  // ── Staleness ────────────────────────────────────────────────────

  /** Refresh staleness tracker for given files. */
  refreshStaleness(filePaths?: string[]): void {
    this.staleness.refresh(filePaths);
  }

  /** Get staleness stats. */
  stalenessStats() {
    return this.staleness.getStats();
  }

  // ── Accessors for subsystems (used by MCP handlers) ──────────────

  getWorkingMemory(): WorkingMemory { return this.working; }
  getEpisodicMemory(): EpisodicMemory { return this.episodic; }
  getSemanticMemory(): SemanticMemory { return this.semantic; }
  getProceduralMemory(): ProceduralMemory { return this.procedural; }
  getStalenessDetector(): StalenessDetector { return this.staleness; }
  getSnapshotManager(): SnapshotManager { return this.snapshots; }
  getEmbeddingStore(): EmbeddingStore { return this.embeddingStore; }

  // ── Private helpers ──────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.init();
    }
  }

  /** Adapt working memory search to SearchResult format. */
  private searchWorking(query: string, topK: number): SearchResult[] {
    const results = this.working.search(query, topK);
    return results.map((r) => ({
      entry: r.entry as MemoryEntry,
      score: r.score,
      sourceTier: 'working' as MemoryTier,
      source: 'project' as const,
    }));
  }

  /** Adapt procedural memory search to SearchResult format. */
  private async searchProcedural(query: string, topK: number): Promise<SearchResult[]> {
    const results = await this.procedural.findByQuery(query, topK);
    return results.map((r) => ({
      entry: {
        id: r.skill.id,
        content: `[Skill: ${r.skill.name}] ${r.skill.description}\nPattern: ${r.skill.pattern}`,
        heatScore: r.skill.confidence,
        confidence: r.skill.confidence,
        createdAt: r.skill.createdAt,
        accessedAt: r.skill.updatedAt,
        sourceFiles: r.skill.sourceFiles,
        tier: 'procedural' as MemoryTier,
      },
      score: r.score,
      sourceTier: 'procedural' as MemoryTier,
      source: 'project' as const,
    }));
  }

  /** Search the global ~/.apex/ store. */
  private async searchGlobal(query: string, topK: number): Promise<SearchResult[]> {
    if (!this.globalStore) return [];

    // Create a temporary procedural memory for global skills
    const globalProcedural = new ProceduralMemory({ fileStore: this.globalStore });
    await globalProcedural.load();

    const results = await globalProcedural.findByQuery(query, topK);
    return results.map((r) => ({
      entry: {
        id: r.skill.id,
        content: `[Global Skill: ${r.skill.name}] ${r.skill.description}\nPattern: ${r.skill.pattern}`,
        heatScore: r.skill.confidence,
        confidence: r.skill.confidence,
        createdAt: r.skill.createdAt,
        accessedAt: r.skill.updatedAt,
        sourceFiles: r.skill.sourceFiles,
        tier: 'procedural' as MemoryTier,
      },
      score: r.score * 0.9, // Slight discount for global results
      sourceTier: 'procedural' as MemoryTier,
      source: 'global' as const,
    }));
  }

  private async getTierSizes(): Promise<Record<MemoryTier, number>> {
    const [episodicStats, proceduralStats] = await Promise.all([
      Promise.resolve(this.episodic.stats()),
      this.procedural.stats(),
    ]);
    return {
      working: this.working.stats().count,
      episodic: episodicStats.entryCount,
      semantic: this.semantic.stats().entryCount,
      procedural: proceduralStats.total,
    };
  }

  // ── Vector & BM25 Index Management ──────────────────────────────

  /**
   * Build BM25 and HNSW indexes from existing episodic and semantic entries.
   * Called once during init(). L2/HNSW is best-effort — if unavailable,
   * hnswIndex stays null and only BM25 is used.
   */
  private async buildIndexes(): Promise<void> {
    const allEntries: Array<{ id: string; content: string }> = [];

    for (const entry of this.episodic.getAll()) {
      allEntries.push({ id: entry.id, content: entry.content });
    }
    for (const entry of this.semantic.all()) {
      allEntries.push({ id: entry.id, content: entry.content });
    }

    // Populate BM25 index with keywords from all entries
    for (const { id, content } of allEntries) {
      const { keywords } = getEmbedding(content);
      this.bm25Index.addDocument(id, keywords);
    }

    // Try to build HNSW index with L2 embeddings (non-blocking, best-effort)
    try {
      const embedder = getSemanticEmbedder();
      for (const { id, content } of allEntries) {
        const embedding = await embedder.embed(content);
        if (!this.hnswIndex) {
          this.hnswIndex = new HNSWIndex(embedding.length);
        }
        this.hnswIndex.insert(id, embedding);
        this.embeddingStore.set(id, embedding);
      }
    } catch {
      // L2 not available — HNSW stays null, graceful degradation
      this.logger.debug('L2 embeddings unavailable; HNSW index not built');
    }
  }

  /**
   * Queue an entry for async embedding. When the queue reaches 5 items
   * the batch is flushed automatically.
   */
  private queueEmbedding(id: string, content: string): void {
    this.embeddingQueue.push({ id, content });
    if (!this.flushingQueue && this.embeddingQueue.length >= 5) {
      void this.flushEmbeddingQueue();
    }
  }

  /**
   * Flush the embedding queue: compute L2 embeddings and update HNSW / BM25.
   * Gracefully degrades to BM25-only if L2 is unavailable.
   */
  private async flushEmbeddingQueue(): Promise<void> {
    if (this.flushingQueue || this.embeddingQueue.length === 0) return;
    this.flushingQueue = true;

    const batch = this.embeddingQueue.splice(0, 20);
    try {
      const embedder = getSemanticEmbedder();
      for (const item of batch) {
        try {
          const embedding = await embedder.embed(item.content);
          // Add to HNSW index
          if (!this.hnswIndex) {
            this.hnswIndex = new HNSWIndex(embedding.length);
          }
          this.hnswIndex.insert(item.id, embedding);
          // Also store in embedding store
          this.embeddingStore.set(item.id, embedding);
          // Add keywords to BM25
          const { keywords } = getEmbedding(item.content);
          this.bm25Index.addDocument(item.id, keywords);
        } catch {
          // L2 not available — just add to BM25
          const { keywords } = getEmbedding(item.content);
          this.bm25Index.addDocument(item.id, keywords);
        }
      }
    } finally {
      this.flushingQueue = false;
    }

    // Flush remaining if any
    if (this.embeddingQueue.length > 0) {
      void this.flushEmbeddingQueue();
    }
  }
}
