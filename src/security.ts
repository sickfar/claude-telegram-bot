/**
 * Security module for Claude Telegram Bot.
 *
 * Rate limiting, path validation, command safety.
 */

import { resolve, normalize } from "path";
import { realpathSync, existsSync } from "fs";
import type { RateLimitBucket } from "./types";
import {
  getAllowedPaths,
  BLOCKED_PATTERNS,
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_REQUESTS,
  RATE_LIMIT_WINDOW,
  TEMP_PATHS,
} from "./config";

// ============== Rate Limiter ==============

class RateLimiter {
  private buckets = new Map<number, RateLimitBucket>();
  private maxTokens: number;
  private refillRate: number; // tokens per second

  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
  }

  check(userId: number): [allowed: boolean, retryAfter?: number] {
    if (!RATE_LIMIT_ENABLED) {
      return [true];
    }

    const now = Date.now();
    let bucket = this.buckets.get(userId);

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastUpdate: now };
      this.buckets.set(userId, bucket);
    }

    // Refill tokens based on time elapsed
    const elapsed = (now - bucket.lastUpdate) / 1000;
    bucket.tokens = Math.min(
      this.maxTokens,
      bucket.tokens + elapsed * this.refillRate
    );
    bucket.lastUpdate = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return [true];
    }

    // Calculate time until next token
    const retryAfter = (1 - bucket.tokens) / this.refillRate;
    return [false, retryAfter];
  }

  getStatus(userId: number): {
    tokens: number;
    max: number;
    refillRate: number;
  } {
    const bucket = this.buckets.get(userId);
    return {
      tokens: bucket?.tokens ?? this.maxTokens,
      max: this.maxTokens,
      refillRate: this.refillRate,
    };
  }
}

// Lazy-initialized to avoid circular dependency issues
let _rateLimiter: RateLimiter | null = null;

function getRateLimiter(): RateLimiter {
  if (!_rateLimiter) {
    _rateLimiter = new RateLimiter(
      RATE_LIMIT_REQUESTS,
      RATE_LIMIT_REQUESTS / RATE_LIMIT_WINDOW
    );
  }
  return _rateLimiter;
}

export const rateLimiter = {
  check: (userId: number) => getRateLimiter().check(userId),
  getStatus: (userId: number) => getRateLimiter().getStatus(userId),
};

// ============== Path Validation ==============

export function isPathAllowed(path: string): boolean {
  try {
    // Expand ~ and resolve to absolute path
    const expanded = path.replace(/^~/, process.env.HOME || "");
    const normalized = normalize(expanded);

    // Try to resolve symlinks (may fail if path doesn't exist yet)
    let resolved: string;
    try {
      resolved = realpathSync(normalized);
    } catch {
      resolved = resolve(normalized);
    }

    // Always allow temp paths (for bot's own files)
    for (const tempPath of TEMP_PATHS) {
      if (resolved.startsWith(tempPath)) {
        return true;
      }
    }

    // Check against allowed paths using proper containment
    for (const allowed of getAllowedPaths()) {
      const allowedResolved = resolve(allowed);
      if (
        resolved === allowedResolved ||
        resolved.startsWith(allowedResolved + "/")
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Validate a relative project path and ensure it's within PROJECTS_ROOT.
 * Returns [valid, absolutePath, error].
 */
export function validateProjectPath(
  relativePath: string,
  projectsRoot: string
): [valid: boolean, absolutePath: string | null, error: string] {
  try {
    // 1. Reject absolute paths
    if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
      return [
        false,
        null,
        "Absolute paths not allowed. Use relative paths within projects root.",
      ];
    }

    // 2. Join with PROJECTS_ROOT
    const joined = resolve(projectsRoot, relativePath);

    // 3. Resolve symlinks (if path exists)
    let resolved: string;
    try {
      resolved = realpathSync(joined);
    } catch {
      // Path doesn't exist yet, use normalized path
      resolved = normalize(joined);
    }

    // 4. Verify resolved path is within PROJECTS_ROOT
    const projectsRootResolved = realpathSync(projectsRoot);
    if (
      resolved !== projectsRootResolved &&
      !resolved.startsWith(projectsRootResolved + "/")
    ) {
      return [
        false,
        null,
        `Path escapes projects root. Resolved to: ${resolved}`,
      ];
    }

    // 5. Check directory exists
    if (!existsSync(resolved)) {
      return [false, null, `Directory does not exist: ${resolved}`];
    }

    return [true, resolved, ""];
  } catch (error) {
    return [false, null, `Validation error: ${error}`];
  }
}

// ============== Command Safety ==============

export function checkCommandSafety(
  command: string
): [safe: boolean, reason: string] {
  const lowerCommand = command.toLowerCase();

  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (lowerCommand.includes(pattern.toLowerCase())) {
      return [false, `Blocked pattern: ${pattern}`];
    }
  }

  // Special handling for rm commands - validate paths
  if (lowerCommand.includes("rm ")) {
    try {
      // Simple parsing: extract arguments after rm
      const rmMatch = command.match(/rm\s+(.+)/i);
      if (rmMatch) {
        const args = rmMatch[1]!.split(/\s+/);
        for (const arg of args) {
          // Skip flags
          if (arg.startsWith("-") || arg.length <= 1) continue;

          // Check if path is allowed
          if (!isPathAllowed(arg)) {
            return [false, `rm target outside allowed paths: ${arg}`];
          }
        }
      }
    } catch {
      // If parsing fails, be cautious
      return [false, "Could not parse rm command for safety check"];
    }
  }

  return [true, ""];
}

// ============== Authorization ==============

export function isAuthorized(
  userId: number | undefined,
  allowedUsers: number[]
): boolean {
  if (!userId) return false;
  if (allowedUsers.length === 0) return false;
  return allowedUsers.includes(userId);
}
