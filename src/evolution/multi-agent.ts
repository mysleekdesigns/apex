/**
 * Multi-Agent Co-evolution for APEX Evolution Engine
 *
 * Manages a population of virtual agent "profiles" that share a semantic
 * memory pool but maintain individual skill libraries and strategy preferences.
 *
 * Key mechanisms:
 * - Tournament selection for breeding (strategy combination)
 * - Cross-pollination of skills from top performers to lower performers
 * - Competitive evaluation to track which agent profiles perform best
 * - Elitism to preserve proven configurations across generations
 *
 * This is a DATA INFRASTRUCTURE module — zero LLM calls. All evolution
 * logic is pure algorithmic computation over agent profiles and scores.
 */

import type {
  AgentProfile,
  PopulationConfig,
  CompetitiveResult,
  Skill,
} from '../types.js';
import { generateId } from '../types.js';
import { Logger } from '../utils/logger.js';
import { FileStore } from '../utils/file-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration options for the {@link AgentPopulation}.
 */
export interface AgentPopulationOptions {
  /** Base directory for persisting population state (typically the .apex-data dir). */
  dataDir: string;

  /** Partial population config overrides — missing fields use defaults. */
  config?: Partial<PopulationConfig>;

  /** Logger instance for debug output. */
  logger?: Logger;
}

/**
 * Summary of an evolution cycle's results.
 */
export interface EvolutionCycleResult {
  /** The generation number after this cycle. */
  generation: number;

  /** IDs of agents preserved via elitism. */
  eliteIds: string[];

  /** IDs of newly bred agents. */
  bredIds: string[];

  /** Number of skill transfers performed during cross-pollination. */
  skillTransfers: number;

  /** Number of strategy mutations applied. */
  mutations: number;

  /** Population fitness summary after the cycle. */
  fitnessSummary: {
    best: number;
    worst: number;
    mean: number;
  };
}

/**
 * A snapshot of population status for display.
 */
export interface PopulationStatus {
  /** Total number of agents. */
  size: number;

  /** Current generation number. */
  generation: number;

  /** Per-agent summary. */
  agents: Array<{
    id: string;
    name: string;
    generation: number;
    fitness: number;
    successRate: number;
    specializations: string[];
    strategyCount: number;
    skillCount: number;
  }>;

  /** Number of competitive results recorded. */
  competitiveResults: number;

  /** Population configuration. */
  config: PopulationConfig;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FileStore collection name for population data. */
const POPULATION_COLLECTION = 'population';

/** FileStore document ID for the agent list. */
const AGENTS_DOC_ID = 'agents';

/** FileStore document ID for competitive results. */
const RESULTS_DOC_ID = 'competitive-results';

/** FileStore document ID for generation counter. */
const GENERATION_DOC_ID = 'generation';

/** Default population configuration. */
const DEFAULT_CONFIG: PopulationConfig = {
  size: 5,
  tournamentSize: 3,
  crossPollinationRate: 0.3,
  mutationRate: 0.1,
  elitismCount: 1,
  evaluationWindow: 20,
};

/** Strategy pool used for seeding and mutation. */
const STRATEGY_POOL = [
  'depth-first',
  'breadth-first',
  'divide-and-conquer',
  'incremental',
  'test-driven',
  'example-driven',
  'pattern-matching',
  'constraint-solving',
  'exploratory',
  'systematic',
];

/** Name components for generating agent names. */
const NAME_PREFIXES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa'];
const NAME_SUFFIXES = ['Prime', 'Nova', 'Core', 'Edge', 'Apex', 'Flux', 'Nexus', 'Pulse', 'Wave', 'Spark'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a number to the [0, 1] range.
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Pick a random element from an array.
 */
function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Pick `count` unique random elements from an array.
 */
function randomSample<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, arr.length));
}

/**
 * Generate a random agent name.
 */
function generateAgentName(): string {
  return `${randomPick(NAME_PREFIXES)}-${randomPick(NAME_SUFFIXES)}`;
}

