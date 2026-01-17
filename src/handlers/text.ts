/**
 * Text message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { session } from "../session";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  checkInterrupt,
  startTypingIndicator,
} from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  let message = ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check if this is custom input for ask-user "Other" option
  console.log(`[TEXT] Checking for custom input: chatId=${chatId}, message="${message.substring(0, 30)}..."`);
  const { handleCustomInput } = await import("./ask-user-other");
  if (handleCustomInput(chatId, message)) {
    console.log(`[TEXT] Custom input handled, replying to user`);
    await ctx.reply("✅ Custom input received. Processing...");
    return;
  }
  console.log(`[TEXT] Not custom input, continuing...`);

  // 3. Check if this is commentary input for plan rejection
  const { handleCommentaryInput } = await import("./plan-approval");
  if (handleCommentaryInput(chatId, message)) {
    await ctx.reply("✅ Commentary received. Processing your feedback...");
    return;
  }

  // 4. Check if this is a reply to a permission comment request
  if (ctx.message?.reply_to_message) {
    const replyText = ctx.message.reply_to_message.text || "";
    if (replyText.includes("Please provide a reason for denial:")) {
      await handlePermissionComment(ctx, chatId, message);
      return;
    }
  }

  // 5. Check for interrupt prefix
  message = await checkInterrupt(message);
  if (!message.trim()) {
    return;
  }

  // 6. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  // 5. Store message for retry
  session.lastMessage = message;

  // 6. Mark processing started
  const stopProcessing = session.startProcessing();

  // 7. Start typing indicator
  const typing = startTypingIndicator(ctx);

  // 8. Create streaming state and callback
  let state = new StreamingState();
  let statusCallback = createStatusCallback(ctx, state);

  // 8.5. Notify user if new session is starting
  const isNewSession = !session.isActive;
  if (isNewSession) {
    await ctx.reply("🆕 New session started");
  }

  // 9. Send to Claude with retry logic for crashes
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await session.sendMessageStreaming(
        message,
        username,
        userId,
        statusCallback,
        chatId,
        ctx
      );

      // 10. Audit log
      await auditLog(userId, username, "TEXT", message, response);
      break; // Success - exit retry loop
    } catch (error) {
      const errorStr = String(error);
      const isClaudeCodeCrash = errorStr.includes("exited with code");

      // Clean up any partial messages from this attempt
      for (const toolMsg of state.toolMessages) {
        try {
          await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Retry on Claude Code crash (not user cancellation)
      if (isClaudeCodeCrash && attempt < MAX_RETRIES) {
        console.log(
          `Claude Code crashed, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`
        );
        await session.kill(); // Clear corrupted session
        await ctx.reply(`⚠️ Claude crashed, retrying...`);
        // Reset state for retry
        state = new StreamingState();
        statusCallback = createStatusCallback(ctx, state);
        continue;
      }

      // Final attempt failed or non-retryable error
      console.error("Error processing message:", error);

      // Check if it was a cancellation
      if (errorStr.includes("abort") || errorStr.includes("cancel")) {
        // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
        const wasInterrupt = session.consumeInterruptFlag();
        if (!wasInterrupt) {
          await ctx.reply("🛑 Query stopped.");
        }
      } else {
        await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
      }
      break; // Exit loop after handling error
    }
  }

  // 11. Cleanup
  stopProcessing();
  typing.stop();
}

/**
 * Handle permission comment reply.
 * Uses in-memory store - no file scanning needed.
 */
async function handlePermissionComment(
  ctx: Context,
  chatId: number,
  comment: string
): Promise<void> {
  const { permissionStore } = await import("../permission-store");
  const { resolvePermission } = await import("../permissions");

  // Find the awaiting_comment request for this chat
  const request = permissionStore.getAwaitingCommentForChat(chatId);

  if (request) {
    // Resolve the permission with denial + comment
    resolvePermission(request.request_id, false, comment);
    await ctx.reply("❌ Permission denied with your reason.");
  } else {
    await ctx.reply("⚠️ No pending permission request found.");
  }
}
