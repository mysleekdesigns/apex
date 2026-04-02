/**
 * APEX Action History Tree
 *
 * Tree structure tracking historical action sequences and their outcomes.
 * Each node records a state description, the action taken, and aggregated
 * outcome statistics (visit count, total value, average value). Children
 * are ranked using UCB1-informed scoring, and low-value branches are
 * automatically pruned.
 *
 * This is a retrospective data structure — it organises past experience,
 * it does NOT run live MCTS simulations.
 */

import { generateId } from '../types.js';
import type { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FileStore collection for action-tree data. */
const COLLECTION = 'planning';

/** FileStore document ID for the serialised tree index. */
const TREE_INDEX_ID = 'action-tree-index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single node in the action history tree.
 */
export interface ActionTreeNode {
  /** Unique identifier for this node. */
  id: string;

  /** Parent node ID, or `null` for the root. */
  parentId: string | null;

  /** Human-readable description of the state before the action. */
  stateDescription: string;

  /** The action that was taken from this state. */
  action: string;

  /** Cumulative sum of outcome values recorded at or below this node. */
  totalValue: number;

  /** Number of times this action path has been visited. */
  visitCount: number;

  /** Running average: `totalValue / visitCount`. */
  avgValue: number;

  /** IDs of child nodes. */
  children: string[];

  /** Depth of this node in the tree (root = 0). */
  depth: number;

  /** Unix-epoch millisecond timestamp of creation. */
  createdAt: number;

  /** Unix-epoch millisecond timestamp of last update. */
  updatedAt: number;

  /** Optional arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration options for {@link ActionTree}.
 */
export interface ActionTreeOptions {
  /** Shared file store for persistence. */
  fileStore: FileStore;

  /** Optional logger instance. */
  logger?: Logger;

  /**
   * Average value below which branches are pruned.
   * @default 0.1
   */
  pruneThreshold?: number;

  /**
   * Maximum allowed tree depth.
   * @default 10
   */
  maxDepth?: number;

  /**
   * UCB1 exploration constant (the "c" parameter).
   * @default Math.SQRT2
   */
  explorationConstant?: number;
}

/**
 * Serialised tree index stored in FileStore.
 */
interface TreeIndex {
  /** ID of the root node (if one exists). */
  rootId: string | null;

  /** All node IDs currently in the tree. */
  nodeIds: string[];

  /** Unix-epoch millisecond timestamp of last save. */
  savedAt: number;
}

// ---------------------------------------------------------------------------
// ActionTree
// ---------------------------------------------------------------------------

/**
 * Manages an in-memory action history tree backed by FileStore persistence.
 *
 * Usage:
 * 1. `await tree.load()` — hydrate from disk (or start fresh).
 * 2. `tree.addNode(...)` / `tree.recordOutcome(...)` during work.
 * 3. `tree.prune()` to trim low-value branches.
 * 4. `await tree.save()` to persist.
 */
export class ActionTree {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly pruneThreshold: number;
  private readonly maxDepth: number;
  private readonly explorationConstant: number;

  /** In-memory node map keyed by node ID. */
  private nodes: Map<string, ActionTreeNode> = new Map();

  /** Root node ID, or `null` if the tree is empty. */
  private rootId: string | null = null;

  constructor(opts: ActionTreeOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:action-tree' });
    this.pruneThreshold = opts.pruneThreshold ?? 0.1;
    this.maxDepth = opts.maxDepth ?? 10;
    this.explorationConstant = opts.explorationConstant ?? Math.SQRT2;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Load the tree from FileStore. If no persisted tree exists, start empty.
   */
  async load(): Promise<void> {
    this.nodes.clear();
    this.rootId = null;

    const index = await this.fileStore.read<TreeIndex>(COLLECTION, TREE_INDEX_ID);
    if (!index || index.nodeIds.length === 0) {
      this.logger.debug('No existing action tree found — starting fresh');
      return;
    }

    let loaded = 0;
    for (const nodeId of index.nodeIds) {
      const node = await this.fileStore.read<ActionTreeNode>(COLLECTION, nodeId);
      if (node) {
        this.nodes.set(node.id, node);
        loaded++;
      }
    }

    this.rootId = index.rootId;
    this.logger.info('Action tree loaded', { nodeCount: loaded, rootId: this.rootId });
  }

  /**
   * Persist the full tree to FileStore (index + individual nodes).
   */
  async save(): Promise<void> {
    const nodeIds = [...this.nodes.keys()];

    // Write index
    const index: TreeIndex = {
      rootId: this.rootId,
      nodeIds,
      savedAt: Date.now(),
    };
    await this.fileStore.write(COLLECTION, TREE_INDEX_ID, index);

    // Write each node
    for (const node of this.nodes.values()) {
      await this.fileStore.write(COLLECTION, node.id, node);
    }

    this.logger.info('Action tree saved', { nodeCount: nodeIds.length });
  }

  // -----------------------------------------------------------------------
  // Node operations
  // -----------------------------------------------------------------------

  /**
   * Add a new node to the tree.
   *
   * If `parentId` is `null`, the node becomes the root (replacing any
   * existing root). If the parent is at `maxDepth`, the node is rejected.
   *
   * @param parentId         - Parent node ID, or `null` to create a root.
   * @param stateDescription - Description of the state before the action.
   * @param action           - The action taken.
   * @param metadata         - Optional metadata to attach.
   * @returns The newly created node, or `null` if depth limit is exceeded.
   */
  addNode(
    parentId: string | null,
    stateDescription: string,
    action: string,
    metadata?: Record<string, unknown>,
  ): ActionTreeNode | null {
    const now = Date.now();
    let depth = 0;

    if (parentId !== null) {
      const parent = this.nodes.get(parentId);
      if (!parent) {
        this.logger.warn('addNode: parent not found', { parentId });
        return null;
      }
      depth = parent.depth + 1;
      if (depth > this.maxDepth) {
        this.logger.debug('addNode: max depth exceeded', { parentId, depth, maxDepth: this.maxDepth });
        return null;
      }
    }

    const node: ActionTreeNode = {
      id: generateId(),
      parentId,
      stateDescription,
      action,
      totalValue: 0,
      visitCount: 0,
      avgValue: 0,
      children: [],
      depth,
      createdAt: now,
      updatedAt: now,
      metadata,
    };

    this.nodes.set(node.id, node);

    if (parentId === null) {
      this.rootId = node.id;
    } else {
      const parent = this.nodes.get(parentId)!;
      parent.children.push(node.id);
      parent.updatedAt = now;
    }

    this.logger.debug('Node added', { nodeId: node.id, parentId, action, depth });
    return node;
  }

  /**
   * Record an outcome value for a node and propagate the update up to
   * all ancestors.
   *
   * @param nodeId - The node where the outcome was observed.
   * @param value  - Scalar outcome value (typically in `[0, 1]`).
   */
  recordOutcome(nodeId: string, value: number): void {
    let current: ActionTreeNode | undefined = this.nodes.get(nodeId);
    if (!current) {
      this.logger.warn('recordOutcome: node not found', { nodeId });
      return;
    }

    const now = Date.now();

    // Walk up to root, updating stats along the way.
    while (current) {
      current.visitCount += 1;
      current.totalValue += value;
      current.avgValue = current.totalValue / current.visitCount;
      current.updatedAt = now;

      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }

    this.logger.debug('Outcome recorded and propagated', { nodeId, value });
  }

  /**
   * Get the node with the given ID, or `null` if not found.
   */
  getNode(nodeId: string): ActionTreeNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  /**
   * Get the root node, or `null` if the tree is empty.
   */
  getRoot(): ActionTreeNode | null {
    return this.rootId ? this.nodes.get(this.rootId) ?? null : null;
  }

  // -----------------------------------------------------------------------
  // UCB1-informed ranking
  // -----------------------------------------------------------------------

  /**
   * Compute the UCB1 score for a child node.
   *
   * UCB1 = avgValue + c * sqrt(ln(parentVisits) / childVisits)
   *
   * Unvisited children receive `Infinity` to ensure they are explored.
   */
  private ucb1Score(child: ActionTreeNode, parentVisitCount: number): number {
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
   * Get the children of a node, ranked by UCB1 score (highest first).
   *
   * @param nodeId - The parent node ID.
   * @returns Array of `{ node, ucb1 }` sorted descending by UCB1 score.
   */
  getChildren(nodeId: string): Array<{ node: ActionTreeNode; ucb1: number }> {
    const parent = this.nodes.get(nodeId);
    if (!parent) {
      return [];
    }

    const parentVisits = parent.visitCount;
    const ranked: Array<{ node: ActionTreeNode; ucb1: number }> = [];

    for (const childId of parent.children) {
      const child = this.nodes.get(childId);
      if (child) {
        ranked.push({ node: child, ucb1: this.ucb1Score(child, parentVisits) });
      }
    }

    ranked.sort((a, b) => b.ucb1 - a.ucb1);
    return ranked;
  }

  /**
   * Get the best action sequence from a given node down to a leaf,
   * selecting the highest-UCB1 child at each level.
   *
   * @param fromNodeId - Starting node ID. Defaults to root.
   * @returns Ordered array of nodes representing the best path.
   */
  getBestPath(fromNodeId?: string): ActionTreeNode[] {
    const startId = fromNodeId ?? this.rootId;
    if (!startId) {
      return [];
    }

    const start = this.nodes.get(startId);
    if (!start) {
      return [];
    }

    const path: ActionTreeNode[] = [start];
    let current = start;

    while (current.children.length > 0) {
      const children = this.getChildren(current.id);
      if (children.length === 0) {
        break;
      }
      const best = children[0].node;
      path.push(best);
      current = best;
    }

    return path;
  }

  // -----------------------------------------------------------------------
  // Pruning
  // -----------------------------------------------------------------------

  /**
   * Remove low-value branches from the tree.
   *
   * A branch is pruned when:
   * 1. The node has been visited at least twice (enough data to judge).
   * 2. Its average value is below `pruneThreshold`.
   * 3. It is not the root node.
   *
   * Pruning is bottom-up: children are evaluated before parents so that
   * entire sub-trees are removed cleanly.
   *
   * @returns The number of nodes removed.
   */
  prune(): number {
    const toRemove = new Set<string>();

    // Collect candidate nodes sorted deepest-first.
    const allNodes = [...this.nodes.values()].sort((a, b) => b.depth - a.depth);

    for (const node of allNodes) {
      if (node.id === this.rootId) continue;
      if (node.visitCount < 2) continue;
      if (node.avgValue >= this.pruneThreshold) continue;

      // Mark this node and its entire sub-tree for removal.
      this.collectSubtree(node.id, toRemove);
    }

    // Actually remove the nodes.
    for (const nodeId of toRemove) {
      const node = this.nodes.get(nodeId);
      if (node && node.parentId) {
        const parent = this.nodes.get(node.parentId);
        if (parent) {
          parent.children = parent.children.filter((cid) => cid !== nodeId);
          parent.updatedAt = Date.now();
        }
      }
      this.nodes.delete(nodeId);
    }

    if (toRemove.size > 0) {
      this.logger.info('Pruned low-value branches', { removedCount: toRemove.size });
    }

    return toRemove.size;
  }

  /**
   * Recursively collect a node and all its descendants into the given set.
   */
  private collectSubtree(nodeId: string, out: Set<string>): void {
    if (out.has(nodeId)) return;
    out.add(nodeId);

    const node = this.nodes.get(nodeId);
    if (node) {
      for (const childId of node.children) {
        this.collectSubtree(childId, out);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Serialisation helpers
  // -----------------------------------------------------------------------

  /**
   * Get the full tree as a plain object suitable for serialisation.
   *
   * @returns Object containing the root ID and all nodes.
   */
  getTree(): { rootId: string | null; nodes: ActionTreeNode[] } {
    return {
      rootId: this.rootId,
      nodes: [...this.nodes.values()],
    };
  }

  /**
   * Get the total number of nodes in the tree.
   */
  get size(): number {
    return this.nodes.size;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Delete all persisted tree data from FileStore.
   */
  async clear(): Promise<void> {
    for (const nodeId of this.nodes.keys()) {
      await this.fileStore.delete(COLLECTION, nodeId);
    }
    await this.fileStore.delete(COLLECTION, TREE_INDEX_ID);

    this.nodes.clear();
    this.rootId = null;
    this.logger.info('Action tree cleared');
  }
}
