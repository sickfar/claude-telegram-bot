/**
 * Plan Approval UI Handler for Claude Telegram Bot.
 *
 * Displays inline keyboard buttons for plan approval (Accept/Reject/Clear Context).
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { session } from "../session";
import { escapeHtml } from "../formatting";

/**
 * Create inline keyboard for plan approval.
 */
export function createPlanApprovalKeyboard(requestId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("✅ Proceed", `planapproval:${requestId}:accept`)
    .row()
    .text("🔄 Clear Context & Proceed", `planapproval:${requestId}:clear`)
    .row()
    .text("❌ Reject with Commentary", `planapproval:${requestId}:reject`);

  return keyboard;
}

/**
 * Display plan approval UI with inline buttons (in-memory version).
 */
export async function displayPlanApproval(
  ctx: Context,
  planFile: string,
  planContent: string,
  requestId: string
): Promise<void> {
  console.log(`[PLAN-APPROVAL] displayPlanApproval called with planFile=${planFile}, requestId=${requestId}`);
  try {
    // Extract plan content without frontmatter
    const planWithoutFrontmatter = planContent.replace(
      /^---\n[\s\S]*?\n---\n\n/,
      ""
    );

    console.log(`[PLAN-APPROVAL] Sending header message`);
    // Send header message
    const headerMessage = `📋 <b>Implementation Plan Ready</b>\n\nFile: <code>${planFile}</code>\n`;
    await ctx.reply(headerMessage, { parse_mode: "HTML" });
    console.log(`[PLAN-APPROVAL] Header sent`);

    // Send plan content - as message if small, as document if large
    const MESSAGE_LIMIT = 3800; // Leave room for HTML formatting

    if (planWithoutFrontmatter.length <= MESSAGE_LIMIT) {
      // Small enough for a message - escape HTML and send
      const escapedPlan = escapeHtml(planWithoutFrontmatter);
      await ctx.reply(`<pre>${escapedPlan}</pre>`, {
        parse_mode: "HTML",
      });
    } else {
      // Too large - send as document
      const { InputFile } = await import("grammy");
      const buffer = Buffer.from(planContent, "utf-8");
      await ctx.replyWithDocument(new InputFile(buffer, planFile), {
        caption: "📄 Plan file (too large for message)",
      });
    }

    // Send approval buttons as final message
    console.log(`[PLAN-APPROVAL] Sending approval buttons`);
    const keyboard = createPlanApprovalKeyboard(requestId);
    await ctx.reply(`<b>Review and approve:</b>`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    console.log(`[PLAN-APPROVAL] Approval dialog complete`);
  } catch (error) {
    console.error(`[PLAN-APPROVAL] Error displaying plan approval:`, error);
    await ctx.reply("❌ Error displaying plan. Please check logs.");
  }
}

// State to track pending commentary input
let pendingCommentary: { requestId: string; chatId: number } | null = null;

/**
 * Check if we're waiting for commentary from a specific chat (used for sequentialize bypass).
 */
export function isPendingCommentary(chatId: number): boolean {
  return pendingCommentary !== null && pendingCommentary.chatId === chatId;
}

/**
 * Check if we're waiting for commentary input and handle it.
 * Called from text handler.
 */
export function handleCommentaryInput(chatId: number, text: string): boolean {
  if (!pendingCommentary || pendingCommentary.chatId !== chatId) {
    return false; // Not waiting for commentary
  }

  const { requestId } = pendingCommentary;
  pendingCommentary = null; // Clear state

  console.log(`[PLAN-APPROVAL] Received commentary for ${requestId}: ${text.substring(0, 50)}...`);

  // Resolve the approval with commentary
  session.planStateManager.answerApproval(requestId, { type: "reject", commentary: text });

  return true; // Handled
}

/**
 * Handle plan approval callback using PlanStateManager.
 */
export async function handlePlanApprovalCallback(
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
  const action = parts[2]! as "accept" | "reject" | "clear";

  // Capture approval data BEFORE resolving (for "clear" action handling)
  const approvalData = session.getPendingPlanApproval();

  // For "reject", ask for commentary first
  if (action === "reject") {
    pendingCommentary = { requestId, chatId };

    await ctx.editMessageText("❌ <b>Plan Rejected</b>\n\nPlease send your commentary/feedback:", {
      parse_mode: "HTML",
    });

    await ctx.answerCallbackQuery({
      text: "Send your commentary as a text message",
    });

    return; // Don't resolve yet - wait for text input
  }

  // For "accept" and "clear", proceed immediately
  const messages = {
    accept: "✅ <b>Plan Approved</b>",
    clear: "🔄 <b>Context Cleared - Starting Fresh</b>",
  };

  await ctx.editMessageText(messages[action], {
    parse_mode: "HTML",
  });

  // Answer the callback
  await ctx.answerCallbackQuery({
    text: messages[action].replace(/<[^>]*>/g, ""), // Strip HTML tags
  });

  // Resolve the promise - this unblocks the MCP handler
  console.log(`[PLAN-APPROVAL DEBUG] Resolving promise for request ${requestId} with action: ${action}`);
  const approvalAction = action === "accept" ? { type: "accept" as const } : { type: "clear" as const };
  session.planStateManager.answerApproval(requestId, approvalAction);

  // Promise-based flow: The MCP tool will receive the action and handle the response.
  // For "clear" action, we need to kill the session since that's UI-level logic.
  if (approvalData?.resolve) {
    console.log(`[PLAN-APPROVAL DEBUG] Promise-based flow - action: ${action}`);

    if (action === "clear" && ctx.chat) {
      // Kill session and let MCP handler know context was cleared
      console.log("[PLAN-APPROVAL] Killing session for context clear");
      await session.kill();
    }

    // The MCP handler will receive the action and continue from there
    return;
  }

}
