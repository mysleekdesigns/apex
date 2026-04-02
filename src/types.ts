/**
 * APEX Agent Self-Learning System — Core Type Definitions
 *
 * Defines the shared type vocabulary for episodes, memory, skills,
 * reflections, trajectories, tasks, and configuration.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a globally-unique identifier.
 *
 * @returns A random UUID v4 string (e.g. `"3b241101-e2bb-4d7a-8702-9e1a4c5e7f23"`).
 */
export function generateId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Core execution types
// ---------------------------------------------------------------------------

/**
 * A single action performed by the agent during an episode.
 *
 * Actions are the atomic units of agent behaviour — each one records what the
 * agent did, when it did it, and whether the action succeeded.
 */
export interface Action {
  /** The category / kind of action (e.g. `"file-edit"`, `"shell-command"`). */
  type: string;

  /** Human-readable description of what the action did. */
  description: string;

  /** Unix-epoch millisecond timestamp of when the action was executed. */
  timestamp: number;

  /** Optional textual result or output produced by the action. */
  result?: string;

  /** Whether the action completed without error. */
  success: boolean;
}

/**
 * The outcome of an entire episode — a summary of success/failure plus timing.
 */
export interface Outcome {
  /** Whether the episode's goal was achieved. */
  success: boolean;

  /** Human-readable summary of the result. */
  description: string;

  /**
   * If the episode failed, a machine-friendly error category
   * (e.g. `"type-error"`, `"timeout"`, `"permission-denied"`).
   */
  errorType?: string;

  /** Wall-clock duration of the episode in milliseconds. */
  duration: number;
}

/**
 * A complete task-execution record produced by the agent.
 *
 * Episodes are the primary unit of experience: each one captures the task
 * that was attempted, every action taken, the final outcome, and an optional
 * embedding for semantic retrieval.
 */
export interface Episode {
  /** Unique identifier for this episode. */
  id: string;

  /** The task description or goal that was attempted. */
  task: string;

  /** Ordered list of actions the agent performed. */
  actions: Action[];

  /** Summary outcome of the episode. */
  outcome: Outcome;

  /**
   * Scalar reward signal in the range `[0, 1]`.
   *
   * - `0` = complete failure
   * - `1` = perfect success
   */
  reward: number;

  /** Unix-epoch millisecond timestamp of when the episode was created. */
  timestamp: number;

  /** Optional dense vector embedding of the episode for similarity search. */
  embedding?: number[];

  /** Arbitrary additional metadata attached to the episode. */
  metadata?: Record<string, unknown>;

  /** File paths that were relevant to this episode. */
  sourceFiles?: string[];
}

// ---------------------------------------------------------------------------
// Trajectory types
// ---------------------------------------------------------------------------

/**
 * A single step in a trajectory, modelled as an (S, A, R, S') tuple.
 */
export interface TrajectoryStep {
  /** Serialised representation of the state *before* the action. */
  state: string;

  /** The action taken in this step. */
  action: string;

  /** Immediate scalar reward received after this step. */
  reward: number;

  /** Serialised representation of the state *after* the action. */
  nextState: string;
}

/**
 * An ordered sequence of (state, action, reward, nextState) tuples derived
 * from a single episode.
 *
 * Trajectories are the structured form consumed by planning and
 * reinforcement-learning components.
 */
export interface Trajectory {
  /** Unique identifier for this trajectory. */
  id: string;

  /** The episode from which this trajectory was extracted. */
  episodeId: string;

  /** Ordered steps that make up the trajectory. */
  steps: TrajectoryStep[];
}

// ---------------------------------------------------------------------------
// Reflection types
// ---------------------------------------------------------------------------

/**
 * A structured reflection produced by the agent's self-evaluation process.
 *
 * Reflections exist at three temporal granularities:
 * - **micro** — after a single episode
 * - **meso** — after a batch of related episodes
 * - **macro** — periodic high-level strategy review
 */