/**
 * Merge partial config with defaults.
 */
function resolveConfig(partial?: Partial<PopulationConfig>): PopulationConfig {
  return {
    size: partial?.size ?? DEFAULT_CONFIG.size,
    tournamentSize: partial?.tournamentSize ?? DEFAULT_CONFIG.tournamentSize,
    crossPollinationRate: partial?.crossPollinationRate ?? DEFAULT_CONFIG.crossPollinationRate,
    mutationRate: partial?.mutationRate ?? DEFAULT_CONFIG.mutationRate,
    elitismCount: partial?.elitismCount ?? DEFAULT_CONFIG.elitismCount,
    evaluationWindow: partial?.evaluationWindow ?? DEFAULT_CONFIG.evaluationWindow,
  };
}

/**
 * Compute a fitness score for an agent from its metrics.
 *
 * Blends success rate and average reward with a small bonus for
 * having more solved tasks (experience).
 */
function computeFitness(agent: AgentProfile): number {
  const { successRate, avgReward, tasksSolved } = agent.metrics;
  const experienceBonus = clamp01(tasksSolved / 50) * 0.1;
  return clamp01(0.5 * successRate + 0.4 * avgReward + experienceBonus);
}

// ---------------------------------------------------------------------------
// AgentPopulation class
// ---------------------------------------------------------------------------

/**
 * Manages a population of virtual agent profiles for co-evolutionary learning.
 *
 * Agents compete on tasks, and after each evaluation round the population
 * evolves: top performers are preserved (elitism), their skills are offered
 * to weaker agents (cross-pollination), and new agents are bred from
 * tournament-selected parents (with optional strategy mutation).
 *
 * All computation is pure; file I/O is limited to {@link FileStore} calls
 * in `save()` and `load()`.
 */
export class AgentPopulation {
  private agents: AgentProfile[] = [];
  private competitiveResults: CompetitiveResult[] = [];
  private generation = 0;
  private readonly config: PopulationConfig;
  private readonly store: FileStore;
  private readonly logger: Logger;

