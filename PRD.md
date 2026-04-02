# APEX: Adaptive Personal Experience eXtraction
## Product Requirements Document

**Version:** 0.5.1
**Date:** 2026-04-02
**Status:** Phase 1 Complete — Foundation & MCP Server Scaffold

---

## Vision

Build the most advanced, performant, and memory-efficient agent self-learning system that continuously improves from its own experience without human intervention. APEX runs as a **zero-API-cost MCP server** that integrates directly with **Claude Code in the terminal** (Max plan compatible — no Anthropic API key required). Claude Code is the LLM brain; APEX is the persistent memory and learning infrastructure.

### Key Architectural Constraint: LLM-Free Data Layer

APEX makes **zero LLM API calls**. All intelligence comes from Claude Code itself (running on your existing Max/Pro plan). APEX is a pure stateful data service:

- **Stores** episodes, memories, skills, reflections, metrics
- **Retrieves** relevant context via embedding similarity + heat scoring
- **Structures** data for Claude to reason over (but Claude does the reasoning)
- **Tracks** learning progress and curriculum state

When reflection or planning is needed, APEX returns raw data to Claude Code, Claude reasons over it in-conversation, and sends the results back to APEX for storage. This means:
- No API keys needed beyond your Claude Code subscription
- No token costs beyond your normal Claude Code usage
- No rate limiting concerns
- Full power of whatever Claude model your plan provides

### Research Foundation

| Research | Key Insight | Our Application |
|----------|------------|-----------------|
| **MemoryOS** (Kang et al., 2025) | OS-inspired hierarchical memory with heat-based eviction | 4-tier memory with segment-paged storage |
| **SaMuLe** (Ge et al., 2025) | Multi-level reflection (micro/meso/macro) from failures | 3-level reflection engine with error taxonomy |
| **Voyager** (Wang et al., 2023) | Skill library + curriculum learning for lifelong learning | Procedural memory + automatic curriculum |
| **LATS** (Zhou et al., 2024) | Monte Carlo Tree Search for LLM agent planning | MCTS-based action selection with experience-backed values |
| **Self-Evolving Agents Survey** (Gao et al., 2025) | What/When/How to evolve taxonomy | Unified evolution engine across all dimensions |

---

## Implementation Progress

| Phase | Name | Status | Notes |
|-------|------|--------|-------|
| **1** | Foundation & MCP Server Scaffold | ✅ **Complete** | MCP server, 15 tool defs, types, utilities, project scanner. Handlers stubbed. |
| **2** | Hierarchical Memory System | 📋 Not started | 4-tier memory, staleness detection, snapshots |
| **3** | Multi-Level Reflection Engine | 📋 Not started | Micro/meso/macro data assemblers, reflection storage |
| **4** | MCTS Planning Engine | 📋 Not started | Experience-backed plan context, action history tree |
| **5** | Curriculum & Experience Replay | 📋 Not started | Difficulty estimation, curriculum generation, skill extraction |
| **6** | Evolution Engine | 📋 Not started | Self-evaluation, knowledge distillation, metrics |
| **7** | Cross-Project Learning | 📋 Not started | Global store, skill promotion, import/export |
| **8** | Hooks, CLAUDE.md & E2E Integration | 📋 Not started | Hooks, CLAUDE.md effectiveness tracking, smoke tests |
| **9** | Testing & Hardening | 📋 Not started | Unit tests, integration tests, benchmarks |
| **10** | Advanced Features (Post-MVP) | 📋 Not started | Foresight reflection, multi-agent, tool creation |
| **11** | Team Learning & GitHub Sharing | 📋 Not started | `.apex-shared/`, PR-based skill proposals, team memory tier |

---

## Claude Code Integration Model

APEX is **not** a standalone agent. It is a **learning layer for Claude Code** — an MCP server + hooks + CLAUDE.md instructions that give Claude persistent, evolving memory and self-improvement across terminal sessions.

### How It Works

```
  Claude Code (terminal, Max plan)
       |
       |  MCP protocol (stdio)
       v
  +---------------------+       +-------------------+
  |  APEX MCP Server    |<----->| .apex-data/       |
  |  (Node.js, no API)  |       | (project memory)  |
  |                     |       +-------------------+
  |  20 tools:          |
  |   apex_recall       |       +-------------------+
  |   apex_record       |<----->| ~/.apex/          |
  |   apex_reflect_get  |       | (global skills +  |
  |   apex_reflect_store|       |  cross-project    |
  |   apex_plan_context |       |  knowledge)       |
  |   apex_skills       |       +-------------------+
  |   apex_skill_store  |
  |   apex_status       |
  |   apex_consolidate  |
  |   apex_curriculum   |
  |   apex_setup        |
  |   apex_snapshot     |
  |   apex_rollback     |
  |   apex_promote      |
  |   apex_import       |
  |   apex_team_*  (x5) |       +-------------------+
  +---------------------+<----->| .apex-shared/     |
                                | (git-committed    |
                                |  team knowledge)  |
                                +-------------------+
```

### Integration Points

| Integration | Mechanism | Purpose |
|-------------|-----------|---------|
| **MCP Server** | `.mcp.json` entry, stdio transport | Expose APEX tools to Claude Code |
| **CLAUDE.md** | Project-level instructions | Tell Claude when/how to use APEX tools |
| **Hooks** | `settings.json` hook entries | Auto-trigger reflection on session end, load context on start |
| **Project Data** | `.apex-data/` in project root | Project-specific memory, skills, metrics |
| **Global Data** | `~/.apex/` in home dir | Cross-project skills, universal knowledge, user profile |

### MCP Tools Exposed to Claude Code

All tools are pure data operations — no LLM calls, sub-millisecond to low-millisecond latency.

| Tool | Description | LLM Call? |
|------|-------------|-----------|
| `apex_recall` | Query all memory tiers for relevant context given a task/question | No — embedding similarity search |
| `apex_record` | Record an episode (task attempted, actions taken, outcome) | No — structured data write |
| `apex_reflect_get` | Retrieve raw episode data for Claude to reflect on, organized by level (micro/meso/macro) | No — data retrieval + grouping |
| `apex_reflect_store` | Store Claude's reflection output (insights, error taxonomy, strategies) | No — structured data write |
| `apex_plan_context` | Retrieve experience-informed context for planning (past attempts, relevant skills, known pitfalls) | No — data retrieval |
| `apex_skills` | List, retrieve, or search the learned skill library | No — index lookup |
| `apex_skill_store` | Store a new skill or update an existing one (extracted by Claude) | No — structured data write |
| `apex_status` | Show memory stats, learning curve, skill count, recent reflections | No — aggregation query |
| `apex_consolidate` | Force memory tier consolidation (Working -> Episodic -> Semantic) | No — data reorganization |
| `apex_curriculum` | Get next suggested task based on skill gaps and difficulty progression | No — scoring algorithm |
| `apex_setup` | Initialize APEX for a new project (scan project, create `.apex-data/`, link global store) | No — file system ops |
| `apex_snapshot` | Create a named snapshot of current memory state | No — file copy |
| `apex_rollback` | Restore memory from a previous snapshot | No — file copy |
| `apex_promote` | Promote a project skill to global `~/.apex/` (cross-project sharing) | No — file copy |
| `apex_import` | Import skills/knowledge from another project's `.apex-data/` or a shared export | No — file read + merge |
| `apex_team_propose` | Propose a skill for team sharing (creates branch + PR) | No — git + file ops |
| `apex_team_review` | Retrieve a pending proposal for Claude to review | No — git + file read |
| `apex_team_status` | Team learning stats: shared skills, proposals, contributors | No — file aggregation |
| `apex_team_sync` | Ingest new `.apex-shared/` content after git pull | No — file index update |
| `apex_team_log` | Team learning changelog | No — file read |

