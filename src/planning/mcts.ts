/**
 * APEX MCTS Planning Engine
 *
 * Monte Carlo Tree Search for forward-looking action planning. This module
 * complements the retrospective {@link ActionTree} by generating and
 * evaluating candidate action sequences *before* execution.
 *
 * The engine supports:
 * - Standard UCB1 tree policy for selection
 * - Historical outcome data for informed simulations
 * - Optional LM value functions for nodes without historical data
 * - FileStore-backed persistence (collection: `'mcts'`)
 */

import { generateId } from '../types.js';
import type { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FileStore collection for MCTS data. */
const COLLECTION = 'mcts';

/** FileStore document ID for the serialised tree index. */
const TREE_INDEX_ID = 'mcts-tree-index';

/** Default maximum tree depth. */
const DEFAULT_MAX_DEPTH = 8;

/** Default maximum number of search iterations. */
const DEFAULT_MAX_ITERATIONS = 50;

/** Default UCB1 exploration constant. */
const DEFAULT_EXPLORATION_CONSTANT = Math.SQRT2;

/** Default simulation rollout depth. */
const DEFAULT_SIMULATION_DEPTH = 5;

/** Default minimum visits before a node can be expanded. */
const DEFAULT_EXPAND_THRESHOLD = 2;

/** Default simulation value when no historical data is available. */
const DEFAULT_SIMULATION_VALUE = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single node in the MCTS search tree.
 */
export interface MCTSNode {
  /** Unique identifier for this node. */
  id: string;

  /** Parent node ID, or `null` for the root. */
  parentId: string | null;

  /** Human-readable description of the state before the action. */
  stateDescription: string;

  /** The action that leads to this state. */
  action: string;

  /** Cumulative sum of simulation values propagated through this node. */
  totalValue: number;

  /** Number of times this node has been visited during search. */
  visitCount: number;

  /** Running average: `totalValue / visitCount`. */
  avgValue: number;

  /** IDs of child nodes. */
  children: string[];

  /** Depth of this node in the tree (root = 0). */
  depth: number;

  /** Whether expansion has been attempted for this node. */
  isExpanded: boolean;

  /** Whether this node represents a terminal state. */
  isTerminal: boolean;

  /** Value from LM evaluation, if available. */
  lmValue?: number;

  /** Number of simulations that have been run through this node. */
  simulationCount: number;

  /** Unix-epoch millisecond timestamp of creation. */
  createdAt: number;

  /** Optional arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration options for {@link MCTSEngine}.
 */
export interface MCTSOptions {
  /** Shared file store for persistence. */
  fileStore: FileStore;

  /** Optional logger instance. */
  logger?: Logger;

  /**
   * Maximum allowed tree depth.
   * @default 8
   */
  maxDepth?: number;

  /**
   * Maximum number of search iterations per call to {@link MCTSEngine.search}.
   * @default 50
   */
  maxIterations?: number;

  /**
   * UCB1 exploration constant (the "c" parameter).
   * @default Math.SQRT2
   */
  explorationConstant?: number;

  /**
   * Maximum depth for simulation rollouts.
   * @default 5
   */
  simulationDepth?: number;

  /**
   * Minimum visit count before a node is eligible for expansion.
   * @default 2
   */
  expandThreshold?: number;
}

/**
 * Result returned by {@link MCTSEngine.search}.
 */
export interface MCTSResult {
  /** The action string of the best child of the root (highest visit count). */
  bestAction: string;

  /** Ordered path of nodes from root to the most-visited leaf. */
  bestPath: MCTSNode[];

  /** Total visit count at the root node. */
  rootVisits: number;

  /** Total number of nodes in the search tree. */
  treeSize: number;

  /** Number of MCTS iterations that were executed. */
  iterations: number;

  /** Mean simulation value across all iterations. */
  avgSimulationValue: number;
}

/**
 * Result of a single simulation (rollout) from a node.
 */
export interface SimulationResult {
  /** Estimated value from the simulation, in `[0, 1]`. */
  value: number;

  /** How many steps deep the simulation went. */
  depth: number;

  /** Whether a terminal state was reached during simulation. */
  terminalReached: boolean;
}

/**
 * Serialised tree index stored in FileStore.
 */
interface MCTSTreeIndex {
  /** ID of the root node (if one exists). */
  rootId: string | null;

  /** All node IDs currently in the tree. */
  nodeIds: string[];

  /** Unix-epoch millisecond timestamp of last save. */
  savedAt: number;
}

// ---------------------------------------------------------------------------
// MCTSEngine
// ---------------------------------------------------------------------------

/**
 * Monte Carlo Tree Search engine for forward-looking action planning.
 *
 * Usage:
 * 1. `await engine.load()` — hydrate from disk (or start fresh).
 * 2. `await engine.search(rootState, candidateActions, ...)` — run MCTS.
 * 3. `await engine.save()` — persist the search tree.
 *
 * The search tree is kept separate from the retrospective {@link ActionTree}
 * and uses the `'mcts'` FileStore collection.
 */
export class MCTSEngine {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly maxDepth: number;
  private readonly maxIterations: number;
  private readonly explorationConstant: number;
  private readonly simulationDepth: number;
  private readonly expandThreshold: number;

  /** In-memory node map keyed by node ID. */
  private nodes: Map<string, MCTSNode> = new Map();

  /** Root node ID, or `null` if the tree is empty. */
  private rootId: string | null = null;

  constructor(opts: MCTSOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:mcts' });
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.explorationConstant = opts.explorationConstant ?? DEFAULT_EXPLORATION_CONSTANT;
    this.simulationDepth = opts.simulationDepth ?? DEFAULT_SIMULATION_DEPTH;
    this.expandThreshold = opts.expandThreshold ?? DEFAULT_EXPAND_THRESHOLD;
  }

  // -----------------------------------------------------------------------
  // Core MCTS loop
  // -----------------------------------------------------------------------

  /**
   * Run a full MCTS search from the given root state.
   *
   * @param rootState          - Description of the initial state.
   * @param candidateActions   - Available actions to consider at each expansion.
   * @param historicalOutcomes - Optional map of action -> historical stats for simulation.
   * @param lmValueFn          - Optional LM-based value function for states without history.
   * @returns The search result including the best action and tree statistics.
   */
  async search(
    rootState: string,
    candidateActions: string[],
    historicalOutcomes?: Map<string, { avgValue: number; visitCount: number }>,
    lmValueFn?: (state: string, action: string) => Promise<number>,
  ): Promise<MCTSResult> {
    // Clear existing tree and create root
    this.clear();

    const root = this.createNode(null, rootState, 'root');
    this.rootId = root.id;

    if (candidateActions.length === 0) {
      return {
        bestAction: '',
        bestPath: [root],
        rootVisits: 0,
        treeSize: 1,
        iterations: 0,
        avgSimulationValue: 0,
      };
    }

    let totalSimValue = 0;
    let iterations = 0;

    for (let i = 0; i < this.maxIterations; i++) {
      // 1. Selection: traverse tree to a promising leaf
      const selected = this.select(root.id);

      // 2. Expansion: if the selected node meets the threshold, expand it
      let simulationNode = selected;
      if (
        !selected.isTerminal &&
        !selected.isExpanded &&
        selected.visitCount >= this.expandThreshold &&
        selected.depth < this.maxDepth
      ) {
        const children = this.expand(selected.id, candidateActions);
        if (children.length > 0) {
          // Pick the first unvisited child for simulation
          simulationNode = children[0];
        }
      }

      // 3. Simulation: run a lightweight rollout
      let simResult: SimulationResult;
      if (lmValueFn && !historicalOutcomes?.has(simulationNode.action)) {
        const lmValue = await lmValueFn(simulationNode.stateDescription, simulationNode.action);
        simResult = { value: Math.max(0, Math.min(1, lmValue)), depth: 1, terminalReached: false };
        simulationNode.lmValue = simResult.value;
      } else {
        simResult = this.simulate(simulationNode, historicalOutcomes);
      }

      simulationNode.simulationCount += 1;
      totalSimValue += simResult.value;

      // 4. Backpropagation: update values up to root
      this.backpropagate(simulationNode.id, simResult.value);

      iterations++;
    }

    // Determine best action: child of root with highest visit count (standard MCTS)
    const rootNode = this.nodes.get(this.rootId)!;
    const bestChild = this.getBestChild(rootNode);
    const bestPath = this.buildBestPath(rootNode);

    return {
      bestAction: bestChild?.action ?? '',
      bestPath,
      rootVisits: rootNode.visitCount,
      treeSize: this.nodes.size,
      iterations,
      avgSimulationValue: iterations > 0 ? totalSimValue / iterations : 0,
    };
  }

  // -----------------------------------------------------------------------
  // MCTS phases (public for testing)
  // -----------------------------------------------------------------------

  /**
   * Selection phase: traverse the tree from the given node using UCB1 tree
   * policy until reaching an unexpanded or terminal node.
   *
   * @param nodeId - The node ID to start selection from.
   * @returns The selected leaf node.
   */
  select(nodeId: string): MCTSNode {
    let current = this.nodes.get(nodeId);
    if (!current) {
      throw new Error(`select: node not found: ${nodeId}`);
    }

    while (current.isExpanded && current.children.length > 0 && !current.isTerminal) {
      let bestChild: MCTSNode | null = null;
      let bestUCB1 = -Infinity;

      for (const childId of current.children) {
        const child = this.nodes.get(childId);
        if (!child) continue;

        const ucb1 = this.computeUCB1(child, current.visitCount);
        if (ucb1 > bestUCB1) {
          bestUCB1 = ucb1;
          bestChild = child;
        }
      }

      if (!bestChild) break;
      current = bestChild;
    }

    return current;
  }

  /**
   * Expansion phase: add child nodes for each candidate action.
   *
   * Only expands if the node has been visited at least {@link expandThreshold}
   * times and has not already been expanded.
   *
   * @param nodeId  - The node to expand.
   * @param actions - Candidate actions to create children for.
   * @returns Array of newly created child nodes.
   */
  expand(nodeId: string, actions: string[]): MCTSNode[] {
    const node = this.nodes.get(nodeId);
    if (!node) {
      this.logger.warn('expand: node not found', { nodeId });
      return [];
    }

    if (node.isExpanded) {
      this.logger.debug('expand: node already expanded', { nodeId });
      return [];
    }

    if (node.visitCount < this.expandThreshold) {
      this.logger.debug('expand: visit count below threshold', {
        nodeId,
        visitCount: node.visitCount,
        threshold: this.expandThreshold,
      });
      return [];
    }

    if (node.depth >= this.maxDepth) {
      this.logger.debug('expand: max depth reached', { nodeId, depth: node.depth });
      node.isTerminal = true;
      return [];
    }

    const children: MCTSNode[] = [];
    for (const action of actions) {
      const childState = `${node.stateDescription} -> ${action}`;
      const child = this.createNode(node.id, childState, action);
      node.children.push(child.id);
      children.push(child);
    }

    node.isExpanded = true;

    this.logger.debug('Node expanded', {
      nodeId,
      childCount: children.length,
      depth: node.depth,
    });

    return children;
  }

  /**
   * Simulation phase: run a lightweight rollout from the given node.
   *
   * Uses historical outcome data when available; otherwise falls back to
   * a default value of 0.5.
   *
   * @param node               - The node to simulate from.
   * @param historicalOutcomes - Optional map of action -> historical stats.
   * @returns The simulation result.
   */
  simulate(
    node: MCTSNode,
    historicalOutcomes?: Map<string, { avgValue: number; visitCount: number }>,
  ): SimulationResult {
    if (node.isTerminal) {
      return { value: node.avgValue || DEFAULT_SIMULATION_VALUE, depth: 0, terminalReached: true };
    }

    let cumulativeValue = 0;
    let steps = 0;
    let terminalReached = false;

    // Start from the current node's action
    const startAction = node.action;
    const historical = historicalOutcomes?.get(startAction);

    if (historical && historical.visitCount > 0) {
      // Weighted by confidence: more visits = more confidence in historical value
      const confidence = Math.min(1, historical.visitCount / 10);
      cumulativeValue += historical.avgValue * confidence + DEFAULT_SIMULATION_VALUE * (1 - confidence);
      steps++;
    } else {
      cumulativeValue += DEFAULT_SIMULATION_VALUE;
      steps++;
    }

    // Continue rollout for remaining simulation depth
    for (let d = 1; d < this.simulationDepth; d++) {
      if (terminalReached) break;

      // In a lightweight rollout without action enumeration, use default value
      // If historical data exists for any action, we could sample, but we keep
      // it simple: default value with slight decay
      cumulativeValue += DEFAULT_SIMULATION_VALUE * Math.pow(0.9, d);
      steps++;
    }

    const value = Math.max(0, Math.min(1, cumulativeValue / steps));
    return { value, depth: steps, terminalReached };
  }

  /**
   * Backpropagation phase: update visit count and value from the given node
   * up to the root.
   *
   * @param nodeId - The node to start backpropagation from.
   * @param value  - The simulation value to propagate.
   */
  backpropagate(nodeId: string, value: number): void {
    let current: MCTSNode | undefined = this.nodes.get(nodeId);
    if (!current) {
      this.logger.warn('backpropagate: node not found', { nodeId });
      return;
    }

    while (current) {
      current.visitCount += 1;
      current.totalValue += value;
      current.avgValue = current.totalValue / current.visitCount;

      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Tree management
  // -----------------------------------------------------------------------

  /**
   * Get the node with the given ID, or `null` if not found.
   *
   * @param nodeId - The node ID to look up.
   * @returns The node, or `null`.
   */
  getNode(nodeId: string): MCTSNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  /**
   * Get the root node, or `null` if the tree is empty.
   *
   * @returns The root node, or `null`.
   */
  getRoot(): MCTSNode | null {
    return this.rootId ? this.nodes.get(this.rootId) ?? null : null;
  }

  /**
   * Get the full tree as a plain object.
   *
   * @returns Object containing the root ID and all nodes.
   */
  getTree(): { rootId: string | null; nodes: MCTSNode[] } {
    return {
      rootId: this.rootId,
      nodes: [...this.nodes.values()],
    };
  }

  /**
   * Clear the in-memory tree (does not affect persisted data).
   */
  clear(): void {
    this.nodes.clear();
    this.rootId = null;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Persist the full MCTS tree to FileStore (index + individual nodes).
   */
  async save(): Promise<void> {
    const nodeIds = [...this.nodes.keys()];

    const index: MCTSTreeIndex = {
      rootId: this.rootId,
      nodeIds,
      savedAt: Date.now(),
    };
    await this.fileStore.write(COLLECTION, TREE_INDEX_ID, index);

    for (const node of this.nodes.values()) {
      await this.fileStore.write(COLLECTION, `mcts-${node.id}`, node);
    }

    this.logger.info('MCTS tree saved', { nodeCount: nodeIds.length });
  }

  /**
   * Load the MCTS tree from FileStore. If no persisted tree exists, start empty.
   */
  async load(): Promise<void> {
    this.nodes.clear();
    this.rootId = null;

    const index = await this.fileStore.read<MCTSTreeIndex>(COLLECTION, TREE_INDEX_ID);
    if (!index || index.nodeIds.length === 0) {
      this.logger.debug('No existing MCTS tree found — starting fresh');
      return;
    }

    let loaded = 0;
    for (const nodeId of index.nodeIds) {
      const node = await this.fileStore.read<MCTSNode>(COLLECTION, `mcts-${nodeId}`);
      if (node) {
        this.nodes.set(node.id, node);
        loaded++;
      }
    }

    this.rootId = index.rootId;
    this.logger.info('MCTS tree loaded', { nodeCount: loaded, rootId: this.rootId });
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Create a new MCTSNode and add it to the in-memory map.
   */
  private createNode(parentId: string | null, stateDescription: string, action: string): MCTSNode {
    const node: MCTSNode = {
      id: generateId(),
      parentId,
      stateDescription,
      action,
      totalValue: 0,
      visitCount: 0,
      avgValue: 0,
      children: [],
      depth: parentId ? (this.nodes.get(parentId)?.depth ?? 0) + 1 : 0,
      isExpanded: false,
      isTerminal: false,
      simulationCount: 0,
      createdAt: Date.now(),
    };

    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * Compute the UCB1 score for a child node.
   *
   * UCB1 = avgValue + c * sqrt(ln(parentVisits) / childVisits)
   *
   * Unvisited children receive `Infinity` to ensure they are explored first.
   */
  private computeUCB1(child: MCTSNode, parentVisitCount: number): number {
    if (child.visitCount === 0) {
      return Infinity;
    }
    if (parentVisitCount === 0) {
      return child.avgValue;
    }
    const exploitation = child.avgValue;
    const exploration =
      this.explorationConstant * Math.sqrt(Math.log(parentVisitCount) / child.visitCount);
    return exploitation + exploration;
  }

  /**
   * Get the child of a node with the highest visit count (standard MCTS
   * best-action selection).
   */
  private getBestChild(node: MCTSNode): MCTSNode | null {
    let best: MCTSNode | null = null;
    let bestVisits = -1;

    for (const childId of node.children) {
      const child = this.nodes.get(childId);
      if (child && child.visitCount > bestVisits) {
        bestVisits = child.visitCount;
        best = child;
      }
    }

    return best;
  }

  /**
   * Build the best path from a node down to a leaf, selecting the child
   * with the highest visit count at each level.
   */
  private buildBestPath(from: MCTSNode): MCTSNode[] {
    const path: MCTSNode[] = [from];
    let current = from;

    while (current.children.length > 0) {
      const bestChild = this.getBestChild(current);
      if (!bestChild) break;
      path.push(bestChild);
      current = bestChild;
    }

    return path;
  }
}
