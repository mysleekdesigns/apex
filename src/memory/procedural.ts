/**
 * Procedural Memory — Skill Library (Disk Tier)
 *
 * File-backed, unbounded skill registry with usage-decay archival.
 * Stores learned capabilities distilled from successful episodes and
 * supports retrieval by task similarity, name, or tags.
 */

import { generateId, type Skill } from '../types.js';
import { getEmbedding, type EmbeddingResult } from '../utils/embeddings.js';
import { combinedSimilarity } from '../utils/similarity.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Extended skill record with archival flag and cached embedding.
 * This is the shape persisted to disk via FileStore.
 */
export interface StoredSkill extends Skill {
  /** Whether this skill has been archived due to low confidence. */
  archived?: boolean;

  /** Cached embedding built from name + description + tags. */
  embedding?: { keywords: string[]; simhash: bigint };

  /** IDs of component skills (for compound skills). */
  components?: string[];
}

/** Options accepted by the ProceduralMemory constructor. */
interface ProceduralMemoryOptions {
  fileStore?: FileStore;
  logger?: Logger;
  /** Confidence threshold below which a skill is archived. Default 0.2. */
  archiveThreshold?: number;
}

/** Aggregate statistics about the skill library. */
interface ProceduralStats {
  total: number;
  active: number;
  archived: number;
  avgConfidence: number;
  avgSuccessRate: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'skills';
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Procedural Memory manages the agent's learned skill library.
 *
 * Skills are persisted individually via {@link FileStore} and indexed in
 * memory for fast lookup by name, tags, and semantic similarity.
 */
export class ProceduralMemory {
  private readonly fileStore: FileStore | undefined;
  private readonly logger: Logger;
  private readonly archiveThreshold: number;

  /** Primary in-memory index: skill id -> StoredSkill. */
  private skills: Map<string, StoredSkill> = new Map();

  /** Secondary index: lowercase skill name -> skill id. */
  private nameIndex: Map<string, string> = new Map();

  /** Secondary index: tag -> Set of skill ids. */
  private tagIndex: Map<string, Set<string>> = new Map();

  /** Whether the in-memory index has been hydrated from disk. */
  private loaded = false;

  constructor(options: ProceduralMemoryOptions = {}) {
    this.fileStore = options.fileStore;
    this.logger = options.logger ?? new Logger({ prefix: 'procedural' });
    this.archiveThreshold = options.archiveThreshold ?? 0.2;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Load all skills from disk into the in-memory index.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.fileStore) {
      this.loaded = true;
      return;
    }

    const items = await this.fileStore.readAll<StoredSkill>(COLLECTION);
    for (const skill of items) {
      this.indexSkill(skill);
    }

    this.loaded = true;
    this.logger.info(`Loaded ${this.skills.size} skills from disk`);
  }

  // -----------------------------------------------------------------------
  // Add / Update
  // -----------------------------------------------------------------------

  /**
   * Add a new skill to the library.
   *
   * Missing fields (id, timestamps, confidence) are auto-populated.
   * The skill is persisted to disk and indexed in memory.
   *
   * @param data - Full or partial skill data.
   * @returns The fully-populated StoredSkill.
   */
  async addSkill(data: Partial<StoredSkill> & Pick<StoredSkill, 'name' | 'description' | 'pattern'>): Promise<StoredSkill> {
    await this.ensureLoaded();

    const now = Date.now();
    const skill: StoredSkill = {
      id: data.id ?? generateId(),
      name: data.name,
      description: data.description,
      preconditions: data.preconditions ?? [],
      pattern: data.pattern,
      successRate: data.successRate ?? 1,
      usageCount: data.usageCount ?? 0,
      confidence: data.confidence ?? 0.5,
      sourceProject: data.sourceProject ?? '',
      sourceFiles: data.sourceFiles ?? [],
      createdAt: data.createdAt ?? now,
      updatedAt: data.updatedAt ?? now,
      tags: data.tags ?? [],
      archived: data.archived ?? false,
      components: data.components,
      embedding: this.buildEmbedding(data.name, data.description, data.tags ?? []),
    };

    this.indexSkill(skill);
    await this.persist(skill);

    this.logger.info(`Added skill "${skill.name}" (${skill.id})`);
    return skill;
  }

