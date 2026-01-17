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
  private resolvers = new Map<string, (result: PermissionResult) => void>();

  constructor() {
    // No automatic cleanup - manual cleanup on new session
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
   * Get request awaiting comment for a specific chat.
   */
  getAwaitingCommentForChat(chatId: number): PermissionRequest | null {
    for (const request of this.requests.values()) {
      if (request.status === "awaiting_comment" && request.chat_id === chatId) {
        return request;
      }
    }
    return null;
  }

  /**
   * Check if there's a pending permission comment for a specific chat.
   * Used by sequentialize middleware to bypass queue and prevent deadlock.
   */
  isPendingPermissionComment(chatId: number): boolean {
    return this.getAwaitingCommentForChat(chatId) !== null;
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
   * Create a Promise that will be resolved when the user approves/denies.
   * Event-based architecture - no polling, no timeout.
   */
  createPromise(requestId: string): Promise<PermissionResult> {
    console.log(`[PERMISSION DEBUG] Creating Promise for request ${requestId}`);

    return new Promise<PermissionResult>((resolve) => {
      // Store the resolver function to be called by the callback handler
      this.resolvers.set(requestId, resolve);
      console.log(`[PERMISSION DEBUG] Resolver stored for ${requestId}, waiting for user action...`);
    });
  }

  /**
   * Resolve a pending permission Promise (called from callback handler).
   */
  resolve(requestId: string, approved: boolean, message?: string): void {
    const resolver = this.resolvers.get(requestId);
    const request = this.requests.get(requestId);

    if (!resolver) {
      console.warn(`[PERMISSION DEBUG] No resolver found for ${requestId}`);
      return;
    }

    console.log(`[PERMISSION DEBUG] Resolving Promise for ${requestId}: ${approved ? 'ALLOW' : 'DENY'}`);

    if (approved) {
      // Parse tool_input back to object
      try {
        const toolInput = JSON.parse(request?.tool_input || "{}");
        resolver({
          behavior: "allow",
          updatedInput: toolInput,
        });
      } catch {
        resolver({
          behavior: "allow",
          updatedInput: {},
        });
      }
    } else {
      resolver({
        behavior: "deny",
        message: message || "Permission denied by user",
        // NOTE: Do NOT set interrupt: true - it causes the turn to end before Claude can respond
        // Claude will see the denial message and can respond normally
      });
    }

    // Clean up
    this.resolvers.delete(requestId);
    this.delete(requestId);
  }

  /**
   * Delete a request.
   */
  delete(requestId: string): void {
    this.requests.delete(requestId);
  }

  /**
   * Clear all pending requests and resolve any pending Promises.
   * Called when a new session starts.
   */
  clearAll(): void {
    const count = this.requests.size;

    // Resolve any pending Promises with deny
    for (const [requestId, resolver] of this.resolvers.entries()) {
      resolver({
        behavior: "deny",
        message: "Permission request cleared (new session started)",
      });
    }

    this.resolvers.clear();
    this.requests.clear();

    if (count > 0) {
      console.log(`Cleared ${count} pending permission requests`);
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

/**
 * Check if there's a pending permission comment for a specific chat.
 * Used by sequentialize middleware to bypass queue and prevent deadlock.
 */
export function isPendingPermissionComment(chatId: number): boolean {
  return permissionStore.isPendingPermissionComment(chatId);
}
