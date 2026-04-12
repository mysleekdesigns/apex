/**
 * Tests for APEX MCP input validation schemas.
 *
 * Covers: valid inputs, invalid inputs (wrong types, missing required fields),
 * optional field defaults, and fuzz testing with random malformed objects.
 */

import { describe, it, expect } from 'vitest';
import {
  validateArgs,
  RecallSchema,
  RecordSchema,
  ReflectGetSchema,
  ReflectStoreSchema,
  PlanContextSchema,
  SkillsSchema,
  SkillStoreSchema,
  StatusSchema,
  ConsolidateSchema,
  CurriculumSchema,
  SetupSchema,
  SnapshotSchema,
  RollbackSchema,
  PromoteSchema,
  ImportSchema,
  ForesightPredictSchema,
  ForesightCheckSchema,
  ForesightResolveSchema,
  PopulationStatusSchema,
  PopulationEvolveSchema,
  ToolProposeSchema,
  ToolVerifySchema,
  ToolListSchema,
  ToolComposeSchema,
  ArchStatusSchema,
  ArchMutateSchema,
  ArchSuggestSchema,
  schemaMap,
} from '../../src/mcp/schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectValid<T>(schema: import('zod').ZodSchema<T>, input: Record<string, unknown>) {
  const result = validateArgs(schema, input);
  expect(result.success).toBe(true);
  if (result.success) return result.data;
  throw new Error('Expected valid input');
}

function expectInvalid<T>(schema: import('zod').ZodSchema<T>, input: Record<string, unknown>) {
  const result = validateArgs(schema, input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.isError).toBe(true);
    const text = result.error.content[0];
    expect(text.type).toBe('text');
    const parsed = JSON.parse((text as { type: 'text'; text: string }).text);
    expect(parsed.error).toBe('Invalid input');
    expect(Array.isArray(parsed.details)).toBe(true);
    return parsed.details as string[];
  }
  throw new Error('Expected invalid input');
}

// ---------------------------------------------------------------------------
// 1. apex_recall
// ---------------------------------------------------------------------------

describe('RecallSchema', () => {
  it('accepts valid input with required fields', () => {
    const data = expectValid(RecallSchema, { query: 'test query' });
    expect(data.query).toBe('test query');
    expect(data.limit).toBeUndefined();
  });

  it('accepts valid input with all fields', () => {
    const data = expectValid(RecallSchema, { query: 'test', context: 'ctx', limit: 5 });
    expect(data.query).toBe('test');
    expect(data.context).toBe('ctx');
    expect(data.limit).toBe(5);
  });

  it('rejects missing query', () => {
    const details = expectInvalid(RecallSchema, {});
    expect(details.some((d: string) => d.includes('query'))).toBe(true);
  });

  it('rejects empty query', () => {
    expectInvalid(RecallSchema, { query: '' });
  });

  it('rejects wrong type for query', () => {
    expectInvalid(RecallSchema, { query: 123 });
  });

  it('rejects wrong type for limit', () => {
    expectInvalid(RecallSchema, { query: 'test', limit: 'ten' });
  });
});

// ---------------------------------------------------------------------------
// 2. apex_record
// ---------------------------------------------------------------------------

describe('RecordSchema', () => {
  const validRecord = {
    task: 'Fix bug',
    actions: [{ type: 'code_edit', description: 'edited file', success: true }],
    outcome: { success: true, description: 'Bug fixed', duration: 5000 },
  };

  it('accepts valid input', () => {
    const data = expectValid(RecordSchema, validRecord);
    expect(data.task).toBe('Fix bug');
    expect(data.actions).toHaveLength(1);
    expect(data.outcome.success).toBe(true);
  });

  it('accepts with optional reward', () => {
    const data = expectValid(RecordSchema, { ...validRecord, reward: 0.8 });
    expect(data.reward).toBe(0.8);
  });

  it('rejects missing task', () => {
    const { task, ...rest } = validRecord;
    expectInvalid(RecordSchema, rest);
  });

  it('rejects missing outcome', () => {
    const { outcome, ...rest } = validRecord;
    expectInvalid(RecordSchema, rest);
  });

  it('rejects malformed actions', () => {
    expectInvalid(RecordSchema, {
      ...validRecord,
      actions: [{ type: 'edit' }], // missing description, success
    });
  });

  it('rejects malformed outcome', () => {
    expectInvalid(RecordSchema, {
      ...validRecord,
      outcome: { success: true }, // missing description, duration
    });
  });
});

