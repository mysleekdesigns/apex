# APEX - Persistent Learning Layer

APEX gives you persistent memory across sessions. It stores episodes, skills, reflections, and metrics locally — all pure data ops with zero extra API cost.

## When to Use APEX Tools

### Start of Task
- `apex_recall` — Query memory for relevant context before starting complex work. Retrieves past attempts, known pitfalls, and learned skills that match your current task.
- `apex_plan_context` — Get experience-informed planning data for non-trivial decisions (past strategies, failure modes, relevant skills).

### During Task
- `apex_record` — Log what you attempted and what happened after completing a subtask or hitting a significant outcome (success or failure).
- `apex_skills` — Search the skill library when you need a known pattern or approach.

### End of Task
- `apex_record` — Final episode recording with overall outcome.
- `apex_skill_store` — Extract and save any reusable pattern you discovered.

### Reflection (after significant work or failures)
- `apex_reflect_get` — Pull grouped episode data for analysis (micro: single episode, meso: similar tasks, macro: error clusters).
- `apex_reflect_store` — Save your reflection output (insights, error taxonomy, strategies) after analyzing the data.
- `apex_consolidate` — Trigger memory tier reorganization (working -> episodic -> semantic).

### Project Management
- `apex_setup` — Initialize APEX for a new project (scans project, creates data dirs).
- `apex_status` — Check memory stats, skill count, learning curve.
- `apex_snapshot` / `apex_rollback` — Save and restore memory state.
- `apex_promote` — Share a project skill globally across all projects.

### Team Sharing
- `apex_team_propose` — Propose a skill for team sharing.
- `apex_team_sync` — Pull in new shared knowledge after git pull.

## Session Lifecycle

1. **Recall** — Start sessions with `apex_recall` for relevant context
2. **Work** — Use `apex_record` to log significant outcomes during work
3. **Reflect** — End sessions with `apex_reflect_get` + `apex_reflect_store` to capture learnings
4. **Consolidate** — Run `apex_consolidate` periodically to organize memory tiers

All APEX tools are pure data operations (read/write to local files). They add no API cost beyond your normal Claude Code usage.