export interface Reflection {
  /** Unique identifier for this reflection. */
  id: string;

  /**
   * Temporal granularity of the reflection.
   *
   * - `"micro"` — single-episode retrospective
   * - `"meso"` — batch / session-level analysis
   * - `"macro"` — periodic strategic review
   */
  level: "micro" | "meso" | "macro";

  /** Free-text content of the reflection. */
  content: string;

  /**
   * Machine-friendly error categories identified during reflection
   * (e.g. `["type-error", "missing-import"]`).
   */
  errorTypes: string[];

  /**
   * Concrete, actionable recommendations extracted from the reflection
   * (e.g. `"Always verify imports before editing a file"`).
   */
  actionableInsights: string[];

  /** IDs of the episodes that informed this reflection. */
  sourceEpisodes: string[];

  /** Unix-epoch millisecond timestamp of when the reflection was created. */
  timestamp: number;

  /**
   * Self-assessed confidence in the reflection's accuracy, in `[0, 1]`.
   *
   * - `0` = no confidence
   * - `1` = fully confident
   */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Skill types
// ---------------------------------------------------------------------------

/**
 * A reusable learned capability distilled from successful episodes.
 *
 * Skills are the agent's "muscle memory" — patterns that have been validated
 * across multiple episodes and can be transferred between projects.
 */
export interface Skill {
  /** Unique identifier for this skill. */
  id: string;

  /** Short human-readable name (e.g. `"TypeScript barrel export"`). */
  name: string;

  /** Detailed description of what the skill does and when to apply it. */
  description: string;

  /**
   * Conditions that must hold before this skill can be applied
   * (e.g. `["project uses TypeScript", "tsconfig.json exists"]`).
   */
  preconditions: string[];

  /** The reusable action pattern or template encoded as a string. */
  pattern: string;

  /**
   * Empirical success rate across all uses, in `[0, 1]`.
   */
  successRate: number;

  /** Total number of times this skill has been applied. */
  usageCount: number;

  /**
   * Confidence that this skill is reliable, in `[0, 1]`.
   * Typically derived from `successRate` weighted by `usageCount`.
   */
  confidence: number;

  /** The project where this skill was originally learned. */
  sourceProject: string;

  /** File paths that contributed to the skill's creation. */
  sourceFiles: string[];

  /** Unix-epoch millisecond timestamp of when the skill was first created. */
  createdAt: number;

  /** Unix-epoch millisecond timestamp of the last update to this skill. */
  updatedAt: number;

  /** Free-form tags for categorisation and retrieval. */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Memory types
// ---------------------------------------------------------------------------

/**
 * The four tiers of the agent's long-term memory system.
 *
 * | Tier          | Purpose                                        |
 * |---------------|------------------------------------------------|
 * | `working`     | Short-lived scratchpad for the current session  |
 * | `episodic`    | Concrete past experiences (episodes)            |
 * | `semantic`    | Generalised knowledge and patterns              |
 * | `procedural`  | Executable skills and action sequences           |
 */
export type MemoryTier = "working" | "episodic" | "semantic" | "procedural";

/**
 * Base record for every item stored in the memory system.
 *
 * All memory tiers share this common shape; the `tier` discriminant indicates
 * which store the entry belongs to.
 */
export interface MemoryEntry {
  /** Unique identifier for this memory entry. */
  id: string;

  /** The textual content of the memory. */
  content: string;

  /** Optional dense vector embedding for similarity search. */
  embedding?: number[];

  /**
   * Access-frequency score used by the consolidation / eviction policy.
   * Higher values indicate "hotter" (more frequently accessed) memories.
   */
  heatScore: number;

  /**
   * Confidence that this memory is still accurate, in `[0, 1]`.
   */
  confidence: number;

  /** Unix-epoch millisecond timestamp of when the entry was created. */
  createdAt: number;

  /** Unix-epoch millisecond timestamp of the most recent access. */
  accessedAt: number;