### Session Lifecycle (LLM-Free APEX Pattern)

```
SESSION START
  1. Claude Code launches, APEX MCP server starts (pure Node.js, no API keys)
  2. CLAUDE.md instructs Claude: "Use apex_recall at the start of complex tasks"
  3. Claude calls apex_recall("build a REST API")
     -> APEX returns: relevant skills, past errors, strategies (data only, no LLM call)

DURING SESSION
  4. Claude works on the task normally
  5. For complex decisions, Claude calls apex_plan_context("deploy strategy")
     -> APEX returns: past attempts at similar tasks, known pitfalls, relevant skills
     -> Claude reasons over this context itself and decides (no extra LLM cost)
  6. Claude calls apex_record after subtasks (what was tried, what happened)

REFLECTION (triggered by Claude or CLAUDE.md instructions)
  7. Claude calls apex_reflect_get("recent") 
     -> APEX returns: grouped episode data (micro: this episode, meso: similar tasks, macro: error clusters)
  8. Claude analyzes the data IN-CONVERSATION and generates reflections
  9. Claude calls apex_reflect_store(reflections) -> APEX persists to Semantic Memory
  10. Claude calls apex_skill_store(skill) if a reusable pattern was identified
  11. Claude calls apex_consolidate -> APEX reorganizes memory tiers

NEXT SESSION
  12. Claude starts fresh but apex_recall returns enriched context
  13. Previously failed approaches are flagged with reflections attached
  14. Learned skills are suggested for matching task patterns
  15. Claude is effectively "smarter" about this project without any extra API cost
```

### What Claude Code Does vs What APEX Does

| Responsibility | Who | Cost |
|---------------|-----|------|
| Reasoning, planning, code generation | **Claude Code** (Max plan) | Included in subscription |
| Analyzing failures, generating reflections | **Claude Code** (in-conversation) | Included in subscription |
| Extracting skills from patterns | **Claude Code** (in-conversation) | Included in subscription |
| Storing & retrieving memories | **APEX MCP** (pure data ops) | Free (local compute) |
| Embedding computation | **APEX MCP** (local model or hash-based) | Free (local compute) |
| Memory consolidation & eviction | **APEX MCP** (algorithms) | Free (local compute) |
| Tracking metrics & learning curves | **APEX MCP** (aggregation) | Free (local compute) |

---

## Architecture Overview

```
                    Claude Code (terminal)
                           |
                     MCP (stdio)
                           |
                +---------------------+
                |   APEX MCP Server    |
                |   (tool handlers)    |
                +---------------------+
                    |            |
          +---------+----------+---------+
          |         |          |         |
    +---------+ +--------+ +--------+ +----------+
    | Memory  | |Reflect | |Planning| |Evolution |
    | System  | |Engine  | |Engine  | |Engine    |
    +---------+ +--------+ +--------+ +----------+
    | Working | | Micro  | | MCTS   | |Curriculum|
    | Episodic| | Meso   | | UCB1   | |Skill Ext.|
    | Semantic| | Macro  | | Value  | |Self-Eval |
    |Procedurl| | Merge  | | Est.   | |Loop Ctrl |
    +---------+ +--------+ +--------+ +----------+
          \         |          |         /
           \        |          |        /
            +---------------------------+
            |  Experience Replay Buffer  |
            |  (prioritized ring buffer) |
            +---------------------------+
                        |
            +---------------------------+
            |    Persistence Layer       |
            +---------------------------+
            |  .apex-data/ (project)    |
            |  ~/.apex/    (global)     |
            +---------------------------+
```

---

## Cross-Cutting Concerns

### Two-Tier Storage: Global + Project

Every APEX installation has two data stores that work together:

```
~/.apex/                          (global — shared across all projects)
  skills/                         universal skills (e.g., "how to write good tests")
  knowledge/                      language/framework knowledge (e.g., "TypeScript patterns")
  profile.json                    user learning profile, preferences
  projects-index.json             registry of all APEX-enabled projects

<project>/.apex-data/             (project-specific)
  episodes/                       task execution history for this project
  memory/                         project-specific episodic + semantic memory
  skills/                         project-specific skills (e.g., "this project's deploy flow")
  reflections/                    project-specific error taxonomy
  metrics/                        learning curve data
  config.json                     project APEX settings
```

**Skill promotion flow:** When a skill succeeds in 3+ different projects, it's automatically promoted from project-level to global. When a project-level skill conflicts with a global one, the project-level wins (local override).

**Query flow for `apex_recall`:**
1. Search project `.apex-data/` first (highest relevance)
2. Search global `~/.apex/` second (broader knowledge)
3. Merge results, deduplicate, rank by combined score
4. Tag each result with its source (project vs global)

### Confidence Model

Every memory entry and skill carries a **confidence score** (0.0 to 1.0):

```
confidence = f(usage_count, success_rate, recency, corroboration)

where:
  usage_count   → more uses = higher confidence (log scale, saturates at ~50)
  success_rate  → % of times this knowledge led to good outcomes
  recency       → recent validations count more (exponential decay)
  corroboration → confirmed by multiple independent episodes = boost
```

Confidence affects behavior:
- **< 0.3:** Shown as "tentative" — Claude told this is uncertain
- **0.3–0.7:** Shown normally with confidence indicator
- **> 0.7:** Shown as "established" — high-trust knowledge
- Skills below 0.2 confidence are auto-archived (not deleted, just hidden)

### Knowledge Staleness & Git-Aware Invalidation

Learned knowledge can become harmful when the codebase changes. APEX detects this:

- **File-hash tracking:** Skills and memories reference the files they were learned from. On `apex_recall`, APEX checks if those files have changed (via git status / mtime).
- **Staleness flag:** If referenced files changed since the knowledge was created, the result is tagged `[STALE — source files changed]` so Claude knows to verify before trusting it.
- **Branch awareness:** Knowledge learned on a feature branch is tagged with that branch. Skills from deleted/merged branches are candidates for promotion or archival.
- **Refactor detection:** If a function/class referenced in a skill no longer exists (quick grep on recall), the skill is flagged `[POSSIBLY INVALID]`.

### Lightweight Embedding Strategy

`transformers.js` is powerful but heavy (~500MB RAM, seconds to load). APEX uses a tiered approach:

