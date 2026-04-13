/**
 * APEX World Model — Action-Effect Causal Graph (Phase 17)
 *
 * Builds and maintains a directed graph of action types and their causal
 * relationships. Nodes represent action types with aggregated success
 * statistics; edges represent observed transitions between consecutive
 * actions, weighted by Bayesian-updated co-occurrence rates.
 *
 * The model supports:
 * - Ingesting episodes to learn action-effect relationships
 * - Extracting frequently observed causal chains
 * - Predicting plan success rates based on the learned graph
 * - Persistence via FileStore
 *
 * Pure computation — zero LLM calls.
 */

import { generateId } from '../types.js';
import type { Episode } from '../types.js';
import type { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FileStore collection for world-model data. */
const COLLECTION = 'world-model';

/** Default success rate for unknown action nodes. */
const DEFAULT_SUCCESS_RATE = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A node in the action-effect graph representing an action type.
 */
export interface ActionNode {
  /** Unique identifier for this node. */
  id: string;

  /** The action type this node represents (e.g. "read-file", "code-edit"). */
  actionType: string;

  /** Total number of times this action type has been observed. */
  occurrenceCount: number;

  /** Number of times this action type succeeded. */
  successCount: number;

  /** Success rate = successCount / occurrenceCount. */
  successRate: number;

  /** Unix-epoch millisecond timestamp of last observation. */
  lastSeen: number;
}

/**
 * A directed edge in the action-effect graph representing a causal transition.
 */
export interface CausalEdge {
  /** Unique identifier for this edge. */
  id: string;

  /** Action type of the source node. */
  sourceActionType: string;

  /** Action type of the target node. */
  targetActionType: string;

  /** Bayesian-updated weight = coOccurrenceCount / observationCount. */
  weight: number;

  /** Number of times this transition was observed. */
  observationCount: number;

  /** Number of times the target action succeeded after the source. */
  coOccurrenceCount: number;

  /** Unix-epoch millisecond timestamp of last observation. */
  lastSeen: number;
}

/**
 * A frequently observed causal chain of actions.
 */
export interface CausalChain {
  /** Unique identifier for this chain. */
  id: string;

  /** Ordered list of action nodes forming the chain. */
  steps: ActionNode[];

  /** How many times this chain (or sub-chain) was observed. */
  frequency: number;

  /** Average success rate across the chain's edges. */
  confidence: number;

  /** Length of the chain (number of steps). */
  length: number;
}

/**
 * Prediction for a single step in a plan.
 */
export interface StepPrediction {
  /** The action type for this step. */
  actionType: string;

  /** Predicted success rate for this step. */
  predictedSuccessRate: number;

  /** Risk level based on predicted success rate. */
  riskLevel: 'low' | 'medium' | 'high';

  /** Number of observations backing this prediction. */
  observations: number;
}

/**
 * Full prediction for a plan (sequence of action types).
 */
export interface PlanPrediction {
  /** Per-step predictions. */
  steps: StepPrediction[];

  /** Overall predicted success rate (product of step rates, adjusted by edges). */
  overallSuccessRate: number;

  /** Confidence in the prediction (based on observation density). */
  confidence: number;

  /** Steps flagged as high risk. */
  highRiskSteps: StepPrediction[];
}

/**
 * Configuration options for the {@link WorldModel}.
 */
export interface WorldModelOptions {
  /** FileStore instance for persistence. */
  fileStore: FileStore;

  /** Optional logger instance. */
  logger?: Logger;

  /** Minimum edge observations before the edge is considered reliable (default 2). */
  minEdgeObservations?: number;

  /** Minimum frequency for a chain to be retained (default 2). */
  chainMinFrequency?: number;

  /** Maximum chain length during extraction (default 5). */
  chainMaxLength?: number;
}

// ---------------------------------------------------------------------------
// WorldModel
// ---------------------------------------------------------------------------

/**
 * Action-effect causal graph that learns from episode history.
 */
export class WorldModel {
  private readonly fileStore: FileStore;
  private readonly logger?: Logger;
  private readonly minEdgeObservations: number;
  private readonly chainMinFrequency: number;
  private readonly chainMaxLength: number;

  /** Map from actionType to ActionNode. */
  private nodes: Map<string, ActionNode> = new Map();

  /** Map from "source->target" to CausalEdge. */
  private edges: Map<string, CausalEdge> = new Map();

  /** Extracted causal chains. */
  private chains: CausalChain[] = [];

  constructor(options: WorldModelOptions) {
    this.fileStore = options.fileStore;
    this.logger = options.logger;
    this.minEdgeObservations = options.minEdgeObservations ?? 2;
    this.chainMinFrequency = options.chainMinFrequency ?? 2;
    this.chainMaxLength = options.chainMaxLength ?? 5;
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  /**
   * Ingest a single episode into the world model.
   *
   * Creates/updates nodes for each action type and edges for consecutive
   * action pairs. Also creates a synthetic outcome node.
   */
  ingestEpisode(episode: Episode): void {
    const actions = episode.actions;
    if (actions.length === 0) return;

    this.logger?.debug('Ingesting episode', {
      episodeId: episode.id,
      actionCount: actions.length,
    });

    const now = Date.now();

    // Update nodes for each action
    for (const action of actions) {
      this.upsertNode(action.type, action.success, now);
    }

    // Create synthetic outcome node
    const outcomeType = episode.outcome.success
      ? '_outcome_success'
      : '_outcome_failure';
    this.upsertNode(outcomeType, episode.outcome.success, now);

    // Create edges between consecutive actions
    for (let i = 0; i < actions.length - 1; i++) {
      this.upsertEdge(
        actions[i].type,
        actions[i + 1].type,
        actions[i + 1].success,
        now,
      );
    }

    // Edge from last action to outcome
    if (actions.length > 0) {
      this.upsertEdge(
        actions[actions.length - 1].type,
        outcomeType,
        episode.outcome.success,
        now,
      );
    }
  }

  /**
   * Ingest multiple episodes and automatically extract chains.
   */
  ingestEpisodes(episodes: Episode[]): void {
    for (const episode of episodes) {
      this.ingestEpisode(episode);
    }
    this.extractChains();
  }

  // -------------------------------------------------------------------------
  // Graph queries
  // -------------------------------------------------------------------------

  /**
   * Get all action nodes in the graph.
   */
  getNodes(): ActionNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get a specific edge between two action types, or undefined if none exists.
   */
  getEdge(sourceActionType: string, targetActionType: string): CausalEdge | undefined {
    return this.edges.get(this.edgeKey(sourceActionType, targetActionType));
  }

  /**
   * Get all successors of an action type, sorted by edge weight descending.
   */
  getSuccessors(actionType: string): Array<{ node: ActionNode; edge: CausalEdge }> {
    const results: Array<{ node: ActionNode; edge: CausalEdge }> = [];

    for (const edge of this.edges.values()) {
      if (edge.sourceActionType === actionType) {
        const node = this.nodes.get(edge.targetActionType);
        if (node) {
          results.push({ node, edge });
        }
      }
    }

    results.sort((a, b) => b.edge.weight - a.edge.weight);
    return results;
  }

  /**
   * Get all predecessors of an action type, sorted by edge weight descending.
   */
  getPredecessors(actionType: string): Array<{ node: ActionNode; edge: CausalEdge }> {
    const results: Array<{ node: ActionNode; edge: CausalEdge }> = [];

    for (const edge of this.edges.values()) {
      if (edge.targetActionType === actionType) {
        const node = this.nodes.get(edge.sourceActionType);
        if (node) {
          results.push({ node, edge });
        }
      }
    }

    results.sort((a, b) => b.edge.weight - a.edge.weight);
    return results;
  }

  /**
   * Get all extracted causal chains.
   */
  getChains(): CausalChain[] {
    return [...this.chains];
  }

  /**
   * Get chains relevant to a keyword query.
   *
   * Scores chains by how many query keywords match action types in the chain,
   * weighted by the chain's confidence.
   */
  getRelevantChains(query: string): CausalChain[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return [];

    const scored: Array<{ chain: CausalChain; score: number }> = [];

    for (const chain of this.chains) {
      const actionTypes = chain.steps.map(s => s.actionType.toLowerCase());
      let matchCount = 0;
      for (const kw of keywords) {
        if (actionTypes.some(at => at.includes(kw))) {
          matchCount++;
        }
      }
      if (matchCount > 0) {
        scored.push({
          chain,
          score: (matchCount / keywords.length) * chain.confidence,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.chain);
  }

  // -------------------------------------------------------------------------
  // Chain extraction
  // -------------------------------------------------------------------------

  /**
   * Extract frequently observed causal chains from the graph.
   *
   * Strategy: enumerate all sub-paths of length 2..chainMaxLength starting
   * from each node, count how many times each sub-path appears by looking
   * at edge observation counts, and keep those meeting the minimum frequency.
   */
  extractChains(): CausalChain[] {
    this.chains = [];

    // Collect all unique sub-sequences from edges
    const chainCandidates = new Map<string, { steps: string[]; minObservations: number }>();

    // For each node, do a DFS to enumerate paths
    for (const startNode of this.nodes.values()) {
      // Skip synthetic outcome nodes as chain starts
      if (startNode.actionType.startsWith('_outcome_')) continue;

      this.enumeratePaths(
        startNode.actionType,
        [startNode.actionType],
        chainCandidates,
      );
    }

    // Filter by minimum frequency and create CausalChain objects
    for (const [key, candidate] of chainCandidates) {
      if (candidate.minObservations >= this.chainMinFrequency) {
        const steps = candidate.steps
          .map(at => this.nodes.get(at))
          .filter((n): n is ActionNode => n !== undefined);

        if (steps.length < 2) continue;

        // Compute confidence as average edge weight along the chain
        let totalWeight = 0;
        let edgeCount = 0;
        for (let i = 0; i < candidate.steps.length - 1; i++) {
          const edge = this.getEdge(candidate.steps[i], candidate.steps[i + 1]);
          if (edge) {
            totalWeight += edge.weight;
            edgeCount++;
          }
        }
        const confidence = edgeCount > 0 ? totalWeight / edgeCount : 0;

        this.chains.push({
          id: generateId(),
          steps,
          frequency: candidate.minObservations,
          confidence,
          length: steps.length,
        });
      }
    }

    // Sort chains by frequency * confidence descending
    this.chains.sort((a, b) =>
      (b.frequency * b.confidence) - (a.frequency * a.confidence),
    );

    this.logger?.debug('Extracted causal chains', {
      chainCount: this.chains.length,
    });

    return this.chains;
  }

  // -------------------------------------------------------------------------
  // Plan prediction
  // -------------------------------------------------------------------------

  /**
   * Predict the outcome of a plan (sequence of action types).
   */
  predictPlan(actionTypes: string[]): PlanPrediction {
    if (actionTypes.length === 0) {
      return {
        steps: [],
        overallSuccessRate: 0,
        confidence: 0,
        highRiskSteps: [],
      };
    }

    const steps: StepPrediction[] = [];
    let totalObservations = 0;

    for (let i = 0; i < actionTypes.length; i++) {
      const actionType = actionTypes[i];
      const node = this.nodes.get(actionType);

      let predictedSuccessRate: number;
      let observations: number;

      if (node) {
        predictedSuccessRate = node.successRate;
        observations = node.occurrenceCount;
      } else {
        // Unknown action — use default
        predictedSuccessRate = DEFAULT_SUCCESS_RATE;
        observations = 0;
      }

      // If there's a preceding action, incorporate edge weight
      if (i > 0) {
        const edge = this.getEdge(actionTypes[i - 1], actionType);
        if (edge && edge.observationCount >= this.minEdgeObservations) {
          // Blend node success rate with edge weight
          predictedSuccessRate = (predictedSuccessRate + edge.weight) / 2;
        }
      }

      const riskLevel = this.classifyRisk(predictedSuccessRate);

      steps.push({
        actionType,
        predictedSuccessRate,
        riskLevel,
        observations,
      });

      totalObservations += observations;
    }

    // Overall success rate: geometric-mean-like product of step rates
    let overallSuccessRate = 1;
    for (const step of steps) {
      overallSuccessRate *= step.predictedSuccessRate;
    }

    // Confidence based on observation density
    const avgObservations = totalObservations / actionTypes.length;
    const confidence = Math.min(1, avgObservations / 10);

    const highRiskSteps = steps.filter(s => s.riskLevel === 'high');

    return {
      steps,
      overallSuccessRate,
      confidence,
      highRiskSteps,
    };
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  /**
   * Get summary statistics about the world model.
   */
  getStats(): {
    nodeCount: number;
    edgeCount: number;
    chainCount: number;
    avgEdgeWeight: number;
    strongestEdge: { source: string; target: string; weight: number } | null;
  } {
    const edgeArray = Array.from(this.edges.values());
    const avgEdgeWeight =
      edgeArray.length > 0
        ? edgeArray.reduce((sum, e) => sum + e.weight, 0) / edgeArray.length
        : 0;

    let strongestEdge: { source: string; target: string; weight: number } | null = null;
    for (const edge of edgeArray) {
      if (!strongestEdge || edge.weight > strongestEdge.weight) {
        strongestEdge = {
          source: edge.sourceActionType,
          target: edge.targetActionType,
          weight: edge.weight,
        };
      }
    }

    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      chainCount: this.chains.length,
      avgEdgeWeight,
      strongestEdge,
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Save the world model state to FileStore.
   */
  async save(): Promise<void> {
    this.logger?.debug('Saving world model');

    await Promise.all([
      this.fileStore.write(COLLECTION, 'nodes', {
        nodes: Array.from(this.nodes.values()),
      }),
      this.fileStore.write(COLLECTION, 'edges', {
        edges: Array.from(this.edges.values()),
      }),
      this.fileStore.write(COLLECTION, 'chains', {
        chains: this.chains,
      }),
    ]);
  }

  /**
   * Load the world model state from FileStore.
   */
  async load(): Promise<void> {
    this.logger?.debug('Loading world model');

    const [nodesData, edgesData, chainsData] = await Promise.all([
      this.fileStore.read<{ nodes: ActionNode[] }>(COLLECTION, 'nodes'),
      this.fileStore.read<{ edges: CausalEdge[] }>(COLLECTION, 'edges'),
      this.fileStore.read<{ chains: CausalChain[] }>(COLLECTION, 'chains'),
    ]);

    if (nodesData?.nodes) {
      this.nodes = new Map();
      for (const node of nodesData.nodes) {
        this.nodes.set(node.actionType, node);
      }
    }

    if (edgesData?.edges) {
      this.edges = new Map();
      for (const edge of edgesData.edges) {
        this.edges.set(this.edgeKey(edge.sourceActionType, edge.targetActionType), edge);
      }
    }

    if (chainsData?.chains) {
      this.chains = chainsData.chains;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Create or update a node for the given action type.
   */
  private upsertNode(actionType: string, success: boolean, timestamp: number): void {
    const existing = this.nodes.get(actionType);

    if (existing) {
      existing.occurrenceCount++;
      if (success) existing.successCount++;
      existing.successRate = existing.successCount / existing.occurrenceCount;
      existing.lastSeen = timestamp;
    } else {
      this.nodes.set(actionType, {
        id: generateId(),
        actionType,
        occurrenceCount: 1,
        successCount: success ? 1 : 0,
        successRate: success ? 1.0 : 0.0,
        lastSeen: timestamp,
      });
    }
  }

  /**
   * Create or update an edge with Bayesian updating.
   *
   * Weight = coOccurrenceCount / observationCount (i.e. fraction of times
   * the target action succeeded following the source action).
   */
  private upsertEdge(
    sourceActionType: string,
    targetActionType: string,
    targetSucceeded: boolean,
    timestamp: number,
  ): void {
    const key = this.edgeKey(sourceActionType, targetActionType);
    const existing = this.edges.get(key);

    if (existing) {
      existing.observationCount++;
      if (targetSucceeded) existing.coOccurrenceCount++;
      existing.weight = existing.coOccurrenceCount / existing.observationCount;
      existing.lastSeen = timestamp;
    } else {
      this.edges.set(key, {
        id: generateId(),
        sourceActionType,
        targetActionType,
        weight: targetSucceeded ? 1.0 : 0.0,
        observationCount: 1,
        coOccurrenceCount: targetSucceeded ? 1 : 0,
        lastSeen: timestamp,
      });
    }
  }

  /**
   * Generate a map key for an edge.
   */
  private edgeKey(source: string, target: string): string {
    return `${source}->${target}`;
  }

  /**
   * Classify risk level based on predicted success rate.
   */
  private classifyRisk(successRate: number): 'low' | 'medium' | 'high' {
    if (successRate >= 0.7) return 'low';
    if (successRate >= 0.4) return 'medium';
    return 'high';
  }

  /**
   * Enumerate all paths from a starting node up to chainMaxLength,
   * recording the minimum observation count along each path.
   */
  private enumeratePaths(
    current: string,
    path: string[],
    results: Map<string, { steps: string[]; minObservations: number }>,
  ): void {
    if (path.length >= this.chainMaxLength) return;

    const successors = this.getSuccessors(current);

    for (const { node, edge } of successors) {
      // Skip synthetic outcome nodes in chain paths
      if (node.actionType.startsWith('_outcome_')) continue;
      // Avoid cycles
      if (path.includes(node.actionType)) continue;

      const newPath = [...path, node.actionType];
      const key = newPath.join('->');

      // Track the minimum observation count along the path
      const existing = results.get(key);
      const minObs = Math.min(
        existing?.minObservations ?? edge.observationCount,
        edge.observationCount,
      );

      results.set(key, {
        steps: newPath,
        minObservations: minObs,
      });

      // Continue DFS
      this.enumeratePaths(node.actionType, newPath, results);
    }
  }
}