// ---------------------------------------------------------------------------
// 3. apex_reflect_get
// ---------------------------------------------------------------------------

describe('ReflectGetSchema', () => {
  it('accepts valid scope', () => {
    const data = expectValid(ReflectGetSchema, { scope: 'recent' });
    expect(data.scope).toBe('recent');
  });

  it('accepts all scope values', () => {
    for (const scope of ['recent', 'similar', 'errors']) {
      expectValid(ReflectGetSchema, { scope });
    }
  });

  it('accepts with optional fields', () => {
    const data = expectValid(ReflectGetSchema, {
      scope: 'similar',
      episodeIds: ['ep-1'],
      taskType: 'testing',
      limit: 5,
    });
    expect(data.episodeIds).toEqual(['ep-1']);
    expect(data.taskType).toBe('testing');
  });

  it('rejects missing scope', () => {
    expectInvalid(ReflectGetSchema, {});
  });

  it('rejects invalid scope value', () => {
    expectInvalid(ReflectGetSchema, { scope: 'all' });
  });
});

// ---------------------------------------------------------------------------
// 4. apex_reflect_store
// ---------------------------------------------------------------------------

describe('ReflectStoreSchema', () => {
  it('accepts valid input', () => {
    const data = expectValid(ReflectStoreSchema, { level: 'micro', content: 'my reflection' });
    expect(data.level).toBe('micro');
    expect(data.content).toBe('my reflection');
  });

  it('accepts all level values', () => {
    for (const level of ['micro', 'meso', 'macro']) {
      expectValid(ReflectStoreSchema, { level, content: 'content' });
    }
  });

  it('accepts optional arrays', () => {
    const data = expectValid(ReflectStoreSchema, {
      level: 'meso',
      content: 'analysis',
      errorTypes: ['timeout'],
      actionableInsights: ['retry with backoff'],
      sourceEpisodes: ['ep-1', 'ep-2'],
    });
    expect(data.errorTypes).toEqual(['timeout']);
  });

  it('rejects missing level', () => {
    expectInvalid(ReflectStoreSchema, { content: 'content' });
  });

  it('rejects missing content', () => {
    expectInvalid(ReflectStoreSchema, { level: 'micro' });
  });

  it('rejects invalid level', () => {
    expectInvalid(ReflectStoreSchema, { level: 'nano', content: 'content' });
  });
});

// ---------------------------------------------------------------------------
// 5. apex_plan_context
// ---------------------------------------------------------------------------

describe('PlanContextSchema', () => {
  it('accepts valid input', () => {
    const data = expectValid(PlanContextSchema, { task: 'refactor module' });
    expect(data.task).toBe('refactor module');
  });

  it('accepts optional booleans', () => {
    const data = expectValid(PlanContextSchema, {
      task: 'test',
      includeSkills: false,
      includePitfalls: true,
    });
    expect(data.includeSkills).toBe(false);
  });

  it('rejects missing task', () => {
    expectInvalid(PlanContextSchema, {});
  });
});

// ---------------------------------------------------------------------------
// 6. apex_skills
// ---------------------------------------------------------------------------

describe('SkillsSchema', () => {
  it('accepts empty input', () => {
    const data = expectValid(SkillsSchema, {});
    expect(data.query).toBeUndefined();
  });

  it('accepts all optional fields', () => {
    const data = expectValid(SkillsSchema, { query: 'test', action: 'search', limit: 5 });
    expect(data.action).toBe('search');
  });

  it('rejects invalid action', () => {
    expectInvalid(SkillsSchema, { action: 'delete' });
  });
});

// ---------------------------------------------------------------------------
// 7. apex_skill_store
// ---------------------------------------------------------------------------

describe('SkillStoreSchema', () => {
  it('accepts valid input', () => {
    const data = expectValid(SkillStoreSchema, {
      name: 'debug-ts',
      description: 'Debug TypeScript errors',
      pattern: 'Step 1: Read error...',
    });
    expect(data.name).toBe('debug-ts');
  });

  it('accepts optional arrays', () => {
    const data = expectValid(SkillStoreSchema, {
      name: 'x',
      description: 'y',
      pattern: 'z',
      preconditions: ['must have node'],
      tags: ['debugging'],
    });
    expect(data.preconditions).toEqual(['must have node']);
  });

  it('rejects missing name', () => {
    expectInvalid(SkillStoreSchema, { description: 'y', pattern: 'z' });
  });

  it('rejects missing pattern', () => {
    expectInvalid(SkillStoreSchema, { name: 'x', description: 'y' });
  });
});

