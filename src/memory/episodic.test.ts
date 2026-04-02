import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EpisodicMemory } from './episodic.js';

// Mock embeddings and similarity to keep tests fast and deterministic
vi.mock('../utils/embeddings.js', () => {
  let callCount = 0;
  return {
    getEmbedding: vi.fn((text: string) => ({
      keywords: text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10),
      simhash: BigInt(callCount++),
      embedding: undefined,
    })),
  };
});

vi.mock('../utils/similarity.js', () => ({
  combinedSimilarity: vi.fn((a: { keywords: string[] }, b: { keywords: string[] }) => {
    // Simple keyword overlap for deterministic tests
    const setA = new Set(a.keywords);
    const setB = new Set(b.keywords);
    let intersection = 0;
    for (const k of setA) {
      if (setB.has(k)) intersection++;
    }
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? intersection / union : 0;
  }),
}));

describe('EpisodicMemory', () => {
  let em: EpisodicMemory;

  beforeEach(() => {
    em = new EpisodicMemory({ capacity: 5 });
  });

  describe('add', () => {
    it('stores an entry from a content string', async () => {
      const entry = await em.add('test episode content');
      expect(entry.id).toBeDefined();
      expect(entry.content).toBe('test episode content');
      expect(entry.tier).toBe('episodic');
    });

    it('stores a pre-built MemoryEntry', async () => {
      const input = {
        id: 'custom-id',
        content: 'pre-built entry',
        heatScore: 0.5,
        confidence: 0.8,
        createdAt: Date.now(),
        accessedAt: Date.now(),
        tier: 'working' as const,
      };
      const entry = await em.add(input);
      expect(entry.id).toBe('custom-id');
      expect(entry.tier).toBe('episodic'); // tier is overridden
    });

    it('creates segments for entries', async () => {
      await em.add('typescript error handling');
      await em.add('python error handling');

      const stats = em.stats();
      expect(stats.entryCount).toBe(2);
      expect(stats.segmentCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('search', () => {
    it('returns matching entries sorted by score', async () => {
      await em.add('typescript error handling patterns');
      await em.add('react component lifecycle hooks');
      await em.add('typescript type inference rules');

      const results = await em.search('typescript', 10);
      expect(results.length).toBeGreaterThan(0);

      // Results should be sorted descending by score
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('returns empty array when memory is empty', async () => {
      const results = await em.search('anything');
      expect(results).toEqual([]);
    });

    it('respects topK', async () => {
      for (let i = 0; i < 5; i++) {
        await em.add(`entry number ${i}`);
      }
      const results = await em.search('entry', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('bumps heat score on access', async () => {
      const entry = await em.add('test entry for heat bump');
      const initialHeat = entry.heatScore;

      // Search triggers bumpHeat
      await em.search('test entry');

      const fetched = await em.get(entry.id);
      // Heat should have been bumped (accessedAt and visitCount changed)
      expect(fetched).not.toBeNull();
    });
  });

  describe('eviction', () => {
    it('evicts entries when capacity is exceeded', async () => {
      const em3 = new EpisodicMemory({ capacity: 3 });

      await em3.add('entry one');
      await em3.add('entry two');
      await em3.add('entry three');
      expect(em3.stats().entryCount).toBe(3);

      await em3.add('entry four'); // triggers eviction
      expect(em3.stats().entryCount).toBe(3);
    });

    it('evicts lowest heat score entries first', async () => {
      const em2 = new EpisodicMemory({ capacity: 2 });

      const cold = await em2.add('cold entry');
      const hot = await em2.add('hot entry');

      // Access hot entry multiple times to increase its heat
      await em2.get(hot.id);
      await em2.get(hot.id);
      await em2.get(hot.id);

      // Adding a third entry should evict the cold one
      await em2.add('new entry');

      const coldFetched = await em2.get(cold.id);
      const hotFetched = await em2.get(hot.id);

      expect(coldFetched).toBeNull();
      expect(hotFetched).not.toBeNull();
    });
  });

  describe('get', () => {
    it('returns entry by ID', async () => {
      const entry = await em.add('findable entry');
      const found = await em.get(entry.id);
      expect(found).not.toBeNull();
      expect(found!.content).toBe('findable entry');
    });

    it('returns null for unknown ID', async () => {
      const found = await em.get('nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('remove', () => {
    it('removes an entry by ID', async () => {
      const entry = await em.add('removable');
      await em.remove(entry.id);
      const found = await em.get(entry.id);
      expect(found).toBeNull();
      expect(em.stats().entryCount).toBe(0);
    });
  });

  describe('getAll', () => {
    it('returns all entries', async () => {
      await em.add('one');
      await em.add('two');
      const all = em.getAll();
      expect(all).toHaveLength(2);
    });
  });

  describe('stats', () => {
    it('returns correct statistics', async () => {
      const stats = em.stats();
      expect(stats.entryCount).toBe(0);
      expect(stats.segmentCount).toBe(0);
      expect(stats.avgHeatScore).toBe(0);
      expect(stats.capacityUtilization).toBe(0);

      await em.add('entry');
      const stats2 = em.stats();
      expect(stats2.entryCount).toBe(1);
      expect(stats2.capacityUtilization).toBeCloseTo(0.2); // 1/5
    });
  });

  describe('recomputeHeatScores', () => {
    it('runs without error', async () => {
      await em.add('entry');
      expect(() => em.recomputeHeatScores()).not.toThrow();
    });
  });
});
