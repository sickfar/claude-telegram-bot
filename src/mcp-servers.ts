/**
 * Core in-process MCP servers for Claude Telegram Bot.
 *
 * These are essential components that must always be available.
 * For external/user-specific MCP servers, see mcp-config.ts
 */

import { planModeMcpServer } from "./plan-mode-mcp";
import { telegramToolsMcpServer } from "./telegram-tools-mcp";
import type { McpServerConfig } from "./types";

/**
 * Core MCP servers that are always loaded.
 * These are built into the application and not user-configurable.
 */
export const CORE_MCP_SERVERS: Record<string, McpServerConfig> = {
  // Plan Mode - in-process MCP server (no file I/O for state)
  "plan-mode": planModeMcpServer,

  // Telegram Tools - in-process MCP server for Telegram operations
  "telegram-tools": telegramToolsMcpServer,
};
