import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SemanticMemory } from './semantic.js';

// Mock embeddings
vi.mock('../utils/embeddings.js', () => ({
  getEmbedding: vi.fn((text: string) => ({
    keywords: text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10),
    simhash: BigInt(text.length), // deterministic but different per content
    embedding: undefined,
  })),
}));

// Mock similarity — use keyword overlap
vi.mock('../utils/similarity.js', () => ({
  combinedSimilarity: vi.fn((a: { keywords: string[] }, b: { keywords: string[] }) => {
    const setA = new Set(a.keywords);
    const setB = new Set(b.keywords);
    let intersection = 0;
    for (const k of setA) if (setB.has(k)) intersection++;
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? intersection / union : 0;
  }),
}));

// Mock hashing — simple string hash
vi.mock('../utils/hashing.js', () => ({
  contentHash: vi.fn((text: string) => {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return hash.toString(16);
  }),
}));

describe('SemanticMemory', () => {
  let sm: SemanticMemory;

  beforeEach(() => {
    sm = new SemanticMemory({ capacity: 5 });
  });

  describe('add', () => {
    it('adds a new knowledge entry and returns its id', async () => {
      const id = await sm.add('TypeScript enums should be avoided');
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    it('increments entry count', async () => {
      await sm.add('fact one');
      await sm.add('fact two');
      expect(sm.stats().entryCount).toBe(2);
    });

    it('deduplicates exact content', async () => {
      const id1 = await sm.add('exact duplicate content');
      const id2 = await sm.add('exact duplicate content');
      expect(id1).toBe(id2);
      expect(sm.stats().entryCount).toBe(1);
      expect(sm.stats().dedupHitCount).toBe(1);
    });

    it('respects metadata (confidence, sourceFiles)', async () => {
      const id = await sm.add('some knowledge', {
        confidence: 0.9,
        sourceFiles: ['src/foo.ts'],
      });
      const entry = sm.get(id);
      expect(entry).toBeDefined();
      expect(entry!.confidence).toBe(0.9);
      expect(entry!.sourceFiles).toEqual(['src/foo.ts']);
    });
  });

  describe('search', () => {
    it('returns results sorted by score descending', async () => {
      await sm.add('typescript error handling');
      await sm.add('react component patterns');
      await sm.add('typescript type inference');

      const results = await sm.search('typescript');
      expect(results.length).toBeGreaterThan(0);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('tags results as semantic tier', async () => {
      await sm.add('some knowledge');
      const results = await sm.search('knowledge');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].sourceTier).toBe('semantic');
      expect(results[0].source).toBe('project');
    });

    it('respects topK', async () => {
      for (let i = 0; i < 5; i++) {
        await sm.add(`knowledge entry ${i} unique${i}`);
      }
      const results = await sm.search('knowledge', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('warms up retrieved entries (bumps heat)', async () => {
      const id = await sm.add('warming test entry');
      const beforeHeat = sm.get(id)!.heatScore;

      await sm.search('warming test');
      const afterHeat = sm.get(id)!.heatScore;
      expect(afterHeat).toBeGreaterThan(beforeHeat);
    });
  });

  describe('eviction', () => {
    it('evicts lowest-scoring entries when over capacity', async () => {
      const sm3 = new SemanticMemory({ capacity: 3 });

      await sm3.add('entry alpha unique1');
      await sm3.add('entry beta unique2');
      await sm3.add('entry gamma unique3');
      expect(sm3.stats().entryCount).toBe(3);

      await sm3.add('entry delta unique4');
      expect(sm3.stats().entryCount).toBe(3); // one was evicted
    });
  });

  describe('get', () => {
    it('returns entry by id', async () => {
      const id = await sm.add('retrievable knowledge');
      const entry = sm.get(id);
      expect(entry).toBeDefined();
      expect(entry!.content).toBe('retrievable knowledge');
    });

    it('returns undefined for unknown id', () => {
      expect(sm.get('nonexistent')).toBeUndefined();
    });
  });

  describe('all', () => {
    it('returns all entries', async () => {
      await sm.add('one unique1');
      await sm.add('two unique2');
      const all = sm.all();
      expect(all).toHaveLength(2);
    });
  });

  describe('stats', () => {
    it('reports correct statistics', async () => {
      const stats = sm.stats();
      expect(stats.entryCount).toBe(0);
      expect(stats.capacity).toBe(5);
      expect(stats.dedupHitCount).toBe(0);
    });
  });
});