// ---------------------------------------------------------------------------
// 8-9. apex_status & apex_consolidate (no-arg tools)
// ---------------------------------------------------------------------------

describe('StatusSchema', () => {
  it('accepts empty input', () => {
    expectValid(StatusSchema, {});
  });
});

describe('ConsolidateSchema', () => {
  it('accepts empty input', () => {
    expectValid(ConsolidateSchema, {});
  });
});

// ---------------------------------------------------------------------------
// 10. apex_curriculum
// ---------------------------------------------------------------------------

describe('CurriculumSchema', () => {
  it('accepts empty input', () => {
    expectValid(CurriculumSchema, {});
  });

  it('accepts optional fields', () => {
    const data = expectValid(CurriculumSchema, { domain: 'testing', skillLevel: 0.5 });
    expect(data.domain).toBe('testing');
    expect(data.skillLevel).toBe(0.5);
  });

  it('rejects wrong type for skillLevel', () => {
    expectInvalid(CurriculumSchema, { skillLevel: 'high' });
  });
});

// ---------------------------------------------------------------------------
// 11. apex_setup
// ---------------------------------------------------------------------------

describe('SetupSchema', () => {
  it('accepts empty input', () => {
    expectValid(SetupSchema, {});
  });

  it('accepts projectPath', () => {
    const data = expectValid(SetupSchema, { projectPath: '/foo/bar' });
    expect(data.projectPath).toBe('/foo/bar');
  });
});

// ---------------------------------------------------------------------------
// 12. apex_snapshot
// ---------------------------------------------------------------------------

describe('SnapshotSchema', () => {
  it('accepts empty input', () => {
    expectValid(SnapshotSchema, {});
  });

  it('accepts optional name', () => {
    const data = expectValid(SnapshotSchema, { name: 'before-refactor' });
    expect(data.name).toBe('before-refactor');
  });
});

// ---------------------------------------------------------------------------
// 13. apex_rollback
// ---------------------------------------------------------------------------

describe('RollbackSchema', () => {
  it('accepts snapshotId', () => {
    const data = expectValid(RollbackSchema, { snapshotId: 'snap-1' });
    expect(data.snapshotId).toBe('snap-1');
  });

  it('accepts latest flag', () => {
    const data = expectValid(RollbackSchema, { latest: true });
    expect(data.latest).toBe(true);
  });

  it('accepts empty input', () => {
    expectValid(RollbackSchema, {});
  });
});

// ---------------------------------------------------------------------------
// 14. apex_promote
// ---------------------------------------------------------------------------

describe('PromoteSchema', () => {
  it('accepts valid skillId', () => {
    const data = expectValid(PromoteSchema, { skillId: 'sk-123' });
    expect(data.skillId).toBe('sk-123');
  });

  it('rejects missing skillId', () => {
    expectInvalid(PromoteSchema, {});
  });

  it('rejects empty skillId', () => {
    expectInvalid(PromoteSchema, { skillId: '' });
  });
});

// ---------------------------------------------------------------------------
// 15. apex_import
// ---------------------------------------------------------------------------

describe('ImportSchema', () => {
  it('accepts valid source', () => {
    const data = expectValid(ImportSchema, { source: '/other/project' });
    expect(data.source).toBe('/other/project');
  });

  it('rejects missing source', () => {
    expectInvalid(ImportSchema, {});
  });
});

// ---------------------------------------------------------------------------
// 16. apex_foresight_predict
// ---------------------------------------------------------------------------

describe('ForesightPredictSchema', () => {
  const valid = {
    taskId: 'task-1',
    predictedSuccess: true,
    expectedDuration: 60000,
    expectedSteps: 5,
  };

  it('accepts valid input', () => {
    const data = expectValid(ForesightPredictSchema, valid);
    expect(data.taskId).toBe('task-1');
    expect(data.predictedSuccess).toBe(true);
  });

  it('accepts optional fields', () => {
    const data = expectValid(ForesightPredictSchema, {
      ...valid,
      riskFactors: ['complexity'],
      confidence: 0.8,
    });
    expect(data.riskFactors).toEqual(['complexity']);
    expect(data.confidence).toBe(0.8);
  });

  it('rejects missing required fields', () => {
    expectInvalid(ForesightPredictSchema, { taskId: 'task-1' });
  });

  it('rejects wrong type for predictedSuccess', () => {
    expectInvalid(ForesightPredictSchema, { ...valid, predictedSuccess: 'yes' });
  });
});

// ---------------------------------------------------------------------------
// 17. apex_foresight_check
// ---------------------------------------------------------------------------

