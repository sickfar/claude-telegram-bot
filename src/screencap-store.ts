/**
 * In-memory store for screencap requests and active recordings.
 *
 * Stores window lists between /screencap command and callback selection.
 * Manages active recording state for async recording operations.
 */

import type { Window } from "node-screenshots";
import type { Subprocess } from "bun";

interface ScreencapRequest {
  requestId: string;
  windows: Window[];
  duration: number; // Duration in seconds
  timestamp: number;
}

interface ActiveRecording {
  chatId: number;
  requestId: string;
  filePath: string;
  duration: number;
  targetType: "screen" | "window";
  windowInfo?: { x: number; y: number; width: number; height: number };
  startTime: number;
  process: Subprocess;
  statusMessageId?: number;
}

const requestStore = new Map<string, ScreencapRequest>();
const recordingStore = new Map<number, ActiveRecording>();
const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a unique request ID.
 */
export function generateRequestId(): string {
  return `sc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Store a screencap request for later retrieval.
 */
export function storeRequest(windows: Window[], duration: number): string {
  cleanupExpiredRequests();

  const requestId = generateRequestId();
  requestStore.set(requestId, {
    requestId,
    windows,
    duration,
    timestamp: Date.now(),
  });

  return requestId;
}

/**
 * Get a screencap request by ID. Returns null if not found or expired.
 */
export function getRequest(requestId: string): ScreencapRequest | null {
  const entry = requestStore.get(requestId);

  if (!entry) {
    return null;
  }

  // Check if expired
  if (Date.now() - entry.timestamp > EXPIRY_MS) {
    requestStore.delete(requestId);
    return null;
  }

  return entry;
}

/**
 * Remove a request from the store.
 */
export function removeRequest(requestId: string): void {
  requestStore.delete(requestId);
}

/**
 * Store an active recording.
 */
export function storeRecording(recording: ActiveRecording): void {
  recordingStore.set(recording.chatId, recording);
}

/**
 * Get an active recording by chat ID.
 */
export function getRecording(chatId: number): ActiveRecording | null {
  return recordingStore.get(chatId) || null;
}

/**
 * Remove a recording from the store.
 */
export function removeRecording(chatId: number): void {
  recordingStore.delete(chatId);
}

/**
 * Check if a recording is currently active for a chat.
 */
export function isRecordingActive(chatId: number): boolean {
  return recordingStore.has(chatId);
}

/**
 * Clean up expired request entries.
 */
function cleanupExpiredRequests(): void {
  const now = Date.now();
  for (const [id, entry] of requestStore) {
    if (now - entry.timestamp > EXPIRY_MS) {
      requestStore.delete(id);
    }
  }
}
