import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCTSEngine } from './mcts.js';
import type { MCTSNode, MCTSOptions } from './mcts.js';

// ---------------------------------------------------------------------------
// Mock FileStore
// ---------------------------------------------------------------------------

const mockFileStore = {
  read: vi.fn().mockResolvedValue(null),
  write: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue([]),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEngine(overrides: Partial<MCTSOptions> = {}): MCTSEngine {
  return new MCTSEngine({
    fileStore: mockFileStore as any,
    maxIterations: 20,
    expandThreshold: 1, // lower threshold for easier testing
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('MCTSEngine — select', () => {
  it('selects unvisited children first', async () => {
    const engine = createEngine({ expandThreshold: 0 });
    // Run a search that will create children; we manually inspect selection
    // by building a tree and calling select directly.
    const root = (engine as any).createNode(null, 'root state', 'root') as MCTSNode;
    (engine as any).rootId = root.id;

    // Expand root manually
    root.visitCount = 5;
    const children = engine.expand(root.id, ['action-a', 'action-b', 'action-c']);
    expect(children.length).toBe(3);

    // All children are unvisited (visitCount = 0) -> UCB1 = Infinity
    // select should return one of the unvisited children
    const selected = engine.select(root.id);
    expect(selected.visitCount).toBe(0);
    // Should be a child, not the root (root is expanded)
    expect(selected.parentId).toBe(root.id);
  });

  it('selects by UCB1 when all children have been visited', async () => {
    const engine = createEngine({ expandThreshold: 0 });
    const root = (engine as any).createNode(null, 'root state', 'root') as MCTSNode;
    (engine as any).rootId = root.id;
    root.visitCount = 20;

    const children = engine.expand(root.id, ['action-a', 'action-b']);

    // Give child-a low value, child-b high value
    const childA = engine.getNode(children[0].id)!;
    childA.visitCount = 5;
    childA.totalValue = 1;
    childA.avgValue = 0.2;

    const childB = engine.getNode(children[1].id)!;
    childB.visitCount = 5;
    childB.totalValue = 4;
    childB.avgValue = 0.8;

    // With equal visit counts, higher avgValue should win
    const selected = engine.select(root.id);
    expect(selected.id).toBe(childB.id);
  });

  it('returns the node itself if it has no children', () => {
    const engine = createEngine();
    const root = (engine as any).createNode(null, 'root state', 'root') as MCTSNode;
    (engine as any).rootId = root.id;

    const selected = engine.select(root.id);
    expect(selected.id).toBe(root.id);
  });
});

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

describe('MCTSEngine — expand', () => {
  it('creates correct number of children', () => {
    const engine = createEngine({ expandThreshold: 0 });
    const root = (engine as any).createNode(null, 'root', 'root') as MCTSNode;
    (engine as any).rootId = root.id;
    root.visitCount = 5;

    const actions = ['a', 'b', 'c', 'd'];
    const children = engine.expand(root.id, actions);

    expect(children.length).toBe(4);
    expect(root.children.length).toBe(4);
    expect(root.isExpanded).toBe(true);
  });

  it('respects expandThreshold', () => {
    const engine = createEngine({ expandThreshold: 5 });
    const root = (engine as any).createNode(null, 'root', 'root') as MCTSNode;
    (engine as any).rootId = root.id;
    root.visitCount = 2; // below threshold of 5

    const children = engine.expand(root.id, ['a', 'b']);
    expect(children.length).toBe(0);
    expect(root.isExpanded).toBe(false);
  });

  it('respects maxDepth', () => {
    const engine = createEngine({ expandThreshold: 0, maxDepth: 2 });
    const root = (engine as any).createNode(null, 'root', 'root') as MCTSNode;
    (engine as any).rootId = root.id;
    root.visitCount = 5;

    // Expand root (depth 0)
    const level1 = engine.expand(root.id, ['a']);
    expect(level1.length).toBe(1);
    expect(level1[0].depth).toBe(1);

    // Expand level 1 (depth 1)
    level1[0].visitCount = 5;
    const level2 = engine.expand(level1[0].id, ['b']);
    expect(level2.length).toBe(1);
    expect(level2[0].depth).toBe(2);

    // Try to expand level 2 (depth 2 = maxDepth) -> should fail
    level2[0].visitCount = 5;
    const level3 = engine.expand(level2[0].id, ['c']);
    expect(level3.length).toBe(0);
    expect(level2[0].isTerminal).toBe(true);
  });

  it('does not re-expand an already expanded node', () => {
    const engine = createEngine({ expandThreshold: 0 });
    const root = (engine as any).createNode(null, 'root', 'root') as MCTSNode;
    (engine as any).rootId = root.id;
    root.visitCount = 5;

    engine.expand(root.id, ['a', 'b']);
    const secondExpand = engine.expand(root.id, ['c', 'd']);
    expect(secondExpand.length).toBe(0);
    expect(root.children.length).toBe(2); // Still only the first expansion
  });
});

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

describe('MCTSEngine — simulate', () => {
  it('uses historical outcomes when available', () => {
    // Use simulationDepth=1 to isolate the historical value effect
    const engine = createEngine({ simulationDepth: 1 });
    const node = (engine as any).createNode(null, 'state', 'known-action') as MCTSNode;

    const historical = new Map([
      ['known-action', { avgValue: 0.9, visitCount: 20 }],
    ]);

    const result = engine.simulate(node, historical);
    // With high historical avgValue and high visit count (confidence ~1),
    // the value should be close to 0.9
    expect(result.value).toBeGreaterThan(DEFAULT_FALLBACK_VALUE());
    expect(result.depth).toBe(1);
    expect(result.terminalReached).toBe(false);
  });

  it('falls back to default value 0.5 without historical data', () => {
    const engine = createEngine({ simulationDepth: 1 });
    const node = (engine as any).createNode(null, 'state', 'unknown-action') as MCTSNode;

    const result = engine.simulate(node);
    expect(result.value).toBeCloseTo(0.5);
    expect(result.depth).toBe(1);
  });

  it('returns early for terminal nodes', () => {
    const engine = createEngine();
    const node = (engine as any).createNode(null, 'state', 'action') as MCTSNode;
    node.isTerminal = true;
    node.avgValue = 0.7;

    const result = engine.simulate(node);
    expect(result.value).toBeCloseTo(0.7);
    expect(result.depth).toBe(0);
    expect(result.terminalReached).toBe(true);
  });

  it('returns default value for terminal nodes with no prior value', () => {
    const engine = createEngine();
    const node = (engine as any).createNode(null, 'state', 'action') as MCTSNode;
    node.isTerminal = true;

    const result = engine.simulate(node);
    expect(result.value).toBeCloseTo(0.5);
    expect(result.terminalReached).toBe(true);
  });
});

/** Helper: the default fallback simulation value. */
function DEFAULT_FALLBACK_VALUE(): number {
  return 0.5;
}

// ---------------------------------------------------------------------------
// Backpropagation
// ---------------------------------------------------------------------------

describe('MCTSEngine — backpropagate', () => {
  it('updates node and all ancestors', () => {
    const engine = createEngine();
    const root = (engine as any).createNode(null, 'root', 'root') as MCTSNode;
    (engine as any).rootId = root.id;

    const child = (engine as any).createNode(root.id, 'child', 'action-a') as MCTSNode;
    root.children.push(child.id);

    const grandchild = (engine as any).createNode(child.id, 'grandchild', 'action-b') as MCTSNode;
    child.children.push(grandchild.id);

    engine.backpropagate(grandchild.id, 0.8);

    expect(grandchild.visitCount).toBe(1);
    expect(grandchild.totalValue).toBeCloseTo(0.8);
    expect(grandchild.avgValue).toBeCloseTo(0.8);

    expect(child.visitCount).toBe(1);
    expect(child.totalValue).toBeCloseTo(0.8);
    expect(child.avgValue).toBeCloseTo(0.8);

    expect(root.visitCount).toBe(1);
    expect(root.totalValue).toBeCloseTo(0.8);
    expect(root.avgValue).toBeCloseTo(0.8);
  });

  it('correctly averages multiple backpropagations', () => {
    const engine = createEngine();
    const root = (engine as any).createNode(null, 'root', 'root') as MCTSNode;
    (engine as any).rootId = root.id;

    const child = (engine as any).createNode(root.id, 'child', 'action') as MCTSNode;
    root.children.push(child.id);

    engine.backpropagate(child.id, 1.0);
    engine.backpropagate(child.id, 0.0);

    expect(child.visitCount).toBe(2);
    expect(child.avgValue).toBeCloseTo(0.5);

    expect(root.visitCount).toBe(2);
    expect(root.avgValue).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// Full search
// ---------------------------------------------------------------------------

describe('MCTSEngine — search', () => {
  it('produces a valid MCTSResult', async () => {
    const engine = createEngine({ maxIterations: 30, expandThreshold: 1 });
    const result = await engine.search(
      'initial state',
      ['action-a', 'action-b', 'action-c'],
    );

    expect(result.bestAction).toBeTruthy();
    expect(result.bestPath.length).toBeGreaterThanOrEqual(1);
    expect(result.rootVisits).toBeGreaterThan(0);
    expect(result.treeSize).toBeGreaterThan(1);
    expect(result.iterations).toBe(30);
    expect(result.avgSimulationValue).toBeGreaterThan(0);
    expect(result.avgSimulationValue).toBeLessThanOrEqual(1);
  });

  it('best action has the highest visit count among root children', async () => {
    const engine = createEngine({ maxIterations: 50, expandThreshold: 1 });
    const result = await engine.search(
      'initial state',
      ['action-a', 'action-b'],
    );

    const root = engine.getRoot()!;
    const children = root.children.map((id) => engine.getNode(id)!);

    // Find child with max visits
    const maxVisitChild = children.reduce(
      (best, c) => (c.visitCount > best.visitCount ? c : best),
      children[0],
    );

    expect(result.bestAction).toBe(maxVisitChild.action);
  });

  it('uses LM value function when provided and no historical data', async () => {
    const lmValueFn = vi.fn().mockResolvedValue(0.9);
    const engine = createEngine({ maxIterations: 10, expandThreshold: 1 });

    const result = await engine.search('state', ['action-x'], undefined, lmValueFn);

    expect(lmValueFn).toHaveBeenCalled();
    expect(result.bestAction).toBe('action-x');
  });

  it('uses historical outcomes over LM value function', async () => {
    const lmValueFn = vi.fn().mockResolvedValue(0.1);
    const historical = new Map([
      ['action-y', { avgValue: 0.95, visitCount: 50 }],
    ]);

    const engine = createEngine({ maxIterations: 10, expandThreshold: 1 });
    await engine.search('state', ['action-y'], historical, lmValueFn);

    // LM function should NOT have been called for action-y because historical data exists
    // (It may be called for 'root' action during initial iterations)
    const callsForActionY = lmValueFn.mock.calls.filter(
      (call: unknown[]) => call[1] === 'action-y',
    );
    expect(callsForActionY.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('MCTSEngine — edge cases', () => {
  it('handles empty candidate actions', async () => {
    const engine = createEngine();
    const result = await engine.search('state', []);

    expect(result.bestAction).toBe('');
    expect(result.iterations).toBe(0);
    expect(result.treeSize).toBe(1);
  });

  it('handles single candidate action', async () => {
    const engine = createEngine({ maxIterations: 10, expandThreshold: 1 });
    const result = await engine.search('state', ['only-action']);

    expect(result.bestAction).toBe('only-action');
    expect(result.treeSize).toBeGreaterThan(1);
  });

  it('handles terminal nodes gracefully in selection', () => {
    const engine = createEngine();
    const root = (engine as any).createNode(null, 'root', 'root') as MCTSNode;
    (engine as any).rootId = root.id;
    root.isTerminal = true;

    const selected = engine.select(root.id);
    expect(selected.id).toBe(root.id);
  });
});

// ---------------------------------------------------------------------------
// Tree management
// ---------------------------------------------------------------------------

describe('MCTSEngine — tree management', () => {
  it('getNode returns null for unknown ID', () => {
    const engine = createEngine();
    expect(engine.getNode('nonexistent')).toBeNull();
  });

  it('getRoot returns null for empty tree', () => {
    const engine = createEngine();
    expect(engine.getRoot()).toBeNull();
  });

  it('getTree returns all nodes', async () => {
    const engine = createEngine({ maxIterations: 5, expandThreshold: 1 });
    await engine.search('state', ['a', 'b']);

    const tree = engine.getTree();
    expect(tree.rootId).toBeTruthy();
    expect(tree.nodes.length).toBeGreaterThan(0);
  });

  it('clear empties the tree', async () => {
    const engine = createEngine({ maxIterations: 5, expandThreshold: 1 });
    await engine.search('state', ['a']);

    expect(engine.getRoot()).not.toBeNull();
    engine.clear();
    expect(engine.getRoot()).toBeNull();
    expect(engine.getTree().nodes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('MCTSEngine — persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('save persists index and nodes to FileStore', async () => {
    const engine = createEngine({ maxIterations: 5, expandThreshold: 1 });
    await engine.search('state', ['a', 'b']);

    await engine.save();

    // Should have written index + one write per node
    const tree = engine.getTree();
    const expectedWrites = 1 + tree.nodes.length; // index + nodes
    expect(mockFileStore.write).toHaveBeenCalledTimes(expectedWrites);

    // First call should be the index
    expect(mockFileStore.write.mock.calls[0][0]).toBe('mcts');
    expect(mockFileStore.write.mock.calls[0][1]).toBe('mcts-tree-index');
  });

  it('load restores tree from FileStore', async () => {
    const nodeA: MCTSNode = {
      id: 'node-a',
      parentId: null,
      stateDescription: 'root',
      action: 'root',
      totalValue: 5,
      visitCount: 10,
      avgValue: 0.5,
      children: ['node-b'],
      depth: 0,
      isExpanded: true,
      isTerminal: false,
      simulationCount: 5,
      createdAt: Date.now(),
    };

    const nodeB: MCTSNode = {
      id: 'node-b',
      parentId: 'node-a',
      stateDescription: 'child',
      action: 'action-b',
      totalValue: 3,
      visitCount: 5,
      avgValue: 0.6,
      children: [],
      depth: 1,
      isExpanded: false,
      isTerminal: false,
      simulationCount: 3,
      createdAt: Date.now(),
    };

    mockFileStore.read.mockImplementation(async (_col: string, id: string) => {
      if (id === 'mcts-tree-index') {
        return { rootId: 'node-a', nodeIds: ['node-a', 'node-b'], savedAt: Date.now() };
      }
      if (id === 'mcts-node-a') return nodeA;
      if (id === 'mcts-node-b') return nodeB;
      return null;
    });

    const engine = createEngine();
    await engine.load();

    const root = engine.getRoot();
    expect(root).not.toBeNull();
    expect(root!.id).toBe('node-a');
    expect(root!.children).toContain('node-b');

    const child = engine.getNode('node-b');
    expect(child).not.toBeNull();
    expect(child!.action).toBe('action-b');
  });

  it('load starts fresh when no index exists', async () => {
    mockFileStore.read.mockResolvedValue(null);

    const engine = createEngine();
    await engine.load();

    expect(engine.getRoot()).toBeNull();
    expect(engine.getTree().nodes.length).toBe(0);
  });
});
