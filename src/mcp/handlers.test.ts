import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the handler functions via the exported handlers map.
// Since handlers depend on heavy subsystems (MemoryManager, FileStore, etc),
// we mock the key dependencies and test input validation + response format.

// Mock all heavy dependencies
vi.mock('../memory/manager.js', () => ({
  MemoryManager: vi.fn().mockImplementation(() => ({
    init: vi.fn(),
    recall: vi.fn().mockResolvedValue([]),
    addToEpisodic: vi.fn().mockResolvedValue({ id: 'mem-1', content: 'test', tier: 'episodic' }),
    addSkill: vi.fn().mockResolvedValue({ id: 'sk-1', name: 'test-skill' }),
    listSkills: vi.fn().mockResolvedValue([]),
    searchSkills: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({
      working: { count: 0, capacity: 10, isFull: false },
      episodic: { entryCount: 0, segmentCount: 0, avgHeatScore: 0, capacityUtilization: 0 },
      semantic: { entryCount: 0, capacity: 5000, dedupHitCount: 0 },
      procedural: { total: 0, active: 0, archived: 0, avgConfidence: 0, avgSuccessRate: 0 },
      snapshots: 0,
    }),
    stalenessStats: vi.fn().mockReturnValue({}),
    consolidate: vi.fn().mockResolvedValue({ timestamp: Date.now(), movedToEpisodic: 0, movedToSemantic: 0, evicted: 0, merged: 0 }),
    createSnapshot: vi.fn().mockResolvedValue({ id: 'snap-1', name: 'test', timestamp: Date.now(), tierSizes: {} }),
    rollback: vi.fn().mockResolvedValue({ id: 'snap-1', name: 'test', timestamp: Date.now(), tierSizes: {} }),
    getSemanticMemory: vi.fn().mockReturnValue({}),
  })),
}));

vi.mock('../utils/file-store.js', () => ({
  FileStore: vi.fn().mockImplementation(() => ({
    init: vi.fn(),
    write: vi.fn(),
    read: vi.fn(),
    readAll: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
  })),
}));

vi.mock('../utils/project-scanner.js', () => ({
  scanProject: vi.fn().mockResolvedValue({
    name: 'test-project',
    type: 'node',
    techStack: ['typescript'],
    dependencies: [],
  }),
}));

vi.mock('../utils/embeddings.js', () => ({
  getEmbedding: vi.fn(() => ({ keywords: [], simhash: BigInt(0), embedding: undefined })),
  extractKeywords: vi.fn(() => []),
  simHash: vi.fn(() => BigInt(0)),
  simHashSimilarity: vi.fn(() => 0),
}));

vi.mock('../utils/similarity.js', () => ({
  combinedSimilarity: vi.fn(() => 0),
}));

vi.mock('../utils/hashing.js', () => ({
  contentHash: vi.fn(() => 'hash'),
}));

vi.mock('../reflection/coordinator.js', () => ({
  ReflectionCoordinator: vi.fn().mockImplementation(() => ({
    getMicroData: vi.fn().mockResolvedValue({}),
    getMesoData: vi.fn().mockResolvedValue({}),
    getMacroData: vi.fn().mockResolvedValue({}),
    metrics: vi.fn().mockResolvedValue({}),
    getUnreflectedEpisodes: vi.fn().mockResolvedValue([]),
    storeReflection: vi.fn().mockResolvedValue({
      reflection: { id: 'ref-1', actionableInsights: [] },
      isDuplicate: false,
      actionabilityScore: 0.5,
      semanticEntryId: 'sem-1',
    }),
  })),
}));

vi.mock('../planning/context.js', () => ({
  PlanContextBuilder: vi.fn().mockImplementation(() => ({
    getContext: vi.fn().mockResolvedValue({
      confidence: 0.5,
      suggestedApproach: '',
      pastAttempts: [],
      knownPitfalls: [],
      applicableSkills: [],
      relevantInsights: [],
    }),
  })),
}));

