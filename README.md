# APEX — Adaptive Personal Experience eXtraction

A persistent learning layer for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). APEX is an MCP server that gives Claude persistent memory, self-reflection, and cross-project skill transfer — all running locally with zero API cost.

## What It Does

APEX remembers across sessions. When Claude encounters a bug it fixed last week, a pattern it learned in another project, or an approach that failed before, APEX surfaces that context automatically. Over time, Claude gets measurably better at tasks within your codebase.

- **Hierarchical Memory** — 4-tier system (working, episodic, semantic, procedural) with heat-based eviction
- **Self-Reflection** — Micro/meso/macro reflection levels that turn failures into reusable insights
- **Skill Library** — Reusable patterns extracted from successful episodes, searchable by task similarity
- **Experience-Backed Planning** — Historical action trees with UCB1 scoring inform future decisions
- **Cross-Project Learning** — Skills learned in one project transfer to others via `~/.apex/`
- **Curriculum Engine** — Identifies skill gaps and suggests tasks targeting weak areas

## Architecture

```
Claude Code (terminal, Max/Pro plan)
       |
       |  MCP protocol (stdio)
       v
  APEX MCP Server (Node.js, zero API calls)
       |
  .apex-data/  (project memory)
  ~/.apex/     (global skills)
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

## MCP Tools

| Tool | Purpose |
|------|---------|
| `apex_recall` | Search all memory tiers for relevant context |
| `apex_record` | Log a task attempt with actions and outcome |
| `apex_reflect_get` | Retrieve episode data organized for reflection |
| `apex_reflect_store` | Store insights from Claude's analysis |
| `apex_plan_context` | Get experience-backed planning context |
| `apex_skills` | Search or list the learned skill library |
| `apex_skill_store` | Save a reusable pattern as a skill |
| `apex_status` | Memory stats, learning curve, health check |
| `apex_consolidate` | Promote knowledge between memory tiers |
| `apex_curriculum` | Get suggested tasks based on skill gaps |
| `apex_setup` | Initialize APEX for a project |
| `apex_snapshot` | Create a named memory snapshot |
| `apex_rollback` | Restore from a previous snapshot |
| `apex_promote` | Promote a skill to global (cross-project) |
| `apex_import` | Import skills from another project |

## How It Works

**Session start:** Claude calls `apex_recall` with the current task. APEX returns relevant past experience, known pitfalls, and applicable skills.

**During work:** Claude records episodes via `apex_record`. After fixing tricky bugs or completing tasks, it stores structured reflections.

**Over time:** Skills are extracted from repeated successes. Knowledge consolidates from working memory through episodic to semantic. Cross-project skills promote to `~/.apex/` automatically after proving useful in 3+ projects.

**Key properties:**
- Every memory entry carries a confidence score (0-1) and staleness tracking
- Referenced files are checked for changes — stale knowledge is flagged, not silently served
- Snapshots protect against bad reflections poisoning future sessions
- Memory has hard capacity limits at every tier — no unbounded growth

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict, ESM) |
| Runtime | Node.js 20+ |
| Protocol | MCP via stdio |
| Testing | Vitest (249 tests) |
| Embeddings | Tiered: keyword/TF-IDF + SimHash (default), transformers.js (opt-in) |
| Storage | File-based JSON + binary in `.apex-data/` |

## Project Structure

```
src/
  mcp/          Server, tool definitions, handlers
  memory/       4-tier memory system, staleness, snapshots, cross-project
  reflection/   Micro/meso/macro data assemblers, reflection storage
  planning/     Action tree, UCB1 value estimation, plan tracking
  curriculum/   Replay buffer, difficulty estimation, skill extraction
  evolution/    Consolidation loop, metrics, skill promotion
  integration/  Effectiveness tracking
  utils/        Embeddings, similarity, ring buffer, file store
  benchmarks/   Performance and memory validation
```

## Testing

```bash
npm test
```

249 tests across 26 files covering unit tests, integration tests, performance benchmarks, and memory efficiency validation.

## Research Foundation

Built on ideas from:
- **MemoryOS** — OS-inspired hierarchical memory with heat-based eviction
- **SaMuLe** — Multi-level reflection from failures
- **Voyager** — Skill library + curriculum learning
- **LATS** — Monte Carlo Tree Search for planning
- **Self-Evolving Agents Survey** — Unified evolution taxonomy

## License

MIT