  /**
   * Update fields on an existing skill.
   *
   * @param id - Skill ID to update.
   * @param updates - Partial fields to merge.
   * @returns The updated StoredSkill, or null if not found.
   */
  async updateSkill(id: string, updates: Partial<StoredSkill>): Promise<StoredSkill | null> {
    await this.ensureLoaded();

    const existing = this.skills.get(id);
    if (!existing) {
      this.logger.warn(`updateSkill: skill ${id} not found`);
      return null;
    }

    // Remove old secondary index entries before mutation
    this.removeFromSecondaryIndexes(existing);

    const updated: StoredSkill = { ...existing, ...updates, id, updatedAt: Date.now() };

    // Rebuild embedding if name, description, or tags changed
    if (updates.name !== undefined || updates.description !== undefined || updates.tags !== undefined) {
      updated.embedding = this.buildEmbedding(updated.name, updated.description, updated.tags);
    }

    this.indexSkill(updated);
    await this.persist(updated);

    this.logger.debug(`Updated skill "${updated.name}" (${id})`);
    return updated;
  }

  // -----------------------------------------------------------------------
  // Record usage
  // -----------------------------------------------------------------------

  /**
   * Record a usage of a skill and update its statistics.
   *
   * - Increments usageCount
   * - Recomputes successRate as a rolling average
   * - Recomputes confidence from (successRate, usageCount, recency)
   * - Archives the skill if confidence drops below threshold
   *
   * @param id - Skill ID.
   * @param success - Whether the usage succeeded.
   * @returns The updated StoredSkill, or null if not found.
   */
  async recordUsage(id: string, success: boolean): Promise<StoredSkill | null> {
    await this.ensureLoaded();

    const skill = this.skills.get(id);
    if (!skill) {
      this.logger.warn(`recordUsage: skill ${id} not found`);
      return null;
    }

    const newCount = skill.usageCount + 1;
    const newSuccessRate = (skill.successRate * skill.usageCount + (success ? 1 : 0)) / newCount;
    const now = Date.now();
    const newConfidence = this.computeConfidence(newSuccessRate, newCount, now);

    return this.updateSkill(id, {
      usageCount: newCount,
      successRate: newSuccessRate,
      confidence: newConfidence,
      archived: newConfidence < this.archiveThreshold,
    });
  }

  // -----------------------------------------------------------------------
  // Skill composition
  // -----------------------------------------------------------------------

  /**
   * Create a compound skill from existing atomic skills.
   *
   * The compound skill's success rate is the product of its components'
   * success rates (conservative estimate).
   *
   * @param data - Skill data for the compound skill. Must include `components`.
   * @returns The new compound StoredSkill.
   */
  async composeSkill(
    data: Partial<StoredSkill> & Pick<StoredSkill, 'name' | 'description' | 'pattern' | 'components'>,
  ): Promise<StoredSkill> {
    await this.ensureLoaded();

    const componentIds = data.components ?? [];
    const components: StoredSkill[] = [];
    for (const cid of componentIds) {
      const c = this.skills.get(cid);
      if (c) components.push(c);
    }

    // Conservative success rate: product of component success rates
    const composedSuccessRate = components.length > 0
      ? components.reduce((acc, c) => acc * c.successRate, 1)
      : data.successRate ?? 1;

    return this.addSkill({
      ...data,
      successRate: composedSuccessRate,
      components: componentIds,
    });
  }

  // -----------------------------------------------------------------------
  // Retrieval
  // -----------------------------------------------------------------------

