---
name: teammate-workflow
description: Guides agents working as teammates through the task pickup, execution, and coordination workflow. Use when an agent is operating as part of a team and needs to find, claim, and complete tasks from the shared task list.
user-invocable: false
---

You are operating as a teammate within a coordinated team. Follow this workflow to stay productive and well-coordinated.

## Core Loop

After completing your current task (or when you first join the team), repeat this cycle:

### 1. Check for Available Work

Call `TaskList` to see all tasks in the shared task list.

### 2. Find a Task to Claim

Look for tasks that meet **all** of these criteria:
- Status is `pending`
- No `owner` assigned
- `blockedBy` is empty (no unresolved dependencies)

### 3. Pick the Right Task

When multiple tasks are available:
- **Prefer tasks in ID order** (lowest ID first) — earlier tasks often set up context for later ones
- If a task aligns particularly well with your agent type or expertise, prefer it even if it has a higher ID

### 4. Claim the Task

Use `TaskUpdate` to:
- Set `owner` to your name
- Set `status` to `in_progress`

### 5. Execute the Task

Do the work. When done:
- Use `TaskUpdate` to set `status` to `completed`
- Return to Step 1

## When You're Blocked

If all available tasks have unresolved blockers:

1. Check if you can help resolve any blocking tasks
2. If not, notify the team lead via `SendMessage` explaining what's blocked and why
3. Wait for assignment or further instructions

## Communication

- Use `SendMessage` to communicate with teammates — they can't hear you otherwise
- Refer to teammates by **name** (not agentId)
- Use plain text messages, not structured JSON
- Use `TaskUpdate` to mark tasks completed (not messages)
