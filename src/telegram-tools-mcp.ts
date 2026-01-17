/**
 * In-process MCP server for Telegram-specific tools.
 *
 * Provides tools that interact with the Telegram bot instance.
 */

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { isPathAllowed } from "./security";
import { getWorkingDir } from "./config";
import { existsSync, statSync } from "fs";
import { resolve, isAbsolute, basename } from "path";

/**
 * In-process MCP server for Telegram operations.
 */
export const telegramToolsMcpServer = createSdkMcpServer({
  name: "telegram-tools",
  version: "1.0.0",
  tools: [
    {
      name: "SendFileToTelegram",
      description:
        "Send a file from the project to the Telegram chat. Accepts absolute or relative paths (relative to current working directory). Maximum file size: 50MB. Requires user approval.",
      inputSchema: {
        file_path: z
          .string()
          .describe("Path to file (absolute or relative to project)"),
        caption: z.string().optional().describe("Optional caption (max 1024 chars)"),
      },
      handler: async (args) => {
        const { file_path, caption } = args as {
          file_path: string;
          caption?: string;
        };

        // 1. Get chat ID from environment
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!chatId) {
          throw new Error(
            "Telegram chat context not available (tool must be called from active session)"
          );
        }

        // 2. Resolve path (relative to working dir if needed)
        let resolvedPath: string;
        if (isAbsolute(file_path)) {
          resolvedPath = file_path;
        } else {
          resolvedPath = resolve(getWorkingDir(), file_path);
        }

        // 3. Validate file exists
        if (!existsSync(resolvedPath)) {
          throw new Error(`File not found: ${file_path}`);
        }

        // 4. Validate is a file (not directory)
        const stats = statSync(resolvedPath);
        if (!stats.isFile()) {
          throw new Error("Path is a directory. Only files are supported.");
        }

        // 5. Check file size (50MB limit)
        const sizeMB = stats.size / (1024 * 1024);
        if (sizeMB > 50) {
          throw new Error(`File too large: ${sizeMB.toFixed(1)}MB (max 50MB)`);
        }

        // 6. Validate path is allowed
        if (!isPathAllowed(resolvedPath)) {
          throw new Error(`Access denied: path outside allowed directories`);
        }

        // 7. Get bot instance (lazy import to avoid circular deps)
        const { bot } = await import("./index");
        const { InputFile } = await import("grammy");

        // 8. Read file and send
        try {
          const fileBuffer = await Bun.file(resolvedPath).arrayBuffer();
          const buffer = Buffer.from(fileBuffer);
          const filename = basename(resolvedPath);

          await bot.api.sendDocument(Number(chatId), new InputFile(buffer, filename), {
            caption: caption || undefined,
            disable_notification: false,
          });

          return {
            content: [
              {
                type: "text",
                text: `File sent: ${filename} (${sizeMB.toFixed(2)}MB)`,
              },
            ],
          };
        } catch (error) {
          throw new Error(
            `Failed to send file: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
    },
  ],
});
