/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { homedir } from "os";
import { relative } from "path";
import { session } from "../session";
import {
  getWorkingDir,
  setWorkingDir,
  PROJECTS_ROOT,
  ALLOWED_USERS,
  RESTART_FILE,
  getPermissionMode,
  setPermissionMode,
  ALLOW_TELEGRAM_PERMISSIONS_MODE,
  getModel,
  getModelName,
  setModel,
  isValidModelName,
  MODEL_IDS,
  type ModelName,
  getThinkingLevel,
  getThinkingLevelName,
  setThinkingLevel,
} from "../config";
import { isAuthorized, validateProjectPath } from "../security";
import { auditLog } from "../utils";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const status = session.isActive ? "Active session" : "No active session";
  const currentDir = getWorkingDir();
  const relativeToRoot = relative(PROJECTS_ROOT, currentDir);
  const displayPath = relativeToRoot || ".";

  const permMode = getPermissionMode();

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}\n` +
      `Current project: <code>${displayPath}</code>\n` +
      `Permission mode: ${permMode}\n\n` +
      `<b>Commands:</b>\n` +
      `/new - Start fresh session\n` +
      `/plan - Start in planning mode\n` +
      `/code - Exit plan mode\n` +
      `/stop - Stop current query\n` +
      `/status - Show detailed status\n` +
      `/project - Switch project directory\n` +
      `/resume - Resume last session\n` +
      `/retry - Retry last message\n` +
      `/permissions - View/change permission mode\n` +
      `/model - Switch Claude model\n` +
      `/thinking - Toggle extended thinking\n` +
      `/restart - Restart the bot\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt current query\n` +
      `• Send photos, voice, or documents`,
    { parse_mode: "HTML" }
  );
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Stop any running query
  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      await Bun.sleep(100);
      session.clearStopRequested();
    }
  }

  // Clear session
  await session.kill();

  await ctx.reply("🆕 Session cleared. Next message starts fresh.");
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      // Wait for the abort to be processed, then clear stopRequested so next message can proceed
      await Bun.sleep(100);
      session.clearStopRequested();
    }
    // Silent stop - no message shown
  }
  // If nothing running, also stay silent
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const lines: string[] = ["📊 <b>Bot Status</b>\n"];

  // Session status
  if (session.isActive) {
    lines.push(`✅ Session: Active (${session.sessionId?.slice(0, 8)}...)`);
  } else {
    lines.push("⚪ Session: None");
  }

  // Query status
  if (session.isRunning) {
    const elapsed = session.queryStarted
      ? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
      : 0;
    lines.push(`🔄 Query: Running (${elapsed}s)`);
    if (session.currentTool) {
      lines.push(`   └─ ${session.currentTool}`);
    }
  } else {
    lines.push("⚪ Query: Idle");
    if (session.lastTool) {
      lines.push(`   └─ Last: ${session.lastTool}`);
    }
  }

  // Last activity
  if (session.lastActivity) {
    const ago = Math.floor(
      (Date.now() - session.lastActivity.getTime()) / 1000
    );
    lines.push(`\n⏱️ Last activity: ${ago}s ago`);
  }

  // Usage stats
  if (session.lastUsage) {
    const usage = session.lastUsage;
    lines.push(
      `\n📈 Last query usage:`,
      `   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
      `   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`
    );
    if (usage.cache_read_input_tokens) {
      lines.push(
        `   Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`
      );
    }
  }

  // Error status
  if (session.lastError) {
    const ago = session.lastErrorTime
      ? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
      : "?";
    lines.push(`\n⚠️ Last error (${ago}s ago):`, `   ${session.lastError}`);
  }

  // Project directory
  const currentDir = getWorkingDir();
  const relativeToRoot = relative(PROJECTS_ROOT, currentDir);
  const displayPath = relativeToRoot || ".";
  lines.push(
    `\n📁 Current project: <code>${displayPath}</code>`,
    `   Full path: <code>${currentDir}</code>`
  );

  // Permission mode
  const permMode = getPermissionMode();
  const permIcon = permMode === "bypass" ? "🔓" : "🔐";
  lines.push(`${permIcon} Permission mode: ${permMode}`);

  // Model
  lines.push(`📱 Model: <b>${getModelName()}</b>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * Build inline keyboard for session selection.
 */
function buildSessionKeyboard(sessions: import("../types").SessionData[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const session of sessions) {
    const shortId = session.session_id.slice(0, 8);
    const icon = session.plan_mode_enabled ? "📋" : "🗂️";

    // Get first message preview (max 40 chars for button)
    const preview = session.last_message_preview || "Unknown";
    const shortPreview = preview.length > 40 ? preview.slice(0, 37) + "..." : preview;

    // Format: "🗂️ first message... | 2h ago"
    const { formatRelativeTime } = require("../session-storage");
    const timeAgo = session.last_activity
      ? formatRelativeTime(session.last_activity)
      : "unknown";

    const label = `${icon} ${shortPreview} | ${timeAgo}`;
    keyboard.text(label, `resume:${shortId}`).row();
  }

  // Add cancel button
  keyboard.text("Cancel", "resume:cancel");

  return keyboard;
}

/**
 * Format session list as text.
 */
function formatSessionList(sessions: import("../types").SessionData[]): string {
  const lines: string[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!;
    const icon = session.plan_mode_enabled ? "📋" : "🗂️";

    // Get first message preview (max 60 chars for list)
    const preview = session.last_message_preview || "Unknown";
    const shortPreview = preview.length > 60 ? preview.slice(0, 57) + "..." : preview;

    const { formatRelativeTime } = require("../session-storage");
    const timeAgo = session.last_activity
      ? formatRelativeTime(session.last_activity)
      : "unknown";

    lines.push(`${i + 1}. ${icon} ${shortPreview} - ${timeAgo}`);
  }

  return lines.join("\n");
}

/**
 * /resume - Resume a session from the list.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isActive) {
    await ctx.reply("Session already active. Use /new to start fresh first.");
    return;
  }

  // Load all sessions
  const { loadSessionList } = await import("../session-storage");
  const sessions = await loadSessionList();

  // Handle no sessions
  if (sessions.length === 0) {
    await ctx.reply("❌ No saved sessions found.");
    return;
  }

  // Display session list with buttons (always, even for single session)
  const keyboard = buildSessionKeyboard(sessions);
  const listText = formatSessionList(sessions);

  await ctx.reply(
    `📋 <b>Select a session to resume:</b>\n\n${listText}`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Check if there's a message to retry
  if (!session.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  if (session.isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  const message = session.lastMessage;
  await ctx.reply(`🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`);

  // Simulate sending the message again by emitting a fake text message event
  // We do this by directly calling the text handler logic
  const { handleText } = await import("./text");

  // Create a modified context with the last message
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      text: message,
    },
  } as Context;

  await handleText(fakeCtx);
}

/**
 * /project - Switch Claude's working directory to a different project.
 */
export async function handleProject(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Parse relative path from command args
  const args = ctx.message?.text?.split(" ") || [];
  const relativePath = args.slice(1).join(" ").trim();

  // If no args, show current project
  if (!relativePath) {
    const currentDir = getWorkingDir();
    const relativeToRoot = relative(PROJECTS_ROOT, currentDir);
    const displayPath = relativeToRoot || ".";

    await ctx.reply(
      `📁 <b>Current project:</b>\n\n` +
        `Relative: <code>${displayPath}</code>\n` +
        `Absolute: <code>${currentDir}</code>\n\n` +
        `<b>Usage:</b> <code>/project &lt;relative/path&gt;</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Check if query is running
  if (session.isRunning) {
    await ctx.reply(
      "⏳ Cannot switch projects while a query is running. Use /stop first."
    );
    return;
  }

  // Validate path
  const [valid, absolutePath, error] = validateProjectPath(
    relativePath,
    PROJECTS_ROOT
  );

  if (!valid || !absolutePath) {
    await ctx.reply(`❌ Invalid path: ${error}`);
    return;
  }

  // Kill existing session
  const oldDir = getWorkingDir();
  await session.kill();

  // Update working dir
  setWorkingDir(absolutePath);

  // Audit log
  const oldRelative = relative(PROJECTS_ROOT, oldDir);
  const newRelative = relative(PROJECTS_ROOT, absolutePath);
  auditLog(
    userId!,
    username,
    "PROJECT",
    `Switched project: ${oldRelative || "."} → ${newRelative || "."}`,
    ""
  );

  // Reply with confirmation
  const displayPath = newRelative || ".";
  await ctx.reply(
    `✅ <b>Switched to project:</b> <code>${displayPath}</code>\n\n` +
      `Session cleared. Next message starts fresh in new directory.`,
    { parse_mode: "HTML" }
  );
}

