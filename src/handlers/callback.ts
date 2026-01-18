/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration).
 */

import type { Context } from "grammy";
import { session } from "../session";
import {
  ALLOWED_USERS,
  setModel,
  isValidModelName,
  MODEL_IDS,
  setThinkingLevel,
  getThinkingLevelName,
} from "../config";
import { isAuthorized } from "../security";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { askUserStore } from "../ask-user-store";
import { permissionStore } from "../permission-store";
import {
  resolvePermission,
  generatePermissionPattern,
  saveProjectPermission,
  getAlwaysAllowDescription,
} from "../permissions";
import { getWorkingDir } from "../config";

/**
 * Handle callback queries from inline keyboards.
 */
export async function handleCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  // 2. Parse callback data: askuser:{request_id}:{option_index}
  if (!callbackData.startsWith("askuser:")) {
    // Check for permission callback
    if (callbackData.startsWith("perm:")) {
      await handlePermissionCallback(ctx, callbackData, chatId);
      return;
    }

    // Check for plan approval callback
    if (callbackData.startsWith("planapproval:")) {
      const { handlePlanApprovalCallback } = await import("./plan-approval");
      await handlePlanApprovalCallback(ctx, callbackData, chatId);
      return;
    }

    // Check for model callback
    if (callbackData.startsWith("model:")) {
      await handleModelCallback(ctx, callbackData, chatId);
      return;
    }

    // Check for thinking callback
    if (callbackData.startsWith("thinking:")) {
      await handleThinkingCallback(ctx, callbackData, chatId);
      return;
    }

    // Check for resume callback
    if (callbackData.startsWith("resume:")) {
      await handleResumeCallback(ctx, callbackData, chatId);
      return;
    }

    // Check for screenshot callback
    if (callbackData.startsWith("screenshot:")) {
      await handleScreenshotCallback(ctx, callbackData, chatId);
      return;
    }

    // Check for screencap callback
    if (callbackData.startsWith("screencap:")) {
      await handleScreencapCallback(ctx, callbackData, chatId, username);
      return;
    }

    await ctx.answerCallbackQuery();
    return;
  }

  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndex = parseInt(parts[2]!, 10);

  // 3. Load request from store
  const requestData = askUserStore.get(requestId);

  if (!requestData) {
    console.error(`Failed to load ask-user request ${requestId}: not found in store`);
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // 4. Get selected option
  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  // 5. If "Other" is selected, prompt for custom text input
  if (selectedOption === "Other") {
    console.log(`[CALLBACK] "Other" selected for request ${requestId}, chatId=${chatId}`);
    const { setPendingCustomInput } = await import("./ask-user-other");
    setPendingCustomInput(requestId, chatId);

    await ctx.editMessageText(`💬 <b>Custom Input</b>\n\nPlease send your custom response as a text message:`, {
      parse_mode: "HTML",
    });

    await ctx.answerCallbackQuery({
      text: "Send your custom response as a text message",
    });

    console.log(`[CALLBACK] Waiting for custom text input for ${requestId}`);
    return; // Don't resolve yet - wait for text input
  }

  // 6. Update the message to show selection
  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch (error) {
    console.debug("Failed to edit callback message:", error);
  }

  // 7. Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // 8. Resolve the promise (if promise-based) - this unblocks the MCP handler
  console.log(`[ASK-USER DEBUG] Resolving promise for request ${requestId} with option: "${selectedOption}"`);
  askUserStore.answer(requestId, selectedOption);

  // Promise-based flow: The MCP tool is still waiting for the answer, so we don't send a new message.
  // The tool will receive the answer and return it to Claude directly.
  // Just acknowledge the selection and return early.
  if (requestData.resolve) {
    console.log(`[ASK-USER DEBUG] Promise-based flow - returning early`);
    return;
  }

  // LEGACY non-promise flow: Send the choice to Claude as a message
  const message = selectedOption;

  // Interrupt any running query - button responses are always immediate
  if (session.isRunning) {
    console.log("Interrupting current query for button response");
    await session.stop();
    // Small delay to ensure clean interruption
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx,
      state
    );

    await auditLog(userId, username, "CALLBACK", message, response);
  } catch (error) {
    console.error("Error processing callback:", error);

    for (const toolMsg of state.toolMessages.values()) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        console.debug("Failed to delete tool message:", error);
      }
    }

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    typing.stop();
  }
}

