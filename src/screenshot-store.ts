/**
 * In-memory store for screenshot window lists.
 *
 * Stores window lists between /screenshot command and callback selection.
 * Auto-expires after 5 minutes.
 */

import type { Window } from "node-screenshots";

interface ScreenshotRequest {
  windows: Window[];
  timestamp: number;
}

const store = new Map<string, ScreenshotRequest>();
const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a unique request ID.
 */
export function generateRequestId(): string {
  return `ss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Store a window list for later retrieval.
 */
export function storeWindows(requestId: string, windows: Window[]): void {
  // Clean up expired entries
  cleanupExpired();

  store.set(requestId, {
    windows,
    timestamp: Date.now(),
  });
}

/**
 * Get windows for a request ID. Returns null if not found or expired.
 */
export function getWindows(requestId: string): Window[] | null {
  const entry = store.get(requestId);

  if (!entry) {
    return null;
  }

  // Check if expired
  if (Date.now() - entry.timestamp > EXPIRY_MS) {
    store.delete(requestId);
    return null;
  }

  return entry.windows;
}

/**
 * Remove a request from the store.
 */
export function removeRequest(requestId: string): void {
  store.delete(requestId);
}

/**
 * Clean up expired entries.
 */
function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now - entry.timestamp > EXPIRY_MS) {
      store.delete(id);
    }
  }
}
