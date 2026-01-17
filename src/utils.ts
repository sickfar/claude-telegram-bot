/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, voice transcription, typing indicator.
 */

import OpenAI from "openai";
import type { Chat } from "grammy/types";
import type { Context } from "grammy";
import type { AuditEvent } from "./types";
import {
  AUDIT_LOG_PATH,
  AUDIT_LOG_JSON,
  AUDIT_LOG_MAX_SIZE_MB,
  AUDIT_LOG_MAX_FILES,
} from "./config";
import { AuditLogger } from "./audit-logger";

// ============== OpenAI Client ==============
// Lazy initialization to avoid circular dependency

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  if (openaiClient) return openaiClient;

  // Lazy import to avoid circular dependency
  const { OPENAI_API_KEY } = require("./config");
  if (OPENAI_API_KEY) {
    openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return openaiClient;
}

// ============== Audit Logging ==============

// Lazy initialization to avoid circular dependency
let auditLogger: AuditLogger | null = null;

function getAuditLogger(): AuditLogger {
  if (auditLogger) return auditLogger;

  // Lazy import to avoid circular dependency
  const {
    AUDIT_LOG_PATH,
    AUDIT_LOG_MAX_SIZE_MB,
    AUDIT_LOG_MAX_FILES,
    AUDIT_LOG_JSON,
  } = require("./config");

  auditLogger = new AuditLogger({
    logPath: AUDIT_LOG_PATH,
    maxSizeMB: AUDIT_LOG_MAX_SIZE_MB,
    maxFiles: AUDIT_LOG_MAX_FILES,
    jsonFormat: AUDIT_LOG_JSON,
  });

  return auditLogger;
}

export async function auditLog(
  userId: number,
  username: string,
  messageType: string,
  content: string,
  response = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "message",
    user_id: userId,
    username,
    message_type: messageType,
    content,
  };
  if (response) {
    event.response = response;
  }
  await getAuditLogger().log(event);
}

export async function auditLogAuth(
  userId: number,
  username: string,
  authorized: boolean
): Promise<void> {
  await getAuditLogger().log({
    timestamp: new Date().toISOString(),
    event: "auth",
    user_id: userId,
    username,
    authorized,
  });
}

export async function auditLogTool(
  userId: number,
  username: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  blocked = false,
  reason = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "tool_use",
    user_id: userId,
    username,
    tool_name: toolName,
    tool_input: toolInput,
    blocked,
  };
  if (blocked && reason) {
    event.reason = reason;
  }
  await getAuditLogger().log(event);
}

export async function auditLogError(
  userId: number,
  username: string,
  error: string,
  context = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "error",
    user_id: userId,
    username,
    error,
  };
  if (context) {
    event.context = context;
  }
  await getAuditLogger().log(event);
}

export async function auditLogRateLimit(
  userId: number,
  username: string,
  retryAfter: number
): Promise<void> {
  await getAuditLogger().log({
    timestamp: new Date().toISOString(),
    event: "rate_limit",
    user_id: userId,
    username,
    retry_after: retryAfter,
  });
}

// ============== Voice Transcription ==============

/**
 * Voice tools availability check result
 */
export interface VoiceToolsAvailability {
  ffmpeg: boolean;
  hear: boolean;
  trans: boolean;
  allAvailable: boolean;
}

/**
 * Voice transcription and translation result
 */
export interface VoiceTranscriptionResult {
  original: string;      // Transcribed text in original language
  translated: string;    // Translation in target language (or same as original)
  wasTranslated: boolean; // Whether translation occurred
}

/**
 * Check availability of voice processing tools (ffmpeg, hear, trans).
 * @returns Tool availability status
 */
export function checkVoiceToolsAvailability(): VoiceToolsAvailability {
  const ffmpeg = !!Bun.which("ffmpeg");
  const hear = !!Bun.which("hear");
  const trans = !!Bun.which("trans");

  return { ffmpeg, hear, trans, allAvailable: ffmpeg && hear && trans };
}

/**
 * Convert OGG audio file to WAV format (16kHz, mono).
 * @param oggPath - Path to .ogg file
 * @returns Path to .wav file, or null on failure
 */
export async function convertOggToWav(oggPath: string): Promise<string | null> {
  try {
    const timestamp = Date.now();
    const wavPath = `/tmp/telegram-bot/voice_${timestamp}.wav`;

    // Convert: 16kHz, mono, overwrite
    await Bun.$`ffmpeg -i ${oggPath} -ar 16000 -ac 1 -y ${wavPath}`.quiet();

    const file = Bun.file(wavPath);
    return (await file.exists()) ? wavPath : null;
  } catch (error) {
    console.error("Audio conversion failed:", error);
    return null;
  }
}

/**
 * Transcribe audio using Apple's 'hear' tool.
 * @param wavPath - Path to .wav file
 * @param locale - Voice recognition locale (e.g., "en-US", "ru-RU")
 * @returns Transcribed text, or null on failure
 */
export async function transcribeWithHear(
  wavPath: string,
  locale: string
): Promise<string | null> {
  try {
    const result = await Bun.$`hear -i ${wavPath} -l ${locale} -d`.quiet();
    const text = result.text().trim();
    return text || null;
  } catch (error) {
    console.error("Transcription with hear failed:", error);
    return null;
  }
}

