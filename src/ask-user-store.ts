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
  private displayFn?: (question: string, options: string[], requestId: string) => Promise<void>;

  constructor() {
    // No automatic cleanup - manual cleanup on new session
  }

  /**
   * Set the function to display ask-user UI.
   * This function will be called when a request is created.
   */
  setDisplayFn(fn: (question: string, options: string[], requestId: string) => Promise<void>): void {
    this.displayFn = fn;
  }

  /**
   * Create a new ask-user request and return a promise that resolves when user answers.
   * Always adds "Other" option for custom text input.
   */
  async createWithPromise(
    requestId: string,
    chatId: string,
    question: string,
    options: string[]
  ): Promise<string> {
    // Always add "Custom answer..." option for custom input
    const optionsWithOther = [...options, "Custom answer..."];

    const request: AskUserRequest = {
      request_id: requestId,
      chat_id: chatId,
      question,
      options: optionsWithOther,
      status: "pending",
      created_at: new Date().toISOString(),
      resolve: null as any, // Will be set below
      reject: null as any,
    };

    this.requests.set(requestId, request);
    console.log(`Created ask-user request: ${requestId} (in-memory, promise-based)`);

    // Display the UI immediately and AWAIT it (critical!)
    if (this.displayFn) {
      console.log(`[ASK-USER] Displaying UI for ${requestId}...`);
      try {
        await this.displayFn(question, optionsWithOther, requestId);
        console.log(`[ASK-USER] UI displayed successfully`);
      } catch (error) {
        console.error("Error displaying ask-user UI:", error);
        this.requests.delete(requestId);
        throw error;
      }
    } else {
      console.warn(`[ASK-USER] No display function set - UI will not be shown!`);
      this.requests.delete(requestId);
      throw new Error("No display function configured for ask-user");
    }

    // Now wait for user response
    return new Promise((resolve, reject) => {
      const req = this.requests.get(requestId);
      if (!req) {
        reject(new Error("Request was unexpectedly deleted"));
        return;
      }

      req.resolve = resolve;
      req.reject = reject;

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
