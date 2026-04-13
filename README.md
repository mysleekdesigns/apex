# APEX — Adaptive Personal Experience eXtraction

A persistent learning layer for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). APEX is an MCP server that gives Claude persistent memory, self-reflection, and cross-project skill transfer — all running locally with zero API cost.

## What It Does

APEX remembers across sessions. When Claude encounters a bug it fixed last week, a pattern it learned in another project, or an approach that failed before, APEX surfaces that context automatically. Over time, Claude gets measurably better at tasks within your codebase.

### Memory & Retrieval
- **Hierarchical Memory** — 4-tier system (working, episodic, semantic, procedural) with ACT-R activation-based eviction
- **Semantic Vector Search** — HNSW index with hybrid retrieval (vector + BM25 + recency), `all-MiniLM-L6-v2` embeddings
- **Adaptive Query Understanding** — Automatic query classification, synonym expansion, multi-hop retrieval, and relevance feedback

### Learning & Reflection
- **Verbal Reinforcement Learning** — Reflexion-style self-critique with structured templates and verbal reward signals
- **Self-Reflection** — Micro/meso/macro reflection levels with quality tracking and auto-pruning
- **Skill Library** — Reusable patterns extracted from successful episodes, searchable by task similarity

### Planning & Reasoning
- **MCTS Planning** — Monte Carlo Tree Search with LM value functions, adaptive exploration, and tree persistence
- **World Model** — Action-effect graph with Bayesian updating, causal chain extraction, and counterfactual reasoning
- **Experience-Backed Planning** — Historical action trees with UCB1 scoring inform future decisions

### Self-Improvement
- **DSPy-Inspired Prompt Optimization** — A/B testing, automated prompt mutation, few-shot curation, regression detection
- **Self-Improving Agent Loop** — Self-benchmarking, automated modification proposals, performance-gated deployment with auto-rollback
- **Cognitive Architecture** — ACT-R activation, spreading activation, formal cognitive cycle, goal stack, production rules

### Collaboration & Ecosystem
- **Team Knowledge Sharing** — Proposal-review workflow, federated learning, conflict resolution via `.apex-shared/`
- **Cross-Project Learning** — Skills learned in one project transfer to others via `~/.apex/`
- **Real-Time Learning Signals** — Passive telemetry, automatic episode detection, implicit reward signals
- **Curriculum Engine** — Identifies skill gaps and suggests tasks targeting weak areas

## Architecture

```
Claude Code (terminal, Max/Pro plan)
       |
       |  MCP protocol (stdio)
       v
  APEX MCP Server (Node.js, zero API calls)
       |
  .apex-data/   (project memory)
  .apex-shared/  (team knowledge)
  ~/.apex/       (global skills)
```

APEX makes **zero LLM calls**. It stores, retrieves, and organizes data. Claude Code does all the reasoning — no extra API keys or token costs.

## Quick Start

```bash
# Clone and install
git clone https://github.com/mysleekdesigns/apex.git
cd apex
npm install

# Build
npm run build

# Add to your project's .mcp.json
{
  "mcpServers": {
    "apex": {
      "command": "node",
      "args": ["/path/to/apex/dist/mcp/server.js"]
    }
  }
}
```

Then in Claude Code, run:
```
apex_setup
```

APEX auto-detects your project type (Node, Python, Rust, Go, etc.) and initializes memory.

## MCP Tools (40)

### Core Memory
| Tool | Purpose |
|------|---------|
| `apex_recall` | Adaptive search across all memory tiers with query classification, expansion, and multi-hop |
| `apex_record` | Log a task attempt with actions and outcome |
| `apex_status` | Memory stats, learning curve, health check |
| `apex_consolidate` | Promote knowledge between memory tiers |
| `apex_setup` | Initialize APEX for a project |
| `apex_snapshot` | Create a named memory snapshot |
| `apex_rollback` | Restore from a previous snapshot |

### Reflection & Skills
| Tool | Purpose |
|------|---------|
| `apex_reflect_get` | Retrieve episode data organized for reflection |
| `apex_reflect_store` | Store insights from Claude's analysis |
| `apex_skills` | Search or list the learned skill library |
| `apex_skill_store` | Save a reusable pattern as a skill |
| `apex_plan_context` | Get experience-backed planning context |
| `apex_curriculum` | Get suggested tasks based on skill gaps |

### Planning & Reasoning
| Tool | Purpose |
|------|---------|
| `apex_goals` | Manage persistent goal hierarchy (add, list, complete, block, abandon) |
| `apex_cognitive_status` | Cognitive cycle phase, activation stats, goal summary |
| `apex_world_model` | Build, predict, query causal chains, run counterfactuals |
| `apex_foresight_predict/check/resolve` | Predict risks, check predictions, resolve outcomes |

