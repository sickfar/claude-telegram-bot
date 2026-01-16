/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 */

import type { Context } from "grammy";
import { session } from "../session";
import {
  WORKING_DIR,
  ALLOWED_USERS,
  RESTART_FILE,
  getPermissionMode,
  setPermissionMode,
  ALLOW_TELEGRAM_PERMISSIONS_MODE,
} from "../config";
import { isAuthorized } from "../security";
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
  const workDir = WORKING_DIR;

  const permMode = getPermissionMode();

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}\n` +
      `Working directory: <code>${workDir}</code>\n` +
      `Permission mode: ${permMode}\n\n` +
      `<b>Commands:</b>\n` +
      `/new - Start fresh session\n` +
      `/stop - Stop current query\n` +
      `/status - Show detailed status\n` +
      `/resume - Resume last session\n` +
      `/retry - Retry last message\n` +
      `/permissions - View/change permission mode\n` +
      `/restart - Restart the bot\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt current query\n` +
      `• Use "think" keyword for extended reasoning\n` +
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

  // Working directory
  lines.push(`\n📁 Working dir: <code>${WORKING_DIR}</code>`);

  // Permission mode
  const permMode = getPermissionMode();
  const permIcon = permMode === "bypass" ? "🔓" : "🔐";
  lines.push(`${permIcon} Permission mode: ${permMode}`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /resume - Resume the last session.
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

  const [success, message] = await session.resumeLast();
  if (success) {
    await ctx.reply(`✅ ${message}`);
  } else {
    await ctx.reply(`❌ ${message}`);
  }
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
 * /plan - Enter plan mode (read-only exploration).
 */
export async function handlePlan(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!session.isActive || !session.sessionId) {
    await ctx.reply("❌ No active session. Send a message first to start a session.");
    return;
  }

  // Create plan mode state
  const stateFile = `/tmp/plan-state-${session.sessionId}.json`;
  const state = {
    session_id: session.sessionId,
    plan_mode_enabled: true,
    active_plan_file: null,
    plan_created_at: new Date().toISOString(),
    restricted_tools: [
      "Read",
      "Glob",
      "Grep",
      "Bash",
      "WritePlan",
      "UpdatePlan",
      "ExitPlanMode",
    ],
  };

  await Bun.write(stateFile, JSON.stringify(state, null, 2));

  await ctx.reply(
    "📋 <b>Plan mode activated</b>\n\n" +
      "You are now in READ-ONLY exploration mode. Claude can:\n" +
      "• Read and explore the codebase\n" +
      "• Run read-only Bash commands\n" +
      "• Create and update implementation plans\n\n" +
      "Claude <b>cannot</b>:\n" +
      "• Write or edit files\n" +
      "• Make any system modifications\n\n" +
      "Use /code to exit plan mode and proceed with implementation.",
    {
      parse_mode: "HTML",
    }
  );
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

  // Check if plan mode is active
  const stateFile = `/tmp/plan-state-${session.sessionId}.json`;
  const file = Bun.file(stateFile);

  if (!(await file.exists())) {
    await ctx.reply("ℹ️ Plan mode is not active.");
    return;
  }

  const state = JSON.parse(await file.text());

  if (!state.plan_mode_enabled) {
    await ctx.reply("ℹ️ Plan mode is not active.");
    return;
  }

  // Disable plan mode
  state.plan_mode_enabled = false;
  await Bun.write(stateFile, JSON.stringify(state, null, 2));

  await ctx.reply(
    "💻 <b>Plan mode exited</b>\n\n" +
      "Claude can now execute code and make system modifications.",
    {
      parse_mode: "HTML",
    }
  );
}
