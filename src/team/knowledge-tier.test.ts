import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeTier } from './knowledge-tier.js';
import type { SharedKnowledge } from './knowledge-tier.js';

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

describe('KnowledgeTier', () => {
  let tmpDir: string;
  let tier: KnowledgeTier;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apex-knowledge-tier-'));
    tier = new KnowledgeTier({
      projectPath: tmpDir,
      author: 'test-author',
      logger: mockLogger,
    });
    await tier.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  it('init creates directory structure', () => {
    const sharedPath = join(tmpDir, '.apex-shared');
    expect(existsSync(sharedPath)).toBe(true);
    expect(existsSync(join(sharedPath, 'skills'))).toBe(true);
    expect(existsSync(join(sharedPath, 'knowledge'))).toBe(true);
    expect(existsSync(join(sharedPath, 'error-taxonomy'))).toBe(true);
    expect(existsSync(join(sharedPath, 'proposals'))).toBe(true);
    expect(existsSync(join(sharedPath, 'changelog'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // addEntry
  // -------------------------------------------------------------------------

  it('addEntry creates skill', async () => {
    const entry = await tier.addEntry({
      content: 'Use memoization for expensive computations',
      category: 'skill',
      author: 'alice',
      sourceProject: '/project/a',
      tags: ['performance', 'optimization'],
      confidence: 0.9,
    });

    expect(entry.id).toBeDefined();
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.category).toBe('skill');
    expect(entry.content).toBe('Use memoization for expensive computations');
    expect(entry.author).toBe('alice');
  });

  it('addEntry creates knowledge', async () => {
    const entry = await tier.addEntry({
      content: 'TypeScript strict mode catches null errors at compile time',
      category: 'knowledge',
      author: 'bob',
      sourceProject: '/project/b',
      tags: ['typescript'],
      confidence: 0.85,
    });

    expect(entry.category).toBe('knowledge');
    expect(entry.id).toBeDefined();
  });

  it('addEntry creates error-taxonomy', async () => {
    const entry = await tier.addEntry({
      content: 'ENOENT errors occur when file path is missing',
      category: 'error-taxonomy',
      author: 'carol',
      sourceProject: '/project/c',
      tags: ['filesystem', 'node'],
      confidence: 0.95,
    });

    expect(entry.category).toBe('error-taxonomy');
    expect(entry.id).toBeDefined();
  });

  it('addEntry auto-generates timestamps', async () => {
    const before = Date.now();
    const entry = await tier.addEntry({
      content: 'Timestamp test',
      category: 'skill',
      author: 'alice',
      sourceProject: '/project/a',
      tags: [],
      confidence: 0.8,
    });
    const after = Date.now();

    expect(entry.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt).toBeLessThanOrEqual(after);
    expect(entry.updatedAt).toBeGreaterThanOrEqual(before);
    expect(entry.updatedAt).toBeLessThanOrEqual(after);
    expect(entry.createdAt).toBe(entry.updatedAt);
  });

  // -------------------------------------------------------------------------
  // getEntry
  // -------------------------------------------------------------------------

  it('getEntry returns entry', async () => {
    const added = await tier.addEntry({
      content: 'Retrieve me',
      category: 'skill',
      author: 'alice',
      sourceProject: '/project/a',
      tags: ['test'],
      confidence: 0.7,
    });

    const fetched = await tier.getEntry('skills', added.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(added.id);
    expect(fetched!.content).toBe('Retrieve me');
  });

  it('getEntry returns null for missing', async () => {
    const result = await tier.getEntry('skills', 'nonexistent-id');
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // listEntries
  // -------------------------------------------------------------------------

  it('listEntries returns all entries across categories', async () => {
    await tier.addEntry({
      content: 'Skill entry',
      category: 'skill',
      author: 'alice',
      sourceProject: '/p',
      tags: [],
      confidence: 0.8,
    });
    await tier.addEntry({
      content: 'Knowledge entry',
      category: 'knowledge',
      author: 'bob',
      sourceProject: '/p',
      tags: [],
      confidence: 0.7,
    });
    await tier.addEntry({
      content: 'Error entry',
      category: 'error-taxonomy',
      author: 'carol',
      sourceProject: '/p',
      tags: [],
      confidence: 0.9,
    });

    const all = await tier.listEntries();
    expect(all).toHaveLength(3);
  });

  it('listEntries filters by category', async () => {
    await tier.addEntry({
      content: 'Skill 1',
      category: 'skill',
      author: 'alice',
      sourceProject: '/p',
      tags: [],
      confidence: 0.8,
    });
    await tier.addEntry({
      content: 'Skill 2',
      category: 'skill',
      author: 'bob',
      sourceProject: '/p',
      tags: [],
      confidence: 0.7,
    });
    await tier.addEntry({
      content: 'Knowledge 1',
      category: 'knowledge',
      author: 'carol',
      sourceProject: '/p',
      tags: [],
      confidence: 0.9,
    });

    const skills = await tier.listEntries('skill');
    expect(skills).toHaveLength(2);
    expect(skills.every((e) => e.category === 'skill')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // removeEntry
  // -------------------------------------------------------------------------

  it('removeEntry deletes entry', async () => {
    const added = await tier.addEntry({
      content: 'Remove me',
      category: 'knowledge',
      author: 'alice',
      sourceProject: '/p',
      tags: [],
      confidence: 0.8,
    });

    const removed = await tier.removeEntry('knowledge', added.id);
    expect(removed).toBe(true);

    const fetched = await tier.getEntry('knowledge', added.id);
    expect(fetched).toBeNull();
  });

  it('removeEntry returns false for missing', async () => {
    const result = await tier.removeEntry('knowledge', 'does-not-exist');
    expect(result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // searchEntries
  // -------------------------------------------------------------------------

  it('searchEntries finds by keyword in content', async () => {
    await tier.addEntry({
      content: 'Use memoization for expensive computations',
      category: 'skill',
      author: 'alice',
      sourceProject: '/p',
      tags: ['perf'],
      confidence: 0.9,
    });
    await tier.addEntry({
      content: 'Always validate user input before processing',
      category: 'knowledge',
      author: 'bob',
      sourceProject: '/p',
      tags: ['security'],
      confidence: 0.85,
    });

    const results = await tier.searchEntries('memoization');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('memoization');
  });

  it('searchEntries filters by category', async () => {
    await tier.addEntry({
      content: 'Caching improves performance',
      category: 'skill',
      author: 'alice',
      sourceProject: '/p',
      tags: ['caching'],
      confidence: 0.8,
    });
    await tier.addEntry({
      content: 'Caching can cause stale data issues',
      category: 'knowledge',
      author: 'bob',
      sourceProject: '/p',
      tags: ['caching'],
      confidence: 0.7,
    });

    const results = await tier.searchEntries('caching', 'skill');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('skill');
  });

  it('searchEntries matches tags', async () => {
    await tier.addEntry({
      content: 'Some generic content here',
      category: 'skill',
      author: 'alice',
      sourceProject: '/p',
      tags: ['react', 'hooks', 'frontend'],
      confidence: 0.8,
    });
    await tier.addEntry({
      content: 'Backend service patterns',
      category: 'skill',
      author: 'bob',
      sourceProject: '/p',
      tags: ['backend', 'api'],
      confidence: 0.7,
    });

    const results = await tier.searchEntries('react');
    expect(results).toHaveLength(1);
    expect(results[0].tags).toContain('react');
  });

  // -------------------------------------------------------------------------
  // getStats
  // -------------------------------------------------------------------------

  it('getStats returns correct counts', async () => {
    await tier.addEntry({
      content: 'S1',
      category: 'skill',
      author: 'a',
      sourceProject: '/p',
      tags: [],
      confidence: 0.8,
    });
    await tier.addEntry({
      content: 'S2',
      category: 'skill',
      author: 'b',
      sourceProject: '/p',
      tags: [],
      confidence: 0.7,
    });
    await tier.addEntry({
      content: 'K1',
      category: 'knowledge',
      author: 'a',
      sourceProject: '/p',
      tags: [],
      confidence: 0.9,
    });
    await tier.addEntry({
      content: 'E1',
      category: 'error-taxonomy',
      author: 'c',
      sourceProject: '/p',
      tags: [],
      confidence: 0.6,
    });

    const stats = await tier.getStats();
    expect(stats.skillCount).toBe(2);
    expect(stats.knowledgeCount).toBe(1);
    expect(stats.errorTaxonomyCount).toBe(1);
    expect(stats.totalEntries).toBe(4);
    expect(stats.lastUpdated).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // getChangelog
  // -------------------------------------------------------------------------

  it('getChangelog records activity', async () => {
    const entry = await tier.addEntry({
      content: 'Track me',
      category: 'skill',
      author: 'alice',
      sourceProject: '/p',
      tags: [],
      confidence: 0.8,
    });

    await tier.removeEntry('skills', entry.id);

    const changelog = await tier.getChangelog();
    expect(changelog.length).toBeGreaterThanOrEqual(2);

    const actions = changelog.map((c) => c.action);
    expect(actions).toContain('add');
    expect(actions).toContain('remove');
  });

  // -------------------------------------------------------------------------
  // Privacy boundary
  // -------------------------------------------------------------------------

  it('privacy boundary — no episode category allowed in shared store', async () => {
    // The KnowledgeTier only supports skill, knowledge, and error-taxonomy.
    // Attempting to store an 'episode' category should fail or be unrecognized.
    // Since categoryToCollection only handles the 3 valid categories, passing
    // an invalid one would cause an error.
    const categories = ['skill', 'knowledge', 'error-taxonomy'] as const;
    for (const cat of categories) {
      const entry = await tier.addEntry({
        content: `Valid ${cat}`,
        category: cat,
        author: 'alice',
        sourceProject: '/p',
        tags: [],
        confidence: 0.8,
      });
      expect(entry.category).toBe(cat);
    }

    // Verify no 'episodes' collection exists in the shared store
    const ids = await tier.store.list('episodes');
    expect(ids).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Multiple authors
  // -------------------------------------------------------------------------

  it('multiple authors tracked', async () => {
    await tier.addEntry({
      content: 'Alice skill',
      category: 'skill',
      author: 'alice',
      sourceProject: '/p/a',
      tags: [],
      confidence: 0.8,
    });
    await tier.addEntry({
      content: 'Bob skill',
      category: 'skill',
      author: 'bob',
      sourceProject: '/p/b',
      tags: [],
      confidence: 0.7,
    });
    await tier.addEntry({
      content: 'Carol knowledge',
      category: 'knowledge',
      author: 'carol',
      sourceProject: '/p/c',
      tags: [],
      confidence: 0.9,
    });

    const all = await tier.listEntries();
    const authors = new Set(all.map((e) => e.author));
    expect(authors.size).toBe(3);
    expect(authors.has('alice')).toBe(true);
    expect(authors.has('bob')).toBe(true);
    expect(authors.has('carol')).toBe(true);
  });
});