/**
 * Handle permission callback (Allow/Deny/Comment).
 */
async function handlePermissionCallback(
  ctx: Context,
  callbackData: string,
  chatId: number
): Promise<void> {
  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const action = parts[2]!; // "allow", "deny", or "comment"

  const requestData = permissionStore.get(requestId);

  if (!requestData) {
    await ctx.answerCallbackQuery({ text: "Request expired" });
    return;
  }

  if (action === "allow") {
    // Update message to show approval
    await ctx.editMessageText(
      `✅ <b>Approved</b>\n\n${requestData.formatted_request}`,
      {
        parse_mode: "HTML",
      }
    );

    // Resolve the Promise - this unblocks canUseTool callback
    resolvePermission(requestId, true);

    await ctx.answerCallbackQuery({ text: "✅ Approved" });
  } else if (action === "always") {
    // Generate and save permission pattern for this project
    const workingDir = getWorkingDir();
    try {
      const toolInput = JSON.parse(requestData.tool_input);
      const pattern = generatePermissionPattern(
        requestData.tool_name,
        toolInput,
        workingDir
      );
      const description = getAlwaysAllowDescription(
        requestData.tool_name,
        toolInput,
        workingDir
      );

      // Save to .claude/settings.local.json
      saveProjectPermission(workingDir, pattern);

      // Extract the command/path preview for the toast
      // e.g., "Always allow `cargo build`?" -> "cargo build"
      const previewMatch = description.match(/`([^`]+)`/);
      const preview = previewMatch ? previewMatch[1] : pattern;

      // Update message to show always-allowed with human-readable description
      await ctx.editMessageText(
        `✅ <b>Always Allowed</b>\n\n${description}\n\n<i>Saved: <code>${pattern}</code></i>`,
        {
          parse_mode: "HTML",
        }
      );

      // Resolve the Promise - this unblocks canUseTool callback
      resolvePermission(requestId, true);

      await ctx.answerCallbackQuery({ text: `✅ Always: ${preview}` });
    } catch (error) {
      console.error("Failed to save permission pattern:", error);
      // Fall back to single allow
      await ctx.editMessageText(
        `✅ <b>Approved</b> (failed to save pattern)\n\n${requestData.formatted_request}`,
        {
          parse_mode: "HTML",
        }
      );
      resolvePermission(requestId, true);
      await ctx.answerCallbackQuery({ text: "✅ Approved (pattern save failed)" });
    }
  } else if (action === "deny") {
    // Update message to show denial
    await ctx.editMessageText(
      `❌ <b>Denied</b>\n\n${requestData.formatted_request}`,
      {
        parse_mode: "HTML",
      }
    );

    // Resolve the Promise - this unblocks canUseTool callback
    resolvePermission(requestId, false, "Denied by user");

    await ctx.answerCallbackQuery({ text: "❌ Denied" });
  } else if (action === "comment") {
    // Update message to show awaiting comment
    await ctx.editMessageText(
      `💬 <b>Please provide a reason for denial:</b>\n\n${requestData.formatted_request}`,
      {
        parse_mode: "HTML",
      }
    );

    // Update store to await comment
    permissionStore.update(requestId, "awaiting_comment");

    await ctx.reply("Type your reason:", {
      reply_markup: { force_reply: true, selective: true },
    });

    await ctx.answerCallbackQuery({ text: "💬 Waiting for comment" });
  }
}

/**
 * Handle model selection callback.
 */
async function handleModelCallback(
  ctx: Context,
  callbackData: string,
  chatId: number
): Promise<void> {
  const parts = callbackData.split(":");
  if (parts.length !== 2) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestedModel = parts[1]!;

  // Validate model name
  if (!isValidModelName(requestedModel)) {
    await ctx.answerCallbackQuery({ text: "Invalid model" });
    return;
  }

  // Set the model
  const success = setModel(requestedModel);

  if (!success) {
    await ctx.editMessageText(
      `Model switching is disabled. Set ALLOW_TELEGRAM_MODEL_MODE=true to enable.`,
      { parse_mode: "HTML" }
    );
    await ctx.answerCallbackQuery({ text: "Model switching disabled" });
    return;
  }

  // Update message to show selection
  const modelId = MODEL_IDS[requestedModel];
  await ctx.editMessageText(
    `✓ Model switched to <b>${requestedModel}</b> (${modelId})`,
    { parse_mode: "HTML" }
  );

  // Log the change
  const username = ctx.from?.username || "unknown";
  auditLog(chatId, username, "model_switch", requestedModel);

  await ctx.answerCallbackQuery({
    text: `Switched to ${requestedModel}`,
  });
}

/**
 * Handle thinking level selection callback.
 */
async function handleThinkingCallback(
  ctx: Context,
  callbackData: string,
  chatId: number
): Promise<void> {
  const parts = callbackData.split(":");
  if (parts.length !== 2) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestedLevel = parseInt(parts[1]!, 10);

  // Validate thinking level
  if (![0, 10000, 50000].includes(requestedLevel)) {
    await ctx.answerCallbackQuery({ text: "Invalid thinking level" });
    return;
  }

  // Set the thinking level
  const success = setThinkingLevel(requestedLevel);

  if (!success) {
    await ctx.editMessageText(
      `Failed to set thinking level.`,
      { parse_mode: "HTML" }
    );
    await ctx.answerCallbackQuery({ text: "Failed to set thinking level" });
    return;
  }

  // Update message to show selection
  const levelName = getThinkingLevelName();
  await ctx.editMessageText(
    `✅ Thinking level set to <b>${levelName}</b> (${requestedLevel} tokens)`,
    { parse_mode: "HTML" }
  );

  // Log the change
  const username = ctx.from?.username || "unknown";
  auditLog(chatId, username, "thinking_level", levelName);

  await ctx.answerCallbackQuery({
    text: `Set to ${levelName}`,
  });
}

/**
 * Handle resume session callback.
 */
async function handleResumeCallback(
  ctx: Context,
  callbackData: string,
  chatId: number
): Promise<void> {
  const parts = callbackData.split(":");
  if (parts.length !== 2) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const sessionIdShort = parts[1]!;

  // Handle cancel
  if (sessionIdShort === "cancel") {
    await ctx.deleteMessage();
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    return;
  }

  // Load session by short ID
  const { loadSessionByShortId } = await import("../session-storage");
  const [success, message, sessionData] = await loadSessionByShortId(sessionIdShort);

  if (!success || !sessionData) {
    await ctx.editMessageText(`❌ ${message}`);
    await ctx.answerCallbackQuery({ text: "Failed to load session" });
    return;
  }

  // Resume session
  const [resumeSuccess, resumeMessage, lastMessages] = await session.resumeById(sessionData.session_id);

  if (resumeSuccess) {
    const projectName = sessionData.project_name || "Unknown";
    const { formatRelativeTime } = await import("../session-storage");
    const timeAgo = sessionData.last_activity
      ? formatRelativeTime(sessionData.last_activity)
      : "unknown";

    await ctx.editMessageText(
      `✅ <b>Resumed Session</b>\n\n` +
      `Project: <code>${projectName}</code>\n` +
      `Session: <code>${sessionData.session_id.slice(0, 8)}...</code>\n` +
      `Last activity: ${timeAgo}`,
      { parse_mode: "HTML" }
    );
    await ctx.answerCallbackQuery({ text: `✅ Resumed: ${projectName}` });

    // Send last 3 messages for context
    if (lastMessages && lastMessages.length > 0) {
      let contextText = "📜 <b>Last messages:</b>\n\n";

      for (const msg of lastMessages) {
        const label = msg.role === "user" ? "👤 You" : "🤖 Claude";
        const preview = msg.content.length > 300 ? msg.content.slice(0, 297) + "..." : msg.content;
        contextText += `${label}:\n${preview}\n\n`;
      }

      await ctx.reply(contextText, { parse_mode: "HTML" });
    }
  } else {
    await ctx.editMessageText(`❌ ${resumeMessage}`, { parse_mode: "HTML" });
    await ctx.answerCallbackQuery({ text: "Failed to resume" });
  }
}

/**
 * Handle screenshot window selection callback.
 */
async function handleScreenshotCallback(
  ctx: Context,
  callbackData: string,
  chatId: number
): Promise<void> {
  // Parse: screenshot:{requestId}:{index|cancel}
  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const indexOrCancel = parts[2]!;

  // Handle cancel
  if (indexOrCancel === "cancel") {
    try {
      await ctx.deleteMessage();
    } catch {}
    await ctx.answerCallbackQuery({ text: "Cancelled" });

    // Clean up store
    const { removeRequest } = await import("../screenshot-store");
    removeRequest(requestId);
    return;
  }

  // Handle whole screen capture
  if (indexOrCancel === "screen") {
    await ctx.answerCallbackQuery({ text: "Capturing screen..." });

    try {
      const { Monitor } = await import("node-screenshots");
      const { removeRequest } = await import("../screenshot-store");

      // Get primary monitor
      const monitors = Monitor.all();
      const primaryMonitor = monitors.find((m) => m.isPrimary) || monitors[0];

      if (!primaryMonitor) {
        await ctx.reply("No monitor found.");
        return;
      }

      // Capture the screen
      const image = await primaryMonitor.captureImage();
      const buffer = image.toPngSync();

      // Send as photo
      const { InputFile } = await import("grammy");
      await ctx.replyWithPhoto(new InputFile(buffer, "screenshot.png"), {
        caption: `Screenshot: ${primaryMonitor.name || "Whole Screen"}`,
      });

      // Delete the selection message
      try {
        await ctx.deleteMessage();
      } catch {}

      // Clean up store
      removeRequest(requestId);
    } catch (error) {
      console.error("Screen capture error:", error);
      await ctx.reply(
        "Failed to capture screen. Check Screen Recording permissions in System Settings > Privacy & Security."
      );
    }
    return;
  }

  const index = parseInt(indexOrCancel, 10);
  if (isNaN(index)) {
    await ctx.answerCallbackQuery({ text: "Invalid index" });
    return;
  }

  // Get windows from store
  const { getWindows, removeRequest } = await import("../screenshot-store");
  const windows = getWindows(requestId);

  if (!windows) {
    await ctx.answerCallbackQuery({ text: "Request expired" });
    try {
      await ctx.deleteMessage();
    } catch {}
    return;
  }

  if (index < 0 || index >= windows.length) {
    await ctx.answerCallbackQuery({ text: "Invalid window index" });
    return;
  }

  const targetWindow = windows[index]!;

  // Show capturing status
  await ctx.answerCallbackQuery({ text: `Capturing ${targetWindow.title.slice(0, 30)}...` });

  try {
    // Capture the window (async)
    const image = await targetWindow.captureImage();

    if (!image) {
      await ctx.reply("Failed to capture window. It may have been closed.");
      return;
    }

    // Convert to PNG buffer (sync for simplicity)
    const buffer = image.toPngSync();

    // Send as photo
    const { InputFile } = await import("grammy");
    await ctx.replyWithPhoto(new InputFile(buffer, "screenshot.png"), {
      caption: `Screenshot: ${targetWindow.title}`,
    });

    // Delete the selection message
    try {
      await ctx.deleteMessage();
    } catch {}

    // Clean up store
    removeRequest(requestId);
  } catch (error) {
    console.error("Screenshot capture error:", error);
    await ctx.reply(
      "Failed to capture screenshot. Check Screen Recording permissions in System Settings > Privacy & Security."
    );
  }
}

/**
 * Handle screencap callback (window/screen selection).
 */
async function handleScreencapCallback(
  ctx: Context,
  callbackData: string,
  chatId: number,
  username: string | undefined
): Promise<void> {
  const parts = callbackData.split(":");
  const requestId = parts[1]!;
  const selection = parts[2]!;

  const { getRequest, removeRequest } = await import("../screencap-store");
  const request = getRequest(requestId);

  if (!request) {
    await ctx.answerCallbackQuery({ text: "Request expired" });
    await ctx.editMessageText("Selection expired. Use /screencap again.");
    return;
  }

  // Handle cancel
  if (selection === "cancel") {
    removeRequest(requestId);
    await ctx.deleteMessage();
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    return;
  }

  const duration = request.duration;

  // Start recording
  if (selection === "screen") {
    await startScreenRecording(chatId, requestId, duration);
    await ctx.editMessageText(`🎥 Recording full screen for ${Math.round(duration)}s...`);
  } else {
    const index = parseInt(selection);
    const window = request.windows[index];
    if (!window) {
      await ctx.answerCallbackQuery({ text: "Invalid window" });
      return;
    }

    await startWindowRecording(chatId, requestId, duration, window);
    await ctx.editMessageText(
      `🎥 Recording: ${window.appName} - ${window.title}\nDuration: ${Math.round(duration)}s`
    );
  }

  removeRequest(requestId);
  await ctx.answerCallbackQuery({ text: "Recording started" });
  auditLog(chatId, username || "unknown", "screencap_start", selection);
}

/**
 * Start full screen recording.
 */
async function startScreenRecording(
  chatId: number,
  requestId: string,
  duration: number
): Promise<void> {
  const timestamp = Date.now();
  const filePath = `/tmp/telegram-bot/screencap_${timestamp}.mp4`;

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-f",
      "avfoundation",
      "-capture_cursor",
      "1",
      "-r",
      "30",
      "-i",
      "Capture screen 0",
      "-t",
      duration.toString(),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      filePath,
    ],
    {
      stderr: "pipe",
    }
  );

  const { storeRecording } = await import("../screencap-store");
  storeRecording({
    chatId,
    requestId,
    filePath,
    duration,
    targetType: "screen",
    startTime: timestamp,
    process: proc,
  });

  // Handle completion
  handleRecordingCompletion(chatId, proc);
}

/**
 * Bring window to front using AppleScript.
 */
async function activateWindow(appName: string): Promise<void> {
  try {
    await Bun.spawn(["osascript", "-e", `tell application "${appName}" to activate`], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    // Wait a bit for the window to come to front
    await Bun.sleep(500);
  } catch (error) {
    console.warn(`Failed to activate window for ${appName}:`, error);
    // Continue anyway - recording will still work even if activation fails
  }
}

/**
 * Get display scale factor (2 for Retina, 1 for non-Retina).
 * node-screenshots returns logical points, but ffmpeg needs physical pixels.
 */
async function getDisplayScaleFactor(): Promise<number> {
  try {
    // Query main display resolution vs backing resolution
    const result = await Bun.spawn([
      "system_profiler",
      "SPDisplaysDataType",
      "-json",
    ], {
      stdout: "pipe",
    });

    const output = await new Response(result.stdout).text();
    const data = JSON.parse(output);

    // Check if Retina (UI Looks like vs Resolution will differ on Retina)
    const displays = data?.SPDisplaysDataType?.[0]?.spdisplays_ndrvs || [];
    for (const display of displays) {
      if (display._spdisplays_main === "spdisplays_yes") {
        // If it has a Retina flag or the resolution suggests 2x scaling
        if (display._spdisplays_retina === "spdisplays_yes") {
          return 2;
        }
      }
    }

    // Default to 2 for modern Macs (most have Retina)
    return 2;
  } catch (error) {
    console.warn("Failed to detect display scale factor, assuming Retina (2x):", error);
    // Default to 2x for Retina displays (safe assumption for modern Macs)
    return 2;
  }
}

/**
 * Start window recording.
 */
async function startWindowRecording(
  chatId: number,
  requestId: string,
  duration: number,
  window: any
): Promise<void> {
  // Bring window to front before recording
  await activateWindow(window.appName);

  const timestamp = Date.now();
  const filePath = `/tmp/telegram-bot/screencap_${timestamp}.mp4`;

  // Get display scale factor for Retina displays
  const scaleFactor = await getDisplayScaleFactor();

  // Convert logical points to physical pixels
  const physicalX = Math.round(window.x * scaleFactor);
  const physicalY = Math.round(window.y * scaleFactor);
  const physicalWidth = Math.round(window.width * scaleFactor);
  const physicalHeight = Math.round(window.height * scaleFactor);

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-f",
      "avfoundation",
      "-capture_cursor",
      "1",
      "-r",
      "30",
      "-i",
      "Capture screen 0",
      "-t",
      duration.toString(),
      "-filter:v",
      `crop=${physicalWidth}:${physicalHeight}:${physicalX}:${physicalY}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      filePath,
    ],
    {
      stderr: "pipe",
    }
  );

  const { storeRecording } = await import("../screencap-store");
  storeRecording({
    chatId,
    requestId,
    filePath,
    duration,
    targetType: "window",
    windowInfo: {
      x: physicalX,
      y: physicalY,
      width: physicalWidth,
      height: physicalHeight,
    },
    startTime: timestamp,
    process: proc,
  });

  handleRecordingCompletion(chatId, proc);
}

