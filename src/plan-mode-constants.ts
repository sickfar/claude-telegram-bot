/**
 * Plan Mode Constants - Re-exports from new module.
 *
 * This file maintains backward compatibility with existing imports,
 * particularly the MCP server which imports from this path.
 *
 * @deprecated Import from "./plan-mode" instead.
 */

export {
  SICKFAR_DIR,
  PLANS_DIR,
  PLAN_MODE_LOG_FILE,
  STATE_FILE_PATTERN,
  PENDING_STATE_FILE,
  RESTRICTED_TOOLS,
  EXIT_PLAN_MODE_TOOLS,
  WRITE_TOOLS,
  PLAN_MODE_SYSTEM_PROMPT,
  getStateFile,
  isExitPlanModeTool,
  isWriteTool,
} from "./plan-mode";
