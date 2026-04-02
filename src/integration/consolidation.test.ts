/**
 * Integration test: Memory consolidation pipeline
 *
 * Tests the flow: Working → Episodic → Semantic, and verifies that
 * consolidation correctly moves data between tiers.
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
    let h = 0;
    for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    return h.toString(16);
  }),
}));

describe('Memory Consolidation Integration', () => {
  let mm: MemoryManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-consolidation-'));
    mm = new MemoryManager({
      projectDataPath: path.join(tmpDir, '.apex-data'),
      projectPath: tmpDir,
    });
    await mm.init();
  });

  it('consolidation moves working memory to episodic', async () => {
    // Add items to working memory
    mm.addToWorking('session context item 1');
    mm.addToWorking('session context item 2');
    mm.addToWorking('session context item 3');

    const statsBefore = await mm.status();
    expect(statsBefore.working.count).toBe(3);

    // Consolidate
    const report = await mm.consolidate();

    expect(report.movedToEpisodic).toBe(3);

    // Working should be empty
    const statsAfter = await mm.status();
    expect(statsAfter.working.count).toBe(0);

    // Episodic should have the items
    expect(statsAfter.episodic.entryCount).toBeGreaterThanOrEqual(3);
  });

  it('consolidation creates auto-snapshot before changes', async () => {
    mm.addToWorking('some content');

    const snapshotsBefore = await mm.listSnapshots();
    await mm.consolidate();
    const snapshotsAfter = await mm.listSnapshots();

    expect(snapshotsAfter.length).toBeGreaterThan(snapshotsBefore.length);
  });

  it('repeated consolidation accumulates episodic entries', async () => {
    mm.addToWorking('batch 1');
    await mm.consolidate();

    mm.addToWorking('batch 2');
    await mm.consolidate();

    const stats = await mm.status();
    expect(stats.episodic.entryCount).toBeGreaterThanOrEqual(2);
  });
});
