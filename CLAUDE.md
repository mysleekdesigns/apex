# APEX — Your Persistent Memory

You have access to APEX, a persistent learning layer that remembers across sessions. Use it. Past you solved problems, hit dead ends, and learned patterns that current you can benefit from. All APEX tools are pure local data ops — zero extra API cost.

## Core Behaviors (follow these every session)

### 1. Start every session with recall

Before diving into work, query your memory for relevant context. This takes a moment and can save you from repeating past mistakes.

```
apex_recall({ query: "brief summary of what you're about to work on" })
```

Do this even if the task seems straightforward. You may have encountered edge cases, project-specific gotchas, or learned patterns that apply.

### 2. Record significant outcomes as you work

After completing a subtask, fixing a bug, or hitting a notable failure, log it:

```
apex_record({
  task: "what you were trying to do",
  actions: [
    { type: "code_edit", description: "what you did", success: true },
    { type: "command", description: "ran tests", success: false }
  ],
  outcome: { success: true, description: "what happened", duration: 30000 }
})
```

You do NOT need to record every trivial file read or routine edit. Record things worth remembering: bugs fixed, approaches that worked or failed, non-obvious solutions.

### 3. Check memory before debugging errors

When you encounter an error, search memory BEFORE starting to debug:

```
apex_recall({ query: "the error message or error pattern" })
```

You may have seen this exact error before and already know the fix. This single habit can save enormous time on recurring issues.

### 4. Search skills before writing new modules

Before building something new, check if you have learned patterns that apply:

```
apex_skills({ action: "search", query: "what you're about to build" })
```

### 5. Record and reflect on task completion

When finishing a task:

```
apex_record({
  task: "the overall task",
  actions: [...],
  outcome: { success: true, description: "final outcome summary", duration: 120000 }
})
```

If something surprising happened (unexpected failure mode, non-obvious fix, a pattern you want to remember), also reflect:

```
apex_reflect_get({ scope: "recent" })
// analyze what you see, then store your insight:
apex_reflect_store({
  level: "micro",
  content: "your analysis of what happened and why",
  actionableInsights: ["concrete takeaway 1", "concrete takeaway 2"]
})
```

### 6. On repeated failure, step back and look at patterns

If you're stuck or failing repeatedly at a type of task, pull broader context:

```
apex_reflect_get({ scope: "errors" })
```

Analyze what you see. Look for common root causes across failures. Then store a meso-level reflection:

```
apex_reflect_store({
  level: "meso",
  content: "pattern analysis across multiple attempts at this type of task",
  errorTypes: ["the error categories you identified"],
  actionableInsights: ["strategy changes to try"]
})
```

---

## Good vs Bad Usage

### Good: Targeted, meaningful memory use

- Recalling before starting work on a complex refactor
- Recording a tricky bug where the root cause was non-obvious
- Searching skills before setting up a new test harness
- Storing a reflection after discovering a recurring failure pattern
- Recording a failed approach so future you avoids it

### Bad: Noisy, low-value memory use

- Recording every single file read or trivial edit
- Calling `apex_recall` with vague queries like "code" or "help"
- Storing reflections with no actionable insights ("it was hard")
- Recording episodes with no useful detail in actions or outcome
- Calling `apex_record` for tasks that took 5 seconds and had zero learning value

**Rule of thumb:** If future you would benefit from knowing about it, record it. If it's routine and forgettable, skip it.

---

## Planning Complex Tasks

For non-trivial tasks, get experience-backed planning context:

```
apex_plan_context({ task: "description of what you need to plan" })
```

This returns relevant past outcomes, known pitfalls, and applicable skills in one call. Use it instead of separate `apex_recall` + `apex_skills` calls when you need a planning overview.

## Saving Reusable Patterns

When you discover a pattern that works well and could apply to future tasks, save it as a skill:

```
apex_skill_store({
  name: "short-descriptive-name",
  description: "When to use this and what it does",
  pattern: "The step-by-step approach or code pattern",
  preconditions: ["conditions that must hold for this to apply"],
  tags: ["relevant", "categories"]
})
```

Good skill candidates: debugging techniques for specific error classes, project-specific setup procedures, patterns for common task types, workarounds for known limitations.

## Memory Maintenance

Run `apex_consolidate()` periodically (after significant work sessions). This promotes working memory into longer-term storage and extracts patterns.

Use `apex_status()` to check memory health if things feel stale or you want to see what's accumulated.

## Advanced: Snapshots and Cross-Project Learning

### Snapshots

Before risky memory operations or experiments:
```
apex_snapshot({ name: "before-experiment" })
```

To restore if something goes wrong:
```
apex_rollback({ latest: true })
```

### Cross-Project Skills

Promote a skill that applies beyond this project:
```
apex_promote({ skillId: "the-skill-id" })
```

Import skills from another project:
```
apex_import({ source: "/path/to/other/project" })
```

### Curriculum

Get suggestions for what to practice based on learning gaps:
```
apex_curriculum({ domain: "testing" })
```

## Setup

If APEX is not yet initialized for a project:
```
apex_setup({ projectPath: "/path/to/project" })
```
