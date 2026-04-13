/**
 * Team Knowledge Tier for APEX Multi-Agent Knowledge Sharing (Phase 18)
 *
 * Manages the `.apex-shared/` directory — a git-tracked shared knowledge
 * store with categories for skills, knowledge, error-taxonomy, and proposals.
 * Privacy boundary: only distilled knowledge is shared, never raw episodes.
 *
 * Pure data operations — zero LLM calls.
 */

import path from 'node:path';
import { generateId } from '../types.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid categories for shared knowledge entries. */
export type KnowledgeCategory = 'skill' | 'knowledge' | 'error-taxonomy';

/** The three content categories plus the proposals collection. */
const CONTENT_CATEGORIES: readonly KnowledgeCategory[] = [
  'skill',
  'knowledge',
  'error-taxonomy',
] as const;

/** Collection names used in the FileStore. */
const COLLECTIONS = ['skills', 'knowledge', 'error-taxonomy', 'proposals', 'changelog'] as const;

/** Maps a category value to its FileStore collection name. */
function categoryToCollection(category: KnowledgeCategory): string {
  switch (category) {
    case 'skill':
      return 'skills';
    case 'knowledge':
      return 'knowledge';
    case 'error-taxonomy':
      return 'error-taxonomy';
  }
}

/** A shared knowledge entry visible to the entire team. */
export interface SharedKnowledge {
  /** Unique identifier. */
  id: string;
  /** The knowledge content (free-form text). */
  content: string;
  /** Category this entry belongs to. */
  category: KnowledgeCategory;
  /** Who contributed this entry. */
  author: string;
  /** Project path where this knowledge originated. */
  sourceProject: string;
  /** Free-form tags for retrieval. */
  tags: string[];
  /** Confidence that this knowledge is accurate, in `[0, 1]`. */
  confidence: number;
  /** Unix-epoch millisecond timestamp of creation. */
  createdAt: number;
  /** Unix-epoch millisecond timestamp of last update. */
  updatedAt: number;
}

/** Stats about the team knowledge tier. */
export interface TeamKnowledgeStats {
  skillCount: number;
  knowledgeCount: number;
  errorTaxonomyCount: number;
  proposalCount: number;
  totalEntries: number;
  /** Unix-epoch millisecond timestamp of the most recent update across all entries. */
  lastUpdated: number;
}

/** A single changelog record. */
export interface ChangelogEntry {
  id: string;
  action: string;
  category: string;
  entryId: string;
  author: string;
  timestamp: number;
}

/** Options for constructing a {@link KnowledgeTier}. */
export interface KnowledgeTierOptions {
  /** Absolute path to the project root. */
  projectPath: string;
  /** Author name for changelog entries. Defaults to `'anonymous'`. */
  author?: string;
  /** Logger instance. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Manages the `.apex-shared/` team knowledge directory.
 *
 * Provides CRUD operations over categorised knowledge entries plus a
 * simple keyword search and an append-only changelog.
 */
export class KnowledgeTier {
  /** Absolute path to the `.apex-shared/` directory. */
  readonly sharedPath: string;

  /** Underlying file-based store. */
  readonly store: FileStore;

  private readonly author: string;
  private readonly logger: Logger;

