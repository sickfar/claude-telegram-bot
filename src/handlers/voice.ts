/**
 * Voice message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session } from "../session";
import { ALLOWED_USERS, TEMP_DIR, TRANSCRIPTION_AVAILABLE, getVoiceLocale, VOICE_TRANSLATION_TARGET } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  processVoiceMessage,
  startTypingIndicator,
} from "../utils";
import { escapeHtml } from "../formatting";
import { StreamingState, createStatusCallback } from "./streaming";

/**
 * Handle incoming voice messages.
 */
export async function handleVoice(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const voice = ctx.message?.voice;

  if (!userId || !voice || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check if transcription is available
  if (!TRANSCRIPTION_AVAILABLE) {
    await ctx.reply(
      "Voice transcription is not configured. Ensure ffmpeg, hear, and translate-shell are installed."
    );
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  // 4. Mark processing started (allows /stop to work during transcription/classification)
  const stopProcessing = session.startProcessing();

  // 5. Start typing indicator for transcription
  const typing = startTypingIndicator(ctx);

  let voicePath: string | null = null;

  try {
    // 6. Download voice file
    const file = await ctx.getFile();
    const timestamp = Date.now();
    voicePath = `${TEMP_DIR}/voice_${timestamp}.ogg`;

    // Download the file
    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
    );
    const buffer = await downloadRes.arrayBuffer();
    await Bun.write(voicePath, buffer);

    // 7. Transcribe and translate
    const statusMsg = await ctx.reply("🎤 Transcribing...");

    // Get current voice locale
    const locale = getVoiceLocale();

    // Process voice message with locale and translation target
    const result = await processVoiceMessage(
      voicePath,
      locale,
      VOICE_TRANSLATION_TARGET
    );

    if (!result) {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        "❌ Voice processing failed. Ensure ffmpeg, hear, and translate-shell are installed."
      );
      stopProcessing();
      return;
    }

    // 8. Show appropriate message based on whether translation occurred
    let displayText: string;
    if (result.wasTranslated) {
      // Show both original and translated
      displayText = `🎤 Original: ${escapeHtml(result.original)}\n🌐 ${VOICE_TRANSLATION_TARGET.toUpperCase()}: ${escapeHtml(result.translated)}`;
    } else {
      // No translation needed, show only transcribed text
      displayText = `🎤 ${escapeHtml(result.original)}`;
    }

    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      displayText,
      { parse_mode: "HTML" }
    );

    // 9. Create streaming state and callback
    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);

    // 10. Send translated text to Claude (or original if no translation)
    const claudeResponse = await session.sendMessageStreaming(
      result.translated,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    // 11. Audit log
    const auditContent = result.wasTranslated
      ? `Original: ${result.original}\n${VOICE_TRANSLATION_TARGET}: ${result.translated}`
      : result.original;

    await auditLog(userId, username, "VOICE", auditContent, claudeResponse);
  } catch (error) {
    console.error("Error processing voice:", error);

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
    stopProcessing();
    typing.stop();

    // Clean up voice file
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch (error) {
        console.debug("Failed to delete voice file:", error);
      }
    }
  }
}
