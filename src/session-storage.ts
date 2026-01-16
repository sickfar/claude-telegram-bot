/**
 * Session storage utilities for Claude Telegram Bot.
 *
 * Uses Claude Code's standard session storage: ~/.claude/projects/<project-path>/
 * Session metadata stored as <session-id>.meta.json alongside SDK's <session-id>.jsonl
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { SessionData } from "./types";
import { getWorkingDir } from "./config";

/**
 * Normalize project path for Claude directory structure.
 * Converts /Users/foo/project to -Users-foo-project
 */
function normalizeProjectPath(workingDir: string): string {
  return workingDir.replace(/\//g, "-");
}

/**
 * Get Claude sessions directory for current project.
 * Returns: ~/.claude/projects/<normalized-path>/
 */
export function getClaudeProjectDir(workingDir?: string): string {
  const cwd = workingDir || getWorkingDir();
  const normalized = normalizeProjectPath(cwd);
  return join(homedir(), ".claude", "projects", normalized);
}

/**
 * Ensure Claude project directory exists.
 */
export function ensureSessionsDirectory(workingDir?: string): void {
  const dir = getClaudeProjectDir(workingDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Created Claude project directory: ${dir}`);
  }
}

/**
 * Extract project name from working directory path.
 */
export function getProjectName(workingDir: string): string {
  const parts = workingDir.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : "unknown";
}

/**
 * Format timestamp as relative time (e.g., "2h ago", "3d ago").
 */
export function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ago`;
  } else if (hours > 0) {
    return `${hours}h ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return "just now";
  }
}

/**
 * Get short ID (first 8 characters) from full session ID.
 */
function getShortId(fullId: string): string {
  return fullId.slice(0, 8);
}

/**
 * Claude SDK session index entry.
 */
interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch?: string;
  projectPath: string;
  isSidechain: boolean;
}

interface SessionIndex {
  version: number;
  entries: SessionIndexEntry[];
}

/**
 * Load all available sessions from Claude project directory.
 * Uses sessions-index.json maintained by Claude SDK.
 */
export async function loadSessionList(workingDir?: string): Promise<SessionData[]> {
  const dir = getClaudeProjectDir(workingDir);
  ensureSessionsDirectory(workingDir);

  const indexPath = join(dir, "sessions-index.json");

  // Try to load from index first
  let sessions: SessionData[] = [];

  if (existsSync(indexPath)) {
    try {
      const text = readFileSync(indexPath, "utf-8");
      const index = JSON.parse(text) as SessionIndex;

      for (const entry of index.entries) {
        // Check if we have our own metadata
        const metaPath = join(dir, `${entry.sessionId}.meta.json`);
        let sessionData: SessionData;

        if (existsSync(metaPath)) {
          // Use our metadata if available
          try {
            const metaText = readFileSync(metaPath, "utf-8");
            sessionData = JSON.parse(metaText) as SessionData;
          } catch (error) {
            console.warn(`Failed to load metadata for ${entry.sessionId}: ${error}`);
            // Fall through to use index data
            sessionData = createSessionDataFromIndex(entry, workingDir);
          }
        } else {
          // Create SessionData from index entry
          sessionData = createSessionDataFromIndex(entry, workingDir);
        }

        sessions.push(sessionData);
      }
    } catch (error) {
      console.warn(`Failed to load sessions-index.json: ${error}`);
    }
  }

  // Fallback: if index is empty or missing, scan .jsonl files directly
  if (sessions.length === 0) {
    const files = readdirSync(dir);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      const sessionId = file.replace(".jsonl", "");
      const metaPath = join(dir, `${sessionId}.meta.json`);
      const jsonlPath = join(dir, file);

      let sessionData: SessionData;

      if (existsSync(metaPath)) {
        // Use our metadata if available
        try {
          const metaText = readFileSync(metaPath, "utf-8");
          sessionData = JSON.parse(metaText) as SessionData;
        } catch (error) {
          console.warn(`Failed to load metadata for ${sessionId}: ${error}`);
          continue;
        }
      } else {
        // Create basic session data from file stats
        const stat = statSync(jsonlPath);
        const cwd = workingDir || getWorkingDir();

        sessionData = {
          session_id: sessionId,
          saved_at: stat.mtime.toISOString(),
          working_dir: cwd,
          last_activity: stat.mtime.toISOString(),
          project_name: getProjectName(cwd),
          last_message_preview: `Session ${sessionId.slice(0, 8)}`,
        };
      }

      sessions.push(sessionData);
    }
  }

  // Sort by modified time (newest first)
  sessions.sort((a, b) => {
    const aTime = a.last_activity || a.saved_at;
    const bTime = b.last_activity || b.saved_at;
    return new Date(bTime).getTime() - new Date(aTime).getTime();
  });

  // Return only last 5 sessions
  return sessions.slice(0, 5);
}

/**
 * Create SessionData from Claude SDK index entry.
 */
function createSessionDataFromIndex(entry: SessionIndexEntry, workingDir?: string): SessionData {
  // Use projectPath from index entry (where session was actually created)
  const sessionWorkingDir = entry.projectPath;

  return {
    session_id: entry.sessionId,
    saved_at: entry.created,
    working_dir: sessionWorkingDir,
    last_activity: entry.modified,
    project_name: getProjectName(sessionWorkingDir),
    last_message_preview: entry.firstPrompt.slice(0, 50),
  };
}

/**
 * Load session by short ID (first 8 characters).
 * Returns: [success, message, sessionData?]
 */
export async function loadSessionByShortId(
  shortId: string,
  workingDir?: string
): Promise<[boolean, string, SessionData?]> {
  const sessions = await loadSessionList(workingDir);
  const session = sessions.find(s => s.session_id.startsWith(shortId));

  if (!session) {
    return [false, "Session not found", undefined];
  }

  return [true, "Session loaded", session];
}

/**
 * Get session metadata file path.
 */
export function getSessionMetaFilePath(sessionId: string, workingDir?: string): string {
  const dir = getClaudeProjectDir(workingDir);
  return join(dir, `${sessionId}.meta.json`);
}

/**
 * Save session metadata to Claude project directory.
 */
export async function saveSessionToDirectory(data: SessionData, workingDir?: string): Promise<void> {
  ensureSessionsDirectory(workingDir);

  const filePath = getSessionMetaFilePath(data.session_id, workingDir);

  try {
    await Bun.write(filePath, JSON.stringify(data, null, 2));
    console.log(`Session metadata saved: ${filePath}`);

    // NOTE: Auto-cleanup disabled to prevent accidental session deletion
    // User should manually delete sessions via CLI or /new command
  } catch (error) {
    console.warn(`Failed to save session metadata: ${error}`);
  }
}

// Cleanup function removed - user never requested automatic session deletion
// Sessions should be managed manually via Claude CLI or file system
