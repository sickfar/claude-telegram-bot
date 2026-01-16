/**
 * Permission request storage and polling.
 *
 * Uses file-based storage in /tmp/perm-{uuid}.json, similar to ask_user MCP pattern.
 */

import { randomUUID } from "crypto";

/**
 * Permission request file format: /tmp/perm-{uuid}.json
 */
export interface PermissionRequest {
  request_id: string;
  chat_id: number;
  tool_name: string;
  tool_input: string;
  formatted_request: string; // Human-readable description
  status: "pending" | "sent" | "approved" | "denied" | "awaiting_comment";
  response?: string; // For "deny with comment"
  created_at: string;
  updated_at: string;
}

/**
 * Result of a permission check.
 */
export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

/**
 * Create a new permission request and save to file.
 * Returns the request_id.
 */
export function createPermissionRequest(
  chatId: number,
  toolName: string,
  toolInput: string,
  formattedRequest: string
): string {
  const requestId = randomUUID();
  const request: PermissionRequest = {
    request_id: requestId,
    chat_id: chatId,
    tool_name: toolName,
    tool_input: toolInput,
    formatted_request: formattedRequest,
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const filepath = `/tmp/perm-${requestId}.json`;
  Bun.write(filepath, JSON.stringify(request));
  console.log(`Created permission request: ${requestId}`);

  return requestId;
}

/**
 * Get a permission request by ID.
 */
export async function getPermissionRequest(
  requestId: string
): Promise<PermissionRequest | null> {
  const filepath = `/tmp/perm-${requestId}.json`;
  try {
    const file = Bun.file(filepath);
    const text = await file.text();
    return JSON.parse(text);
  } catch (error) {
    console.warn(`Failed to load permission request ${requestId}:`, error);
    return null;
  }
}

/**
 * Update a permission request status and optional response.
 */
export async function updatePermissionRequest(
  requestId: string,
  status: PermissionRequest["status"],
  response?: string
): Promise<void> {
  const request = await getPermissionRequest(requestId);
  if (!request) {
    console.warn(`Cannot update non-existent request: ${requestId}`);
    return;
  }

  request.status = status;
  request.updated_at = new Date().toISOString();
  if (response !== undefined) {
    request.response = response;
  }

  const filepath = `/tmp/perm-${requestId}.json`;
  await Bun.write(filepath, JSON.stringify(request));
}

/**
 * Poll for permission request result with timeout.
 * Returns permission result or denies on timeout.
 */
export async function pollPermissionRequest(
  requestId: string,
  timeoutMs: number
): Promise<PermissionResult> {
  const startTime = Date.now();
  const pollInterval = 500; // Check every 500ms

  while (Date.now() - startTime < timeoutMs) {
    const request = await getPermissionRequest(requestId);

    if (!request) {
      return {
        behavior: "deny",
        message: "Permission request expired or was deleted",
      };
    }

    if (request.status === "approved") {
      // Parse tool_input back to object
      try {
        const toolInput = JSON.parse(request.tool_input);
        return {
          behavior: "allow",
          updatedInput: toolInput,
        };
      } catch {
        // If parsing fails, return as empty object
        return {
          behavior: "allow",
          updatedInput: {},
        };
      }
    }

    if (request.status === "denied") {
      const message = request.response
        ? `Permission denied: ${request.response}`
        : "Permission denied by user";
      return {
        behavior: "deny",
        message,
      };
    }

    // Still pending or sent - keep waiting
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timeout - deny by default for safety
  return {
    behavior: "deny",
    message: "Permission request timed out (no response after 55 seconds)",
  };
}

/**
 * Clean up permission request file (synchronous).
 */
export function cleanupPermissionRequest(requestId: string): void {
  const filepath = `/tmp/perm-${requestId}.json`;
  try {
    const fs = require("fs");
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      console.log(`Cleaned up permission request: ${requestId}`);
    }
  } catch (error) {
    console.debug(`Failed to cleanup permission request ${requestId}:`, error);
  }
}
