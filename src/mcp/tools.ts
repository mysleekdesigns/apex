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
];
