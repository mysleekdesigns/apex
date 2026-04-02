/**
 * Adaptive Architecture Search for APEX Evolution Engine (Phase 10, Feature 4)
 *
 * Meta-learning system that optimizes APEX's own hyperparameters and
 * configuration. Tracks performance under different configs, samples new
 * configs biased toward high-performing regions, and generates suggestions
 * for prompt improvements.
 *
 * Pure computation and data aggregation — no LLM calls, no external services.
 * Async methods are used only for disk I/O via FileStore.
 */

import type {
  AgentConfig,
  ArchitectureConfig,
  ArchitectureSearchState,
  ConfigPerformance,
  PromptSuggestion,
} from '../types.js';
import { generateId } from '../types.js';
import { Logger } from '../utils/logger.js';
import { FileStore } from '../utils/file-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mutation operation that can be applied to a config. */
export type MutationType =
  | 'toggle-subsystem'
  | 'adjust-reflection-frequency'
  | 'adjust-consolidation-frequency'
  | 'adjust-memory-capacity'
  | 'adjust-exploration-rate'
  | 'adjust-consolidation-threshold'
  | 'adjust-performance-window';

/** Description of a single mutation applied to create a new config. */
export interface MutationRecord {
  /** What kind of mutation was applied. */
  type: MutationType;

  /** Human-readable description of the change. */
  description: string;

  /** The parameter that was changed. */
  parameter: string;

  /** Value before mutation. */
  previousValue: unknown;

  /** Value after mutation. */
  newValue: unknown;
}

/** Result of applying a mutation to the current config. */
export interface MutationResult {
  /** The newly created config. */
  config: ArchitectureConfig;

  /** Description of the mutation that was applied. */
  mutation: MutationRecord;

  /** Whether the mutation was successfully applied. */
  applied: boolean;

  /** Reason if the mutation was not applied. */
  reason?: string;
}

/** Rollback suggestion when performance degrades. */
export interface RollbackSuggestion {
  /** Whether a rollback is recommended. */
  shouldRollback: boolean;

  /** The config to roll back to. */
  targetConfigId?: string;

  /** Score of the current config. */
  currentScore: number;

  /** Score of the suggested rollback target. */
  targetScore?: number;

  /** Human-readable reason for the suggestion. */
  reason: string;
}

/** Tool usage statistics for prompt suggestion generation. */
export interface ToolUsageStats {
  /** Tool name -> number of times called. */
  callCounts: Record<string, number>;

  /** Tool name -> success rate (0-1). */
  successRates: Record<string, number>;

  /** Total episodes observed. */
  totalEpisodes: number;
}

/** Configuration options for ArchitectureSearch. */
export interface ArchitectureSearchOptions {
  /** Base directory for persisting state (typically the .apex-data dir). */
  dataDir: string;

  /** Maximum number of configs to try. Default: 20. */
  searchBudget?: number;

  /** Number of episodes before checking for rollback. Default: 10. */
  rollbackWindow?: number;

  /** Mutation magnitude (0-1). Higher = bigger parameter changes. Default: 0.2. */
  mutationMagnitude?: number;

