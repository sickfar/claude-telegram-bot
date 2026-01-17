/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { TELEGRAM_TOKEN, getWorkingDir, ALLOWED_USERS, RESTART_FILE } from "./config";
import { unlinkSync, readFileSync, existsSync } from "fs";
import {
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleRetry,
  handleProject,
  handlePermissionsCommand,
  handleModel,
  handleThinking,
  handleVoiceLocale,
  handlePlan,
  handleCode,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleCallback,
} from "./handlers";
import { isPendingCustomInput } from "./handlers/ask-user-other";
import { isPendingCommentary } from "./handlers/plan-approval";

// Create bot instance
export const bot = new Bot(TELEGRAM_TOKEN);

// Sequentialize non-command messages per user (prevents race conditions)
// Commands bypass sequentialization so they work immediately
bot.use(
  sequentialize((ctx) => {
    // Commands are not sequentialized - they work immediately
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // Messages with ! prefix bypass queue (interrupt)
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    // Callback queries (button clicks) are not sequentialized
    if (ctx.callbackQuery) {
      return undefined;
    }

    // Text messages that are responses to ask-user "Other" or plan rejection should NOT be sequentialized
    // Otherwise they create a deadlock (the ask/plan tool is waiting, but the text is queued)
    if (ctx.message?.text && ctx.chat?.id) {
      if (isPendingCustomInput(ctx.chat.id) || isPendingCommentary(ctx.chat.id)) {
        console.log(`[SEQUENTIALIZE] Bypassing queue for custom input/commentary response`);
        return undefined; // Don't sequentialize
      }
    }

    // Other messages are sequentialized per chat
    return ctx.chat?.id.toString();
  })
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("new", handleNew);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);
bot.command("project", handleProject);
bot.command("permissions", handlePermissionsCommand);
bot.command("model", handleModel);
bot.command("thinking", handleThinking);
bot.command("voicelocale", handleVoiceLocale);
bot.command("plan", handlePlan);
bot.command("code", handleCode);

// ============== Message Handlers ==============

// Text messages
bot.on("message:text", handleText);

// Voice messages
bot.on("message:voice", handleVoice);

// Photo messages
bot.on("message:photo", handlePhoto);

// Document messages
bot.on("message:document", handleDocument);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot - TypeScript Edition");
console.log("=".repeat(50));
console.log(`Current directory: ${getWorkingDir()}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log("Starting bot...");

// Get bot info first
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

// Register commands for Telegram's command suggestions (when user types /)
await bot.api.setMyCommands([
  { command: "new", description: "Start fresh session" },
  { command: "stop", description: "Stop current query" },
  { command: "status", description: "Show detailed status" },
  { command: "plan", description: "Start in planning mode" },
  { command: "code", description: "Exit plan mode" },
  { command: "project", description: "Switch project directory" },
  { command: "resume", description: "Resume last session" },
  { command: "retry", description: "Retry last message" },
  { command: "permissions", description: "View/change permission mode" },
  { command: "model", description: "Switch Claude model" },
  { command: "thinking", description: "Toggle extended thinking" },
  { command: "voicelocale", description: "Set voice recognition locale" },
  { command: "restart", description: "Restart the bot" },
]);

// Initialize storage (ensure directories, migrate old audit logs, cleanup temp files)
const { runMigrations } = await import("./migrations");
await runMigrations();

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Only update if restart was recent (within 30 seconds)
    if (age < 30000 && data.chat_id && data.message_id) {
      await bot.api.editMessageText(
        data.chat_id,
        data.message_id,
        "✅ Bot restarted"
      );
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try { unlinkSync(RESTART_FILE); } catch {}
  }
}

// Start with concurrent runner (commands work immediately)
const runner = run(bot);

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    console.log("Stopping bot...");
    runner.stop();
  }
};

process.on("SIGINT", () => {
  console.log("Received SIGINT");
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM");
  stopRunner();
  process.exit(0);
});
