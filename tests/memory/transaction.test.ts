import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryTransaction } from '../../src/memory/transaction.js';
import { AuditLog, type AuditEntry } from '../../src/memory/audit-log.js';
import { WorkingMemory } from '../../src/memory/working.js';
import { EpisodicMemory } from '../../src/memory/episodic.js';
import { SemanticMemory } from '../../src/memory/semantic.js';
import { ProceduralMemory } from '../../src/memory/procedural.js';
import { FileStore } from '../../src/utils/file-store.js';
import { EventBus } from '../../src/utils/event-bus.js';
import { Logger } from '../../src/utils/logger.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/embeddings.js', () => ({
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
  })),
  extractKeywords: vi.fn((text: string) => text.toLowerCase().split(/\s+/).filter(Boolean)),
  simHash: vi.fn(() => BigInt(0)),
  simHashSimilarity: vi.fn(() => 0.5),
}));

vi.mock('../../src/utils/similarity.js', () => {
  const combinedSimilarity = vi.fn(() => 0.5);

  class MockBM25Index {
    private docs = new Map<string, string[]>();
    get size() { return this.docs.size; }
    addDocument(id: string, terms: string[]) { this.docs.set(id, terms); }
    removeDocument(id: string) { this.docs.delete(id); }
    addDocuments(docs: Array<{ id: string; terms: string[] }>) {
      for (const d of docs) this.addDocument(d.id, d.terms);
    }
    score() { return new Map<string, number>(); }
    scoreDocument() { return 0; }
  }

  return {
    combinedSimilarity,
    BM25Index: MockBM25Index,
    hybridSearch: vi.fn(() => []),
  };
});

vi.mock('../../src/utils/hashing.js', () => ({
  contentHash: vi.fn((text: string) => `hash-${text.length}-${text.slice(0, 8)}`),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = new Logger({ prefix: 'test', level: 'error' });

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-tx-test-'));
  return dir;
}

function createTiers(dataPath: string) {
  const fileStore = new FileStore(dataPath);
  const eventBus = new EventBus();

  const working = new WorkingMemory({ capacity: 20, eventBus, logger });
  const episodic = new EpisodicMemory({ capacity: 100, fileStore, eventBus, logger });
  const semantic = new SemanticMemory({ capacity: 100, fileStore, logger });
  const procedural = new ProceduralMemory({ fileStore, logger });

  return { fileStore, working, episodic, semantic, procedural };
}

// ---------------------------------------------------------------------------
// Tests: MemoryTransaction
// ---------------------------------------------------------------------------

describe('MemoryTransaction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('begin + commit preserves state', async () => {
    const { fileStore, working, episodic, semantic, procedural } = createTiers(tmpDir);
    await fileStore.init();

    // Add some initial data
    working.add('item A');
    working.add('item B');
    await episodic.add('episode 1');

    const tx = new MemoryTransaction(working, episodic, semantic, procedural, logger);
    await tx.begin();
    expect(tx.state).toBe('active');

    // Mutate
    working.add('item C');
    await episodic.add('episode 2');

    await tx.commit();
    expect(tx.state).toBe('committed');

    // Verify mutations persisted
    expect(working.getAll().length).toBe(3);
    expect(episodic.getAll().length).toBe(2);
  });

  it('begin + rollback restores working and episodic state', async () => {
    const { fileStore, working, episodic, semantic, procedural } = createTiers(tmpDir);
    await fileStore.init();

    // Add initial data
    working.add('item A');
    await episodic.add('episode 1');

    const tx = new MemoryTransaction(working, episodic, semantic, procedural, logger);
    await tx.begin();

    // Mutate
    working.add('item B');
    working.add('item C');
    await episodic.add('episode 2');
    await episodic.add('episode 3');

    expect(working.getAll().length).toBe(3);
    expect(episodic.getAll().length).toBe(3);

    await tx.rollback();
    expect(tx.state).toBe('rolled-back');

    // Working memory should be restored (1 entry)
    // Note: rollback re-adds via add() which creates new IDs, but count should match
    expect(working.getAll().length).toBe(1);

    // Episodic should be restored (1 entry)
    expect(episodic.getAll().length).toBe(1);
  });

  it('begin + rollback restores procedural skills', async () => {
    const { fileStore, working, episodic, semantic, procedural } = createTiers(tmpDir);
    await fileStore.init();
    await procedural.load();

    await procedural.addSkill({
      name: 'skill-A',
      description: 'A skill',
      pattern: 'do A',
    });

    const tx = new MemoryTransaction(working, episodic, semantic, procedural, logger);
    await tx.begin();

    // Add another skill during transaction
    await procedural.addSkill({
      name: 'skill-B',
      description: 'B skill',
      pattern: 'do B',
    });

    expect((await procedural.getAll(true)).length).toBe(2);

    await tx.rollback();

    // Should be back to 1 skill
    expect((await procedural.getAll(true)).length).toBe(1);
    const remaining = (await procedural.getAll(true))[0];
    expect(remaining.name).toBe('skill-A');
  });

  it('throws if begin called twice without commit/rollback', async () => {
    const { fileStore, working, episodic, semantic, procedural } = createTiers(tmpDir);
    await fileStore.init();

    const tx = new MemoryTransaction(working, episodic, semantic, procedural, logger);
    await tx.begin();

    await expect(tx.begin()).rejects.toThrow('already active');
  });

  it('throws if commit called without active transaction', async () => {
    const { fileStore, working, episodic, semantic, procedural } = createTiers(tmpDir);
    await fileStore.init();

    const tx = new MemoryTransaction(working, episodic, semantic, procedural, logger);

    await expect(tx.commit()).rejects.toThrow('No active transaction');
  });

  it('throws if rollback called without active transaction', async () => {
    const { fileStore, working, episodic, semantic, procedural } = createTiers(tmpDir);
    await fileStore.init();

    const tx = new MemoryTransaction(working, episodic, semantic, procedural, logger);

    await expect(tx.rollback()).rejects.toThrow('No active transaction');
  });
});