  /** Logger instance for debug output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default search budget (max configs to try). */
const DEFAULT_SEARCH_BUDGET = 20;

/** Default number of episodes before rollback check. */
const DEFAULT_ROLLBACK_WINDOW = 10;

/** Default mutation magnitude. */
const DEFAULT_MUTATION_MAGNITUDE = 0.2;

/** FileStore collection name. */
const ARCH_SEARCH_COLLECTION = 'architecture-search';

/** FileStore document ID for the search state. */
const ARCH_SEARCH_STATE_ID = 'state';

/** FileStore document ID for the config store. */
const ARCH_CONFIGS_COLLECTION = 'architecture-configs';

/** Weights for the composite performance score. */
const SCORE_WEIGHTS = {
  successRate: 0.35,
  avgReward: 0.25,
  memoryEfficiency: 0.15,
  recallQuality: 0.15,
  reflectionValue: 0.10,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a number to the [min, max] range.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Compute a composite performance score from individual metrics.
 * Returns a value in [0, 1].
 */
export function computeCompositeScore(metrics: ConfigPerformance['metrics']): number {
  return (
    SCORE_WEIGHTS.successRate * clamp(metrics.successRate, 0, 1) +
    SCORE_WEIGHTS.avgReward * clamp(metrics.avgReward, 0, 1) +
    SCORE_WEIGHTS.memoryEfficiency * clamp(metrics.memoryEfficiency, 0, 1) +
    SCORE_WEIGHTS.recallQuality * clamp(metrics.recallQuality, 0, 1) +
    SCORE_WEIGHTS.reflectionValue * clamp(metrics.reflectionValue, 0, 1)
  );
}

/**
 * Create a default AgentConfig.
 */
function defaultAgentConfig(): AgentConfig {
  return {
    memoryLimits: { working: 100, episodic: 500, semantic: 200 },
    explorationRate: 0.15,
    consolidationThreshold: 50,
    embeddingLevel: 'auto',
    snapshotRetention: 5,
    coldStartThreshold: 10,
  };
}

/**
 * Create a default ArchitectureConfig.
 */
function defaultArchitectureConfig(): ArchitectureConfig {
  return {
    id: generateId(),
    agentConfig: defaultAgentConfig(),
    subsystemFlags: {
      microReflection: true,
      mesoReflection: true,
      macroReflection: true,
      foresight: true,
      curriculum: true,
      crossProject: true,
    },
    reflectionFrequency: 3,
    consolidationFrequency: 5,
    performanceWindow: 10,
    generation: 0,
    createdAt: Date.now(),
  };
}

/**
 * Simple seeded pseudo-random number generator (xorshift32).
 * Used for deterministic testing. Falls back to Math.random() if no seed.
 */
function createRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;

  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffffffff);
  };
}

// ---------------------------------------------------------------------------
// ArchitectureSearch class
// ---------------------------------------------------------------------------

/**
 * Meta-learning system that optimizes APEX's own hyperparameters and
 * architecture configuration.
 *
 * Maintains a history of (config, performance) pairs, samples new configs
 * biased toward high-performing regions, detects performance degradation,
 * and generates prompt improvement suggestions.
 *
 * All computation is pure; file I/O is limited to {@link FileStore} calls
 * in `save()` and `load()`.
 */
export class ArchitectureSearch {
  private state: ArchitectureSearchState;
  private configs: Map<string, ArchitectureConfig> = new Map();
  private readonly store: FileStore;
  private readonly logger: Logger;
  private readonly searchBudget: number;
  private readonly rollbackWindow: number;
  private readonly mutationMagnitude: number;
  private rng: () => number;

  constructor(options: ArchitectureSearchOptions) {
    this.store = new FileStore(options.dataDir);
    this.logger = options.logger ?? new Logger({ prefix: 'arch-search' });
    this.searchBudget = options.searchBudget ?? DEFAULT_SEARCH_BUDGET;
    this.rollbackWindow = options.rollbackWindow ?? DEFAULT_ROLLBACK_WINDOW;
    this.mutationMagnitude = options.mutationMagnitude ?? DEFAULT_MUTATION_MAGNITUDE;
    this.rng = Math.random;

    // Initialize with default state
    const defaultConfig = defaultArchitectureConfig();
    this.configs.set(defaultConfig.id, defaultConfig);
    this.state = {
      currentConfigId: defaultConfig.id,
      configHistory: [],
      bestConfigId: defaultConfig.id,
      bestScore: 0,
      generation: 0,
      searchBudget: this.searchBudget,
      searchesRemaining: this.searchBudget,
    };
  }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  /**
   * Initialize the architecture search with a fresh default config.
   *
   * @returns The initial architecture config.
   */
  async initialize(): Promise<ArchitectureConfig> {
    const config = defaultArchitectureConfig();
    this.configs.set(config.id, config);

    this.state = {
      currentConfigId: config.id,
      configHistory: [],
      bestConfigId: config.id,
      bestScore: 0,
      generation: 0,
      searchBudget: this.searchBudget,
      searchesRemaining: this.searchBudget,
    };

    await this.save();
    this.logger.info('Architecture search initialized', { configId: config.id });
    return structuredClone(config);
  }

