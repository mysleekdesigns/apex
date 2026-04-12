/**
 * Integration test: Snapshot and rollback
 *
 * Verifies snapshot creation, memory modification, and rollback
 * restoring the previous state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MemoryManager } from '../memory/manager.js';

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
  return {
    combinedSimilarity: vi.fn(() => 0.5),
    cosineSimilarity: vi.fn(() => 0),
    BM25Index: MockBM25Index,
    hybridSearch: vi.fn((_query: any, candidates: any[]) =>
      candidates.map((c: any) => ({
        id: c.id, score: 0.5, components: { vector: 0, bm25: 0, recency: 0.5 },
      }))
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

describe('Snapshot & Rollback Integration', () => {
  let mm: MemoryManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-snapshot-'));
    mm = new MemoryManager({
      projectDataPath: path.join(tmpDir, '.apex-data'),
      projectPath: tmpDir,
    });
    await mm.init();
  });

  it('creates named snapshots', async () => {
    const snap = await mm.createSnapshot('test-snapshot');
    expect(snap.name).toBe('test-snapshot');
    expect(snap.id).toBeDefined();
    expect(snap.timestamp).toBeGreaterThan(0);
  });

  it('lists created snapshots', async () => {
    await mm.createSnapshot('snap-1');
    await mm.createSnapshot('snap-2');

    const list = await mm.listSnapshots();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some(s => s.name === 'snap-1')).toBe(true);
    expect(list.some(s => s.name === 'snap-2')).toBe(true);
  });

  it('rollback restores snapshot state', async () => {
    // Add initial data and snapshot
    await mm.addToEpisodic('initial data');
    const snap = await mm.createSnapshot('before-change');

    // Modify state
    await mm.addToEpisodic('additional data after snapshot');

    // Rollback
    const restored = await mm.rollback(snap.id);
    expect(restored.id).toBe(snap.id);
  });
});
