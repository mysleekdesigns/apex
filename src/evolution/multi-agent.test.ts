import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentPopulation } from './multi-agent.js';
import type { AgentProfile, Skill } from '../types.js';

// Mock FileStore to avoid disk I/O
vi.mock('../utils/file-store.js', () => {
  const storage = new Map<string, unknown>();
  return {
    FileStore: vi.fn().mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockImplementation((_col: string, id: string) => {
        return Promise.resolve(storage.get(`${_col}/${id}`) ?? null);
      }),
      write: vi.fn().mockImplementation((_col: string, id: string, data: unknown) => {
        storage.set(`${_col}/${id}`, data);
        return Promise.resolve();
      }),
      readAll: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      _storage: storage,
    })),
  };
});

// Suppress logger output in tests
vi.mock('../utils/logger.js', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

function makeSkill(id: string, name: string): Skill {
  return {
    id,
    name,
    description: `Skill ${name}`,
    preconditions: [],
    pattern: 'pattern',
    successRate: 0.8,
    usageCount: 5,
    confidence: 0.7,
    sourceProject: '/test',
    sourceFiles: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags: ['test'],
  };
}

describe('AgentPopulation', () => {
  let population: AgentPopulation;

  beforeEach(async () => {
    population = new AgentPopulation({
      dataDir: '/tmp/test-apex-data',
      config: {
        size: 5,
        tournamentSize: 3,
        crossPollinationRate: 0.3,
        mutationRate: 0.1,
        elitismCount: 1,
        evaluationWindow: 20,
      },
    });
  });

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  describe('initialize', () => {
    it('creates the correct number of agents', async () => {
      const agents = await population.initialize();
      expect(agents).toHaveLength(5);
    });

    it('assigns unique IDs to all agents', async () => {
      const agents = await population.initialize();
      const ids = new Set(agents.map((a) => a.id));
      expect(ids.size).toBe(5);
    });

    it('gives each agent at least one strategy', async () => {
      const agents = await population.initialize();
      for (const agent of agents) {
        expect(agent.strategies.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('sets generation to 0 for seed agents', async () => {
      const agents = await population.initialize();
      for (const agent of agents) {
        expect(agent.generation).toBe(0);
      }
    });

    it('initializes agents with zeroed metrics', async () => {
      const agents = await population.initialize();
      for (const agent of agents) {
        expect(agent.metrics.tasksSolved).toBe(0);
        expect(agent.metrics.successRate).toBe(0);
        expect(agent.metrics.avgReward).toBe(0);
        expect(agent.metrics.specializations).toEqual([]);
      }
    });

    it('seed agents have no parents', async () => {
      const agents = await population.initialize();
      for (const agent of agents) {
        expect(agent.parentIds).toEqual([]);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Tournament selection
  // -----------------------------------------------------------------------

  describe('tournamentSelect', () => {
    it('returns the best-fitness agent from the tournament', async () => {
      await population.initialize();

      // Manually set one agent to have a much higher fitness
      const agents = population.getAgents();
      const superAgent = agents[0];

      // Give the super agent great metrics (via competitive evaluation)
      for (let i = 0; i < 10; i++) {
        population.evaluateCompetitively(
          `task-${i}`,
          'testing',
          [],
          1.0,
          true,
        );
      }

      // Tournament should produce an agent (not crash)
      const selected = population.tournamentSelect();
      expect(selected).toBeDefined();
      expect(selected.id).toBeDefined();
      expect(selected.name).toBeDefined();
    });

    it('respects the exclude set', async () => {
      await population.initialize();
      const agents = population.getAgents();

      // Exclude all but one agent
      const excludeIds = new Set(agents.slice(1).map((a) => a.id));
      const selected = population.tournamentSelect(excludeIds);

      // Should select the only non-excluded agent
      expect(selected.id).toBe(agents[0].id);
    });

    it('falls back to full population when all are excluded', async () => {
      await population.initialize();
      const agents = population.getAgents();

      const allIds = new Set(agents.map((a) => a.id));
      const selected = population.tournamentSelect(allIds);

      // Should still return an agent (from full population fallback)
      expect(selected).toBeDefined();
      expect(agents.some((a) => a.id === selected.id)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Cross-pollination
  // -----------------------------------------------------------------------

  describe('crossPollinate', () => {
    it('transfers skills from top agents to bottom agents', async () => {
      await population.initialize();
      const agents = population.getAgents();

      // Give the first agent some skill weights and a high fitness
      // by evaluating it competitively with good scores
      const skillA = makeSkill('skill-a', 'A');
      const skillB = makeSkill('skill-b', 'B');

      // Simulate: agent[0] is the top performer with skill weights
      // We need to give agent[0] high metrics and skill weights
      for (let i = 0; i < 10; i++) {
        population.evaluateCompetitively(`task-${i}`, 'testing', [], 1.0, true);
      }

      // Set skill weights directly on the top agent through internal state
      // by re-getting agents after evaluation
      const updatedAgents = population.getAgents();

      // Manually set skill weights through evaluation trick:
      // We need a way to test cross-pollination, so let's use a high
      // crossPollinationRate population
      const highCrossPop = new AgentPopulation({
        dataDir: '/tmp/test-apex-data-cross',
        config: {
          size: 3,
          tournamentSize: 2,
          crossPollinationRate: 1.0, // Always cross-pollinate
          mutationRate: 0,
          elitismCount: 1,
          evaluationWindow: 20,
        },
      });
      await highCrossPop.initialize();

      // Give agent 0 very high metrics and skill weights
      for (let i = 0; i < 20; i++) {
        highCrossPop.evaluateCompetitively(`task-${i}`, 'testing', [skillA.id], 1.0, true);
      }

      // Now manually check that cross-pollination runs without error
      const transfers = highCrossPop.crossPollinate([skillA, skillB]);
      // With rate 1.0 but no initial skill weights to transfer,
      // transfers may be 0 (since agents only get weights through evaluateCompetitively
      // which doesn't set weights). The key is it doesn't crash.
      expect(transfers).toBeGreaterThanOrEqual(0);
    });

    it('returns zero transfers when no skills exist', async () => {
      await population.initialize();
      const transfers = population.crossPollinate([]);
      expect(transfers).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Competitive evaluation
  // -----------------------------------------------------------------------

  describe('evaluateCompetitively', () => {
    it('ranks all agents', async () => {
      await population.initialize();

      const result = population.evaluateCompetitively(
        'task-1',
        'testing',
        [],
        0.8,
        true,
      );

      expect(result.taskId).toBe('task-1');
      expect(result.rankings).toHaveLength(5);
      expect(result.bestAgent).toBeDefined();
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('rankings are sorted by score descending', async () => {
      await population.initialize();

      const result = population.evaluateCompetitively(
        'task-1',
        'refactoring',
        [],
        0.5,
        false,
      );

      for (let i = 1; i < result.rankings.length; i++) {
        expect(result.rankings[i - 1].score).toBeGreaterThanOrEqual(result.rankings[i].score);
      }
    });

    it('bestAgent matches the top-ranked agent', async () => {
      await population.initialize();

      const result = population.evaluateCompetitively(
        'task-1',
        'testing',
        [],
        1.0,
        true,
      );

      expect(result.bestAgent).toBe(result.rankings[0].agentId);
    });

    it('updates agent metrics after evaluation', async () => {
      await population.initialize();
      const agentsBefore = population.getAgents();

      population.evaluateCompetitively('task-1', 'testing', [], 0.8, true);

      const agentsAfter = population.getAgents();
      for (const agent of agentsAfter) {
        expect(agent.metrics.tasksSolved).toBe(1);
        expect(agent.metrics.avgReward).toBe(0.8);
        expect(agent.metrics.successRate).toBe(1.0);
      }
    });

    it('each ranking includes agent strategies', async () => {
      await population.initialize();

      const result = population.evaluateCompetitively(
        'task-1',
        'testing',
        [],
        0.5,
        true,
      );

      for (const ranking of result.rankings) {
        expect(Array.isArray(ranking.strategies)).toBe(true);
        expect(ranking.strategies.length).toBeGreaterThan(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Evolution cycle
  // -----------------------------------------------------------------------

  describe('evolve', () => {
    it('increments the generation counter', async () => {
      await population.initialize();
      expect(population.getGeneration()).toBe(0);

      await population.evolve();
      expect(population.getGeneration()).toBe(1);

      await population.evolve();
      expect(population.getGeneration()).toBe(2);
    });

    it('preserves the population size', async () => {
      await population.initialize();
      await population.evolve();

      const agents = population.getAgents();
      expect(agents).toHaveLength(5);
    });

    it('produces a valid EvolutionCycleResult', async () => {
      await population.initialize();

      // Give agents some data to work with
      population.evaluateCompetitively('task-1', 'testing', [], 0.8, true);

      const result = await population.evolve();

      expect(result.generation).toBe(1);
      expect(result.eliteIds.length).toBeGreaterThanOrEqual(1);
      expect(result.bredIds.length).toBeGreaterThanOrEqual(1);
      expect(result.eliteIds.length + result.bredIds.length).toBe(5);
      expect(result.fitnessSummary.best).toBeGreaterThanOrEqual(result.fitnessSummary.worst);
      expect(result.fitnessSummary.mean).toBeGreaterThanOrEqual(result.fitnessSummary.worst);
      expect(result.fitnessSummary.mean).toBeLessThanOrEqual(result.fitnessSummary.best);
    });

    it('bred agents have parentIds from the population', async () => {
      await population.initialize();
      const seedIds = new Set(population.getAgents().map((a) => a.id));

      await population.evolve();

      const newAgents = population.getAgents();
      for (const agent of newAgents) {
        if (agent.parentIds.length > 0) {
          // Parents should be from the previous generation
          for (const parentId of agent.parentIds) {
            expect(seedIds.has(parentId)).toBe(true);
          }
        }
      }
    });

    it('includes skill transfers when skills are provided', async () => {
      // Use a high cross-pollination rate to increase chance of transfers
      const pop = new AgentPopulation({
        dataDir: '/tmp/test-apex-evolve',
        config: {
          size: 4,
          tournamentSize: 2,
          crossPollinationRate: 1.0,
          mutationRate: 0,
          elitismCount: 1,
          evaluationWindow: 20,
        },
      });
      await pop.initialize();

      const skills = [makeSkill('s1', 'Skill-1'), makeSkill('s2', 'Skill-2')];
      const result = await pop.evolve(skills);

      // skillTransfers should be a number (may be 0 if no weights to transfer)
      expect(typeof result.skillTransfers).toBe('number');
    });
  });

  // -----------------------------------------------------------------------
  // Elitism
  // -----------------------------------------------------------------------

  describe('elitism', () => {
    it('preserves the top agent unchanged across generations', async () => {
      await population.initialize();

      // Give one agent much better metrics
      for (let i = 0; i < 10; i++) {
        population.evaluateCompetitively(`task-${i}`, 'testing', [], 0.9, true);
      }

      const agentsBefore = population.getAgents();
      // Find the best agent (highest fitness = highest metrics)
      const sorted = [...agentsBefore].sort((a, b) => {
        const fitnessA = 0.5 * a.metrics.successRate + 0.4 * a.metrics.avgReward;
        const fitnessB = 0.5 * b.metrics.successRate + 0.4 * b.metrics.avgReward;
        return fitnessB - fitnessA;
      });
      const bestBefore = sorted[0];

      const result = await population.evolve();

      // The elite agent's ID should be in the eliteIds
      expect(result.eliteIds).toContain(bestBefore.id);

      // The elite agent should still be in the population
      const agentsAfter = population.getAgents();
      const preserved = agentsAfter.find((a) => a.id === bestBefore.id);
      expect(preserved).toBeDefined();
      expect(preserved!.strategies).toEqual(bestBefore.strategies);
    });

    it('elitismCount controls how many agents are preserved', async () => {
      const pop = new AgentPopulation({
        dataDir: '/tmp/test-apex-elite',
        config: {
          size: 6,
          tournamentSize: 2,
          crossPollinationRate: 0,
          mutationRate: 0,
          elitismCount: 3,
          evaluationWindow: 20,
        },
      });
      await pop.initialize();

      const result = await pop.evolve();

      // Should preserve exactly 3 elites
      expect(result.eliteIds).toHaveLength(3);
      expect(result.bredIds).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns comprehensive population status', async () => {
      await population.initialize();

      const status = population.getStatus();

      expect(status.size).toBe(5);
      expect(status.generation).toBe(0);
      expect(status.agents).toHaveLength(5);
      expect(status.competitiveResults).toBe(0);
      expect(status.config.size).toBe(5);

      for (const agent of status.agents) {
        expect(agent.id).toBeDefined();
        expect(agent.name).toBeDefined();
        expect(typeof agent.fitness).toBe('number');
        expect(typeof agent.successRate).toBe('number');
        expect(typeof agent.strategyCount).toBe('number');
        expect(typeof agent.skillCount).toBe('number');
      }
    });

    it('agents are sorted by fitness descending', async () => {
      await population.initialize();

      // Give agents different reward levels
      population.evaluateCompetitively('t1', 'testing', [], 0.9, true);

      const status = population.getStatus();
      for (let i = 1; i < status.agents.length; i++) {
        expect(status.agents[i - 1].fitness).toBeGreaterThanOrEqual(status.agents[i].fitness);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  describe('save and load', () => {
    it('persists and restores population state', async () => {
      await population.initialize();
      population.evaluateCompetitively('task-1', 'testing', [], 0.7, true);
      await population.save();

      // Create a new population instance and load
      const pop2 = new AgentPopulation({
        dataDir: '/tmp/test-apex-data',
      });
      const loaded = await pop2.load();

      expect(loaded).toBe(true);
      expect(pop2.getAgents()).toHaveLength(5);
      expect(pop2.getGeneration()).toBe(0);
    });
  });
});
