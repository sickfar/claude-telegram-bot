/**
 * Plan State Manager
 *
 * Single source of truth for plan mode state. Handles file I/O,
 * state transitions, and approval flow.
 */

import {
  PLANS_DIR,
  PENDING_STATE_FILE,
  RESTRICTED_TOOLS,
  PLAN_MODE_SYSTEM_PROMPT,
  WRITE_TOOLS,
  getStateFile,
  getBaseToolName,
} from "./constants";
import type {
  PlanState,
  PlanApprovalRequest,
  PlanStateTransition,
  PlanApprovalAction,
} from "./types";
import { createEmptyState } from "./types";

/**
 * Manages plan mode state with optional file persistence and state machine validation.
 */
export class PlanStateManager {
  private state: PlanState = createEmptyState();
  private sessionId: string | null;
  private pendingApproval: PlanApprovalRequest | null = null;
  private persistToFile: boolean;

  constructor(sessionId: string | null = null, persistToFile: boolean = false) {
    this.sessionId = sessionId;
    this.persistToFile = persistToFile;
  }

  // ===== File I/O =====

  private get stateFilePath(): string {
    if (!this.sessionId) {
      throw new Error("Cannot access state file without session ID");
    }
    return getStateFile(this.sessionId);
  }

  /**
   * Load plan state from files. Tries session-specific file first,
   * then falls back to pending state file.
   */
  async load(): Promise<PlanState | null> {
    // Try session-specific file first
    if (this.sessionId) {
      const loaded = await this.loadFromFile(this.stateFilePath);
      if (loaded) {
        this.state = loaded;
        return loaded;
      }
    }

    // Check pending state file
    const pending = await this.loadFromFile(PENDING_STATE_FILE);
    if (pending) {
      this.state = pending;
      return pending;
    }

    return null;
  }