describe('ForesightCheckSchema', () => {
  const valid = {
    predictionId: 'pred-1',
    stepIndex: 0,
    stepSuccess: true,
    elapsedMs: 5000,
    completedSteps: 1,
  };

  it('accepts valid input', () => {
    const data = expectValid(ForesightCheckSchema, valid);
    expect(data.predictionId).toBe('pred-1');
  });

  it('accepts optional stepDescription', () => {
    const data = expectValid(ForesightCheckSchema, { ...valid, stepDescription: 'ran tests' });
    expect(data.stepDescription).toBe('ran tests');
  });

  it('rejects missing predictionId', () => {
    const { predictionId, ...rest } = valid;
    expectInvalid(ForesightCheckSchema, rest);
  });
});

// ---------------------------------------------------------------------------
// 18. apex_foresight_resolve
// ---------------------------------------------------------------------------

describe('ForesightResolveSchema', () => {
  const valid = {
    predictionId: 'pred-1',
    actualOutcome: { success: true, description: 'All tests passed', duration: 30000 },
  };

  it('accepts valid input', () => {
    const data = expectValid(ForesightResolveSchema, valid);
    expect(data.predictionId).toBe('pred-1');
    expect(data.actualOutcome.success).toBe(true);
  });

  it('accepts optional episodeId and errorType', () => {
    const data = expectValid(ForesightResolveSchema, {
      ...valid,
      actualOutcome: { ...valid.actualOutcome, errorType: 'timeout' },
      episodeId: 'ep-1',
    });
    expect(data.episodeId).toBe('ep-1');
    expect(data.actualOutcome.errorType).toBe('timeout');
  });

  it('rejects missing actualOutcome', () => {
    expectInvalid(ForesightResolveSchema, { predictionId: 'pred-1' });
  });

  it('rejects malformed actualOutcome', () => {
    expectInvalid(ForesightResolveSchema, {
      predictionId: 'pred-1',
      actualOutcome: { success: true }, // missing description, duration
    });
  });
});

// ---------------------------------------------------------------------------
// 19-20. Population handlers
// ---------------------------------------------------------------------------

describe('PopulationStatusSchema', () => {
  it('accepts empty input', () => {
    expectValid(PopulationStatusSchema, {});
  });
});

describe('PopulationEvolveSchema', () => {
  it('accepts empty input', () => {
    expectValid(PopulationEvolveSchema, {});
  });

  it('accepts all optional fields', () => {
    const data = expectValid(PopulationEvolveSchema, {
      taskId: 't-1',
      taskDomain: 'testing',
      taskReward: 0.9,
      taskSuccess: true,
    });
    expect(data.taskId).toBe('t-1');
  });
});

// ---------------------------------------------------------------------------
// 21. apex_tool_propose
// ---------------------------------------------------------------------------

