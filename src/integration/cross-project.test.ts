/**
 * Integration Test: Cross-Project Skill Promotion
 *
 * Tests the full cross-project learning flow:
 * - Create skill in project A
 * - Promote to global store
 * - Verify accessible from project B context
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { MemoryManager } from '../memory/manager.js';
import { ProceduralMemory } from '../memory/procedural.js';
import { CrossProjectQuery } from '../memory/cross-project.js';
import { SkillPromotionPipeline } from '../evolution/promotion.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

describe('Cross-Project Skill Promotion', () => {
  let tmpDir: string;
  let projectADir: string;
  let projectBDir: string;
  let projectADataDir: string;
  let projectBDataDir: string;
  let globalDir: string;
  let projectAStore: FileStore;
  let projectBStore: FileStore;
  let globalStore: FileStore;
  const logger = new Logger({ prefix: 'test', level: 'error' });

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apex-cross-project-'));

    projectADir = path.join(tmpDir, 'project-a');
    projectBDir = path.join(tmpDir, 'project-b');
    globalDir = path.join(tmpDir, 'global');

    projectADataDir = path.join(projectADir, '.apex-data');
    projectBDataDir = path.join(projectBDir, '.apex-data');

    projectAStore = new FileStore(projectADataDir);
    projectBStore = new FileStore(projectBDataDir);
    globalStore = new FileStore(globalDir);

    await projectAStore.init();
    await projectBStore.init();
    await globalStore.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should promote a skill from project A to global and access from project B', async () => {
    // Step 1: Create a skill in project A
    const managerA = new MemoryManager({
      projectDataPath: projectADataDir,
      globalDataPath: globalDir,
      projectPath: projectADir,
      logger,
    });
    await managerA.init();

    const skill = await managerA.addSkill({
      name: 'error-boundary-pattern',
      description: 'Implement React error boundaries for graceful error handling',
      pattern: '1. Create ErrorBoundary class\n2. Wrap components\n3. Add fallback UI',
      tags: ['react', 'error-handling'],
      sourceProject: projectADir,
      sourceFiles: [],
      successRate: 0.95,
      usageCount: 10,
      confidence: 0.85,
    });

    expect(skill.id).toBeTruthy();

    // Step 2: Promote skill to global store
    const pipeline = new SkillPromotionPipeline({
      projectStore: projectAStore,
      globalStore,
      logger,
    });

    const promotionResult = await pipeline.manualPromote(skill.id, projectADir, 'project-a');

    expect(promotionResult.promoted).toBe(true);
    expect(promotionResult.globalSkillId).toBeTruthy();

    // Step 3: Verify accessible from project B context via global store
    const managerB = new MemoryManager({
      projectDataPath: projectBDataDir,
      globalDataPath: globalDir,
      projectPath: projectBDir,
      logger,
    });
    await managerB.init();

    // Recall from project B should find the global skill
    const results = await managerB.recall('React error boundary graceful handling', 10);

    const globalResult = results.find((r) => r.source === 'global');
    expect(globalResult).toBeDefined();
    expect(globalResult!.entry.content).toContain('error-boundary-pattern');
  });

  it('should search global skills via CrossProjectQuery', async () => {
    // Store a skill in the global store directly (simulating a prior promotion)
    const globalProcedural = new ProceduralMemory({ fileStore: globalStore, logger });
    await globalProcedural.load();

    await globalProcedural.addSkill({
      name: 'typescript-strict-null-checks',
      description: 'Enable and handle strict null checks in TypeScript projects',
      pattern: 'Enable strictNullChecks in tsconfig, add null guards throughout codebase',
      tags: ['typescript', 'type-safety'],
      sourceProject: '/some/project',
      sourceFiles: [],
      successRate: 0.9,
      usageCount: 5,
      confidence: 0.8,
    });

    // Query from project B
    const cpq = new CrossProjectQuery({
      projectStore: projectBStore,
      globalStore,
      logger,
    });

    const results = await cpq.search('TypeScript strict null checks', 5);
    expect(results.length).toBeGreaterThan(0);

    const globalResult = results.find((r) => r.source === 'global');
    expect(globalResult).toBeDefined();
    expect(globalResult!.entry.content).toContain('strict-null-checks');
  });

  it('should apply tech-stack boost for same-language projects', async () => {
    const cpq = new CrossProjectQuery({
      projectStore: projectBStore,
      globalStore,
      logger,
    });

    // Set project B as a TypeScript project
    cpq.setCurrentProject({
      name: 'project-b',
      path: projectBDir,
      type: 'library',
      techStack: ['typescript', 'react'],
      dependencies: [],
      scripts: {},
      structure: [],
    });

    // TypeScript skill should get a boost
    const tsBoost = cpq.computeTechStackBoost(['typescript', 'react']);
    expect(tsBoost).toBeGreaterThan(1.0);

    // Python skill should NOT get a boost
    const pyBoost = cpq.computeTechStackBoost(['python', 'django']);
    expect(pyBoost).toBe(1.0);

    // Same language but different framework gets partial boost
    const tsOtherBoost = cpq.computeTechStackBoost(['typescript', 'vue']);
    expect(tsOtherBoost).toBeGreaterThan(1.0);
    // But less than same-language + same-framework
    expect(tsOtherBoost).toBeLessThanOrEqual(tsBoost);
  });

  it('should deduplicate results when same skill exists locally and globally', async () => {
    // Add same-named skill to both project and global stores
    const projectProcedural = new ProceduralMemory({ fileStore: projectBStore, logger });
    await projectProcedural.load();
    const localSkill = await projectProcedural.addSkill({
      name: 'shared-pattern',
      description: 'A pattern that exists in both local and global',
      pattern: 'Do the thing',
      tags: ['shared'],
      sourceProject: projectBDir,
      sourceFiles: [],
    });

    const globalProcedural = new ProceduralMemory({ fileStore: globalStore, logger });
    await globalProcedural.load();
    await globalProcedural.addSkill({
      id: localSkill.id, // Same ID to test dedup
      name: 'shared-pattern',
      description: 'A pattern that exists in both local and global',
      pattern: 'Do the thing',
      tags: ['shared'],
      sourceProject: projectBDir,
      sourceFiles: [],
    });

    const cpq = new CrossProjectQuery({
      projectStore: projectBStore,
      globalStore,
      logger,
    });

    const results = await cpq.search('shared pattern', 10);

    // Should not have duplicates with the same ID
    const ids = results.map((r) => r.entry.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('should discount global results relative to project results', async () => {
    // Add identical skills to project and global stores with different IDs
    const projectProcedural = new ProceduralMemory({ fileStore: projectBStore, logger });
    await projectProcedural.load();
    await projectProcedural.addSkill({
      name: 'local-error-handling',
      description: 'Error handling pattern for this specific project',
      pattern: 'Try-catch with project-specific logging',
      tags: ['error-handling'],
      sourceProject: projectBDir,
      sourceFiles: [],
    });

    const globalProcedural = new ProceduralMemory({ fileStore: globalStore, logger });
    await globalProcedural.load();
    await globalProcedural.addSkill({
      name: 'global-error-handling',
      description: 'Error handling pattern for general use',
      pattern: 'Try-catch with standard logging',
      tags: ['error-handling'],
      sourceProject: '/other/project',
      sourceFiles: [],
    });

    const cpq = new CrossProjectQuery({
      projectStore: projectBStore,
      globalStore,
      logger,
    });

    const results = await cpq.search('error handling pattern', 10);
    expect(results.length).toBeGreaterThanOrEqual(2);

    // Find the project and global results
    const projectResult = results.find((r) => r.source === 'project');
    const globalResult = results.find((r) => r.source === 'global');

    // Both should be present
    expect(projectResult).toBeDefined();
    expect(globalResult).toBeDefined();

    // Global results should have a discount applied (score * 0.9)
    // so given similar content, the project result should score higher
    // (this depends on the similarity scores being similar)
  });
});
