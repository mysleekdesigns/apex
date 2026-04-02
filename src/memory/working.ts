/**
 * Working Memory — the "CPU registers" tier of the APEX memory system.
 *
 * Short-lived context for the current session. Entries are stored in a
 * fixed-capacity ring buffer; when the buffer is full the oldest entry
 * is evicted and an event is emitted so the Memory Manager can promote
 * it to episodic memory.
 */

import { generateId, type MemoryEntry } from '../types.js';
import { RingBuffer } from '../utils/ring-buffer.js';
import { EventBus } from '../utils/event-bus.js';
import { Logger } from '../utils/logger.js';
import {
  getEmbedding,
  extractKeywords,
  simHash,
  simHashSimilarity,
} from '../utils/embeddings.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CAPACITY = 10;
const OVERFLOW_EVENT = 'memory:working-overflow' as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Extended entry that tracks dialogue-chain linkage. */
export interface WorkingMemoryEntry extends MemoryEntry {
  /** ID of the previous entry in the dialogue chain (`undefined` for roots). */
  parentId?: string;
}

export interface WorkingMemoryOptions {
  /** Maximum number of pages in the dialogue queue. @default 10 */
  capacity?: number;
  /** Shared event bus for cross-system communication. */
  eventBus?: EventBus;
  /** Structured logger instance. */
  logger?: Logger;
}

export interface WorkingMemoryStats {
  /** Number of entries currently held. */
  count: number;
  /** Maximum capacity of the buffer. */
  capacity: number;
  /** Whether the buffer is at full capacity. */
  isFull: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class WorkingMemory {
  private readonly buffer: RingBuffer<WorkingMemoryEntry>;
  private readonly capacity: number;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;

  /** Fast lookup from entry id to entry reference. */
  private readonly index = new Map<string, WorkingMemoryEntry>();

  /** Tracks the id of the most recently added entry for dialogue chaining. */
  private lastEntryId: string | undefined;

  constructor(options: WorkingMemoryOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.eventBus = options.eventBus ?? new EventBus();
    this.logger = options.logger ?? new Logger({ prefix: 'working-memory' });
    this.buffer = new RingBuffer<WorkingMemoryEntry>(this.capacity);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Add a new entry to working memory.
   *
   * Creates a `MemoryEntry` from the provided content string, generates an
   * L0+L1 embedding, and pushes it into the ring buffer. If the buffer is
   * full the oldest entry is evicted and a `memory:working-overflow` event
   * is emitted.
   *
   * The new entry is automatically linked to the previous entry in the
   * dialogue chain via `parentId`.
   *
   * @param content - Free-text content for the memory page.
   * @param sourceFiles - Optional file paths associated with this entry.
   * @returns The newly created entry.
   */
  add(content: string, sourceFiles?: string[]): WorkingMemoryEntry {
    const now = Date.now();
    const embedding = getEmbedding(content, 'fast');

    const entry: WorkingMemoryEntry = {
      id: generateId(),
      content,
      embedding: embedding.embedding,
      heatScore: 1.0,
      confidence: 1.0,
      createdAt: now,
      accessedAt: now,
      tier: 'working',
      sourceFiles,
      parentId: this.lastEntryId,
    };

    const evicted = this.buffer.push(entry);
    this.index.set(entry.id, entry);

    if (evicted) {
      this.index.delete(evicted.id);
      this.logger.debug('Entry evicted from working memory', { id: evicted.id });
      this.eventBus.emit(OVERFLOW_EVENT, evicted);
    }

    this.lastEntryId = entry.id;
    this.logger.debug('Entry added to working memory', { id: entry.id });

    return entry;
  }

  /**
   * Retrieve the full dialogue chain leading up to (and including) a given entry.
   *
   * Walks the `parentId` links from the specified entry back to the root,
   * returning entries in chronological order (oldest first).
   *
   * @param entryId - The id of the entry whose chain to retrieve.
   * @returns Ordered array of entries from root to the specified entry.
   *          Empty array if the entry is not found.
   */
  getChain(entryId: string): WorkingMemoryEntry[] {
    const chain: WorkingMemoryEntry[] = [];
    let current = this.index.get(entryId);

    while (current) {
      chain.push(current);
      current = current.parentId ? this.index.get(current.parentId) : undefined;
    }

    chain.reverse();
    return chain;
  }

  /**
   * Return all current pages in the session, oldest first.
   *
   * @returns Array of all working memory entries currently held.
   */
  getAll(): WorkingMemoryEntry[] {
    return this.buffer.toArray();
  }

  /**
   * Search working memory by keyword / similarity match.
   *
   * Scoring combines keyword overlap (Jaccard-like) and SimHash similarity.
   * Results are sorted by descending score.
   *
   * @param query - Free-text search query.
   * @param topK - Maximum number of results to return. @default 5
   * @returns Top-k entries sorted by relevance score.
   */
  search(query: string, topK: number = 5): Array<{ entry: WorkingMemoryEntry; score: number }> {
    const entries = this.buffer.toArray();
    if (entries.length === 0) return [];

    const queryKeywords = new Set(extractKeywords(query));
    const queryHash = simHash(query);

    const scored = entries.map((entry) => {
      // Keyword overlap (Jaccard-ish: intersection / union)
      const entryKeywords = new Set(extractKeywords(entry.content));
      const intersection = [...queryKeywords].filter((k) => entryKeywords.has(k)).length;
      const union = new Set([...queryKeywords, ...entryKeywords]).size;
      const keywordScore = union > 0 ? intersection / union : 0;

      // SimHash similarity
      const entryHash = simHash(entry.content);
      const hashScore = simHashSimilarity(queryHash, entryHash);

      // Combined score: weighted average (keywords are more precise, weight higher)
      const score = keywordScore * 0.6 + hashScore * 0.4;

      // Bump accessedAt on search hit
      entry.accessedAt = Date.now();

      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Clear all entries and reset the dialogue chain for a new session.
   */
  clear(): void {
    this.buffer.clear();
    this.index.clear();
    this.lastEntryId = undefined;
    this.logger.info('Working memory cleared');
  }

  /**
   * Return current working memory statistics.
   */
  stats(): WorkingMemoryStats {
    return {
      count: this.buffer.length,
      capacity: this.capacity,
      isFull: this.buffer.isFull,
    };
  }
}
