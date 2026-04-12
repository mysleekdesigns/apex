/**
 * Integration test: Full learning loop
 *
 * Tests the round-trip: record → reflect → recall, verifying that
 * recorded episodes are retrievable and that the system wires together.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MemoryManager } from '../memory/manager.js';

// Mock embeddings for deterministic tests
vi.mock('../utils/embeddings.js', () => ({
  getEmbedding: vi.fn((text: string) => ({
    keywords: text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10),
    simhash: BigInt(text.length),
    embedding: undefined,
  })),
  getEmbeddingAsync: vi.fn(async (text: string) => ({
    keywords: text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10),
    simhash: BigInt(text.length),
    embedding: undefined,
  })),
  getSemanticEmbedder: vi.fn(() => ({
    embed: vi.fn(async () => { throw new Error('L2 not available in tests'); }),
    embedBatch: vi.fn(async () => { throw new Error('L2 not available in tests'); }),
    isLoaded: vi.fn(() => false),
  })),
  extractKeywords: vi.fn((text: string) => text.toLowerCase().split(/\s+/).filter(Boolean)),
  simHash: vi.fn(() => BigInt(0)),
  simHashSimilarity: vi.fn(() => 0.5),
}));

vi.mock('../utils/similarity.js', () => {
  class MockBM25Index {
    private docs = new Map<string, string[]>();
    get size() { return this.docs.size; }
    addDocument(id: string, terms: string[]) { this.docs.set(id, terms); }
    removeDocument(id: string) { this.docs.delete(id); }
    addDocuments(docs: Array<{ id: string; terms: string[] }>) { for (const d of docs) this.addDocument(d.id, d.terms); }
    score(queryTerms: string[]) {
      const scores = new Map<string, number>();
      const qs = new Set(queryTerms);
      for (const [id, terms] of this.docs) { let s = 0; for (const t of terms) if (qs.has(t)) s++; if (s > 0) scores.set(id, s); }
      return scores;
    }
    scoreDocument(queryTerms: string[], docId: string) {
      const terms = this.docs.get(docId); if (!terms) return 0;
      const qs = new Set(queryTerms); let s = 0; for (const t of terms) if (qs.has(t)) s++; return s;
    }
  }
  const combinedSimilarity = vi.fn((a: { keywords: string[] }, b: { keywords: string[] }) => {
    const setA = new Set(a.keywords);
    const setB = new Set(b.keywords);
    let intersection = 0;
    for (const k of setA) if (setB.has(k)) intersection++;
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? intersection / union : 0;
  });
  return {
    combinedSimilarity,
    cosineSimilarity: vi.fn(() => 0),
    BM25Index: MockBM25Index,
    hybridSearch: vi.fn((query: any, candidates: any[]) =>
      candidates.map((c: any) => ({
        id: c.id,
        score: combinedSimilarity({ keywords: query.keywords }, { keywords: c.keywords }),
        components: { vector: 0, bm25: 0, recency: 0.5 },
      })).sort((a: any, b: any) => b.score - a.score)
    ),
  };
});

vi.mock('../utils/vector-index.js', () => ({
  HNSWIndex: vi.fn(),
}));

vi.mock('../utils/hashing.js', () => ({
  contentHash: vi.fn((text: string) => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    return h.toString(16);
  }),
}));

describe('Learning Loop Integration', () => {
  let mm: MemoryManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-loop-'));
    mm = new MemoryManager({
      projectDataPath: path.join(tmpDir, '.apex-data'),
      projectPath: tmpDir,
    });
    await mm.init();
  });

  it('record → recall round-trip returns the recorded content', async () => {
    // Record an episode
    await mm.addToEpisodic('Fixed a TypeScript type error in the auth module');

    // Recall it
    const results = await mm.recall('TypeScript type error auth');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content).toContain('TypeScript');
  });

  it('multiple records improve recall relevance', async () => {
    // Record several episodes
    await mm.addToEpisodic('React component rendering performance issue');
    await mm.addToEpisodic('TypeScript type error in API handler');
    await mm.addToEpisodic('TypeScript generic constraint fix in middleware');

    // Recall for TypeScript should return TypeScript-related entries
    const results = await mm.recall('TypeScript');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('skills are retrievable after storage', async () => {
    const skill = await mm.addSkill({
      name: 'error-boundary-pattern',
      description: 'React error boundary for catching render errors',
      pattern: 'class ErrorBoundary extends React.Component {...}',
      tags: ['react', 'error-handling'],
    });

    const skills = await mm.listSkills();
    expect(skills.find(s => s.id === skill.id)).toBeDefined();

    const searchResults = await mm.searchSkills('error boundary');
    expect(searchResults.length).toBeGreaterThan(0);
  });

  it('working memory content flows to recall results', async () => {
    mm.addToWorking('Current session: debugging websocket connection');

    const results = await mm.recall('websocket connection');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.sourceTier === 'working')).toBe(true);
  });

  it('semantic memory deduplicates identical content', async () => {
    const id1 = await mm.addToSemantic('TypeScript enums should be avoided');
    const id2 = await mm.addToSemantic('TypeScript enums should be avoided');
    expect(id1).toBe(id2); // deduplicated
  });
});