  /** File paths associated with this memory entry. */
  sourceFiles?: string[];

  /**
   * Whether this entry has been flagged as potentially outdated.
   * Stale entries are candidates for re-validation or eviction.
   */
  stale?: boolean;

  /** The memory tier this entry belongs to. */
  tier: MemoryTier;
}

/**
 * A ranked result returned by the memory retrieval system.
 */
export interface SearchResult {
  /** The matched memory entry. */
  entry: MemoryEntry;

  /**
   * Relevance score for this result (higher is better).
   * The exact scale depends on the retrieval strategy used.
   */
  score: number;

  /** The memory tier the entry was retrieved from. */
  sourceTier: MemoryTier;

  /**
   * Whether the entry came from the current project's memory store
   * or from the shared global store.
   */
  source: "project" | "global";
}

// ---------------------------------------------------------------------------
// Multi-agent co-evolution types
// ---------------------------------------------------------------------------

/**
 * A virtual agent profile in the evolutionary population.
 *
 * Each agent has its own strategy preferences, personal skill weightings,
 * and performance metrics. Agents share a semantic memory pool but compete
 * and cooperate via cross-pollination of skills.
 */
export interface AgentProfile {
  /** Unique identifier for this agent. */
  id: string;

  /** Human-readable name for this agent. */
  name: string;

  /** Preferred strategy identifiers this agent tends to use. */
  strategies: string[];

  /** Personal weight modifiers for skills (skillId -> weight in [0, 2]). */
  skillWeights: Record<string, number>;

  /** Aggregate performance metrics for this agent. */
  metrics: {
    /** Total number of tasks this agent has been evaluated on. */
    tasksSolved: number;
    /** Fraction of tasks solved successfully, in [0, 1]. */
    successRate: number;
    /** Mean reward across all evaluations. */
    avgReward: number;
    /** Domains this agent excels at (based on above-average performance). */
    specializations: string[];
  };

  /** Generation number (0 = seed, incremented on each evolution cycle). */
  generation: number;

  /** IDs of the parent agents this agent was bred from. */
  parentIds: string[];

  /** Unix-epoch ms timestamp of when this agent was created. */
  createdAt: number;

  /** Unix-epoch ms timestamp of the last update to this agent. */
  updatedAt: number;
}

/**
 * Configuration for the agent population and evolutionary process.
 */
export interface PopulationConfig {
  /** Number of agents in the population. Default: 5. */
  size: number;

  /** Number of agents sampled for tournament selection. Default: 3. */
  tournamentSize: number;

  /** Probability that a skill is transferred during cross-pollination, in [0, 1]. Default: 0.3. */
  crossPollinationRate: number;

  /** Probability that a strategy is mutated during breeding, in [0, 1]. Default: 0.1. */
  mutationRate: number;

  /** Number of top agents preserved unchanged across generations. Default: 1. */
  elitismCount: number;

  /** Number of recent episodes to consider when computing fitness. Default: 20. */
  evaluationWindow: number;
}

/**
 * Result of a competitive evaluation where multiple agents are scored on a task.
 */
export interface CompetitiveResult {
  /** ID of the task that was evaluated. */
  taskId: string;

  /** Agents ranked by score (descending). */
  rankings: Array<{ agentId: string; score: number; strategies: string[] }>;

  /** ID of the highest-scoring agent. */
  bestAgent: string;

  /** Unix-epoch ms timestamp of when this evaluation was performed. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Task / curriculum types
// ---------------------------------------------------------------------------

/**
 * A task definition used by the curriculum engine to schedule work for the
 * agent.
 */
export interface Task {
  /** Unique identifier for this task. */
  id: string;

  /** Human-readable description of the task objective. */
  description: string;

  /**
   * Estimated difficulty in `[0, 1]`.
   *
   * - `0` = trivial
   * - `1` = extremely challenging
   */
  difficulty: number;

  /** Problem domain (e.g. `"refactoring"`, `"testing"`, `"documentation"`). */
  domain: string;

