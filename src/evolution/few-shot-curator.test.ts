import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FewShotCurator } from './few-shot-curator.js';
import type { FewShotExample } from './few-shot-curator.js';
import type { Episode } from '../types.js';
import { generateId } from '../types.js';

// ---------------------------------------------------------------------------
// Mock FileStore
// ---------------------------------------------------------------------------

function createMockFileStore() {
  const store = new Map<string, Map<string, unknown>>();

  return {
    init: vi.fn(async () => {}),
    write: vi.fn(async (collection: string, id: string, data: unknown) => {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(id, data);
    }),
    read: vi.fn(async (collection: string, id: string) => {
      return store.get(collection)?.get(id) ?? null;
    }),
    readAll: vi.fn(async (collection: string) => {
      const col = store.get(collection);
      if (!col) return [];
      return [...col.values()];
    }),
    list: vi.fn(async (collection: string) => {
      const col = store.get(collection);
      if (!col) return [];
      return [...col.keys()];
    }),
    delete: vi.fn(async () => {}),
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: generateId(),
    task: 'test task',
    actions: [
      {
        type: 'file-edit',
        description: 'edited a file',
        timestamp: Date.now(),
        success: true,
      },
      {
        type: 'shell-command',
        description: 'ran npm test',
        timestamp: Date.now(),
        success: true,
      },
    ],
    outcome: { success: true, description: 'completed', duration: 5000 },
    reward: 0.9,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeExample(overrides: Partial<FewShotExample> = {}): FewShotExample {
  return {
    id: generateId(),
    toolName: 'file-edit',
    input: { description: 'test input' },
    description: 'test example description',
    sourceEpisodeId: null,
    quality: 0.8,
    usageCount: 0,
    successAfterUse: 0,
    createdAt: new Date().toISOString(),
    lastUsed: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FewShotCurator', () => {
  let fileStore: ReturnType<typeof createMockFileStore>;
  let curator: FewShotCurator;

  beforeEach(async () => {
    fileStore = createMockFileStore();
    curator = new FewShotCurator({
      fileStore: fileStore as never,
      maxExamplesPerTool: 3,
      rotationInterval: 10,
    });
    await curator.init();
  });

  it('extractExamples from successful episodes', () => {
    const successEp = makeEpisode({ reward: 0.95 });
    const failEp = makeEpisode({
      outcome: { success: false, description: 'failed', duration: 1000 },
      reward: 0.1,
    });

    const examples = curator.extractExamples([successEp, failEp]);

    // Only the successful episode should produce examples
    expect(examples.length).toBeGreaterThan(0);
    for (const ex of examples) {
      expect(ex.sourceEpisodeId).toBe(successEp.id);
      expect(ex.quality).toBe(0.95);
    }
  });

  it('addExample and retrieve by tool name', async () => {
    const ex = makeExample({ toolName: 'shell-command' });
    await curator.addExample(ex);

    const retrieved = curator.getExamplesForTool('shell-command');
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].id).toBe(ex.id);

    const empty = curator.getExamplesForTool('nonexistent');
    expect(empty).toHaveLength(0);
  });

  it('getBestExamples respects quality ranking and rotation', async () => {
    const highQuality = makeExample({ toolName: 'test-tool', quality: 0.9, usageCount: 0 });
    const medQuality = makeExample({ toolName: 'test-tool', quality: 0.7, usageCount: 0 });
    const overused = makeExample({ toolName: 'test-tool', quality: 0.95, usageCount: 15 });

    await curator.addExample(highQuality);
    await curator.addExample(medQuality);
    await curator.addExample(overused);

    const best = curator.getBestExamples('test-tool', 2);
    expect(best).toHaveLength(2);
    // High quality with low usage should beat overused high quality
    expect(best[0].id).toBe(highQuality.id);
  });

  it('recordUsage and recordOutcome updates quality', async () => {
    const ex = makeExample({ toolName: 'quality-test', quality: 0.5 });
    await curator.addExample(ex);

    await curator.recordUsage(ex.id);
    await curator.recordUsage(ex.id);
    await curator.recordOutcome(ex.id, true);
    await curator.recordOutcome(ex.id, true);

    const updated = curator.getExamplesForTool('quality-test')[0];
    expect(updated.usageCount).toBe(2);
    expect(updated.successAfterUse).toBe(2);
    // quality = successAfterUse / max(usageCount, 1) = 2/2 = 1.0
    expect(updated.quality).toBe(1.0);
  });

  it('pruneExamples removes low-quality after sufficient usage', async () => {
    const good = makeExample({ toolName: 'prune-test', quality: 0.8, usageCount: 5, successAfterUse: 4 });
    const bad = makeExample({ toolName: 'prune-test', quality: 0.1, usageCount: 5, successAfterUse: 0 });
    const tooNew = makeExample({ toolName: 'prune-test', quality: 0.1, usageCount: 1, successAfterUse: 0 });

    await curator.addExample(good);
    await curator.addExample(bad);
    await curator.addExample(tooNew);

    const pruned = await curator.pruneExamples(0.3, 3);
    expect(pruned).toBe(1); // Only `bad` is pruned (low quality, sufficient usage)

    const remaining = curator.getExamplesForTool('prune-test');
    expect(remaining).toHaveLength(2);
    expect(remaining.find((e) => e.id === bad.id)).toBeUndefined();
  });

  it('formatForInjection produces readable text', async () => {
    await curator.addExample(makeExample({
      toolName: 'format-test',
      description: 'Edited config file for deployment',
      quality: 0.9,
    }));
    await curator.addExample(makeExample({
      toolName: 'format-test',
      description: 'Updated package.json scripts',
      quality: 0.8,
    }));

    const text = curator.formatForInjection('format-test');
    expect(text).toContain('Example 1:');
    expect(text).toContain('Example 2:');
    expect(text).toContain('Edited config file for deployment');
    expect(text).toContain('Updated package.json scripts');
  });

  it('persist and reload preserves state', async () => {
    const ex = makeExample({ toolName: 'persist-test' });
    await curator.addExample(ex);
    await curator.persist();

    // Create a new curator with the same file store
    const curator2 = new FewShotCurator({
      fileStore: fileStore as never,
      maxExamplesPerTool: 3,
    });
    await curator2.init();

    const retrieved = curator2.getExamplesForTool('persist-test');
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].id).toBe(ex.id);
    expect(retrieved[0].toolName).toBe('persist-test');
  });
});
