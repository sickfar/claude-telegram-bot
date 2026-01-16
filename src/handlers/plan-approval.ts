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

  // Capture approval data BEFORE state transition (which may clear it)
  const approvalData = session.getPendingPlanApproval();
  const oldSessionId = session.sessionId;

  // Use async handler to perform state transition
  const [success, message, shouldContinue] = await session.handlePlanApprovalAsync(
    requestId,
    action
  );

  if (!success) {
    await ctx.answerCallbackQuery({ text: message });
    return;
  }

  // Update message to show result
  await ctx.editMessageText(message, {
    parse_mode: "HTML",
  });

  // Handle different actions
  if (action === "accept") {
    await ctx.answerCallbackQuery({ text: "✅ Plan approved" });

    // Continue with implementation - send message to resume session
    if (shouldContinue && ctx.chat) {
      const { StreamingState, createStatusCallback } = await import("./streaming");
      const { startTypingIndicator } = await import("../utils");
      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state);

      // Start typing indicator
      const typing = startTypingIndicator(ctx);

      try {
        console.log("[PLAN-APPROVAL] Resuming session for implementation");
        await session.sendMessageStreaming(
          "The plan has been approved. Proceed with the implementation as outlined in the plan.",
          ctx.from?.username || "user",
          ctx.from?.id || 0,
          statusCallback,
          ctx.chat.id,
          ctx
        );
        console.log("[PLAN-APPROVAL] Implementation response received");
      } catch (e) {
        console.error("[PLAN-APPROVAL] Error resuming session:", e);
        await ctx.reply("❌ Error starting implementation. Please try again.");
      } finally {
        typing.stop();
      }
    }
  } else if (action === "reject") {
    await ctx.answerCallbackQuery({ text: "❌ Plan rejected" });
    // Session continues but plan is discarded
  } else if (action === "clear") {
    await ctx.answerCallbackQuery({ text: "🔄 Starting fresh session with plan" });

    // Use pre-captured approval data (captured before state transition cleared it)
    const planContent = approvalData?.planContent || "";

    // Get the old session log file path
    const { getClaudeProjectDir } = await import("../session-storage");
    const projectDir = getClaudeProjectDir();
    const oldSessionLogFile = oldSessionId ? `${projectDir}/${oldSessionId}.jsonl` : null;

    // Kill the session (clears context)
    await session.kill();
    console.log("[PLAN-APPROVAL] Session cleared, starting new session with plan");

    // Start new session with plan context
    if (shouldContinue && ctx.chat && planContent) {
      const { StreamingState, createStatusCallback } = await import("./streaming");
      const { startTypingIndicator } = await import("../utils");
      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state);

      // Start typing indicator
      const typing = startTypingIndicator(ctx);

      // Build the prompt with plan and reference to old session
      let prompt = `# Implementation Plan\n\nFollow this implementation plan:\n\n---\n${planContent}\n---\n\n`;
      prompt += `Proceed with implementing this plan step by step.\n\n`;

      if (oldSessionLogFile) {
        prompt += `If you need any details from the planning discussion, you can reference the previous conversation log at: ${oldSessionLogFile}`;
      }

      try {
        console.log("[PLAN-APPROVAL] Starting new session with plan context");
        await session.sendMessageStreaming(
          prompt,
          ctx.from?.username || "user",
          ctx.from?.id || 0,
          statusCallback,
          ctx.chat.id,
          ctx
        );
        console.log("[PLAN-APPROVAL] New session started with plan");
      } catch (e) {
        console.error("[PLAN-APPROVAL] Error starting new session:", e);
        await ctx.reply("❌ Error starting new session. Please try again.");
      } finally {
        typing.stop();
      }
    }
  }
}
