import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateId } from '../types.js';
import { TreePersistenceManager } from './tree-persistence.js';
import type { ActionTree, ActionTreeNode } from './action-tree.js';
import type { SavedSubtree, TreeGrowthMetrics } from './tree-persistence.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<ActionTreeNode>): ActionTreeNode {
  return {
    id: generateId(),
    parentId: null,
    stateDescription: 'test state',
    action: 'test action',
    totalValue: 0,
    visitCount: 0,
    avgValue: 0,
    children: [],
    depth: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMockTree(nodes: ActionTreeNode[]): ActionTree {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return {
    getTree: () => ({ rootId: nodes[0]?.id ?? null, nodes }),
    getNode: (id: string) => nodeMap.get(id) ?? null,
    getRoot: () => nodes[0] ?? null,
    getChildren: (id: string) => {
      const parent = nodeMap.get(id);
      if (!parent) return [];
      return parent.children
        .map((cid) => {
          const child = nodeMap.get(cid);
          return child ? { node: child, ucb1: child.avgValue } : null;
        })
        .filter(Boolean);
    },
    getBestPath: () => nodes,
    size: nodes.length,
    prune: vi.fn().mockReturnValue(0),
    addNode: vi.fn().mockImplementation(
      (_parentId: string | null, stateDescription: string, action: string, metadata?: Record<string, unknown>) => {
        const newNode = makeNode({
          parentId: _parentId,
          stateDescription,
          action,
          metadata,
          depth: _parentId ? (nodeMap.get(_parentId)?.depth ?? 0) + 1 : 0,
        });
        nodeMap.set(newNode.id, newNode);
        return newNode;
      },
    ),
    recordOutcome: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as ActionTree;
}

function createMockFileStore() {
  const storage = new Map<string, unknown>();
  return {
    read: vi.fn().mockImplementation(
      (_collection: string, id: string) => {
        const key = `${_collection}:${id}`;
        return Promise.resolve(storage.get(key) ?? null);
      },
    ),
    write: vi.fn().mockImplementation(
      (_collection: string, id: string, data: unknown) => {
        const key = `${_collection}:${id}`;
        storage.set(key, JSON.parse(JSON.stringify(data)));
        return Promise.resolve();
      },
    ),
    delete: vi.fn().mockImplementation(
      (_collection: string, id: string) => {
        const key = `${_collection}:${id}`;
        storage.delete(key);
        return Promise.resolve();
      },
    ),
    list: vi.fn().mockResolvedValue([]),
    readAll: vi.fn().mockResolvedValue([]),
    init: vi.fn().mockResolvedValue(undefined),
    _storage: storage,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TreePersistenceManager', () => {
  let fileStore: ReturnType<typeof createMockFileStore>;
  let manager: TreePersistenceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    fileStore = createMockFileStore();
    manager = new TreePersistenceManager({
      fileStore: fileStore as any,
      saveThreshold: 0.3,
      minVisitsToSave: 5,
      maxSavedSubtrees: 20,
      compactionSimilarity: 0.8,
      pruneValueThreshold: 0.2,
      pruneMinVisits: 5,
    });
  });

  // -----------------------------------------------------------------------
  // savePromisingSubtrees
  // -----------------------------------------------------------------------

  describe('savePromisingSubtrees', () => {
    it('identifies high-value subtrees and saves them', async () => {
      const root = makeNode({ id: 'root', action: 'start', avgValue: 0.5, visitCount: 10 });
      const child = makeNode({
        id: 'child1',
        parentId: 'root',
        action: 'good path',
        avgValue: 0.6,
        visitCount: 8,
        depth: 1,
      });
      root.children = ['child1'];
      const tree = createMockTree([root, child]);

      const count = await manager.savePromisingSubtrees(tree, 'refactoring');

      // The root qualifies (avgValue 0.5 >= 0.3, visitCount 10 >= 5).
      // Child is under root so it should be skipped (no overlapping subtrees).
      expect(count).toBe(1);
      expect(fileStore.write).toHaveBeenCalled();
    });

    it('skips low-value subtrees', async () => {
      const root = makeNode({ id: 'root', action: 'start', avgValue: 0.1, visitCount: 10 });
      const child = makeNode({
        id: 'child1',
        parentId: 'root',
        action: 'bad path',
        avgValue: 0.1,
        visitCount: 3,
        depth: 1,
      });
      root.children = ['child1'];
      const tree = createMockTree([root, child]);

      const count = await manager.savePromisingSubtrees(tree, 'testing');

      expect(count).toBe(0);
    });

    it('does not save overlapping subtrees', async () => {
      const root = makeNode({ id: 'root', action: 'start', avgValue: 0.5, visitCount: 10 });
      const child = makeNode({
        id: 'child1',
        parentId: 'root',
        action: 'also good',
        avgValue: 0.7,
        visitCount: 8,
        depth: 1,
      });
      root.children = ['child1'];
      const tree = createMockTree([root, child]);

      const count = await manager.savePromisingSubtrees(tree, 'refactoring');

      // Root qualifies, so child (descendant of root) should be skipped.
      expect(count).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // restoreSubtrees
  // -----------------------------------------------------------------------

  describe('restoreSubtrees', () => {
    it('loads and returns count for matching task type', async () => {
      // Manually write a saved subtree and index into the mock file store.
      const savedNode = makeNode({
        id: 'saved-node-1',
        action: 'saved action',
        avgValue: 0.8,
        visitCount: 10,
        depth: 0,
      });

      const subtree: SavedSubtree = {
        id: 'st-1',
        taskType: 'testing',
        rootNodeId: 'saved-node-1',
        nodes: { 'saved-node-1': savedNode },
        avgValue: 0.8,
        totalVisits: 10,
        savedAt: Date.now() - 10000,
        restoreCount: 0,
      };

      const index = {
        byTaskType: { testing: ['st-1'] },
        allIds: ['st-1'],
        updatedAt: Date.now(),
      };

      fileStore._storage.set('tree-persistence:subtree-index', index);
      fileStore._storage.set('tree-persistence:subtree-st-1', subtree);

      const root = makeNode({ id: 'tree-root', action: 'root', depth: 0 });
      const tree = createMockTree([root]);

      const count = await manager.restoreSubtrees(tree, 'testing');

      expect(count).toBe(1);
      // addNode should have been called to add the saved node.
      expect(tree.addNode).toHaveBeenCalled();
    });

    it('returns 0 when no subtrees exist for the task type', async () => {
      const root = makeNode({ id: 'tree-root', action: 'root', depth: 0 });
      const tree = createMockTree([root]);

      const count = await manager.restoreSubtrees(tree, 'nonexistent');

      expect(count).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // listSavedSubtrees
  // -----------------------------------------------------------------------

  describe('listSavedSubtrees', () => {
    it('filters by task type', async () => {
      const stA: SavedSubtree = {
        id: 'a',
        taskType: 'refactoring',
        rootNodeId: 'r1',
        nodes: {},
        avgValue: 0.5,
        totalVisits: 10,
        savedAt: Date.now(),
        restoreCount: 0,
      };
      const stB: SavedSubtree = {
        id: 'b',
        taskType: 'testing',
        rootNodeId: 'r2',
        nodes: {},
        avgValue: 0.6,
        totalVisits: 12,
        savedAt: Date.now(),
        restoreCount: 0,
      };

      const index = {
        byTaskType: { refactoring: ['a'], testing: ['b'] },
        allIds: ['a', 'b'],
        updatedAt: Date.now(),
      };

      fileStore._storage.set('tree-persistence:subtree-index', index);
      fileStore._storage.set('tree-persistence:subtree-a', stA);
      fileStore._storage.set('tree-persistence:subtree-b', stB);

      const refactoring = await manager.listSavedSubtrees('refactoring');
      expect(refactoring).toHaveLength(1);
      expect(refactoring[0].taskType).toBe('refactoring');

      const all = await manager.listSavedSubtrees();
      expect(all).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // pruneConfidentlyBad
  // -----------------------------------------------------------------------

  describe('pruneConfidentlyBad', () => {
    it('identifies nodes with low value and high visits', () => {
      const root = makeNode({ id: 'root', action: 'start', avgValue: 0.5, visitCount: 10 });
      const bad = makeNode({
        id: 'bad',
        parentId: 'root',
        action: 'bad path',
        avgValue: 0.05,
        visitCount: 8,
        depth: 1,
      });
      const good = makeNode({
        id: 'good',
        parentId: 'root',
        action: 'good path',
        avgValue: 0.7,
        visitCount: 8,
        depth: 1,
      });
      root.children = ['bad', 'good'];
      const tree = createMockTree([root, bad, good]);

      const count = manager.pruneConfidentlyBad(tree);

      // Only the bad node should be flagged (avgValue 0.05 < 0.2, visitCount 8 > 5).
      expect(count).toBe(1);
    });

    it('spares nodes with insufficient visits', () => {
      const root = makeNode({ id: 'root', action: 'start', avgValue: 0.5, visitCount: 10 });
      const lowVisits = makeNode({
        id: 'low',
        parentId: 'root',
        action: 'uncertain',
        avgValue: 0.05,
        visitCount: 3, // Below pruneMinVisits of 5
        depth: 1,
      });
      root.children = ['low'];
      const tree = createMockTree([root, lowVisits]);

      const count = manager.pruneConfidentlyBad(tree);

      expect(count).toBe(0);
    });

    it('spares nodes above the value threshold', () => {
      const root = makeNode({ id: 'root', action: 'start', avgValue: 0.5, visitCount: 10 });
      const decent = makeNode({
        id: 'decent',
        parentId: 'root',
        action: 'decent path',
        avgValue: 0.25, // Above pruneValueThreshold of 0.2
        visitCount: 8,
        depth: 1,
      });
      root.children = ['decent'];
      const tree = createMockTree([root, decent]);

      const count = manager.pruneConfidentlyBad(tree);

      expect(count).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // compactTree
  // -----------------------------------------------------------------------

  describe('compactTree', () => {
    it('merges sibling nodes with similar actions', () => {
      const root = makeNode({ id: 'root', action: 'start', avgValue: 0.5, visitCount: 10 });
      const childA = makeNode({
        id: 'a',
        parentId: 'root',
        action: 'refactor extract method',
        avgValue: 0.6,
        visitCount: 5,
        depth: 1,
      });
      const childB = makeNode({
        id: 'b',
        parentId: 'root',
        action: 'refactor extract method',
        avgValue: 0.4,
        visitCount: 3,
        depth: 1,
      });
      root.children = ['a', 'b'];
      const tree = createMockTree([root, childA, childB]);

      const result = manager.compactTree(tree);

      // Identical actions => Jaccard similarity = 1.0 >= 0.8
      expect(result.mergedGroups).toBe(1);
      expect(result.nodesRemoved).toBe(1);
      expect(result.nodesRemaining).toBe(2); // root + survivor
      // recordOutcome should be called on the kept node with the absorbed avg.
      expect(tree.recordOutcome).toHaveBeenCalled();
    });

    it('preserves dissimilar siblings', () => {
      const root = makeNode({ id: 'root', action: 'start', avgValue: 0.5, visitCount: 10 });
      const childA = makeNode({
        id: 'a',
        parentId: 'root',
        action: 'refactor extract method carefully',
        avgValue: 0.6,
        visitCount: 5,
        depth: 1,
      });
      const childB = makeNode({
        id: 'b',
        parentId: 'root',
        action: 'deploy kubernetes production cluster',
        avgValue: 0.4,
        visitCount: 3,
        depth: 1,
      });
      root.children = ['a', 'b'];
      const tree = createMockTree([root, childA, childB]);

      const result = manager.compactTree(tree);

      // Completely different actions => low Jaccard similarity.
      expect(result.mergedGroups).toBe(0);
      expect(result.nodesRemoved).toBe(0);
      expect(result.nodesRemaining).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // recordMetricsSnapshot / getMetrics
  // -----------------------------------------------------------------------

  describe('growth metrics', () => {
    it('records snapshot with correct values', async () => {
      const root = makeNode({ id: 'root', action: 'start', avgValue: 0.5, visitCount: 10 });
      const childA = makeNode({
        id: 'a',
        parentId: 'root',
        action: 'action-a',
        avgValue: 0.7,
        visitCount: 5,
        depth: 1,
      });
      const childB = makeNode({
        id: 'b',
        parentId: 'root',
        action: 'action-b',
        avgValue: 0.3,
        visitCount: 3,
        depth: 1,
      });
      root.children = ['a', 'b'];
      const tree = createMockTree([root, childA, childB]);

      await manager.recordMetricsSnapshot(tree, 2, 1);

      const metrics = await manager.getMetrics();
      expect(metrics.snapshots).toHaveLength(1);

      const snap = metrics.snapshots[0];
      expect(snap.totalNodes).toBe(3);
      expect(snap.maxDepth).toBe(1);
      expect(snap.avgBreadth).toBe(2); // root has 2 children, only internal node
      expect(snap.avgValue).toBeCloseTo((0.5 + 0.7 + 0.3) / 3);
      expect(snap.pruneCount).toBe(2);
      expect(snap.compactCount).toBe(1);
    });

    it('returns empty metrics when none recorded', async () => {
      const metrics = await manager.getMetrics();
      expect(metrics.snapshots).toHaveLength(0);
      expect(metrics.updatedAt).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // evictOldSubtrees
  // -----------------------------------------------------------------------

  describe('evictOldSubtrees', () => {
    it('removes oldest subtrees when exceeding max', async () => {
      const smallManager = new TreePersistenceManager({
        fileStore: fileStore as any,
        maxSavedSubtrees: 2,
      });

      // Create 4 subtrees with different savedAt times.
      const subtrees: SavedSubtree[] = [];
      const ids: string[] = [];

      for (let i = 0; i < 4; i++) {
        const st: SavedSubtree = {
          id: `st-${i}`,
          taskType: 'testing',
          rootNodeId: `r${i}`,
          nodes: {},
          avgValue: 0.5,
          totalVisits: 10,
          savedAt: Date.now() - (4 - i) * 10000, // oldest first
          restoreCount: 0,
        };
        subtrees.push(st);
        ids.push(st.id);
        fileStore._storage.set(`tree-persistence:subtree-st-${i}`, st);
      }

      const index = {
        byTaskType: { testing: ids },
        allIds: ids,
        updatedAt: Date.now(),
      };
      fileStore._storage.set('tree-persistence:subtree-index', index);

      const evicted = await smallManager.evictOldSubtrees();

      // Should evict 2 oldest (4 - maxSavedSubtrees of 2 = 2).
      expect(evicted).toBe(2);

      // Verify the oldest two were deleted.
      expect(fileStore._storage.has('tree-persistence:subtree-st-0')).toBe(false);
      expect(fileStore._storage.has('tree-persistence:subtree-st-1')).toBe(false);
      // The newest two remain.
      expect(fileStore._storage.has('tree-persistence:subtree-st-2')).toBe(true);
      expect(fileStore._storage.has('tree-persistence:subtree-st-3')).toBe(true);
    });

    it('does nothing when under the limit', async () => {
      const evicted = await manager.evictOldSubtrees();
      expect(evicted).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Persistence round-trip
  // -----------------------------------------------------------------------

  describe('persistence', () => {
    it('save and load round-trip', async () => {
      const root = makeNode({ id: 'root', action: 'start', avgValue: 0.5, visitCount: 10 });
      const child = makeNode({
        id: 'child1',
        parentId: 'root',
        action: 'good path',
        avgValue: 0.6,
        visitCount: 8,
        depth: 1,
      });
      root.children = ['child1'];
      const tree = createMockTree([root, child]);

      // Save subtrees.
      const saved = await manager.savePromisingSubtrees(tree, 'refactoring');
      expect(saved).toBeGreaterThan(0);

      // Create a fresh manager with the same file store.
      const manager2 = new TreePersistenceManager({
        fileStore: fileStore as any,
        saveThreshold: 0.3,
        minVisitsToSave: 5,
      });

      // List should return the saved subtrees.
      const listed = await manager2.listSavedSubtrees('refactoring');
      expect(listed).toHaveLength(saved);
      expect(listed[0].taskType).toBe('refactoring');
      expect(listed[0].avgValue).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // clear
  // -----------------------------------------------------------------------

  describe('clear', () => {
    it('removes all persistence data', async () => {
      // Save something first.
      const root = makeNode({ id: 'root', action: 'start', avgValue: 0.5, visitCount: 10 });
      const tree = createMockTree([root]);
      await manager.savePromisingSubtrees(tree, 'testing');
      await manager.recordMetricsSnapshot(tree);

      await manager.clear();

      const subtrees = await manager.listSavedSubtrees();
      expect(subtrees).toHaveLength(0);

      const metrics = await manager.getMetrics();
      expect(metrics.snapshots).toHaveLength(0);
    });
  });
});
