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
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import type { Context } from "grammy";
import {
  getAllowedPaths,
  MCP_SERVERS,
  getSafetyPrompt,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
  getWorkingDir,
  getPermissionMode,
  getModel,
  PLAN_MODE,
  getPlanStateFile,
  isExitPlanModeTool,
  isWriteTool,
  PlanStateManager,
} from "./config";
import type { PlanApprovalAction } from "./plan-mode";
import { formatToolStatus } from "./formatting";
import {
  checkPendingAskUserRequests,
  checkPendingPermissionRequests,
  formatPermissionRequest,
} from "./handlers/streaming";
import {
  createPermissionRequest,
  pollPermissionRequest,
  cleanupPermissionRequest,
} from "./permissions";
import { checkCommandSafety, isPathAllowed } from "./security";
import type { SessionData, StatusCallback, TokenUsage } from "./types";

/**
 * Determine thinking token budget based on message keywords.
 */
function getThinkingLevel(message: string): number {
  const msgLower = message.toLowerCase();

  // Check deep thinking triggers first (more specific)
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 50000;
  }

  // Check normal thinking triggers
  if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 10000;
  }

  // Default: no thinking
  return 0;
}

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

  // Plan mode state manager (in-memory only, no file persistence)
  planStateManager: PlanStateManager = new PlanStateManager(null, false);

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
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string> {
    // Set chat context for ask_user and plan_mode MCP tools
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }
    if (this.sessionId) {
      process.env.TELEGRAM_SESSION_ID = this.sessionId;
    }

    const isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      { 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] ||
      String(thinkingTokens);

    // Check for pending plan injection
    let messageToSend = message;
    if (this.pendingPlanInjection) {
      const { filename, content } = this.pendingPlanInjection;
      messageToSend = `[CONTEXT: Resumed session with active plan]\n\nPlan file: ${filename}\n\n${content}\n\n---\n\n${message}`;
      this.pendingPlanInjection = null;
    }

    // Initialize plan state manager with current session ID (in-memory only)
    this.planStateManager = new PlanStateManager(this.sessionId, false);

    // Build system prompt with plan mode if active
    const planModePrompt = await getPlanModePrompt(this.planStateManager);
    const safetyPrompt = getSafetyPrompt();
    const systemPrompt = planModePrompt
      ? `${safetyPrompt}\n\n${planModePrompt}`
      : safetyPrompt;

    // In plan mode, always bypass permissions (plan approval is the permission gate)
    const inPlanMode = this.planStateManager.isEnabled();
    const shouldBypassPermissions = inPlanMode || getPermissionMode() !== "interactive";

    // Build SDK V1 options - supports all features
    const options: Options = {
      model: getModel(),
      cwd: getWorkingDir(),
      settingSources: ["user", "project"],
      permissionMode: shouldBypassPermissions ? "bypassPermissions" : "default",
      allowDangerouslySkipPermissions: shouldBypassPermissions,
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
        // If bypass mode or in plan mode, allow everything
        if (shouldBypassPermissions) {
          return { behavior: "allow", updatedInput: toolInput };
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
            return { behavior: "deny", message: `Blocked: ${reason}` };
          }
        }

        // Format the permission request for display
        const formattedRequest = formatPermissionRequest(
          toolName,
          toolInputStr
        );

        // Create permission request file
        const requestId = createPermissionRequest(
          chatId!,
          toolName,
          toolInputStr,
          formattedRequest
        );

        // Poll for user response (55 second timeout)
        const result = await pollPermissionRequest(requestId, 55000);

        // Clean up request file
        cleanupPermissionRequest(requestId);

        return result;
      },

      // NOTE: Context compaction hooks are commented out due to type compatibility issues
      // with the Agent SDK. Plan context is preserved via session file and re-injected
      // on resume instead. This provides equivalent functionality without the hooks API.
      //
      // TODO: Revisit hooks when SDK provides clearer type definitions or examples
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
    let askUserTriggered = false;
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

              // Check for ExitPlanMode - set flag to prevent subsequent modifications
              if (isExitPlanModeTool(toolName)) {
                planApprovalRequested = true;
                await this.planStateManager.transition({ type: "REQUEST_APPROVAL", requestId: "" });
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
                await statusCallback("tool", toolDisplay);
              }

              // Check for pending ask_user requests after ask-user MCP tool
              if (toolName.startsWith("mcp__ask-user") && ctx && chatId) {
                // Small delay to let MCP server write the file
                await new Promise((resolve) => setTimeout(resolve, 200));

                // Retry a few times in case of timing issues
                for (let attempt = 0; attempt < 3; attempt++) {
                  const buttonsSent = await checkPendingAskUserRequests(
                    ctx,
                    chatId
                  );
                  if (buttonsSent) {
                    askUserTriggered = true;
                    break;
                  }
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }

              // Check for plan approval after ExitPlanMode tool
              if (isExitPlanModeTool(toolName) && ctx && chatId && this.sessionId) {
                console.log("[PLAN] ExitPlanMode tool completed, checking for plan approval");

                // Retry a few times in case of timing issues (like ask_user does)
                for (let attempt = 0; attempt < 5; attempt++) {
                  if (attempt > 0) {
                    console.log(`[PLAN] Retry attempt ${attempt}`);
                  }

                  // Delay to let MCP server write state
                  await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 200 : 300));

                  try {
                    // Reload state from file to get MCP server updates
                    await this.planStateManager.load();
                    const state = this.planStateManager.getState();
                    console.log(`[PLAN] plan_approval_pending=${state.plan_approval_pending}, active_plan_file=${state.active_plan_file}`);

                    if (state.plan_approval_pending && state.active_plan_file) {
                      // Read plan content using manager
                      const planContent = await this.planStateManager.readPlanContent();

                      if (planContent) {
                        const requestId = crypto.randomUUID().slice(0, 8);
                        console.log(`[PLAN] Displaying approval for ${state.active_plan_file}`);

                        // Store in manager
                        this.planStateManager.setPendingApproval(state.active_plan_file, planContent, requestId);

                        // Display approval dialog
                        const { displayPlanApproval } = await import("./handlers/plan-approval");
                        await displayPlanApproval(ctx, state.active_plan_file, planContent, requestId);

                        // Break out of event loop to wait for user
                        askUserTriggered = true;
                        console.log("[PLAN] Approval dialog displayed, breaking event loop");
                        break; // Success, stop retrying
                      } else {
                        const planPath = this.planStateManager.getPlanFilePath();
                        console.warn(`[PLAN] Plan file not found: ${planPath}`);
                      }
                    } else {
                      console.log(`[PLAN] Approval not pending yet (attempt ${attempt})`);
                    }
                  } catch (error) {
                    console.error(`[PLAN] Error checking plan approval:`, error);
                  }
                }

                if (!askUserTriggered) {
                  console.error("[PLAN] Failed to display approval dialog after all retries");
                }
              }

              // Check for pending permission requests (interactive mode)
              if (ctx && chatId && getPermissionMode() === "interactive") {
                await checkPendingPermissionRequests(ctx, chatId);
              }
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

          // Break out of event loop if ask_user or plan approval was triggered
          if (askUserTriggered) {
            console.log("[PLAN] Breaking out of event loop - askUserTriggered=true");
            break;
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
        (queryCompleted || askUserTriggered || this.stopRequested)
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

    // If ask_user or plan approval was triggered, return early - user will respond via button
    if (askUserTriggered) {
      console.log("[PLAN] Query ended early - waiting for user selection");
      await statusCallback("done", "");
      return "[Waiting for user selection]";
    }

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
    this.sessionId = null;
    this.lastActivity = null;
    // Reset plan state manager (in-memory only)
    this.planStateManager = new PlanStateManager(null, false);
    console.log("Session cleared");
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
    if (action === "accept") {
      const msg = `✅ <b>Plan Accepted</b>\n\nFile: <code>${approval.planFile}</code>`;
      return [true, msg, true];
    } else if (action === "reject") {
      const msg = `❌ <b>Plan Rejected</b>\n\nFile: <code>${approval.planFile}</code>`;
      return [true, msg, false];
    } else if (action === "clear") {
      const msg = `🗑️ <b>Context Cleared</b>\n\nFile: <code>${approval.planFile}</code>`;
      return [true, msg, false];
    }

    return [false, "Invalid action", false];
  }

  /**
   * Handle plan approval response asynchronously (with state transition).
   */
  async handlePlanApprovalAsync(
    requestId: string,
    action: PlanApprovalAction
  ): Promise<[boolean, string, boolean]> {
    return await this.planStateManager.handleApprovalResponse(requestId, action);
  }

  /**
   * Get pending plan approval info (for displaying to user).
   */
  getPendingPlanApproval(): {
    planFile: string;
    planContent: string;
    requestId: string;
  } | null {
    const approval = this.planStateManager.getPendingApproval();
    if (!approval) return null;
    return {
      planFile: approval.planFile,
      planContent: approval.planContent,
      requestId: approval.requestId,
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

      // Initialize plan state manager with resumed session ID
      this.planStateManager = new PlanStateManager(this.sessionId);
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
