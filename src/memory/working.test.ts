import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkingMemory, type WorkingMemoryEntry } from './working.js';
import { EventBus } from '../utils/event-bus.js';

// Mock embeddings module to avoid heavy computation in tests
vi.mock('../utils/embeddings.js', () => ({
  getEmbedding: vi.fn((text: string) => ({
    keywords: text.split(/\s+/).slice(0, 5),
    simhash: BigInt(0),
    embedding: undefined,
  })),
  extractKeywords: vi.fn((text: string) => text.toLowerCase().split(/\s+/).filter(Boolean)),
  simHash: vi.fn(() => BigInt(0)),
  simHashSimilarity: vi.fn(() => 0.5),
}));

describe('WorkingMemory', () => {
  let wm: WorkingMemory;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    wm = new WorkingMemory({ capacity: 3, eventBus });
  });

  describe('add', () => {
    it('creates an entry with correct properties', () => {
      const entry = wm.add('test content');
      expect(entry.id).toBeDefined();
      expect(entry.content).toBe('test content');
      expect(entry.tier).toBe('working');
      expect(entry.heatScore).toBe(1.0);
      expect(entry.confidence).toBe(1.0);
      expect(entry.createdAt).toBeGreaterThan(0);
    });

    it('links entries via parentId (dialogue chain)', () => {
      const e1 = wm.add('first');
      const e2 = wm.add('second');
      const e3 = wm.add('third');

      expect(e1.parentId).toBeUndefined();
      expect(e2.parentId).toBe(e1.id);
      expect(e3.parentId).toBe(e2.id);
    });

    it('associates sourceFiles when provided', () => {
      const entry = wm.add('content', ['file1.ts', 'file2.ts']);
      expect(entry.sourceFiles).toEqual(['file1.ts', 'file2.ts']);
    });
  });

  describe('FIFO overflow', () => {
    it('emits overflow event when capacity exceeded', () => {
      const overflowed: WorkingMemoryEntry[] = [];
      eventBus.on('memory:working-overflow', (entry: unknown) => {
        overflowed.push(entry as WorkingMemoryEntry);
      });

      wm.add('a');
      wm.add('b');
      wm.add('c');
      expect(overflowed).toHaveLength(0);

      wm.add('d'); // evicts 'a'
      expect(overflowed).toHaveLength(1);
      expect(overflowed[0].content).toBe('a');
    });

    it('maintains capacity after overflow', () => {
      wm.add('a');
      wm.add('b');
      wm.add('c');
      wm.add('d');
      wm.add('e');

      const stats = wm.stats();
      expect(stats.count).toBe(3);
      expect(stats.isFull).toBe(true);
    });
  });

  describe('getChain', () => {
    it('returns dialogue chain in chronological order', () => {
      const e1 = wm.add('first');
      const e2 = wm.add('second');
      const e3 = wm.add('third');

      const chain = wm.getChain(e3.id);
      expect(chain).toHaveLength(3);
      expect(chain[0].content).toBe('first');
      expect(chain[1].content).toBe('second');
      expect(chain[2].content).toBe('third');
    });

    it('returns partial chain for mid-sequence entry', () => {
      const e1 = wm.add('first');
      const e2 = wm.add('second');
      wm.add('third');

      const chain = wm.getChain(e2.id);
      expect(chain).toHaveLength(2);
      expect(chain[0].content).toBe('first');
      expect(chain[1].content).toBe('second');
    });

    it('returns empty array for unknown id', () => {
      expect(wm.getChain('nonexistent')).toEqual([]);
    });
  });

  describe('getAll', () => {
    it('returns all entries oldest-first', () => {
      wm.add('a');
      wm.add('b');
      wm.add('c');

      const all = wm.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].content).toBe('a');
      expect(all[2].content).toBe('c');
    });

    it('returns empty array when empty', () => {
      expect(wm.getAll()).toEqual([]);
    });
  });

  describe('search', () => {
    it('returns results sorted by score descending', () => {
      wm.add('typescript error handling patterns');
      wm.add('react component lifecycle');
      wm.add('typescript type inference');

      const results = wm.search('typescript');
      expect(results.length).toBeGreaterThan(0);
      // Scores should be descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('respects topK limit', () => {
      wm.add('a');
      wm.add('b');
      wm.add('c');

      const results = wm.search('test', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty for empty memory', () => {
      expect(wm.search('anything')).toEqual([]);
    });
  });

  describe('clear', () => {
    it('removes all entries and resets chain', () => {
      wm.add('a');
      wm.add('b');
      wm.clear();

      expect(wm.stats().count).toBe(0);
      expect(wm.getAll()).toEqual([]);

      // New entries after clear should have no parent
      const e = wm.add('fresh');
      expect(e.parentId).toBeUndefined();
    });
  });

  describe('stats', () => {
    it('reports correct stats', () => {
      expect(wm.stats()).toEqual({ count: 0, capacity: 3, isFull: false });

      wm.add('a');
      wm.add('b');
      wm.add('c');
      expect(wm.stats()).toEqual({ count: 3, capacity: 3, isFull: true });
    });
  });
});
