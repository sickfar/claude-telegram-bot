/**
 * Storage migration orchestrator.
 *
 * Migrates bot storage from /tmp to ~/.sickfar/ for persistence.
 */

import { existsSync, mkdirSync } from "fs";
import { copyFile } from "fs/promises";
import { CONFIG_DIR, AUDIT_LOG_PATH } from "./config";

/**
 * Run all migrations on bot startup.
 */
export async function runMigrations(): Promise<void> {
  try {
    // Phase 1: Ensure directory structure
    ensureDirectoryStructure();

    // Phase 2: Migrate audit log from /tmp
    await migrateAuditLog();

    // Note: /tmp cleanup removed - MCP servers are now in-process and don't use /tmp files
  } catch (error) {
    console.error("Storage initialization failed:", error);
    // Don't throw - allow bot to start even if migration fails
  }
}

/**
 * Ensure ~/.sickfar directory structure exists.
 * NOTE: Sessions are now stored in ~/.claude/projects/<project-path>/ (Claude Code standard)
 */
function ensureDirectoryStructure(): void {
  const dirs = [
    CONFIG_DIR,
    `${CONFIG_DIR}/logs`,
    `${CONFIG_DIR}/plans`,
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`  Created directory: ${dir}`);
    }
  }
}

/**
 * Migrate audit log from /tmp to ~/.sickfar/logs/
 */
async function migrateAuditLog(): Promise<void> {
  const oldPath = "/tmp/claude-telegram-audit.log";
  const newPath = AUDIT_LOG_PATH;

  if (!existsSync(oldPath)) {
    console.log("  No old audit log to migrate");
    return;
  }

  // Only migrate if destination doesn't exist (don't overwrite)
  if (existsSync(newPath)) {
    console.log("  Audit log already exists at new location");
    return;
  }

  try {
    await copyFile(oldPath, newPath);
    console.log(`  Migrated audit log: ${oldPath} → ${newPath}`);
  } catch (error) {
    console.warn("  Failed to migrate audit log:", error);
  }
}