/**
 * Handle recording completion (async).
 */
async function handleRecordingCompletion(chatId: number, proc: any): Promise<void> {
  const exitCode = await proc.exited;

  const { getRecording, removeRecording } = await import("../screencap-store");
  const recording = getRecording(chatId);

  if (!recording) return;

  try {
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();

      let errorMsg = "❌ Recording failed.";
      if (
        stderr.includes("Operation not permitted") ||
        stderr.includes("Input/output error")
      ) {
        errorMsg =
          "❌ Screen recording permission denied.\n\n" +
          "Grant permission in:\n" +
          "System Settings > Privacy & Security > Screen Recording";
      }

      const { bot } = await import("../index");
      await bot.api.sendMessage(chatId, errorMsg);

      await cleanupRecording(recording);
      removeRecording(chatId);
      return;
    }

    // Check file size
    const fileSize = await Bun.file(recording.filePath).size;
    const sizeMB = fileSize / (1024 * 1024);

    if (sizeMB > 50) {
      const { bot } = await import("../index");
      await bot.api.sendMessage(
        chatId,
        `❌ Video exceeds 50MB limit (${sizeMB.toFixed(1)}MB). Try shorter duration.`
      );
      await cleanupRecording(recording);
      removeRecording(chatId);
      return;
    }

    // Send video
    const { bot } = await import("../index");
    const { InputFile } = await import("grammy");

    const fileBuffer = await Bun.file(recording.filePath).arrayBuffer();
    const buffer = Buffer.from(fileBuffer);

    await bot.api.sendVideo(chatId, new InputFile(buffer, "recording.mp4"), {
      caption: `🎥 Screen recording (${Math.round(recording.duration)}s)`,
    });

    // Cleanup
    await cleanupRecording(recording);
    removeRecording(chatId);
  } catch (error) {
    console.error("Recording completion error:", error);
    await cleanupRecording(recording);
    removeRecording(chatId);
  }
}

/**
 * Cleanup recording temp file.
 */
async function cleanupRecording(recording: any): Promise<void> {
  try {
    await Bun.$`rm -f ${recording.filePath}`.quiet();
  } catch (e) {
    console.warn(`Failed to cleanup ${recording.filePath}:`, e);
  }
}
