/**
 * APEX MCP Tool Handlers
 *
 * Stub implementations for all APEX tools.
 * Each handler returns a proper MCP response structure.
 * Real implementations will replace the stubs as subsystems come online.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Types will be fleshed out as the project evolves
// import type { ... } from '../types.js';

function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function stub(toolName: string, args: Record<string, unknown>): CallToolResult {
  return ok({
    status: 'not_yet_implemented',
    tool: toolName,
    message: `${toolName} handler is stubbed. Implementation pending.`,
    receivedArgs: args,
  });
}

// ── Handler implementations ───────────────────────────────────────

async function handleRecall(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_recall', args);
}

async function handleRecord(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_record', args);
}

async function handleReflectGet(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_reflect_get', args);
}

async function handleReflectStore(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_reflect_store', args);
}

async function handlePlanContext(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_plan_context', args);
}

async function handleSkills(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_skills', args);
}

async function handleSkillStore(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_skill_store', args);
}

async function handleStatus(_args: Record<string, unknown>): Promise<CallToolResult> {
  return ok({
    status: 'ok',
    tool: 'apex_status',
    memory: {
      episodes: 0,
      reflections: { micro: 0, meso: 0, macro: 0 },
      skills: 0,
      snapshots: 0,
    },
    message: 'APEX is running. Memory subsystems not yet connected.',
  });
}

async function handleConsolidate(_args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_consolidate', _args);
}

async function handleCurriculum(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_curriculum', args);
}

async function handleSetup(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_setup', args);
}

async function handleSnapshot(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_snapshot', args);
}

async function handleRollback(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_rollback', args);
}

async function handlePromote(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_promote', args);
}

async function handleImport(args: Record<string, unknown>): Promise<CallToolResult> {
  return stub('apex_import', args);
}

// ── Exported handler map ──────────────────────────────────────────

export const handlers = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>([
  ['apex_recall', handleRecall],
  ['apex_record', handleRecord],
  ['apex_reflect_get', handleReflectGet],
  ['apex_reflect_store', handleReflectStore],
  ['apex_plan_context', handlePlanContext],
  ['apex_skills', handleSkills],
  ['apex_skill_store', handleSkillStore],
  ['apex_status', handleStatus],
  ['apex_consolidate', handleConsolidate],
  ['apex_curriculum', handleCurriculum],
  ['apex_setup', handleSetup],
  ['apex_snapshot', handleSnapshot],
  ['apex_rollback', handleRollback],
  ['apex_promote', handlePromote],
  ['apex_import', handleImport],
]);