  /** Optional constraints the agent must respect while executing the task. */
  constraints?: string[];

  /** Optional skill IDs or names that may help accomplish the task. */
  suggestedSkills?: string[];
}

// ---------------------------------------------------------------------------
// Foresight types
// ---------------------------------------------------------------------------

/**
 * A signal emitted during multi-step task execution indicating whether the
 * current trajectory is diverging from the original prediction.
 */
export interface AdaptationSignal {
  /** Zero-based index of the step that triggered the signal. */
  stepIndex: number;

  /** How far the current trajectory has diverged from prediction (0 = on-track, 1 = fully diverged). */
  divergenceScore: number;

  /** Recommended course of action based on divergence. */
  recommendation: 'continue' | 'adjust' | 'reflect' | 'abort';

  /** Human-readable explanation of why this recommendation was made. */
  reason: string;

  /** Unix-epoch millisecond timestamp of when the signal was generated. */
  timestamp: number;
}

/**
 * A forward-looking prediction recorded before executing a multi-step task.
 *
 * After execution completes, the actual outcome is compared against the
 * prediction to compute a surprise score. High surprise triggers automatic
 * reflection.
 */
export interface ForesightPrediction {
  /** Unique identifier for this prediction. */
  id: string;

  /** ID of the task or plan this prediction is associated with. */
  taskId: string;

  /** The predicted outcome before execution. */
  predictedOutcome: {
    /** Whether the task is expected to succeed. */
    success: boolean;
    /** Expected wall-clock duration in milliseconds. */
    expectedDuration: number;
    /** Expected number of steps to complete the task. */
    expectedSteps: number;
    /** Known risk factors that could cause failure. */
    riskFactors: string[];
    /** Confidence in this prediction (0 = no confidence, 1 = certain). */
    confidence: number;
  };

  /** The actual outcome after execution (populated by resolve). */
  actualOutcome?: Outcome;

  /** Surprise score comparing predicted vs actual (0 = exact match, 1 = complete mismatch). */
  surpriseScore?: number;

  /** Adaptation signals emitted during execution. */
  adaptationSignals: AdaptationSignal[];

  /** Unix-epoch millisecond timestamp of when the prediction was created. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Tool creation types (Voyager-inspired)
// ---------------------------------------------------------------------------

/**
 * A tool definition created by the ToolFactory from recurring successful
 * action patterns. Represents a parameterized, verifiable action template
 * that the agent can invoke.
 */
export interface ToolDefinitionApex {
  /** Unique identifier for this tool. */
  id: string;

  /** Short human-readable name (e.g. `"lint-fix-commit"`). */
  name: string;

  /** Detailed description of what the tool does. */
  description: string;

  /** Input parameters extracted from variable parts of the pattern. */
  inputSchema: {
    parameters: Array<{
      name: string;
      type: string;
      description: string;
      required: boolean;
    }>;
  };

  /** The action template encoded as a string. */
  pattern: string;

  /** Conditions that must hold before this tool can be used. */
  preconditions: string[];

  /** Description of the expected output when the tool succeeds. */
  expectedOutput: string;

  /** Episode IDs this tool was extracted from. */
  sourceEpisodes: string[];

  /** Verification lifecycle status. */
  verificationStatus: 'pending' | 'verified' | 'rejected' | 'deprecated';

  /** Quality score assigned by the verification sandbox, in `[0, 1]`. */
  verificationScore: number;

  /** Mastery tracking metrics. */
  masteryMetrics: {
    /** Total number of times this tool has been used. */
    usageCount: number;
    /** Success rate across all uses, in `[0, 1]`. */
    successRate: number;
    /** Average duration of tool usage in milliseconds. */
    avgDuration: number;
    /** Descriptions of contexts where this tool failed. */
    failureContexts: string[];
    /** Unix-epoch millisecond timestamp of last usage. */
    lastUsed: number;
  };

