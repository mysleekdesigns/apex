import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../utils/file-store.js';
import { PlanContextBuilder } from './context.js';
import type { Episode, Reflection } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let fileStore: FileStore;

const mockMemoryManager = {
  searchSkills: async () => [],
} as any;

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: `ep-${Math.random().toString(36).slice(2, 8)}`,
    task: 'fix authentication bug',
    actions: [
      { type: 'code_edit', description: 'edited auth.ts', timestamp: Date.now(), success: true },
      { type: 'command', description: 'ran tests', timestamp: Date.now(), success: true },
    ],
    outcome: { success: true, description: 'Bug fixed', duration: 30000 },
    reward: 0.8,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReflection(overrides: Partial<Reflection> = {}): Reflection {
  return {
    id: `ref-${Math.random().toString(36).slice(2, 8)}`,
    level: 'micro',
    content: 'Always check null values before accessing properties',
    errorTypes: ['type-error'],
    actionableInsights: ['Validate inputs before processing'],
    sourceEpisodes: [],
    timestamp: Date.now(),
    confidence: 0.7,
    ...overrides,
  };
}

function createBuilder(): PlanContextBuilder {
  return new PlanContextBuilder({
    fileStore,
    memoryManager: mockMemoryManager,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'apex-test-'));
  fileStore = new FileStore(tmpDir);
  await fileStore.init();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlanContextBuilder — lessonsLearned', () => {
  it('returns lessonsLearned array in context', async () => {
    const builder = createBuilder();
    const ctx = await builder.getContext('fix authentication bug');

    expect(ctx.lessonsLearned).toBeDefined();
    expect(Array.isArray(ctx.lessonsLearned)).toBe(true);
  });

  it('extracts lessons from matching reflections', async () => {
    const builder = createBuilder();

    // Store a reflection with content that matches the task via keyword/simhash similarity
    const reflection = makeReflection({
      id: 'ref-lesson-1',
      content: 'fix authentication bug requires careful token validation',
      actionableInsights: ['Always validate auth tokens', 'Check token expiry'],
    });
    await fileStore.write('reflections', reflection.id, reflection);

    const ctx = await builder.getContext('fix authentication bug');

    expect(ctx.lessonsLearned.length).toBeGreaterThan(0);
    // Each lesson should have the expected shape
    for (const lesson of ctx.lessonsLearned) {
      expect(lesson.lesson).toBeTruthy();
      expect(lesson.relevance).toBeGreaterThan(0);
      expect(lesson.level).toBeTruthy();
      expect(lesson.timestamp).toBeGreaterThan(0);
      expect(lesson.reflectionId).toBeTruthy();
    }
  });

  it('caps lessonsLearned at 5', async () => {
    const builder = createBuilder();

    // Store 4 reflections, each with 2 actionable insights => 8 potential lessons
    for (let i = 0; i < 4; i++) {
      const ref = makeReflection({
        id: `ref-cap-${i}`,
        content: 'fix authentication bug with proper validation and testing',
        actionableInsights: [
          `Insight A from reflection ${i}`,
          `Insight B from reflection ${i}`,
        ],
      });
      await fileStore.write('reflections', ref.id, ref);
    }

    const ctx = await builder.getContext('fix authentication bug');
    expect(ctx.lessonsLearned.length).toBeLessThanOrEqual(5);
  });

  it('sorts lessonsLearned by relevance descending', async () => {
    const builder = createBuilder();

    // Store two reflections: one highly relevant, one less so
    const highRelevance = makeReflection({
      id: 'ref-high',
      content: 'fix authentication bug in login page required token refresh',
      actionableInsights: ['Refresh tokens before validation'],
    });
    const lowRelevance = makeReflection({
      id: 'ref-low',
      content: 'generic code review found authentication issue',
      actionableInsights: ['Review code carefully'],
    });
    await fileStore.write('reflections', highRelevance.id, highRelevance);
    await fileStore.write('reflections', lowRelevance.id, lowRelevance);

    const ctx = await builder.getContext('fix authentication bug in login');

    if (ctx.lessonsLearned.length >= 2) {
      // Lessons should be sorted by relevance descending
      for (let i = 1; i < ctx.lessonsLearned.length; i++) {
        expect(ctx.lessonsLearned[i - 1].relevance).toBeGreaterThanOrEqual(
          ctx.lessonsLearned[i].relevance,
        );
      }
    }
  });

  it('boosts confidence when lessons are present', async () => {
    const builder = createBuilder();

    // Get baseline confidence with no data
    const ctxEmpty = await builder.getContext('fix authentication bug');
    const baseConfidence = ctxEmpty.confidence;

    // Add a matching reflection
    const ref = makeReflection({
      id: 'ref-boost',
      content: 'fix authentication bug with proper null checks',
      actionableInsights: ['Check for null before accessing properties'],
    });
    await fileStore.write('reflections', ref.id, ref);

    const ctxWithLessons = await builder.getContext('fix authentication bug');

    // Confidence should be boosted by 0.1 when lessons exist
    if (ctxWithLessons.lessonsLearned.length > 0) {
      expect(ctxWithLessons.confidence).toBeGreaterThan(baseConfidence);
    }
  });
});