describe('ToolProposeSchema', () => {
  it('accepts empty input', () => {
    expectValid(ToolProposeSchema, {});
  });

  it('accepts optional thresholds', () => {
    const data = expectValid(ToolProposeSchema, { minFrequency: 5, minSuccessRate: 0.9 });
    expect(data.minFrequency).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 22. apex_tool_verify
// ---------------------------------------------------------------------------

describe('ToolVerifySchema', () => {
  it('accepts valid toolId', () => {
    const data = expectValid(ToolVerifySchema, { toolId: 'tool-1' });
    expect(data.toolId).toBe('tool-1');
  });

  it('rejects missing toolId', () => {
    expectInvalid(ToolVerifySchema, {});
  });
});

// ---------------------------------------------------------------------------
// 23. apex_tool_list
// ---------------------------------------------------------------------------

describe('ToolListSchema', () => {
  it('accepts empty input', () => {
    expectValid(ToolListSchema, {});
  });

  it('accepts valid status', () => {
    for (const status of ['pending', 'verified', 'rejected', 'deprecated']) {
      expectValid(ToolListSchema, { status });
    }
  });

  it('rejects invalid status', () => {
    expectInvalid(ToolListSchema, { status: 'active' });
  });
});

// ---------------------------------------------------------------------------
// 24. apex_tool_compose
// ---------------------------------------------------------------------------

describe('ToolComposeSchema', () => {
  it('accepts empty input', () => {
    expectValid(ToolComposeSchema, {});
  });

  it('accepts toolIds array', () => {
    const data = expectValid(ToolComposeSchema, { toolIds: ['t-1', 't-2'] });
    expect(data.toolIds).toEqual(['t-1', 't-2']);
  });
});

// ---------------------------------------------------------------------------
// 25-27. Architecture handlers
// ---------------------------------------------------------------------------

describe('ArchStatusSchema', () => {
  it('accepts empty input', () => {
    expectValid(ArchStatusSchema, {});
  });
});

describe('ArchMutateSchema', () => {
  it('accepts empty input', () => {
    expectValid(ArchMutateSchema, {});
  });

  it('accepts valid mutationType', () => {
    const data = expectValid(ArchMutateSchema, { mutationType: 'toggle-subsystem', biased: true });
    expect(data.mutationType).toBe('toggle-subsystem');
    expect(data.biased).toBe(true);
  });

  it('accepts all mutation types', () => {
    const types = [
      'toggle-subsystem',
      'adjust-reflection-frequency',
      'adjust-consolidation-frequency',
      'adjust-memory-capacity',
      'adjust-exploration-rate',
      'adjust-consolidation-threshold',
      'adjust-performance-window',
    ];
    for (const mutationType of types) {
      expectValid(ArchMutateSchema, { mutationType });
    }
  });

  it('rejects invalid mutationType', () => {
    expectInvalid(ArchMutateSchema, { mutationType: 'delete-everything' });
  });
});

describe('ArchSuggestSchema', () => {
  it('accepts empty input', () => {
    expectValid(ArchSuggestSchema, {});
  });
});

// ---------------------------------------------------------------------------
// schemaMap coverage
// ---------------------------------------------------------------------------

describe('schemaMap', () => {
  it('has entries for all 31 tools', () => {
    expect(Object.keys(schemaMap)).toHaveLength(31);
  });

  const toolNames = [
    'apex_recall', 'apex_record', 'apex_reflect_get', 'apex_reflect_store',
    'apex_plan_context', 'apex_skills', 'apex_skill_store', 'apex_status',
    'apex_consolidate', 'apex_curriculum', 'apex_setup', 'apex_snapshot',
    'apex_rollback', 'apex_promote', 'apex_import', 'apex_foresight_predict',
    'apex_foresight_check', 'apex_foresight_resolve', 'apex_population_status',
    'apex_population_evolve', 'apex_tool_propose', 'apex_tool_verify',
    'apex_tool_list', 'apex_tool_compose', 'apex_arch_status',
    'apex_arch_mutate', 'apex_arch_suggest', 'apex_prompt_optimize',
    'apex_prompt_module', 'apex_goals', 'apex_cognitive_status',
  ];

  it.each(toolNames)('contains schema for %s', (name) => {
    expect(schemaMap[name]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// validateArgs helper
// ---------------------------------------------------------------------------

describe('validateArgs', () => {
  it('returns structured error with field details', () => {
    const result = validateArgs(RecallSchema, { query: 123, limit: 'bad' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.isError).toBe(true);
      const parsed = JSON.parse((result.error.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.error).toBe('Invalid input');
      expect(parsed.details.length).toBeGreaterThan(0);
    }
  });

  it('returns typed data on success', () => {
    const result = validateArgs(RecallSchema, { query: 'hello' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe('hello');
    }
  });
});

// ---------------------------------------------------------------------------
// Fuzz testing: random malformed objects
// ---------------------------------------------------------------------------

describe('fuzz: random malformed objects do not throw', () => {
  const malformedInputs: Record<string, unknown>[] = [
    { query: null },
    { query: undefined },
    { query: true },
    { query: [1, 2, 3] },
    { query: { nested: true } },
    { task: 42, actions: 'not-array', outcome: null },
    { level: 999, content: false },
    { scope: [], episodeIds: 'string-not-array' },
    { taskId: {}, predictedSuccess: 'maybe', expectedDuration: -1 },
    { predictionId: null, stepIndex: 'zero', stepSuccess: 1 },
    { toolId: [] },
    { mutationType: 42, biased: 'yes' },
    { source: 123 },
    { skillId: false },
    { status: 123 },
    { toolIds: 'not-an-array' },
    { minFrequency: 'three', minSuccessRate: 'high' },
    {},
    { unknownField: 'value' },
    { query: 'x'.repeat(100000) }, // very long string
  ];

  const allSchemas = Object.entries(schemaMap);

  it.each(allSchemas)('schema %s handles malformed inputs without throwing', (name, schema) => {
    for (const input of malformedInputs) {
      // Should never throw -- always returns a result
      const result = validateArgs(schema, input);
      expect(typeof result.success).toBe('boolean');
      if (!result.success) {
        expect(result.error.isError).toBe(true);
      }
    }
  });
});
