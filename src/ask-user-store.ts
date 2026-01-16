/**
 * In-memory store for ask-user requests.
 *
 * Replaces file-based storage in /tmp/ask-user-*.json with ephemeral in-memory storage.
 * Requests are automatically cleaned up after 5 minutes.
 */

export interface AskUserRequest {
  request_id: string;
  chat_id: string;
  question: string;
  options: string[];
  status: "pending" | "sent";
  created_at: string;
}

/**
 * Singleton in-memory store for ask-user requests.
 */
class AskUserStore {
  private requests = new Map<string, AskUserRequest>();
  private cleanupInterval: Timer | null = null;
  private readonly CLEANUP_INTERVAL_MS = 60_000; // Check every minute
  private readonly REQUEST_TTL_MS = 300_000; // 5 minutes

  constructor() {
    this.startCleanup();
  }

  /**
   * Create a new ask-user request.
   */
  create(
    requestId: string,
    chatId: string,
    question: string,
    options: string[]
  ): void {
    const request: AskUserRequest = {
      request_id: requestId,
      chat_id: chatId,
      question,
      options,
      status: "pending",
      created_at: new Date().toISOString(),
    };

    this.requests.set(requestId, request);
    console.log(`Created ask-user request: ${requestId} (in-memory)`);
  }

  /**
   * Get a request by ID.
   */
  get(requestId: string): AskUserRequest | null {
    return this.requests.get(requestId) || null;
  }

  /**
   * Get all pending requests for a specific chat.
   */
  getPendingForChat(chatId: number): AskUserRequest[] {
    const chatIdStr = String(chatId);
    const pending: AskUserRequest[] = [];

    for (const request of this.requests.values()) {
      if (request.status === "pending" && request.chat_id === chatIdStr) {
        pending.push(request);
      }
    }

    return pending;
  }

  /**
   * Mark a request as sent (buttons displayed).
   */
  markSent(requestId: string): void {
    const request = this.requests.get(requestId);
    if (request) {
      request.status = "sent";
    }
  }

  /**
   * Delete a request (after user answers).
   */
  delete(requestId: string): void {
    this.requests.delete(requestId);
    console.log(`Deleted ask-user request: ${requestId}`);
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
      console.log(`Cleaned up ${removed} expired ask-user requests`);
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
  getStats(): { total: number; pending: number; sent: number } {
    let pending = 0;
    let sent = 0;

    for (const request of this.requests.values()) {
      if (request.status === "pending") pending++;
      if (request.status === "sent") sent++;
    }

    return {
      total: this.requests.size,
      pending,
      sent,
    };
  }
}

// Export singleton instance
export const askUserStore = new AskUserStore();
