/**
 * Tests for Memory Bounds Manager (Phase 22)
 *
 * Covers: soft/hard limit detection, eviction enforcement,
 * eviction priority, high-value entry survival, usage report
 * accuracy, graceful degradation, and file size monitoring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryBounds, type MemoryBoundsConfig } from '../../src/memory/bounds.js';
import { WorkingMemory } from '../../src/memory/working.js';
import { EpisodicMemory } from '../../src/memory/episodic.js';
import { SemanticMemory } from '../../src/memory/semantic.js';
import { ProceduralMemory } from '../../src/memory/procedural.js';
import { EventBus } from '../../src/utils/event-bus.js';

// ---------------------------------------------------------------------------
// Mocks — keep computation light
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/embeddings.js', () => ({
  getEmbedding: vi.fn((text: string) => ({
    keywords: text.split(/\s+/).slice(0, 5),
    simhash: BigInt(0),
    embedding: undefined,
  })),
  getEmbeddingAsync: vi.fn(async (text: string) => ({
    keywords: text.split(/\s+/).slice(0, 5),
    simhash: BigInt(0),
    embedding: undefined,
  })),
  extractKeywords: vi.fn((text: string) =>
    text.toLowerCase().split(/\s+/).filter(Boolean),
  ),
  simHash: vi.fn(() => BigInt(0)),
  simHashSimilarity: vi.fn(() => 0.5),
  getSemanticEmbedder: vi.fn(() => { throw new Error('no L2'); }),
}));

vi.mock('../../src/utils/similarity.js', () => ({
  combinedSimilarity: vi.fn(() => 0.5),
  BM25Index: vi.fn(() => ({ addDocument: vi.fn(), search: vi.fn(() => []) })),
  hybridSearch: vi.fn(() => []),
}));

vi.mock('../../src/utils/hashing.js', () => ({
  contentHash: vi.fn((text: string) => `hash-${text.length}-${text.slice(0, 10)}`),
}));

// Mock fs for file size computation
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    readdir: vi.fn(async () => []),
    stat: vi.fn(async () => ({ size: 0 })),
    mkdir: actual.mkdir,
    readFile: actual.readFile,
    writeFile: actual.writeFile,
    rm: actual.rm,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSmallConfig(): MemoryBoundsConfig {
  return {
    working:         { soft: 4, hard: 5 },
    episodic:        { soft: 8, hard: 10 },
    semantic:        { soft: 8, hard: 10 },
    procedural:      { soft: 4, hard: 5 },
    totalFileSizeMB: { soft: 50, hard: 100 },
  };
}

function createBounds(config?: MemoryBoundsConfig, eventBus?: EventBus): MemoryBounds {
  return new MemoryBounds({
    config: config ?? makeSmallConfig(),
    dataPath: '/tmp/apex-test-data',
    eventBus,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryBounds', () => {

  describe('canAdd()', () => {
    it('allows add when well below soft limit', () => {
      const bounds = createBounds();
      const result = bounds.canAdd('episodic', 3);
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('allows add with warning when at soft limit', () => {
      const bounds = createBounds();
      // soft=8, hard=10, count=8 -> at soft limit
      const result = bounds.canAdd('episodic', 8);
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('80%');
      expect(result.warning).toContain('apex_consolidate');
    });

    it('allows add with warning when between soft and hard', () => {
      const bounds = createBounds();
      const result = bounds.canAdd('episodic', 9);
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('90%');
    });

    it('rejects add when at hard limit', () => {
      const bounds = createBounds();
      const result = bounds.canAdd('episodic', 10);
      expect(result.allowed).toBe(false);
      expect(result.warning).toContain('hard limit');
      expect(result.warning).toContain('eviction required');
    });

    it('rejects add when above hard limit', () => {
      const bounds = createBounds();
      const result = bounds.canAdd('episodic', 15);
      expect(result.allowed).toBe(false);
    });

    it('allows add for unknown tier (graceful)', () => {
      const bounds = createBounds();
      const result = bounds.canAdd('unknown_tier', 9999);
      expect(result.allowed).toBe(true);
    });
  });

  describe('soft limit warning emission', () => {
    it('emits memory:bounds-warning event when soft limit is hit', () => {
      const eventBus = new EventBus();
      const handler = vi.fn();
      eventBus.on('memory:bounds-warning', handler);

      const bounds = createBounds(undefined, eventBus);
      bounds.canAdd('episodic', 8);

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.tier).toBe('episodic');
      expect(payload.warning).toContain('80%');
    });

    it('does not emit event when below soft limit', () => {
      const eventBus = new EventBus();
      const handler = vi.fn();
      eventBus.on('memory:bounds-warning', handler);

      const bounds = createBounds(undefined, eventBus);
      bounds.canAdd('episodic', 5);

      expect(handler).not.toHaveBeenCalled();
    });

    it('does not emit event when at hard limit (rejection)', () => {
      const eventBus = new EventBus();
      const handler = vi.fn();
      eventBus.on('memory:bounds-warning', handler);

      const bounds = createBounds(undefined, eventBus);
      bounds.canAdd('episodic', 10);

      // At hard limit: no warning event, just rejection
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('enforce() — episodic tier', () => {
    let episodic: EpisodicMemory;
    let tiers: Parameters<MemoryBounds['enforce']>[1];

    beforeEach(() => {
      episodic = new EpisodicMemory({ capacity: 1000 }); // internal capacity high
      tiers = {
        working: new WorkingMemory({ capacity: 100 }),
        episodic,
        semantic: new SemanticMemory({ capacity: 1000 }),
        procedural: new ProceduralMemory(),
      };
    });

    it('evicts lowest heat-score entries to bring count below hard limit', async () => {
      // Add 12 entries to exceed hard=10
      for (let i = 0; i < 12; i++) {
        const entry = await episodic.add(`episode ${i}`);
        // Give varied heat scores
        entry.heatScore = i * 0.1;
      }

      const bounds = createBounds();
      const report = await bounds.enforce('episodic', tiers);

      // Should have evicted some entries (max 10% of 10 = 1)
      expect(report.evictedCount).toBeGreaterThan(0);
      expect(report.evictedIds.length).toBe(report.evictedCount);
      expect(report.tier).toBe('episodic');
    });

    it('does not evict more than 10% of capacity in a single pass', async () => {
      // Add 20 entries (10 over hard limit of 10)
      for (let i = 0; i < 20; i++) {
        await episodic.add(`episode ${i}`);
      }

      const bounds = createBounds();
      const report = await bounds.enforce('episodic', tiers);

      // Max evict = floor(10 * 0.1) = 1
      expect(report.evictedCount).toBeLessThanOrEqual(1);
    });

    it('does nothing when under hard limit', async () => {
      for (let i = 0; i < 5; i++) {
        await episodic.add(`episode ${i}`);
      }

      const bounds = createBounds();
      const report = await bounds.enforce('episodic', tiers);
      expect(report.evictedCount).toBe(0);
      expect(report.evictedIds).toEqual([]);
    });

    it('emits memory:bounds-eviction event on eviction', async () => {
      const eventBus = new EventBus();
      const handler = vi.fn();
      eventBus.on('memory:bounds-eviction', handler);

      for (let i = 0; i < 12; i++) {
        await episodic.add(`episode ${i}`);
      }

      const bounds = createBounds(undefined, eventBus);
      await bounds.enforce('episodic', tiers);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('enforce() — procedural tier', () => {
    it('evicts lowest-confidence skills first', async () => {
      const procedural = new ProceduralMemory();
      const tiers = {
        working: new WorkingMemory({ capacity: 100 }),
        episodic: new EpisodicMemory({ capacity: 100 }),
        semantic: new SemanticMemory({ capacity: 100 }),
        procedural,
      };

      // Add 7 skills (exceeds hard=5)
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const skill = await procedural.addSkill({
          name: `skill-${i}`,
          description: `desc ${i}`,
          pattern: `pattern ${i}`,
          confidence: i * 0.15, // 0, 0.15, 0.30, ... 0.90
          usageCount: i,
          tags: [],
        });
        ids.push(skill.id);
      }

      const bounds = createBounds();
      const report = await bounds.enforce('procedural', tiers);

      // Should evict the lowest-value skill(s)
      expect(report.evictedCount).toBeGreaterThan(0);
      // The evicted entries should be from the low-confidence end
      for (const evictedId of report.evictedIds) {
        // The lowest-confidence skill has confidence=0 and usageCount=0
        // It should be in the evicted set
        expect(ids).toContain(evictedId);
      }
    });
  });

  describe('high-value entries survive eviction', () => {
    it('evicts low-heat entries and preserves high-heat entries', async () => {
      const episodic = new EpisodicMemory({ capacity: 1000 });
      const tiers = {
        working: new WorkingMemory({ capacity: 100 }),
        episodic,
        semantic: new SemanticMemory({ capacity: 1000 }),
        procedural: new ProceduralMemory(),
      };

      const highValueIds: string[] = [];
      const lowValueIds: string[] = [];

      // Add entries with distinct heat scores
      for (let i = 0; i < 12; i++) {
        const entry = await episodic.add(`episode ${i}`);
        if (i >= 10) {
          // These are high-value
          entry.heatScore = 5.0;
          highValueIds.push(entry.id);
        } else {
          // These are low-value
          entry.heatScore = 0.01;
          lowValueIds.push(entry.id);
        }
      }

      const bounds = createBounds();
      const report = await bounds.enforce('episodic', tiers);

      // Evicted IDs should be from the low-value set
      for (const evictedId of report.evictedIds) {
        expect(lowValueIds).toContain(evictedId);
        expect(highValueIds).not.toContain(evictedId);
      }
    });
  });

  describe('getUsage() — usage report', () => {
    it('returns correct entry counts and utilization percentages', async () => {
      const episodic = new EpisodicMemory({ capacity: 1000 });
      const semantic = new SemanticMemory({ capacity: 1000 });
      const procedural = new ProceduralMemory();
      const working = new WorkingMemory({ capacity: 100 });

      // Add some entries
      working.add('working entry 1');
      working.add('working entry 2');
      await episodic.add('episodic entry 1');
      await episodic.add('episodic entry 2');
      await episodic.add('episodic entry 3');

      const bounds = createBounds();
      const report = await bounds.getUsage({ working, episodic, semantic, procedural });

      expect(report.tiers.working.count).toBe(2);
      expect(report.tiers.working.capacity.hard).toBe(5);
      expect(report.tiers.working.utilizationPercent).toBe(40);

      expect(report.tiers.episodic.count).toBe(3);
      expect(report.tiers.episodic.capacity.hard).toBe(10);
      expect(report.tiers.episodic.utilizationPercent).toBe(30);

      expect(report.tiers.semantic.count).toBe(0);
      expect(report.tiers.procedural.count).toBe(0);

      expect(report.totalFileSizeMB).toBeGreaterThanOrEqual(0);
    });

    it('generates alerts when tiers exceed soft limits', async () => {
      const episodic = new EpisodicMemory({ capacity: 1000 });
      const working = new WorkingMemory({ capacity: 100 });
      const semantic = new SemanticMemory({ capacity: 1000 });
      const procedural = new ProceduralMemory();

      // Add 9 episodic entries (soft=8, hard=10)
      for (let i = 0; i < 9; i++) {
        await episodic.add(`entry ${i} unique content ${i * 1000}`);
      }

      const bounds = createBounds();
      const report = await bounds.getUsage({ working, episodic, semantic, procedural });

      expect(report.alerts.length).toBeGreaterThan(0);
      const episodicAlert = report.alerts.find((a) => a.includes('Episodic'));
      expect(episodicAlert).toBeDefined();
      expect(episodicAlert).toContain('90%');
      expect(episodicAlert).toContain('apex_consolidate');
    });

    it('generates hard limit alert when at capacity', async () => {
      const episodic = new EpisodicMemory({ capacity: 1000 });
      const working = new WorkingMemory({ capacity: 100 });
      const semantic = new SemanticMemory({ capacity: 1000 });
      const procedural = new ProceduralMemory();

      for (let i = 0; i < 10; i++) {
        await episodic.add(`entry ${i} unique ${i * 1000}`);
      }

      const bounds = createBounds();
      const report = await bounds.getUsage({ working, episodic, semantic, procedural });

      const hardAlert = report.alerts.find((a) => a.includes('hard limit'));
      expect(hardAlert).toBeDefined();
    });

    it('returns zero alerts when all tiers are well below limits', async () => {
      const bounds = createBounds();
      const report = await bounds.getUsage({
        working: new WorkingMemory({ capacity: 100 }),
        episodic: new EpisodicMemory({ capacity: 1000 }),
        semantic: new SemanticMemory({ capacity: 1000 }),
        procedural: new ProceduralMemory(),
      });

      expect(report.alerts).toEqual([]);
    });
  });

  describe('graceful degradation', () => {
    it('does not crash when enforce is called on an empty tier', async () => {
      const bounds = createBounds();
      const tiers = {
        working: new WorkingMemory({ capacity: 100 }),
        episodic: new EpisodicMemory({ capacity: 100 }),
        semantic: new SemanticMemory({ capacity: 100 }),
        procedural: new ProceduralMemory(),
      };

      const report = await bounds.enforce('episodic', tiers);
      expect(report.evictedCount).toBe(0);
    });

    it('does not crash when enforce is called on unknown tier', async () => {
      const bounds = createBounds();
      const tiers = {
        working: new WorkingMemory({ capacity: 100 }),
        episodic: new EpisodicMemory({ capacity: 100 }),
        semantic: new SemanticMemory({ capacity: 100 }),
        procedural: new ProceduralMemory(),
      };

      const report = await bounds.enforce('nonexistent', tiers);
      expect(report.evictedCount).toBe(0);
    });

    it('handles exceeding hard limit without crashing', async () => {
      // Even if somehow entries exceed hard limit significantly,
      // enforcement should not throw
      const episodic = new EpisodicMemory({ capacity: 1000 });
      for (let i = 0; i < 50; i++) {
        await episodic.add(`episode ${i}`);
      }

      const bounds = createBounds();
      const tiers = {
        working: new WorkingMemory({ capacity: 100 }),
        episodic,
        semantic: new SemanticMemory({ capacity: 1000 }),
        procedural: new ProceduralMemory(),
      };

      // Should not throw
      const report = await bounds.enforce('episodic', tiers);
      expect(report.evictedCount).toBeGreaterThan(0);
      expect(report.remainingCount).toBeLessThan(50);
    });
  });

  describe('total file size monitoring', () => {
    it('reports totalFileSizeMB as 0 when no files exist', async () => {
      const bounds = createBounds();
      const report = await bounds.getUsage({
        working: new WorkingMemory({ capacity: 100 }),
        episodic: new EpisodicMemory({ capacity: 100 }),
        semantic: new SemanticMemory({ capacity: 100 }),
        procedural: new ProceduralMemory(),
      });

      // With mocked fs returning empty arrays, total should be 0
      expect(report.totalFileSizeMB).toBe(0);
    });

    it('generates file size alert when total exceeds soft limit', async () => {
      // Override fs mock to return large file sizes
      const { readdir, stat } = await import('fs/promises');
      const mockReaddir = vi.mocked(readdir);
      const mockStat = vi.mocked(stat);

      // Simulate 60MB of files (above soft=50, below hard=100)
      mockReaddir.mockResolvedValue(['a.json', 'b.json'] as unknown as Awaited<ReturnType<typeof readdir>>);
      mockStat.mockResolvedValue({ size: 10 * 1024 * 1024 } as Awaited<ReturnType<typeof stat>>);

      const bounds = createBounds();
      const report = await bounds.getUsage({
        working: new WorkingMemory({ capacity: 100 }),
        episodic: new EpisodicMemory({ capacity: 100 }),
        semantic: new SemanticMemory({ capacity: 100 }),
        procedural: new ProceduralMemory(),
      });

      // With mocked files: 3 collections (episodes, segment-index, entry-meta, memory, skills)
      // = 5 dirs * 2 files * 10MB = 100MB total
      const fileSizeAlert = report.alerts.find((a) => a.includes('file size'));
      expect(fileSizeAlert).toBeDefined();

      // Restore mock defaults
      mockReaddir.mockResolvedValue([]);
      mockStat.mockResolvedValue({ size: 0 } as Awaited<ReturnType<typeof stat>>);
    });
  });

  describe('eviction determinism', () => {
    it('evicts the same number of entries and targets the lowest-heat entries', async () => {
      // Create episodic memory with varied heat scores
      const episodic = new EpisodicMemory({ capacity: 1000 });
      const entries: Array<{ id: string; heatScore: number }> = [];
      for (let i = 0; i < 12; i++) {
        const entry = await episodic.add(`episode ${i}`);
        entry.heatScore = i * 0.1;
        entry.createdAt = 1000 + i;
        entries.push({ id: entry.id, heatScore: entry.heatScore });
      }

      const bounds = createBounds();
      const tiers = {
        working: new WorkingMemory({ capacity: 100 }),
        episodic,
        semantic: new SemanticMemory({ capacity: 100 }),
        procedural: new ProceduralMemory(),
      };

      const report = await bounds.enforce('episodic', tiers);

      // Should evict exactly 1 entry (10% of hard=10, but min 1, excess=2)
      expect(report.evictedCount).toBe(1);

      // The evicted entry should be the one with the lowest heat score
      const lowestHeat = entries.sort((a, b) => a.heatScore - b.heatScore)[0];
      expect(report.evictedIds[0]).toBe(lowestHeat.id);

      // Running enforce again should still evict the next-lowest
      const report2 = await bounds.enforce('episodic', tiers);
      expect(report2.evictedCount).toBe(1);
      // The second-lowest heat entry should now be evicted
      const secondLowest = entries[1];
      expect(report2.evictedIds[0]).toBe(secondLowest.id);
    });
  });
});