| Tier | Method | Speed | Quality | RAM | When |
|------|--------|-------|---------|-----|------|
| **L0** | Keyword extraction + TF-IDF | <1ms | Good for exact matches | ~1MB | Default, always on |
| **L1** | Character n-gram hashing (SimHash) | <5ms | Good for fuzzy matching | ~10MB | Default, always on |
| **L2** | `transformers.js` embeddings | ~50ms | Best semantic similarity | ~500MB | Opt-in, loaded lazily on first use |

- `apex_recall` uses L0+L1 by default. If results are poor (low scores), it upgrades to L2 for that query.
- L2 model is loaded once on first need and stays in memory for the session.
- Configuration: `"embedding_level": "auto" | "fast" | "full"` in `.apex-data/config.json`
- The L0+L1 combination is surprisingly effective for code-related queries where keyword overlap is high.

### Self-Improving CLAUDE.md

The CLAUDE.md instructions evolve based on what's working:

- APEX tracks which tools Claude actually calls and how often
- APEX tracks which `apex_recall` queries return useful results (measured by whether Claude uses the returned context)
- Periodically (or via `apex_status`), APEX reports CLAUDE.md effectiveness metrics
- Claude can then update the CLAUDE.md instructions to improve its own usage patterns
- Example: if Claude never calls `apex_plan_context`, the CLAUDE.md instructions for planning may need to be more prominent or differently worded

### Cold Start / Bootstrap

New project, empty APEX. How to be useful from day one:

1. **Global knowledge applies immediately.** If you've used APEX in other projects, universal skills (testing patterns, debugging strategies, code review insights) are available via `~/.apex/`.
2. **`apex_setup` auto-scans the project.** On first run, it reads `package.json`, `tsconfig.json`, directory structure, README, etc. to build an initial project profile. This gives `apex_recall` basic project context even before any learning.
3. **First-session recording is lightweight.** CLAUDE.md asks Claude to `apex_record` just task outcomes (not full trajectories) for the first 5 sessions — low friction, fast bootstrap.
4. **Progressive complexity.** Phase 1 features (`apex_recall`, `apex_record`) work with zero learning data. Advanced features (reflection, curriculum) activate once enough data exists (configurable threshold, default: 10 episodes).

### Memory Snapshots & Rollback

Bad reflections or skills can poison future sessions. Safety net:

- **Automatic snapshots** before every `apex_consolidate` (kept for last N consolidations, default 5)
- **`apex_snapshot`** MCP tool to manually create a named snapshot
- **`apex_rollback`** MCP tool to restore a previous snapshot
- Snapshots are lightweight — just the memory index + refs, not full episode data
- Each snapshot is timestamped and tagged with session metadata

---

## Phase 1: Foundation & MCP Server Scaffold ✅ COMPLETE

**Goal:** Establish the project, core types, MCP server skeleton, and the `.mcp.json` / `CLAUDE.md` integration files that make APEX available in Claude Code immediately.

**Runtime:** TypeScript / Node.js (ESM)
**Storage:** File-based (JSON + binary) in `.apex-data/`
**Completed:** 2026-04-02 | **Commit:** `925e9c8`
**Lines of code:** ~2,030 (TypeScript, src/ only)

### Checklist

- [x] **Project scaffold** ✅
  - [x] Initialize `package.json` with TypeScript, ESM module type, `bin` entry
  - [x] Configure `tsconfig.json` (strict mode, ES2022 target, path aliases)
  - [x] Set up directory structure: `src/{memory,reflection,planning,curriculum,evolution,mcp,utils}`
  - [x] Add dependencies: `@modelcontextprotocol/sdk`
  - [x] Add dev dependencies: `vitest`, `tsx`, `typescript`
  - [x] Add `.gitignore` for `node_modules`, `dist`, `*.db`, `.apex-data`

- [x] **MCP server entry point** (`src/mcp/server.ts`) ✅
  - [x] Initialize MCP server with stdio transport
  - [x] Register all APEX tool handlers (stubs initially)
  - [x] Graceful shutdown handling
  - [x] Server info and capability declaration

- [x] **MCP tool definitions** (`src/mcp/tools.ts`) ✅ — all 15 core tools defined with full JSON Schema
  - [x] `apex_recall` — input: query string, context? | output: ranked memory results across all tiers
  - [x] `apex_record` — input: episode data (task, actions, outcome, reward?) | output: episode ID
  - [x] `apex_reflect_get` — input: scope ("recent", episode IDs, task type) | output: grouped episode data for Claude to reason over
  - [x] `apex_reflect_store` — input: reflection (level, insights, error_types, strategies) | output: reflection ID
  - [x] `apex_plan_context` — input: task description | output: past attempts, relevant skills, known pitfalls
  - [x] `apex_skills` — input: query? or "list" | output: matching skills with success rates
  - [x] `apex_skill_store` — input: skill definition (name, description, preconditions, pattern) | output: skill ID
  - [x] `apex_status` — input: none | output: memory stats, tier utilization, learning curve data
  - [x] `apex_consolidate` — input: none | output: consolidation report (what moved between tiers)
  - [x] `apex_curriculum` — input: domain?, skill_level? | output: next suggested task + difficulty score
  - [x] `apex_setup` — input: project_path? | output: initialization report (project profile, global link status)
  - [x] `apex_snapshot` — input: name? | output: snapshot ID + metadata
  - [x] `apex_rollback` — input: snapshot ID or "latest" | output: restored state summary
  - [x] `apex_promote` — input: skill ID | output: confirmation (project -> global)
  - [x] `apex_import` — input: source path or project name | output: import report (what was merged)

- [x] **Integration files** (partial) ✅
  - [x] Update `.mcp.json` to include APEX server entry
  - [x] Create `CLAUDE.md` with contextual instructions for Claude (see "Self-Improving CLAUDE.md" section)
  - [ ] Create `.apex-data/` directory structure for persistence *(deferred to `apex_setup` handler implementation in Phase 2)*
  - [ ] Create `~/.apex/` global directory structure (if not exists) *(deferred to `apex_setup` handler implementation in Phase 2)*
  - [ ] Register project in `~/.apex/projects-index.json` *(deferred to `apex_setup` handler implementation in Phase 2)*

- [x] **Project scanner** (`src/utils/project-scanner.ts`) ✅ — for cold start bootstrap
  - [x] Detect project type (package.json, tsconfig, Cargo.toml, pyproject.toml, etc.)
  - [x] Extract tech stack, dependencies, scripts
  - [x] Identify directory structure patterns
  - [x] Read README / docs for project context
  - [x] Generate initial project profile for `.apex-data/config.json`

- [x] **Core type definitions** (`src/types.ts`) ✅ — 518 lines, comprehensive
  - [x] `Episode` — task execution record (id, task, actions[], outcome, reward, timestamp, embedding?)
  - [x] `Trajectory` — ordered sequence of `(state, action, reward, next_state)` tuples
  - [x] `Reflection` — structured output (level, content, error_types[], actionable_insights[])
  - [x] `Skill` — reusable capability (name, description, preconditions, code/prompt, success_rate, usage_count, confidence, source_project, source_files[])
  - [x] `MemoryEntry` — base for all memory tiers (id, content, embedding, heat_score, confidence, created_at, accessed_at, source_files[]?, stale?)
  - [x] `SearchResult` — ranked retrieval result (entry, score, source_tier)
  - [x] `Task` — task definition (id, description, difficulty, domain, constraints)
  - [x] `AgentConfig` — global config (model, memory limits, exploration params, thresholds)

