/**
 * APEX Tree Persistence, Pruning & Compaction
 *
 * Manages selective persistence of promising subtrees across sessions,
 * advanced pruning of confidently bad branches, compaction of similar
 * nodes, and tracking of tree growth metrics over time.
 *
 * Part of Phase 13: Enhanced MCTS Planning.
 */

import { generateId } from '../types.js';
import type { ActionTree, ActionTreeNode } from './action-tree.js';
import type { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FileStore collection for tree persistence data. */
const COLLECTION = 'tree-persistence';

/** FileStore document ID for the subtree index. */
const SUBTREE_INDEX_ID = 'subtree-index';

/** FileStore document ID for growth metrics. */
const METRICS_ID = 'tree-growth-metrics';

/** Maximum number of metric snapshots retained. */
const MAX_METRIC_SNAPSHOTS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A saved subtree that can be restored for recurring task types. */
export interface SavedSubtree {
  /** Unique ID for this saved subtree. */
  id: string;
  /** Task type this subtree is associated with (e.g., "refactoring", "testing"). */
  taskType: string;
  /** The root node of the subtree. */
  rootNodeId: string;
  /** All nodes in the subtree, keyed by ID. */
  nodes: Record<string, ActionTreeNode>;
  /** Average value across all nodes in the subtree. */
  avgValue: number;
  /** Total visits across all nodes. */
  totalVisits: number;
  /** When this subtree was saved. */
  savedAt: number;
  /** When this subtree was last restored. */
  lastRestoredAt?: number;
  /** Number of times this subtree has been restored. */
  restoreCount: number;
}

/** Metrics tracking tree growth over time. */
export interface TreeGrowthMetrics {
  /** Snapshots of tree state over time. */
  snapshots: Array<{
    timestamp: number;
    totalNodes: number;
    maxDepth: number;
    avgBreadth: number;
    avgValue: number;
    pruneCount: number;
    compactCount: number;
  }>;
  /** Last updated timestamp. */
  updatedAt: number;
}

/** Result of a compaction operation. */
export interface CompactionResult {
  /** Number of node groups that were merged. */
  mergedGroups: number;
  /** Total nodes removed via compaction. */
  nodesRemoved: number;
  /** Total nodes remaining after compaction. */
  nodesRemaining: number;
}

/** Configuration options for {@link TreePersistenceManager}. */
export interface TreePersistenceOptions {
  /** Shared file store for persistence. */
  fileStore: FileStore;
  /** Optional logger instance. */
  logger?: Logger;
  /** Minimum average value for a subtree to be saved. Default: 0.3 */
  saveThreshold?: number;
  /** Minimum visits for a subtree to be saved. Default: 5 */
  minVisitsToSave?: number;
  /** Maximum number of saved subtrees to keep. Default: 20 */
  maxSavedSubtrees?: number;
  /** Similarity threshold for compaction (Jaccard on action keywords). Default: 0.8 */
  compactionSimilarity?: number;
  /** Prune nodes with avgValue < this AND visits > pruneMinVisits. Default: 0.2 */
  pruneValueThreshold?: number;
  /** Minimum visits to confirm a node is confidently bad. Default: 5 */
  pruneMinVisits?: number;
}

/** Persisted index of saved subtree IDs, grouped by task type. */
interface SubtreeIndex {
  /** Map of taskType to array of subtree IDs. */
  byTaskType: Record<string, string[]>;
  /** All subtree IDs in insertion order. */
  allIds: string[];
  /** Last updated timestamp. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract lowercase keywords from a string by splitting on whitespace
 * and common punctuation, filtering out short tokens.
 */
function extractKeywords(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[\s,.\-_:;/\\()\[\]{}'"!?<>|=+*&#@~`]+/)
    .filter((t) => t.length >= 2);
  return new Set(tokens);
}

/**
 * Compute the Jaccard similarity between two sets.
 * Returns a value in [0, 1] where 1 means identical sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// TreePersistenceManager
// ---------------------------------------------------------------------------

/**
 * Manages persisting promising subtrees across sessions, advanced pruning,
 * tree compaction, and growth metrics tracking.
 */
export class TreePersistenceManager {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly saveThreshold: number;
  private readonly minVisitsToSave: number;
  private readonly maxSavedSubtrees: number;
  private readonly compactionSimilarity: number;
  private readonly pruneValueThreshold: number;
  private readonly pruneMinVisits: number;

  constructor(opts: TreePersistenceOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:tree-persistence' });
    this.saveThreshold = opts.saveThreshold ?? 0.3;
    this.minVisitsToSave = opts.minVisitsToSave ?? 5;
    this.maxSavedSubtrees = opts.maxSavedSubtrees ?? 20;
    this.compactionSimilarity = opts.compactionSimilarity ?? 0.8;
    this.pruneValueThreshold = opts.pruneValueThreshold ?? 0.2;
    this.pruneMinVisits = opts.pruneMinVisits ?? 5;
  }

  // -----------------------------------------------------------------------
  // Saving promising subtrees
  // -----------------------------------------------------------------------

  /**
   * Save promising subtrees from an ActionTree for a given task type.
   *
   * Walks the tree from root, identifying subtrees rooted at high-value
   * nodes (avgValue >= saveThreshold AND visitCount >= minVisitsToSave).
   * Skips children of already-qualifying nodes to avoid overlapping saves.
   *
   * @param tree     - The action tree to extract subtrees from.
   * @param taskType - The task type label to associate with saved subtrees.
   * @returns Count of subtrees saved.
   */
  async savePromisingSubtrees(
    tree: ActionTree,
    taskType: string,
  ): Promise<number> {
    const treeData = tree.getTree();
    if (!treeData.rootId || treeData.nodes.length === 0) {
      return 0;
    }

    const nodeMap = new Map(treeData.nodes.map((n) => [n.id, n]));
    const index = await this.loadIndex();
    const existingIds = index.byTaskType[taskType] ?? [];

    // Load existing subtrees for this task type to compare quality.
    const existingSubtrees: SavedSubtree[] = [];
    for (const sid of existingIds) {
      const st = await this.fileStore.read<SavedSubtree>(COLLECTION, `subtree-${sid}`);
      if (st) existingSubtrees.push(st);
    }

    // Walk tree, find qualifying roots. Skip descendants of qualifying nodes.
    const qualifyingRoots: ActionTreeNode[] = [];
    const qualifiedSet = new Set<string>();

    const visit = (nodeId: string): void => {
      const node = nodeMap.get(nodeId);
      if (!node) return;

      // Check if any ancestor already qualified — skip if so.
      if (node.parentId && qualifiedSet.has(node.parentId)) {
        qualifiedSet.add(node.id); // propagate "covered" status
        return;
      }

      if (
        node.avgValue >= this.saveThreshold &&
        node.visitCount >= this.minVisitsToSave
      ) {
        qualifyingRoots.push(node);
        qualifiedSet.add(node.id);
        // Don't recurse into children — they're part of this subtree.
        return;
      }

      // Recurse into children.
      for (const childId of node.children) {
        visit(childId);
      }
    };

    visit(treeData.rootId);

    let savedCount = 0;

    for (const rootNode of qualifyingRoots) {
      // Extract the full subtree rooted at this node.
      const subtreeNodes: Record<string, ActionTreeNode> = {};
      const collectDescendants = (nid: string): void => {
        const n = nodeMap.get(nid);
        if (!n) return;
        subtreeNodes[nid] = n;
        for (const cid of n.children) {
          collectDescendants(cid);
        }
      };
      collectDescendants(rootNode.id);

      const nodeList = Object.values(subtreeNodes);
      const avgValue =
        nodeList.length > 0
          ? nodeList.reduce((sum, n) => sum + n.avgValue, 0) / nodeList.length
          : 0;
      const totalVisits = nodeList.reduce((sum, n) => sum + n.visitCount, 0);

      // Only save if better than existing subtrees for this task type.
      const dominated = existingSubtrees.some((ex) => ex.avgValue >= avgValue);
      if (dominated && existingSubtrees.length > 0) {
        continue;
      }

      const subtree: SavedSubtree = {
        id: generateId(),
        taskType,
        rootNodeId: rootNode.id,
        nodes: subtreeNodes,
        avgValue,
        totalVisits,
        savedAt: Date.now(),
        restoreCount: 0,
      };

      await this.fileStore.write(COLLECTION, `subtree-${subtree.id}`, subtree);

      // Update index.
      if (!index.byTaskType[taskType]) {
        index.byTaskType[taskType] = [];
      }
      index.byTaskType[taskType].push(subtree.id);
      index.allIds.push(subtree.id);

      savedCount++;
      this.logger.info('Saved promising subtree', {
        subtreeId: subtree.id,
        taskType,
        nodeCount: nodeList.length,
        avgValue,
      });
    }

    if (savedCount > 0) {
      index.updatedAt = Date.now();
      await this.saveIndex(index);
    }

    return savedCount;
  }

  // -----------------------------------------------------------------------
  // Restoring subtrees
  // -----------------------------------------------------------------------

  /**
   * Restore saved subtrees into an ActionTree for a given task type.
   *
   * For each saved subtree, checks if the tree already has a node with
   * the same action at the same depth. If so, merges statistics. If not,
   * adds the subtree as new nodes under the most appropriate parent.
   *
   * @param tree     - The action tree to restore subtrees into.
   * @param taskType - The task type to filter saved subtrees by.
   * @returns Count of subtrees restored.
   */
  async restoreSubtrees(
    tree: ActionTree,
    taskType: string,
  ): Promise<number> {
    const index = await this.loadIndex();
    const subtreeIds = index.byTaskType[taskType] ?? [];

    if (subtreeIds.length === 0) {
      return 0;
    }

    let restoredCount = 0;

    for (const sid of subtreeIds) {
      const subtree = await this.fileStore.read<SavedSubtree>(
        COLLECTION,
        `subtree-${sid}`,
      );
      if (!subtree) continue;

      const savedNodes = Object.values(subtree.nodes);
      if (savedNodes.length === 0) continue;

      // Sort by depth so we process parents before children.
      savedNodes.sort((a, b) => a.depth - b.depth);

      const root = tree.getRoot();

      // Try to find a matching node (same action, same depth) for the
      // subtree root. If found, we merge. Otherwise add as new nodes.
      let matchFound = false;
      if (root) {
        const subtreeRoot = savedNodes[0];
        const existingMatch = this.findMatchingNode(
          tree,
          root,
          subtreeRoot.action,
          subtreeRoot.depth,
        );
        if (existingMatch) {
          // Merge: update visit count and total value via recordOutcome.
          // We approximate by recording the saved average as an outcome
          // once for each saved visit.
          // Simple merge: record a single outcome with the saved avg.
          if (subtreeRoot.visitCount > 0) {
            tree.recordOutcome(existingMatch.id, subtreeRoot.avgValue);
          }
          matchFound = true;
        }
      }

      if (!matchFound) {
        // Add the subtree root under the tree's root (or as a new root).
        const treeRoot = tree.getRoot();
        const parentId = treeRoot ? treeRoot.id : null;
        const subtreeRoot = savedNodes[0];

        // Map old IDs to new IDs for reparenting.
        const idMap = new Map<string, string>();

        const newRoot = tree.addNode(
          parentId,
          subtreeRoot.stateDescription,
          subtreeRoot.action,
          subtreeRoot.metadata,
        );
        if (newRoot) {
          idMap.set(subtreeRoot.id, newRoot.id);
          if (subtreeRoot.visitCount > 0) {
            tree.recordOutcome(newRoot.id, subtreeRoot.avgValue);
          }

          // Add descendants in depth order.
          for (let i = 1; i < savedNodes.length; i++) {
            const savedNode = savedNodes[i];
            const newParentId = savedNode.parentId
              ? idMap.get(savedNode.parentId)
              : null;
            if (!newParentId) continue;

            const newNode = tree.addNode(
              newParentId,
              savedNode.stateDescription,
              savedNode.action,
              savedNode.metadata,
            );
            if (newNode) {
              idMap.set(savedNode.id, newNode.id);
              if (savedNode.visitCount > 0) {
                tree.recordOutcome(newNode.id, savedNode.avgValue);
              }
            }
          }
        }
      }

      // Update restore metadata.
      subtree.lastRestoredAt = Date.now();
      subtree.restoreCount += 1;
      await this.fileStore.write(COLLECTION, `subtree-${sid}`, subtree);

      restoredCount++;
      this.logger.info('Restored subtree', {
        subtreeId: sid,
        taskType,
        nodeCount: savedNodes.length,
      });
    }

    return restoredCount;
  }

  // -----------------------------------------------------------------------
  // Listing
  // -----------------------------------------------------------------------

  /**
   * List all saved subtrees, optionally filtered by task type.
   *
   * @param taskType - If provided, only return subtrees for this task type.
   * @returns Array of saved subtrees.
   */
  async listSavedSubtrees(taskType?: string): Promise<SavedSubtree[]> {
    const index = await this.loadIndex();
    const ids = taskType
      ? index.byTaskType[taskType] ?? []
      : index.allIds;

    const subtrees: SavedSubtree[] = [];
    for (const sid of ids) {
      const st = await this.fileStore.read<SavedSubtree>(
        COLLECTION,
        `subtree-${sid}`,
      );
      if (st) subtrees.push(st);
    }

    return subtrees;
  }

  // -----------------------------------------------------------------------
  // Advanced pruning
  // -----------------------------------------------------------------------

  /**
   * Identify branches that are confidently bad.
   *
   * A branch is confidently bad when its avgValue is below
   * {@link pruneValueThreshold} (default 0.2) AND its visitCount exceeds
   * {@link pruneMinVisits} (default 5). This is more aggressive than the
   * ActionTree's built-in prune (threshold 0.1, minVisits 2).
   *
   * Walks the tree bottom-up, collecting entire subtrees rooted at
   * confidently bad nodes. Returns the count of nodes identified for
   * removal along with their IDs.
   *
   * Note: Since ActionTree does not expose a per-node delete API, this
   * method returns the IDs and count. The caller can use ActionTree's
   * own `prune()` method after adjusting thresholds, or a future
   * ActionTree enhancement can support per-node deletion.
   *
   * @param tree - The action tree to analyse.
   * @returns The number of nodes identified as confidently bad.
   */
  pruneConfidentlyBad(tree: ActionTree): number {
    const treeData = tree.getTree();
    if (!treeData.rootId || treeData.nodes.length === 0) {
      return 0;
    }

    const nodeMap = new Map(treeData.nodes.map((n) => [n.id, n]));
    const toRemove = new Set<string>();

    // Sort deepest-first for bottom-up traversal.
    const sorted = [...treeData.nodes].sort((a, b) => b.depth - a.depth);

    for (const node of sorted) {
      // Never prune the root.
      if (node.id === treeData.rootId) continue;
      // Already marked for removal via an ancestor.
      if (toRemove.has(node.id)) continue;

      if (
        node.avgValue < this.pruneValueThreshold &&
        node.visitCount > this.pruneMinVisits
      ) {
        // Collect this node and all its descendants.
        this.collectSubtreeIds(node.id, nodeMap, toRemove);
      }
    }

    if (toRemove.size > 0) {
      this.logger.info('Identified confidently bad branches', {
        nodeCount: toRemove.size,
        threshold: this.pruneValueThreshold,
        minVisits: this.pruneMinVisits,
      });
    }

    return toRemove.size;
  }

  // -----------------------------------------------------------------------
  // Tree compaction
  // -----------------------------------------------------------------------

  /**
   * Compact the tree by merging sibling nodes with similar actions.
   *
   * Two sibling nodes are considered "similar" if the Jaccard similarity
   * of their action keywords exceeds {@link compactionSimilarity}
   * (default 0.8). When merging, the node with the higher avgValue is
   * kept; the other's visitCount and totalValue are added to it, and its
   * children are reparented.
   *
   * Note: Like {@link pruneConfidentlyBad}, this operates on a snapshot
   * of tree data from `getTree()`. Since ActionTree does not expose
   * per-node mutation APIs (reparenting, deletion), this method returns
   * a {@link CompactionResult} describing what would be compacted. For
   * trees where the manager has direct node access (e.g. via mock or
   * enhanced ActionTree), it performs the merge via `recordOutcome`.
   *
   * @param tree - The action tree to compact.
   * @returns A {@link CompactionResult} with merge statistics.
   */
  compactTree(tree: ActionTree): CompactionResult {
    const treeData = tree.getTree();
    if (!treeData.rootId || treeData.nodes.length === 0) {
      return { mergedGroups: 0, nodesRemoved: 0, nodesRemaining: treeData.nodes.length };
    }

    const nodeMap = new Map(treeData.nodes.map((n) => [n.id, n]));

    // Find all non-leaf (internal) nodes.
    const internalNodes = treeData.nodes.filter((n) => n.children.length > 0);

    let mergedGroups = 0;
    let nodesRemoved = 0;
    const removedIds = new Set<string>();

    for (const parent of internalNodes) {
      const childIds = parent.children.filter((cid) => !removedIds.has(cid));
      if (childIds.length < 2) continue;

      // Precompute keyword sets for each child.
      const childKeywords = new Map<string, Set<string>>();
      for (const cid of childIds) {
        const child = nodeMap.get(cid);
        if (child) {
          childKeywords.set(cid, extractKeywords(child.action));
        }
      }

      // Compare all pairs of siblings.
      const merged = new Set<string>();
      for (let i = 0; i < childIds.length; i++) {
        if (merged.has(childIds[i])) continue;
        const kwA = childKeywords.get(childIds[i]);
        if (!kwA) continue;

        for (let j = i + 1; j < childIds.length; j++) {
          if (merged.has(childIds[j])) continue;
          const kwB = childKeywords.get(childIds[j]);
          if (!kwB) continue;

          const sim = jaccardSimilarity(kwA, kwB);
          if (sim >= this.compactionSimilarity) {
            const nodeA = nodeMap.get(childIds[i])!;
            const nodeB = nodeMap.get(childIds[j])!;

            // Keep the one with higher avgValue; absorb the other.
            const keeper = nodeA.avgValue >= nodeB.avgValue ? nodeA : nodeB;
            const absorbed = keeper === nodeA ? nodeB : nodeA;

            // Record the absorbed node's stats into the keeper.
            // Use recordOutcome if available to propagate properly.
            if (absorbed.visitCount > 0) {
              tree.recordOutcome(keeper.id, absorbed.avgValue);
            }

            merged.add(absorbed.id);
            removedIds.add(absorbed.id);
            mergedGroups++;
            nodesRemoved++;

            this.logger.debug('Compacted sibling nodes', {
              keeperId: keeper.id,
              absorbedId: absorbed.id,
              similarity: sim,
            });
          }
        }
      }
    }

    const nodesRemaining = treeData.nodes.length - nodesRemoved;

    if (mergedGroups > 0) {
      this.logger.info('Tree compaction complete', {
        mergedGroups,
        nodesRemoved,
        nodesRemaining,
      });
    }

    return { mergedGroups, nodesRemoved, nodesRemaining };
  }

  // -----------------------------------------------------------------------
  // Growth metrics
  // -----------------------------------------------------------------------

  /**
   * Record a growth metrics snapshot for the current tree state.
   *
   * Captures total nodes, max depth, average breadth (children per
   * internal node), average value, and prune/compact counts.
   * Retains the last 100 snapshots.
   *
   * @param tree         - The action tree to measure.
   * @param pruneCount   - Nodes pruned in the current period. Default: 0.
   * @param compactCount - Nodes compacted in the current period. Default: 0.
   */
  async recordMetricsSnapshot(
    tree: ActionTree,
    pruneCount = 0,
    compactCount = 0,
  ): Promise<void> {
    const treeData = tree.getTree();
    const nodes = treeData.nodes;

    let maxDepth = 0;
    let totalValue = 0;
    let internalNodeCount = 0;
    let totalChildren = 0;

    for (const node of nodes) {
      if (node.depth > maxDepth) maxDepth = node.depth;
      totalValue += node.avgValue;
      if (node.children.length > 0) {
        internalNodeCount++;
        totalChildren += node.children.length;
      }
    }

    const avgValue = nodes.length > 0 ? totalValue / nodes.length : 0;
    const avgBreadth = internalNodeCount > 0 ? totalChildren / internalNodeCount : 0;

    const metrics = await this.getMetrics();

    metrics.snapshots.push({
      timestamp: Date.now(),
      totalNodes: nodes.length,
      maxDepth,
      avgBreadth,
      avgValue,
      pruneCount,
      compactCount,
    });

    // Keep only the last MAX_METRIC_SNAPSHOTS snapshots.
    if (metrics.snapshots.length > MAX_METRIC_SNAPSHOTS) {
      metrics.snapshots = metrics.snapshots.slice(-MAX_METRIC_SNAPSHOTS);
    }

    metrics.updatedAt = Date.now();
    await this.fileStore.write(COLLECTION, METRICS_ID, metrics);

    this.logger.debug('Recorded metrics snapshot', {
      totalNodes: nodes.length,
      maxDepth,
      avgBreadth,
      avgValue,
    });
  }

  /**
   * Get tree growth metrics history.
   *
   * @returns The {@link TreeGrowthMetrics} containing all recorded snapshots.
   */
  async getMetrics(): Promise<TreeGrowthMetrics> {
    const existing = await this.fileStore.read<TreeGrowthMetrics>(
      COLLECTION,
      METRICS_ID,
    );
    return existing ?? { snapshots: [], updatedAt: 0 };
  }

  // -----------------------------------------------------------------------
  // Eviction
  // -----------------------------------------------------------------------

  /**
   * Remove the oldest saved subtrees if the total exceeds
   * {@link maxSavedSubtrees}.
   *
   * Subtrees are evicted in order of `savedAt` (oldest first).
   *
   * @returns The number of subtrees evicted.
   */
  async evictOldSubtrees(): Promise<number> {
    const index = await this.loadIndex();

    if (index.allIds.length <= this.maxSavedSubtrees) {
      return 0;
    }

    // Load all subtrees to sort by savedAt.
    const all: SavedSubtree[] = [];
    for (const sid of index.allIds) {
      const st = await this.fileStore.read<SavedSubtree>(
        COLLECTION,
        `subtree-${sid}`,
      );
      if (st) all.push(st);
    }

    // Sort by savedAt ascending (oldest first).
    all.sort((a, b) => a.savedAt - b.savedAt);

    const toEvict = all.length - this.maxSavedSubtrees;
    let evictedCount = 0;

    for (let i = 0; i < toEvict; i++) {
      const st = all[i];
      await this.fileStore.delete(COLLECTION, `subtree-${st.id}`);

      // Remove from index.
      const taskIds = index.byTaskType[st.taskType];
      if (taskIds) {
        index.byTaskType[st.taskType] = taskIds.filter((id) => id !== st.id);
        if (index.byTaskType[st.taskType].length === 0) {
          delete index.byTaskType[st.taskType];
        }
      }
      index.allIds = index.allIds.filter((id) => id !== st.id);

      evictedCount++;
    }

    if (evictedCount > 0) {
      index.updatedAt = Date.now();
      await this.saveIndex(index);
      this.logger.info('Evicted old subtrees', { evictedCount });
    }

    return evictedCount;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Clear all persistence data (saved subtrees, index, and metrics).
   */
  async clear(): Promise<void> {
    const index = await this.loadIndex();

    for (const sid of index.allIds) {
      await this.fileStore.delete(COLLECTION, `subtree-${sid}`);
    }

    await this.fileStore.delete(COLLECTION, SUBTREE_INDEX_ID);
    await this.fileStore.delete(COLLECTION, METRICS_ID);

    this.logger.info('Tree persistence data cleared');
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Load the subtree index from FileStore. */
  private async loadIndex(): Promise<SubtreeIndex> {
    const existing = await this.fileStore.read<SubtreeIndex>(
      COLLECTION,
      SUBTREE_INDEX_ID,
    );
    return existing ?? { byTaskType: {}, allIds: [], updatedAt: 0 };
  }

  /** Save the subtree index to FileStore. */
  private async saveIndex(index: SubtreeIndex): Promise<void> {
    await this.fileStore.write(COLLECTION, SUBTREE_INDEX_ID, index);
  }

  /**
   * Recursively collect a node and all its descendants into a set.
   */
  private collectSubtreeIds(
    nodeId: string,
    nodeMap: Map<string, ActionTreeNode>,
    out: Set<string>,
  ): void {
    if (out.has(nodeId)) return;
    out.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (node) {
      for (const childId of node.children) {
        this.collectSubtreeIds(childId, nodeMap, out);
      }
    }
  }

  /**
   * Find a node in the tree matching the given action and depth.
   * Performs a breadth-first search from the given start node.
   */
  private findMatchingNode(
    tree: ActionTree,
    start: ActionTreeNode,
    action: string,
    depth: number,
  ): ActionTreeNode | null {
    const queue: ActionTreeNode[] = [start];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.action === action && current.depth === depth) {
        return current;
      }

      // Only search deeper if we haven't passed the target depth.
      if (current.depth < depth) {
        const children = tree.getChildren(current.id);
        for (const child of children) {
          queue.push(child.node);
        }
      }
    }

    return null;
  }
}
