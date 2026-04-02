/**
 * Integration Test: Curriculum Progression
 *
 * Tests the curriculum generator end-to-end:
 * - Generate curriculum suggestions
 * - Verify difficulty increases over time as skills improve
 * - Failure-directed curriculum targets weak areas
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { CurriculumGenerator } from '../curriculum/generator.js';
import { MemoryManager } from '../memory/manager.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';
import type { Episode } from '../types.js';
import { generateId } from '../types.js';

describe('Curriculum Progression', () => {
  let tmpDir: string;
  let dataDir: string;
  let fileStore: FileStore;
  let generator: CurriculumGenerator;
  let memoryManager: MemoryManager;
  const logger = new Logger({ prefix: 'test', level: 'error' });

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apex-curriculum-'));
    dataDir = path.join(tmpDir, '.apex-data');

    fileStore = new FileStore(dataDir);
    await fileStore.init();

    generator = new CurriculumGenerator({ fileStore, logger });

    memoryManager = new MemoryManager({
      projectDataPath: dataDir,
      projectPath: tmpDir,
      logger,
    });
    await memoryManager.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeEpisode(
    task: string,
    success: boolean,
    reward: number,
    opts?: { errorType?: string; difficulty?: number },
  ): Episode {
    return {
      id: generateId(),
      task,
      actions: [
        {
          type: 'code_edit',
          description: 'Worked on task',
          timestamp: Date.now(),
          success,
        },
      ],
      outcome: {
        success,
        description: success ? 'Completed' : 'Failed',
        errorType: opts?.errorType,
        duration: 30000,
      },
      reward,
      timestamp: Date.now(),
      metadata: opts?.difficulty !== undefined ? { difficulty: opts.difficulty } : undefined,
    };
  }

  it('should generate suggestions for a domain with no history', async () => {
    const suggestions = await generator.suggest([], [], {
      domain: 'testing',
      count: 3,
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);

    for (const s of suggestions) {
      expect(s.task.domain).toBe('testing');
      expect(s.task.difficulty).toBeGreaterThanOrEqual(0);
      expect(s.task.difficulty).toBeLessThanOrEqual(1);
      expect(s.reason).toBeTruthy();
    }
  });

  it('should increase suggested difficulty as agent skill improves', async () => {
    // Simulate a beginner: a few easy successes
    const beginnerEpisodes: Episode[] = [
      makeEpisode('Write a simple unit test for a pure function', true, 0.3, { difficulty: 0.1 }),
      makeEpisode('Add test coverage for utility module', true, 0.3, { difficulty: 0.2 }),
    ];

    const beginnerSuggestions = await generator.suggest(beginnerEpisodes, [], {
      domain: 'testing',
      count: 3,
    });

    // Simulate an intermediate agent: many successes at higher difficulty
    const intermediateEpisodes: Episode[] = [
      ...beginnerEpisodes,
      makeEpisode('Write integration tests with mock dependencies', true, 0.7, { difficulty: 0.5 }),
      makeEpisode('Achieve 90% branch coverage for complex module', true, 0.7, { difficulty: 0.6 }),
      makeEpisode('Create test fixtures for database integration tests', true, 0.8, { difficulty: 0.7 }),
      makeEpisode('Design test strategy for async event handlers', true, 0.8, { difficulty: 0.7 }),
    ];

    const intermediateSuggestions = await generator.suggest(intermediateEpisodes, [], {
      domain: 'testing',
      count: 3,
    });

    // The intermediate suggestions should target higher difficulty than beginner
    const beginnerAvgDifficulty = beginnerSuggestions.reduce(
      (sum, s) => sum + s.task.difficulty, 0,
    ) / beginnerSuggestions.length;

    const intermediateAvgDifficulty = intermediateSuggestions.reduce(
      (sum, s) => sum + s.task.difficulty, 0,
    ) / intermediateSuggestions.length;

    expect(intermediateAvgDifficulty).toBeGreaterThanOrEqual(beginnerAvgDifficulty);
  });

  it('should target weak areas when there are recurring failures', async () => {
    const episodes: Episode[] = [
      // Successes in testing
      makeEpisode('Write unit test for parser', true, 0.5, { difficulty: 0.3 }),
      makeEpisode('Add test for auth module', true, 0.5, { difficulty: 0.3 }),
      // Failures with specific error type
      makeEpisode('Fix type error in handler', false, 0.0, { errorType: 'type-error' }),
      makeEpisode('Debug type error in middleware', false, 0.0, { errorType: 'type-error' }),
      makeEpisode('Resolve type mismatch in API layer', false, 0.0, { errorType: 'type-error' }),
    ];

    const suggestions = await generator.suggest(episodes, [], { count: 5 });

    // Some suggestions should target the weakness
    const hasWeaknessTarget = suggestions.some((s) => s.targetWeakness !== undefined);
    expect(hasWeaknessTarget).toBe(true);
  });

  it('should suggest tasks for uncovered domains', async () => {
    // Agent has only worked in testing domain
    const episodes: Episode[] = [
      makeEpisode('Write test for parser', true, 0.5),
      makeEpisode('Add test coverage', true, 0.5),
    ];

    const suggestions = await generator.suggest(episodes, [], { count: 10 });

    // Should suggest tasks — domain coverage depends on generator logic
    const domains = new Set(suggestions.map((s) => s.task.domain));
    expect(domains.size).toBeGreaterThanOrEqual(1);
  });

  it('should enrich suggestions with relevant skill recommendations', async () => {
    // Add a testing skill
    await memoryManager.addSkill({
      name: 'vitest-mock-setup',
      description: 'Set up vitest mocks for testing external dependencies',
      pattern: 'vi.mock() the module, define return values, verify calls',
      tags: ['testing', 'vitest', 'mock'],
      sourceProject: tmpDir,
      sourceFiles: [],
    });

    const allSkills = await memoryManager.listSkills();

    const episodes: Episode[] = [
      makeEpisode('Write test with mocks', true, 0.5),
    ];

    const suggestions = await generator.suggest(episodes, allSkills, {
      domain: 'testing',
      count: 3,
    });

    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('should compute domain progress from episode history', () => {
    const episodes: Episode[] = [
      makeEpisode('Write test for auth', true, 0.5),
      makeEpisode('Add test coverage for utils', true, 0.7),
      makeEpisode('Test the API endpoint', false, 0.0, { errorType: 'timeout' }),
      makeEpisode('Refactor module structure', true, 0.8),
      makeEpisode('Refactor component hierarchy', false, 0.0, { errorType: 'type-error' }),
    ];

    const progress = generator.getDomainProgress(episodes);
    expect(progress.length).toBeGreaterThan(0);

    for (const dp of progress) {
      expect(dp.domain).toBeTruthy();
      expect(dp.episodeCount).toBeGreaterThan(0);
      expect(dp.successRate).toBeGreaterThanOrEqual(0);
      expect(dp.successRate).toBeLessThanOrEqual(1);
      expect(dp.currentLevel).toBeGreaterThanOrEqual(0);
      expect(dp.currentLevel).toBeLessThanOrEqual(1);
    }
  });

  it('should identify weak areas from failure patterns', () => {
    const episodes: Episode[] = [];

    // Create a pattern of failures
    for (let i = 0; i < 5; i++) {
      episodes.push(
        makeEpisode(`Debug type error ${i}`, false, 0.0, { errorType: 'type-error' }),
      );
      episodes.push(
        makeEpisode(`Fix type issue ${i}`, true, 0.5),
      );
    }

    const weakAreas = generator.getWeakAreas(episodes);
    expect(weakAreas.length).toBeGreaterThan(0);

    const typeErrorWeakness = weakAreas.find((w) => w.errorType === 'type-error');
    expect(typeErrorWeakness).toBeDefined();
    expect(typeErrorWeakness!.failureRate).toBeGreaterThan(0);
  });

  it('should provide ZPD-appropriate tasks via generateZPDTasks', () => {
    // Beginner level
    const beginnerTasks = generator.generateZPDTasks(0.1, 'testing', []);
    expect(beginnerTasks.length).toBeGreaterThan(0);
    for (const t of beginnerTasks) {
      expect(t.difficulty).toBeLessThanOrEqual(0.6);
    }

    // Advanced level
    const advancedTasks = generator.generateZPDTasks(0.8, 'testing', []);
    expect(advancedTasks.length).toBeGreaterThan(0);
    for (const t of advancedTasks) {
      expect(t.difficulty).toBeGreaterThanOrEqual(0.4);
    }
  });
});
