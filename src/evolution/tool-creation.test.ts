import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolFactory } from './tool-creation.js';
import type { Episode, ToolDefinitionApex, ToolComposition } from '../types.js';
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
// Test episode helpers
// ---------------------------------------------------------------------------

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: generateId(),
    task: 'Test task',
    actions: [
      { type: 'file_read', description: 'Read /src/index.ts', timestamp: Date.now(), success: true },
      { type: 'code_edit', description: 'Edit /src/index.ts to add export', timestamp: Date.now(), success: true },
      { type: 'command', description: 'Run "npm test"', timestamp: Date.now(), success: true },
    ],
    outcome: { success: true, description: 'Task completed', duration: 5000 },
    reward: 1.0,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeEpisodeWithPattern(
  pattern: Array<{ type: string; description: string }>,
  success = true,
): Episode {
  return makeEpisode({
    actions: pattern.map((p) => ({
      ...p,
      timestamp: Date.now(),
      success: true,
    })),
    outcome: { success, description: success ? 'ok' : 'failed', duration: 3000 },
    reward: success ? 1.0 : 0.0,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolFactory', () => {
  let fileStore: ReturnType<typeof createMockFileStore>;
  let factory: ToolFactory;

  beforeEach(() => {
    fileStore = createMockFileStore();
    factory = new ToolFactory({
      fileStore: fileStore as any,
      minFrequency: 3,
      minSuccessRate: 0.8,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    });
  });

  // ── Pattern extraction ─────────────────────────────────────────

  describe('extractPatterns', () => {
    it('identifies recurring action sequences from successful episodes', () => {
      const pattern = [
        { type: 'file_read', description: 'Read /src/foo.ts' },
        { type: 'code_edit', description: 'Edit /src/foo.ts' },
        { type: 'command', description: 'Run "npm test"' },
      ];

      const episodes = [
        makeEpisodeWithPattern(pattern),
        makeEpisodeWithPattern(pattern),
        makeEpisodeWithPattern(pattern),
      ];

      const patterns = factory.extractPatterns(episodes);
      expect(patterns.length).toBeGreaterThan(0);

      // Should find a pattern containing file_read -> code_edit -> command
      const fullMatch = patterns.find(
        (p) =>
          p.actionTypes.length === 3 &&
          p.actionTypes[0] === 'file_read' &&
          p.actionTypes[1] === 'code_edit' &&
          p.actionTypes[2] === 'command',
      );
      expect(fullMatch).toBeDefined();
      expect(fullMatch!.frequency).toBe(3);
      expect(fullMatch!.successRate).toBe(1);
    });

    it('returns empty for no successful episodes', () => {
      const episodes = [
        makeEpisodeWithPattern(
          [{ type: 'command', description: 'fail' }],
          false,
        ),
      ];
      expect(factory.extractPatterns(episodes)).toEqual([]);
    });

    it('filters patterns below minimum frequency', () => {
      const pattern = [
        { type: 'code_edit', description: 'edit file' },
        { type: 'command', description: 'run test' },
      ];

      // Only 2 episodes, but minFrequency is 3
      const episodes = [
        makeEpisodeWithPattern(pattern),
        makeEpisodeWithPattern(pattern),
      ];

      const patterns = factory.extractPatterns(episodes);
      expect(patterns.length).toBe(0);
    });

    it('calculates success rate accounting for failed episodes', () => {
      const pattern = [
        { type: 'code_edit', description: 'edit' },
        { type: 'command', description: 'test' },
      ];

      // 3 successful + 3 failed = 50% success rate, below 0.8 threshold
      const episodes = [
        makeEpisodeWithPattern(pattern, true),
        makeEpisodeWithPattern(pattern, true),
        makeEpisodeWithPattern(pattern, true),
        makeEpisodeWithPattern(pattern, false),
        makeEpisodeWithPattern(pattern, false),
        makeEpisodeWithPattern(pattern, false),
      ];

      const patterns = factory.extractPatterns(episodes);
      expect(patterns.length).toBe(0);
    });
  });

  // ── Tool definition generation ─────────────────────────────────

  describe('proposeTools', () => {
    it('generates tool definitions with proper parameters', () => {
      const pattern = [
        { type: 'file_read', description: 'Read /src/utils/helper.ts' },
        { type: 'code_edit', description: 'Edit /src/utils/helper.ts to fix bug' },
      ];

      const episodes = [
        makeEpisodeWithPattern(pattern),
        makeEpisodeWithPattern(pattern),
        makeEpisodeWithPattern(pattern),
      ];

      const tools = factory.proposeTools(episodes);
      expect(tools.length).toBeGreaterThan(0);

      const tool = tools[0];
      expect(tool.id).toBeDefined();
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.verificationStatus).toBe('pending');
      expect(tool.verificationScore).toBe(0);
      expect(tool.masteryMetrics.usageCount).toBe(0);
      expect(tool.sourceEpisodes.length).toBe(3);
      expect(tool.createdAt).toBeGreaterThan(0);
      expect(tool.tags.length).toBeGreaterThan(0);
    });

    it('extracts parameters from file paths in descriptions', () => {
      const pattern = [
        { type: 'file_read', description: 'Read /src/components/Button.tsx' },
        { type: 'code_edit', description: 'Edit /src/components/Button.tsx' },
      ];

      const episodes = Array.from({ length: 3 }, () =>
        makeEpisodeWithPattern(pattern),
      );

      const tools = factory.proposeTools(episodes);
      expect(tools.length).toBeGreaterThan(0);

      // Should have extracted path parameters
      const tool = tools.find((t) =>
        t.inputSchema.parameters.some((p) => p.name === 'path'),
      );
      expect(tool).toBeDefined();
    });

    it('infers preconditions from action types', () => {
      const pattern = [
        { type: 'code_edit', description: 'Edit file' },
        { type: 'command', description: 'Run shell command' },
      ];

      const episodes = Array.from({ length: 3 }, () =>
        makeEpisodeWithPattern(pattern),
      );

      const tools = factory.proposeTools(episodes);
      expect(tools.length).toBeGreaterThan(0);

      const tool = tools[0];
      expect(tool.preconditions).toContain('Target file must exist and be writable');
      expect(tool.preconditions).toContain('Shell environment must be available');
    });

    it('returns empty array when no patterns meet thresholds', () => {
      const episodes = [makeEpisode()]; // Only 1 episode
      const tools = factory.proposeTools(episodes);
      expect(tools).toEqual([]);
    });
  });

  // ── Verification scoring ───────────────────────────────────────

  describe('verify', () => {
    it('verifies a well-formed tool as verified', () => {
      const tool: ToolDefinitionApex = {
        id: generateId(),
        name: 'file-read-then-code-edit',
        description: 'Auto-extracted tool: file_read -> code_edit\n\nSteps:\n1. [file_read] Read <path>\n2. [code_edit] Edit <path>',
        inputSchema: {
          parameters: [
            { name: 'path', type: 'string', description: 'File path to read and edit', required: true },
          ],
        },
        pattern: JSON.stringify({ actionTypes: ['file_read', 'code_edit'], templates: ['Read <path>', 'Edit <path>'] }),
        preconditions: ['Target file must exist and be writable'],
        expectedOutput: 'Successful completion of 2-step sequence: file_read -> code_edit',
        sourceEpisodes: [generateId(), generateId(), generateId(), generateId(), generateId()],
        verificationStatus: 'pending',
        verificationScore: 0,
        masteryMetrics: { usageCount: 0, successRate: 0, avgDuration: 0, failureContexts: [], lastUsed: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: ['file-read', 'code-edit'],
      };

      const verified = factory.verify(tool);
      expect(verified.verificationStatus).toBe('verified');
      expect(verified.verificationScore).toBeGreaterThan(0.6);
    });

    it('rejects an overfitted tool with single source episode', () => {
      const tool: ToolDefinitionApex = {
        id: generateId(),
        name: 'x',
        description: 'tiny',
        inputSchema: { parameters: [] },
        pattern: '{}',
        preconditions: [],
        expectedOutput: '',
        sourceEpisodes: [generateId()],
        verificationStatus: 'pending',
        verificationScore: 0,
        masteryMetrics: { usageCount: 0, successRate: 0, avgDuration: 0, failureContexts: [], lastUsed: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: [],
      };

      const verified = factory.verify(tool);
      expect(verified.verificationStatus).toBe('rejected');
      expect(verified.verificationScore).toBeLessThan(0.3);
    });

    it('scores higher for tools with more source episodes', () => {
      const baseTool: ToolDefinitionApex = {
        id: generateId(),
        name: 'file-read-then-edit',
        description: 'Read and edit a file\n\nSteps:\n1. [file_read] Read\n2. [code_edit] Edit',
        inputSchema: { parameters: [{ name: 'path', type: 'string', description: 'file', required: true }] },
        pattern: JSON.stringify({ actionTypes: ['file_read', 'code_edit'] }),
        preconditions: ['File must exist'],
        expectedOutput: 'Success',
        sourceEpisodes: [],
        verificationStatus: 'pending',
        verificationScore: 0,
        masteryMetrics: { usageCount: 0, successRate: 0, avgDuration: 0, failureContexts: [], lastUsed: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: ['file-read'],
      };

      const fewEpisodes = factory.verify({ ...baseTool, sourceEpisodes: [generateId(), generateId()] });
      const manyEpisodes = factory.verify({
        ...baseTool,
        sourceEpisodes: Array.from({ length: 5 }, () => generateId()),
      });

      expect(manyEpisodes.verificationScore).toBeGreaterThan(fewEpisodes.verificationScore);
    });

    it('penalises dangerous patterns in safety scoring', () => {
      const safeTool: ToolDefinitionApex = {
        id: generateId(),
        name: 'safe-tool',
        description: 'Read a file and log output\n\nSteps:\n1. [file_read] Read',
        inputSchema: { parameters: [{ name: 'path', type: 'string', description: 'path', required: true }] },
        pattern: JSON.stringify({ actionTypes: ['file_read'] }),
        preconditions: ['File must exist'],
        expectedOutput: 'File contents logged',
        sourceEpisodes: Array.from({ length: 3 }, () => generateId()),
        verificationStatus: 'pending',
        verificationScore: 0,
        masteryMetrics: { usageCount: 0, successRate: 0, avgDuration: 0, failureContexts: [], lastUsed: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: ['file-read'],
      };

      const dangerousTool: ToolDefinitionApex = {
        ...safeTool,
        id: generateId(),
        name: 'dangerous-tool',
        description: 'rm -rf and force delete everything',
        pattern: JSON.stringify({ actionTypes: ['command'], templates: ['rm -rf /'] }),
      };

      const safeResult = factory.verify(safeTool);
      const dangerousResult = factory.verify(dangerousTool);

      expect(safeResult.verificationScore).toBeGreaterThan(dangerousResult.verificationScore);
    });
  });

  // ── Tool composition ───────────────────────────────────────────

  describe('composeTools', () => {
    it('creates composite tools from tool chains in episodes', () => {
      const toolA: ToolDefinitionApex = {
        id: 'tool-a',
        name: 'read-file',
        description: 'Read a file',
        inputSchema: { parameters: [] },
        pattern: JSON.stringify({ actionTypes: ['file_read'] }),
        preconditions: [],
        expectedOutput: 'File contents',
        sourceEpisodes: [],
        verificationStatus: 'verified',
        verificationScore: 0.8,
        masteryMetrics: { usageCount: 5, successRate: 0.9, avgDuration: 100, failureContexts: [], lastUsed: Date.now() },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: ['file-read'],
      };

      const toolB: ToolDefinitionApex = {
        id: 'tool-b',
        name: 'edit-file',
        description: 'Edit a file',
        inputSchema: { parameters: [] },
        pattern: JSON.stringify({ actionTypes: ['code_edit'] }),
        preconditions: [],
        expectedOutput: 'File edited',
        sourceEpisodes: [],
        verificationStatus: 'verified',
        verificationScore: 0.8,
        masteryMetrics: { usageCount: 5, successRate: 0.9, avgDuration: 200, failureContexts: [], lastUsed: Date.now() },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: ['code-edit'],
      };

      // Create episodes where tool A is followed by tool B
      const episodes = Array.from({ length: 4 }, () =>
        makeEpisodeWithPattern([
          { type: 'file_read', description: 'Read file' },
          { type: 'code_edit', description: 'Edit file' },
          { type: 'command', description: 'Run test' },
        ]),
      );

      // Use lower minFrequency factory for composition test
      const compFactory = new ToolFactory({
        fileStore: fileStore as any,
        minFrequency: 2,
        logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      });

      const compositions = compFactory.composeTools([toolA, toolB], episodes);
      expect(compositions.length).toBeGreaterThan(0);

      const comp = compositions[0];
      expect(comp.id).toBeDefined();
      expect(comp.name).toBeTruthy();
      expect(comp.steps.length).toBe(2);
      expect(comp.steps[0].toolId).toBe('tool-a');
      expect(comp.steps[1].toolId).toBe('tool-b');
      expect(comp.usageCount).toBeGreaterThanOrEqual(2);
    });

    it('returns empty when fewer than 2 tools provided', () => {
      const singleTool: ToolDefinitionApex = {
        id: 'only-one',
        name: 'solo',
        description: 'Only tool',
        inputSchema: { parameters: [] },
        pattern: JSON.stringify({ actionTypes: ['command'] }),
        preconditions: [],
        expectedOutput: 'output',
        sourceEpisodes: [],
        verificationStatus: 'verified',
        verificationScore: 0.8,
        masteryMetrics: { usageCount: 0, successRate: 0, avgDuration: 0, failureContexts: [], lastUsed: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: [],
      };

      const compositions = factory.composeTools([singleTool], [makeEpisode()]);
      expect(compositions).toEqual([]);
    });

    it('returns empty with no episodes', () => {
      const tools = [
        { id: 'a', verificationStatus: 'verified', pattern: JSON.stringify({ actionTypes: ['x'] }) },
        { id: 'b', verificationStatus: 'verified', pattern: JSON.stringify({ actionTypes: ['y'] }) },
      ] as ToolDefinitionApex[];

      expect(factory.composeTools(tools, [])).toEqual([]);
    });
  });

  // ── Mastery tracking ───────────────────────────────────────────

  describe('recordUsage', () => {
    const baseTool: ToolDefinitionApex = {
      id: generateId(),
      name: 'test-tool',
      description: 'Test tool',
      inputSchema: { parameters: [] },
      pattern: '{}',
      preconditions: [],
      expectedOutput: '',
      sourceEpisodes: [],
      verificationStatus: 'verified',
      verificationScore: 0.8,
      masteryMetrics: {
        usageCount: 0,
        successRate: 0,
        avgDuration: 0,
        failureContexts: [],
        lastUsed: 0,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tags: [],
    };

    it('increments usage count on success', () => {
      const updated = factory.recordUsage(baseTool, true, 1000);
      expect(updated.masteryMetrics.usageCount).toBe(1);
      expect(updated.masteryMetrics.successRate).toBe(1);
      expect(updated.masteryMetrics.avgDuration).toBe(1000);
      expect(updated.masteryMetrics.lastUsed).toBeGreaterThan(0);
    });

    it('tracks failure context', () => {
      const updated = factory.recordUsage(baseTool, false, 500, 'File not found');
      expect(updated.masteryMetrics.usageCount).toBe(1);
      expect(updated.masteryMetrics.successRate).toBe(0);
      expect(updated.masteryMetrics.failureContexts).toContain('File not found');
    });

    it('computes running average of success rate', () => {
      let tool = baseTool;
      tool = factory.recordUsage(tool, true, 100);
      tool = factory.recordUsage(tool, true, 200);
      tool = factory.recordUsage(tool, false, 300);

      expect(tool.masteryMetrics.usageCount).toBe(3);
      expect(tool.masteryMetrics.successRate).toBeCloseTo(2 / 3);
      expect(tool.masteryMetrics.avgDuration).toBeCloseTo(200);
    });

    it('deprecates tools with consistently low success rate', () => {
      let tool = baseTool;

      // Record 10 failures
      for (let i = 0; i < 10; i++) {
        tool = factory.recordUsage(tool, false, 100, `Failure ${i}`);
      }

      expect(tool.verificationStatus).toBe('deprecated');
      expect(tool.masteryMetrics.successRate).toBe(0);
    });

    it('does not deprecate tools with good success rate', () => {
      let tool = baseTool;

      // 8 successes, 2 failures = 80% success rate
      for (let i = 0; i < 8; i++) {
        tool = factory.recordUsage(tool, true, 100);
      }
      for (let i = 0; i < 2; i++) {
        tool = factory.recordUsage(tool, false, 100);
      }

      expect(tool.verificationStatus).toBe('verified');
      expect(tool.masteryMetrics.successRate).toBeCloseTo(0.8);
    });

    it('limits failure context history to 10 entries', () => {
      let tool = baseTool;

      for (let i = 0; i < 15; i++) {
        tool = factory.recordUsage(tool, false, 100, `Context ${i}`);
      }

      expect(tool.masteryMetrics.failureContexts.length).toBeLessThanOrEqual(10);
    });
  });

  // ── Persistence ────────────────────────────────────────────────

  describe('persistence', () => {
    it('saves and loads a tool', async () => {
      const tool: ToolDefinitionApex = {
        id: 'test-persist-id',
        name: 'persist-tool',
        description: 'A tool to persist',
        inputSchema: { parameters: [] },
        pattern: '{}',
        preconditions: [],
        expectedOutput: '',
        sourceEpisodes: [],
        verificationStatus: 'verified',
        verificationScore: 0.8,
        masteryMetrics: { usageCount: 0, successRate: 0, avgDuration: 0, failureContexts: [], lastUsed: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: [],
      };

      await factory.saveTool(tool);
      const loaded = await factory.loadTool('test-persist-id');
      expect(loaded).toEqual(tool);
    });

    it('lists tools with optional status filter', async () => {
      const verified: ToolDefinitionApex = {
        id: 'v1',
        name: 'verified-tool',
        description: 'verified',
        inputSchema: { parameters: [] },
        pattern: '{}',
        preconditions: [],
        expectedOutput: '',
        sourceEpisodes: [],
        verificationStatus: 'verified',
        verificationScore: 0.8,
        masteryMetrics: { usageCount: 0, successRate: 0, avgDuration: 0, failureContexts: [], lastUsed: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: [],
      };

      const pending: ToolDefinitionApex = {
        ...verified,
        id: 'p1',
        name: 'pending-tool',
        verificationStatus: 'pending',
      };

      await factory.saveTool(verified);
      await factory.saveTool(pending);

      const all = await factory.listTools();
      expect(all.length).toBe(2);

      const onlyVerified = await factory.listTools('verified');
      expect(onlyVerified.length).toBe(1);
      expect(onlyVerified[0].name).toBe('verified-tool');
    });

    it('saves and lists compositions', async () => {
      const comp: ToolComposition = {
        id: 'comp-1',
        name: 'read-then-edit',
        description: 'Read file then edit',
        steps: [
          { toolId: 'tool-a', inputMapping: {} },
          { toolId: 'tool-b', inputMapping: { input: 'previousOutput' } },
        ],
        successRate: 0.9,
        usageCount: 5,
        createdAt: Date.now(),
      };

      await factory.saveComposition(comp);
      const listed = await factory.listCompositions();
      expect(listed.length).toBe(1);
      expect(listed[0]).toEqual(comp);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty episode list gracefully', () => {
      expect(factory.proposeTools([])).toEqual([]);
      expect(factory.extractPatterns([])).toEqual([]);
    });

    it('handles episodes with single action (below minPatternLength)', () => {
      const episodes = Array.from({ length: 5 }, () =>
        makeEpisodeWithPattern([{ type: 'command', description: 'ls' }]),
      );

      const patterns = factory.extractPatterns(episodes);
      expect(patterns.length).toBe(0);
    });

    it('handles episodes with no successful ones', () => {
      const episodes = Array.from({ length: 5 }, () =>
        makeEpisodeWithPattern(
          [
            { type: 'file_read', description: 'Read file' },
            { type: 'code_edit', description: 'Edit file' },
          ],
          false,
        ),
      );

      expect(factory.proposeTools(episodes)).toEqual([]);
    });

    it('verify handles tool with unparseable pattern gracefully', () => {
      const tool: ToolDefinitionApex = {
        id: generateId(),
        name: 'bad-pattern-tool',
        description: 'Tool with unparseable pattern\n\nSteps:\n1. [x] do thing',
        inputSchema: { parameters: [{ name: 'x', type: 'string', description: 'test', required: true }] },
        pattern: 'not-json',
        preconditions: ['must have stuff'],
        expectedOutput: 'Something happens with this tool',
        sourceEpisodes: Array.from({ length: 3 }, () => generateId()),
        verificationStatus: 'pending',
        verificationScore: 0,
        masteryMetrics: { usageCount: 0, successRate: 0, avgDuration: 0, failureContexts: [], lastUsed: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: ['test'],
      };

      // Should not throw
      const verified = factory.verify(tool);
      expect(verified.verificationScore).toBeGreaterThanOrEqual(0);
      expect(verified.verificationScore).toBeLessThanOrEqual(1);
    });
  });
});