  /** If this is a composite tool, the IDs of its component tools. */
  composedFrom?: string[];

  /** Unix-epoch millisecond timestamp of creation. */
  createdAt: number;

  /** Unix-epoch millisecond timestamp of last update. */
  updatedAt: number;

  /** Free-form tags for categorisation and retrieval. */
  tags: string[];
}

/**
 * A composite tool that chains multiple tools together in a pipeline.
 * Created when Tool A's output reliably feeds into Tool B's input.
 */
export interface ToolComposition {
  /** Unique identifier for this composition. */
  id: string;

  /** Short human-readable name for the pipeline. */
  name: string;

  /** Description of what the pipeline accomplishes. */
  description: string;

  /** Ordered steps in the pipeline. */
  steps: Array<{
    /** ID of the tool used in this step. */
    toolId: string;
    /** Mapping from previous step output fields to this step's input parameters. */
    inputMapping: Record<string, string>;
  }>;

  /** Empirical success rate across all uses, in `[0, 1]`. */
  successRate: number;

  /** Total number of times this pipeline has been used. */
  usageCount: number;

  /** Unix-epoch millisecond timestamp of creation. */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Architecture search types
// ---------------------------------------------------------------------------

/**
 * Describes the full APEX architecture configuration including which
 * subsystems are active, their interconnections, and tunable hyperparameters.
 */
export interface ArchitectureConfig {
  /** Unique identifier for this configuration. */
  id: string;

  /** The core agent hyperparameters. */
  agentConfig: AgentConfig;

  /** Flags controlling which subsystems are active. */
  subsystemFlags: {
    microReflection: boolean;
    mesoReflection: boolean;
    macroReflection: boolean;
    foresight: boolean;
    curriculum: boolean;
    crossProject: boolean;
  };

  /** Trigger reflection every N episodes. */
  reflectionFrequency: number;

  /** Trigger consolidation every N episodes. */
  consolidationFrequency: number;

  /** Number of episodes to average when computing performance. */
  performanceWindow: number;

  /** ID of the parent config this was mutated from. */
  parentConfigId?: string;

  /** Generation number in the search lineage. */
  generation: number;

  /** Unix-epoch millisecond timestamp of when this config was created. */
  createdAt: number;
}

/**
 * Performance metrics measured under a specific architecture configuration.
 */
export interface ConfigPerformance {
  /** ID of the config these metrics were measured under. */
  configId: string;

  /** Individual performance metric values. */
  metrics: {
    /** Fraction of episodes that succeeded (0-1). */
    successRate: number;
    /** Mean reward across episodes. */
    avgReward: number;
    /** Ratio of useful recalls to total recalls (0-1). */
    memoryEfficiency: number;
    /** Average relevance score of recall results (0-1). */
    recallQuality: number;
    /** Fraction of reflections that led to improved outcomes (0-1). */
    reflectionValue: number;
  };

  /** Number of episodes observed under this config. */
  episodeCount: number;

  /** Unix-epoch ms timestamp of when measurement started. */
  startTime: number;

  /** Unix-epoch ms timestamp of when measurement ended. */
  endTime: number;
}

/**
 * Persistent state of the architecture search process.
 */
export interface ArchitectureSearchState {
  /** ID of the currently active config. */
  currentConfigId: string;

  /** History of all configs tried with their performance. */
  configHistory: Array<{ configId: string; performance: ConfigPerformance }>;

  /** ID of the best-performing config found so far. */
  bestConfigId: string;

  /** Composite score of the best config. */
  bestScore: number;

  /** Current generation of the search. */
  generation: number;

  /** Maximum number of configs to evaluate. */
  searchBudget: number;

  /** Remaining configs that can still be tried. */
  searchesRemaining: number;
}

/**
 * A suggestion for modifying the CLAUDE.md prompt based on usage patterns.
 */
export interface PromptSuggestion {
  /** Unique identifier for this suggestion. */
  id: string;

  /** Which section of CLAUDE.md this suggestion targets. */
  section: string;

