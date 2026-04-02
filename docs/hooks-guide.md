# APEX Hooks Guide for Claude Code

Configure Claude Code hooks in your `settings.json` to integrate APEX into your workflow automatically. Hooks are shell commands that Claude Code runs on specific events, letting you record tool outcomes and trigger reflections without manual intervention.

---

## Where to Configure Hooks

Claude Code reads hook configuration from `~/.claude/settings.json`. Add a top-level `"hooks"` key with event names mapping to arrays of matcher/hook pairs.

### Hook Structure

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<tool_name_pattern>",
        "hooks": [
          {
            "type": "command",
            "command": "shell-command-here"
          }
        ]
      }
    ]
  }
}
```

Each hook command receives context about the tool invocation via **stdin** (JSON) and **environment variables**. The stdin payload includes the tool name, input parameters, and (for post-tool hooks) the tool's output.

---

## 1. Post-Tool Hook: Record Tool Outcomes as Micro-Episodes

This hook fires after every tool use and writes a micro-episode log entry that APEX can ingest. It captures what tool was called, whether it succeeded, and a summary of the outcome.

### How It Works

A `PostToolUse` hook receives the tool result on stdin. The script below extracts the tool name and outcome, then appends a timestamped JSON record to `.apex-data/hook-episodes.jsonl` in your project directory. APEX can later import these as micro-episodes when you call `apex_record` or during consolidation.

### Script: `~/.claude/hooks/record-tool-outcome.sh`

Create this file and make it executable (`chmod +x`):

```bash
#!/usr/bin/env bash
# record-tool-outcome.sh — Log tool outcomes for APEX micro-episodes
#
# Receives tool use context on stdin as JSON.
# Appends a micro-episode line to .apex-data/hook-episodes.jsonl

set -euo pipefail

# Read stdin (tool context JSON)
INPUT=$(cat)

# Extract fields using lightweight JSON parsing
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name','unknown'))" 2>/dev/null || echo "unknown")
IS_ERROR=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('is_error', False) else 'false')" 2>/dev/null || echo "false")

# Only record if we're in a project with APEX initialized
APEX_DIR=".apex-data"
if [ ! -d "$APEX_DIR" ]; then
  exit 0
fi

EPISODE_FILE="$APEX_DIR/hook-episodes.jsonl"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Append micro-episode record
echo "{\"timestamp\":\"$TIMESTAMP\",\"tool\":\"$TOOL_NAME\",\"is_error\":$IS_ERROR,\"source\":\"hook\"}" >> "$EPISODE_FILE"
```

### Settings Configuration

Add this to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/record-tool-outcome.sh"
          }
        ]
      }
    ]
  }
}
```

An empty `"matcher"` matches all tool uses. To limit recording to specific tools, set `"matcher"` to a pattern like `"Bash"` or `"Edit"`.

### Selective Recording

If you only want to record outcomes from specific tools (to reduce noise), use multiple matcher entries:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/record-tool-outcome.sh"
          }
        ]
      },
      {
        "matcher": "Edit",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/record-tool-outcome.sh"
          }
        ]
      }
    ]
  }
}
```

---

## 2. Reflection Trigger: Detect Repeated Failures

After accumulating several failed tool calls, it helps to pause and reflect. This hook counts recent errors in the micro-episode log and, when a threshold is reached, writes a marker file that signals Claude should run `apex_reflect_get`.

### Script: `~/.claude/hooks/check-failure-threshold.sh`

Create this file and make it executable (`chmod +x`):

```bash
#!/usr/bin/env bash
# check-failure-threshold.sh — Suggest reflection after repeated failures
#
# Checks recent error count in hook-episodes.jsonl.
# When threshold is exceeded, writes a reflection marker.

set -euo pipefail

APEX_DIR=".apex-data"
EPISODE_FILE="$APEX_DIR/hook-episodes.jsonl"
MARKER_FILE="$APEX_DIR/reflection-needed.marker"
THRESHOLD=${APEX_REFLECTION_THRESHOLD:-5}

if [ ! -f "$EPISODE_FILE" ]; then
  exit 0
