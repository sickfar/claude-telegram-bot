/**
 * Plan Mode Constants
 *
 * Shared constants between main bot and MCP server.
 * This file should remain free of side effects and async code
 * so it can be safely imported by the MCP server.
 */

import { homedir } from "os";

const HOME = homedir();

// Base directory for all plan mode data
export const SICKFAR_DIR = `${HOME}/.sickfar`;

// Plan mode paths
export const PLANS_DIR = `${SICKFAR_DIR}/plans`;
export const PLAN_MODE_LOG_FILE = `${SICKFAR_DIR}/plan-mode-mcp.log`;

// State file patterns
export const STATE_FILE_PATTERN = "/tmp/plan-state-{sessionId}.json";
export const PENDING_STATE_FILE = "/tmp/plan-state-pending.json";

// Tools allowed in plan mode
export const RESTRICTED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "WritePlan",
  "UpdatePlan",
  "ExitPlanMode",
] as const;

// MCP tool name variants for ExitPlanMode
export const EXIT_PLAN_MODE_TOOLS = [
  "ExitPlanMode",
  "mcp__plan-mode__ExitPlanMode",
] as const;

// Write tools that should be blocked when plan approval is pending
export const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"] as const;

// Plan mode system prompt
export const PLAN_MODE_SYSTEM_PROMPT = `
CRITICAL: PLAN MODE ACTIVE

You are in READ-ONLY planning mode. You MUST ONLY use these tools:
- Read, Glob, Grep: For exploring the codebase
- Bash: For read-only commands only (no modifications)
- WritePlan, UpdatePlan, ExitPlanMode: For creating/updating your plan

You CANNOT use Write, Edit, or any tools that modify system state.

Your task: Explore the codebase and create a detailed implementation plan.
When done, call ExitPlanMode to present your plan for approval.
`;

/**
 * Get state file path for a given session ID
 */
export function getStateFile(sessionId: string): string {
  return STATE_FILE_PATTERN.replace("{sessionId}", sessionId);
}

/**
 * Check if a tool name is ExitPlanMode (handles MCP prefix variants)
 */
export function isExitPlanModeTool(toolName: string): boolean {
  return (EXIT_PLAN_MODE_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Check if a tool name is a write tool
 */
export function isWriteTool(toolName: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Extract base tool name from MCP-prefixed tool name
 * e.g., "mcp__plan-mode__WritePlan" -> "WritePlan"
 */
export function getBaseToolName(toolName: string): string {
  return toolName.replace(/^mcp__[^_]+__/, "");
}

/**
 * Check if a tool is allowed in plan mode
 */
export function isToolAllowedInPlanMode(toolName: string): boolean {
  const baseName = getBaseToolName(toolName);
  return (RESTRICTED_TOOLS as readonly string[]).includes(baseName);
}
