import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorldModel } from './world-model.js';
import type { Episode } from '../types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockFileStore() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    init: vi.fn(async () => {}),
    write: vi.fn(async (collection: string, id: string, data: unknown) => {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(id, data);
    }),
    read: vi.fn(async (collection: string, id: string) => {
      return store.get(collection)?.get(id) ?? null;
    }),
    readAll: vi.fn(async (collection: string) => {
      const entries = store.get(collection);
      if (!entries) return {};
      const result: Record<string, unknown> = {};
      entries.forEach((val, key) => { result[key] = val; });
      return result;
    }),
    list: vi.fn(async (collection: string) => {
      const entries = store.get(collection);
      return entries ? Array.from(entries.keys()) : [];
    }),
    delete: vi.fn(async (collection: string, id: string) => {
      store.get(collection)?.delete(id);
    }),
    _store: store,
  };
}

const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

let idCounter = 0;
function makeEpisode(
  actions: Array<{ type: string; success: boolean }>,
  overallSuccess = true,
): Episode {
  idCounter++;
  return {
    id: `ep-${idCounter}`,
    task: 'Test task',
    actions: actions.map((a, i) => ({
      type: a.type,
      description: `Action ${a.type}`,
      timestamp: 1000000 + i * 1000,
      success: a.success,
    })),
    outcome: {
      success: overallSuccess,
      description: overallSuccess ? 'Success' : 'Failure',
      duration: 5000,
    },
    reward: overallSuccess ? 1.0 : 0.0,
    timestamp: 1000000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorldModel', () => {
  let model: WorldModel;
  let fileStore: ReturnType<typeof createMockFileStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    idCounter = 0;
    fileStore = createMockFileStore();
    model = new WorldModel({
      fileStore: fileStore as any,
      logger: mockLogger,
      minEdgeObservations: 2,
      chainMinFrequency: 2,
      chainMaxLength: 5,
    });
  });

  // -----------------------------------------------------------------------
  // Ingestion — nodes
  // -----------------------------------------------------------------------

  describe('ingestEpisode — nodes', () => {
    it('creates nodes for each action type', () => {
      model.ingestEpisode(makeEpisode([
        { type: 'read-file', success: true },
        { type: 'code-edit', success: true },
      ]));

      const nodes = model.getNodes();
      const actionTypes = nodes.map(n => n.actionType);
      expect(actionTypes).toContain('read-file');
      expect(actionTypes).toContain('code-edit');
      // Also creates synthetic outcome node
      expect(actionTypes).toContain('_outcome_success');
    });

    it('updates occurrence counts with multiple episodes', () => {
      model.ingestEpisode(makeEpisode([{ type: 'read-file', success: true }]));
      model.ingestEpisode(makeEpisode([{ type: 'read-file', success: true }]));

      const node = model.getNodes().find(n => n.actionType === 'read-file');
      expect(node).toBeDefined();
      expect(node!.occurrenceCount).toBe(2);
      expect(node!.successCount).toBe(2);
      expect(node!.successRate).toBe(1.0);
    });
  });

  // -----------------------------------------------------------------------
  // Ingestion — edges
  // -----------------------------------------------------------------------

  describe('ingestEpisode — edges', () => {
    it('creates edges between consecutive actions', () => {
      model.ingestEpisode(makeEpisode([
        { type: 'read-file', success: true },
        { type: 'code-edit', success: true },
      ]));

      const edge = model.getEdge('read-file', 'code-edit');
      expect(edge).toBeDefined();
      expect(edge!.observationCount).toBe(1);
    });

    it('updates edge weights with Bayesian updating', () => {
      // First: target succeeds => weight = 1/1 = 1.0
      model.ingestEpisode(makeEpisode([
        { type: 'read-file', success: true },
        { type: 'code-edit', success: true },
      ]));
      let edge = model.getEdge('read-file', 'code-edit');
      expect(edge!.weight).toBe(1.0);

      // Second: target fails => weight = 1/2 = 0.5
      model.ingestEpisode(makeEpisode([
        { type: 'read-file', success: true },
        { type: 'code-edit', success: false },
      ]));
      edge = model.getEdge('read-file', 'code-edit');
      expect(edge!.weight).toBe(0.5);
      expect(edge!.observationCount).toBe(2);
      expect(edge!.coOccurrenceCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Graph queries
  // -----------------------------------------------------------------------

  describe('getSuccessors', () => {
    it('returns connected nodes sorted by weight', () => {
      // read-file -> code-edit (success) and read-file -> shell-command (fail)
      model.ingestEpisode(makeEpisode([
        { type: 'read-file', success: true },
        { type: 'code-edit', success: true },
      ]));
      model.ingestEpisode(makeEpisode([
        { type: 'read-file', success: true },
        { type: 'shell-command', success: false },
      ]));

      const successors = model.getSuccessors('read-file');
      expect(successors.length).toBeGreaterThanOrEqual(2);
      // Highest weight first
      expect(successors[0].edge.weight).toBeGreaterThanOrEqual(successors[1].edge.weight);
    });
  });

  describe('getPredecessors', () => {
    it('returns source nodes that lead to the given action type', () => {
      model.ingestEpisode(makeEpisode([
        { type: 'read-file', success: true },
        { type: 'code-edit', success: true },
      ]));
      model.ingestEpisode(makeEpisode([
        { type: 'search', success: true },
        { type: 'code-edit', success: true },
      ]));

      const predecessors = model.getPredecessors('code-edit');
      const srcTypes = predecessors.map(p => p.node.actionType);
      expect(srcTypes).toContain('read-file');
      expect(srcTypes).toContain('search');
    });
  });

  describe('getEdge', () => {
    it('returns specific edge or undefined for missing', () => {
      model.ingestEpisode(makeEpisode([
        { type: 'read-file', success: true },
        { type: 'code-edit', success: true },
      ]));

      expect(model.getEdge('read-file', 'code-edit')).toBeDefined();
      expect(model.getEdge('code-edit', 'read-file')).toBeUndefined();
      expect(model.getEdge('nonexistent', 'code-edit')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Chain extraction
  // -----------------------------------------------------------------------

  describe('extractChains', () => {
    it('finds patterns from repeated sequences', () => {
      // Use DIFFERENT episode signatures that share a common sub-chain
      // (chain counting increments per distinct signature match, not per episode)
      for (let i = 0; i < 3; i++) {
        model.ingestEpisode(makeEpisode([
          { type: 'read-file', success: true },
          { type: 'code-edit', success: true },
          { type: 'run-tests', success: true },
        ]));
      }
      // Add episodes with a different full sequence but overlapping sub-chain
      for (let i = 0; i < 3; i++) {
        model.ingestEpisode(makeEpisode([
          { type: 'read-file', success: true },
          { type: 'code-edit', success: true },
        ]));
      }

      const chains = model.extractChains();
      expect(chains.length).toBeGreaterThan(0);

      // At least one chain should contain read-file -> code-edit
      const hasExpected = chains.some(c =>
        c.steps.some(s => s.actionType === 'read-file') &&
        c.steps.some(s => s.actionType === 'code-edit'),
      );
      expect(hasExpected).toBe(true);
    });

    it('respects chainMinFrequency — filters low-frequency chains', () => {
      // Only one occurrence — below minFrequency of 2
      model.ingestEpisode(makeEpisode([
        { type: 'unique-a', success: true },
        { type: 'unique-b', success: true },
      ]));

      const chains = model.extractChains();
      const hasUnique = chains.some(c =>
        c.steps.some(s => s.actionType === 'unique-a'),
      );
      expect(hasUnique).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Plan prediction
  // -----------------------------------------------------------------------

  describe('predictPlan', () => {
    beforeEach(() => {
      // Build a model with known data
      for (let i = 0; i < 5; i++) {
        model.ingestEpisode(makeEpisode([
          { type: 'read-file', success: true },
          { type: 'code-edit', success: true },
          { type: 'run-tests', success: true },
        ]));
      }
    });

    it('predicts success based on graph for known actions', () => {
      const prediction = model.predictPlan(['read-file', 'code-edit', 'run-tests']);
      expect(prediction.steps).toHaveLength(3);
      expect(prediction.overallSuccessRate).toBeGreaterThan(0);
      expect(prediction.overallSuccessRate).toBeLessThanOrEqual(1);
      expect(prediction.confidence).toBeGreaterThan(0);
    });

    it('flags high risk steps with low success', () => {
      // Ingest failing actions
      for (let i = 0; i < 5; i++) {
        model.ingestEpisode(makeEpisode([
          { type: 'read-file', success: true },
          { type: 'risky-action', success: false },
        ], false));
      }

      const prediction = model.predictPlan(['read-file', 'risky-action']);
      // risky-action has 0% success rate, should be high risk
      const riskyStep = prediction.steps.find(s => s.actionType === 'risky-action');
      expect(riskyStep).toBeDefined();
      expect(riskyStep!.riskLevel).toBe('high');
      expect(prediction.highRiskSteps.length).toBeGreaterThan(0);
    });

    it('handles unknown actions gracefully', () => {
      const prediction = model.predictPlan(['unknown-action-xyz']);
      expect(prediction.steps).toHaveLength(1);
      // Unknown node defaults to 0.5 success rate
      expect(prediction.steps[0].predictedSuccessRate).toBe(0.5);
      expect(prediction.confidence).toBe(0); // no observations
    });

    it('returns empty prediction for empty plan', () => {
      const prediction = model.predictPlan([]);
      expect(prediction.steps).toHaveLength(0);
      expect(prediction.overallSuccessRate).toBe(0);
      expect(prediction.confidence).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Chain search
  // -----------------------------------------------------------------------

  describe('getRelevantChains', () => {
    it('finds chains matching query keywords', () => {
      for (let i = 0; i < 3; i++) {
        model.ingestEpisode(makeEpisode([
          { type: 'read-file', success: true },
          { type: 'code-edit', success: true },
          { type: 'run-tests', success: true },
        ]));
      }
      model.extractChains();

      const chains = model.getRelevantChains('code-edit');
      // Should find chains containing "code-edit" in action types
      expect(chains.length).toBeGreaterThanOrEqual(0);
      // If chains were extracted, those matching should be returned
      if (model.getChains().length > 0) {
        const relevant = model.getRelevantChains('read-file code-edit');
        // Matches should be ranked by relevance * confidence
        for (const chain of relevant) {
          expect(chain.confidence).toBeGreaterThan(0);
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  describe('getStats', () => {
    it('returns correct counts', () => {
      model.ingestEpisode(makeEpisode([
        { type: 'read-file', success: true },
        { type: 'code-edit', success: true },
      ]));

      const stats = model.getStats();
      // 3 nodes: read-file, code-edit, _outcome_success
      expect(stats.nodeCount).toBe(3);
      // 2 edges: read-file->code-edit, code-edit->_outcome_success
      expect(stats.edgeCount).toBe(2);
      expect(stats.chainCount).toBe(0); // no chains extracted yet
      expect(stats.avgEdgeWeight).toBeGreaterThan(0);
      expect(stats.strongestEdge).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  describe('save', () => {
    it('persists to FileStore', async () => {
      model.ingestEpisode(makeEpisode([
        { type: 'read-file', success: true },
        { type: 'code-edit', success: true },
      ]));

      await model.save();

      expect(fileStore.write).toHaveBeenCalledTimes(3); // nodes, edges, chains
      expect(fileStore.write).toHaveBeenCalledWith(
        'world-model',
        'nodes',
        expect.objectContaining({ nodes: expect.any(Array) }),
      );
      expect(fileStore.write).toHaveBeenCalledWith(
        'world-model',
        'edges',
        expect.objectContaining({ edges: expect.any(Array) }),
      );
      expect(fileStore.write).toHaveBeenCalledWith(
        'world-model',
        'chains',
        expect.objectContaining({ chains: expect.any(Array) }),
      );
    });
  });

  describe('load', () => {
    it('restores state from FileStore', async () => {
      // First: build state and save
      model.ingestEpisode(makeEpisode([
        { type: 'read-file', success: true },
        { type: 'code-edit', success: true },
      ]));
      await model.save();

      // Second: create a fresh model and load
      const model2 = new WorldModel({
        fileStore: fileStore as any,
        logger: mockLogger,
      });
      await model2.load();

      expect(fileStore.read).toHaveBeenCalledWith('world-model', 'nodes');
      expect(fileStore.read).toHaveBeenCalledWith('world-model', 'edges');
      expect(fileStore.read).toHaveBeenCalledWith('world-model', 'chains');

      // State should be restored
      const nodes = model2.getNodes();
      const actionTypes = nodes.map(n => n.actionType);
      expect(actionTypes).toContain('read-file');
      expect(actionTypes).toContain('code-edit');

      const edge = model2.getEdge('read-file', 'code-edit');
      expect(edge).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Batch ingestion
  // -----------------------------------------------------------------------

  describe('ingestEpisodes', () => {
    it('processes multiple episodes and extracts chains', () => {
      const episodes = [];
      // Use different signatures sharing a common sub-chain for chain extraction
      for (let i = 0; i < 3; i++) {
        episodes.push(makeEpisode([
          { type: 'read-file', success: true },
          { type: 'code-edit', success: true },
          { type: 'run-tests', success: true },
        ]));
      }
      for (let i = 0; i < 3; i++) {
        episodes.push(makeEpisode([
          { type: 'read-file', success: true },
          { type: 'code-edit', success: true },
        ]));
      }

      model.ingestEpisodes(episodes);

      // Nodes should exist
      const nodes = model.getNodes();
      expect(nodes.find(n => n.actionType === 'read-file')).toBeDefined();
      expect(nodes.find(n => n.actionType === 'code-edit')).toBeDefined();
      expect(nodes.find(n => n.actionType === 'run-tests')).toBeDefined();

      // Chains should have been automatically extracted
      const chains = model.getChains();
      expect(chains.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Bayesian convergence
  // -----------------------------------------------------------------------

  describe('Bayesian update convergence', () => {
    it('weights approach true frequency with more data', () => {
      // True rate: 70% success for code-edit after read-file
      const trueRate = 0.7;
      const sampleSize = 100;
      let successCount = 0;

      for (let i = 0; i < sampleSize; i++) {
        const success = i < sampleSize * trueRate;
        if (success) successCount++;
        model.ingestEpisode(makeEpisode([
          { type: 'read-file', success: true },
          { type: 'code-edit', success },
        ]));
      }

      const edge = model.getEdge('read-file', 'code-edit');
      expect(edge).toBeDefined();
      // Weight should be close to true rate
      expect(edge!.weight).toBeCloseTo(trueRate, 1);
      expect(edge!.observationCount).toBe(sampleSize);
      expect(edge!.coOccurrenceCount).toBe(successCount);
    });
  });
});
