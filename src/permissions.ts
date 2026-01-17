/**
 * Permission request storage and polling.
 *
 * Uses in-memory storage with automatic cleanup. Delegates to permissionStore singleton.
 * Also handles persistent project permissions in .claude/settings.local.json.
 */

import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, relative, isAbsolute } from "path";
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

// ============================================================================
// Persistent Project Permissions (Claude Code compatible)
// ============================================================================

interface SettingsFile {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
}

/**
 * Load project permissions from .claude/settings.local.json.
 * Returns array of allow patterns like ["Bash(git:*)", "Read(src/**)"].
 */
export function loadProjectPermissions(workingDir: string): string[] {
  const settingsPath = join(workingDir, ".claude", "settings.local.json");

  if (!existsSync(settingsPath)) {
    return [];
  }

  try {
    const content = readFileSync(settingsPath, "utf-8");
    const settings: SettingsFile = JSON.parse(content);
    return settings.permissions?.allow || [];
  } catch (error) {
    console.warn(`Failed to load permissions from ${settingsPath}:`, error);
    return [];
  }
}

/**
 * Save a permission pattern to .claude/settings.local.json.
 * Creates the file and directory if they don't exist.
 */
export function saveProjectPermission(
  workingDir: string,
  pattern: string
): void {
  const claudeDir = join(workingDir, ".claude");
  const settingsPath = join(claudeDir, "settings.local.json");

  // Ensure .claude directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Load existing settings or create new
  let settings: SettingsFile = {};
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(content);
    } catch {
      // Start fresh if file is corrupted
    }
  }

  // Ensure permissions structure exists
  if (!settings.permissions) {
    settings.permissions = {};
  }
  if (!settings.permissions.allow) {
    settings.permissions.allow = [];
  }

  // Add pattern if not already present
  if (!settings.permissions.allow.includes(pattern)) {
    settings.permissions.allow.push(pattern);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log(`[PERMISSION] Saved pattern to ${settingsPath}: ${pattern}`);
  }
}

/**
 * Extract up to 2 non-flag words from a Bash command.
 * e.g., "cargo build --debug &2>1" -> "cargo build"
 *       "git status" -> "git status"
 *       "ls -la /tmp" -> "ls"
 */
function extractBashCommandPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/);
  const words: string[] = [];

  for (const token of tokens) {
    // Skip flags (starting with -), redirections, and shell operators
    if (
      token.startsWith("-") ||
      token.startsWith("&") ||
      token.startsWith("|") ||
      token.startsWith(">") ||
      token.startsWith("<") ||
      token.includes(">&") ||
      token.includes("2>")
    ) {
      continue;
    }
    words.push(token);
    if (words.length >= 2) break;
  }

  return words.join(" ");
}

/**
 * Generate a permission pattern from tool name and input.
 * Patterns match Claude Code format: "Bash(git:*)", "Read(src/**)", etc.
 */
export function generatePermissionPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
  workingDir: string
): string {
  if (toolName === "Bash") {
    const command = String(toolInput.command || "");
    // Extract up to 2 non-flag words
    const prefix = extractBashCommandPrefix(command);
    if (prefix) {
      return `Bash(${prefix}:*)`;
    }
    // Fallback to first token if extraction fails
    const firstToken = command.trim().split(/\s+/)[0] || "unknown";
    return `Bash(${firstToken}:*)`;
  }

  if (["Read", "Write", "Edit"].includes(toolName)) {
    const filePath = String(toolInput.file_path || "");
    if (filePath) {
      // Try to make path relative to working dir
      let relativePath = filePath;
      if (isAbsolute(filePath) && filePath.startsWith(workingDir)) {
        relativePath = relative(workingDir, filePath);
      }
      // Use directory pattern with **
      const dir = dirname(relativePath);
      if (dir && dir !== ".") {
        return `${toolName}(${dir}/**)`;
      }
      // Root level file - use exact name
      return `${toolName}(${relativePath})`;
    }
  }

  // For other tools, just allow the tool entirely
  return toolName;
}

/**
 * Get a human-readable description of what "Always Allow" will permit.
 * For Bash: "Always allow `cargo build`?"
 */
export function getAlwaysAllowDescription(
  toolName: string,
  toolInput: Record<string, unknown>,
  workingDir: string
): string {
  if (toolName === "Bash") {
    const command = String(toolInput.command || "");
    const prefix = extractBashCommandPrefix(command);
    return `Always allow \`${prefix}\`?`;
  }

  if (["Read", "Write", "Edit"].includes(toolName)) {
    const filePath = String(toolInput.file_path || "");
    let relativePath = filePath;
    if (isAbsolute(filePath) && filePath.startsWith(workingDir)) {
      relativePath = relative(workingDir, filePath);
    }
    const dir = dirname(relativePath);
    if (dir && dir !== ".") {
      return `Always allow ${toolName} in \`${dir}/\`?`;
    }
    return `Always allow ${toolName} \`${relativePath}\`?`;
  }

  return `Always allow ${toolName}?`;
}

/**
 * Check if a tool call matches any permission pattern.
 */
export function matchesPermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  permissions: string[],
  workingDir: string
): boolean {
  for (const pattern of permissions) {
    if (matchesSinglePermission(toolName, toolInput, pattern, workingDir)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a tool call matches a single permission pattern.
 * Pattern formats:
 * - "Bash(git:*)" - matches Bash commands starting with "git"
 * - "Read(src/**)" - matches Read for files under src/
 * - "Write" - matches all Write operations
 */
function matchesSinglePermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  pattern: string,
  workingDir: string
): boolean {
  // Parse pattern: "ToolName" or "ToolName(args)"
  const match = pattern.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) return false;

  const [, patternTool, patternArgs] = match;

  // Tool name must match
  if (patternTool !== toolName) return false;

  // If no args in pattern, it matches all uses of this tool
  if (!patternArgs) return true;

  // Match based on tool type
  if (toolName === "Bash") {
    const command = String(toolInput.command || "");
    return matchBashPattern(command, patternArgs);
  }

  if (["Read", "Write", "Edit"].includes(toolName)) {
    const filePath = String(toolInput.file_path || "");
    return matchFilePattern(filePath, patternArgs, workingDir);
  }

  // For other tools, pattern args must match exactly (or be *)
  return patternArgs === "*";
}

/**
 * Match a Bash command against a pattern like "git:*" or "npm test:*".
 */
function matchBashPattern(command: string, pattern: string): boolean {
  // Pattern format: "prefix:*" where * is wildcard
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2); // Remove ":*"
    return command.trim().startsWith(prefix);
  }
  // Exact match
  return command.trim() === pattern;
}

/**
 * Match a file path against a pattern like "src/**" or "*.ts".
 */
function matchFilePattern(
  filePath: string,
  pattern: string,
  workingDir: string
): boolean {
  // Make file path relative to working dir for comparison
  let relativePath = filePath;
  if (isAbsolute(filePath) && filePath.startsWith(workingDir)) {
    relativePath = relative(workingDir, filePath);
  }

  // Handle ** (recursive) patterns
  if (pattern.endsWith("/**")) {
    const dir = pattern.slice(0, -3);
    return relativePath.startsWith(dir + "/") || relativePath === dir;
  }

  // Handle * (single level) patterns
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, "[^/]*").replace(/\//g, "\\/") + "$"
    );
    return regex.test(relativePath);
  }

  // Exact match
  return relativePath === pattern || filePath === pattern;
}