  /** The current text in that section (or a summary). */
  currentText: string;

  /** The suggested replacement or addition. */
  suggestedText: string;

  /** Why this change is being suggested. */
  reason: string;

  /** What improvement is expected from this change. */
  expectedImpact: string;

  /** Confidence that this suggestion will help (0-1). */
  confidence: number;

  /** Unix-epoch millisecond timestamp. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Global configuration for the APEX agent.
 */
export interface AgentConfig {
  /**
   * Maximum number of entries allowed in each memory tier.
   * When a tier exceeds its limit the consolidation policy kicks in.
   */
  memoryLimits: {
    /** Max entries in the working-memory tier. */
    working: number;
    /** Max entries in the episodic-memory tier. */
    episodic: number;
    /** Max entries in the semantic-memory tier. */
    semantic: number;
  };

  /**
   * Probability `[0, 1]` that the agent will explore a novel strategy
   * instead of exploiting the best-known one (epsilon-greedy).
   */
  explorationRate: number;

  /**
   * Number of working-memory entries that triggers automatic consolidation
   * into longer-term tiers.
   */
  consolidationThreshold: number;

  /**
   * Embedding generation strategy.
   *
   * - `"auto"` — choose based on content length and available resources
   * - `"fast"` — lightweight / approximate embeddings
   * - `"full"` — highest-quality embeddings
   */
  embeddingLevel: "auto" | "fast" | "full";

  /** Number of memory snapshots to retain before pruning old ones. */
  snapshotRetention: number;

  /**
   * Minimum number of episodes required before the agent considers itself
   * past the "cold start" phase for a given project.
   */
  coldStartThreshold: number;
}

// ---------------------------------------------------------------------------
// Project types
// ---------------------------------------------------------------------------

/**
 * Metadata about a project, produced by the project scanner.
 */
export interface ProjectProfile {
  /** Human-readable project name (typically from `package.json`). */
  name: string;

  /** Absolute filesystem path to the project root. */
  path: string;

  /**
   * High-level project type (e.g. `"library"`, `"cli"`, `"web-app"`,
   * `"monorepo"`).
   */
  type: string;

  /** Technologies and frameworks detected (e.g. `["typescript", "react"]`). */
  techStack: string[];

  /** Direct dependency names extracted from the project manifest. */
  dependencies: string[];

  /** Named scripts from the project manifest (e.g. `{ build: "tsc" }`). */
  scripts: Record<string, string>;

  /** Notable directory / file paths that characterise the project layout. */
  structure: string[];

  /** Optional free-text description of the project's purpose. */
  description?: string;
}

// ---------------------------------------------------------------------------
// Consolidation / snapshot types
// ---------------------------------------------------------------------------

/**
 * Report generated after a memory consolidation pass.
 */
export interface ConsolidationReport {
  /** Unix-epoch millisecond timestamp of when consolidation ran. */
  timestamp: number;

  /** Number of entries promoted from working to episodic memory. */
  movedToEpisodic: number;

  /** Number of entries promoted from episodic to semantic memory. */
  movedToSemantic: number;

  /** Number of entries permanently removed (evicted). */
  evicted: number;

  /** Number of entries merged with existing entries. */
  merged: number;
}

/**
 * Metadata for a point-in-time memory snapshot.
 *
 * Snapshots allow the agent to roll back to a previous memory state if a
 * consolidation or learning step goes wrong.
 */
export interface Snapshot {
  /** Unique identifier for this snapshot. */
  id: string;

  /** Optional human-readable label for the snapshot. */
  name?: string;

  /** Unix-epoch millisecond timestamp of when the snapshot was taken. */
  timestamp: number;

  /** Number of entries in each memory tier at snapshot time. */
  tierSizes: Record<MemoryTier, number>;

  /**
   * Whether this snapshot was created automatically (e.g. before
   * consolidation) or manually by the user.
   */
  auto: boolean;
}
