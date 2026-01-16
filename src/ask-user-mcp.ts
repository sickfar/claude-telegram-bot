/**
 * In-process MCP server for ask_user tool.
 *
 * Replaces the external stdio-based server with a direct in-memory implementation
 * using the Agent SDK's createSdkMcpServer(). This eliminates file I/O and the
 * need for scanning /tmp/ask-user-*.json files.
 */

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { askUserStore } from "./ask-user-store";

/**
 * In-process MCP server that presents options as Telegram inline keyboard buttons.
 * When Claude calls ask_user(), this directly populates the askUserStore.
 */
export const askUserMcpServer = createSdkMcpServer({
  name: "ask-user",
  version: "1.0.0",
  tools: [
    {
      name: "ask_user",
      description:
        "Present options to the user as tappable inline buttons in Telegram. IMPORTANT: After calling this tool, STOP and wait. Do NOT add any text after calling this tool - the user will tap a button and their choice becomes their next message. Just call the tool and end your turn.",
      inputSchema: {
        question: z.string().describe("The question to ask the user"),
        options: z
          .array(z.string())
          .min(2)
          .max(10)
          .describe(
            "List of options for the user to choose from (2-6 options recommended)"
          ),
      },
      handler: async (args) => {
        const { question, options } = args as { question: string; options: string[] };
        const requestId = crypto.randomUUID().slice(0, 8);
        const chatId = process.env.TELEGRAM_CHAT_ID || "";

        // Direct in-memory call - no file I/O!
        askUserStore.create(requestId, chatId, question, options);

        return {
          content: [
            {
              type: "text" as const,
              text: "[Buttons sent to user. STOP HERE - do not output any more text. Wait for user to tap a button.]",
            },
          ],
        };
      },
    },
  ],
});