- [x] **Shared utilities** (`src/utils/`) ✅ — 11 modules, ~750 lines
  - [x] `embeddings.ts` — tiered embedding: L0 (keyword/TF-IDF), L1 (SimHash), L2 (transformers.js, lazy-loaded)
  - [x] `similarity.ts` — cosine similarity, Jaccard similarity for keyword sets
  - [x] `hashing.ts` — content hashing for deduplication (FNV-1a)
  - [x] `serialization.ts` — efficient binary serialization for episodes and embeddings
  - [x] `ring-buffer.ts` — fixed-capacity ring buffer with O(1) push/evict
  - [x] `event-bus.ts` — typed event emitter for inter-system communication
  - [x] `logger.ts` — structured logger with levels and optional file output
  - [x] `file-store.ts` — filesystem-based CRUD persistence for 6 collections
  - [x] `project-scanner.ts` — auto-detect project metadata (Node, Python, Rust, Go, web frameworks)
  - [x] `index.ts` — barrel exports

**Note:** All 15 tool handlers in `src/mcp/handlers.ts` are stubbed (return `not_yet_implemented`). Implementing the actual handler logic requires the subsystems built in Phases 2–6.

---

## Phase 2: Hierarchical Memory System

**Goal:** Implement the 4-tier memory architecture inspired by MemoryOS, with OS-style segment-paged storage and heat-based lifecycle management.

### Memory Tiers

| Tier | Analogy | Contents | Capacity | Eviction |
|------|---------|----------|----------|----------|
| **Working Memory** | CPU registers | Current session context, active task | ~10 items | FIFO (oldest dialogue page) |
| **Episodic Memory** | RAM | Recent experience episodes, trajectories | ~1000 episodes | Heat-score based |
| **Semantic Memory** | SSD | Distilled knowledge, rules, error taxonomies | ~5000 entries | LRU + heat merge |
| **Procedural Memory** | Disk | Skill library, learned action sequences | Unbounded (file-backed) | Usage-decay archival |

### Checklist

- [ ] **Working Memory** (`src/memory/working.ts`)
  - [ ] Fixed-size dialogue page queue (configurable, default 10)
  - [ ] Dialogue chain construction (contextual linking between pages)
  - [ ] FIFO overflow to Episodic Memory
  - [ ] Full context retrieval (all pages returned for current session)

- [ ] **Episodic Memory** (`src/memory/episodic.ts`)
  - [ ] Segment-paged storage: episodes grouped into topical segments
  - [ ] Segment similarity scoring (cosine embedding + Jaccard keywords, per MemoryOS Eq.3)
  - [ ] Heat score computation: `Heat = alpha * N_visit + beta * L_interaction + gamma * R_recency`
  - [ ] Heat-based eviction when capacity exceeded
  - [ ] Two-stage retrieval: segment selection -> page selection within segment
  - [ ] Heat score update on retrieval (visit count + recency refresh)

- [ ] **Semantic Memory** (`src/memory/semantic.ts`)
  - [ ] Knowledge entries: facts, rules, error taxonomy entries
  - [ ] Incremental update from episodic memory consolidation
  - [ ] Embedding-based retrieval with top-k
  - [ ] Deduplication via content hashing
  - [ ] Merge/update existing entries when new info overlaps

- [ ] **Procedural Memory** (`src/memory/procedural.ts`)
  - [ ] Skill registry: name -> Skill definition
  - [ ] Skill composition: combine atomic skills into compound skills
  - [ ] Success rate tracking per skill (rolling window)
  - [ ] Skill retrieval by task similarity
  - [ ] File-backed persistence (JSON + embeddings binary)

- [ ] **Memory Manager** (`src/memory/manager.ts`)
  - [ ] Unified interface across all tiers
  - [ ] Cross-tier retrieval: query project tiers first, then global `~/.apex/`, merge and rank
  - [ ] Consolidation pipeline: Working -> Episodic -> Semantic (triggered by thresholds)
  - [ ] Skill extraction pipeline: Episodic -> Procedural (on repeated success patterns)
  - [ ] Memory stats and health monitoring
  - [ ] Persistence: save/load full memory state to `.apex-data/`

- [ ] **Staleness detector** (`src/memory/staleness.ts`)
  - [ ] Track source files referenced by each memory entry / skill
  - [ ] On recall: check if source files changed (git diff or mtime comparison)
  - [ ] Tag stale results: `[STALE — source files changed since learned]`
  - [ ] Check if referenced functions/classes still exist (fast grep)
  - [ ] Tag invalid results: `[POSSIBLY INVALID — referenced code not found]`
  - [ ] Staleness stats in `apex_status` output

- [ ] **Snapshot manager** (`src/memory/snapshots.ts`)
  - [ ] Auto-snapshot before consolidation (rolling window, keep last N)
  - [ ] Named snapshots via `apex_snapshot` tool
  - [ ] Restore from snapshot via `apex_rollback` tool
  - [ ] Lightweight: snapshot = memory index + tier metadata, not full episode data
  - [ ] Snapshot listing and cleanup

- [ ] **Memory-efficient embedding storage** (`src/memory/embedding-store.ts`)
  - [ ] Binary quantization option (1-bit embeddings, 32x compression)
  - [ ] Int8 scalar quantization option (4x compression)
  - [ ] Memory-mapped file backing for large embedding sets
  - [ ] Batch similarity search with SIMD-friendly layout

---

## Phase 3: Multi-Level Reflection Engine

**Goal:** Implement the SaMuLe-inspired 3-level reflection data pipeline. APEX handles data organization and storage; Claude Code (via CLAUDE.md instructions) does the actual reasoning. Triggered via `apex_reflect_get` + `apex_reflect_store` MCP tools.

### Reflection Levels

| Level | Scope | Input | Output |
|-------|-------|-------|--------|
| **Micro** | Single trajectory | One failed episode + reference | Error diagnosis + corrective strategy |
| **Meso** | Intra-task | Multiple episodes for same task | Error taxonomy + pattern-based feedback |
| **Macro** | Inter-task | Episodes clustered by error type | Transferable insights + general strategies |

### Checklist

- [ ] **Micro-level data assembler** (`src/reflection/micro.ts`)
  - [ ] Retrieve single failed episode + any reference/goal data
  - [ ] Format trajectory as step-by-step action log for Claude to analyze
  - [ ] Include contrastive data when both success and failure trajectories exist for same task
  - [ ] Return structured prompt-ready data (Claude does the actual analysis)

- [ ] **Meso-level data assembler** (`src/reflection/meso.ts`)
  - [ ] Group episodes by task type / similarity
  - [ ] Retrieve cross-attempt data for the same task type
  - [ ] Include existing error taxonomy for Claude to extend
  - [ ] Format episode clusters for pattern detection (Claude does the reasoning)

