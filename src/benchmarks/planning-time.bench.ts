/**
 * Benchmark: MCTS planning time for action tree operations.
 *
 * Measures UCB1 selection + backpropagation at various iteration budgets
 * (10, 100, 1000).
 *
 * Target: < 5s for 100 iterations.
 */

import { describe, bench } from 'vitest';
import { ActionTree } from '../planning/action-tree.js';
import {
  ValueEstimator,
  computeUCB1,
  computeRecencyWeight,
} from '../planning/value.js';
import type { ActionTreeNode } from '../planning/action-tree.js';
import { FileStore } from '../utils/file-store.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempFileStore(): Promise<FileStore> {
  const dir = await mkdtemp(join(tmpdir(), 'apex-bench-planning-'));
  const store = new FileStore(dir);
  await store.init();
  return store;
}

function buildTree(
  tree: ActionTree,
  parentId: string | null,
  depth: number,
  branchingFactor: number,
): string[] {
  if (depth <= 0) return [];
  const nodeIds: string[] = [];
  for (let i = 0; i < branchingFactor; i++) {
    const node = tree.addNode(parentId, `state-d${depth}-b${i}`, `action-d${depth}-b${i}`);
    if (node) {
      tree.recordOutcome(node.id, Math.random());
      nodeIds.push(node.id);
      nodeIds.push(...buildTree(tree, node.id, depth - 1, branchingFactor));
    }
  }
  return nodeIds;
}

// ---------------------------------------------------------------------------
// Pure UCB1 computation benchmarks
// ---------------------------------------------------------------------------

describe('UCB1 computation (pure math)', () => {
  bench('computeUCB1 single call', () => {
    computeUCB1(0.65, 1000, 50);
  });

  bench('computeUCB1 x1000 calls', () => {
    for (let i = 1; i <= 1000; i++) {
      computeUCB1(Math.random(), 1000, i);
    }
  });

  bench('computeRecencyWeight x1000 calls', () => {
    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      computeRecencyWeight(now - i * 86_400_000);
    }
  });
});

// ---------------------------------------------------------------------------
// ValueEstimator benchmarks
// ---------------------------------------------------------------------------

describe('ValueEstimator.estimateValue', () => {
  const estimator = new ValueEstimator();

  const makeNode = (id: string, visits: number, avgVal: number): ActionTreeNode => ({
    id,
    parentId: null,
    stateDescription: 'test state',
    action: `test action for ${id}`,
    totalValue: avgVal * visits,
    visitCount: visits,
    avgValue: avgVal,
    children: [],
    depth: 1,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now(),
  });

  bench('estimateValue single node (no skills)', () => {
    const node = makeNode('n1', 50, 0.7);
    estimator.estimateValue(node, 500);
  });

  bench('rankChildren 10 nodes', () => {
    const children = Array.from({ length: 10 }, (_, i) =>
      makeNode(`c${i}`, i + 1, Math.random()),
    );
    estimator.rankChildren(children, 100);
  });

  bench('rankChildren 100 nodes', () => {
    const children = Array.from({ length: 100 }, (_, i) =>
      makeNode(`c${i}`, i + 1, Math.random()),
    );
    estimator.rankChildren(children, 1000);
  });
});

// ---------------------------------------------------------------------------
// ActionTree operations at various iteration budgets
// ---------------------------------------------------------------------------

describe('ActionTree: add + recordOutcome iterations', () => {
  bench('10 iterations: add node + record outcome + getBestPath', async () => {
    const store = await makeTempFileStore();
    const tree = new ActionTree({ fileStore: store });
    const root = tree.addNode(null, 'root state', 'root action')!;
    for (let i = 0; i < 10; i++) {
      const node = tree.addNode(root.id, `state-${i}`, `action-${i}`);
      if (node) tree.recordOutcome(node.id, Math.random());
    }
    tree.getBestPath();
  });

  bench('100 iterations: add node + record outcome + getBestPath', async () => {
    const store = await makeTempFileStore();
    const tree = new ActionTree({ fileStore: store });
    const root = tree.addNode(null, 'root state', 'root action')!;
    let currentParent = root.id;
    for (let i = 0; i < 100; i++) {
      const node = tree.addNode(currentParent, `state-${i}`, `action-${i}`);
      if (node) {
        tree.recordOutcome(node.id, Math.random());
        currentParent = i % 5 === 0 ? root.id : node.id;
      }
    }
    tree.getBestPath();
  }, { iterations: 10 });

  bench('1000 iterations: add node + record outcome + prune', async () => {
    const store = await makeTempFileStore();
    const tree = new ActionTree({ fileStore: store, maxDepth: 20 });
    const root = tree.addNode(null, 'root state', 'root action')!;
    let currentParent = root.id;
    for (let i = 0; i < 1000; i++) {
      const node = tree.addNode(currentParent, `state-${i}`, `action-${i}`);
      if (node) {
        tree.recordOutcome(node.id, Math.random() * 0.5);
        currentParent = i % 10 === 0 ? root.id : node.id;
      }
    }
    tree.prune();
    tree.getBestPath();
  }, { iterations: 3 });
});

// ---------------------------------------------------------------------------
// Full selection + backpropagation cycle
// ---------------------------------------------------------------------------

describe('UCB1 selection + backpropagation cycle', () => {
  bench('100 iterations: select best child + backpropagate', async () => {
    const store = await makeTempFileStore();
    const tree = new ActionTree({ fileStore: store });
    const root = tree.addNode(null, 'root', 'start')!;
    buildTree(tree, root.id, 3, 5);

    for (let i = 0; i < 100; i++) {
      let current = root;
      while (current.children.length > 0) {
        const children = tree.getChildren(current.id);
        if (children.length === 0) break;
        current = children[0].node;
      }
      tree.recordOutcome(current.id, Math.random());
    }
  }, { iterations: 5 });
});
