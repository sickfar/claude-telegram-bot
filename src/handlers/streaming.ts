/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard } from "grammy";
import type { StatusCallback } from "../types";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
  BUTTON_LABEL_MAX_LENGTH,
} from "../config";
import { askUserStore } from "../ask-user-store";
import { permissionStore } from "../permission-store";

/**
 * Create inline keyboard for ask_user options.
 */
export function createAskUserKeyboard(
  requestId: string,
  options: string[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let idx = 0; idx < options.length; idx++) {
    const option = options[idx]!;
    // Truncate long options for button display
    const display =
      option.length > BUTTON_LABEL_MAX_LENGTH
        ? option.slice(0, BUTTON_LABEL_MAX_LENGTH) + "..."
        : option;
    const callbackData = `askuser:${requestId}:${idx}`;
    keyboard.text(display, callbackData).row();
  }
  return keyboard;
}

/**
 * Create inline keyboard for permission request.
 */
export function createPermissionKeyboard(requestId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text("✅ Allow", `perm:${requestId}:allow`).row();
  keyboard.text("✅ Always Allow", `perm:${requestId}:always`).row();
  keyboard.text("❌ Deny", `perm:${requestId}:deny`).row();
  keyboard.text("💬 Deny with reason", `perm:${requestId}:comment`).row();
  return keyboard;
}

/**
 * Format permission request for display.
 */
export function formatPermissionRequest(
  toolName: string,
  toolInput: string
): string {
  // Parse tool name (remove mcp__ prefix if present)
  const cleanName = toolName.replace(/^mcp__[^_]+__/, "");

  // Parse the JSON input
  let input: any;
  try {
    input = JSON.parse(toolInput);
  } catch {
    // If not valid JSON, use as-is
    return `🛠 <b>Use tool:</b> ${cleanName}\n<code>${escapeHtml(toolInput.slice(0, 200))}</code>`;
  }

  // Format based on tool type
  if (toolName === "Bash") {
    const command = input.command || toolInput;
    return `🔧 <b>Execute command:</b>\n<code>${escapeHtml(command)}</code>`;
  } else if (toolName === "Read") {
    const filePath = input.file_path || toolInput;
    return `📖 <b>Read file:</b>\n<code>${escapeHtml(filePath)}</code>`;
  } else if (toolName === "Write" || toolName === "Edit") {
    const filePath = input.file_path || toolInput;
    return `✏️ <b>Modify file:</b>\n<code>${escapeHtml(filePath)}</code>`;
  } else {
    // For other tools, show the tool name and truncated input
    return `🛠 <b>Use tool:</b> ${cleanName}\n<code>${escapeHtml(toolInput.slice(0, 200))}</code>`;
  }
}

/**
 * Display permission request UI immediately.
 * Called directly from canUseTool callback - no scanning, no waiting.
 */
export async function displayPermissionRequest(
  ctx: Context,
  requestId: string,
  formattedRequest: string
): Promise<void> {
  try {
    const keyboard = createPermissionKeyboard(requestId);

    await ctx.reply(`🔐 <b>Permission Required</b>\n\n${formattedRequest}`, {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });

    // Mark as sent in store
    permissionStore.update(requestId, "sent");
    console.log(`[PERMISSION DEBUG] UI displayed for ${requestId}`);
  } catch (error) {
    console.error(`Failed to display permission request ${requestId}:`, error);
  }
}

/**
 * Check for pending ask-user requests and send inline keyboards.
 * With the in-process MCP server, requests are already in the store - no file sync needed.
 */
export async function checkPendingAskUserRequests(
  ctx: Context,
  chatId: number
): Promise<boolean> {
  // Get pending requests from store (already populated by in-process MCP server)
  const pendingRequests = askUserStore.getPendingForChat(chatId);
  let buttonsSent = false;

  for (const request of pendingRequests) {
    try {
      const question = request.question || "Please choose:";
      const options = request.options || [];
      const requestId = request.request_id || "";

      if (options.length > 0 && requestId) {
        const keyboard = createAskUserKeyboard(requestId, options);
        await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
        buttonsSent = true;

        // Mark as sent in store
        askUserStore.markSent(requestId);
      }
    } catch (error) {
      console.warn(`Failed to send ask-user request ${request.request_id}:`, error);
    }
  }

  return buttonsSent;
}

