/**
 * APEX MCP Tool Definitions
 *
 * All tools are pure data operations — zero LLM calls.
 * Each definition provides name, description, and JSON Schema input.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const tools: ToolDefinition[] = [
  // ── 1. apex_recall ──────────────────────────────────────────────
  {
    name: 'apex_recall',
    description:
      'Query all memory tiers for relevant context. Searches episodic memory, reflections, and skill library to surface past experience related to the current task.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to match against stored memories',
        },
        context: {
          type: 'string',
          description: 'Optional additional context to improve relevance',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
      },
      required: ['query'],
    },
  },

  // ── 2. apex_record ──────────────────────────────────────────────
  {
    name: 'apex_record',
    description:
      'Record an episode — the task attempted, actions taken, and outcome. This is the primary ingestion point for experiential learning.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Description of the task that was attempted',
        },
        actions: {
          type: 'array',
          description: 'Ordered list of actions taken during the episode',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                description: 'Category of action (e.g. "code_edit", "file_read", "command")',
              },
              description: {
                type: 'string',
                description: 'What the action did',
              },
              success: {
                type: 'boolean',
                description: 'Whether the individual action succeeded',
              },
            },
            required: ['type', 'description', 'success'],
          },
        },
        outcome: {
          type: 'object',
          description: 'Final outcome of the episode',
          properties: {
            success: {
              type: 'boolean',
              description: 'Whether the overall task succeeded',
            },
            description: {
              type: 'string',
              description: 'Summary of the outcome',
            },
            errorType: {
              type: 'string',
              description: 'Classification of error if the task failed',
            },
            duration: {
              type: 'number',
              description: 'Duration of the episode in milliseconds',
            },
          },
          required: ['success', 'description', 'duration'],
        },
        reward: {
          type: 'number',
          description: 'Optional explicit reward signal (-1.0 to 1.0)',
        },
      },
      required: ['task', 'actions', 'outcome'],
    },
  },

  // ── 3. apex_reflect_get ─────────────────────────────────────────
  {
    name: 'apex_reflect_get',
    description:
      'Retrieve raw episode data for reflection. Returns episodes filtered by scope so the agent can analyze patterns, errors, or recent activity.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['recent', 'similar', 'errors'],
          description: 'Filter scope: "recent" for latest episodes, "similar" for related tasks, "errors" for failed episodes',
        },
        episodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific episode IDs to retrieve',
        },
        taskType: {
          type: 'string',
          description: 'Filter episodes by task type',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of episodes to return (default: 20)',
        },
      },
      required: ['scope'],
    },
  },

  // ── 4. apex_reflect_store ───────────────────────────────────────
  {
    name: 'apex_reflect_store',
    description:
      'Store the output of a reflection. Reflections are tiered: micro (single episode), meso (pattern across episodes), macro (strategic insights).',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['micro', 'meso', 'macro'],
          description: 'Reflection tier: micro (single episode), meso (pattern), macro (strategy)',
        },
        content: {
          type: 'string',
          description: 'The reflection content',
        },
        errorTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Error types this reflection addresses',
        },
        actionableInsights: {
          type: 'array',
          items: { type: 'string' },
          description: 'Concrete takeaways extracted from the reflection',
        },
        sourceEpisodes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Episode IDs that informed this reflection',
        },
      },
      required: ['level', 'content'],
    },
  },

  // ── 5. apex_plan_context ────────────────────────────────────────
  {
    name: 'apex_plan_context',
    description:
      'Get experience-informed planning context for a task. Returns relevant skills, known pitfalls, and past outcomes to guide planning.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Description of the task being planned',
        },
        includeSkills: {
          type: 'boolean',
          description: 'Include matching skills from the skill library (default: true)',
        },
        includePitfalls: {
          type: 'boolean',
          description: 'Include known pitfalls and failure patterns (default: true)',
        },
      },
      required: ['task'],
    },
  },

  // ── 6. apex_skills ──────────────────────────────────────────────
  {
    name: 'apex_skills',
    description:
      'List or search the skill library. Skills are reusable patterns extracted from successful episodes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to filter skills',
        },
        action: {
          type: 'string',
          enum: ['list', 'search'],
          description: 'Action to perform (default: "list")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of skills to return (default: 20)',
        },
      },
    },
  },

  // ── 7. apex_skill_store ─────────────────────────────────────────
  {
    name: 'apex_skill_store',
    description:
      'Store a new skill in the skill library. Skills capture reusable patterns with preconditions and tags for later retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short, descriptive name for the skill',
        },
        description: {
          type: 'string',
          description: 'What the skill does and when to use it',
        },
        preconditions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Conditions that must be true before applying this skill',
        },
        pattern: {
          type: 'string',
          description: 'The reusable pattern or procedure',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization and search',
        },
      },
      required: ['name', 'description', 'pattern'],
    },
  },

  // ── 8. apex_status ──────────────────────────────────────────────
  {
    name: 'apex_status',
    description:
      'Show memory statistics and learning information. Returns counts of episodes, reflections, skills, and overall learning health.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── 9. apex_consolidate ─────────────────────────────────────────
  {
    name: 'apex_consolidate',
    description:
      'Force memory tier consolidation. Promotes episodic memories to reflections and extracts skills when thresholds are met.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── 10. apex_curriculum ─────────────────────────────────────────
  {
    name: 'apex_curriculum',
    description:
      'Get the next suggested task from the curriculum engine. Uses current skill level and learning gaps to recommend what to practice next.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain to get suggestions for (e.g. "typescript", "testing")',
        },
        skillLevel: {
          type: 'number',
          description: 'Current skill level estimate (0.0 to 1.0)',
        },
      },
    },
  },

  // ── 11. apex_setup ──────────────────────────────────────────────
  {
    name: 'apex_setup',
    description:
      'Initialize APEX for a project. Creates the memory directory structure and configuration files.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the project root (defaults to current working directory)',
        },
      },
    },
  },

  // ── 12. apex_snapshot ───────────────────────────────────────────
  {
    name: 'apex_snapshot',
    description:
      'Create a snapshot of current memory state. Useful before risky operations or as a checkpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Optional human-readable name for the snapshot',
        },
      },
    },
  },

  // ── 13. apex_rollback ───────────────────────────────────────────
  {
    name: 'apex_rollback',
    description:
      'Restore memory state from a snapshot. Either specify a snapshot ID or use latest.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshotId: {
          type: 'string',
          description: 'ID of the snapshot to restore',
        },
        latest: {
          type: 'boolean',
          description: 'If true, restore the most recent snapshot',
        },
      },
    },
  },

  // ── 14. apex_promote ────────────────────────────────────────────
  {
    name: 'apex_promote',
    description:
      'Promote a project-local skill to the global skill library so it is available across all projects.',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: {
          type: 'string',
          description: 'ID of the skill to promote',
        },
      },
      required: ['skillId'],
    },
  },

  // ── 15. apex_import ─────────────────────────────────────────────
  {
    name: 'apex_import',
    description:
      'Import skills from another project into the current project skill library.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Path or identifier of the source project to import from',
        },
      },
      required: ['source'],
    },
  },

  // ── 16. apex_foresight_predict ─────────────────────────────────
  {
    name: 'apex_foresight_predict',
    description:
      'Record a prediction before starting a multi-step task. Captures expected outcome, duration, steps, and risk factors for later comparison.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'ID of the task or plan being predicted',
        },
        predictedSuccess: {
          type: 'boolean',
          description: 'Whether the task is expected to succeed',
        },
        expectedDuration: {
          type: 'number',
          description: 'Expected wall-clock duration in milliseconds',
        },
        expectedSteps: {
          type: 'number',
          description: 'Expected number of steps to complete the task',
        },
        riskFactors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Known risk factors that could cause failure',
        },
        confidence: {
          type: 'number',
          description: 'Confidence in this prediction (0.0 to 1.0, default 0.5)',
        },
      },
      required: ['taskId', 'predictedSuccess', 'expectedDuration', 'expectedSteps'],
    },
  },

  // ── 17. apex_foresight_check ───────────────────────────────────
  {
    name: 'apex_foresight_check',
    description:
      'Check divergence during task execution. Compares current progress against the original prediction and returns an adaptation signal (continue, adjust, reflect, or abort).',
    inputSchema: {
      type: 'object',
      properties: {
        predictionId: {
          type: 'string',
          description: 'ID of the prediction to check against',
        },
        stepIndex: {
          type: 'number',
          description: 'Zero-based index of the current step',
        },
        stepSuccess: {
          type: 'boolean',
          description: 'Whether the current step succeeded',
        },
        elapsedMs: {
          type: 'number',
          description: 'Total elapsed time so far in milliseconds',
        },
        completedSteps: {
          type: 'number',
          description: 'Total number of steps completed so far (including this one)',
        },
        stepDescription: {
          type: 'string',
          description: 'Optional description of what happened in this step',
        },
      },
      required: ['predictionId', 'stepIndex', 'stepSuccess', 'elapsedMs', 'completedSteps'],
    },
  },

  // ── 18. apex_foresight_resolve ─────────────────────────────────
  {
    name: 'apex_foresight_resolve',
    description:
      'Compare a prediction with the actual outcome after task completion. Calculates a surprise score (0 = exact match, 1 = complete mismatch) and auto-triggers reflection when surprise is high.',
    inputSchema: {
      type: 'object',
      properties: {
        predictionId: {
          type: 'string',
          description: 'ID of the prediction to resolve',
        },
        actualOutcome: {
          type: 'object',
          description: 'The actual outcome of the task',
          properties: {
            success: {
              type: 'boolean',
              description: 'Whether the task actually succeeded',
            },
            description: {
              type: 'string',
              description: 'Summary of what actually happened',
            },
            errorType: {
              type: 'string',
              description: 'Error classification if the task failed',
            },
            duration: {
              type: 'number',
              description: 'Actual duration in milliseconds',
            },
          },
          required: ['success', 'description', 'duration'],
        },
        episodeId: {
          type: 'string',
          description: 'Optional episode ID for linking to reflection',
        },
      },
      required: ['predictionId', 'actualOutcome'],
    },
  },

  // ── 19. apex_population_status ────────────────────────────────
  {
    name: 'apex_population_status',
    description:
      'Show agent population stats, rankings, and specializations. Returns the current state of the multi-agent co-evolution system.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── 20. apex_population_evolve ────────────────────────────────
  {
    name: 'apex_population_evolve',
    description:
      'Trigger one evolution cycle on the agent population. Evaluates fitness, selects parents via tournament, breeds offspring, applies mutations, and cross-pollinates skills.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Optional task ID to run competitive evaluation before evolving',
        },
        taskDomain: {
          type: 'string',
          description: 'Domain of the task (e.g. "testing", "refactoring") — required if taskId is provided',
        },
        taskReward: {
          type: 'number',
          description: 'Reward achieved on the task (0.0 to 1.0) — required if taskId is provided',
        },
        taskSuccess: {
          type: 'boolean',
          description: 'Whether the task succeeded — required if taskId is provided',
        },
      },
    },
  },

  // ── 21. apex_tool_propose ───────────────────────────────────────
  {
    name: 'apex_tool_propose',
    description:
      'Propose new tools from recurring successful action patterns. Analyses recent episodes and extracts multi-step patterns that appear frequently with high success rate.',
    inputSchema: {
      type: 'object',
      properties: {
        minFrequency: {
          type: 'number',
          description: 'Minimum number of episodes a pattern must appear in (default: 3)',
        },
        minSuccessRate: {
          type: 'number',
          description: 'Minimum success rate for a pattern to qualify (default: 0.8)',
        },
      },
    },
  },

  // ── 22. apex_tool_verify ────────────────────────────────────────
  {
    name: 'apex_tool_verify',
    description:
      'Run verification checks on a proposed tool. Scores preconditions, generalisability, clarity, reusability, and safety. Updates the tool status to verified, pending, or rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        toolId: {
          type: 'string',
          description: 'ID of the tool to verify',
        },
      },
      required: ['toolId'],
    },
  },

  // ── 23. apex_tool_list ──────────────────────────────────────────
  {
    name: 'apex_tool_list',
    description:
      'List all created tools with their mastery metrics. Optionally filter by verification status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'verified', 'rejected', 'deprecated'],
          description: 'Filter by verification status',
        },
      },
    },
  },

  // ── 24. apex_tool_compose ───────────────────────────────────────
  {
    name: 'apex_tool_compose',
    description:
      'Create composite tools from sequences of existing tools that chain together reliably. Detects recurring tool pipelines across successful episodes.',
    inputSchema: {
      type: 'object',
      properties: {
        toolIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: specific tool IDs to compose. If omitted, auto-detects chains from episodes.',
        },
      },
    },
  },
  // ── 25. apex_arch_status ──────────────────────────────────────
  {
    name: 'apex_arch_status',
    description:
      'Show current architecture config, performance history, and best config found. Returns the state of the adaptive architecture search system.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── 26. apex_arch_mutate ──────────────────────────────────────
  {
    name: 'apex_arch_mutate',
    description:
      'Propose and apply a config mutation to the current architecture. Supports toggling subsystems, adjusting frequencies, memory capacities, and hyperparameters. Tracks rollback state automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        mutationType: {
          type: 'string',
          enum: [
            'toggle-subsystem',
            'adjust-reflection-frequency',
            'adjust-consolidation-frequency',
            'adjust-memory-capacity',
            'adjust-exploration-rate',
            'adjust-consolidation-threshold',
            'adjust-performance-window',
          ],
          description: 'Type of mutation to apply. If omitted, a random mutation is selected.',
        },
        biased: {
          type: 'boolean',
          description: 'If true, sample biased toward high-performing configs (default: false)',
        },
      },
    },
  },

  // ── 27. apex_arch_suggest ─────────────────────────────────────
  {
    name: 'apex_arch_suggest',
    description:
      'Get suggestions for config and prompt improvements based on performance data and tool usage patterns. Returns rollback recommendations if performance has degraded. Includes DSPy-inspired prompt optimization suggestions and regression alerts.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── 28. apex_prompt_optimize ──────────────────────────────────
  {
    name: 'apex_prompt_optimize',
    description:
      'Run a DSPy-inspired prompt optimization round. Analyses prompt module effectiveness metrics, proposes rule-based mutations (rephrase, simplify, elaborate, adjust-emphasis, add/remove examples), and manages A/B experiments. Returns mutation proposals ranked by expected impact.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['optimize', 'status', 'conclude-experiments'],
          description:
            'Action to perform. "optimize" runs a mutation round, "status" shows current experiments and module metrics, "conclude-experiments" evaluates and concludes significant A/B tests.',
        },
      },
      required: ['action'],
    },
  },

  // ── 29. apex_prompt_module ────────────────────────────────────
  {
    name: 'apex_prompt_module',
    description:
      'Manage prompt modules — modular prompt text units with versioning, A/B variants, and effectiveness tracking. Register new modules, hot-swap content, view metrics, and manage few-shot examples.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['register', 'list', 'get', 'hot-swap', 'add-variant', 'examples'],
          description:
            'Action to perform on prompt modules.',
        },
        name: {
          type: 'string',
          description: 'Module name (required for register, get, hot-swap, add-variant, examples).',
        },
        category: {
          type: 'string',
          enum: ['tool-description', 'behavior', 'few-shot'],
          description: 'Module category (required for register).',
        },
        content: {
          type: 'string',
          description: 'Module content text (required for register, hot-swap, add-variant).',
        },
        mutationType: {
          type: 'string',
          enum: ['rephrase', 'add-example', 'remove-example', 'adjust-emphasis', 'simplify', 'elaborate'],
          description: 'Mutation type for add-variant action.',
        },
      },
      required: ['action'],
    },
  },

  // ── 30. apex_goals ────────────────────────────────────────────
  {
    name: 'apex_goals',
    description:
      'Manage the persistent goal hierarchy. Track multi-session objectives with sub-goals, priorities, deadlines, and progress. Goals persist across sessions and surface in planning context.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'get', 'update', 'complete', 'block', 'abandon', 'search'],
          description: 'Action to perform on the goal stack.',
        },
        goalId: {
          type: 'string',
          description: 'Goal ID (required for get, update, complete, block, abandon).',
        },
        description: {
          type: 'string',
          description: 'Goal description (required for add).',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Goal priority (for add or update).',
        },
        parentId: {
          type: 'string',
          description: 'Parent goal ID to create a sub-goal (for add).',
        },
        deadline: {
          type: 'string',
          description: 'ISO timestamp deadline (for add or update).',
        },
        context: {
          type: 'string',
          description: 'Additional context/notes (for add or update).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization (for add or update).',
        },
        query: {
          type: 'string',
          description: 'Search query (for search action).',
        },
        cascade: {
          type: 'boolean',
          description: 'Cascade to sub-goals (for abandon action).',
        },
      },
      required: ['action'],
    },
  },

  // ── 31. apex_cognitive_status ─────────────────────────────────
  {
    name: 'apex_cognitive_status',
    description:
      'Show cognitive architecture status: current cognitive phase, cycle quality, ACT-R activation stats, goal stack summary, production rule stats, and phase-appropriate next-step suggestions.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── 32. apex_self_benchmark ──────────────────────────────────────
  {
    name: 'apex_self_benchmark',
    description:
      'Run the self-benchmarking suite to measure APEX performance across recall accuracy, reflection quality, skill reuse, planning effectiveness, and consolidation efficiency. Returns composite and per-dimension scores. Use "run" to execute benchmarks, "history" to view past results, "compare" to diff two results, or "seed" to generate synthetic test data.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'history', 'compare', 'seed'],
          description: 'Action to perform: "run" executes the benchmark suite, "history" shows past results, "compare" diffs two results, "seed" generates synthetic episodes.',
        },
        baselineId: {
          type: 'string',
          description: 'Baseline result ID (for compare action).',
        },
        candidateId: {
          type: 'string',
          description: 'Candidate result ID (for compare action).',
        },
        seedCount: {
          type: 'number',
          description: 'Number of synthetic episodes to generate (for seed action, default: 20).',
        },
      },
      required: ['action'],
    },
  },

  // ── 33. apex_self_modify ─────────────────────────────────────────
  {
    name: 'apex_self_modify',
    description:
      'Self-improvement pipeline: analyze benchmark weak spots, propose config changes, evaluate proposals, and track modification history. Implements Darwin-Godel Machine pattern with strict performance gates (≥5% improvement required, no dimension may degrade >2%).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['analyze', 'evaluate', 'history', 'rollback-check', 'stats'],
          description: 'Action: "analyze" finds weak spots and proposes changes, "evaluate" tests a proposal, "history" shows past modifications, "rollback-check" checks if rollback needed, "stats" shows aggregate stats.',
        },
        benchmarkId: {
          type: 'string',
          description: 'Benchmark result ID to analyze (for analyze action).',
        },
        proposalId: {
          type: 'string',
          description: 'Proposal ID to evaluate (for evaluate action).',
        },
        baselineBenchmarkId: {
          type: 'string',
          description: 'Baseline benchmark ID (for evaluate action).',
        },
        candidateBenchmarkId: {
          type: 'string',
          description: 'Candidate benchmark ID after applying proposal (for evaluate action).',
        },
      },
      required: ['action'],
    },
  },

  // ── 34. apex_telemetry ───────────────────────────────────────────
  {
    name: 'apex_telemetry',
    description:
      'View real-time learning signals: passive telemetry, detected episodes, implicit rewards, and session summaries. No manual recording required — purely observational.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['summary', 'events', 'episodes', 'rewards', 'flush'],
          description: 'Action: "summary" shows session overview, "events" shows recent tool calls, "episodes" shows auto-detected episodes, "rewards" shows implicit reward signals, "flush" persists telemetry to disk.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of items to return (default: 20).',
        },
      },
      required: ['action'],
    },
  },
];