- [ ] **Macro-level data assembler** (`src/reflection/macro.ts`)
  - [ ] Cluster episodes by error type tags (from stored reflections)
  - [ ] Retrieve cross-task episode groups sharing failure patterns
  - [ ] Format clustered data for transferable insight extraction (Claude does the reasoning)

- [ ] **Reflection storage** (`src/reflection/store.ts`)
  - [ ] Accept structured reflection from Claude (insights, error types, strategies)
  - [ ] Merge into Semantic Memory with proper heat scoring
  - [ ] Update error taxonomy index
  - [ ] Deduplicate against existing reflections (content hash + similarity check)
  - [ ] Priority scoring of reflections by actionability tags

- [ ] **Reflection coordinator** (`src/reflection/coordinator.ts`)
  - [ ] Orchestrate the get -> (Claude reasons) -> store flow
  - [ ] Track which episodes have been reflected on (avoid re-processing)
  - [ ] Incremental taxonomy index update on new reflections
  - [ ] Metrics: reflection count, taxonomy size, insight density

---

## Phase 4: MCTS Planning Engine

**Goal:** Implement experience-informed planning support. Instead of running MCTS internally (which would require LLM calls), APEX provides rich planning context to Claude Code via `apex_plan_context`, and tracks plan outcomes to improve future suggestions. The MCTS structure is used to organize and score historical action paths, not to run live simulations.

### Checklist

- [ ] **Experience-backed plan context** (`src/planning/context.ts`)
  - [ ] Given a task, retrieve: past attempts at similar tasks, their outcomes, and reflections
  - [ ] Rank past approaches by success rate and recency
  - [ ] Identify known pitfalls and anti-patterns for this task type
  - [ ] Suggest applicable skills from Procedural Memory
  - [ ] Return structured context for Claude to reason over

- [ ] **Action history tree** (`src/planning/action-tree.ts`)
  - [ ] Tree structure tracking historical action sequences and their outcomes
  - [ ] Node: state description + action taken + outcome value
  - [ ] Visit count and average value per action path (UCB1-informed ranking)
  - [ ] Prune low-value branches automatically

- [ ] **Plan tracking** (`src/planning/tracker.ts`)
  - [ ] Record plans proposed by Claude (via `apex_record` with plan metadata)
  - [ ] Track plan execution: which steps completed, which failed
  - [ ] Link plan outcomes back to the action history tree
  - [ ] Compute plan success rates by task type

- [ ] **Value estimation** (`src/planning/value.ts`)
  - [ ] Historical success rate for action patterns (from action tree)
  - [ ] Skill-informed priors: boost value for actions matching learned skills
  - [ ] UCB1 scoring: `Q(s,a) + c * sqrt(ln(N(s)) / N(s,a))` for exploration/exploitation
  - [ ] Decay old values over time (recency weighting)

---

## Phase 5: Curriculum & Experience Replay

**Goal:** Implement Voyager-inspired curriculum learning and memory-efficient prioritized experience replay. The `apex_curriculum` MCP tool suggests next tasks; Claude Code drives the actual learning sessions.

### Checklist

- [ ] **Experience Replay Buffer** (`src/curriculum/replay-buffer.ts`)
  - [ ] Prioritized sampling by TD-error / surprise score
  - [ ] Ring buffer backing (fixed memory, O(1) operations)
  - [ ] Importance sampling weights for bias correction
  - [ ] Compressed episode storage (quantized embeddings + delta encoding)
  - [ ] Configurable capacity with automatic eviction

- [ ] **Difficulty estimator** (`src/curriculum/difficulty.ts`)
  - [ ] Task complexity scoring (number of steps, tool calls, constraints)
  - [ ] Historical difficulty: success rate across past attempts
  - [ ] Embedding-based similarity to previously solved tasks
  - [ ] Composite difficulty score combining all signals

- [ ] **Curriculum generator** (`src/curriculum/generator.ts`)
  - [ ] Automatic task proposal based on current skill level
  - [ ] Zone of Proximal Development targeting (not too easy, not too hard)
  - [ ] Domain coverage tracking (ensure breadth, not just depth)
  - [ ] Progressive complexity: unlock harder tasks as skills improve
  - [ ] Failure-directed curriculum: generate tasks targeting weak areas

- [ ] **Skill extractor** (`src/curriculum/skill-extractor.ts`)
  - [ ] Identify reusable action subsequences from successful trajectories
  - [ ] Skill abstraction: parameterize concrete actions into general skills
  - [ ] Skill verification: test extracted skill on similar tasks
  - [ ] Skill composition: detect when skills chain together reliably

---

## Phase 6: Evolution Engine

**Goal:** Wire all subsystems into a unified self-improvement loop. Claude Code drives the loop; APEX provides data infrastructure at each step.

### The Evolution Loop (Claude Code drives, APEX serves data)

```
  Claude Code (the LLM brain — your Max plan)
  ==============================================
  +--> [1. Task Selection]  --> [2. Planning]       --> [3. Execution]
  |     Claude asks            Claude asks              Claude works
  |     apex_curriculum        apex_plan_context        on the task
  |                                                        |
  |    [6. Curriculum Update] <-- [5. Consolidation]       |
  |     apex_consolidate           apex_consolidate        |
  |            |                         ^                 v
  |            v                         |            [Outcome]
  +--- [7. Next Iteration]     [4. Reflection]        apex_record
                                Claude calls
                                apex_reflect_get
                                (reasons over data)
                                apex_reflect_store
```

### Checklist

- [ ] **Evolution loop controller** (`src/evolution/loop.ts`)
  - [ ] Main event loop: select task -> plan -> execute -> reflect -> consolidate
  - [ ] Configurable iteration budget (max iterations, time limit, token budget)
  - [ ] Graceful pause/resume with full state serialization
  - [ ] Progress metrics: success rate over time, skill count, memory utilization

- [ ] **Self-evaluation module** (`src/evolution/evaluator.ts`)
  - [ ] Outcome scoring: binary success/fail + continuous quality score
  - [ ] LLM-as-judge for open-ended task evaluation
  - [ ] Comparison against reference solutions when available
  - [ ] Novelty detection: flag when task is unlike anything seen before

- [ ] **Knowledge distillation** (`src/evolution/distillation.ts`)
  - [ ] Periodic consolidation: compress episodic memory into semantic entries
  - [ ] Rule extraction: identify consistent patterns across episodes
  - [ ] Skill crystallization: promote frequently-successful action sequences
  - [ ] Forgetting curve: decay unused knowledge (Ebbinghaus-inspired)

- [ ] **Metrics & telemetry** (`src/evolution/metrics.ts`)
  - [ ] Per-iteration stats: task difficulty, outcome, planning time, memory usage
  - [ ] Rolling aggregates: success rate (window=50), avg reward, skill growth
  - [ ] Memory pressure monitoring: tier utilization, eviction rates
  - [ ] Learning curve visualization data export (CSV/JSON)

---

## Phase 7: Cross-Project Learning & Knowledge Sharing

