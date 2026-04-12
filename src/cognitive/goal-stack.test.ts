import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../utils/file-store.js';
import { GoalStack } from './goal-stack.js';

describe('GoalStack', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let stack: GoalStack;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apex-goal-test-'));
    fileStore = new FileStore(tmpDir);
    await fileStore.init();
    stack = new GoalStack({ fileStore });
    await stack.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should add a top-level goal and verify fields', async () => {
    const goal = await stack.addGoal({
      description: 'Ship v2.0',
      priority: 'high',
      deadline: '2026-05-01T00:00:00Z',
      context: 'Major release',
      tags: ['release'],
    });

    expect(goal.id).toBeTruthy();
    expect(goal.description).toBe('Ship v2.0');
    expect(goal.status).toBe('active');
    expect(goal.priority).toBe('high');
    expect(goal.parentId).toBeNull();
    expect(goal.subGoalIds).toEqual([]);
    expect(goal.progress).toBe(0);
    expect(goal.context).toBe('Major release');
    expect(goal.tags).toEqual(['release']);
    expect(goal.createdAt).toBeTruthy();
    expect(goal.completedAt).toBeNull();

    // Also retrievable
    const fetched = stack.getGoal(goal.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.description).toBe('Ship v2.0');
  });

  it('should add a sub-goal linked to parent', async () => {
    const parent = await stack.addGoal({ description: 'Parent goal' });
    const child = await stack.addGoal({ description: 'Child goal', parentId: parent.id });

    expect(child.parentId).toBe(parent.id);

    const updatedParent = stack.getGoal(parent.id)!;
    expect(updatedParent.subGoalIds).toContain(child.id);

    const subs = stack.getSubGoals(parent.id);
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe(child.id);
  });

  it('should update parent progress when sub-goal completes', async () => {
    const parent = await stack.addGoal({ description: 'Parent' });
    const c1 = await stack.addGoal({ description: 'Child 1', parentId: parent.id });
    await stack.addGoal({ description: 'Child 2', parentId: parent.id });

    await stack.completeGoal(c1.id);

    const updated = stack.getGoal(parent.id)!;
    expect(updated.progress).toBeCloseTo(0.5);
  });

  it('should set parent progress to 1.0 when all sub-goals complete', async () => {
    const parent = await stack.addGoal({ description: 'Parent' });
    const c1 = await stack.addGoal({ description: 'Child 1', parentId: parent.id });
    const c2 = await stack.addGoal({ description: 'Child 2', parentId: parent.id });

    await stack.completeGoal(c1.id);
    await stack.completeGoal(c2.id);

    const updated = stack.getGoal(parent.id)!;
    expect(updated.progress).toBe(1);
  });

  it('should return active goals sorted by priority then deadline', async () => {
    await stack.addGoal({ description: 'Low', priority: 'low' });
    await stack.addGoal({ description: 'Critical late', priority: 'critical', deadline: '2026-12-01T00:00:00Z' });
    await stack.addGoal({ description: 'Critical early', priority: 'critical', deadline: '2026-06-01T00:00:00Z' });
    await stack.addGoal({ description: 'High', priority: 'high' });

    const active = stack.getActiveGoals();
    expect(active.map((g) => g.description)).toEqual([
      'Critical early',
      'Critical late',
      'High',
      'Low',
    ]);
  });

  it('should abandon goal with cascade to sub-goals', async () => {
    const parent = await stack.addGoal({ description: 'Parent' });
    const child = await stack.addGoal({ description: 'Child', parentId: parent.id });
    const grandchild = await stack.addGoal({ description: 'Grandchild', parentId: child.id });

    await stack.abandonGoal(parent.id, true);

    expect(stack.getGoal(parent.id)!.status).toBe('abandoned');
    expect(stack.getGoal(child.id)!.status).toBe('abandoned');
    expect(stack.getGoal(grandchild.id)!.status).toBe('abandoned');
  });

  it('should block goal and update status', async () => {
    const goal = await stack.addGoal({ description: 'Blocked goal' });
    await stack.blockGoal(goal.id, 'Waiting on dependency');

    const updated = stack.getGoal(goal.id)!;
    expect(updated.status).toBe('blocked');
    expect(updated.context).toContain('Blocked: Waiting on dependency');
  });

  it('should search goals by keyword', async () => {
    await stack.addGoal({ description: 'Implement authentication', tags: ['security'] });
    await stack.addGoal({ description: 'Add logging middleware' });
    await stack.addGoal({ description: 'Fix auth token refresh', context: 'security related' });

    const results = stack.searchGoals('auth security');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // First result should match both keywords
    expect(results[0].description).toContain('auth');
  });

  it('should return urgent goals within deadline window', async () => {
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours
    const far = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(); // 72 hours

    await stack.addGoal({ description: 'Urgent soon', priority: 'medium', deadline: soon });
    await stack.addGoal({ description: 'Not urgent', priority: 'medium', deadline: far });
    await stack.addGoal({ description: 'Critical always', priority: 'critical' });

    const urgent = stack.getUrgentGoals(24);
    const descs = urgent.map((g) => g.description);
    expect(descs).toContain('Urgent soon');
    expect(descs).toContain('Critical always');
    expect(descs).not.toContain('Not urgent');
  });

  it('should format a readable context string', async () => {
    const parent = await stack.addGoal({
      description: 'Complete auth refactor',
      priority: 'critical',
      deadline: '2026-04-15T00:00:00Z',
    });
    const sub1 = await stack.addGoal({ description: 'Update session middleware', priority: 'high', parentId: parent.id });
    await stack.addGoal({ description: 'Migrate user tokens', priority: 'high', parentId: parent.id });
    await stack.completeGoal(sub1.id);

    const ctx = stack.getContextString();
    expect(ctx).toContain('Active goals (1):');
    expect(ctx).toContain('[CRITICAL]');
    expect(ctx).toContain('Complete auth refactor');
    expect(ctx).toContain('deadline: 2026-04-15');
    expect(ctx).toContain('[HIGH]');
    expect(ctx).toContain('completed');
  });

  it('should persist and reload state', async () => {
    await stack.addGoal({ description: 'Persistent goal', priority: 'high', tags: ['persist'] });
    await stack.persist();

    // Create a new stack from the same fileStore
    const stack2 = new GoalStack({ fileStore });
    await stack2.init();

    const goals = stack2.getActiveGoals();
    expect(goals).toHaveLength(1);
    expect(goals[0].description).toBe('Persistent goal');
    expect(goals[0].tags).toEqual(['persist']);
  });
});