/**
 * Tracks state for streaming message updates.
 */
export class StreamingState {
  textMessages = new Map<number, Message>(); // segment_id -> telegram message
  toolMessages: Message[] = []; // ephemeral tool status messages
  lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
  lastContent = new Map<number, string>(); // segment_id -> last sent content
}

/**
 * Create a status callback for streaming updates.
 */
export function createStatusCallback(
  ctx: Context,
  state: StreamingState
): StatusCallback {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      if (statusType === "thinking") {
        // Show thinking inline, compact (first 500 chars)
        const preview =
          content.length > 500 ? content.slice(0, 500) + "..." : content;
        const escaped = escapeHtml(preview);
        const thinkingMsg = await ctx.reply(`🧠 <i>${escaped}</i>`, {
          parse_mode: "HTML",
        });
        state.toolMessages.push(thinkingMsg);
      } else if (statusType === "tool") {
        const toolMsg = await ctx.reply(content, { parse_mode: "HTML" });
        state.toolMessages.push(toolMsg);
      } else if (statusType === "text" && segmentId !== undefined) {
        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;

        if (!state.textMessages.has(segmentId)) {
          // New segment - create message
          const display =
            content.length > TELEGRAM_SAFE_LIMIT
              ? content.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
              : content;
          const formatted = convertMarkdownToHtml(display);
          try {
            const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            // HTML parse failed, fall back to plain text
            console.debug("HTML reply failed, using plain text:", htmlError);
            const msg = await ctx.reply(formatted);
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          }
          state.lastEditTimes.set(segmentId, now);
        } else if (now - lastEdit > STREAMING_THROTTLE_MS) {
          // Update existing segment message (throttled)
          const msg = state.textMessages.get(segmentId)!;
          const display =
            content.length > TELEGRAM_SAFE_LIMIT
              ? content.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
              : content;
          const formatted = convertMarkdownToHtml(display);
          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }
          try {
            await ctx.api.editMessageText(
              msg.chat.id,
              msg.message_id,
              formatted,
              {
                parse_mode: "HTML",
              }
            );
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            console.debug("HTML edit failed, trying plain text:", htmlError);
            try {
              await ctx.api.editMessageText(
                msg.chat.id,
                msg.message_id,
                formatted
              );
              state.lastContent.set(segmentId, formatted);
            } catch (editError) {
              console.debug("Edit message failed:", editError);
            }
          }
          state.lastEditTimes.set(segmentId, now);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        if (state.textMessages.has(segmentId) && content) {
          const msg = state.textMessages.get(segmentId)!;
          const formatted = convertMarkdownToHtml(content);

          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }

          if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
            try {
              await ctx.api.editMessageText(
                msg.chat.id,
                msg.message_id,
                formatted,
                {
                  parse_mode: "HTML",
                }
              );
            } catch (error) {
              console.debug("Failed to edit final message:", error);
            }
          } else {
            // Too long - delete and split
            try {
              await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
            } catch (error) {
              console.debug("Failed to delete message for splitting:", error);
            }
            for (let i = 0; i < formatted.length; i += TELEGRAM_SAFE_LIMIT) {
              const chunk = formatted.slice(i, i + TELEGRAM_SAFE_LIMIT);
              try {
                await ctx.reply(chunk, { parse_mode: "HTML" });
              } catch (htmlError) {
                console.debug(
                  "HTML chunk failed, using plain text:",
                  htmlError
                );
                await ctx.reply(chunk);
              }
            }
          }
        }
      } else if (statusType === "done") {
        // Delete tool messages - text messages stay
        for (const toolMsg of state.toolMessages) {
          try {
            await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
          } catch (error) {
            console.debug("Failed to delete tool message:", error);
          }
        }
      }
    } catch (error) {
      console.error("Status callback error:", error);
    }
  };
}
