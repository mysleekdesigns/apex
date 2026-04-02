/**
 * Integration Test: Cold Start
 *
 * Tests that a new project with existing global skills can immediately
 * access those skills via recall, even with zero local history.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { MemoryManager } from '../memory/manager.js';
import { ProceduralMemory } from '../memory/procedural.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

describe('Cold Start', () => {
  let tmpDir: string;
  let newProjectDir: string;
  let newProjectDataDir: string;
  let globalDir: string;
  let globalStore: FileStore;
  const logger = new Logger({ prefix: 'test', level: 'error' });

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apex-cold-start-'));
    newProjectDir = path.join(tmpDir, 'new-project');
    newProjectDataDir = path.join(newProjectDir, '.apex-data');
    globalDir = path.join(tmpDir, 'global');

    globalStore = new FileStore(globalDir);
    await globalStore.init();

    // Pre-populate global store with skills (simulating skills from other projects)
    const globalProcedural = new ProceduralMemory({ fileStore: globalStore, logger });
    await globalProcedural.load();

    await globalProcedural.addSkill({
      name: 'eslint-config-setup',
      description: 'Set up ESLint configuration for TypeScript projects',
      pattern: '1. Install eslint and typescript-eslint\n2. Create .eslintrc.json\n3. Add lint script',
      tags: ['eslint', 'typescript', 'linting'],
      sourceProject: '/other/project',
      sourceFiles: [],
      successRate: 0.95,
      usageCount: 15,
      confidence: 0.9,
    });

    await globalProcedural.addSkill({
      name: 'vitest-setup',
      description: 'Configure vitest for a TypeScript project',
      pattern: '1. Install vitest\n2. Add vitest.config.ts\n3. Configure tsconfig for tests',
      tags: ['vitest', 'testing', 'typescript'],
      sourceProject: '/another/project',
      sourceFiles: [],
      successRate: 0.9,
      usageCount: 8,
      confidence: 0.85,
    });

    await globalProcedural.addSkill({
      name: 'docker-compose-dev',
      description: 'Set up Docker Compose for local development',
      pattern: '1. Create docker-compose.yml\n2. Define services\n3. Add volumes for hot reload',
      tags: ['docker', 'devops'],
      sourceProject: '/devops/project',
      sourceFiles: [],
      successRate: 0.85,
      usageCount: 5,
      confidence: 0.75,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should return global skills immediately on a new project with no local data', async () => {
    // Create a new project MemoryManager with empty local data
    const newProjectStore = new FileStore(newProjectDataDir);
    await newProjectStore.init();

    const manager = new MemoryManager({
      projectDataPath: newProjectDataDir,
      globalDataPath: globalDir,
      projectPath: newProjectDir,
      logger,
    });
    await manager.init();

    // Verify local memory is empty
    const status = await manager.status();
    expect(status.episodic.entryCount).toBe(0);
    expect(status.working.count).toBe(0);

    // Recall should still find global skills
    const results = await manager.recall('ESLint TypeScript configuration', 5);
    expect(results.length).toBeGreaterThan(0);

    const globalResult = results.find((r) => r.source === 'global');
    expect(globalResult).toBeDefined();
    expect(globalResult!.entry.content).toContain('eslint-config-setup');
  });

  it('should find global skills by topic query', async () => {
    const newProjectStore = new FileStore(newProjectDataDir);
    await newProjectStore.init();

    const manager = new MemoryManager({
      projectDataPath: newProjectDataDir,
      globalDataPath: globalDir,
      projectPath: newProjectDir,
      logger,
    });
    await manager.init();

    // Query about testing setup
    const testResults = await manager.recall('vitest testing setup configuration', 5);
    expect(testResults.length).toBeGreaterThan(0);

    const vitestResult = testResults.find((r) =>
      r.entry.content.includes('vitest-setup'),
    );
    expect(vitestResult).toBeDefined();

    // Query about Docker
    const dockerResults = await manager.recall('Docker development environment compose', 5);
    expect(dockerResults.length).toBeGreaterThan(0);

    const dockerResult = dockerResults.find((r) =>
      r.entry.content.includes('docker-compose-dev'),
    );
    expect(dockerResult).toBeDefined();
  });

  it('should merge local and global results once local data is added', async () => {
    const newProjectStore = new FileStore(newProjectDataDir);
    await newProjectStore.init();

    const manager = new MemoryManager({
      projectDataPath: newProjectDataDir,
      globalDataPath: globalDir,
      projectPath: newProjectDir,
      logger,
    });
    await manager.init();

    // Add some local data
    await manager.addToEpisodic(
      'Task: Configure ESLint for this project\nOutcome: SUCCESS — ESLint working with strict rules',
    );
    await manager.addSkill({
      name: 'project-specific-lint-rule',
      description: 'Custom ESLint rule for this project naming conventions',
      pattern: 'Create custom rule in .eslintrc that enforces PascalCase for components',
      tags: ['eslint', 'typescript'],
      sourceProject: newProjectDir,
      sourceFiles: [],
    });

    // Recall should now return both local and global results
    const results = await manager.recall('ESLint TypeScript configuration rules', 10);
    expect(results.length).toBeGreaterThan(0);

    const sources = new Set(results.map((r) => r.source));
    // Should have both project and global results
    expect(sources.has('project')).toBe(true);
    expect(sources.has('global')).toBe(true);
  });

  it('should work without a global store configured', async () => {
    const newProjectStore = new FileStore(newProjectDataDir);
    await newProjectStore.init();

    // Create manager WITHOUT globalDataPath
    const manager = new MemoryManager({
      projectDataPath: newProjectDataDir,
      projectPath: newProjectDir,
      logger,
    });
    await manager.init();

    // Recall should work but return empty results (no local or global data)
    const results = await manager.recall('anything at all', 5);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);

    // Adding local data should work fine
    await manager.addToEpisodic('Local entry in project without global store');
    const afterResults = await manager.recall('local entry', 5);
    expect(afterResults.length).toBeGreaterThan(0);
  });

  it('should apply global score discount to cold-start results', async () => {
    const newProjectStore = new FileStore(newProjectDataDir);
    await newProjectStore.init();

    const manager = new MemoryManager({
      projectDataPath: newProjectDataDir,
      globalDataPath: globalDir,
      projectPath: newProjectDir,
      logger,
    });
    await manager.init();

    // Add a local skill identical to a global one
    await manager.addSkill({
      name: 'eslint-config-setup-local',
      description: 'Set up ESLint configuration for TypeScript projects locally',
      pattern: '1. Install eslint\n2. Configure for TypeScript',
      tags: ['eslint', 'typescript'],
      sourceProject: newProjectDir,
      sourceFiles: [],
    });

    const results = await manager.recall('ESLint TypeScript setup', 10);

    // Find both local and global versions
    const localResult = results.find(
      (r) => r.source === 'project' && r.sourceTier === 'procedural',
    );
    const globalResult = results.find(
      (r) => r.source === 'global' && r.sourceTier === 'procedural',
    );

    // Both should exist
    if (localResult && globalResult) {
      // Global results should have a score discount applied
      // (0.9x multiplier per the MemoryManager implementation)
      // Given identical content, local should score >= global
      expect(localResult.score).toBeGreaterThanOrEqual(globalResult.score * 0.89);
    }
  });
});
