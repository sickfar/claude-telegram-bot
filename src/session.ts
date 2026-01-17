/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the Agent SDK V1.
 * V1 supports full options (cwd, mcpServers, settingSources, etc.)
 */

import {
  query,
  type Options,
  type SDKMessage,
  type HookCallback,
  type PostToolUseHookInput,
  type PreCompactHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import type { Context } from "grammy";
import {
  getAllowedPaths,
  MCP_SERVERS,
  getSafetyPrompt,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  getWorkingDir,
  getPermissionMode,
  getModel,
  getThinkingLevel,
  getThinkingLevelName,
  PLAN_MODE,
  getPlanStateFile,
  isExitPlanModeTool,
  isWriteTool,
  getBaseToolName,
  PlanStateManager,
} from "./config";
import { WRITE_TOOLS } from "./plan-mode/constants";
import type { PlanApprovalAction } from "./plan-mode";
import { formatToolStatus } from "./formatting";
import {
  displayPermissionRequest,
  formatPermissionRequest,
  StreamingState,
  updateBashToolMessage,
} from "./handlers/streaming";
import {
  createPermissionRequest,
  waitForPermission,
  loadProjectPermissions,
  matchesPermission,
} from "./permissions";
import { permissionStore } from "./permission-store";
import { askUserStore } from "./ask-user-store";
import { checkCommandSafety, isPathAllowed } from "./security";
import type { SessionData, StatusCallback, TokenUsage } from "./types";

/**
 * Extract text content from SDK message.
 */
function getTextFromMessage(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;

  const textParts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("") : null;
}

/**
 * Check if plan mode is enabled using PlanStateManager.
 * Returns the plan mode system prompt if active, undefined otherwise.
 */
async function getPlanModePrompt(
  manager: PlanStateManager
): Promise<string | undefined> {
  await manager.load();
  return manager.getSystemPrompt() ?? undefined;
}

/**
 * Manages Claude Code sessions using the Agent SDK V1.
 */
class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;

  // Plan mode state manager (with file persistence for state across messages/restarts)
  planStateManager: PlanStateManager = new PlanStateManager(null, true);

  private abortController: AbortController | null = null;
  private isQueryRunning = false;
  private stopRequested = false;
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;
  private pendingPlanInjection: { filename: string; content: string } | null =
    null;

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning || this._isProcessing;
  }

  /**
   * Check if the last stop was triggered by a new message interrupt (! prefix).
   * Resets the flag when called. Also clears stopRequested so new messages can proceed.
   */
  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      // Clear stopRequested so the new message can proceed
      this.stopRequested = false;
    }
    return was;
  }

  /**
   * Mark that this stop is from a new message interrupt.
   */
  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  /**
   * Clear the stopRequested flag (used after interrupt to allow new message to proceed).
   */
  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /**
   * Mark processing as started.
   * Returns a cleanup function to call when done.
   */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Stop the currently running query or mark for cancellation.
   * Returns: "stopped" if query was aborted, "pending" if processing will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    // If a query is actively running, abort it
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      this.abortController.abort();
      console.log("Stop requested - aborting current query");
      return "stopped";
    }

    // If processing but query not started yet
    if (this._isProcessing) {
      this.stopRequested = true;
      console.log("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  /**
   * Send a message to Claude with streaming updates via callback.
   *
   * @param ctx - grammY context for ask_user button display
   * @param state - StreamingState for tracking tool messages (used by PostToolUse hook)
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context,
    state?: StreamingState
  ): Promise<string> {
    // Set chat context for ask_user and plan_mode MCP tools
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }
    if (this.sessionId) {
      process.env.TELEGRAM_SESSION_ID = this.sessionId;
    }

    // Set ask-user display function - called synchronously when ask_user is invoked
    if (ctx && chatId) {
      askUserStore.setDisplayFn(async (question, options, requestId) => {
        console.log(`[ASK-USER] Displaying UI for ${requestId}`);
        try {
          const { createAskUserKeyboard } = await import("./handlers/streaming");
          const keyboard = createAskUserKeyboard(requestId, options);
          await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
          console.log(`[ASK-USER] UI displayed successfully`);
        } catch (error) {
          console.error(`[ASK-USER] Failed to display UI:`, error);
          throw error;
        }
      });
    }

    const isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel();
    const thinkingLabel = getThinkingLevelName();

    // Check for pending plan injection
    let messageToSend = message;
    if (this.pendingPlanInjection) {
      const { filename, content } = this.pendingPlanInjection;
      messageToSend = `[CONTEXT: Resumed session with active plan]\n\nPlan file: ${filename}\n\n${content}\n\n---\n\n${message}`;
      this.pendingPlanInjection = null;
    }

    // Update plan state manager session ID if needed (preserve state across messages)
    // Only create new manager for fresh sessions, otherwise keep existing state
    if (isNewSession) {
      this.planStateManager = new PlanStateManager(this.sessionId, true);
    }

    // Set plan approval display function - MUST be done after PlanStateManager is created/updated
    if (ctx && chatId) {
      this.planStateManager.setDisplayApprovalFn(async (planFile, planContent, requestId) => {
        console.log(`[PLAN-APPROVAL] Displaying approval UI for ${requestId}`);
        try {
          const { displayPlanApproval } = await import("./handlers/plan-approval");
          await displayPlanApproval(ctx, planFile, planContent, requestId);
          console.log(`[PLAN-APPROVAL] Approval UI displayed successfully`);
        } catch (error) {
          console.error(`[PLAN-APPROVAL] Failed to display approval UI:`, error);
          throw error;
        }
      });
    }

    // Build system prompt with plan mode if active
    const planModePrompt = await getPlanModePrompt(this.planStateManager);
    const safetyPrompt = getSafetyPrompt();
    const systemPrompt = planModePrompt
      ? `${safetyPrompt}\n\n${planModePrompt}`
      : safetyPrompt;

    // Check if plan mode is enabled (used for write tool blocking)
    const inPlanMode = this.planStateManager.isEnabled();
    // Bypass permissions only if not in plan mode AND permission mode is not interactive
    // In plan mode, we need the callback to block write tools
    const permissionMode = getPermissionMode();
    const shouldBypassPermissions = !inPlanMode && permissionMode !== "interactive";
    console.log(`[PLAN MODE DEBUG] inPlanMode=${inPlanMode}, permissionMode=${permissionMode}, shouldBypassPermissions=${shouldBypassPermissions}`);

    // Build SDK V1 options - supports all features
    const options: Options = {
      model: getModel(),
      cwd: getWorkingDir(),
      settingSources: ["user", "project"],
      // Only set permissionMode when bypassing - omit otherwise to allow canUseTool callback
      ...(shouldBypassPermissions && { permissionMode: "bypassPermissions" }),
      allowDangerouslySkipPermissions: shouldBypassPermissions,
      // In plan mode, block write tools at SDK level
      ...(inPlanMode && { disallowedTools: [...WRITE_TOOLS] }),
      systemPrompt: systemPrompt,
      mcpServers: MCP_SERVERS,
      maxThinkingTokens: thinkingTokens,
      additionalDirectories: getAllowedPaths(),
      resume: this.sessionId || undefined,

      // Permission callback for interactive mode
      canUseTool: async (
        toolName: string,
        toolInput: Record<string, unknown>
      ) => {
        console.log(`[PERMISSION DEBUG] canUseTool invoked for: ${toolName}`);

        // In plan mode, block write tools entirely (check FIRST, before any bypass)
        if (inPlanMode && isWriteTool(getBaseToolName(toolName))) {
          console.log(`[PLAN MODE] Blocked write tool: ${toolName}`);
          return {
            behavior: "deny",
            message: `Tool "${getBaseToolName(toolName)}" is blocked in plan mode.`,
            // NOTE: Do NOT set interrupt: true - it ends the turn before Claude can respond
          };
        }

        // If bypass mode, allow everything (only reached if not blocked above)
        if (shouldBypassPermissions) {
          console.log(`[PERMISSION DEBUG] Bypassing permissions`);
          return { behavior: "allow", updatedInput: toolInput };
        }

        // Always allow our internal MCP tools (plan-mode) without permission prompts
        if (toolName.startsWith("mcp__plan-mode__")) {
          console.log(`[PERMISSION DEBUG] Auto-allowing internal MCP tool: ${toolName}`);
          return { behavior: "allow", updatedInput: toolInput };
        }

        // Handle built-in AskUserQuestion tool
        if (toolName === "AskUserQuestion") {
          console.log(`[ASK-USER] AskUserQuestion called`);
          return await this.handleAskUserQuestion(toolInput, ctx, chatId);
        }

        // Serialize tool input for processing
        const toolInputStr = JSON.stringify(toolInput);

        // Check catastrophic commands (keep defense-in-depth)
        if (toolName === "Bash") {
          // Extract command from Bash tool input
          const command =
            typeof toolInput.command === "string"
              ? toolInput.command
              : toolInputStr;
          const [isSafe, reason] = checkCommandSafety(command);
          if (!isSafe) {
            return {
              behavior: "deny",
              message: `Blocked: ${reason}`,
              // NOTE: Do NOT set interrupt: true - it ends the turn before Claude can respond
            };
          }
        }

        // Check stored project permissions (from .claude/settings.local.json)
        const workingDir = getWorkingDir();
        const storedPermissions = loadProjectPermissions(workingDir);
        if (matchesPermission(toolName, toolInput, storedPermissions, workingDir)) {
          console.log(`[PERMISSION] Auto-allowed by stored rule for: ${toolName}`);
          return { behavior: "allow", updatedInput: toolInput };
        }

        // Format the permission request for display
        const formattedRequest = formatPermissionRequest(
          toolName,
          toolInputStr
        );

        console.log(`[PERMISSION DEBUG] Creating permission request...`);
        // Create permission request
        const requestId = createPermissionRequest(
          chatId!,
          toolName,
          toolInputStr,
          formattedRequest
        );

        // Display UI immediately - no waiting, no race condition
        if (ctx) {
          console.log(`[PERMISSION DEBUG] Displaying UI for ${requestId}...`);
          await displayPermissionRequest(ctx, requestId, formattedRequest);
        } else {
          console.warn(`[PERMISSION DEBUG] No ctx available, cannot display permission UI`);
        }

        console.log(`[PERMISSION DEBUG] Awaiting Promise for ${requestId}...`);
        // Wait for user to click Allow/Deny (event-based, no timeout)
        const result = await waitForPermission(requestId);
        console.log(`[PERMISSION DEBUG] Promise resolved with result:`, result.behavior);

        return result;
      },

      // PostToolUse hook to update Bash tool messages with output
      hooks: ctx && state ? {
        PostToolUse: [{
          hooks: [async (input, toolUseId) => {
            const hookInput = input as PostToolUseHookInput;

            // Only handle Bash tools
            if (hookInput.tool_name !== "Bash") {
              return { continue: true };
            }

            // Extract command and output from the hook input
            const toolInput = hookInput.tool_input as Record<string, unknown>;
            const command = String(toolInput.command || "");
            const toolResponse = hookInput.tool_response as { stdout?: string; stderr?: string; exitCode?: number } | string;

            // Handle different response formats
            let output = "";
            let isError = false;

            if (typeof toolResponse === "string") {
              output = toolResponse;
              isError = false;
            } else if (toolResponse) {
              // Check for error (non-zero exit code or stderr)
              isError = (toolResponse.exitCode !== undefined && toolResponse.exitCode !== 0) ||
                        (!!toolResponse.stderr && !toolResponse.stdout);
              output = isError ? (toolResponse.stderr || "") : (toolResponse.stdout || "");
            }

            // Update the Telegram message
            if (toolUseId) {
              await updateBashToolMessage(ctx!, state!, toolUseId, command, output, isError);
            }

            return { continue: true };
          }] as HookCallback[],
        }],
        PreCompact: [{
          hooks: [async (input) => {
            const hookInput = input as PreCompactHookInput;
            console.log(`[COMPACTION] Pre-compaction triggered: ${hookInput.trigger}`);

            // Send notification to Telegram
            try {
              await ctx.reply("Compacting conversation...");
            } catch (error) {
              console.warn(`[COMPACTION] Failed to send notification:`, error);
            }

            return { continue: true };
          }] as HookCallback[],
        }],
      } : undefined,
    };

    // Add Claude Code executable path if set (required for standalone builds)
    if (process.env.CLAUDE_CODE_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
    }

    if (this.sessionId && !isNewSession) {
      console.log(
        `RESUMING session ${this.sessionId.slice(
          0,
          8
        )}... (thinking=${thinkingLabel})`
      );
    } else {
      console.log(`STARTING new Claude session (thinking=${thinkingLabel})`);
      this.sessionId = null;
      // Clear any pending requests from previous session
      permissionStore.clearAll();
      askUserStore.clearAll();
    }

    // Check if stop was requested during processing phase
    if (this.stopRequested) {
      console.log(
        "Query cancelled before starting (stop was requested during processing)"
      );
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    // Create abort controller for cancellation
    this.abortController = new AbortController();
    this.isQueryRunning = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    // Response tracking
    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;
    let planApprovalRequested = false; // Track if ExitPlanMode was called (to block subsequent writes)

    try {
      // Use V1 query() API - supports all options including cwd, mcpServers, etc.
      const queryInstance = query({
        prompt: messageToSend,
        options: {
          ...options,
          abortController: this.abortController,
        },
      });

      // Process streaming response
      for await (const event of queryInstance) {
        // Check for abort
        if (this.stopRequested) {
          console.log("Query aborted by user");
          break;
        }

        // Capture session_id from first message
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id;
          console.log(`GOT session_id: ${this.sessionId!.slice(0, 8)}...`);

          // Update plan state manager with session ID (migrates pending state if exists)
          await this.planStateManager.updateSessionId(this.sessionId);

          this.saveSession();
        }

        // Handle different message types
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            // Thinking blocks
            if (block.type === "thinking") {
              const thinkingText = block.thinking;
              if (thinkingText) {
                console.log(`THINKING BLOCK: ${thinkingText.slice(0, 100)}...`);
                await statusCallback("thinking", thinkingText);
              }
            }

            // Tool use blocks
            if (block.type === "tool_use") {
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown>;
              const toolUseId = block.id;

              // Check for ExitPlanMode - set flag to prevent subsequent modifications
              if (isExitPlanModeTool(toolName)) {
                planApprovalRequested = true;
                console.log(`[PLAN] ExitPlanMode detected (${toolName}) - blocking subsequent write operations`);
              }

              // Block write operations if plan approval is pending
              const [shouldBlock, blockReason] = this.planStateManager.shouldBlockTool(toolName);
              if (shouldBlock || (isWriteTool(toolName) && planApprovalRequested)) {
                const reason = blockReason || "plan approval pending";
                console.warn(`BLOCKED: ${toolName} not allowed - ${reason}`);
                await statusCallback("tool", `BLOCKED: ${toolName} not allowed - ${reason}`);
                throw new Error(`${toolName} blocked: ${reason}`);
              }

              // Safety check for Bash commands
              if (toolName === "Bash") {
                const command = String(toolInput.command || "");
                const [isSafe, reason] = checkCommandSafety(command);
                if (!isSafe) {
                  console.warn(`BLOCKED: ${reason}`);
                  await statusCallback("tool", `BLOCKED: ${reason}`);
                  throw new Error(`Unsafe command blocked: ${reason}`);
                }
              }

              // Safety check for file operations
              if (["Read", "Write", "Edit"].includes(toolName)) {
                const filePath = String(toolInput.file_path || "");
                if (filePath) {
                  // Allow reads from temp paths and .claude directories
                  const isTmpRead =
                    toolName === "Read" &&
                    (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
                      filePath.includes("/.claude/"));

                  if (!isTmpRead && !isPathAllowed(filePath)) {
                    console.warn(
                      `BLOCKED: File access outside allowed paths: ${filePath}`
                    );
                    await statusCallback("tool", `Access denied: ${filePath}`);
                    throw new Error(`File access blocked: ${filePath}`);
                  }
                }
              }

              // Segment ends when tool starts
              if (currentSegmentText) {
                await statusCallback(
                  "segment_end",
                  currentSegmentText,
                  currentSegmentId
                );
                currentSegmentId++;
                currentSegmentText = "";
              }

              // Format and show tool status
              const toolDisplay = formatToolStatus(toolName, toolInput);
              this.currentTool = toolDisplay;
              this.lastTool = toolDisplay;
              console.log(`Tool: ${toolDisplay}`);

              // Don't show tool status for ask_user - the buttons are self-explanatory
              if (!toolName.startsWith("mcp__ask-user")) {
                await statusCallback("tool", toolDisplay, undefined, toolUseId);
              }

              // Ask-user and ExitPlanMode tools use promise-based flow - no polling needed!
              // The onRequestCreated/onApprovalCreated callbacks (registered at start of sendMessageStreaming)
              // handle button display immediately. The MCP handlers block until user responds.

              // Permission UI is now displayed directly from canUseTool callback
              // No need to check for pending requests here
            }

            // Text content
            if (block.type === "text") {
              const text = block.text;

              responseParts.push(text);
              currentSegmentText += text;

              // Stream text updates (throttled)
              const now = Date.now();
              if (
                now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                currentSegmentText.length > 20
              ) {
                await statusCallback(
                  "text",
                  currentSegmentText,
                  currentSegmentId
                );
                lastTextUpdate = now;
              }
            }
          }

        }

        // Result message
        if (event.type === "result") {
          console.log("Response complete");
          queryCompleted = true;

          // Capture usage if available
          if ("usage" in event && event.usage) {
            this.lastUsage = event.usage as TokenUsage;
            const u = this.lastUsage;
            console.log(
              `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${
                u.cache_read_input_tokens || 0
              } cache_create=${u.cache_creation_input_tokens || 0}`
            );
          }
        }
      }

      // V1 query completes automatically when the generator ends
    } catch (error) {
      const errorStr = String(error).toLowerCase();
      const isCleanupError =
        errorStr.includes("cancel") || errorStr.includes("abort");

      if (
        isCleanupError &&
        (queryCompleted || this.stopRequested)
      ) {
        console.warn(`Suppressed post-completion error: ${error}`);
      } else {
        console.error(`Error in query: ${error}`);
        this.lastError = String(error).slice(0, 100);
        this.lastErrorTime = new Date();
        throw error;
      }
    } finally {
      this.isQueryRunning = false;
      this.abortController = null;
      this.queryStarted = null;
      this.currentTool = null;
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // Emit final segment
    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    await statusCallback("done", "");

    return responseParts.join("") || "No response from Claude.";
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
    // Clean up plan state file before clearing
    await this.planStateManager.cleanup();

    this.sessionId = null;
    this.lastActivity = null;
    // Reset plan state manager
    this.planStateManager = new PlanStateManager(null, true);
    console.log("Session cleared");
  }

  /**
   * Handle built-in AskUserQuestion tool.
   * Processes 1-4 questions sequentially, displays UI via Telegram buttons, and collects answers.
   */
  private async handleAskUserQuestion(
    input: any,
    ctx: Context | undefined,
    chatId: number | undefined
  ): Promise<{ behavior: "allow"; updatedInput: any }> {
    if (!ctx || !chatId) {
      throw new Error("AskUserQuestion requires context and chatId");
    }

    const questions = input.questions || [];
    if (questions.length === 0) {
      throw new Error("AskUserQuestion called with no questions");
    }

    console.log(`[ASK-USER] Handling ${questions.length} question(s)`);
    const answers: Record<string, string> = {};

    // Handle each question sequentially
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const requestId = `askuser_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      console.log(`[ASK-USER] Processing question ${i + 1}/${questions.length}: "${q.question}"`);

      // Extract option labels from the options array
      const optionLabels = q.options.map((opt: any) => opt.label);

      // Create request and wait for answer (display function already set in askUserStore)
      // This will automatically add "Other" option and handle custom text input
      const answer = await askUserStore.createWithPromise(
        requestId,
        chatId.toString(),
        q.question,
        optionLabels
      );

      console.log(`[ASK-USER] Answer for "${q.header}": ${answer}`);

      // Store answer mapped by header
      answers[q.header] = answer;
    }

    console.log(`[ASK-USER] All questions answered:`, answers);

    // Return the updated input with answers in the format SDK expects
    return {
      behavior: "allow",
      updatedInput: {
        questions: input.questions,
        answers: answers
      }
    };
  }

  /**
   * Handle plan approval response.
   * Delegates to PlanStateManager.
   * Returns: [success, message, shouldContinue]
   */
  handlePlanApproval(
    requestId: string,
    action: PlanApprovalAction
  ): [boolean, string, boolean] {
    const approval = this.planStateManager.getPendingApproval();
    if (!approval) {
      return [false, "No pending plan approval", false];
    }

    if (approval.requestId !== requestId) {
      return [false, "Request ID mismatch", false];
    }

    // Note: The actual state transition is done asynchronously in the callback handler
    // Here we just return the response synchronously
    if (action.type === "accept") {
      const msg = `✅ <b>Plan Accepted</b>\n\nFile: <code>${approval.planFile}</code>`;
      return [true, msg, true];
    } else if (action.type === "reject") {
      const msg = `❌ <b>Plan Rejected</b>\n\nFile: <code>${approval.planFile}</code>`;
      return [true, msg, false];
    } else if (action.type === "clear") {
      const msg = `🗑️ <b>Context Cleared</b>\n\nFile: <code>${approval.planFile}</code>`;
      return [true, msg, false];
    }

    return [false, "Invalid action", false];
  }

  /**
   * Get pending plan approval info (for callback handler).
   */
  getPendingPlanApproval(): {
    planFile: string;
    planContent: string;
    requestId: string;
    resolve?: (action: PlanApprovalAction) => void;
  } | null {
    const approval = this.planStateManager.getPendingApproval();
    if (!approval) return null;
    return {
      planFile: approval.planFile,
      planContent: approval.planContent,
      requestId: approval.requestId,
      resolve: approval.resolve,
    };
  }

  /**
   * Save session to disk for resume after restart.
   */
  private async saveSession(): Promise<void> {
    if (!this.sessionId) return;

    try {
      const workingDir = getWorkingDir();
      const data: SessionData = {
        session_id: this.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: workingDir,
      };

      // Add new metadata for session listing
      data.last_activity = this.lastActivity?.toISOString() || data.saved_at;
      if (this.lastMessage) {
        data.last_message_preview = this.lastMessage.slice(0, 50);
      }

      // Extract project name from working directory
      const { getProjectName } = await import("./session-storage");
      data.project_name = getProjectName(workingDir);

      // Get plan mode state from manager
      const planState = this.planStateManager.getState();
      if (planState.plan_mode_enabled) {
        data.plan_mode_enabled = true;
      }
      if (planState.active_plan_file) {
        data.active_plan_file = planState.active_plan_file;
      }
      if (planState.plan_approval_pending) {
        data.plan_approval_pending = true;
      }

      // Use new directory-based storage
      const { saveSessionToDirectory } = await import("./session-storage");
      await saveSessionToDirectory(data);
    } catch (error) {
      console.warn(`Failed to save session: ${error}`);
    }
  }

  /**
   * Read last N messages from session .jsonl file.
   * Returns array of {role: 'user'|'assistant', content: string}
   */
  private readLastMessages(jsonlPath: string, count: number): Array<{role: string, content: string}> {
    try {
      const { readFileSync } = require("fs");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.trim().split("\n").filter((l: string) => l.trim());

      const messages: Array<{role: string, content: string}> = [];

      // Parse JSONL lines in reverse to get last messages
      for (let i = lines.length - 1; i >= 0 && messages.length < count * 2; i--) {
        try {
          const line = JSON.parse(lines[i]!);

          if (line.type === "user") {
            messages.unshift({role: "user", content: line.message});
          } else if (line.type === "assistant") {
            // Extract text from assistant message
            const textBlocks = line.message?.content?.filter((b: any) => b.type === "text") || [];
            const text = textBlocks.map((b: any) => b.text).join("\n");
            if (text) {
              messages.unshift({role: "assistant", content: text});
            }
          }
        } catch (e) {
          // Skip invalid lines
        }
      }

      // Return last 'count' exchanges (user + assistant pairs)
      return messages.slice(-count * 2);
    } catch (error) {
      console.warn(`Failed to read session messages: ${error}`);
      return [];
    }
  }

  /**
   * Resume a specific session by ID.
   * @param sessionId - Full session ID to resume
   * @returns [success, message, lastMessages?]
   */
  async resumeById(sessionId: string): Promise<[success: boolean, message: string, lastMessages?: Array<{role: string, content: string}>]> {
    try {
      const { getSessionMetaFilePath, getClaudeProjectDir } = await import("./session-storage");
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");

      // Check if the session .jsonl file exists (SDK session file)
      const projectDir = getClaudeProjectDir();
      const jsonlPath = join(projectDir, `${sessionId}.jsonl`);

      if (!existsSync(jsonlPath)) {
        return [false, "Session file not found"];
      }

      // Try to load metadata if it exists
      const metaPath = getSessionMetaFilePath(sessionId);
      let data: SessionData;

      if (existsSync(metaPath)) {
        const text = readFileSync(metaPath, "utf-8");
        data = JSON.parse(text);
      } else {
        // SDK session without metadata - read from sessions-index.json
        const indexPath = join(projectDir, "sessions-index.json");

        if (existsSync(indexPath)) {
          const indexText = readFileSync(indexPath, "utf-8");
          const index = JSON.parse(indexText) as { entries: Array<{ sessionId: string; projectPath: string; created: string; modified: string; firstPrompt: string }> };
          const entry = index.entries.find(e => e.sessionId === sessionId);

          if (entry) {
            const { getProjectName } = await import("./session-storage");
            data = {
              session_id: sessionId,
              saved_at: entry.created,
              working_dir: entry.projectPath,
              last_activity: entry.modified,
              project_name: getProjectName(entry.projectPath),
              last_message_preview: entry.firstPrompt.slice(0, 50),
            };
          } else {
            return [false, "Session not found in index"];
          }
        } else {
          // Fallback to file stats if no index (shouldn't happen)
          const { statSync } = await import("fs");
          const stat = statSync(jsonlPath);
          const { getProjectName } = await import("./session-storage");

          data = {
            session_id: sessionId,
            saved_at: stat.mtime.toISOString(),
            working_dir: getWorkingDir(),
            last_activity: stat.mtime.toISOString(),
            project_name: getProjectName(getWorkingDir()),
          };
        }
      }

      if (!data.session_id) {
        return [false, "Invalid session data"];
      }

      if (data.working_dir && data.working_dir !== getWorkingDir()) {
        return [
          false,
          `Session working directory mismatch.\nSession: ${data.working_dir}\nCurrent: ${getWorkingDir()}\n\nUse /project to switch directories first.`,
        ];
      }

      this.sessionId = data.session_id;
      this.lastActivity = new Date();
      console.log(
        `Resumed session ${data.session_id.slice(0, 8)}... (saved at ${
          data.saved_at
        })`
      );

      // Initialize plan state manager with resumed session ID (with file persistence)
      this.planStateManager = new PlanStateManager(this.sessionId, true);
      await this.planStateManager.load();

      // Check for active plan and inject into context
      const activePlanFile = this.planStateManager.getActivePlanFile();
      if (activePlanFile) {
        const planContent = await this.planStateManager.readPlanContent();

        if (planContent) {
          console.log(`Found active plan: ${activePlanFile}`);

          // Store plan for injection into next message
          this.pendingPlanInjection = {
            filename: activePlanFile,
            content: planContent,
          };

          return [
            true,
            `Resumed session with active plan: ${activePlanFile}`,
          ];
        }
      }

      const projectName = data.project_name || "Unknown";
      const relativeTime = data.last_activity
        ? (await import("./session-storage")).formatRelativeTime(data.last_activity)
        : "unknown";

      // Read last 3 messages from session
      const lastMessages = this.readLastMessages(jsonlPath, 3);

      return [
        true,
        `Resumed session: ${projectName} (${relativeTime})`,
        lastMessages,
      ];
    } catch (error) {
      console.error(`Failed to resume session: ${error}`);
      return [false, `Failed to load session: ${error}`];
    }
  }
}

// Global session instance
export const session = new ClaudeSession();
