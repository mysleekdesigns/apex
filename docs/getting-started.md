# Getting Started with APEX

APEX (Adaptive Personal Experience eXtraction) is a persistent learning layer for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It gives Claude a memory that persists across sessions — so it remembers what worked, what failed, and what it learned in your projects.

APEX runs as a local MCP server. It makes **zero LLM API calls** and costs nothing beyond your existing Claude Code subscription (Max or Pro plan).

> **What's new:** APEX now includes semantic vector memory (HNSW indexing), MCTS-based planning, a cognitive architecture inspired by ACT-R/SOAR, self-improving agent loops, world model reasoning, team knowledge sharing, and adaptive query understanding — all running locally with zero API cost. See [What's Under the Hood](#whats-under-the-hood) for details.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Connecting APEX to Your Project](#connecting-apex-to-your-project)
- [Initializing APEX](#initializing-apex)
- [How APEX Works](#how-apex-works)
- [Core Workflow](#core-workflow)
- [Tool Reference](#tool-reference)
- [Memory Architecture](#memory-architecture)
- [Cross-Project Learning](#cross-project-learning)
- [Team Knowledge Sharing](#team-knowledge-sharing)
- [Advanced Features](#advanced-features)
- [What's Under the Hood](#whats-under-the-hood)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js 20+** — [Download here](https://nodejs.org/)
- **Claude Code** — installed and working in your terminal ([installation guide](https://docs.anthropic.com/en/docs/claude-code))
- **Claude Max or Pro plan** — APEX runs locally but requires Claude Code to do the reasoning

Verify your setup:

```bash
node --version   # Should be v20.x or higher
claude --version # Should show Claude Code version
```

---

## Installation

Clone the APEX repository and build it:

```bash
git clone https://github.com/mysleekdesigns/apex.git
cd apex
npm install
npm run build
```

That's it. APEX is now compiled in the `dist/` directory.

> **Tip:** Note the full path to the `dist/mcp/server.js` file — you'll need it in the next step. You can get it with `pwd` (e.g., `/Users/you/projects/apex/dist/mcp/server.js`).

---

## Connecting APEX to Your Project

APEX connects to Claude Code via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). You tell Claude Code where to find the APEX server by adding a `.mcp.json` file to your project root.

### Option A: Project-Level Configuration (Recommended)

Create a `.mcp.json` file in the root of the project where you want to use APEX:

```json
{
  "mcpServers": {
    "apex": {
      "command": "node",
      "args": ["/absolute/path/to/apex/dist/mcp/server.js"],
      "env": {
        "APEX_DATA_DIR": ".apex-data",
        "APEX_GLOBAL_DIR": "~/.apex"
      }
    }
  }
}
```

Replace `/absolute/path/to/apex/dist/mcp/server.js` with the actual path on your machine.

### Option B: User-Level Configuration (All Projects)

To make APEX available in every project, add the same configuration to your Claude Code user settings at `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "apex": {
      "command": "node",
      "args": ["/absolute/path/to/apex/dist/mcp/server.js"],
      "env": {
        "APEX_DATA_DIR": ".apex-data",
        "APEX_GLOBAL_DIR": "~/.apex"
      }
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APEX_DATA_DIR` | `.apex-data` | Where project-specific memory is stored (relative to project root) |
| `APEX_GLOBAL_DIR` | `~/.apex` | Where cross-project skills and global knowledge live |

---

## Initializing APEX

Once `.mcp.json` is in place, open Claude Code in your project directory. Claude will automatically start the APEX MCP server. Initialize APEX for your project:

```
apex_setup({ projectPath: "/path/to/your/project" })
```

Or simply ask Claude: *"Initialize APEX for this project."*

APEX will:
1. Create a `.apex-data/` directory in your project with subdirectories for episodes, memory, skills, reflections, metrics, and snapshots
2. Create `~/.apex/` (if it doesn't exist) for global cross-project storage
3. Scan your project to detect its tech stack (Node, Python, Rust, Go, etc.)
4. Register your project in the global project index

> **Note:** Add `.apex-data/` to your `.gitignore` — it contains local learning data, not source code.

---

## How APEX Works

Understanding the flow helps you get the most out of APEX:

```
Session Start
  Claude recalls relevant past experience (apex_recall)
       |
During Work
  Claude records what it tries and what happens (apex_record)
  Telemetry passively tracks tool usage patterns (automatic)
       |
After Tasks
  Claude reflects on outcomes (apex_reflect_get + apex_reflect_store)
  Reusable patterns are saved as skills (apex_skill_store)
       |
Memory Consolidation
  Knowledge promotes through memory tiers (apex_consolidate)
  ACT-R activation keeps frequently-used memories accessible
       |
Self-Improvement
  APEX benchmarks itself and proposes optimizations (apex_self_benchmark)
  World model refines causal understanding of actions (apex_world_model)
       |
Next Session
  Claude is "smarter" — past failures flagged, relevant skills suggested
```

The key insight: **APEX stores and retrieves data. Claude does all the reasoning.** This is why APEX has zero API cost — it's a pure data service.

---

## Core Workflow

### 1. Recall Before Working

At the start of a task, Claude should recall relevant context:

```
apex_recall({ query: "set up authentication middleware" })
```

APEX searches all memory tiers using **hybrid retrieval** — combining semantic vector similarity, BM25 keyword matching, and recency signals — and returns:
- Past episodes where similar tasks were attempted
- Known pitfalls and failure patterns
- Applicable skills from this project and globally
- Relevant causal chains from the world model

Behind the scenes, APEX classifies your query intent (error lookup, pattern search, skill search, planning, or exploratory) and adapts its retrieval strategy accordingly. Vague queries are automatically expanded with related terms.

### 2. Record Outcomes

After completing work (especially tricky fixes or new approaches), Claude records what happened:

```
apex_record({
  task: "Fix CORS headers in Express middleware",
  actions: [
    { type: "code_edit", description: "Added origin whitelist to cors config", success: true },
    { type: "command", description: "Ran integration tests", success: true }
  ],
  outcome: { success: true, description: "CORS issue resolved by whitelisting specific origins instead of using wildcard", duration: 45000 }
})
```

**What to record:** Bug fixes with non-obvious root causes, approaches that worked or failed, patterns you want to remember. **What to skip:** Routine file reads, trivial edits, anything forgettable.

> **Passive learning:** Even when you don't explicitly record, APEX's telemetry system passively tracks tool call patterns and timing. It detects natural task boundaries (like recall -> plan -> edit -> test sequences) and derives implicit reward signals from outcomes.

### 3. Reflect on Patterns

After a task or session, Claude can analyze what happened:

```
apex_reflect_get({ scope: "recent" })
```

Then store insights:

```
apex_reflect_store({
  level: "micro",
  content: "CORS wildcard (*) doesn't work with credentials. Must whitelist specific origins.",
  actionableInsights: ["Always use explicit origin whitelist when credentials are involved"]
})
```

APEX uses Reflexion-style structured templates to guide reflection quality. Insights are tracked for effectiveness — reflections that lead to better outcomes get promoted; low-value reflections are auto-pruned.

### 4. Save Reusable Skills

When Claude discovers a pattern that applies broadly:

```
apex_skill_store({
  name: "express-cors-credentials",
  description: "Configure CORS in Express when using cookies/auth headers",
  pattern: "1. Install cors package\n2. Create whitelist array from env\n3. Set origin to function that checks whitelist\n4. Set credentials: true",
  preconditions: ["Express.js project", "Authentication with cookies or headers"],
  tags: ["express", "cors", "security", "middleware"]
})
```

### 5. Consolidate Memory

Periodically (after significant work sessions), consolidate:

```
apex_consolidate()
```

This promotes working memory into longer-term storage and extracts patterns across episodes. Consolidation runs within a transaction — if anything goes wrong mid-process, all changes roll back automatically.

> **Auto-consolidation:** APEX also triggers background consolidation every 10 new episodes, so memory stays healthy even without manual intervention.

---

## Tool Reference

### Core Tools

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_recall` | Searches all memory tiers for relevant context | Start of tasks, before debugging |
| `apex_record` | Logs a task episode (actions + outcome) | After completing significant work |
| `apex_reflect_get` | Retrieves episode data organized for analysis | When reflecting on what happened |
| `apex_reflect_store` | Persists Claude's analysis as a reflection | After analyzing episodes |
| `apex_plan_context` | Returns past attempts, pitfalls, and skills for planning | Before planning complex tasks |
| `apex_skills` | Searches or lists the skill library | Before building something new |
| `apex_skill_store` | Saves a reusable pattern | When a generalizable approach is found |
| `apex_status` | Shows memory stats, learning curve, health | Checking system state |
| `apex_consolidate` | Promotes knowledge through memory tiers | End of work sessions |
| `apex_curriculum` | Suggests tasks based on identified skill gaps | Exploring what to practice |
| `apex_setup` | Initializes APEX for a project | First time using APEX in a project |

### Snapshot & Recovery

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_snapshot` | Creates a named checkpoint of memory state | Before risky operations or experiments |
| `apex_rollback` | Restores from a previous snapshot | When memory gets corrupted or polluted |

### Cross-Project

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_promote` | Promotes a project skill to `~/.apex/` (global) | When a skill applies beyond this project |
| `apex_import` | Imports skills from another project | Starting a project similar to an existing one |

### Foresight

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_foresight_predict` | Records a prediction before a multi-step task | Before complex multi-step work |
| `apex_foresight_check` | Checks execution divergence from prediction | Mid-task to catch drift |
| `apex_foresight_resolve` | Compares prediction vs actual outcome | After completing predicted work |

### Cognitive Architecture

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_goals` | Manages a persistent goal hierarchy (add, list, update, complete, block, abandon, search) | Tracking multi-session objectives |
| `apex_cognitive_status` | Shows current cognitive phase, quality metrics, activation stats, goal summary, and rule stats | Understanding system state at a deeper level |

### World Model & Causal Reasoning

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_world_model` | Builds/queries the action-effect graph, predicts outcomes, extracts causal chains, runs counterfactuals, compares strategies | Understanding *why* actions lead to outcomes |

### Self-Improvement

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_self_benchmark` | Runs APEX's internal benchmark suite (recall accuracy, reflection quality, skill reuse, planning, consolidation) | Measuring if APEX is actually helping |
| `apex_self_modify` | Analyzes weak spots and proposes safe config changes with performance-gated deployment | Tuning APEX's own behavior |

### Prompt Optimization

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_prompt_optimize` | Runs optimization rounds, views experiment status, concludes A/B tests | When tool descriptions could be more effective |
| `apex_prompt_module` | Registers, lists, hot-swaps, and manages modular prompt components | Fine-tuning how APEX communicates with Claude |

### Team Collaboration

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_team_propose` | Proposes a skill or knowledge entry for team sharing | When you've learned something the team should know |
| `apex_team_review` | Reviews and accepts/rejects pending team proposals | Curating shared team knowledge |
| `apex_team_status` | Shows team learning stats, contributor leaderboard, pending proposals | Monitoring team knowledge health |
| `apex_team_sync` | Ingests new content from `.apex-shared/` | Pulling team knowledge into your local APEX |
| `apex_team_log` | Shows the team knowledge changelog | Seeing what the team has learned recently |

### Telemetry & Observability

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_telemetry` | Shows session summary, recent events, detected episodes, implicit rewards | Understanding how APEX is being used |

### Multi-Agent & Evolution

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_population_status` | Shows agent population stats | Monitoring evolution progress |
| `apex_population_evolve` | Triggers one evolution cycle | Exploring strategy variations |
| `apex_tool_propose` | Proposes new tools from successful patterns | When recurring patterns emerge |
| `apex_tool_verify` | Verifies and scores proposed tools | Validating tool proposals |
| `apex_tool_list` | Lists created tools with mastery metrics | Reviewing tool library |
| `apex_tool_compose` | Creates composite tools from sequences | Combining tool chains |
| `apex_arch_status` | Shows architecture config and history | Checking system configuration |
| `apex_arch_mutate` | Proposes and applies config mutations | Tuning system behavior |
| `apex_arch_suggest` | Gets improvement suggestions | When performance could be better |

---

## Memory Architecture

APEX uses a 4-tier memory system inspired by cognitive science (ACT-R, SOAR) and OS memory management:

### Tier 1: Working Memory
- **Capacity:** 10 entries (ring buffer)
- **Purpose:** Current session context
- **Behavior:** When full, oldest entries overflow to episodic memory
- **Analogy:** Your "mental scratchpad" — recent, fast, limited

### Tier 2: Episodic Memory
- **Capacity:** 1,000 entries
- **Purpose:** Specific past experiences (task attempts, bug fixes, etc.)
- **Behavior:** ACT-R activation-based eviction — frequently and recently accessed memories stay, cold ones are pruned
- **Analogy:** "I remember fixing that bug last Tuesday" — concrete, timestamped episodes

### Tier 3: Semantic Memory
- **Capacity:** 5,000 entries
- **Purpose:** Generalized knowledge extracted from episodes
- **Behavior:** Deduplication of similar entries, hybrid similarity-based retrieval (vector + keyword + recency)
- **Analogy:** "React hooks need cleanup functions for subscriptions" — abstract knowledge

### Tier 4: Procedural Memory
- **Capacity:** Unlimited (skill library)
- **Purpose:** Reusable patterns and step-by-step approaches
- **Behavior:** Success rates and confidence tracked per skill, usage-based ranking. High-confidence skills (>0.8, >10 uses) are converted into production rules for O(1) pattern matching
- **Analogy:** "Here's how to set up a CI pipeline" — recipes and playbooks

### How Memory Flows

```
Working Memory (current session)
      | overflow
      v
Episodic Memory (concrete experiences)
      | consolidation (patterns extracted)
      v
Semantic Memory (generalized knowledge)
      | skill extraction (reusable patterns)
      v
Procedural Memory (skill library)
      | high confidence + high usage
      v
Production Rules (O(1) instant matching)
```

### Memory Signals

Every memory entry carries:
- **ACT-R Activation** — `B_i = ln(sum(t_j^(-d)))` where `t_j` is time since the jth access and `d` is decay (~0.5). This replaces simple heat scores with a psychologically-grounded model of memory access
- **Spreading Activation** — when a memory is recalled, semantically related memories get an activation boost (configurable spread factor, default 0.3)
- **Confidence score** (0-1) — how reliable this knowledge is
- **Staleness tracking** — files referenced by a memory are checked for changes; stale knowledge is flagged

### How Retrieval Works

APEX uses **hybrid retrieval** combining three signals:

| Signal | Default Weight | What It Measures |
|--------|---------------|------------------|
| Vector similarity (HNSW) | 0.6 | Semantic meaning via `all-MiniLM-L6-v2` embeddings |
| BM25 keyword matching | 0.3 | Exact term overlap with TF-IDF weighting |
| Recency | 0.1 | How recently the memory was created or accessed |

These weights adapt based on query intent. An error lookup boosts BM25 to 0.6 for exact matching. A planning query boosts vector similarity to 0.6 for broader semantic reach. Weights are also tunable via architecture search.

**Performance:** Sub-100ms recall at 10,000+ entries. Embedding runs at ~30ms per query using a cached `all-MiniLM-L6-v2` model (23MB, loaded lazily on first use). Falls back gracefully to keyword-only retrieval if the model fails to load.

---

## Cross-Project Learning

APEX supports learning that transfers between projects.

### Two Storage Locations

```
~/.apex/                     (global — shared across all projects)
  skills/                    Universal skills
  knowledge/                 Language/framework knowledge
  projects-index.json        Registry of all APEX-enabled projects
  profile.json               User learning profile

your-project/.apex-data/     (project-specific)
  episodes/                  Task history for this project
  memory/                    Project memory
  skills/                    Project-specific skills
  reflections/               Error patterns
  metrics/                   Learning curves
```

### Skill Promotion

Skills automatically promote to global after proving useful in **3+ different projects**. You can also promote manually:

```
apex_promote({ skillId: "express-cors-credentials" })
```

### Importing Skills

Starting a new project similar to an existing one? Import its skills:

```
apex_import({ source: "/path/to/similar-project" })
```

### How Recall Searches Both

When you call `apex_recall`, APEX:
1. Classifies your query intent (error lookup, pattern search, skill search, planning, or exploratory)
2. Expands vague queries with related terms from a learned synonym map
3. Searches project `.apex-data/` first (highest relevance)
4. Searches global `~/.apex/` second (broader knowledge)
5. Merges results, deduplicates, and ranks by combined score
6. Tags each result with its source (project vs global)
7. For complex queries, performs multi-hop retrieval — first-pass results inform a refined second query

---

## Team Knowledge Sharing

When multiple developers work on the same project, each can run their own APEX instance and share distilled knowledge through a Git-tracked shared tier.

### How It Works

```
Developer A's APEX                   Developer B's APEX
  .apex-data/ (private)               .apex-data/ (private)
       |                                    |
       | apex_team_propose                  | apex_team_sync
       v                                    v
  .apex-shared/ (Git-tracked, shared via normal Git workflow)
    skills/              Shared skill library
    knowledge/           Shared knowledge base
    error-taxonomy/      Shared error patterns
    proposals/           Pending proposals for review
```

### Quick Start

1. **Propose** something you've learned:
   ```
   apex_team_propose({ type: "skill", content: { name: "fix-n+1-queries", ... } })
   ```

2. **Review** what teammates have proposed:
   ```
   apex_team_review({ proposalId: "...", action: "accept" })
   ```

3. **Sync** to pull accepted knowledge into your local APEX:
   ```
   apex_team_sync()
   ```

### Privacy Boundary

Raw episodes (your specific task history) are **never** shared. Only distilled knowledge — skills, patterns, error taxonomies — enters the shared tier. This is enforced at the architecture level.

### Conflict Resolution

When team knowledge conflicts with your personal knowledge, APEX presents both with full provenance (who proposed it, when, from which project). You can configure precedence: team-first or personal-first.

---

## Advanced Features

### Foresight Reflection

Before multi-step tasks, Claude can record a prediction of what will happen, then compare it to reality:

```
apex_foresight_predict({
  task: "Migrate database from SQLite to PostgreSQL",
  predictedSteps: ["Update connection config", "Modify queries for PG syntax", "Run migration", "Update tests"],
  predictedOutcome: "Successful migration with minor query syntax fixes"
})
```

During execution, check for drift:

```
apex_foresight_check({ predictionId: "..." })
```

After completion, resolve the prediction vs reality:

```
apex_foresight_resolve({ predictionId: "...", actualOutcome: "..." })
```

This builds calibration — over time, Claude becomes better at predicting task complexity and pitfalls.

### Goal Tracking

APEX maintains a persistent goal hierarchy that spans sessions:

```
apex_goals({ action: "add", description: "Complete auth refactor", priority: "high" })
```

Goals support sub-goals, priorities, deadlines, and status tracking (active, blocked, completed, abandoned). Active goals are automatically surfaced in `apex_plan_context` responses so Claude stays aware of the bigger picture.

### World Model & Causal Reasoning

APEX builds a directed action-effect graph from your episode history. Instead of just knowing "what worked before," it understands *why*:

```
apex_world_model({ action: "predict", plan: ["update schema", "run migration", "update queries"] })
```

This traces your plan through the causal graph, predicting likely outcomes and flagging high-risk steps. You can also run counterfactual analysis:

```
apex_world_model({ action: "counterfactual", episodeId: "...", alternativeAction: "..." })
```

*"If I had done X instead of Y, what would likely have happened?"*

### Self-Improvement Loop

APEX can benchmark and tune itself:

```
apex_self_benchmark({ action: "run" })
```

This measures five dimensions: recall accuracy, reflection quality, skill reuse rate, planning effectiveness, and consolidation efficiency. Based on results, APEX proposes targeted config changes:

```
apex_self_modify({ action: "analyze" })
```

**Safety gates:** Modifications are only applied if they improve the composite benchmark score by >5% with no individual dimension degrading by >2%. If performance drops >10% from the best-ever score, APEX auto-rolls back and alerts you.

### Prompt Auto-Optimization

APEX's tool descriptions aren't static — they evolve based on effectiveness:

```
apex_prompt_optimize({ action: "run" })
```

This uses DSPy-inspired techniques: A/B testing of prompt variants, automated mutation strategies (rephrase, simplify, elaborate, adjust emphasis, add/remove examples), and statistical significance testing before declaring winners. A regression detector auto-rolls back any change that degrades performance.

### Architecture Search

APEX can adapt its own configuration based on performance:

```
apex_arch_suggest()       # Get improvement suggestions
apex_arch_mutate({...})   # Apply a configuration change
apex_arch_status()        # Review configuration and history
```

Tunable parameters include reflection frequency, memory capacities, exploration rates, retrieval weights, and which subsystems are active.

### Tool Creation (Voyager-Inspired)

When Claude identifies recurring patterns, it can propose new reusable tools:

```
apex_tool_propose({
  name: "setup-express-auth",
  description: "Standard Express authentication setup",
  pattern: "...",
  sourceEpisodes: ["episode-id-1", "episode-id-2"]
})
```

Proposed tools are verified and scored before becoming part of the library.

### Telemetry & Passive Learning

APEX passively observes tool usage patterns without requiring explicit recording:

```
apex_telemetry({ action: "summary" })
```

The telemetry system:
- **Tracks tool call sequences** — which tools are called, in what order, with what timing
- **Detects natural episodes** — recognizes patterns like recall -> plan -> edit -> test as coherent task units
- **Derives implicit rewards** — test passes after code changes, skill reuse, successful recall-then-record cycles all generate positive signals; repeated failures and slow execution generate negative signals
- **Summarizes sessions** — tools used, outcomes, time spent, errors encountered

This means APEX learns even from sessions where you forget to call `apex_record`.

---

## What's Under the Hood

This section is for those who want to understand the technical foundations. You don't need to know any of this to use APEX effectively.

### Retrieval Engine

APEX implements a three-signal hybrid retrieval pipeline:

1. **HNSW Vector Index** — Hierarchical Navigable Small World graph for approximate nearest neighbor search. Embeddings are generated by `all-MiniLM-L6-v2` (23MB transformer model, loaded lazily). Supports cosine, euclidean, and dot product distance metrics. Sub-linear retrieval at 10K+ entries (<50ms)
2. **BM25 Scoring** — Term frequency-inverse document frequency for keyword matching. Handles exact error messages and technical terms that embedding models sometimes miss
3. **Recency Signal** — Time-decay factor ensuring recent memories surface naturally

Weights are configurable and adapt per query type via the query classifier.

### Cognitive Architecture

Inspired by ACT-R (Carnegie Mellon) and SOAR (University of Michigan):

- **ACT-R Activation:** Memory retrieval uses `B_i = ln(sum(t_j^(-d)))` — the same base-level learning equation from cognitive psychology. Spreading activation boosts related memories when one is recalled
- **Cognitive Cycle:** A formal perceive -> decide -> act -> learn loop maps all MCP tools to phases. Tracks cycle quality and phase transitions
- **Production Rules:** High-confidence, frequently-used skills are compiled into if-then rules for instant O(1) pattern matching, bypassing embedding search entirely
- **Goal Stack:** Persistent, hierarchical goal tracking with sub-goals, priorities, deadlines, and cascade operations

### Planning Engine

Based on LATS (Language Agent Tree Search, ICML 2024):

- **MCTS (Monte Carlo Tree Search):** Full UCB1 selection, expansion with thresholds, simulation via historical outcomes, and backpropagation of real episode results
- **LM Value Functions:** Structured prompts for Claude to evaluate candidate plans (scored 0-1), with a Jaccard-based value cache and accuracy tracking
- **Adaptive Exploration:** Per-domain learned exploration constants replace fixed `sqrt(2)`. Exploration decays as confidence increases
- **Tree Persistence:** Promising subtrees persist across sessions. Confidently bad branches (avgValue < 0.2, visits > 5) are auto-pruned. Similar nodes are compacted to save memory

### Safety & Robustness

- **Input Validation:** All tool inputs validated by Zod schemas with structured field-level error messages
- **Atomic File Operations:** Write-to-temp-then-rename pattern with SHA-256 checksums and `.bak` backups
- **Concurrency Protection:** In-process async mutex with FIFO queuing and deadlock detection
- **Transaction Semantics:** Consolidation is wrapped in transactions with `structuredClone` checkpoints and automatic rollback on failure
- **Memory Bounds:** Soft and hard limits with tier-specific eviction. Alerts at 80% capacity. Graceful degradation under pressure
- **Audit Log:** Append-only JSONL log of all memory mutations with auto-rotation

### Verbal Reinforcement Learning

Based on Reflexion (NeurIPS 2023):

- **Structured Templates:** Actor-evaluator-self-reflection format: what happened, root cause, what to try next, confidence
- **Verbal Rewards:** Episode outcomes are converted to natural language reward signals and stored as first-class semantic memory entries (e.g., *"When doing X, approach Y failed because Z. Next time try W."*)
- **Contrastive Pairs:** Automatically generates failed-vs-successful comparisons for the same task type
- **Quality Tracking:** Measures whether applying a reflection actually improved subsequent success rates. Auto-prunes ineffective reflections (quality < 0.1 after 5+ uses)

### Benchmarking Framework

Adapted from the Letta LoCoMo benchmark:

- **Recall Accuracy:** Tests at depths of 10, 100, 500, and 1,000 entries. Measures recall@1/5/10 and MRR
- **Skill Transfer:** Learns skills in project A, measures applicability in project B, including cross-language transfer
- **Reflection Quality:** Tracks whether reflections improve next-attempt success rates
- **Consolidation Loss:** Measures information preservation through memory tier promotions
- **Performance Gates:** Recall <100ms at 10K entries, embedding <50ms per query

### Research Foundations

| System | Source | Key Innovation |
|--------|--------|----------------|
| MemGPT/Letta | arxiv:2310.08560 | OS-inspired memory hierarchy + vector retrieval |
| Reflexion | arxiv:2303.11366 | Verbal reinforcement learning (91% HumanEval) |
| LATS | arxiv:2310.04406 (ICML 2024) | MCTS + LM value functions |
| Voyager | MineDojo (2023) | Lifelong skill library + automatic curriculum |
| DSPy | Stanford NLP | Algorithmic prompt optimization (20-40% improvement) |
| Darwin-Godel Machine | Sakana AI (2025) | Self-modifying agent code (17-53% SWE-bench improvement) |
| ACT-R | Carnegie Mellon / ACM HAI 2026 | Psychologically grounded memory activation |
| SOAR | University of Michigan (2025) | Cognitive design patterns for agents |

---

## Configuration

### Project Configuration

After `apex_setup`, APEX creates `.apex-data/config.json` with project-specific settings. The defaults work well for most projects.

Key configurable values:

| Setting | Default | Description |
|---------|---------|-------------|
| `memoryLimits.working` | 10 | Working memory capacity |
| `memoryLimits.episodic` | 1,000 | Episodic memory capacity |
| `memoryLimits.semantic` | 5,000 | Semantic memory capacity |
| `explorationRate` | Varies | Balance between exploiting known approaches and exploring new ones |
| `embeddingLevel` | `"auto"` | Embedding strategy: `"fast"` (keyword/hash), `"full"` (transformers.js), or `"auto"` |
| `retrievalWeights.vector` | 0.6 | Weight for semantic vector similarity in hybrid retrieval |
| `retrievalWeights.bm25` | 0.3 | Weight for BM25 keyword matching |
| `retrievalWeights.recency` | 0.1 | Weight for recency signal |
| `activationDecay` | 0.5 | ACT-R memory decay parameter (`d` in the activation equation) |
| `spreadingActivation` | 0.3 | Activation boost for semantically related memories |
| `consolidationThreshold` | 10 | Number of new episodes before auto-consolidation triggers |

### Adding CLAUDE.md Instructions

For the best experience, add APEX instructions to your project's `CLAUDE.md` file. This tells Claude **when and how** to use APEX tools. You can copy the instructions from the [APEX repository's CLAUDE.md](https://github.com/mysleekdesigns/apex/blob/main/CLAUDE.md) or adapt them to your workflow.

The key behaviors to instruct:
1. **Recall before working** — query memory at the start of complex tasks
2. **Record significant outcomes** — log non-trivial results
3. **Check memory before debugging** — search for known error patterns
4. **Search skills before building** — reuse existing patterns
5. **Reflect on completion** — extract insights from sessions
6. **Consolidate periodically** — maintain memory health

### Hooks (Optional)

You can configure Claude Code hooks to automate APEX interactions. See the [Hooks Guide](./hooks-guide.md) for details on auto-triggering reflection on session end, recording tool outcomes automatically, and more.

---

## Troubleshooting

### APEX tools not appearing in Claude Code

- Verify `.mcp.json` is in your project root (or settings in `~/.claude/settings.json`)
- Check that the path to `dist/mcp/server.js` is absolute and correct
- Ensure you've run `npm run build` in the APEX directory
- Restart Claude Code to reload MCP servers

### "APEX not initialized" errors

Run `apex_setup` in your project. This creates the `.apex-data/` directory structure.

### Memory seems stale or wrong

APEX tracks file changes and flags stale knowledge. If memory is clearly wrong:

```
apex_snapshot({ name: "before-cleanup" })  # Safety net
apex_consolidate()                          # Re-organize memory
```

If memory is badly corrupted, roll back to a known good state:

```
apex_rollback({ latest: true })
```

### Self-improvement made things worse

APEX has automatic rollback safety. If you suspect a self-modification degraded performance:

```
apex_self_modify({ action: "rollback-check" })
```

This checks if current performance is >10% below best-ever and recommends rollback if so. You can also use snapshots:

```
apex_rollback({ latest: true })
```

### Build errors

```bash
cd /path/to/apex
rm -rf dist node_modules
npm install
npm run build
```

### Embedding model won't load

APEX uses `all-MiniLM-L6-v2` (23MB) for semantic embeddings. If it fails to load (network issues, disk space), APEX automatically falls back to keyword-only retrieval. No action needed — it degrades gracefully. To retry loading:

```bash
cd /path/to/apex
npm run build  # Re-downloads model dependencies
```

### Checking system health

```
apex_status()
```

This shows memory stats, skill counts, learning curve data, memory bounds usage, and any health warnings.

For deeper diagnostics:

```
apex_cognitive_status()   # Cognitive cycle and activation stats
apex_telemetry({ action: "summary" })  # Session telemetry
apex_self_benchmark({ action: "history" })  # Benchmark trends
```

---

## Next Steps

- Read the [Hooks Guide](./hooks-guide.md) to automate APEX in your workflow
- Explore `apex_curriculum` to find skill gaps and practice areas
- Use `apex_promote` to share skills across projects
- Set up `apex_team_propose` / `apex_team_sync` for team knowledge sharing
- Run `apex_self_benchmark` to see how APEX is performing
- Use `apex_goals` to track multi-session objectives
- Run `apex_status` periodically to monitor your learning progress

For questions or issues, visit the [GitHub repository](https://github.com/mysleekdesigns/apex).
