/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration).
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session } from "../session";
import {
  ALLOWED_USERS,
  setModel,
  isValidModelName,
  MODEL_IDS,
} from "../config";
import { isAuthorized } from "../security";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

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

  // 3. Load request file
  const requestFile = `/tmp/ask-user-${requestId}.json`;
  let requestData: {
    question: string;
    options: string[];
    status: string;
  };

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
    console.error(`Failed to load ask-user request ${requestId}:`, error);
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // 4. Get selected option
  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  // 5. Update the message to show selection
  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch (error) {
    console.debug("Failed to edit callback message:", error);
  }

  // 6. Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // 7. Delete request file
  try {
    unlinkSync(requestFile);
  } catch (error) {
    console.debug("Failed to delete request file:", error);
  }

  // 8. Send the choice to Claude as a message
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
      ctx
    );

    await auditLog(userId, username, "CALLBACK", message, response);
  } catch (error) {
    console.error("Error processing callback:", error);

    for (const toolMsg of state.toolMessages) {
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

  const requestFile = `/tmp/perm-${requestId}.json`;
  let requestData: {
    formatted_request: string;
    status: string;
    updated_at: string;
    response?: string;
  };

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
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

    // Update request file
    requestData.status = "approved";
    requestData.updated_at = new Date().toISOString();
    await Bun.write(requestFile, JSON.stringify(requestData));

    await ctx.answerCallbackQuery({ text: "✅ Approved" });
  } else if (action === "deny") {
    // Update message to show denial
    await ctx.editMessageText(
      `❌ <b>Denied</b>\n\n${requestData.formatted_request}`,
      {
        parse_mode: "HTML",
      }
    );

    // Update request file
    requestData.status = "denied";
    requestData.response = "Denied by user";
    requestData.updated_at = new Date().toISOString();
    await Bun.write(requestFile, JSON.stringify(requestData));

    await ctx.answerCallbackQuery({ text: "❌ Denied" });
  } else if (action === "comment") {
    // Update message to show awaiting comment
    await ctx.editMessageText(
      `💬 <b>Please provide a reason for denial:</b>\n\n${requestData.formatted_request}`,
      {
        parse_mode: "HTML",
      }
    );

    // Set a flag in the request file to indicate waiting for comment
    requestData.status = "awaiting_comment";
    requestData.updated_at = new Date().toISOString();
    await Bun.write(requestFile, JSON.stringify(requestData));

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
