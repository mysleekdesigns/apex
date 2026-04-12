import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { FileStore } from '../utils/file-store.js';
import type { Skill } from '../types.js';
import {
  ProductionRuleEngine,
  type RuleCondition,
  type RuleAction,
} from './production-rules.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: randomUUID(),
    name: 'test-skill',
    description: 'debugging authentication errors in middleware',
    preconditions: ['project uses express', 'has auth middleware'],
    pattern:
      '1. Check session token\n2. Verify middleware chain\n3. Run apex_recall for similar issues',
    successRate: 0.9,
    usageCount: 15,
    confidence: 0.85,
    sourceProject: 'test-project',
    sourceFiles: ['src/auth.ts'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags: ['debugging', 'authentication'],
    ...overrides,
  };
}

function makeCondition(overrides: Partial<RuleCondition> = {}): RuleCondition {
  return {
    patterns: ['debugging', 'authentication', 'middleware'],
    taskTypes: ['debugging'],
    requiredTags: [],
    contextPatterns: [],
    ...overrides,
  };
}

function makeAction(overrides: Partial<RuleAction> = {}): RuleAction {
  return {
    description: 'Fix auth middleware issues',
    steps: ['Check session token', 'Verify middleware chain'],
    toolSuggestions: ['apex_recall'],
    avoidPatterns: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProductionRuleEngine', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let engine: ProductionRuleEngine;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apex-test-'));
    fileStore = new FileStore(tmpDir);
    await fileStore.init();
    engine = new ProductionRuleEngine({ fileStore });
    await engine.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Extract rules from high-confidence skills
  it('should extract rules from high-confidence skills', () => {
    const skill = makeSkill({ confidence: 0.9, usageCount: 20, successRate: 0.85 });
    const rules = engine.extractFromSkills([skill]);

    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule.name).toBe('test-skill');
    expect(rule.sourceSkillId).toBe(skill.id);
    expect(rule.confidence).toBe(0.85); // from successRate
    expect(rule.priority).toBe(90); // Math.round(0.9 * 100)
    expect(rule.enabled).toBe(true);
    expect(rule.condition.patterns.length).toBeGreaterThan(0);
    expect(rule.action.steps.length).toBeGreaterThan(0);
    expect(rule.action.toolSuggestions).toContain('apex_recall');
  });

  // 2. Skip low-confidence or low-usage skills
  it('should skip low-confidence or low-usage skills', () => {
    const lowConf = makeSkill({ confidence: 0.5, usageCount: 20 });
    const lowUsage = makeSkill({ confidence: 0.9, usageCount: 3 });
    const bothLow = makeSkill({ confidence: 0.3, usageCount: 2 });

    const rules = engine.extractFromSkills([lowConf, lowUsage, bothLow]);
    expect(rules).toHaveLength(0);
  });

  // 3. Add rule manually and verify fields
  it('should add a rule manually and populate fields correctly', async () => {
    const rule = await engine.addRule({
      name: 'manual-rule',
      condition: makeCondition(),
      action: makeAction(),
      confidence: 0.75,
      priority: 80,
    });

    expect(rule.id).toBeTruthy();
    expect(rule.name).toBe('manual-rule');
    expect(rule.confidence).toBe(0.75);
    expect(rule.priority).toBe(80);
    expect(rule.hitCount).toBe(0);
    expect(rule.fireCount).toBe(0);
    expect(rule.successCount).toBe(0);
    expect(rule.accuracy).toBe(0);
    expect(rule.enabled).toBe(true);
    expect(rule.sourceSkillId).toBeNull();

    // Should be retrievable
    const found = engine.getRule(rule.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('manual-rule');
  });

  // 4. Match returns correct rules for matching task description
  it('should match rules against a task description', async () => {
    await engine.addRule({
      name: 'auth-rule',
      condition: makeCondition({ patterns: ['authentication', 'middleware', 'error'] }),
      action: makeAction(),
      confidence: 0.9,
    });

    await engine.addRule({
      name: 'unrelated-rule',
      condition: makeCondition({ patterns: ['database', 'migration', 'schema'] }),
      action: makeAction({ description: 'Handle DB migrations' }),
      confidence: 0.8,
    });

    const matches = engine.match({
      taskDescription: 'fix authentication error in middleware',
    });

    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].rule.name).toBe('auth-rule');
    expect(matches[0].matchScore).toBeGreaterThan(0);
    expect(matches[0].matchedPatterns.length).toBeGreaterThan(0);
  });

  // 5. Match respects task type and tags
  it('should boost matches when taskType and tags match', async () => {
    await engine.addRule({
      name: 'debug-rule',
      condition: makeCondition({
        patterns: ['error', 'fix', 'authentication', 'middleware', 'session'],
        taskTypes: ['debugging'],
        requiredTags: ['critical'],
      }),
      action: makeAction(),
      confidence: 0.8,
      priority: 50,
    });

    // Only matches 2/5 patterns = 0.4 base score, so taskType boost to 0.6 is visible
    const withType = engine.match({
      taskDescription: 'fix the error',
      taskType: 'debugging',
      tags: ['critical'],
    });

    const withoutType = engine.match({
      taskDescription: 'fix the error',
    });

    // Both should match, but with type+tags the score should be higher
    expect(withType.length).toBeGreaterThanOrEqual(1);
    expect(withoutType.length).toBeGreaterThanOrEqual(1);
    expect(withType[0].matchScore).toBeGreaterThan(withoutType[0].matchScore);
  });

  // 6. Match scoring: higher priority and confidence rank higher
  it('should rank higher priority and confidence rules first', async () => {
    await engine.addRule({
      name: 'low-priority',
      condition: makeCondition({ patterns: ['error', 'fix'] }),
      action: makeAction(),
      confidence: 0.5,
      priority: 30,
    });

    await engine.addRule({
      name: 'high-priority',
      condition: makeCondition({ patterns: ['error', 'fix'] }),
      action: makeAction(),
      confidence: 0.95,
      priority: 90,
    });

    const matches = engine.match({ taskDescription: 'fix the error' });
    expect(matches.length).toBe(2);
    expect(matches[0].rule.name).toBe('high-priority');
    expect(matches[1].rule.name).toBe('low-priority');
  });

  // 7. Record fire and outcome updates accuracy
  it('should update accuracy after recording fire and outcome', async () => {
    const rule = await engine.addRule({
      name: 'tracked-rule',
      condition: makeCondition(),
      action: makeAction(),
    });

    await engine.recordFire(rule.id);
    await engine.recordOutcome(rule.id, true);

    const updated = engine.getRule(rule.id)!;
    expect(updated.fireCount).toBe(1);
    expect(updated.successCount).toBe(1);
    expect(updated.accuracy).toBe(1);

    await engine.recordFire(rule.id);
    await engine.recordOutcome(rule.id, false);

    const updated2 = engine.getRule(rule.id)!;
    expect(updated2.fireCount).toBe(2);
    expect(updated2.successCount).toBe(1);
    expect(updated2.accuracy).toBe(0.5);
  });

  // 8. Auto-prune disables low-accuracy rules
  it('should auto-prune rules with low accuracy after sufficient fires', async () => {
    const rule = await engine.addRule({
      name: 'bad-rule',
      condition: makeCondition(),
      action: makeAction(),
    });

    // Simulate 10 fires, 2 successes (accuracy = 0.2)
    for (let i = 0; i < 10; i++) {
      await engine.recordFire(rule.id);
    }
    await engine.recordOutcome(rule.id, true);
    await engine.recordOutcome(rule.id, true);

    const pruned = await engine.autoPrune();
    expect(pruned).toContain(rule.id);

    const prunedRule = engine.getRule(rule.id)!;
    expect(prunedRule.enabled).toBe(false);
  });

  // 9. getMatchContext returns formatted context
  it('should return formatted match context string', async () => {
    await engine.addRule({
      name: 'context-rule',
      condition: makeCondition({ patterns: ['testing', 'api'] }),
      action: makeAction({
        steps: ['Write integration tests', 'Mock external services'],
      }),
      confidence: 0.92,
    });

    const context = engine.getMatchContext('testing api endpoints');
    expect(context).toContain('Applicable rules:');
    expect(context).toContain('confidence: 0.92');
    expect(context).toContain('Write integration tests');
  });

  // 10. Inverted index updated when rules added
  it('should update inverted index when rules are added or disabled', async () => {
    const rule = await engine.addRule({
      name: 'indexed-rule',
      condition: makeCondition({ patterns: ['unique-keyword-xyz'] }),
      action: makeAction(),
    });

    // Should match via the index
    const matches1 = engine.match({
      taskDescription: 'something about unique-keyword-xyz',
    });
    expect(matches1.length).toBe(1);

    // Disable the rule
    await engine.disableRule(rule.id);

    // Should no longer match
    const matches2 = engine.match({
      taskDescription: 'something about unique-keyword-xyz',
    });
    expect(matches2.length).toBe(0);

    // Re-enable
    await engine.enableRule(rule.id);
    const matches3 = engine.match({
      taskDescription: 'something about unique-keyword-xyz',
    });
    expect(matches3.length).toBe(1);
  });

  // 11. Persist and reload preserves state
  it('should persist rules and reload them on init', async () => {
    const skill = makeSkill({ confidence: 0.9, usageCount: 20 });
    const extracted = engine.extractFromSkills([skill]);
    expect(extracted).toHaveLength(1);

    await engine.persist();

    // Create a fresh engine with the same store
    const engine2 = new ProductionRuleEngine({ fileStore });
    await engine2.init();

    const reloaded = engine2.getRule(extracted[0].id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.name).toBe('test-skill');
    expect(reloaded!.sourceSkillId).toBe(skill.id);
    expect(reloaded!.confidence).toBe(skill.successRate);
  });

  // 12. listRules with filters
  it('should list rules with filters', async () => {
    await engine.addRule({
      name: 'enabled-rule',
      condition: makeCondition(),
      action: makeAction(),
    });

    const disabledRule = await engine.addRule({
      name: 'disabled-rule',
      condition: makeCondition(),
      action: makeAction(),
    });
    await engine.disableRule(disabledRule.id);

    const allRules = engine.listRules();
    expect(allRules).toHaveLength(2);

    const enabledOnly = engine.listRules({ enabled: true });
    expect(enabledOnly).toHaveLength(1);
    expect(enabledOnly[0].name).toBe('enabled-rule');

    const disabledOnly = engine.listRules({ enabled: false });
    expect(disabledOnly).toHaveLength(1);
    expect(disabledOnly[0].name).toBe('disabled-rule');
  });

  // 13. getStats returns correct statistics
  it('should return correct stats', async () => {
    const rule = await engine.addRule({
      name: 'stats-rule',
      condition: makeCondition({ patterns: ['stats', 'test'] }),
      action: makeAction(),
    });

    await engine.recordFire(rule.id);
    await engine.recordOutcome(rule.id, true);

    engine.match({ taskDescription: 'stats test query' });

    const stats = engine.getStats();
    expect(stats.totalRules).toBe(1);
    expect(stats.enabledRules).toBe(1);
    expect(stats.totalFires).toBe(1);
    expect(stats.topRules).toHaveLength(1);
    expect(stats.topRules[0].name).toBe('stats-rule');
  });

  // 14. getMatchContext returns empty for no matches
  it('should return empty string when no rules match', () => {
    const context = engine.getMatchContext('completely unrelated query');
    expect(context).toBe('');
  });
});