/**
 * /permissions - View or change permission mode dynamically.
 */
export async function handlePermissionsCommand(
  ctx: Context
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!userId) {
    await ctx.reply("Unable to identify user.");
    return;
  }

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    auditLog(userId, username, "AUTH", "/permissions command rejected", "");
    await ctx.reply("⛔️ Unauthorized");
    return;
  }

  // Check if mode switching is allowed
  if (!ALLOW_TELEGRAM_PERMISSIONS_MODE) {
    await ctx.reply(
      `⚠️ Permission mode changes via Telegram are disabled.\nMode is locked to: ${getPermissionMode()}`
    );
    return;
  }

  // Parse argument
  const args = ctx.message?.text?.split(" ") || [];
  const newMode = args[1]?.toLowerCase();

  if (!newMode) {
    // Show current mode
    const current = getPermissionMode();
    await ctx.reply(
      `🔐 <b>Current permission mode:</b> ${current}\n\n` +
        `Available modes:\n` +
        `• <code>bypass</code> - No prompts (fast)\n` +
        `• <code>interactive</code> - Show dialogs\n\n` +
        `Change mode: <code>/permissions [mode]</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (newMode !== "bypass" && newMode !== "interactive") {
    await ctx.reply(
      "⚠️ Invalid mode. Use: /permissions bypass OR /permissions interactive"
    );
    return;
  }

  // Set new mode
  const success = setPermissionMode(newMode);
  if (success) {
    auditLog(userId, username, "CONFIG", `Permission mode changed to: ${newMode}`, "");
    await ctx.reply(`✅ Permission mode set to: <b>${newMode}</b>`, {
      parse_mode: "HTML",
    });
  } else {
    await ctx.reply("❌ Failed to change permission mode.");
  }
}

/**
 * /model - Switch between Claude models (opus/sonnet/haiku).
 */
export async function handleModel(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const args = ctx.message?.text?.split(" ").slice(1) || [];
  const requestedModel = args[0]?.toLowerCase();

  // No arguments: show inline keyboard with model options
  if (!requestedModel) {
    const currentModel = getModelName();

    // Create inline keyboard with model buttons
    const keyboard = new InlineKeyboard()
      .text("🚀 Opus", "model:opus")
      .row()
      .text("⚡ Sonnet", "model:sonnet")
      .row()
      .text("💨 Haiku", "model:haiku");

    await ctx.reply(
      `Current model: <b>${currentModel}</b>\n\nSelect a model:`,
      {
        parse_mode: "HTML",
        reply_markup: keyboard
      }
    );
    return;
  }

  // Programmatic model switch (e.g., /model opus)
  if (!isValidModelName(requestedModel)) {
    await ctx.reply(
      `Invalid model: <b>${requestedModel}</b>\n\n` +
      `Available models: ${Object.keys(MODEL_IDS).join(", ")}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const success = setModel(requestedModel);

  if (!success) {
    await ctx.reply(
      "Model switching is disabled. Set ALLOW_TELEGRAM_MODEL_MODE=true to enable.",
      { parse_mode: "HTML" }
    );
    return;
  }

  auditLog(
    chatId,
    username,
    `model_switch`,
    requestedModel
  );

  await ctx.reply(
    `Model switched to <b>${requestedModel}</b> (${MODEL_IDS[requestedModel]})`,
    { parse_mode: "HTML" }
  );
}

/**
 * /thinking - Toggle or view extended thinking mode.
 */
export async function handleThinking(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const args = ctx.message?.text?.split(" ").slice(1) || [];
  const requestedLevel = args[0]?.toLowerCase();

  // No arguments: show inline keyboard with options
  if (!requestedLevel) {
    const currentLevel = getThinkingLevel();
    const currentName = getThinkingLevelName();

    // Create inline keyboard with thinking options
    const keyboard = new InlineKeyboard()
      .text("🚫 Off (0 tokens)", "thinking:0")
      .row()
      .text("💭 Normal (10k tokens)", "thinking:10000")
      .row()
      .text("🧠 Deep (50k tokens)", "thinking:50000");

    await ctx.reply(
      `Current thinking level: <b>${currentName}</b> (${currentLevel} tokens)\n\nSelect thinking level:`,
      {
        parse_mode: "HTML",
        reply_markup: keyboard
      }
    );
    return;
  }

  // Parse level from argument
  let level: number;
  if (requestedLevel === "off") {
    level = 0;
  } else if (requestedLevel === "normal") {
    level = 10000;
  } else if (requestedLevel === "deep") {
    level = 50000;
  } else {
    await ctx.reply(
      `Invalid level: <b>${requestedLevel}</b>\n\n` +
      `Available levels: off, normal, deep`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const success = setThinkingLevel(level);

  if (!success) {
    await ctx.reply(
      "Failed to set thinking level.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const levelName = getThinkingLevelName();
  auditLog(
    chatId,
    username,
    `thinking_level`,
    levelName
  );

  await ctx.reply(
    `Thinking level set to <b>${levelName}</b> (${level} tokens)`,
    { parse_mode: "HTML" }
  );
}

/**
 * /plan - Start a new session in plan mode (read-only exploration).
 */
export async function handlePlan(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Parse message from command args
  const args = ctx.message?.text?.split(" ") || [];
  const message = args.slice(1).join(" ").trim();

  // If no message provided, show usage
  if (!message) {
    await ctx.reply(
      `📋 <b>Plan Mode</b>\n\n` +
        `Start a new session in read-only planning mode.\n\n` +
        `<b>Usage:</b> <code>/plan &lt;your task description&gt;</code>\n\n` +
        `Example: <code>/plan add user authentication with JWT</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Only create new session if none exists
  if (!session.isActive) {
    // Check if query is running
    if (session.isRunning) {
      const result = await session.stop();
      if (result) {
        await Bun.sleep(100);
        session.clearStopRequested();
      }
    }

    // Clear session (this resets session.planStateManager)
    await session.kill();

    // Set plan mode state using session's manager (will persist to file)
    await session.planStateManager.transition({ type: "ENTER_PLAN_MODE" });

    await ctx.reply(
      "📋 <b>Starting plan mode...</b>\n\n" +
        "READ-ONLY exploration mode activated. Claude will explore the codebase and create an implementation plan.",
      {
        parse_mode: "HTML",
      }
    );
  } else {
    // Session exists, just send message to it
    await ctx.reply(
      "📋 <b>Sending to existing session...</b>",
      {
        parse_mode: "HTML",
      }
    );
  }

  // Import streaming utilities
  const { StreamingState, createStatusCallback } = await import("./streaming");
  const { startTypingIndicator } = await import("../utils");

  // Store message for retry
  session.lastMessage = message;

  // Start processing
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  let streamingState = new StreamingState();
  let statusCallback = createStatusCallback(ctx, streamingState);

  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await session.sendMessageStreaming(
        message,
        username,
        userId!,
        statusCallback,
        chatId,
        ctx
      );

      auditLog(userId!, username, "PLAN", message, response);
      break;
    } catch (error) {
      const errorStr = String(error);
      const isClaudeCodeCrash = errorStr.includes("exited with code");

      // Clean up any partial messages
      for (const toolMsg of streamingState.toolMessages) {
        try {
          await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
        } catch {}
      }

      // Retry on crash
      if (isClaudeCodeCrash && attempt < MAX_RETRIES) {
        console.log(
          `Claude Code crashed, retrying (attempt ${attempt + 2}/${
            MAX_RETRIES + 1
          })...`
        );
        await session.kill();
        await ctx.reply(`⚠️ Claude crashed, retrying...`);
        streamingState = new StreamingState();
        statusCallback = createStatusCallback(ctx, streamingState);
        continue;
      }

      console.error("Error processing plan message:", error);

      if (errorStr.includes("abort") || errorStr.includes("cancel")) {
        const wasInterrupt = session.consumeInterruptFlag();
        if (!wasInterrupt) {
          await ctx.reply("🛑 Query stopped.");
        }
      } else {
        await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
      }
      break;
    }
  }

  stopProcessing();
  typing.stop();
}

/**
 * /code - Exit plan mode or continue to execution.
 */
export async function handleCode(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!session.isActive || !session.sessionId) {
    await ctx.reply("❌ No active session.");
    return;
  }

  // Check if plan mode is active using session's planStateManager
  await session.planStateManager.load();
  if (!session.planStateManager.isEnabled()) {
    await ctx.reply("ℹ️ Plan mode is not active.");
    return;
  }

  // Disable plan mode using state transition
  await session.planStateManager.transition({ type: "EXIT_PLAN_MODE" });

  await ctx.reply(
    "💻 <b>Plan mode exited</b>\n\n" +
      "Claude can now execute code and make system modifications.",
    {
      parse_mode: "HTML",
    }
  );
}