  // -----------------------------------------------------------------------
  // Config management
  // -----------------------------------------------------------------------

  /**
   * Get the current active architecture config.
   *
   * @returns A deep copy of the current config.
   */
  getCurrentConfig(): ArchitectureConfig {
    const config = this.configs.get(this.state.currentConfigId);
    if (!config) {
      throw new Error(`Current config ${this.state.currentConfigId} not found`);
    }
    return structuredClone(config);
  }

  /**
   * Get a config by ID.
   *
   * @param configId - The config ID to look up.
   * @returns The config, or null if not found.
   */
  getConfig(configId: string): ArchitectureConfig | null {
    const config = this.configs.get(configId);
    return config ? structuredClone(config) : null;
  }

  /**
   * Get the full search state.
   *
   * @returns A deep copy of the current search state.
   */
  getState(): ArchitectureSearchState {
    return structuredClone(this.state);
  }

  // -----------------------------------------------------------------------
  // Performance tracking
  // -----------------------------------------------------------------------

  /**
   * Record performance metrics for the current config.
   *
   * Computes a composite score and updates the best config if this one
   * outperforms the previous best.
   *
   * @param performance - Performance data to record.
   * @returns The composite score for this performance record.
   */
  recordPerformance(performance: ConfigPerformance): number {
    const score = computeCompositeScore(performance.metrics);

    this.state.configHistory.push({
      configId: performance.configId,
      performance,
    });

    // Update best if this is a new high score
    if (score > this.state.bestScore) {
      this.state.bestScore = score;
      this.state.bestConfigId = performance.configId;

      this.logger.info('New best config found', {
        configId: performance.configId,
        score,
        previousBest: this.state.bestScore,
      });
    }

    this.logger.debug('Performance recorded', {
      configId: performance.configId,
      score,
      episodeCount: performance.episodeCount,
    });

    return score;
  }

  /**
   * Get the performance history for a specific config.
   *
   * @param configId - The config to get history for.
   * @returns Array of performance records for this config.
   */
  getPerformanceHistory(configId: string): ConfigPerformance[] {
    return this.state.configHistory
      .filter((h) => h.configId === configId)
      .map((h) => structuredClone(h.performance));
  }

  /**
   * Get the average composite score for a config across all its performance records.
   *
   * @param configId - The config to compute average score for.
   * @returns The average score, or 0 if no records exist.
   */
  getAverageScore(configId: string): number {
    const records = this.state.configHistory.filter((h) => h.configId === configId);
    if (records.length === 0) return 0;

    const totalScore = records.reduce(
      (sum, r) => sum + computeCompositeScore(r.performance.metrics),
      0,
    );
    return totalScore / records.length;
  }

  // -----------------------------------------------------------------------
  // Mutation
  // -----------------------------------------------------------------------