vi.mock('../planning/action-tree.js', () => ({
  ActionTree: vi.fn().mockImplementation(() => ({
    load: vi.fn(),
    getRoot: vi.fn().mockReturnValue(null),
    getBestPath: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../planning/tracker.js', () => ({
  PlanTracker: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../planning/value.js', () => ({
  ValueEstimator: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../curriculum/generator.js', () => ({
  CurriculumGenerator: vi.fn().mockImplementation(() => ({
    suggest: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../curriculum/difficulty.js', () => ({
  DifficultyEstimator: vi.fn(),
}));

vi.mock('../curriculum/skill-extractor.js', () => ({
  SkillExtractor: vi.fn(),
}));

vi.mock('../memory/global-store.js', () => ({
  GlobalStoreManager: vi.fn().mockImplementation(() => ({
    init: vi.fn(),
    listGlobalSkills: vi.fn().mockResolvedValue([]),
    getProfile: vi.fn().mockResolvedValue({ totalEpisodes: 0, learningVelocity: 0 }),
    listRegisteredProjects: vi.fn().mockResolvedValue([]),
    registerProject: vi.fn(),
  })),
}));

vi.mock('../memory/cross-project.js', () => ({
  CrossProjectQuery: vi.fn().mockImplementation(() => ({
    setCurrentProject: vi.fn(),
  })),
}));

vi.mock('../memory/portability.js', () => ({
  PortabilityManager: vi.fn().mockImplementation(() => ({
    importFromProject: vi.fn().mockResolvedValue({ total: 0, imported: 0, skipped: 0, conflicts: [], errors: [] }),
  })),
}));

vi.mock('../memory/project-index.js', () => ({
  ProjectSimilarityIndex: vi.fn().mockImplementation(() => ({
    upsertFingerprint: vi.fn().mockResolvedValue({}),
    findSimilar: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../evolution/promotion.js', () => ({
  SkillPromotionPipeline: vi.fn().mockImplementation(() => ({
    manualPromote: vi.fn().mockResolvedValue({ promoted: true, skillId: 'sk-1', globalSkillId: 'gsk-1', skillName: 'test', reason: 'ok' }),
  })),
}));

vi.mock('../integration/effectiveness-tracker.js', () => ({
  EffectivenessTracker: vi.fn().mockImplementation(() => ({
    recordToolCall: vi.fn(),
    recordRecallHit: vi.fn(),
    getReport: vi.fn().mockResolvedValue({
      currentSession: { sessionId: 's1', durationMs: 0, totalCalls: 0, toolCalls: {}, recallHitRate: 0 },
      pastSessionCount: 0,
      suggestions: [],
    }),
    persist: vi.fn(),
  })),
}));

describe('MCP Handlers', () => {
  let handlers: Map<string, (args: Record<string, unknown>) => Promise<any>>;

  beforeEach(async () => {
    // Clear module cache to reset singletons
    vi.resetModules();
    const mod = await import('./handlers.js');
    handlers = mod.handlers;
  });

  it('exports a handler map with all expected tools', () => {
    const expectedTools = [
      'apex_recall', 'apex_record', 'apex_reflect_get', 'apex_reflect_store',
      'apex_plan_context', 'apex_skills', 'apex_skill_store', 'apex_status',
      'apex_consolidate', 'apex_curriculum', 'apex_setup', 'apex_snapshot',
      'apex_rollback', 'apex_promote', 'apex_import',
    ];
    for (const tool of expectedTools) {
      expect(handlers.has(tool)).toBe(true);
    }
  });

  describe('apex_recall', () => {
    it('fails without query parameter', async () => {
      const handler = handlers.get('apex_recall')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Invalid input');
      expect(text).toContain('query');
    });
  });

  describe('apex_record', () => {
    it('fails without task parameter', async () => {
      const handler = handlers.get('apex_record')!;
      const result = await handler({ outcome: { success: true, description: 'ok', duration: 100 } });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid input');
      expect(result.content[0].text).toContain('task');
    });

    it('fails without outcome parameter', async () => {
      const handler = handlers.get('apex_record')!;
      const result = await handler({ task: 'test task' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid input');
      expect(result.content[0].text).toContain('outcome');
    });
  });

  describe('apex_reflect_store', () => {
    it('fails without level and content', async () => {
      const handler = handlers.get('apex_reflect_store')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid input');
    });
  });

  describe('apex_plan_context', () => {
    it('fails without task parameter', async () => {
      const handler = handlers.get('apex_plan_context')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid input');
      expect(result.content[0].text).toContain('task');
    });
  });

  describe('apex_skill_store', () => {
    it('fails without name, description, pattern', async () => {
      const handler = handlers.get('apex_skill_store')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid input');
    });
  });

  describe('apex_promote', () => {
    it('fails without skillId', async () => {
      const handler = handlers.get('apex_promote')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid input');
      expect(result.content[0].text).toContain('skillId');
    });
  });

  describe('apex_import', () => {
    it('fails without source', async () => {
      const handler = handlers.get('apex_import')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid input');
      expect(result.content[0].text).toContain('source');
    });
  });

  describe('apex_rollback', () => {
    it('fails without snapshotId or latest flag', async () => {
      const handler = handlers.get('apex_rollback')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('snapshotId');
    });
  });
});