  private async loadFromFile(path: string): Promise<PlanState | null> {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return null;

      const text = await file.text();
      if (!text.trim()) return null;

      const parsed = JSON.parse(text);
      return this.validateState(parsed);
    } catch (error) {
      console.warn(`[PlanState] Failed to load from ${path}:`, error);
      return null;
    }
  }

  private validateState(data: unknown): PlanState | null {
    if (!data || typeof data !== "object") return null;

    const obj = data as Record<string, unknown>;

    return {
      session_id: typeof obj.session_id === "string" ? obj.session_id : null,
      plan_mode_enabled: obj.plan_mode_enabled === true,
      active_plan_file:
        typeof obj.active_plan_file === "string" ? obj.active_plan_file : null,
      plan_created_at:
        typeof obj.plan_created_at === "string" ? obj.plan_created_at : "",
      restricted_tools: Array.isArray(obj.restricted_tools)
        ? obj.restricted_tools
        : [...RESTRICTED_TOOLS],
      plan_approval_pending: obj.plan_approval_pending === true,
    };
  }

  /**
   * Save current state to file (if persistence is enabled).
   */
  async save(): Promise<void> {
    if (!this.persistToFile) {
      console.log(`[PlanState] Skipping file save (in-memory mode)`);
      return;
    }

    const stateJson = JSON.stringify(this.state, null, 2);

    if (!this.sessionId) {
      // Save to pending file
      await Bun.write(PENDING_STATE_FILE, stateJson);
      console.log(`[PlanState] Saved to pending file`);
      return;
    }

    await Bun.write(this.stateFilePath, stateJson);
    console.log(`[PlanState] Saved to ${this.stateFilePath}`);
  }

  // ===== State Transitions =====

  /**
   * Apply a state transition with validation.
   */
  async transition(action: PlanStateTransition): Promise<boolean> {
    console.log(`[PlanState] Transition: ${action.type}`);

    switch (action.type) {
      case "ENTER_PLAN_MODE":
        this.state = {
          session_id: this.sessionId,
          plan_mode_enabled: true,
          active_plan_file: null,
          plan_created_at: new Date().toISOString(),
          restricted_tools: [...RESTRICTED_TOOLS],
          plan_approval_pending: false,
        };
        break;

      case "WRITE_PLAN":
        if (!this.state.plan_mode_enabled) {
          console.warn(`[PlanState] Cannot write plan - plan mode not enabled`);
          return false;
        }
        this.state.active_plan_file = action.planFile;
        break;

      case "UPDATE_PLAN":
        if (!this.state.active_plan_file) {
          console.warn(`[PlanState] Cannot update plan - no active plan file`);
          return false;
        }
        // Content is written to file separately
        break;

      case "REQUEST_APPROVAL":
        if (!this.state.active_plan_file) {
          console.warn(
            `[PlanState] Cannot request approval - no active plan file`
          );
          return false;
        }
        this.state.plan_approval_pending = true;
        break;

      case "APPROVE_PLAN":
        this.state.plan_mode_enabled = false;
        this.state.plan_approval_pending = false;
        break;

      case "REJECT_PLAN":
        this.state.plan_approval_pending = false;
        // Plan mode remains enabled, user can refine
        break;

      case "CLEAR_CONTEXT":
        this.state = createEmptyState();
        this.pendingApproval = null;
        break;

      case "EXIT_PLAN_MODE":
        this.state.plan_mode_enabled = false;
        break;

      default:
        console.warn(`[PlanState] Unknown transition: ${(action as { type: string }).type}`);
        return false;
    }

    await this.save();
    return true;
  }

  // ===== Queries =====

  /**
   * Check if plan mode is enabled.
   */
  isEnabled(): boolean {
    return this.state.plan_mode_enabled;
  }

  /**
   * Check if waiting for user approval.
   */
  isApprovalPending(): boolean {
    return this.state.plan_approval_pending;
  }

  /**
   * Get active plan filename.
   */
  getActivePlanFile(): string | null {
    return this.state.active_plan_file;
  }

  /**
   * Get system prompt if plan mode is enabled.
   */
  getSystemPrompt(): string | null {
    return this.state.plan_mode_enabled ? PLAN_MODE_SYSTEM_PROMPT : null;
  }

  /**
   * Get current state (read-only).
   */
  getState(): Readonly<PlanState> {
    return this.state;
  }

  /**
   * Get current session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  // ===== Tool Validation =====

  /**
   * Check if a tool is allowed in plan mode.
   */
  isToolAllowed(toolName: string): boolean {
    if (!this.state.plan_mode_enabled) return true;

    const baseName = getBaseToolName(toolName);
    return (this.state.restricted_tools as readonly string[]).includes(
      baseName
    );
  }

  /**
   * Check if a tool should be blocked.
   * Returns [shouldBlock, reason].
   */
  shouldBlockTool(toolName: string): [boolean, string | null] {
    // Block write tools if approval pending
    if (this.state.plan_approval_pending) {
      const baseName = getBaseToolName(toolName);
      if ((WRITE_TOOLS as readonly string[]).includes(baseName)) {
        return [true, "Plan approval pending - write operations blocked"];
      }
    }

    return [false, null];
  }

  // ===== Approval Handling =====

  /**
   * Set pending approval request.
   */
  setPendingApproval(
    planFile: string,
    planContent: string,
    requestId: string
  ): void {
    this.pendingApproval = {
      requestId,
      planFile,
      planContent,
      status: "pending",
      createdAt: new Date(),
    };
    console.log(`[PlanState] Set pending approval: ${requestId}`);
  }

  /**
   * Get pending approval request.
   */
  getPendingApproval(): PlanApprovalRequest | null {
    return this.pendingApproval;
  }

  /**
   * Handle user approval response.
   * Returns [success, message, shouldContinueSession].
   */
  async handleApprovalResponse(
    requestId: string,
    action: PlanApprovalAction
  ): Promise<[boolean, string, boolean]> {
    if (!this.pendingApproval) {
      return [false, "No pending approval", false];
    }

    if (this.pendingApproval.requestId !== requestId) {
      return [false, "Request ID mismatch", false];
    }

    const planFile = this.pendingApproval.planFile;

    switch (action) {
      case "accept":
        this.pendingApproval.status = "accepted";
        this.pendingApproval = null;
        await this.transition({ type: "APPROVE_PLAN" });
        return [true, `✅ <b>Plan Accepted</b>\n\nFile: <code>${planFile}</code>`, true];

      case "reject":
        this.pendingApproval.status = "rejected";
        this.pendingApproval = null;
        await this.transition({ type: "REJECT_PLAN" });
        return [true, `❌ <b>Plan Rejected</b>\n\nFile: <code>${planFile}</code>`, false];

      case "clear":
        this.pendingApproval.status = "cleared";
        this.pendingApproval = null;
        await this.transition({ type: "CLEAR_CONTEXT" });
        return [true, `🗑️ <b>Context Cleared</b>\n\nFile: <code>${planFile}</code>`, false];

      default:
        return [false, "Invalid action", false];
    }
  }

  // ===== Session Lifecycle =====

  /**
   * Update session ID and migrate pending state if needed.
   */
  async updateSessionId(sessionId: string): Promise<void> {
    const hadNoSession = !this.sessionId;
    this.sessionId = sessionId;
    this.state.session_id = sessionId;

    // Migrate pending state to session-specific file
    if (hadNoSession) {
      try {
        const pendingFile = Bun.file(PENDING_STATE_FILE);
        if (await pendingFile.exists()) {
          const text = await pendingFile.text();
          if (text.trim()) {
            // Save current state to session file
            await this.save();
            // Clear pending file
            await Bun.write(PENDING_STATE_FILE, "");
            console.log(
              `[PlanState] Migrated pending state to session ${sessionId.slice(0, 8)}...`
            );
          }
        }
      } catch (error) {
        console.warn(`[PlanState] Failed to migrate pending state:`, error);
      }
    }
  }

  /**
   * Cleanup state files.
   */
  async cleanup(): Promise<void> {
    if (this.sessionId) {
      try {
        const { unlink } = await import("fs/promises");
        await unlink(this.stateFilePath);
        console.log(`[PlanState] Cleaned up ${this.stateFilePath}`);
      } catch {
        // Ignore cleanup errors
      }
    }
    this.state = createEmptyState();
    this.pendingApproval = null;
  }

  // ===== Plan Content =====

  /**
   * Read active plan content from file.
   */
  async readPlanContent(): Promise<string | null> {
    const planFile = this.state.active_plan_file;
    if (!planFile) return null;

    const planPath = `${PLANS_DIR}/${planFile}`;
    try {
      const file = Bun.file(planPath);
      if (await file.exists()) {
        return await file.text();
      }
    } catch (error) {
      console.warn(`[PlanState] Failed to read plan content:`, error);
    }
    return null;
  }

  /**
   * Get full plan file path.
   */
  getPlanFilePath(): string | null {
    const planFile = this.state.active_plan_file;
    if (!planFile) return null;
    return `${PLANS_DIR}/${planFile}`;
  }
}
