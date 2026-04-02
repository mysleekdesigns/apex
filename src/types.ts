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