  /**
   * Generate a mutated config from the current config.
   *
   * The mutation is randomly selected from the available mutation types,
   * and the magnitude is controlled by the {@link mutationMagnitude} option.
   *
   * @param mutationType - Optional specific mutation to apply. If omitted,
   *                       a random mutation is selected.
   * @param seed - Optional RNG seed for deterministic behavior.
   * @returns The mutation result including the new config and description.
   */
  mutate(mutationType?: MutationType, seed?: number): MutationResult {
    if (this.state.searchesRemaining <= 0) {
      return {
        config: this.getCurrentConfig(),
        mutation: {
          type: 'toggle-subsystem',
          description: 'Search budget exhausted',
          parameter: '',
          previousValue: null,
          newValue: null,
        },
        applied: false,
        reason: 'Search budget exhausted. No more mutations allowed.',
      };
    }

    const rng = seed !== undefined ? createRng(seed) : this.rng;
    const currentConfig = this.getCurrentConfig();

    // Select mutation type
    const allTypes: MutationType[] = [
      'toggle-subsystem',
      'adjust-reflection-frequency',
      'adjust-consolidation-frequency',
      'adjust-memory-capacity',
      'adjust-exploration-rate',
      'adjust-consolidation-threshold',
      'adjust-performance-window',
    ];
    const selectedType = mutationType ?? allTypes[Math.floor(rng() * allTypes.length)];

    // Apply mutation
    const newConfig: ArchitectureConfig = {
      ...structuredClone(currentConfig),
      id: generateId(),
      parentConfigId: currentConfig.id,
      generation: this.state.generation + 1,
      createdAt: Date.now(),
    };

    const mutation = this.applyMutation(newConfig, selectedType, rng);

    // Register new config
    this.configs.set(newConfig.id, newConfig);
    this.state.currentConfigId = newConfig.id;
    this.state.generation++;
    this.state.searchesRemaining--;

    this.logger.info('Config mutated', {
      type: selectedType,
      parentId: currentConfig.id,
      newId: newConfig.id,
      generation: this.state.generation,
      remaining: this.state.searchesRemaining,
    });

    return {
      config: structuredClone(newConfig),
      mutation,
      applied: true,
    };
  }

  /**
   * Apply a specific mutation to a config (in-place).
   *
   * @param config - The config to mutate.
   * @param type - The mutation type.
   * @param rng - Random number generator.
   * @returns A record describing the mutation.
   */
  private applyMutation(
    config: ArchitectureConfig,
    type: MutationType,
    rng: () => number,
  ): MutationRecord {
    const mag = this.mutationMagnitude;

    switch (type) {
      case 'toggle-subsystem': {
        const flags = config.subsystemFlags;
        const keys = Object.keys(flags) as Array<keyof typeof flags>;
        const key = keys[Math.floor(rng() * keys.length)];
        const prev = flags[key];
        flags[key] = !prev;
        return {
          type,
          description: `${prev ? 'Disabled' : 'Enabled'} ${key}`,
          parameter: `subsystemFlags.${key}`,
          previousValue: prev,
          newValue: flags[key],
        };
      }

      case 'adjust-reflection-frequency': {
        const prev = config.reflectionFrequency;
        const delta = Math.round((rng() * 2 - 1) * mag * 10);
        config.reflectionFrequency = clamp(prev + delta, 1, 50);
        return {
          type,
          description: `Adjusted reflection frequency from ${prev} to ${config.reflectionFrequency}`,
          parameter: 'reflectionFrequency',
          previousValue: prev,
          newValue: config.reflectionFrequency,
        };
      }

      case 'adjust-consolidation-frequency': {
        const prev = config.consolidationFrequency;
        const delta = Math.round((rng() * 2 - 1) * mag * 10);
        config.consolidationFrequency = clamp(prev + delta, 1, 50);
        return {
          type,
          description: `Adjusted consolidation frequency from ${prev} to ${config.consolidationFrequency}`,
          parameter: 'consolidationFrequency',
          previousValue: prev,
          newValue: config.consolidationFrequency,
        };
      }

      case 'adjust-memory-capacity': {
        const tiers = ['working', 'episodic', 'semantic'] as const;
        const tier = tiers[Math.floor(rng() * tiers.length)];
        const prev = config.agentConfig.memoryLimits[tier];
        const delta = Math.round((rng() * 2 - 1) * mag * prev);
        config.agentConfig.memoryLimits[tier] = clamp(prev + delta, 10, 10000);
        return {
          type,
          description: `Adjusted ${tier} memory capacity from ${prev} to ${config.agentConfig.memoryLimits[tier]}`,
          parameter: `agentConfig.memoryLimits.${tier}`,
          previousValue: prev,
          newValue: config.agentConfig.memoryLimits[tier],
        };
      }

      case 'adjust-exploration-rate': {
        const prev = config.agentConfig.explorationRate;
        const delta = (rng() * 2 - 1) * mag;
        config.agentConfig.explorationRate = clamp(prev + delta, 0.01, 0.99);
        return {
          type,
          description: `Adjusted exploration rate from ${prev.toFixed(3)} to ${config.agentConfig.explorationRate.toFixed(3)}`,
          parameter: 'agentConfig.explorationRate',
          previousValue: prev,
          newValue: config.agentConfig.explorationRate,
        };
      }

      case 'adjust-consolidation-threshold': {
        const prev = config.agentConfig.consolidationThreshold;
        const delta = Math.round((rng() * 2 - 1) * mag * prev);
        config.agentConfig.consolidationThreshold = clamp(prev + delta, 5, 500);
        return {
          type,
          description: `Adjusted consolidation threshold from ${prev} to ${config.agentConfig.consolidationThreshold}`,
          parameter: 'agentConfig.consolidationThreshold',
          previousValue: prev,
          newValue: config.agentConfig.consolidationThreshold,
        };
      }

      case 'adjust-performance-window': {
        const prev = config.performanceWindow;
        const delta = Math.round((rng() * 2 - 1) * mag * 10);
        config.performanceWindow = clamp(prev + delta, 3, 100);
        return {
          type,
          description: `Adjusted performance window from ${prev} to ${config.performanceWindow}`,
          parameter: 'performanceWindow',
          previousValue: prev,
          newValue: config.performanceWindow,
        };
      }
    }
  }

