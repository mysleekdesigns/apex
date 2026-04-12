import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../utils/file-store.js';
import { MicroAssembler } from './micro.js';
import type { Episode, Reflection } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let fileStore: FileStore;

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

function createAssembler(): MicroAssembler {
  return new MicroAssembler({ fileStore });
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

describe('MicroAssembler.assembleReflexion', () => {
  it('works for a failed episode', async () => {
    const assembler = createAssembler();
    const failed = makeEpisode({
      id: 'ep-fail-1',
      task: 'fix authentication bug in login',
      outcome: {
        success: false,
        description: 'Tests still failing',
        errorType: 'type-error',
        duration: 15000,
      },
      reward: 0.2,
      actions: [
        { type: 'code_edit', description: 'edited auth.ts', timestamp: Date.now(), success: true },
        { type: 'command', description: 'ran tests', timestamp: Date.now(), success: false },
      ],
    });
    await fileStore.write('episodes', failed.id, failed);

    const result = await assembler.assembleReflexion({ episodeId: 'ep-fail-1' });

    expect(result.level).toBe('micro');
    expect(result.reflexionTemplate.type).toBe('failure');
    expect(result.reflexionTemplate.root_cause).toContain('type-error');
    expect(result.verbalReward).toContain('fix authentication bug');
    expect(result.failedEpisode.id).toBe('ep-fail-1');
  });

  it('works for a successful episode', async () => {
    const assembler = createAssembler();
    const success = makeEpisode({
      id: 'ep-success-1',
      task: 'fix authentication bug',
      outcome: { success: true, description: 'Bug fixed', duration: 20000 },
      reward: 0.9,
    });
    await fileStore.write('episodes', success.id, success);

    const result = await assembler.assembleReflexion({ episodeId: 'ep-success-1' });

    expect(result.reflexionTemplate.type).toBe('success');
    expect(result.reflexionTemplate.root_cause).toBe('N/A');
    expect(result.reflexionTemplate.what_to_try_next).toBe('Continue this approach');
    expect(result.reflexionTemplate.confidence).toBe(0.8);
    // For success, no contrastive search should occur
    expect(result.contrastiveEpisode).toBeUndefined();
  });

  it('reflexionTemplate.type is failure for failed episodes', async () => {
    const assembler = createAssembler();
    const failed = makeEpisode({
      id: 'ep-fail-2',
      outcome: {
        success: false,
        description: 'Crashed',
        errorType: 'runtime-error',
        duration: 5000,
      },
      reward: 0.0,
    });
    await fileStore.write('episodes', failed.id, failed);

    const result = await assembler.assembleReflexion({ episodeId: failed.id });
    expect(result.reflexionTemplate.type).toBe('failure');
  });

  it('reflexionTemplate.type is success for successful episodes', async () => {
    const assembler = createAssembler();
    const ep = makeEpisode({ id: 'ep-succ-2' });
    await fileStore.write('episodes', ep.id, ep);

    const result = await assembler.assembleReflexion({ episodeId: ep.id });
    expect(result.reflexionTemplate.type).toBe('success');
  });

  it('verbalReward string contains the task description', async () => {
    const assembler = createAssembler();
    const ep = makeEpisode({
      id: 'ep-vr-1',
      task: 'refactor payment module',
    });
    await fileStore.write('episodes', ep.id, ep);

    const result = await assembler.assembleReflexion({ episodeId: ep.id });
    expect(result.verbalReward).toContain('refactor payment module');
  });

  it('prior insights influence what_to_try_next for failures', async () => {
    const assembler = createAssembler();

    // Store a reflection with an actionable insight related to the task
    const reflection = makeReflection({
      id: 'ref-insight-1',
      content: 'fix authentication bug requires checking null values',
      actionableInsights: ['Always validate auth token before use'],
    });
    await fileStore.write('reflections', reflection.id, reflection);

    const failed = makeEpisode({
      id: 'ep-insight-1',
      task: 'fix authentication bug in session handler',
      outcome: {
        success: false,
        description: 'Null pointer on auth token',
        errorType: 'null-reference',
        duration: 8000,
      },
      reward: 0.1,
      actions: [
        { type: 'code_edit', description: 'edited session.ts', timestamp: Date.now(), success: false },
      ],
    });
    await fileStore.write('episodes', failed.id, failed);

    const result = await assembler.assembleReflexion({ episodeId: failed.id });

    // With no contrastive episode but with prior insights, what_to_try_next
    // should come from the first prior insight
    if (!result.contrastiveEpisode && result.priorInsights.length > 0) {
      expect(result.reflexionTemplate.what_to_try_next).toBe(result.priorInsights[0]);
    }
    // Either way, the template should be filled in
    expect(result.reflexionTemplate.what_to_try_next).toBeTruthy();
  });
});
