import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanTracker, type TrackedPlan } from './tracker.js';

// In-memory store mock
function createMockFileStore() {
  const store = new Map<string, any>();
  return {
    read: vi.fn(async (_col: string, key: string) => store.get(key) ?? null),
    write: vi.fn(async (_col: string, key: string, data: any) => { store.set(key, data); }),
    readAll: vi.fn(async (_col: string) => [...store.values()].filter(v => v.task)), // only plans
    delete: vi.fn(async (_col: string, key: string) => { store.delete(key); }),
    list: vi.fn(async () => [...store.keys()]),
    init: vi.fn(),
  };
}

describe('PlanTracker', () => {
  let tracker: PlanTracker;
  let mockStore: ReturnType<typeof createMockFileStore>;

  beforeEach(() => {
    mockStore = createMockFileStore();
    tracker = new PlanTracker({ fileStore: mockStore as any });
  });

  describe('createPlan', () => {
    it('creates a plan with steps in proposed status', async () => {
      const plan = await tracker.createPlan(
        'Refactor auth',
        'refactoring',
        ['Step 1', 'Step 2', 'Step 3'],
      );

      expect(plan.id).toBeDefined();
      expect(plan.task).toBe('Refactor auth');
      expect(plan.taskType).toBe('refactoring');
      expect(plan.status).toBe('proposed');
      expect(plan.steps).toHaveLength(3);
      expect(plan.steps.every(s => s.status === 'pending')).toBe(true);
    });

    it('persists the plan to file store', async () => {
      await tracker.createPlan('Test', 'testing', ['Step']);
      expect(mockStore.write).toHaveBeenCalled();
    });
  });

  describe('updateStep', () => {
    it('updates step status and auto-promotes plan to in_progress', async () => {
      const plan = await tracker.createPlan('Task', 'type', ['A', 'B']);
      const updated = await tracker.updateStep(plan.id, plan.steps[0].id, 'completed', 'Done');

      expect(updated.steps[0].status).toBe('completed');
      expect(updated.steps[0].outcome).toBe('Done');
      expect(updated.status).toBe('in_progress');
    });

    it('throws for unknown plan', async () => {
      await expect(
        tracker.updateStep('nonexistent', 'step-id', 'completed'),
      ).rejects.toThrow('not found');
    });

    it('throws for unknown step', async () => {
      const plan = await tracker.createPlan('Task', 'type', ['A']);
      await expect(
        tracker.updateStep(plan.id, 'bad-step-id', 'completed'),
      ).rejects.toThrow('not found');
    });
  });

  describe('completePlan', () => {
    it('marks plan as completed with outcome', async () => {
      const plan = await tracker.createPlan('Task', 'type', ['A']);
      const completed = await tracker.completePlan(plan.id, {
        success: true,
        description: 'All done',
      });

      expect(completed.status).toBe('completed');
      expect(completed.outcome).toEqual({ success: true, description: 'All done' });
      expect(completed.completedAt).toBeDefined();
    });

    it('marks plan as failed when success is false', async () => {
      const plan = await tracker.createPlan('Task', 'type', ['A']);
      const failed = await tracker.completePlan(plan.id, {
        success: false,
        description: 'Error',
      });

      expect(failed.status).toBe('failed');
    });
  });

  describe('getSuccessRates', () => {
    it('computes per-task-type success rates', async () => {
      const p1 = await tracker.createPlan('Task A', 'testing', ['Step']);
      await tracker.completePlan(p1.id, { success: true, description: 'ok' });

      const p2 = await tracker.createPlan('Task B', 'testing', ['Step']);
      await tracker.completePlan(p2.id, { success: false, description: 'fail' });

      const rates = await tracker.getSuccessRates();
      const testingRate = rates.find(r => r.taskType === 'testing');
      expect(testingRate).toBeDefined();
      expect(testingRate!.totalPlans).toBe(2);
      expect(testingRate!.successfulPlans).toBe(1);
      expect(testingRate!.successRate).toBeCloseTo(0.5);
    });
  });

  describe('linkToEpisode / linkToActionTree', () => {
    it('links episode IDs to a plan', async () => {
      const plan = await tracker.createPlan('Task', 'type', ['Step']);
      const updated = await tracker.linkToEpisode(plan.id, 'ep-123');
      expect(updated.linkedEpisodeIds).toContain('ep-123');
    });

    it('links action tree node IDs', async () => {
      const plan = await tracker.createPlan('Task', 'type', ['Step']);
      const updated = await tracker.linkToActionTree(plan.id, 'node-456');
      expect(updated.actionTreeNodeIds).toContain('node-456');
    });

    it('does not duplicate links', async () => {
      const plan = await tracker.createPlan('Task', 'type', ['Step']);
      await tracker.linkToEpisode(plan.id, 'ep-123');
      const updated = await tracker.linkToEpisode(plan.id, 'ep-123');
      expect(updated.linkedEpisodeIds.filter(id => id === 'ep-123')).toHaveLength(1);
    });
  });
});