  constructor(options: KnowledgeTierOptions) {
    this.sharedPath = path.join(options.projectPath, '.apex-shared');
    this.author = options.author ?? 'anonymous';
    this.logger = options.logger ?? new Logger({ prefix: 'apex:knowledge-tier' });
    this.store = new FileStore(this.sharedPath, { logger: this.logger });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialise the `.apex-shared/` directory structure.
   *
   * Creates subdirectories for each collection if they do not already exist.
   */
  async init(): Promise<void> {
    // FileStore.init() only creates its hard-coded collections, so we create
    // ours manually via a write to each — the FileStore lazily creates dirs.
    // Instead, we just ensure directories exist by calling the store's init
    // (which is a no-op for unknown collections) and then do our own mkdirs.
    const { mkdir } = await import('fs/promises');
    for (const col of COLLECTIONS) {
      await mkdir(path.join(this.sharedPath, col), { recursive: true });
    }
    this.logger.info('Knowledge tier initialised', { path: this.sharedPath });
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Add a new shared knowledge entry.
   *
   * @param entry - Entry data (without `id`, `createdAt`, or `updatedAt`).
   * @returns The fully-populated {@link SharedKnowledge} that was persisted.
   */
  async addEntry(
    entry: Omit<SharedKnowledge, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<SharedKnowledge> {
    const now = Date.now();
    const full: SharedKnowledge = {
      ...entry,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };

    const collection = categoryToCollection(full.category);
    await this.store.write(collection, full.id, full);
    await this.logChange('add', full.category, full.id);
    this.logger.info('Added shared knowledge entry', { id: full.id, category: full.category });
    return full;
  }

  /**
   * Retrieve a single entry by category and ID.
   *
   * @returns The entry, or `null` if not found.
   */
  async getEntry(category: string, id: string): Promise<SharedKnowledge | null> {
    return this.store.read<SharedKnowledge>(category, id);
  }

  /**
   * List all entries, optionally filtered by category.
   *
   * When no category is given, entries from all three content categories are
   * merged and sorted by `updatedAt` descending.
   */
  async listEntries(category?: KnowledgeCategory): Promise<SharedKnowledge[]> {
    if (category) {
      const col = categoryToCollection(category);
      return this.store.readAll<SharedKnowledge>(col);
    }

    const all: SharedKnowledge[] = [];
    for (const cat of CONTENT_CATEGORIES) {
      const col = categoryToCollection(cat);
      const entries = await this.store.readAll<SharedKnowledge>(col);
      all.push(...entries);
    }
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return all;
  }

  /**
   * Remove an entry by category and ID.
   *
   * @returns `true` if the entry existed and was deleted, `false` otherwise.
   */
  async removeEntry(category: string, id: string): Promise<boolean> {
    const existing = await this.store.read<SharedKnowledge>(category, id);
    if (!existing) return false;

    await this.store.delete(category, id);
    await this.logChange('remove', category, id);
    this.logger.info('Removed shared knowledge entry', { id, category });
    return true;
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Simple keyword search across entry content and tags.
   *
   * Scores entries by the number of query words that appear in the content or
   * tags (case-insensitive). Results are returned sorted by score descending.
   *
   * @param query    - Free-text search query.
   * @param category - Optional category filter.
   */
  async searchEntries(query: string, category?: KnowledgeCategory): Promise<SharedKnowledge[]> {
    const entries = await this.listEntries(category);
    const queryWords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (queryWords.length === 0) return entries;

    const scored = entries.map((entry) => {
      const haystack = [entry.content, ...entry.tags].join(' ').toLowerCase();
      let score = 0;
      for (const word of queryWords) {
        if (haystack.includes(word)) score += 1;
      }
      return { entry, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.entry);
  }

  // -------------------------------------------------------------------------
  // Stats & Changelog
  // -------------------------------------------------------------------------

  /** Compute summary statistics for the knowledge tier. */
  async getStats(): Promise<TeamKnowledgeStats> {
    const [skills, knowledge, errorTaxonomy, proposals] = await Promise.all([
      this.store.list('skills'),
      this.store.list('knowledge'),
      this.store.list('error-taxonomy'),
      this.store.list('proposals'),
    ]);

    const allEntries = await this.listEntries();
    const lastUpdated =
      allEntries.length > 0
        ? Math.max(...allEntries.map((e) => e.updatedAt))
        : 0;

    return {
      skillCount: skills.length,
      knowledgeCount: knowledge.length,
      errorTaxonomyCount: errorTaxonomy.length,
      proposalCount: proposals.length,
      totalEntries: skills.length + knowledge.length + errorTaxonomy.length,
      lastUpdated,
    };
  }

  /**
   * Return the most recent changelog entries.
   *
   * @param limit - Maximum number of entries to return (default `20`).
   */
  async getChangelog(
    limit: number = 20,
  ): Promise<Array<{ id: string; action: string; category: string; author: string; timestamp: number }>> {
    const entries = await this.store.readAll<ChangelogEntry>('changelog');
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries.slice(0, limit).map(({ id, action, category, author, timestamp }) => ({
      id,
      action,
      category,
      author,
      timestamp,
    }));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Append a record to the changelog collection.
   *
   * @param action   - What happened (e.g. `"add"`, `"remove"`, `"accept"`).
   * @param category - The affected category.
   * @param entryId  - The ID of the affected entry.
   */
  private async logChange(action: string, category: string, entryId: string): Promise<void> {
    const record: ChangelogEntry = {
      id: generateId(),
      action,
      category,
      entryId,
      author: this.author,
      timestamp: Date.now(),
    };
    await this.store.write('changelog', record.id, record);
  }
}