  /**
   * Find skills by semantic similarity to a query string.
   *
   * Computes an embedding for the query and ranks all active skills
   * by combined similarity (keyword Jaccard + SimHash).
   *
   * @param query - Natural-language description of the task.
   * @param topK - Maximum number of results to return. Default 5.
   * @param includeArchived - Whether to include archived skills. Default false.
   * @returns Skills sorted by descending similarity score.
   */
  async findByQuery(
    query: string,
    topK = 5,
    includeArchived = false,
  ): Promise<Array<{ skill: StoredSkill; score: number }>> {
    await this.ensureLoaded();

    const queryEmbedding = this.buildEmbedding(query, '', []);
    const results: Array<{ skill: StoredSkill; score: number }> = [];

    for (const skill of this.skills.values()) {
      if (!includeArchived && skill.archived) continue;
      if (!skill.embedding) continue;

      const score = combinedSimilarity(queryEmbedding, skill.embedding);
      results.push({ skill, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Look up a skill by exact name (case-insensitive).
   *
   * @param name - Skill name to match.
   * @returns The matching StoredSkill, or null.
   */
  async findByName(name: string): Promise<StoredSkill | null> {
    await this.ensureLoaded();
    const id = this.nameIndex.get(name.toLowerCase());
    return id ? (this.skills.get(id) ?? null) : null;
  }

  /**
   * Find skills that have ALL of the specified tags.
   *
   * @param tags - Tags to match (intersection).
   * @param includeArchived - Whether to include archived skills. Default false.
   * @returns Skills that contain every specified tag.
   */
  async findByTags(tags: string[], includeArchived = false): Promise<StoredSkill[]> {
    await this.ensureLoaded();

    if (tags.length === 0) return [];

    // Start with the smallest candidate set
    const candidateSets = tags
      .map((t) => this.tagIndex.get(t.toLowerCase()) ?? new Set<string>())
      .sort((a, b) => a.size - b.size);

    const intersection = new Set(candidateSets[0]);
    for (let i = 1; i < candidateSets.length; i++) {
      for (const id of intersection) {
        if (!candidateSets[i].has(id)) intersection.delete(id);
      }
    }

    const results: StoredSkill[] = [];
    for (const id of intersection) {
      const skill = this.skills.get(id);
      if (skill && (includeArchived || !skill.archived)) {
        results.push(skill);
      }
    }

    return results;
  }

  /**
   * Get a skill by ID.
   *
   * @param id - Skill ID.
   * @returns The StoredSkill, or null if not found.
   */
  async get(id: string): Promise<StoredSkill | null> {
    await this.ensureLoaded();
    return this.skills.get(id) ?? null;
  }

  /**
   * Return all skills (optionally including archived).
   *
   * @param includeArchived - Whether to include archived skills. Default false.
   */
  async getAll(includeArchived = false): Promise<StoredSkill[]> {
    await this.ensureLoaded();
    const all = [...this.skills.values()];
    return includeArchived ? all : all.filter((s) => !s.archived);
  }

  /**
   * Delete a skill from the library and disk.
   *
   * @param id - Skill ID to remove.
   */
  async deleteSkill(id: string): Promise<void> {
    await this.ensureLoaded();

    const skill = this.skills.get(id);
    if (!skill) return;

    this.removeFromSecondaryIndexes(skill);
    this.skills.delete(id);

    if (this.fileStore) {
      await this.fileStore.delete(COLLECTION, id);
    }

    this.logger.info(`Deleted skill "${skill.name}" (${id})`);
  }

  // -----------------------------------------------------------------------
  // Archival
  // -----------------------------------------------------------------------

  /**
   * Scan all skills and archive those whose confidence has decayed below
   * the threshold. Confidence is recomputed based on current time.
   *
   * @returns Number of skills newly archived.
   */
  async runArchival(): Promise<number> {
    await this.ensureLoaded();

    const now = Date.now();
    let count = 0;

    for (const skill of this.skills.values()) {
      if (skill.archived) continue;

      const freshConfidence = this.computeConfidence(skill.successRate, skill.usageCount, now, skill.updatedAt);
      if (freshConfidence < this.archiveThreshold) {
        await this.updateSkill(skill.id, {
          confidence: freshConfidence,
          archived: true,
        });
        count++;
      }
    }

    if (count > 0) {
      this.logger.info(`Archived ${count} skills below confidence threshold ${this.archiveThreshold}`);
    }

    return count;
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  /**
   * Compute aggregate statistics about the skill library.
   */
  async stats(): Promise<ProceduralStats> {
    await this.ensureLoaded();

    const all = [...this.skills.values()];
    const active = all.filter((s) => !s.archived);
    const archived = all.filter((s) => s.archived);

    const avgConfidence = all.length > 0
      ? all.reduce((sum, s) => sum + s.confidence, 0) / all.length
      : 0;

    const avgSuccessRate = all.length > 0
      ? all.reduce((sum, s) => sum + s.successRate, 0) / all.length
      : 0;

    return {
      total: all.length,
      active: active.length,
      archived: archived.length,
      avgConfidence,
      avgSuccessRate,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Ensure the in-memory index is hydrated from disk. */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /** Persist a single skill to disk via FileStore. */
  private async persist(skill: StoredSkill): Promise<void> {
    if (!this.fileStore) return;

    // BigInt is not JSON-serializable, so we convert the simhash to a string
    // for persistence and reconstruct it on load.
    const serializable = {
      ...skill,
      embedding: skill.embedding
        ? { keywords: skill.embedding.keywords, simhash: String(skill.embedding.simhash) }
        : undefined,
    };

    await this.fileStore.write(COLLECTION, skill.id, serializable);
  }

  /** Add a skill to all in-memory indexes. */
  private indexSkill(skill: StoredSkill): void {
    // Reconstruct bigint from serialized string if needed
    if (skill.embedding && typeof skill.embedding.simhash === 'string') {
      skill.embedding.simhash = BigInt(skill.embedding.simhash as unknown as string);
    }

    this.skills.set(skill.id, skill);
    this.nameIndex.set(skill.name.toLowerCase(), skill.id);

    for (const tag of skill.tags) {
      const key = tag.toLowerCase();
      let ids = this.tagIndex.get(key);
      if (!ids) {
        ids = new Set();
        this.tagIndex.set(key, ids);
      }
      ids.add(skill.id);
    }
  }

  /** Remove a skill from secondary indexes (name + tags). */
  private removeFromSecondaryIndexes(skill: StoredSkill): void {
    this.nameIndex.delete(skill.name.toLowerCase());
    for (const tag of skill.tags) {
      const key = tag.toLowerCase();
      const ids = this.tagIndex.get(key);
      if (ids) {
        ids.delete(skill.id);
        if (ids.size === 0) this.tagIndex.delete(key);
      }
    }
  }

  /**
   * Build an embedding from a skill's name, description, and tags.
   * Combines them into a single text block for keyword + simhash extraction.
   */
  private buildEmbedding(name: string, description: string, tags: string[]): EmbeddingResult {
    const text = [name, description, ...tags].filter(Boolean).join(' ');
    return getEmbedding(text);
  }

  /**
   * Compute confidence score from success rate, usage count, and recency.
   *
   * confidence = 0.5 * successRate + 0.3 * usageWeight + 0.2 * recencyWeight
   *
   * where:
   * - usageWeight = min(1, log(usageCount + 1) / log(51))  (saturates at 50 uses)
   * - recencyWeight = exp(-0.05 * daysSinceUpdate)
   *
   * @param successRate - Current success rate in [0, 1].
   * @param usageCount - Number of times the skill has been used.
   * @param now - Current timestamp in ms.
   * @param updatedAt - Last update timestamp in ms. Defaults to now.
   */
  private computeConfidence(
    successRate: number,
    usageCount: number,
    now: number,
    updatedAt?: number,
  ): number {
    const usageWeight = Math.min(1, Math.log(usageCount + 1) / Math.log(51));
    const daysSinceUpdate = (now - (updatedAt ?? now)) / MS_PER_DAY;
    const recencyWeight = Math.exp(-0.05 * daysSinceUpdate);

    return 0.5 * successRate + 0.3 * usageWeight + 0.2 * recencyWeight;
  }
}
