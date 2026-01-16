/**
 * Plan Approval UI Handler for Claude Telegram Bot.
 *
 * Displays inline keyboard buttons for plan approval (Accept/Reject/Clear Context).
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { unlinkSync } from "fs";
import { session } from "../session";

export interface PlanApprovalRequest {
  request_id: string;
  chat_id: number;
  plan_file: string;
  plan_content: string;
  session_id: string;
  status: "pending" | "sent" | "approved" | "rejected";
  created_at: string;
  updated_at: string;
}

/**
 * Create inline keyboard for plan approval.
 */
export function createPlanApprovalKeyboard(requestId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("✅ Accept Plan", `planapproval:${requestId}:accept`)
    .text("❌ Reject Plan", `planapproval:${requestId}:reject`)
    .row()
    .text("🗑️ Clear Context & Proceed", `planapproval:${requestId}:clear`);

  return keyboard;
}

/**
 * Check for pending plan approval requests and display them.
 */
export async function checkPendingPlanApprovals(
  ctx: Context,
  chatId: number
): Promise<void> {
  // Scan /tmp for plan-*.json files
  const tmpDir = "/tmp";
  const files: string[] = [];

  try {
    for await (const entry of new Bun.Glob("plan-*.json").scan(tmpDir)) {
      files.push(`${tmpDir}/${entry}`);
    }
  } catch (error) {
    console.debug("Error scanning for plan approvals:", error);
    return;
  }

  // Process each pending request
  for (const filePath of files) {
    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) continue;

      const data: PlanApprovalRequest = JSON.parse(await file.text());

      // Skip if not for this chat or already sent
      if (data.chat_id !== chatId) continue;
      if (data.status !== "pending") continue;

      // Extract plan summary (first 500 chars without frontmatter)
      const planWithoutFrontmatter = data.plan_content.replace(
        /^---\n[\s\S]*?\n---\n\n/,
        ""
      );
      const planSummary =
        planWithoutFrontmatter.length > 500
          ? planWithoutFrontmatter.slice(0, 500) + "..."
          : planWithoutFrontmatter;

      // Send approval message with buttons
      const message = `📋 <b>Implementation Plan Ready</b>\n\nFile: <code>${data.plan_file}</code>\n\n<pre>${planSummary}</pre>\n\n<b>Review and approve:</b>`;

      const keyboard = createPlanApprovalKeyboard(data.request_id);

      await ctx.reply(message, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });

      // Mark as sent
      data.status = "sent";
      data.updated_at = new Date().toISOString();
      await Bun.write(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error(`Error processing plan approval ${filePath}:`, error);
    }
  }
}

/**
 * Handle plan approval callback.
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
  const action = parts[2]!; // "accept", "reject", or "clear"

  const requestFile = `/tmp/plan-${requestId}.json`;
  let requestData: PlanApprovalRequest;

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
    await ctx.answerCallbackQuery({ text: "Request expired" });
    return;
  }

  if (action === "accept") {
    // Update message to show approval
    await ctx.editMessageText(
      `✅ <b>Plan Accepted</b>\n\nFile: <code>${requestData.plan_file}</code>\n\nContinuing with implementation...`,
      {
        parse_mode: "HTML",
      }
    );

    // Update request file
    requestData.status = "approved";
    requestData.updated_at = new Date().toISOString();
    await Bun.write(requestFile, JSON.stringify(requestData));

    // Update plan mode state - disable plan mode so execution can proceed
    const stateFile = `/tmp/plan-state-${requestData.session_id}.json`;
    const stateFileObj = Bun.file(stateFile);
    if (await stateFileObj.exists()) {
      const state = JSON.parse(await stateFileObj.text());
      state.plan_mode_enabled = false;
      state.plan_approval_pending = false;
      await Bun.write(stateFile, JSON.stringify(state, null, 2));
    }

    await ctx.answerCallbackQuery({ text: "✅ Plan approved" });
  } else if (action === "reject") {
    // Update message to show rejection
    await ctx.editMessageText(
      `❌ <b>Plan Rejected</b>\n\nFile: <code>${requestData.plan_file}</code>\n\nThe plan has been rejected. Session continues without this plan.`,
      {
        parse_mode: "HTML",
      }
    );

    // Update request file
    requestData.status = "rejected";
    requestData.updated_at = new Date().toISOString();
    await Bun.write(requestFile, JSON.stringify(requestData));

    // Delete plan file
    const HOME = require("os").homedir();
    const planPath = `${HOME}/.claude/plans/${requestData.plan_file}`;
    try {
      unlinkSync(planPath);
      console.log(`Deleted rejected plan: ${planPath}`);
    } catch (error) {
      console.debug("Failed to delete plan file:", error);
    }

    // Update plan mode state - clear plan but keep session
    const stateFile = `/tmp/plan-state-${requestData.session_id}.json`;
    const stateFileObj = Bun.file(stateFile);
    if (await stateFileObj.exists()) {
      const state = JSON.parse(await stateFileObj.text());
      state.plan_mode_enabled = false;
      state.active_plan_file = null;
      state.plan_approval_pending = false;
      await Bun.write(stateFile, JSON.stringify(state, null, 2));
    }

    await ctx.answerCallbackQuery({ text: "❌ Plan rejected" });
  } else if (action === "clear") {
    // Update message to show context cleared
    await ctx.editMessageText(
      `🗑️ <b>Context Cleared</b>\n\nFile: <code>${requestData.plan_file}</code>\n\nSession cleared. The plan has been saved and can be accessed later.`,
      {
        parse_mode: "HTML",
      }
    );

    // Update request file
    requestData.status = "rejected";
    requestData.updated_at = new Date().toISOString();
    await Bun.write(requestFile, JSON.stringify(requestData));

    // Kill the session but keep plan file
    await session.kill();
    console.log("Session cleared after plan approval clear");

    // Clear plan mode state
    const stateFile = `/tmp/plan-state-${requestData.session_id}.json`;
    try {
      unlinkSync(stateFile);
    } catch (error) {
      console.debug("Failed to delete plan state file:", error);
    }

    await ctx.answerCallbackQuery({ text: "🗑️ Context cleared" });
  }

  // Clean up request file after handling
  try {
    unlinkSync(requestFile);
  } catch (error) {
    console.debug("Failed to delete request file:", error);
  }
}