**Goal:** Enable skills and knowledge to flow between projects. A debugging pattern learned in Project A should help in Project B. This is the multiplier that makes APEX exponentially more valuable over time.

### Checklist

- [ ] **Global store manager** (`src/memory/global-store.ts`)
  - [ ] `~/.apex/` directory management (create, validate, migrate)
  - [ ] Global skill registry with project-of-origin tracking
  - [ ] Global knowledge base (language patterns, framework idioms, debugging strategies)
  - [ ] User learning profile: aggregate stats across all projects

- [ ] **Skill promotion pipeline** (`src/evolution/promotion.ts`)
  - [ ] Auto-promotion rules: skill succeeds in N+ projects (default 3) -> promote to global
  - [ ] Manual promotion via `apex_promote` tool
  - [ ] Conflict resolution: project-level overrides global (local wins)
  - [ ] Provenance tracking: which project(s) contributed to each global skill

- [ ] **Cross-project query** (`src/memory/cross-project.ts`)
  - [ ] `apex_recall` searches project store first, then global store
  - [ ] Results tagged with source (`[project]` vs `[global]` vs `[project:other-name]`)
  - [ ] Relevance boost for same-tech-stack projects (e.g., both TypeScript + React)
  - [ ] Privacy boundary: only skills/knowledge are shared, not raw episodes

- [ ] **Import/Export** (`src/memory/portability.ts`)
  - [ ] Export project skills as portable JSON bundle (shareable with teammates)
  - [ ] Import skill bundle into project or global store
  - [ ] Merge strategy: skip duplicates, flag conflicts, accept new
  - [ ] `apex_import` tool for Claude to trigger imports

- [ ] **Project similarity index** (`src/memory/project-index.ts`)
  - [ ] Fingerprint each project (tech stack, directory patterns, dependency overlap)
  - [ ] Rank projects by similarity for cross-project recall prioritization
  - [ ] Update fingerprint on project structure changes

---

## Phase 8: Hooks, CLAUDE.md & End-to-End Integration

**Goal:** Wire APEX into the Claude Code experience so learning happens automatically. The CLAUDE.md is the most critical file — it determines whether Claude actually uses APEX.

### Checklist

- [ ] **CLAUDE.md authoring** (contextual, not just a list of tools)
  - [ ] **On session start:** "Call `apex_recall` with a summary of what you're about to work on"
  - [ ] **On encountering an error:** "Before debugging, call `apex_recall` with the error message — you may have seen this before"
  - [ ] **After fixing a tricky bug:** "Call `apex_record` with what the bug was, what you tried, and what worked"
  - [ ] **Before writing a new module:** "Call `apex_skills` to check for relevant patterns you've learned"
  - [ ] **On task completion:** "Call `apex_record` with the outcome. If something surprising happened, call `apex_reflect_get` and analyze it"
  - [ ] **On repeated failure:** "Call `apex_reflect_get('meso')` to see patterns across your attempts at this type of task"
  - [ ] Examples of good vs bad tool usage patterns
  - [ ] Progressive disclosure: basic instructions first, advanced patterns at the bottom