  // -----------------------------------------------------------------------
  // Bayesian-inspired sampling
  // -----------------------------------------------------------------------

  /**
   * Sample a new config biased toward high-performing regions.
   *
   * Uses a simple weighted sampling approach: configs with higher composite
   * scores are more likely to be used as the basis for the next mutation.
   * This is a lightweight approximation of Bayesian optimization.
   *
   * @param seed - Optional RNG seed for deterministic behavior.
   * @returns The sampled and mutated config.
   */
  sampleBiased(seed?: number): MutationResult {
    const rng = seed !== undefined ? createRng(seed) : this.rng;

    // If we have performance history, bias toward better-performing configs
    if (this.state.configHistory.length > 0) {
      const scored = this.state.configHistory.map((h) => ({
        configId: h.configId,
        score: computeCompositeScore(h.performance.metrics),
      }));

      // Softmax-like weighting: higher scores get exponentially more weight
      const maxScore = Math.max(...scored.map((s) => s.score));
      const weights = scored.map((s) => Math.exp(3 * (s.score - maxScore)));
      const totalWeight = weights.reduce((a, b) => a + b, 0);

      // Sample proportional to weights
      let r = rng() * totalWeight;
      let selectedIdx = 0;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          selectedIdx = i;
          break;
        }
      }

