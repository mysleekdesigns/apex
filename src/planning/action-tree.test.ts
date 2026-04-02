import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionTree, type ActionTreeNode } from './action-tree.js';

// Mock FileStore
const mockFileStore = {
  read: vi.fn().mockResolvedValue(null),
  write: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  readAll: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([]),
  init: vi.fn().mockResolvedValue(undefined),
};

describe('ActionTree', () => {
  let tree: ActionTree;

  beforeEach(async () => {
    vi.clearAllMocks();
    tree = new ActionTree({
      fileStore: mockFileStore as any,
      pruneThreshold: 0.1,
      maxDepth: 5,
      explorationConstant: Math.SQRT2,
    });
  });

  describe('addNode', () => {
    it('creates a root node when parentId is null', () => {
      const root = tree.addNode(null, 'initial state', 'start');
      expect(root).not.toBeNull();
      expect(root!.parentId).toBeNull();
      expect(root!.depth).toBe(0);
      expect(root!.action).toBe('start');
      expect(root!.visitCount).toBe(0);
      expect(root!.totalValue).toBe(0);
    });

    it('creates a child node linked to parent', () => {
      const root = tree.addNode(null, 'root', 'init')!;
      const child = tree.addNode(root.id, 'child state', 'step1');
      expect(child).not.toBeNull();
      expect(child!.parentId).toBe(root.id);
      expect(child!.depth).toBe(1);
    });

    it('returns null when max depth exceeded', () => {
      // maxDepth = 5, build chain until we exceed it
      let parentId: string | null = null;
      let lastNode: any = null;
      for (let i = 0; i <= 10; i++) {
        const node = tree.addNode(parentId, `state ${i}`, `action ${i}`);
        if (node === null) {
          // This is the depth-exceeded case
          expect(i).toBeGreaterThan(5);
          return;
        }
        lastNode = node;
        parentId = node.id;
      }
      // If we get here, we need to verify max depth was enforced
      // by trying one more beyond the last successful node
      const tooDeep = tree.addNode(lastNode!.id, 'too deep', 'nope');
      expect(tooDeep).toBeNull();
    });

    it('returns null for unknown parent', () => {
      const node = tree.addNode('nonexistent', 'state', 'action');
      expect(node).toBeNull();
    });

    it('stores metadata on node', () => {
      const node = tree.addNode(null, 'state', 'action', { custom: 'data' });
      expect(node!.metadata).toEqual({ custom: 'data' });
    });
  });

  describe('recordOutcome', () => {
    it('updates visit count and value for the target node', () => {
      const root = tree.addNode(null, 'root', 'init')!;
      tree.recordOutcome(root.id, 0.8);

      const node = tree.getNode(root.id)!;
      expect(node.visitCount).toBe(1);
      expect(node.totalValue).toBeCloseTo(0.8);
      expect(node.avgValue).toBeCloseTo(0.8);
    });

    it('propagates values up to ancestors (backpropagation)', () => {
      const root = tree.addNode(null, 'root', 'init')!;
      const child = tree.addNode(root.id, 'child', 'step1')!;
      const grandchild = tree.addNode(child.id, 'grandchild', 'step2')!;

      tree.recordOutcome(grandchild.id, 1.0);

      // All ancestors should be updated
      expect(tree.getNode(grandchild.id)!.visitCount).toBe(1);
      expect(tree.getNode(child.id)!.visitCount).toBe(1);
      expect(tree.getNode(root.id)!.visitCount).toBe(1);

      expect(tree.getNode(grandchild.id)!.avgValue).toBeCloseTo(1.0);
      expect(tree.getNode(child.id)!.avgValue).toBeCloseTo(1.0);
      expect(tree.getNode(root.id)!.avgValue).toBeCloseTo(1.0);
    });

    it('correctly averages multiple outcomes', () => {
      const root = tree.addNode(null, 'root', 'init')!;
      tree.recordOutcome(root.id, 1.0);
      tree.recordOutcome(root.id, 0.0);

      const node = tree.getNode(root.id)!;
      expect(node.visitCount).toBe(2);
      expect(node.avgValue).toBeCloseTo(0.5);
    });

    it('is a no-op for unknown nodeId', () => {
      // Should not throw
      tree.recordOutcome('nonexistent', 1.0);
    });
  });

  describe('getChildren (UCB1 ranking)', () => {
    it('returns children sorted by UCB1 score descending', () => {
      const root = tree.addNode(null, 'root', 'init')!;
      const c1 = tree.addNode(root.id, 's1', 'action-a')!;
      const c2 = tree.addNode(root.id, 's2', 'action-b')!;

      // Give root some visits
      tree.recordOutcome(c1.id, 0.2);
      tree.recordOutcome(c1.id, 0.3);
      tree.recordOutcome(c2.id, 0.9);

      const children = tree.getChildren(root.id);
      expect(children).toHaveLength(2);
      // c2 has higher avg value, should rank higher (or exploration bonus may affect)
      expect(children[0].ucb1).toBeGreaterThanOrEqual(children[1].ucb1);
    });

    it('gives Infinity UCB1 to unvisited children', () => {
      const root = tree.addNode(null, 'root', 'init')!;
      tree.addNode(root.id, 's1', 'visited')!;
      tree.addNode(root.id, 's2', 'unvisited')!;

      // Only visit the first child
      const children = tree.getChildren(root.id);
      const unvisited = children.find(c => c.node.action === 'unvisited');
      expect(unvisited!.ucb1).toBe(Infinity);
    });

    it('returns empty array for unknown nodeId', () => {
      expect(tree.getChildren('nonexistent')).toEqual([]);
    });
  });

  describe('getBestPath', () => {
    it('returns path from root to best leaf', () => {
      const root = tree.addNode(null, 'root', 'init')!;
      const a = tree.addNode(root.id, 's-a', 'go-left')!;
      const b = tree.addNode(root.id, 's-b', 'go-right')!;
      tree.addNode(a.id, 's-a1', 'left-leaf');
      tree.addNode(b.id, 's-b1', 'right-leaf')!;

      // Make right path better
      tree.recordOutcome(b.id, 0.9);
      tree.recordOutcome(b.id, 0.9);

      const path = tree.getBestPath(root.id);
      expect(path.length).toBeGreaterThanOrEqual(1);
      expect(path[0].id).toBe(root.id);
    });

    it('returns empty for unknown node', () => {
      expect(tree.getBestPath('nonexistent')).toEqual([]);
    });

    it('returns empty when tree is empty', () => {
      expect(tree.getBestPath()).toEqual([]);
    });
  });

  describe('prune', () => {
    it('removes low-value branches', () => {
      const root = tree.addNode(null, 'root', 'init')!;
      const good = tree.addNode(root.id, 's-good', 'good-action')!;
      const bad = tree.addNode(root.id, 's-bad', 'bad-action')!;

      // Make good node high value
      tree.recordOutcome(good.id, 0.9);
      tree.recordOutcome(good.id, 0.8);

      // Make bad node low value (below pruneThreshold of 0.1)
      tree.recordOutcome(bad.id, 0.01);
      tree.recordOutcome(bad.id, 0.02);

      const removed = tree.prune();
      expect(removed).toBeGreaterThan(0);
      expect(tree.getNode(bad.id)).toBeNull();
      expect(tree.getNode(good.id)).not.toBeNull();
    });

    it('does not prune the root', () => {
      const root = tree.addNode(null, 'root', 'init')!;
      tree.recordOutcome(root.id, 0.01);
      tree.recordOutcome(root.id, 0.01);

      const removed = tree.prune();
      expect(removed).toBe(0);
      expect(tree.getRoot()).not.toBeNull();
    });

    it('does not prune nodes with fewer than 2 visits', () => {
      const root = tree.addNode(null, 'root', 'init')!;
      const child = tree.addNode(root.id, 's', 'action')!;
      tree.recordOutcome(child.id, 0.01); // 1 visit only

      const removed = tree.prune();
      expect(removed).toBe(0);
    });
  });

  describe('getTree / size', () => {
    it('returns tree structure', () => {
      tree.addNode(null, 'root', 'init');
      const data = tree.getTree();
      expect(data.rootId).toBeDefined();
      expect(data.nodes).toHaveLength(1);
    });

    it('reports correct size', () => {
      expect(tree.size).toBe(0);
      tree.addNode(null, 'root', 'init');
      expect(tree.size).toBe(1);
    });
  });
});