- [ ] **Claude Code hooks** (documented for user's `settings.json`)
  - [ ] Post-tool hook: optionally record tool outcomes as micro-episodes
  - [ ] Guidance for configuring reflection triggers

- [ ] **`.mcp.json` configuration**
  - [ ] Server entry pointing to built APEX MCP server
  - [ ] Environment variable passthrough (data dir path)

- [ ] **CLAUDE.md effectiveness tracking**
  - [ ] Track which APEX tools are called per session (stored in metrics)
  - [ ] Track recall hit rate (did Claude use the returned context?)
  - [ ] Surface metrics in `apex_status` so user/Claude can improve CLAUDE.md
  - [ ] Suggest CLAUDE.md improvements when tools are underutilized

- [ ] **End-to-end smoke test**
  - [ ] Start Claude Code with APEX configured
  - [ ] Verify `apex_status` returns valid stats
  - [ ] Verify `apex_record` -> `apex_reflect_get` -> `apex_reflect_store` -> `apex_recall` round-trip
  - [ ] Verify skills persist across MCP server restarts
  - [ ] Verify memory consolidation runs and data survives restart
  - [ ] Verify cross-project recall (skill from project A visible in project B)
  - [ ] Verify snapshot + rollback cycle

---

## Phase 9: Testing & Hardening

**Goal:** Comprehensive test coverage and performance validation.

### Checklist

- [ ] **Unit tests**
  - [ ] Ring buffer: capacity, eviction, ordering
  - [ ] Heat score computation and eviction ordering
  - [ ] Similarity functions: cosine, Jaccard
  - [ ] MCTS: UCB1 selection, backpropagation correctness
  - [ ] Memory tier transitions: Working -> Episodic -> Semantic
  - [ ] Reflection merger: multi-level combination
  - [ ] MCP tool handlers: input validation, error handling

- [ ] **Integration tests**
  - [ ] Full learning loop: task -> plan -> execute -> reflect -> improve
  - [ ] Memory consolidation pipeline end-to-end
  - [ ] Skill extraction from repeated successful episodes
  - [ ] Curriculum progression: verify difficulty increases over time
  - [ ] MCP server lifecycle: startup, tool calls, shutdown, restart with state
  - [ ] Cross-project skill promotion and recall
  - [ ] Staleness detection: modify a source file, verify recall tags it stale
  - [ ] Snapshot create -> modify memory -> rollback -> verify restored state
  - [ ] Cold start: new project with existing global skills -> verify recall works

- [ ] **Performance benchmarks**
  - [ ] Memory retrieval latency at 1K, 10K, 100K entries
  - [ ] MCTS planning time vs iteration budget
  - [ ] Embedding storage size with quantization options
  - [ ] Full loop iteration throughput

- [ ] **Memory efficiency validation**
  - [ ] Measure peak RSS across learning iterations
  - [ ] Verify ring buffer prevents unbounded growth
  - [ ] Validate quantized embeddings maintain retrieval quality (>95% recall@10)
  - [ ] Stress test: 10K episodes without OOM

---

## Phase 10: Advanced Features (Post-MVP)

**Goal:** Stretch features that push the system toward production-grade autonomous learning.

### Checklist

- [ ] **Foresight-based reflection** (SaMuLe interactive mode)
  - [ ] Predict expected outcome before execution
  - [ ] Compare predicted vs actual, trigger reflection on surprise
  - [ ] Proactive adaptation during multi-step tasks

- [ ] **Multi-agent co-evolution**
  - [ ] Population of agent instances with shared Semantic Memory
  - [ ] Cross-pollination: best skills migrate between agents
  - [ ] Competitive evaluation: agents solve same tasks, best strategies win

- [ ] **Tool creation & mastery** (Voyager-inspired)
  - [ ] Automatic tool/function creation from successful patterns
  - [ ] Tool verification sandbox
  - [ ] Tool composition into higher-order capabilities

- [ ] **Adaptive architecture search**
  - [ ] Meta-learning: optimize hyperparameters (exploration constant, memory capacities)
  - [ ] Architecture mutation: try different reflection/planning combinations
  - [ ] Self-referential improvement: agent modifies its own prompts/config

---

## Phase 11: Team Learning & GitHub-Native Sharing (Future Release)

**Goal:** Enable a team to share APEX knowledge through their existing GitHub workflow. When one person's Claude learns something, the whole team benefits on their next `git pull`. No new tools, no dashboards, no knowledge management overhead — it flows through git like code.

### The Core Insight

Knowledge sharing should work exactly like code sharing:
- **Learn locally** → **propose to team** → **review via PR** → **merge** → **everyone benefits on `git pull`**

Raw episodes and personal working memory are never shared. Only curated, high-confidence skills, reflections, and error taxonomies flow to the team.

### Privacy Model

```
NEVER SHARED (stays in .apex-data/, gitignored)
  - Raw episodes (may contain sensitive context, credentials, etc.)
  - Working memory (session-specific)
  - Personal metrics & learning curves
  - Low-confidence / unverified knowledge

SHARED VIA GIT (committed to .apex-shared/)
  - Team-reviewed skills (proposed via PR, merged by team)
  - Error taxonomies (common failure patterns)
  - Project conventions (architecture decisions, patterns)
  - Reflections distilled to actionable rules

PERSONAL GLOBAL (stays in ~/.apex/, never leaves your machine)
  - Cross-project skills (your personal learnings)
  - User profile & preferences
  - Personal skill success rates
```

### Directory Structure

```
<project>/
  .apex-data/                    (gitignored — personal, per-developer)
    episodes/
    memory/
    skills/
    metrics/
    config.json

  .apex-shared/                  (committed to git — team knowledge)
    skills/                      team-reviewed skills
      ts-error-handling.json
      deploy-rollback.json
    knowledge/                   project conventions & patterns
      api-design-rules.json
      testing-strategy.json
    taxonomies/                  shared error taxonomies
      build-errors.json
      runtime-errors.json
    proposals/                   pending skill proposals (auto-created branches)
    manifest.json                index of all shared knowledge + metadata
    CHANGELOG.md                 auto-generated: what was learned, by whom, when
```

### Team Learning Flow

```
  Developer A (Claude Code + APEX)          Git (GitHub)           Developer B (Claude Code + APEX)
  ================================          ==========             ================================

  1. Works on task, Claude learns
     a new skill locally
          |
  2. Skill reaches high confidence
     (used 5+ times, >80% success)
          |
  3. Claude calls apex_team_propose
     -> creates skill file in
        .apex-shared/proposals/
     -> creates git branch
        apex/propose/<skill-name>
     -> opens PR automatically
          |                              4. PR appears:
          |                                 "APEX: New team skill -
          |                                  TypeScript error boundary
          |                                  pattern"
          |                                 (auto-generated description,
          |                                  provenance, success stats)
          |                                                              5. Dev B reviews PR
          |                                                                 (or their Claude reviews
          |                                                                  via apex_team_review)
          |                                                                        |
          |                              6. PR merged                               |
          |                                 -> skill moves to                       |
          |                                    .apex-shared/skills/                 |
          |                                 -> CHANGELOG.md updated                 |
          |                                                                        |
          |                                                              7. git pull
          |                                                                 -> APEX detects new
          |                                                                    .apex-shared/ files
          |                                                                 -> auto-ingests into
          |                                                                    team memory tier
          |                                                                        |
          |                                                              8. apex_recall now returns
          |                                                                 Dev A's skill when
          |                                                                 relevant
```

### Memory Tier Update: Team Tier

The 4-tier personal memory is extended with a read-only team layer:

| Tier | Source | Writable? | Contents |
|------|--------|-----------|----------|
| **Working Memory** | Personal | Yes | Current session context |
| **Episodic Memory** | Personal | Yes | Personal experience episodes |
| **Semantic Memory** | Personal | Yes | Personal distilled knowledge |
| **Procedural Memory** | Personal | Yes | Personal skill library |
| **Team Memory** | `.apex-shared/` (git) | Read-only* | Team-reviewed skills, knowledge, taxonomies |
| **Global Memory** | `~/.apex/` | Yes | Cross-project personal knowledge |

*Team memory is read-only via APEX tools. Writes go through the git PR flow.

Query priority for `apex_recall`:
1. Working Memory (most specific)
2. Episodic Memory
3. Procedural Memory (personal skills)
4. **Team Memory** (team-reviewed skills) ← new
5. Semantic Memory
6. Global Memory (broadest)

### New MCP Tools for Team Features

| Tool | Description | LLM Call? |
|------|-------------|-----------|
| `apex_team_propose` | Propose a personal skill for team sharing (creates branch + PR) | No — git + file ops |
| `apex_team_review` | Retrieve a pending team proposal for Claude to review | No — git + file read |
| `apex_team_status` | Show team learning stats: shared skills, pending proposals, contributors | No — file read + aggregation |
| `apex_team_sync` | Ingest new `.apex-shared/` content after a `git pull` | No — file read + index update |
| `apex_team_log` | Show the team learning changelog (what was learned, by whom, when) | No — file read |

### Checklist

- [ ] **`.apex-shared/` directory manager** (`src/team/shared-store.ts`)
  - [ ] Initialize `.apex-shared/` with manifest.json, directory structure
  - [ ] Add `.apex-data/` to `.gitignore` (ensure personal data never committed)
  - [ ] Ensure `.apex-shared/` is NOT in `.gitignore`
  - [ ] Manifest tracks all shared knowledge entries with metadata
  - [ ] CHANGELOG.md auto-generation on new entries

- [ ] **Team memory tier** (`src/memory/team.ts`)
  - [ ] Read-only memory tier backed by `.apex-shared/` directory
  - [ ] Auto-sync: detect file changes in `.apex-shared/` (via mtime or git status)
  - [ ] Index shared skills and knowledge for fast retrieval
  - [ ] Integrate into Memory Manager cross-tier queries
  - [ ] Tag all team results with `[team]` and contributor attribution

- [ ] **Proposal pipeline** (`src/team/proposal.ts`)
  - [ ] Select high-confidence personal skills as candidates (threshold: configurable, default confidence > 0.7)
  - [ ] Sanitize skill before proposing: strip personal episode refs, file paths, any sensitive context
  - [ ] Generate skill file in portable format with provenance metadata
  - [ ] Create git branch: `apex/propose/<skill-slug>-<short-hash>`
  - [ ] Write skill file to `.apex-shared/proposals/`
  - [ ] Generate PR description: what the skill does, when to use it, success stats, source context
  - [ ] Create PR via `gh pr create` (requires gh CLI, graceful fallback to branch-only)

- [ ] **PR description generator** (`src/team/pr-description.ts`)
  - [ ] Auto-format: skill name, description, preconditions, when to apply
  - [ ] Include provenance: learned from which task type, how many times used, success rate
  - [ ] Include example: show a concrete scenario where this skill helped
  - [ ] Include confidence justification: why this skill is trustworthy
  - [ ] Privacy check: scan for secrets, file paths, usernames — redact before publishing

- [ ] **Ingestion pipeline** (`src/team/ingest.ts`)
  - [ ] On `apex_team_sync` or auto-detect: scan `.apex-shared/` for new/changed files
  - [ ] Parse shared skill files, validate schema
  - [ ] Merge into team memory tier index
  - [ ] Handle updates to existing skills (versioning, prefer newer)
  - [ ] Handle deletions (skill removed from `.apex-shared/` = removed from team memory)

- [ ] **Conflict resolution** (`src/team/conflicts.ts`)
  - [ ] Detect when a personal skill and team skill overlap (same task pattern, different approach)
  - [ ] Default: personal skill wins for that developer (they trust their own experience)
  - [ ] Surface conflicts in `apex_status` so Claude can reason about which is better
  - [ ] Over time: track which version (personal vs team) performs better per developer

- [ ] **Team analytics** (`src/team/analytics.ts`)
  - [ ] Per-skill stats: how many team members use it, aggregate success rate
  - [ ] Contributor leaderboard: who contributes most skills (opt-in, stored in manifest)
  - [ ] Knowledge gap detection: areas where team has few skills
  - [ ] Skill velocity: how fast is the team learning (skills/week)
  - [ ] CHANGELOG.md generation: human-readable log of team learning

- [ ] **GitHub integration** (`src/team/github.ts`)
  - [ ] Use `gh` CLI for PR creation (detect availability, graceful fallback)
  - [ ] Link skills to issues/PRs where they were learned (if available from episodes)
  - [ ] Branch protection awareness: handle repos requiring reviews
  - [ ] Support for GitHub Enterprise (configurable remote)

- [ ] **Security & privacy hardening**
  - [ ] Pre-share sanitization: regex scan for API keys, tokens, passwords, emails
  - [ ] Path anonymization: replace absolute paths with relative project paths
  - [ ] Configurable redaction rules in `.apex-data/config.json`
  - [ ] Audit log: record what was shared and when (local, never shared)
  - [ ] `apex_team_propose --dry-run` to preview what would be shared before committing

### Shared Skill File Format

```json
{
  "apex_version": "0.5.0",
  "type": "skill",
  "id": "sk_a1b2c3d4",
  "name": "TypeScript exhaustive switch pattern",
  "description": "Use `never` type assertion in default case to ensure switch statements handle all union members at compile time",
  "when_to_apply": "When writing switch statements over union types or enums",
  "pattern": "function assertNever(x: never): never { throw new Error(`Unexpected: ${x}`); }\n\nswitch(value) {\n  case 'a': ...; break;\n  case 'b': ...; break;\n  default: assertNever(value);\n}",
  "confidence": 0.85,
  "provenance": {
    "contributor": "developer-a",
    "learned_from": "TypeScript API development",
    "first_seen": "2026-03-15T10:30:00Z",
    "times_used": 12,
    "success_rate": 0.92
  },
  "tags": ["typescript", "type-safety", "switch", "pattern"],
  "related_skills": [],
  "version": 1,
  "created_at": "2026-04-02T19:00:00Z"
}
```

### Team Onboarding Flow

```
NEW TEAM MEMBER joins project
  1. git clone <project>
     -> .apex-shared/ is already there with team knowledge

  2. First Claude Code session:
     -> APEX detects .apex-shared/ exists
     -> Auto-indexes team skills into team memory tier
     -> apex_recall immediately returns team knowledge
     
  3. New member benefits from entire team's learning history
     on their very first session — zero setup beyond git clone

EXISTING PROJECT adds APEX
  1. Any team member runs apex_setup
     -> Creates .apex-shared/ directory structure
     -> Commits initial structure to git
     
  2. Team members install APEX MCP server (npm install)
     -> Add to .mcp.json (can be committed, shared)
     
  3. Over time, skills accumulate through normal PR flow
```

---

## Performance Targets

| Metric | Target |
|--------|--------|
| MCP server startup | < 500ms |
| `apex_recall` latency | < 100ms (10K entries) |
| `apex_record` latency | < 20ms |
| Memory per 1K episodes | < 50 MB (with int8 quantization) |
| MCTS planning (100 iterations) | < 5s |
| Full reflection cycle | < 30s (excluding LLM latency) |
| Sustained learning (10K iterations) | No memory growth beyond configured limits |
| Skill extraction accuracy | > 80% reuse success rate |
| `apex_team_sync` latency | < 200ms (100 shared skills) |
| `apex_team_propose` (branch + PR) | < 10s (network dependent) |
| Team skill ingestion on git pull | Automatic, < 500ms |
| Pre-share privacy scan | < 100ms per skill |

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict, ESM) |
| Runtime | Node.js 20+ |
| Protocol | MCP (Model Context Protocol) via stdio |
| MCP SDK | `@modelcontextprotocol/sdk` |
| LLM | **None** — Claude Code (Max plan) provides all reasoning |
| Testing | Vitest |
| Embeddings | Tiered: L0 keyword/TF-IDF + L1 SimHash (default), L2 `transformers.js` (opt-in, lazy) |
| Storage | File-based JSON + binary in `.apex-data/` |
| Host | Claude Code (terminal, Max/Pro plan) |