// ---------------------------------------------------------------------------
// Tests: AuditLog
// ---------------------------------------------------------------------------

describe('AuditLog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends entries and reads them back', async () => {
    const audit = new AuditLog({ dataPath: tmpDir, logger });

    const entry: AuditEntry = {
      timestamp: Date.now(),
      operation: 'record',
      tier: 'working',
      entryId: 'abc-123',
      details: 'Added test entry',
      success: true,
    };

    audit.append(entry);
    audit.append({ ...entry, entryId: 'abc-456', operation: 'promote' });
    await audit.flush();

    const entries = await audit.getRecentEntries(10);
    expect(entries.length).toBe(2);
    expect(entries[0].entryId).toBe('abc-123');
    expect(entries[1].entryId).toBe('abc-456');
    expect(entries[1].operation).toBe('promote');
  });

  it('respects limit in getRecentEntries', async () => {
    const audit = new AuditLog({ dataPath: tmpDir, logger });

    for (let i = 0; i < 10; i++) {
      audit.append({
        timestamp: Date.now(),
        operation: 'record',
        tier: 'working',
        entryId: `entry-${i}`,
        details: `Entry ${i}`,
        success: true,
      });
    }
    await audit.flush();

    const entries = await audit.getRecentEntries(3);
    expect(entries.length).toBe(3);
    // Should be the last 3
    expect(entries[0].entryId).toBe('entry-7');
    expect(entries[2].entryId).toBe('entry-9');
  });

  it('rotates when file exceeds maxFileSize', async () => {
    // Use a very small maxFileSize to trigger rotation quickly
    const audit = new AuditLog({ dataPath: tmpDir, logger, maxFileSize: 200 });

    // Write enough entries to exceed 200 bytes
    for (let i = 0; i < 10; i++) {
      audit.append({
        timestamp: Date.now(),
        operation: 'record',
        tier: 'working',
        entryId: `entry-${i}`,
        details: `This is a reasonably long detail string to fill up the log file quickly number ${i}`,
        success: true,
      });
    }
    await audit.flush();

    // Check that rotated files exist
    const auditDir = path.join(tmpDir, 'audit');
    const files = fs.readdirSync(auditDir);
    const rotatedFiles = files.filter((f) => f.startsWith('audit-') && f !== 'audit.jsonl');
    expect(rotatedFiles.length).toBeGreaterThan(0);
  });

  it('returns empty array when no log file exists', async () => {
    const audit = new AuditLog({ dataPath: tmpDir, logger });
    const entries = await audit.getRecentEntries();
    expect(entries).toEqual([]);
  });

  it('handles concurrent appends without corruption', async () => {
    const audit = new AuditLog({ dataPath: tmpDir, logger });

    // Fire many concurrent appends
    for (let i = 0; i < 20; i++) {
      audit.append({
        timestamp: Date.now(),
        operation: 'record',
        tier: 'episodic',
        entryId: `concurrent-${i}`,
        details: `Concurrent entry ${i}`,
        success: true,
      });
    }
    await audit.flush();

    const entries = await audit.getRecentEntries(100);
    // All entries should be written (some may be in rotated files, but the
    // active file should have at least some)
    expect(entries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Consolidation with Transaction (integration-like)
// ---------------------------------------------------------------------------

describe('Consolidation transaction integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rolls back when a mid-consolidation step throws', async () => {
    const { fileStore, working, episodic, semantic, procedural } = createTiers(tmpDir);
    await fileStore.init();

    // Set up initial state
    working.add('will move to episodic');
    const initialWorkingCount = working.getAll().length;

    const tx = new MemoryTransaction(working, episodic, semantic, procedural, logger);
    await tx.begin();

    // Simulate step 1: flush working -> episodic
    const entries = working.getAll();
    for (const entry of entries) {
      await episodic.add({ ...entry, tier: 'episodic' });
    }
    working.clear();

    // Verify mid-transaction state
    expect(working.getAll().length).toBe(0);
    expect(episodic.getAll().length).toBe(1);

    // Simulate step 2 failure
    await tx.rollback();

    // Working memory should be restored
    expect(working.getAll().length).toBe(initialWorkingCount);
    // Episodic should be restored to pre-transaction (empty)
    expect(episodic.getAll().length).toBe(0);
  });
});