/**
 * Translate text to target language using translate-shell.
 * Auto-detects source language.
 * @param text - Text to translate
 * @param targetLang - Target language code (e.g., "en", "es", "fr")
 * @returns Translation in target language, or null on failure
 */
export async function translateText(
  text: string,
  targetLang: string
): Promise<string | null> {
  try {
    // Use :targetLang to auto-detect source and translate to target
    const result = await Bun.$`trans -b :${targetLang} ${text}`.quiet();
    const translation = result.text().trim();
    return translation || null;
  } catch (error) {
    console.error("Translation failed:", error);
    return null;
  }
}

/**
 * Check if locale matches target language.
 * Compares language code prefix (before dash).
 * @param locale - Locale string (e.g., "en-US", "ru-RU")
 * @param targetLang - Target language code (e.g., "en", "ru")
 * @returns true if locale language matches target
 */
export function isLocaleLanguage(locale: string, targetLang: string): boolean {
  const localeLang = locale.split(/[_-]/)[0]?.toLowerCase() || "";
  return localeLang === targetLang.toLowerCase();
}

/**
 * Complete voice transcription and translation pipeline.
 * @param oggPath - Path to .ogg voice file
 * @param locale - Voice recognition locale (e.g., "en-US", "ru-RU")
 * @param targetLang - Target translation language code (e.g., "en", "es")
 * @returns Transcription result with original and translated text
 */
export async function processVoiceMessage(
  oggPath: string,
  locale: string,
  targetLang: string = "en"
): Promise<VoiceTranscriptionResult | null> {
  let wavPath: string | null = null;

  try {
    // Step 1: Convert to WAV
    wavPath = await convertOggToWav(oggPath);
    if (!wavPath) return null;

    // Step 2: Transcribe with specified locale
    const original = await transcribeWithHear(wavPath, locale);
    if (!original) return null;

    // Step 3: Translate if source and target languages differ
    const needsTranslation = !isLocaleLanguage(locale, targetLang);

    if (!needsTranslation) {
      // Already in target language, no translation needed
      return {
        original,
        translated: original,
        wasTranslated: false,
      };
    }

    // Translate to target language
    const translated = await translateText(original, targetLang);
    if (!translated) {
      // Translation failed, fallback to original text
      console.warn("Translation failed, using original text for Claude");
      return {
        original,
        translated: original,  // Fallback behavior
        wasTranslated: false,
      };
    }

    return {
      original,
      translated,
      wasTranslated: true,
    };
  } catch (error) {
    console.error("Voice processing pipeline failed:", error);
    return null;
  } finally {
    // Cleanup WAV file
    if (wavPath) {
      try {
        await Bun.$`rm ${wavPath}`.quiet();
      } catch (e) {
        console.warn(`Failed to cleanup ${wavPath}:`, e);
      }
    }
  }
}

/**
 * @deprecated Use processVoiceMessage instead. Kept for backward compatibility.
 * Falls back to OpenAI if available, otherwise uses new voice pipeline.
 */
export async function transcribeVoice(
  filePath: string
): Promise<string | null> {
  console.warn("transcribeVoice() is deprecated, use processVoiceMessage()");

  // Try OpenAI first if available (for backward compatibility)
  const client = getOpenAIClient();
  if (client) {
    try {
      const { TRANSCRIPTION_PROMPT } = require("./config");
      const file = Bun.file(filePath);
      const transcript = await client.audio.transcriptions.create({
        model: "gpt-4o-transcribe",
        file: file,
        prompt: TRANSCRIPTION_PROMPT,
      });
      return transcript.text;
    } catch (error) {
      console.error("OpenAI transcription failed, falling back to hear:", error);
    }
  }

  // Fall back to new voice pipeline
  const result = await processVoiceMessage(filePath, "en-US", "en");
  return result ? result.translated : null;
}

// ============== Typing Indicator ==============

export interface TypingController {
  stop: () => void;
}

export function startTypingIndicator(ctx: Context): TypingController {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await ctx.replyWithChatAction("typing");
      } catch (error) {
        console.debug("Typing indicator failed:", error);
      }
      await Bun.sleep(4000);
    }
  };

  // Start the loop
  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}

// ============== Message Interrupt ==============

// Import session lazily to avoid circular dependency
let sessionModule: {
  session: {
    isRunning: boolean;
    stop: () => Promise<"stopped" | "pending" | false>;
    markInterrupt: () => void;
    clearStopRequested: () => void;
  };
} | null = null;

export async function checkInterrupt(text: string): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  // Lazy import to avoid circular dependency
  if (!sessionModule) {
    sessionModule = await import("./session");
  }

  const strippedText = text.slice(1).trimStart();

  if (sessionModule.session.isRunning) {
    console.log("! prefix - interrupting current query");
    sessionModule.session.markInterrupt();
    await sessionModule.session.stop();
    await Bun.sleep(100);
    // Clear stopRequested so the new message can proceed
    sessionModule.session.clearStopRequested();
  }

  return strippedText;
}