      // Set current config to the sampled one before mutating
      const selectedConfigId = scored[selectedIdx].configId;
      if (this.configs.has(selectedConfigId)) {
        this.state.currentConfigId = selectedConfigId;
      }
    }

    return this.mutate(undefined, seed);
  }

  // -----------------------------------------------------------------------
  // Rollback detection
  // -----------------------------------------------------------------------

  /**
   * Check whether the current config has degraded performance compared to
   * the best known config and suggest a rollback if so.
   *
   * Compares the average score of the current config (over the rollback
   * window) against the best config's average score. If the current config
   * is significantly worse, a rollback is suggested.
   *
   * @returns A rollback suggestion.
   */
  checkRollback(): RollbackSuggestion {
    const currentHistory = this.state.configHistory
      .filter((h) => h.configId === this.state.currentConfigId);

    // Need enough data to make a judgment
    if (currentHistory.length < this.rollbackWindow) {
      return {
        shouldRollback: false,
        currentScore: 0,
        reason: `Insufficient data: ${currentHistory.length}/${this.rollbackWindow} episodes observed.`,
      };
    }

    // Compute average score for current config over the window
    const recentHistory = currentHistory.slice(-this.rollbackWindow);
    const currentScore = recentHistory.reduce(
      (sum, h) => sum + computeCompositeScore(h.performance.metrics),
      0,
    ) / recentHistory.length;

    const bestScore = this.state.bestScore;
    const degradation = bestScore - currentScore;
    const degradationThreshold = 0.1; // 10% degradation triggers suggestion

    if (degradation > degradationThreshold && this.state.bestConfigId !== this.state.currentConfigId) {
      this.logger.warn('Performance degradation detected', {
        currentConfigId: this.state.currentConfigId,
        bestConfigId: this.state.bestConfigId,
        currentScore,
        bestScore,
        degradation,
      });

      return {
        shouldRollback: true,
        targetConfigId: this.state.bestConfigId,
        currentScore,
        targetScore: bestScore,
        reason: `Current config scores ${currentScore.toFixed(3)} vs best config ${bestScore.toFixed(3)} ` +
                `(${(degradation * 100).toFixed(1)}% degradation over ${this.rollbackWindow} episodes).`,
      };
    }

    return {
      shouldRollback: false,
      currentScore,
      reason: `Current config performing within acceptable range (score: ${currentScore.toFixed(3)}, best: ${bestScore.toFixed(3)}).`,
    };
  }

  /**
   * Roll back to a specific config.
   *
   * @param configId - The config to roll back to.
   * @returns The restored config, or null if not found.
   */
  rollbackTo(configId: string): ArchitectureConfig | null {
    const config = this.configs.get(configId);
    if (!config) {
      this.logger.warn('Rollback target not found', { configId });
      return null;
    }

    this.state.currentConfigId = configId;
    this.logger.info('Rolled back to config', { configId });

    return structuredClone(config);
  }

  // -----------------------------------------------------------------------
  // Prompt suggestions
  // -----------------------------------------------------------------------

  /**
   * Generate suggestions for CLAUDE.md prompt modifications based on
   * tool usage patterns and performance data.
   *
   * Analyzes which APEX tools are underutilized, which patterns lead to
   * better outcomes, and generates concrete suggestions.
   *
   * @param toolUsage - Tool usage statistics from the effectiveness tracker.
   * @returns Array of prompt suggestions sorted by confidence (descending).
   */
  generatePromptSuggestions(toolUsage: ToolUsageStats): PromptSuggestion[] {
    const suggestions: PromptSuggestion[] = [];
    const now = Date.now();

    // Core APEX tools that should be used regularly
    const coreTools = [
      'apex_recall',
      'apex_record',
      'apex_reflect_get',
      'apex_reflect_store',
      'apex_plan_context',
      'apex_skills',
      'apex_consolidate',
    ];

    // Check for underutilized tools
    for (const tool of coreTools) {
      const calls = toolUsage.callCounts[tool] ?? 0;
      const expectedMinCalls = Math.max(1, Math.floor(toolUsage.totalEpisodes * 0.3));

      if (calls < expectedMinCalls && toolUsage.totalEpisodes >= 5) {
        suggestions.push({
          id: generateId(),
          section: 'Core Behaviors',
          currentText: `Current usage of ${tool}: ${calls} calls across ${toolUsage.totalEpisodes} episodes`,
          suggestedText: `Add emphasis on using ${tool} more frequently. Consider adding it to the session start checklist.`,
          reason: `${tool} is underutilized (${calls} calls vs expected minimum of ${expectedMinCalls}).`,
          expectedImpact: `Increased ${tool} usage should improve ${this.toolImpactDescription(tool)}.`,
          confidence: clamp(0.5 + (expectedMinCalls - calls) / expectedMinCalls * 0.3, 0.3, 0.9),
          timestamp: now,
        });
      }
    }

    // Check for tools with low success rates
    for (const [tool, rate] of Object.entries(toolUsage.successRates)) {
      if (rate < 0.5 && (toolUsage.callCounts[tool] ?? 0) >= 3) {
        suggestions.push({
          id: generateId(),
          section: 'Good vs Bad Usage',
          currentText: `${tool} success rate: ${(rate * 100).toFixed(0)}%`,
          suggestedText: `Add guidance for better ${tool} usage. Include examples of effective queries and common mistakes to avoid.`,
          reason: `${tool} has a low success rate (${(rate * 100).toFixed(0)}%), suggesting users may need better guidance.`,
          expectedImpact: `Improved ${tool} guidance should reduce wasted calls and improve recall quality.`,
          confidence: clamp(0.6 - rate * 0.3, 0.3, 0.8),
          timestamp: now,
        });
      }
    }

    // Analyze performance history for subsystem-specific suggestions
    const currentConfig = this.getCurrentConfig();
    const flags = currentConfig.subsystemFlags;

    // If macro reflection is disabled and we have performance data, check if it should be re-enabled
    if (!flags.macroReflection && this.state.configHistory.length >= 10) {
      const recentScores = this.state.configHistory.slice(-10).map(
        (h) => computeCompositeScore(h.performance.metrics),
      );
      const avgScore = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;

      if (avgScore < 0.5) {
        suggestions.push({
          id: generateId(),
          section: 'Core Behaviors',
          currentText: 'Macro reflection is currently disabled.',
          suggestedText: 'Re-enable macro reflection to gain strategic insights from accumulated experience.',
          reason: `Performance is below average (${avgScore.toFixed(3)}) with macro reflection disabled.`,
          expectedImpact: 'Macro reflection provides high-level pattern detection that could identify systemic issues.',
          confidence: 0.6,
          timestamp: now,
        });
      }
    }

    // Check reflection frequency
    if (currentConfig.reflectionFrequency > 10 && this.state.configHistory.length >= 5) {
      const recentScores = this.state.configHistory.slice(-5).map(
        (h) => h.performance.metrics.reflectionValue,
      );
      const avgReflectionValue = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;

      if (avgReflectionValue < 0.3) {
        suggestions.push({
          id: generateId(),
          section: 'Core Behaviors',
          currentText: `Reflection frequency: every ${currentConfig.reflectionFrequency} episodes`,
          suggestedText: `Reduce reflection frequency to every 3-5 episodes for more responsive learning.`,
          reason: `Reflection value is low (${avgReflectionValue.toFixed(3)}) with infrequent reflections.`,
          expectedImpact: 'More frequent reflections allow faster course corrections.',
          confidence: 0.55,
          timestamp: now,
        });
      }
    }

    // Sort by confidence descending
    suggestions.sort((a, b) => b.confidence - a.confidence);

    return suggestions;
  }

  /**
   * Return a human-readable description of what a tool impacts.
   */
  private toolImpactDescription(tool: string): string {
    const impacts: Record<string, string> = {
      apex_recall: 'context retrieval quality and error avoidance',
      apex_record: 'experiential learning and pattern detection',
      apex_reflect_get: 'self-awareness and error pattern recognition',
      apex_reflect_store: 'knowledge consolidation and strategic planning',
      apex_plan_context: 'planning accuracy and pitfall avoidance',
      apex_skills: 'skill reuse and efficiency',
      apex_consolidate: 'memory health and retrieval performance',
    };
    return impacts[tool] ?? 'overall agent performance';
  }

  // -----------------------------------------------------------------------
  // Best config selection
  // -----------------------------------------------------------------------

  /**
   * Get the best config found so far along with its performance data.
   *
   * @returns Object containing the best config and its average score.
   */
  getBestConfig(): { config: ArchitectureConfig; score: number } | null {
    const config = this.configs.get(this.state.bestConfigId);
    if (!config) return null;

    return {
      config: structuredClone(config),
      score: this.state.bestScore,
    };
  }

  /**
   * Get all configs ranked by their average composite score.
   *
   * @returns Array of configs with scores, sorted descending by score.
   */
  getRankedConfigs(): Array<{ configId: string; score: number; generation: number }> {
    const configScores = new Map<string, { totalScore: number; count: number }>();

    for (const entry of this.state.configHistory) {
      const score = computeCompositeScore(entry.performance.metrics);
      const existing = configScores.get(entry.configId) ?? { totalScore: 0, count: 0 };
      existing.totalScore += score;
      existing.count++;
      configScores.set(entry.configId, existing);
    }

    const ranked: Array<{ configId: string; score: number; generation: number }> = [];
    for (const [configId, data] of configScores) {
      const config = this.configs.get(configId);
      ranked.push({
        configId,
        score: data.count > 0 ? data.totalScore / data.count : 0,
        generation: config?.generation ?? 0,
      });
    }

    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  /**
   * Get a summary of the architecture search status.
   *
   * @returns Status object with key metrics and state.
   */
  getStatus(): {
    currentConfigId: string;
    bestConfigId: string;
    bestScore: number;
    generation: number;
    searchesRemaining: number;
    totalConfigs: number;
    totalPerformanceRecords: number;
  } {
    return {
      currentConfigId: this.state.currentConfigId,
      bestConfigId: this.state.bestConfigId,
      bestScore: this.state.bestScore,
      generation: this.state.generation,
      searchesRemaining: this.state.searchesRemaining,
      totalConfigs: this.configs.size,
      totalPerformanceRecords: this.state.configHistory.length,
    };
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Persist the search state and all configs to disk via FileStore.
   */
  async save(): Promise<void> {
    // Save state
    await this.store.write(ARCH_SEARCH_COLLECTION, ARCH_SEARCH_STATE_ID, this.state);

    // Save all configs
    for (const [id, config] of this.configs) {
      await this.store.write(ARCH_CONFIGS_COLLECTION, id, config);
    }

    this.logger.debug('Architecture search state saved', {
      configs: this.configs.size,
      historyEntries: this.state.configHistory.length,
    });
  }

  /**
   * Load search state and configs from disk via FileStore.
   *
   * @returns `true` if data was loaded successfully, `false` otherwise.
   */
  async load(): Promise<boolean> {
    const loaded = await this.store.read<ArchitectureSearchState>(
      ARCH_SEARCH_COLLECTION,
      ARCH_SEARCH_STATE_ID,
    );

    if (!loaded) {
      this.logger.debug('No persisted architecture search state found');
      return false;
    }

    this.state = loaded;

    // Load all configs referenced in history
    const configIds = new Set<string>();
    configIds.add(this.state.currentConfigId);
    configIds.add(this.state.bestConfigId);
    for (const entry of this.state.configHistory) {
      configIds.add(entry.configId);
    }

    for (const id of configIds) {
      const config = await this.store.read<ArchitectureConfig>(ARCH_CONFIGS_COLLECTION, id);
      if (config) {
        this.configs.set(id, config);
      }
    }

    this.logger.info('Architecture search state loaded', {
      configs: this.configs.size,
      generation: this.state.generation,
      bestScore: this.state.bestScore,
    });

    return true;
  }

  // -----------------------------------------------------------------------
  // Testing helpers
  // -----------------------------------------------------------------------

  /**
   * Set the RNG for deterministic testing.
   * @internal
   */
  _setRng(rng: () => number): void {
    this.rng = rng;
  }
}
