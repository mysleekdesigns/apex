import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryManager } from './manager.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Mock embeddings globally
vi.mock('../utils/embeddings.js', () => ({
  getEmbedding: vi.fn((text: string) => ({
    keywords: text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10),
    simhash: BigInt(text.length),
    embedding: undefined,
  })),
  extractKeywords: vi.fn((text: string) => text.toLowerCase().split(/\s+/).filter(Boolean)),
  simHash: vi.fn(() => BigInt(0)),
  simHashSimilarity: vi.fn(() => 0.5),
}));

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

vi.mock('../utils/hashing.js', () => ({
  contentHash: vi.fn((text: string) => {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return hash.toString(16);
  }),
}));

describe('MemoryManager', () => {
  let mm: MemoryManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-test-'));
    const projectDataPath = path.join(tmpDir, '.apex-data');
    const globalDataPath = path.join(tmpDir, '.apex-global');

    mm = new MemoryManager({
      projectDataPath,
      globalDataPath,
      projectPath: tmpDir,
    });

    await mm.init();
  });

  describe('addToWorking', () => {
    it('adds entry to working memory', () => {
      const entry = mm.addToWorking('test content');
      expect(entry.content).toBe('test content');
      expect(entry.tier).toBe('working');
    });
  });

  describe('addToEpisodic', () => {
    it('adds entry to episodic memory', async () => {
      const entry = await mm.addToEpisodic('episodic content');
      expect(entry.content).toBe('episodic content');
      expect(entry.tier).toBe('episodic');
    });
  });

  describe('addToSemantic', () => {
    it('adds knowledge to semantic memory', async () => {
      const id = await mm.addToSemantic('semantic knowledge');
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });
  });

  describe('addSkill', () => {
    it('stores a skill in procedural memory', async () => {
      const skill = await mm.addSkill({
        name: 'test-skill',
        description: 'A test skill',
        pattern: 'step 1, step 2',
      });
      expect(skill.id).toBeDefined();
      expect(skill.name).toBe('test-skill');
    });
  });

  describe('recall (cross-tier retrieval)', () => {
    it('returns results from multiple tiers', async () => {
      mm.addToWorking('typescript error in working memory');
      await mm.addToEpisodic('typescript bug in episodic memory');
      await mm.addToSemantic('typescript patterns in semantic memory');

      const results = await mm.recall('typescript');
      expect(results.length).toBeGreaterThan(0);
    });

    it('deduplicates results by entry ID', async () => {
      mm.addToWorking('unique test content');

      const results = await mm.recall('unique test content');
      const ids = results.map((r) => r.entry.id);
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });

    it('sorts results by score descending', async () => {
      mm.addToWorking('entry one');
      await mm.addToEpisodic('entry two');

      const results = await mm.recall('entry');
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });
  });

  describe('consolidate', () => {
    it('moves working memory to episodic and returns report', async () => {
      mm.addToWorking('item 1');
      mm.addToWorking('item 2');

      const report = await mm.consolidate();
      expect(report.movedToEpisodic).toBe(2);
      expect(report.timestamp).toBeGreaterThan(0);
    });

    it('clears working memory after consolidation', async () => {
      mm.addToWorking('item');
      await mm.consolidate();

      const stats = await mm.status();
      expect(stats.working.count).toBe(0);
    });
  });

  describe('status', () => {
    it('returns stats for all tiers', async () => {
      const stats = await mm.status();
      expect(stats).toHaveProperty('working');
      expect(stats).toHaveProperty('episodic');
      expect(stats).toHaveProperty('semantic');
      expect(stats).toHaveProperty('procedural');
      expect(stats).toHaveProperty('snapshots');
    });
  });

  describe('snapshots', () => {
    it('creates a named snapshot', async () => {
      const snapshot = await mm.createSnapshot('test-snap');
      expect(snapshot.name).toBe('test-snap');
      expect(snapshot.id).toBeDefined();
    });

    it('lists snapshots', async () => {
      await mm.createSnapshot('snap-1');
      const list = await mm.listSnapshots();
      expect(list.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('skills', () => {
    it('stores and retrieves skills', async () => {
      await mm.addSkill({
        name: 'error-handling',
        description: 'Handle errors gracefully',
        pattern: 'try-catch with specific error types',
      });

      const skills = await mm.listSkills();
      expect(skills.length).toBe(1);
      expect(skills[0].name).toBe('error-handling');
    });

    it('searches skills by query', async () => {
      await mm.addSkill({
        name: 'typescript-patterns',
        description: 'Common typescript patterns',
        pattern: 'Use discriminated unions',
      });

      const results = await mm.searchSkills('typescript');
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