### API Key Requirements

| Key | Required? | Purpose |
|-----|-----------|---------|
| Anthropic API key | **No** | Claude Code subscription handles all LLM usage |
| OpenAI API key | **No** | Embeddings are computed locally |
| Any external API | **No** | APEX is fully self-contained and offline-capable |

---

## Key Design Principles

1. **Zero API cost:** APEX makes no LLM calls. All intelligence comes from Claude Code (your Max plan). APEX is pure data infrastructure.
2. **Claude Code native:** APEX is invisible infrastructure. Claude uses it via MCP tools as naturally as it uses Read or Bash.
3. **Cross-project by default:** Skills flow between projects automatically. Learning in one project benefits all future projects.
4. **Memory-first:** Every data structure has a hard capacity limit. No unbounded growth anywhere.
5. **Failure-centric learning:** Failures are more valuable than successes. The system actively seeks and learns from failure.
6. **Composable skills:** Learned capabilities are modular and composable, enabling combinatorial growth.
7. **Heat-driven lifecycle:** Information flows through tiers based on access frequency, engagement, and recency — not just time.
8. **Trust but verify:** Every memory carries a confidence score. Stale knowledge is flagged, not silently served. Rollback is always available.
9. **Crash-safe:** Atomic writes ensure no learning is lost on unexpected shutdown.
10. **Observable:** `apex_status` gives full visibility into what the agent has learned and how it's improving.
11. **Zero-config start:** `apex_setup` auto-detects project type. Global skills apply immediately. Advanced features activate as data accumulates.
12. **Offline-capable:** No network required. Embeddings computed locally, data stored locally. Works on flights.
13. **Lightweight-first:** Fast keyword matching by default. Heavy embeddings are opt-in and lazy-loaded. Startup stays under 500ms.
14. **Git-native team sharing:** Team knowledge flows through PRs, not a separate system. New members inherit the team's entire learning history on `git clone`. Private data never leaves your machine.