fi

# Count errors in the last 20 entries
RECENT_ERRORS=$(tail -20 "$EPISODE_FILE" | grep -c '"is_error":true' || true)

if [ "$RECENT_ERRORS" -ge "$THRESHOLD" ]; then
  if [ ! -f "$MARKER_FILE" ]; then
    echo "{\"triggered\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"error_count\":$RECENT_ERRORS}" > "$MARKER_FILE"
    # Output to stderr so it appears in Claude Code's hook output
    echo "APEX: $RECENT_ERRORS failures detected in recent tool calls. Consider running apex_reflect_get('micro') to analyze what's going wrong." >&2
  fi
fi
```

### Settings Configuration

Chain this after the recording hook so it checks the threshold on every tool completion:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/record-tool-outcome.sh"
          },
          {
            "type": "command",
            "command": "~/.claude/hooks/check-failure-threshold.sh"
          }
        ]
      }
    ]
  }
}
```

### Tuning the Threshold

Set the `APEX_REFLECTION_THRESHOLD` environment variable to control sensitivity:

- **3** -- Aggressive: reflect early, good for unfamiliar projects
- **5** -- Default: balanced for general use
- **10** -- Relaxed: only reflect on persistent failure patterns

You can set this in your shell profile or pass it through Claude Code's environment configuration.

### Clearing the Reflection Marker

After Claude runs a reflection cycle (`apex_reflect_get` + `apex_reflect_store`), delete the marker so future failures can trigger a new reflection:

```bash
rm -f .apex-data/reflection-needed.marker
```

The CLAUDE.md instructions should tell Claude to do this automatically after completing a reflection cycle.

---

## 3. Complete Settings Example

Here is a full `~/.claude/settings.json` snippet combining both hooks with the APEX MCP server configuration:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/record-tool-outcome.sh"
          },
          {
            "type": "command",
            "command": "~/.claude/hooks/check-failure-threshold.sh"
          }
        ]
      }
    ]
  }
}
```

Your project-level `.mcp.json` should separately configure the APEX MCP server:

```json
{
  "mcpServers": {
    "apex": {
      "command": "node",
      "args": ["path/to/apex/dist/index.js"],
      "type": "stdio"
    }
  }
}
```

---

## 4. How the Hooks Fit into the APEX Learning Loop

```
Tool Call (e.g., Bash, Edit)
    |
    v
PostToolUse hook fires
    |
    +---> record-tool-outcome.sh
    |         |
    |         v
    |     Appends micro-episode to .apex-data/hook-episodes.jsonl
    |
    +---> check-failure-threshold.sh
              |
              v
          If errors >= threshold:
              Write .apex-data/reflection-needed.marker
              Print suggestion to stderr
              |
              v
          Claude sees the suggestion and calls:
              apex_reflect_get('micro') -> analyze failures
              apex_reflect_store(...)   -> save insights
              rm reflection-needed.marker
```

The hook-recorded micro-episodes supplement the richer episodes that Claude records explicitly via `apex_record`. Together they give APEX a complete picture of tool success/failure patterns for reflection and learning.

---

## 5. Troubleshooting

**Hooks not firing:**
- Verify `~/.claude/settings.json` is valid JSON (use `python3 -m json.tool < ~/.claude/settings.json`)
- Check that hook scripts are executable: `chmod +x ~/.claude/hooks/*.sh`
- Restart Claude Code after changing `settings.json`

**No episodes being recorded:**
- Confirm `.apex-data/` directory exists in your project (run `apex_setup` first)
- Check script output manually: `echo '{"tool_name":"Bash","is_error":false}' | ~/.claude/hooks/record-tool-outcome.sh`

**Reflection never triggers:**
- Check your threshold: `tail -20 .apex-data/hook-episodes.jsonl | grep -c '"is_error":true'`
- Lower the threshold: `export APEX_REFLECTION_THRESHOLD=3`

**Python not available for JSON parsing:**
- The scripts use `python3` for lightweight JSON extraction. If unavailable, replace with `jq` or any other JSON parser on your system.
