/**
 * Plan Mode Type Definitions
 *
 * Formal interfaces for plan state, approval requests, and state transitions.
 * These types are shared between the main bot and MCP server.
 */

/**
 * Plan state persisted to /tmp/plan-state-{sessionId}.json
 */
export interface PlanState {
  /** Session ID from Claude Agent SDK */
  session_id: string | null;

  /** Whether plan mode is currently active */
  plan_mode_enabled: boolean;

  /** Filename of active plan in ~/.sickfar/plans/ */
  active_plan_file: string | null;

  /** ISO timestamp when plan mode was entered */
  plan_created_at: string;

  /** Tools allowed in plan mode */
  restricted_tools: readonly string[];

  /** Whether waiting for user approval */
  plan_approval_pending: boolean;
}

/**
 * In-memory approval request state
 */
export interface PlanApprovalRequest {
  requestId: string;
  planFile: string;
  planContent: string;
  status: "pending" | "accepted" | "rejected" | "cleared";
  createdAt: Date;
  // Promise-based response mechanism
  resolve?: (action: PlanApprovalAction) => void;
  reject?: (error: Error) => void;
}

/**
 * Structured result from ExitPlanMode MCP tool
 */
export interface ExitPlanModeResult {
  type: "plan_approval";
  requestId: string;
  planFile: string;
}

/**
 * Valid state transitions for the plan mode state machine
 */
export type PlanStateTransition =
  | { type: "ENTER_PLAN_MODE" }
  | { type: "WRITE_PLAN"; planFile: string }
  | { type: "UPDATE_PLAN"; content: string }
  | { type: "REQUEST_APPROVAL"; requestId: string }
  | { type: "APPROVE_PLAN" }
  | { type: "REJECT_PLAN" }
  | { type: "CLEAR_CONTEXT" }
  | { type: "EXIT_PLAN_MODE" };

/**
 * Approval action from user button click
 */
export type PlanApprovalAction = "accept" | "reject" | "clear";

/**
 * Create default empty state
 */
export function createEmptyState(): PlanState {
  return {
    session_id: null,
    plan_mode_enabled: false,
    active_plan_file: null,
    plan_created_at: "",
    restricted_tools: [],
    plan_approval_pending: false,
  };
}

/**
 * Type guard to check if a result is an ExitPlanMode result
 */
export function isExitPlanModeResult(data: unknown): data is ExitPlanModeResult {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return obj.type === "plan_approval" && typeof obj.requestId === "string" && typeof obj.planFile === "string";
}
