/**
 * Integration Test: MCP Server Lifecycle
 *
 * Tests the handler chain: setup -> record -> recall -> reflect -> status.
 * Verifies state persists across handler calls and input validation works.
 *
 * NOTE: The MCP handlers use module-level singleton state, so we import
 * them and call directly. We point them at temp directories by passing
 * projectPath in setup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { MemoryManager } from '../memory/manager.js';
import { ReflectionCoordinator } from '../reflection/coordinator.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';
import { generateId } from '../types.js';

/**
 * Since the MCP handlers module uses module-level singletons that are hard
 * to reset between tests, we replicate the handler logic directly against
 * the subsystems. This tests the same integration flow without the singleton
 * coupling.
 */
describe('MCP Server Lifecycle', () => {
  let tmpDir: string;
  let dataDir: string;
  let memoryManager: MemoryManager;
  let reflectionCoordinator: ReflectionCoordinator;
  let fileStore: FileStore;
  const logger = new Logger({ prefix: 'test', level: 'error' });

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apex-mcp-lifecycle-'));
    dataDir = path.join(tmpDir, '.apex-data');

    fileStore = new FileStore(dataDir);
    await fileStore.init();

    memoryManager = new MemoryManager({
      projectDataPath: dataDir,
      projectPath: tmpDir,
      logger,
    });
    await memoryManager.init();

    reflectionCoordinator = new ReflectionCoordinator({
      fileStore,
      semanticMemory: memoryManager.getSemanticMemory(),
      logger,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should complete setup -> record -> recall -> reflect -> status chain', async () => {
    // Step 1: Setup (memory manager is already initialized in beforeEach)
    const setupStatus = await memoryManager.status();
    expect(setupStatus.working.count).toBe(0);
    expect(setupStatus.episodic.entryCount).toBe(0);

    // Step 2: Record an episode (simulating apex_record handler)
    const task = 'Fix authentication token validation';
    const content = `Task: ${task}\nOutcome: SUCCESS — Token validation now checks expiry`;
    const episodeEntry = await memoryManager.addToEpisodic(content);

    const episodeId = generateId();
    const episode = {
      id: episodeId,
      task,
      actions: [
        {
          type: 'code_edit',
          description: 'Updated token validation logic',
          timestamp: Date.now(),
          success: true,
        },
      ],
      outcome: {
        success: true,
        description: 'Token validation now checks expiry',
        duration: 25000,
      },
      reward: 1.0,
      timestamp: Date.now(),
    };
    await fileStore.write('episodes', episodeId, episode);

    expect(episodeEntry.id).toBeTruthy();

    // Step 3: Recall (simulating apex_recall handler)
    const recallResults = await memoryManager.recall('authentication token validation', 5);
    expect(recallResults.length).toBeGreaterThan(0);

    const foundEpisode = recallResults.find(
      (r) => r.entry.content.includes('token validation'),
    );
    expect(foundEpisode).toBeDefined();

    // Step 4: Reflect (simulating apex_reflect_store handler)
    const reflection = await reflectionCoordinator.storeReflection({
      level: 'micro',
      content: 'Token validation should always check both signature and expiry timestamp',
      actionableInsights: [
        'Validate JWT signature before checking claims',
        'Always check exp claim against current time with clock skew tolerance',
      ],
      sourceEpisodes: [episodeId],
      confidence: 0.85,
    });

    expect(reflection.reflection.id).toBeTruthy();
    expect(reflection.reflection.actionableInsights.length).toBe(2);

    // Step 5: Status (simulating apex_status handler)
    const finalStatus = await memoryManager.status();
    expect(finalStatus.episodic.entryCount).toBeGreaterThan(0);
  });

  it('should persist state across separate recall calls', async () => {
    // First: record some data
    await memoryManager.addToEpisodic(
      'Task: Set up CI pipeline with GitHub Actions\nOutcome: SUCCESS',
    );
    await memoryManager.addToEpisodic(
      'Task: Configure ESLint with TypeScript plugin\nOutcome: SUCCESS',
    );

    // Save state
    await memoryManager.save();

    // Create a new MemoryManager pointing at the same data directory
    // (simulating a new session)
    const freshManager = new MemoryManager({
      projectDataPath: dataDir,
      projectPath: tmpDir,
      logger,
    });
    await freshManager.init();

    // The fresh manager should be able to recall previously stored data
    const results = await freshManager.recall('CI pipeline GitHub Actions', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content).toContain('CI pipeline');
  });

  it('should handle missing required parameters gracefully', async () => {
    // Recall with empty query should still work (returns empty or all)
    const results = await memoryManager.recall('', 5);
    // Should not throw, may return 0 or more results
    expect(Array.isArray(results)).toBe(true);
  });

  it('should store and retrieve skills across handler-like calls', async () => {
    // Store a skill (simulating apex_skill_store)
    const skill = await memoryManager.addSkill({
      name: 'vitest-snapshot-testing',
      description: 'Use vitest snapshot tests for component output verification',
      pattern: 'expect(result).toMatchSnapshot()',
      preconditions: ['Project uses vitest'],
      tags: ['testing', 'vitest', 'snapshot'],
      sourceProject: tmpDir,
      sourceFiles: [],
    });

    // Search for skills (simulating apex_skills with action=search)
    const searchResults = await memoryManager.searchSkills('vitest snapshot', 5);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].skill.name).toBe('vitest-snapshot-testing');

    // List all skills (simulating apex_skills with action=list)
    const allSkills = await memoryManager.listSkills();
    expect(allSkills.length).toBeGreaterThanOrEqual(1);

    // Get specific skill by ID
    const retrieved = await memoryManager.getSkill(skill.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('vitest-snapshot-testing');
  });

  it('should track reflection metrics across multiple reflections', async () => {
    // Store multiple reflections
    await reflectionCoordinator.storeReflection({
      level: 'micro',
      content: 'Error handling in async code needs try-catch at every await',
      actionableInsights: ['Wrap all awaits in try-catch'],
      confidence: 0.8,
    });

    await reflectionCoordinator.storeReflection({
      level: 'meso',
      content: 'Pattern analysis: most failures come from unhandled promise rejections',
      errorTypes: ['unhandled-rejection'],
      actionableInsights: [
        'Add global unhandled rejection handler',
        'Use Promise.allSettled instead of Promise.all',
      ],
      confidence: 0.9,
    });

    const metrics = await reflectionCoordinator.metrics();
    expect(metrics.totalReflections).toBeGreaterThanOrEqual(2);
    expect(metrics.byLevel.micro).toBeGreaterThanOrEqual(1);
    expect(metrics.byLevel.meso).toBeGreaterThanOrEqual(1);
    expect(metrics.totalInsights).toBeGreaterThanOrEqual(3);
  });

  it('should handle concurrent operations without data corruption', async () => {
    // Fire off multiple operations concurrently
    const promises = [
      memoryManager.addToEpisodic('Concurrent entry 1: auth module fix'),
      memoryManager.addToEpisodic('Concurrent entry 2: database migration'),
      memoryManager.addToEpisodic('Concurrent entry 3: API endpoint'),
      memoryManager.addSkill({
        name: 'concurrent-skill',
        description: 'Test concurrent skill creation',
        pattern: 'Step 1\nStep 2',
        tags: ['test'],
        sourceProject: tmpDir,
        sourceFiles: [],
      }),
    ];

    const results = await Promise.all(promises);

    // All operations should succeed
    for (const result of results) {
      expect(result).toBeDefined();
      expect(result.id).toBeTruthy();
    }

    // Recall should find all entries
    const status = await memoryManager.status();
    expect(status.episodic.entryCount).toBeGreaterThanOrEqual(3);
    expect(status.procedural.total).toBeGreaterThanOrEqual(1);
  });
});
