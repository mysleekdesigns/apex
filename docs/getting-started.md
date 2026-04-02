# Getting Started with APEX

APEX (Adaptive Personal Experience eXtraction) is a persistent learning layer for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It gives Claude a memory that persists across sessions — so it remembers what worked, what failed, and what it learned in your projects.

APEX runs as a local MCP server. It makes **zero LLM API calls** and costs nothing beyond your existing Claude Code subscription (Max or Pro plan).

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
- [Advanced Features](#advanced-features)
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
       |
After Tasks
  Claude reflects on outcomes (apex_reflect_get + apex_reflect_store)
  Reusable patterns are saved as skills (apex_skill_store)
       |
Memory Consolidation
  Knowledge promotes through memory tiers (apex_consolidate)
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

APEX searches all memory tiers and returns:
- Past episodes where similar tasks were attempted
- Known pitfalls and failure patterns
- Applicable skills from this project and globally

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

This promotes working memory into longer-term storage and extracts patterns across episodes.

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

### Advanced: Foresight

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `apex_foresight_predict` | Records a prediction before a multi-step task | Before complex multi-step work |
| `apex_foresight_check` | Checks execution divergence from prediction | Mid-task to catch drift |
| `apex_foresight_resolve` | Compares prediction vs actual outcome | After completing predicted work |

### Advanced: Multi-Agent & Evolution

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

APEX uses a 4-tier memory system inspired by cognitive science and OS memory management:

### Tier 1: Working Memory
- **Capacity:** 10 entries (ring buffer)
- **Purpose:** Current session context
- **Behavior:** When full, oldest entries overflow to episodic memory
- **Analogy:** Your "mental scratchpad" — recent, fast, limited

### Tier 2: Episodic Memory
- **Capacity:** 1,000 entries
- **Purpose:** Specific past experiences (task attempts, bug fixes, etc.)
- **Behavior:** Heat-based eviction — frequently accessed memories stay, cold ones are pruned
- **Analogy:** "I remember fixing that bug last Tuesday" — concrete, timestamped episodes

### Tier 3: Semantic Memory
- **Capacity:** 5,000 entries
- **Purpose:** Generalized knowledge extracted from episodes
- **Behavior:** Deduplication of similar entries, similarity-based retrieval
- **Analogy:** "React hooks need cleanup functions for subscriptions" — abstract knowledge

### Tier 4: Procedural Memory
- **Capacity:** Unlimited (skill library)
- **Purpose:** Reusable patterns and step-by-step approaches
- **Behavior:** Success rates and confidence tracked per skill, usage-based ranking
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
```

Every memory entry carries:
- **Confidence score** (0-1) — how reliable this knowledge is
- **Heat score** — access frequency, drives eviction decisions
- **Staleness tracking** — files referenced by a memory are checked for changes; stale knowledge is flagged

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
1. Searches project `.apex-data/` first (highest relevance)
2. Searches global `~/.apex/` second (broader knowledge)
3. Merges results, deduplicates, and ranks by combined score
4. Tags each result with its source (project vs global)

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

### Architecture Search

APEX can adapt its own configuration based on performance:

```
apex_arch_suggest()       # Get improvement suggestions
apex_arch_mutate({...})   # Apply a configuration change
apex_arch_status()        # Review configuration and history
```

Tunable parameters include reflection frequency, memory capacities, exploration rates, and which subsystems are active.

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

### Build errors

```bash
cd /path/to/apex
rm -rf dist node_modules
npm install
npm run build
```

### Checking system health

```
apex_status()
```

This shows memory stats, skill counts, learning curve data, and any health warnings.

---

## Next Steps

- Read the [Hooks Guide](./hooks-guide.md) to automate APEX in your workflow
- Explore `apex_curriculum` to find skill gaps and practice areas
- Use `apex_promote` to share skills across projects
- Run `apex_status` periodically to monitor your learning progress

For questions or issues, visit the [GitHub repository](https://github.com/mysleekdesigns/apex).
