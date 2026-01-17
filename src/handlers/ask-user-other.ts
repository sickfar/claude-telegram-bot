/**
 * Handler for "Other" option in ask-user (custom text input).
 */

import { askUserStore } from "../ask-user-store";

// State to track pending custom input
let pendingCustomInput: { requestId: string; chatId: number } | null = null;

/**
 * Check if we're waiting for custom input from a specific chat (used for sequentialize bypass).
 */
export function isPendingCustomInput(chatId: number): boolean {
  return pendingCustomInput !== null && pendingCustomInput.chatId === chatId;
}

/**
 * Set pending custom input state (called when "Other" button is clicked).
 */
export function setPendingCustomInput(requestId: string, chatId: number): void {
  console.log(`[ASK-USER-OTHER] Setting pending custom input: requestId=${requestId}, chatId=${chatId}`);
  pendingCustomInput = { requestId, chatId };
}

/**
 * Check if we're waiting for custom input and handle it.
 * Called from text handler.
 */
export function handleCustomInput(chatId: number, text: string): boolean {
  console.log(`[ASK-USER-OTHER] handleCustomInput called: chatId=${chatId}, pendingCustomInput=${JSON.stringify(pendingCustomInput)}`);

  if (!pendingCustomInput || pendingCustomInput.chatId !== chatId) {
    console.log(`[ASK-USER-OTHER] Not waiting for custom input from this chat`);
    return false; // Not waiting for custom input
  }

  const { requestId } = pendingCustomInput;
  pendingCustomInput = null; // Clear state

  console.log(`[ASK-USER-OTHER] Received custom input for ${requestId}: ${text.substring(0, 50)}...`);

  // Resolve the ask-user request with the custom text
  askUserStore.answer(requestId, text);

  return true; // Handled
}
