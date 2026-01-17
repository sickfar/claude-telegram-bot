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
  status: "pending" | "sent" | "answered";
  created_at: string;
  // Promise-based response mechanism
  resolve?: (answer: string) => void;
  reject?: (error: Error) => void;
}

/**
 * Singleton in-memory store for ask-user requests.
 */
class AskUserStore {
  private requests = new Map<string, AskUserRequest>();
  private onRequestCreatedCallbacks: Array<(request: AskUserRequest) => void> = [];

  constructor() {
    // No automatic cleanup - manual cleanup on new session
  }

  /**
   * Register a callback to be notified when a new request is created.
   * Used to immediately display buttons to the user.
   */
  onRequestCreated(callback: (request: AskUserRequest) => void): void {
    this.onRequestCreatedCallbacks.push(callback);
  }

  /**
   * Create a new ask-user request and return a promise that resolves when user answers.
   */
  createWithPromise(
    requestId: string,
    chatId: string,
    question: string,
    options: string[]
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const request: AskUserRequest = {
        request_id: requestId,
        chat_id: chatId,
        question,
        options,
        status: "pending",
        created_at: new Date().toISOString(),
        resolve,
        reject,
      };

      this.requests.set(requestId, request);
      console.log(`Created ask-user request: ${requestId} (in-memory, promise-based)`);

      // Notify listeners to display buttons immediately (before waiting)
      for (const callback of this.onRequestCreatedCallbacks) {
        try {
          callback(request);
        } catch (error) {
          console.error("Error in onRequestCreated callback:", error);
        }
      }

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.requests.has(requestId)) {
          this.delete(requestId);
          reject(new Error("Ask-user request timed out after 5 minutes"));
        }
      }, 5 * 60 * 1000);
    });
  }


  /**
   * Get a request by ID.
   */
  get(requestId: string): AskUserRequest | null {
    return this.requests.get(requestId) || null;
  }



  /**
   * Answer a request (resolves the promise if using promise-based flow).
   */
  answer(requestId: string, selectedOption: string): void {
    const request = this.requests.get(requestId);
    if (!request) {
      console.warn(`Cannot answer - request ${requestId} not found`);
      return;
    }

    // If promise-based, resolve it
    if (request.resolve) {
      request.resolve(selectedOption);
      console.log(`Resolved ask-user request ${requestId} with answer: "${selectedOption}"`);
    }

    // Update status and clean up
    request.status = "answered";
    this.delete(requestId);
  }

  /**
   * Delete a request (after user answers).
   */
  delete(requestId: string): void {
    this.requests.delete(requestId);
    console.log(`Deleted ask-user request: ${requestId}`);
  }

  /**
   * Clear all pending requests.
   * Called when a new session starts.
   */
  clearAll(): void {
    const count = this.requests.size;
    this.requests.clear();

    if (count > 0) {
      console.log(`Cleared ${count} pending ask-user requests`);
    }
  }

}

// Export singleton instance
export const askUserStore = new AskUserStore();
