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

        console.log(`[ASK-USER DEBUG] MCP handler creating request with chatId="${chatId}"`);

        // Create request with promise - this will block until user responds!
        const answerPromise = askUserStore.createWithPromise(requestId, chatId, question, options);

        // Wait for user to click a button (promise resolves when they do)
        try {
          const selectedOption = await answerPromise;
          console.log(`[ASK-USER DEBUG] User selected: "${selectedOption}"`);

          return {
            content: [
              {
                type: "text" as const,
                text: `User selected: ${selectedOption}`,
              },
            ],
          };
        } catch (error) {
          console.error(`[ASK-USER DEBUG] Error waiting for user response:`, error);
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
  ],
});
