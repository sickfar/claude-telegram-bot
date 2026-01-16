/**
 * Permission request storage and polling.
 *
 * Uses in-memory storage with automatic cleanup. Delegates to permissionStore singleton.
 */

import { randomUUID } from "crypto";
import { permissionStore } from "./permission-store";
import type {
  PermissionRequest,
  PermissionResult,
} from "./permission-store";

// Re-export types from permission store
export type { PermissionRequest, PermissionResult };

/**
 * Create a new permission request in the store.
 * Returns the request_id.
 */
export function createPermissionRequest(
  chatId: number,
  toolName: string,
  toolInput: string,
  formattedRequest: string
): string {
  const requestId = randomUUID();
  permissionStore.create(requestId, chatId, toolName, toolInput, formattedRequest);
  return requestId;
}

/**
 * Get a permission request by ID from the store.
 */
export async function getPermissionRequest(
  requestId: string
): Promise<PermissionRequest | null> {
  return permissionStore.get(requestId);
}

/**
 * Update a permission request status and optional response in the store.
 */
export async function updatePermissionRequest(
  requestId: string,
  status: PermissionRequest["status"],
  response?: string
): Promise<void> {
  permissionStore.update(requestId, status, response);
}

/**
 * Wait for permission request result (event-based, no timeout).
 * Creates a Promise that will be resolved by the callback handler when user clicks Allow/Deny.
 */
export async function waitForPermission(
  requestId: string
): Promise<PermissionResult> {
  return permissionStore.createPromise(requestId);
}

/**
 * Resolve a pending permission request (called from callback handler).
 */
export function resolvePermission(
  requestId: string,
  approved: boolean,
  message?: string
): void {
  permissionStore.resolve(requestId, approved, message);
}
