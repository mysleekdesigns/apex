/**
 * Integration Test: Staleness Detection
 *
 * Tests that memory entries referencing source files are correctly tagged
 * as stale when those files change on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';

import { MemoryManager } from '../memory/manager.js';
import { StalenessDetector } from '../memory/staleness.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';
import type { MemoryEntry, SearchResult } from '../types.js';
import { generateId } from '../types.js';

describe('Staleness Detection', () => {
  let tmpDir: string;
  let dataDir: string;
  let memoryManager: MemoryManager;
  let staleness: StalenessDetector;
  const logger = new Logger({ prefix: 'test', level: 'error' });

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apex-staleness-'));
    dataDir = path.join(tmpDir, '.apex-data');

    const fileStore = new FileStore(dataDir);
    await fileStore.init();

    memoryManager = new MemoryManager({
      projectDataPath: dataDir,
      projectPath: tmpDir,
      logger,
    });
    await memoryManager.init();

    staleness = memoryManager.getStalenessDetector();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should tag recall results as stale when source files change', async () => {
    // Create a source file
    const sourceFile = path.join(tmpDir, 'auth.ts');
    await writeFile(sourceFile, 'export function validateToken() { return true; }');

    // Record a memory entry referencing that file
    const entry = await memoryManager.addToEpisodic({
      id: generateId(),
      content: 'Task: Fix validateToken function\nOutcome: SUCCESS',
      heatScore: 0.5,
      confidence: 1.0,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      tier: 'episodic',
      sourceFiles: [sourceFile],
    } as MemoryEntry);

    // First recall: entry should NOT be stale (file hasn't changed)
    // The staleness detector records the file state on first check
    const firstResults = await memoryManager.recall('validateToken', 5);
    expect(firstResults.length).toBeGreaterThan(0);

    // Simulate file modification by changing its mtime
    const futureTime = new Date(Date.now() + 60000);
    await utimes(sourceFile, futureTime, futureTime);

    // Second recall: entry should be tagged as stale
    const secondResults = await memoryManager.recall('validateToken', 5);
    expect(secondResults.length).toBeGreaterThan(0);

    const staleResult = secondResults.find(
      (r) => r.entry.stale === true || r.entry.content.includes('[STALE'),
    );
    expect(staleResult).toBeDefined();
  });

  it('should detect missing source files', async () => {
    const missingFile = path.join(tmpDir, 'deleted-module.ts');

    // Check a file that doesn't exist
    const result = staleness.checkFiles([missingFile]);
    expect(result.missingFiles).toContain(missingFile);
    expect(result.changedFiles.length).toBe(0);
  });

  it('should detect changed source files', async () => {
    const sourceFile = path.join(tmpDir, 'utils.ts');
    await writeFile(sourceFile, 'export const VERSION = 1;');

    // Record initial state
    staleness.checkFiles([sourceFile]);

    // Modify the file
    const futureTime = new Date(Date.now() + 60000);
    await utimes(sourceFile, futureTime, futureTime);

    // Check again: should detect the change
    const result = staleness.checkFiles([sourceFile]);
    expect(result.changedFiles).toContain(sourceFile);
  });

  it('should not report unchanged files as stale', async () => {
    const sourceFile = path.join(tmpDir, 'stable.ts');
    await writeFile(sourceFile, 'export const STABLE = true;');

    // Record initial state
    staleness.checkFiles([sourceFile]);

    // Check again without modification: should be clean
    const result = staleness.checkFiles([sourceFile]);
    expect(result.changedFiles.length).toBe(0);
    expect(result.missingFiles.length).toBe(0);
  });

  it('should refresh staleness state after acknowledged changes', async () => {
    const sourceFile = path.join(tmpDir, 'refreshable.ts');
    await writeFile(sourceFile, 'export const FOO = 1;');

    // Record initial state
    staleness.checkFiles([sourceFile]);

    // Modify file
    const futureTime = new Date(Date.now() + 60000);
    await utimes(sourceFile, futureTime, futureTime);

    // Detect change
    const changed = staleness.checkFiles([sourceFile]);
    expect(changed.changedFiles.length).toBe(1);

    // Refresh (user acknowledged staleness)
    staleness.refresh([sourceFile]);

    // Now file should be considered up-to-date
    const afterRefresh = staleness.checkFiles([sourceFile]);
    expect(afterRefresh.changedFiles.length).toBe(0);
  });

  it('should check entry staleness via checkEntry', async () => {
    const sourceFile = path.join(tmpDir, 'entry-check.ts');
    await writeFile(sourceFile, 'export function check() {}');

    const entry: MemoryEntry = {
      id: generateId(),
      content: 'Knowledge about the check function',
      heatScore: 0.5,
      confidence: 1.0,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      tier: 'semantic',
      sourceFiles: [sourceFile],
    };

    // First check records state, returns not stale
    const firstCheck = staleness.checkEntry(entry);
    expect(firstCheck.stale).toBe(false);

    // Modify file
    const futureTime = new Date(Date.now() + 60000);
    await utimes(sourceFile, futureTime, futureTime);

    // Second check should detect staleness
    const secondCheck = staleness.checkEntry(entry);
    expect(secondCheck.stale).toBe(true);
    expect(secondCheck.changedFiles).toContain(sourceFile);
  });

  it('should tag search results with staleness annotations', async () => {
    const sourceFile = path.join(tmpDir, 'annotate.ts');
    await writeFile(sourceFile, 'export const ANNOTATE = true;');

    const entry: MemoryEntry = {
      id: generateId(),
      content: 'Information about the annotate module',
      heatScore: 0.5,
      confidence: 1.0,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      tier: 'episodic',
      sourceFiles: [sourceFile],
    };

    // Record initial state
    staleness.checkFiles([sourceFile]);

    // Modify file
    const futureTime = new Date(Date.now() + 60000);
    await utimes(sourceFile, futureTime, futureTime);

    // Build a mock SearchResult array and tag it
    const mockResults: SearchResult[] = [
      { entry, score: 0.8, sourceTier: 'episodic', source: 'project' },
    ];

    const tagged = staleness.tagSearchResults(mockResults);
    expect(tagged.length).toBe(1);
    expect(tagged[0].entry.content).toContain('[STALE');
    expect(tagged[0].entry.stale).toBe(true);
  });

  it('should report staleness stats', async () => {
    const sourceFile = path.join(tmpDir, 'stats.ts');
    await writeFile(sourceFile, 'export const STAT = 1;');

    const entry: MemoryEntry = {
      id: generateId(),
      content: 'Stats test entry',
      heatScore: 0.5,
      confidence: 1.0,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      tier: 'episodic',
      sourceFiles: [sourceFile],
    };

    staleness.checkEntry(entry);

    const stats = staleness.getStats();
    expect(stats.totalChecked).toBeGreaterThanOrEqual(1);
    expect(typeof stats.filesTracked).toBe('number');
    expect(typeof stats.staleCount).toBe('number');
    expect(typeof stats.invalidCount).toBe('number');
  });
});