### Self-Improvement
| Tool | Purpose |
|------|---------|
| `apex_self_benchmark` | Run standardized benchmark suite, compare generations |
| `apex_self_modify` | Analyze weak spots, evaluate and deploy improvements |
| `apex_prompt_optimize` | Run prompt optimization rounds, conclude experiments |
| `apex_prompt_module` | Register, swap, and A/B test prompt modules |
| `apex_arch_status/mutate/suggest` | Architecture search and parameter optimization |
| `apex_population_status/evolve` | Multi-agent population evolution |
| `apex_tool_propose/verify/list/compose` | Dynamic tool creation pipeline |

### Collaboration
| Tool | Purpose |
|------|---------|
| `apex_promote` | Promote a skill to global (cross-project) |
| `apex_import` | Import skills from another project |
| `apex_team_propose` | Propose skill/knowledge for team review |
| `apex_team_review` | Review pending team proposals |
| `apex_team_status` | Team learning stats and pending proposals |
| `apex_team_sync` | Ingest new shared team knowledge |
| `apex_team_log` | Team learning changelog |
| `apex_telemetry` | View session telemetry, detected episodes, implicit rewards |

## How It Works

**Session start:** Claude calls `apex_recall` with the current task. APEX classifies the query intent, expands it with related terms, and returns relevant past experience with adaptive retrieval weights. For low-confidence results, multi-hop retrieval automatically refines the search.

**During work:** Claude records episodes via `apex_record`. After fixing tricky bugs or completing tasks, it stores structured reflections. Implicit reward signals are derived from tool call patterns without manual recording.

**Over time:** Skills are extracted from repeated successes. Knowledge consolidates from working memory through episodic to semantic. The self-improvement loop benchmarks APEX's own performance and deploys parameter changes that pass quality gates. Cross-project skills promote to `~/.apex/` after proving useful in 3+ projects.

**Key properties:**
- Every memory entry carries a confidence score (0-1) and staleness tracking
- Referenced files are checked for changes — stale knowledge is flagged, not silently served
- Snapshots protect against bad reflections poisoning future sessions
- Memory has hard capacity limits at every tier — no unbounded growth
- Zod validation on all 40 tool inputs with structured error messages
- Atomic file operations (write-to-temp-then-rename) with SHA-256 checksums
- Concurrency protection via in-process async mutex with deadlock detection
- Transaction semantics with rollback on consolidation failure

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict, ESM) |
| Runtime | Node.js 20+ |
| Protocol | MCP via stdio |
| Testing | Vitest (1,100 tests across 74 files) |
| Embeddings | HNSW vector index + BM25 + SimHash hybrid; `all-MiniLM-L6-v2` via transformers.js |
| Storage | File-based JSON + binary in `.apex-data/` with atomic ops and checksums |
| Validation | Zod schemas for all tool inputs |

## Project Structure

```
src/
  mcp/          Server, tool definitions, handlers, dynamic descriptions
  memory/       4-tier memory, query classification, expansion, multi-hop, feedback
  reflection/   Verbal RL, structured templates, foresight engine
  planning/     MCTS, LM value functions, world model, counterfactual reasoning
  cognitive/    ACT-R activation, cognitive cycle, goal stack, production rules
  curriculum/   Replay buffer, difficulty estimation, skill extraction
  evolution/    Self-benchmark, self-modify, prompt optimization, architecture search
  integration/  Effectiveness tracking, telemetry, episode detection, implicit rewards
  team/         Knowledge tier, proposal workflow, federated learning
  utils/        Embeddings, HNSW index, similarity, file store, file locks
  benchmarks/   Performance, stress tests, retrieval quality
```

## Testing

```bash
npm test
```

1,100 tests across 74 files covering unit tests, integration tests, benchmarks, and stress tests.

## Research Foundation

Built on ideas from:
- **MemGPT/Letta** — OS-inspired memory hierarchy + vector retrieval
- **Reflexion** — Verbal reinforcement learning (91% HumanEval pass@1)
- **LATS** (ICML 2024) — MCTS + LM value functions
- **DSPy** (Stanford NLP) — Algorithmic prompt optimization
- **Darwin-Godel Machine** (Sakana AI) — Self-modifying agent code
- **ACT-R / SOAR** — Cognitive architecture design patterns for agents
- **Voyager** — Lifelong skill library + automatic curriculum

## License

MIT
