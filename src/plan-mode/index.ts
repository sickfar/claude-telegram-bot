/**
 * Plan Mode Module
 *
 * Public API for plan mode functionality.
 */

// Types
export type {
  PlanState,
  PlanApprovalRequest,
  PlanStateTransition,
  PlanApprovalAction,
  ExitPlanModeResult,
} from "./types";
export { createEmptyState, isExitPlanModeResult } from "./types";

// Constants
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
  getBaseToolName,
  isToolAllowedInPlanMode,
} from "./constants";

// State Manager
export { PlanStateManager } from "./state-manager";