  constructor(options: AgentPopulationOptions) {
    this.store = new FileStore(options.dataDir);
    this.config = resolveConfig(options.config);
    this.logger = options.logger ?? new Logger({ prefix: 'multi-agent' });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialize a new population with seed agents.
   *
   * Each seed agent gets a random subset of strategies from the strategy
   * pool and starts with zeroed metrics.
   *
   * @returns The newly created agent profiles.
   */
  async initialize(): Promise<AgentProfile[]> {
    const now = Date.now();
    this.agents = [];
    this.competitiveResults = [];
    this.generation = 0;

    for (let i = 0; i < this.config.size; i++) {
      const strategyCount = 2 + Math.floor(Math.random() * 3); // 2-4 strategies
      const agent: AgentProfile = {
        id: generateId(),
        name: generateAgentName(),
        strategies: randomSample(STRATEGY_POOL, strategyCount),
        skillWeights: {},
        metrics: {
          tasksSolved: 0,
          successRate: 0,
          avgReward: 0,
          specializations: [],
        },
        generation: 0,
        parentIds: [],
        createdAt: now,
        updatedAt: now,
      };
      this.agents.push(agent);
    }

    await this.save();

    this.logger.info('Population initialized', {
      size: this.agents.length,
      config: this.config,
    });

    return [...this.agents];
  }

  /**
   * Load population state from disk.
   *
   * @returns `true` if state was loaded, `false` if no persisted state exists.
   */
  async load(): Promise<boolean> {
    const agents = await this.store.read<AgentProfile[]>(POPULATION_COLLECTION, AGENTS_DOC_ID);
    const results = await this.store.read<CompetitiveResult[]>(POPULATION_COLLECTION, RESULTS_DOC_ID);
    const genData = await this.store.read<{ generation: number }>(POPULATION_COLLECTION, GENERATION_DOC_ID);

    if (!agents) {
      this.logger.debug('No persisted population found');
      return false;
    }

    this.agents = agents;
    this.competitiveResults = results ?? [];
    this.generation = genData?.generation ?? 0;

    this.logger.info('Population loaded', {
      size: this.agents.length,
      generation: this.generation,
      competitiveResults: this.competitiveResults.length,
    });

    return true;
  }

  /**
   * Persist population state to disk.
   */
  async save(): Promise<void> {
    await this.store.write(POPULATION_COLLECTION, AGENTS_DOC_ID, this.agents);
    await this.store.write(POPULATION_COLLECTION, RESULTS_DOC_ID, this.competitiveResults);
    await this.store.write(POPULATION_COLLECTION, GENERATION_DOC_ID, { generation: this.generation });

    this.logger.debug('Population saved', {
      size: this.agents.length,
      generation: this.generation,
    });
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** Return a copy of all agent profiles. */
  getAgents(): AgentProfile[] {
    return structuredClone(this.agents);
  }

  /** Return a specific agent by ID, or `null` if not found. */
  getAgent(agentId: string): AgentProfile | null {
    const agent = this.agents.find((a) => a.id === agentId);
    return agent ? structuredClone(agent) : null;
  }

  /** Return the current generation number. */
  getGeneration(): number {
    return this.generation;
  }

  /** Return the population configuration. */
  getConfig(): PopulationConfig {
    return { ...this.config };
  }

  /** Return all competitive results. */
  getCompetitiveResults(): CompetitiveResult[] {
    return structuredClone(this.competitiveResults);
  }

  // -----------------------------------------------------------------------
  // Competitive evaluation
  // -----------------------------------------------------------------------

  /**
   * Score multiple agents on a task and record the competitive result.
   *
   * Each agent is scored based on how well its skill set and strategies
   * match the task. The scoring is purely heuristic: agents with relevant
   * skill weights and strategies that match the task domain score higher.
   *
   * @param taskId      - Unique identifier for the task.
   * @param taskDomain  - The domain of the task (e.g. "testing", "refactoring").
   * @param skillIds    - IDs of skills relevant to this task.
   * @param taskReward  - The actual reward achieved on the task (used to update metrics).
   * @param taskSuccess - Whether the task was completed successfully.
   * @returns The competitive result with rankings.
   */
  evaluateCompetitively(
    taskId: string,
    taskDomain: string,
    skillIds: string[],
    taskReward: number,
    taskSuccess: boolean,
  ): CompetitiveResult {
    const rankings: Array<{ agentId: string; score: number; strategies: string[] }> = [];

    for (const agent of this.agents) {
      const score = this.scoreAgentForTask(agent, taskDomain, skillIds);
      rankings.push({
        agentId: agent.id,
        score,
        strategies: [...agent.strategies],
      });

      // Update agent metrics
      this.updateAgentMetrics(agent, taskReward, taskSuccess, taskDomain);
    }

    // Sort by score descending
    rankings.sort((a, b) => b.score - a.score);

    const result: CompetitiveResult = {
      taskId,
      rankings,
      bestAgent: rankings[0].agentId,
      timestamp: Date.now(),
    };

    this.competitiveResults.push(result);

    // Keep only recent results within the evaluation window
    const maxResults = this.config.evaluationWindow * this.agents.length;
    if (this.competitiveResults.length > maxResults) {
      this.competitiveResults = this.competitiveResults.slice(-maxResults);
    }

    this.logger.debug('Competitive evaluation complete', {
      taskId,
      bestAgent: result.bestAgent,
      topScore: rankings[0].score,
    });

    return result;
  }

  // -----------------------------------------------------------------------
  // Tournament selection
  // -----------------------------------------------------------------------

  /**
   * Select an agent using tournament selection.
   *
   * Randomly samples `tournamentSize` agents from the population and
   * returns the one with the highest fitness score.
   *
   * @param exclude - Optional set of agent IDs to exclude from selection.
   * @returns The selected agent profile.
   */
  tournamentSelect(exclude?: Set<string>): AgentProfile {
    const eligible = exclude
      ? this.agents.filter((a) => !exclude.has(a.id))
      : this.agents;

    if (eligible.length === 0) {
      // Fallback: select from full population
      const candidates = randomSample(this.agents, this.config.tournamentSize);
      return this.bestByFitness(candidates);
    }

    const tournamentSize = Math.min(this.config.tournamentSize, eligible.length);
    const candidates = randomSample(eligible, tournamentSize);
    return this.bestByFitness(candidates);
  }

  // -----------------------------------------------------------------------
  // Cross-pollination
  // -----------------------------------------------------------------------

  /**
   * Transfer skills from top-performing agents to lower-performing agents.
   *
   * For each non-elite agent, each skill weighted by a top agent has a
   * `crossPollinationRate` chance of being adopted (with a reduced weight).
   *
   * @param availableSkills - All skills that exist in the skill library.
   * @returns The number of skill transfers performed.
   */
  crossPollinate(availableSkills: Skill[]): number {
    const sorted = this.agentsByFitness();
    const topCount = Math.max(1, Math.floor(sorted.length / 3));
    const topAgents = sorted.slice(0, topCount);
    const bottomAgents = sorted.slice(topCount);

    let transfers = 0;
    const skillIdSet = new Set(availableSkills.map((s) => s.id));

    for (const recipient of bottomAgents) {
      for (const donor of topAgents) {
        for (const [skillId, weight] of Object.entries(donor.skillWeights)) {
          // Only transfer skills that actually exist
          if (!skillIdSet.has(skillId)) continue;

          // Skip if recipient already has a higher weight
          if ((recipient.skillWeights[skillId] ?? 0) >= weight) continue;

          if (Math.random() < this.config.crossPollinationRate) {
            // Adopt the skill with a discounted weight
            recipient.skillWeights[skillId] = clamp01(weight * 0.7);
            recipient.updatedAt = Date.now();
            transfers++;
          }
        }
      }
    }

    // Boost confidence of skills that appear across many agents
    for (const skill of availableSkills) {
      const agentsWithSkill = this.agents.filter(
        (a) => (a.skillWeights[skill.id] ?? 0) > 0.3,
      );
      if (agentsWithSkill.length >= Math.ceil(this.agents.length * 0.6)) {
        // Skill is broadly successful — boost all weights slightly
        for (const agent of this.agents) {
          if (agent.skillWeights[skill.id] !== undefined) {
            agent.skillWeights[skill.id] = clamp01(agent.skillWeights[skill.id] + 0.05);
          }
        }
      }
    }

    this.logger.debug('Cross-pollination complete', { transfers });
    return transfers;
  }

  // -----------------------------------------------------------------------
  // Evolution cycle
  // -----------------------------------------------------------------------

  /**
   * Run one full evolution cycle: evaluate fitness, select, breed, mutate.
   *
   * 1. Rank all agents by fitness.
   * 2. Preserve top `elitismCount` agents unchanged.
   * 3. Fill remaining slots by breeding from tournament-selected parents.
   * 4. Apply random strategy mutations to non-elite offspring.
   * 5. Optionally cross-pollinate skills.
   * 6. Increment generation counter.
   *
   * @param availableSkills - Current skill library for cross-pollination.
   * @returns A summary of the evolution cycle.
   */
  async evolve(availableSkills: Skill[] = []): Promise<EvolutionCycleResult> {
    const sorted = this.agentsByFitness();

    // Elitism: preserve top agents
    const eliteCount = Math.min(this.config.elitismCount, sorted.length);
    const elites = sorted.slice(0, eliteCount);
    const eliteIds = elites.map((a) => a.id);

    // Breed new agents to fill the remaining slots
    const newPopulation: AgentProfile[] = elites.map((a) => ({
      ...structuredClone(a),
      updatedAt: Date.now(),
    }));

    const bredIds: string[] = [];
    let mutations = 0;
    const slotsToFill = this.config.size - eliteCount;

    for (let i = 0; i < slotsToFill; i++) {
      const parent1 = this.tournamentSelect();
      const excludeSet = new Set([parent1.id]);
      const parent2 = this.tournamentSelect(excludeSet);

      const child = this.breed(parent1, parent2);

      // Apply mutations
      const mutationCount = this.mutate(child);
      mutations += mutationCount;

      newPopulation.push(child);
      bredIds.push(child.id);
    }

    this.agents = newPopulation;
    this.generation++;

    // Cross-pollinate skills
    const skillTransfers = this.crossPollinate(availableSkills);

    await this.save();

    const fitnesses = this.agents.map(computeFitness);
    const result: EvolutionCycleResult = {
      generation: this.generation,
      eliteIds,
      bredIds,
      skillTransfers,
      mutations,
      fitnessSummary: {
        best: Math.max(...fitnesses),
        worst: Math.min(...fitnesses),
        mean: fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length,
      },
    };

    this.logger.info('Evolution cycle complete', result);
    return result;
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  /**
   * Build a population status summary for display.
   */
  getStatus(): PopulationStatus {
    return {
      size: this.agents.length,
      generation: this.generation,
      agents: this.agentsByFitness().map((a) => ({
        id: a.id,
        name: a.name,
        generation: a.generation,
        fitness: Math.round(computeFitness(a) * 1000) / 1000,
        successRate: Math.round(a.metrics.successRate * 1000) / 1000,
        specializations: a.metrics.specializations,
        strategyCount: a.strategies.length,
        skillCount: Object.keys(a.skillWeights).length,
      })),
      competitiveResults: this.competitiveResults.length,
      config: { ...this.config },
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Score an agent's suitability for a given task.
   *
   * Considers:
   * - Strategy overlap with the task domain
   * - Skill weight coverage of required skills
   * - Historical success rate in this domain
   */
  private scoreAgentForTask(
    agent: AgentProfile,
    taskDomain: string,
    skillIds: string[],
  ): number {
    // Strategy relevance: does this agent's strategy set mention the domain?
    const domainLower = taskDomain.toLowerCase();
    const strategyRelevance = agent.strategies.some(
      (s) => s.toLowerCase().includes(domainLower) || domainLower.includes(s.toLowerCase()),
    )
      ? 0.3
      : 0;

    // Skill coverage: how many of the required skills does this agent weight?
    let skillScore = 0;
    if (skillIds.length > 0) {
      const totalWeight = skillIds.reduce(
        (sum, sid) => sum + (agent.skillWeights[sid] ?? 0),
        0,
      );
      skillScore = clamp01(totalWeight / skillIds.length) * 0.4;
    }

    // Historical performance
    const isSpecialist = agent.metrics.specializations.some(
      (s) => s.toLowerCase() === domainLower,
    );
    const historyScore = agent.metrics.successRate * 0.2 + (isSpecialist ? 0.1 : 0);

    return clamp01(strategyRelevance + skillScore + historyScore);
  }

  /**
   * Update an agent's performance metrics after a task evaluation.
   */
  private updateAgentMetrics(
    agent: AgentProfile,
    reward: number,
    success: boolean,
    domain: string,
  ): void {
    const prev = agent.metrics;
    const n = prev.tasksSolved;

    // Incremental mean update
    agent.metrics.tasksSolved = n + 1;
    agent.metrics.avgReward = (prev.avgReward * n + reward) / (n + 1);
    agent.metrics.successRate =
      (prev.successRate * n + (success ? 1 : 0)) / (n + 1);

    // Track domain specialization if success rate > 0.7 in this domain
    if (success && !prev.specializations.includes(domain)) {
      // Simple heuristic: add specialization after a success
      // (in practice, you'd track per-domain stats)
      const recentInDomain = this.competitiveResults
        .filter((r) => r.rankings.some((rank) => rank.agentId === agent.id))
        .slice(-5);

      if (recentInDomain.length >= 2) {
        agent.metrics.specializations.push(domain);
        // Keep specializations bounded
        if (agent.metrics.specializations.length > 5) {
          agent.metrics.specializations = agent.metrics.specializations.slice(-5);
        }
      }
    }

    agent.updatedAt = Date.now();
  }

  /**
   * Sort agents by fitness score (descending).
   */
  private agentsByFitness(): AgentProfile[] {
    return [...this.agents].sort((a, b) => computeFitness(b) - computeFitness(a));
  }

  /**
   * Return the best agent from a list, by fitness.
   */
  private bestByFitness(candidates: AgentProfile[]): AgentProfile {
    let best = candidates[0];
    let bestFitness = computeFitness(best);

    for (let i = 1; i < candidates.length; i++) {
      const f = computeFitness(candidates[i]);
      if (f > bestFitness) {
        best = candidates[i];
        bestFitness = f;
      }
    }

    return best;
  }

  /**
   * Breed a child agent from two parents.
   *
   * Strategies are combined: each parent contributes roughly half.
   * Skill weights are averaged from both parents.
   * The child starts with zeroed performance metrics.
   */
  private breed(parent1: AgentProfile, parent2: AgentProfile): AgentProfile {
    const now = Date.now();

    // Combine strategies: take ~half from each parent, deduplicate
    const strats1 = randomSample(parent1.strategies, Math.ceil(parent1.strategies.length / 2));
    const strats2 = randomSample(parent2.strategies, Math.ceil(parent2.strategies.length / 2));
    const combinedStrategies = [...new Set([...strats1, ...strats2])];

    // Average skill weights from both parents
    const allSkillIds = new Set([
      ...Object.keys(parent1.skillWeights),
      ...Object.keys(parent2.skillWeights),
    ]);
    const childWeights: Record<string, number> = {};
    for (const sid of allSkillIds) {
      const w1 = parent1.skillWeights[sid] ?? 0;
      const w2 = parent2.skillWeights[sid] ?? 0;
      childWeights[sid] = (w1 + w2) / 2;
    }

    return {
      id: generateId(),
      name: generateAgentName(),
      strategies: combinedStrategies,
      skillWeights: childWeights,
      metrics: {
        tasksSolved: 0,
        successRate: 0,
        avgReward: 0,
        specializations: [],
      },
      generation: this.generation + 1,
      parentIds: [parent1.id, parent2.id],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Apply random mutations to an agent's strategies.
   *
   * Each strategy has a `mutationRate` chance of being replaced with a
   * random strategy from the pool. There's also a small chance of adding
   * or removing a strategy.
   *
   * @returns The number of mutations applied.
   */
  private mutate(agent: AgentProfile): number {
    let mutations = 0;

    // Mutate existing strategies
    for (let i = 0; i < agent.strategies.length; i++) {
      if (Math.random() < this.config.mutationRate) {
        const replacement = randomPick(STRATEGY_POOL);
        if (!agent.strategies.includes(replacement)) {
          agent.strategies[i] = replacement;
          mutations++;
        }
      }
    }

    // Small chance to add a new strategy (if below max)
    if (agent.strategies.length < 5 && Math.random() < this.config.mutationRate * 0.5) {
      const newStrat = randomPick(STRATEGY_POOL);
      if (!agent.strategies.includes(newStrat)) {
        agent.strategies.push(newStrat);
        mutations++;
      }
    }

    // Small chance to remove a strategy (if above min)
    if (agent.strategies.length > 1 && Math.random() < this.config.mutationRate * 0.3) {
      const removeIdx = Math.floor(Math.random() * agent.strategies.length);
      agent.strategies.splice(removeIdx, 1);
      mutations++;
    }

    // Mutate skill weights slightly
    for (const skillId of Object.keys(agent.skillWeights)) {
      if (Math.random() < this.config.mutationRate) {
        const delta = (Math.random() - 0.5) * 0.2;
        agent.skillWeights[skillId] = clamp01(agent.skillWeights[skillId] + delta);
        mutations++;
      }
    }

    if (mutations > 0) {
      agent.updatedAt = Date.now();
    }

    return mutations;
  }
}
