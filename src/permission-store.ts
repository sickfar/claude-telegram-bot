/**
 * In-memory store for permission requests.
 *
 * Replaces file-based storage in /tmp/perm-*.json with ephemeral in-memory storage.
 * Requests are automatically cleaned up after 5 minutes.
 */

export interface PermissionRequest {
  request_id: string;
  chat_id: number;
  tool_name: string;
  tool_input: string;
  formatted_request: string;
  status: "pending" | "sent" | "approved" | "denied" | "awaiting_comment";
  response?: string;
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
 * Singleton in-memory store for permission requests.
 */
class PermissionStore {
  private requests = new Map<string, PermissionRequest>();
  private cleanupInterval: Timer | null = null;
  private readonly CLEANUP_INTERVAL_MS = 60_000; // Check every minute
  private readonly REQUEST_TTL_MS = 300_000; // 5 minutes

  constructor() {
    this.startCleanup();
  }

  /**
   * Create a new permission request.
   */
  create(
    requestId: string,
    chatId: number,
    toolName: string,
    toolInput: string,
    formattedRequest: string
  ): void {
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

    this.requests.set(requestId, request);
    console.log(`Created permission request: ${requestId} (in-memory)`);
  }

  /**
   * Get a request by ID.
   */
  get(requestId: string): PermissionRequest | null {
    return this.requests.get(requestId) || null;
  }

  /**
   * Get all pending requests for a specific chat.
   */
  getPendingForChat(chatId: number): PermissionRequest[] {
    const pending: PermissionRequest[] = [];

    for (const request of this.requests.values()) {
      if (request.status === "pending" && request.chat_id === chatId) {
        pending.push(request);
      }
    }

    return pending;
  }

  /**
   * Update a request's status and optional response.
   */
  update(
    requestId: string,
    status: PermissionRequest["status"],
    response?: string
  ): void {
    const request = this.requests.get(requestId);
    if (!request) {
      console.warn(`Cannot update non-existent request: ${requestId}`);
      return;
    }

    request.status = status;
    request.updated_at = new Date().toISOString();
    if (response !== undefined) {
      request.response = response;
    }

    console.log(`Updated permission request ${requestId}: ${status}`);
  }

  /**
   * Poll for permission request result with timeout.
   * Replaces file-based polling with in-memory checks.
   */
  async poll(requestId: string, timeoutMs: number): Promise<PermissionResult> {
    const startTime = Date.now();
    const pollInterval = 500; // Check every 500ms

    while (Date.now() - startTime < timeoutMs) {
      const request = this.get(requestId);

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
          // Clean up after successful approval
          this.delete(requestId);
          return {
            behavior: "allow",
            updatedInput: toolInput,
          };
        } catch {
          // If parsing fails, return as empty object
          this.delete(requestId);
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
        // Clean up after denial
        this.delete(requestId);
        return {
          behavior: "deny",
          message,
        };
      }

      // Still pending or sent - keep waiting
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout - deny by default for safety
    this.delete(requestId);
    return {
      behavior: "deny",
      message: "Permission request timed out (no response after 55 seconds)",
    };
  }

  /**
   * Delete a request.
   */
  delete(requestId: string): void {
    this.requests.delete(requestId);
    console.log(`Deleted permission request: ${requestId}`);
  }

  /**
   * Start automatic cleanup of old requests.
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Remove requests older than TTL.
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [requestId, request] of this.requests.entries()) {
      const createdAt = new Date(request.created_at).getTime();
      const age = now - createdAt;

      if (age > this.REQUEST_TTL_MS) {
        this.requests.delete(requestId);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`Cleaned up ${removed} expired permission requests`);
    }
  }

  /**
   * Stop cleanup interval (for testing).
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get store stats (for debugging).
   */
  getStats(): {
    total: number;
    pending: number;
    sent: number;
    approved: number;
    denied: number;
  } {
    let pending = 0;
    let sent = 0;
    let approved = 0;
    let denied = 0;

    for (const request of this.requests.values()) {
      if (request.status === "pending") pending++;
      if (request.status === "sent") sent++;
      if (request.status === "approved") approved++;
      if (request.status === "denied") denied++;
    }

    return {
      total: this.requests.size,
      pending,
      sent,
      approved,
      denied,
    };
  }
}

// Export singleton instance
export const permissionStore = new PermissionStore();
