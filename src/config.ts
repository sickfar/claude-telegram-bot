/**
 * Configuration for Claude Telegram Bot.
 *
 * All environment variables, paths, constants, and safety settings.
 */

import { homedir } from "os";
import { resolve, dirname } from "path";
import type { McpServerConfig } from "./types";

// ============== Environment Setup ==============

const HOME = homedir();

// Config directory (must be defined early for loadPersistentConfig)
export const CONFIG_DIR = `${HOME}/.sickfar`;
export const PERSISTENT_CONFIG_FILE = `${CONFIG_DIR}/settings.json`;

// Model configuration
const MODEL_IDS = {
  opus: "claude-opus-4-5",
  sonnet: "claude-sonnet-4-5",
  haiku: "claude-haiku-4-5",
} as const;

export type ModelName = keyof typeof MODEL_IDS;

const MODEL_DEFAULT = (process.env.MODEL_DEFAULT as ModelName) || "sonnet";
const ALLOW_TELEGRAM_MODEL_MODE = process.env.ALLOW_TELEGRAM_MODEL_MODE !== "false";

let currentModel: ModelName = MODEL_DEFAULT;

// Ensure necessary paths are available for Claude's bash commands
// LaunchAgents don't inherit the full shell environment
const EXTRA_PATHS = [
  `${HOME}/.local/bin`,
  `${HOME}/.bun/bin`,
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
];

const currentPath = process.env.PATH || "";
const pathParts = currentPath.split(":");
for (const extraPath of EXTRA_PATHS) {
  if (!pathParts.includes(extraPath)) {
    pathParts.unshift(extraPath);
  }
}
process.env.PATH = pathParts.join(":");

// ============== Core Configuration ==============

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USERS: number[] = (
  process.env.TELEGRAM_ALLOWED_USERS || ""
)
  .split(",")
  .filter((x) => x.trim())
  .map((x) => parseInt(x.trim(), 10))
  .filter((x) => !isNaN(x));

// Projects root directory (parent of all project directories)
export const PROJECTS_ROOT = process.env.PROJECTS_ROOT || HOME;

// Runtime state: current working directory
let currentWorkingDir: string = PROJECTS_ROOT;

// Get the current working directory
export function getWorkingDir(): string {
  return currentWorkingDir;
}

// Set the working directory (must be within PROJECTS_ROOT)
export function setWorkingDir(path: string): void {
  currentWorkingDir = path;
  rebuildAllowedPaths();
  savePersistentConfig();
}

// Reset working directory to PROJECTS_ROOT
export function resetWorkingDir(): void {
  currentWorkingDir = PROJECTS_ROOT;
  rebuildAllowedPaths();
  savePersistentConfig();
}

// Save persistent configuration
function savePersistentConfig(): void {
  try {
    // Ensure config directory exists
    const fs = require("fs");
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    const config = {
      working_dir: currentWorkingDir,
      model: currentModel,
      saved_at: new Date().toISOString(),
    };
    Bun.write(PERSISTENT_CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.warn(`Failed to save persistent config: ${error}`);
  }
}

// Load persistent configuration
function loadPersistentConfig(): void {
  try {
    const fs = require("fs");

    // Check if config file exists
    if (!fs.existsSync(PERSISTENT_CONFIG_FILE)) {
      console.log(`No persistent config file found at ${PERSISTENT_CONFIG_FILE}`);
      return;
    }

    const text = fs.readFileSync(PERSISTENT_CONFIG_FILE, "utf-8");
    const config = JSON.parse(text);
    console.log(`Loaded config from ${PERSISTENT_CONFIG_FILE}:`, config);

    if (config.working_dir && typeof config.working_dir === "string") {
      // Validate that the saved path still exists and is within PROJECTS_ROOT
      const savedPath = config.working_dir;
      console.log(`Validating saved path: ${savedPath} (PROJECTS_ROOT: ${PROJECTS_ROOT})`);

      // Check if path is within PROJECTS_ROOT
      if (savedPath.startsWith(PROJECTS_ROOT)) {
        // Check if directory exists
        try {
          const stat = fs.statSync(savedPath);
          if (stat.isDirectory()) {
            currentWorkingDir = savedPath;
            console.log(`✓ Restored working directory: ${savedPath}`);

            // Restore model if present
            if (config.model && typeof config.model === "string") {
              if (config.model in MODEL_IDS) {
                currentModel = config.model as ModelName;
                console.log(`✓ Restored model: ${currentModel}`);
              } else {
                console.log(`✗ Invalid model in config: ${config.model}, using default`);
              }
            }

            return;
          }
        } catch (err) {
          // Directory doesn't exist anymore, use default
          console.log(`✗ Saved directory no longer exists: ${savedPath}, using default (error: ${err})`);
        }
      } else {
        console.log(`✗ Saved path outside PROJECTS_ROOT: ${savedPath}, using default (PROJECTS_ROOT: ${PROJECTS_ROOT})`);
      }
    } else {
      console.log(`✗ No valid working_dir in config`);
    }
  } catch (error) {
    console.warn(`Failed to load persistent config: ${error}`);
  }
}

// Load persistent config on startup (before rebuilding allowed paths)
loadPersistentConfig();

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ============== Claude CLI Path ==============

// Auto-detect from PATH, or use environment override
function findClaudeCli(): string {
  const envPath = process.env.CLAUDE_CLI_PATH;
  if (envPath) return envPath;

  // Try to find claude in PATH using Bun.which
  const whichResult = Bun.which("claude");
  if (whichResult) return whichResult;

  // Final fallback
  return "/usr/local/bin/claude";
}

export const CLAUDE_CLI_PATH = findClaudeCli();

// ============== MCP Configuration ==============

// MCP servers loaded from mcp-config.ts
let MCP_SERVERS: Record<string, McpServerConfig> = {};

try {
  // Dynamic import of MCP config
  const mcpConfigPath = resolve(dirname(import.meta.dir), "mcp-config.ts");
  const mcpModule = await import(mcpConfigPath).catch(() => null);
  if (mcpModule?.MCP_SERVERS) {
    MCP_SERVERS = mcpModule.MCP_SERVERS;
    console.log(
      `Loaded ${Object.keys(MCP_SERVERS).length} MCP servers from mcp-config.ts`
    );
  }
} catch {
  console.log("No mcp-config.ts found - running without MCPs");
}

export { MCP_SERVERS };

// ============== Security Configuration ==============

// Allowed directories for file operations (runtime variable)
let _allowedPaths: string[] = [];

// Build default allowed paths based on current working directory
function buildDefaultAllowedPaths(): string[] {
  return [
    currentWorkingDir,
    `${HOME}/Documents`,
    `${HOME}/Downloads`,
    `${HOME}/Desktop`,
    `${HOME}/.sickfar`, // Bot data (plans, settings, logs)
  ];
}

// Rebuild allowed paths when working directory changes
function rebuildAllowedPaths(): void {
  const allowedPathsStr = process.env.ALLOWED_PATHS || "";
  _allowedPaths = allowedPathsStr
    ? allowedPathsStr
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : buildDefaultAllowedPaths();
}

// Get the current allowed paths
export function getAllowedPaths(): string[] {
  return _allowedPaths;
}

// Initialize allowed paths
rebuildAllowedPaths();

// Build safety prompt dynamically from current allowed paths
function buildSafetyPrompt(allowedPaths: string[]): string {
  const pathsList = allowedPaths
    .map((p) => `   - ${p} (and subdirectories)`)
    .join("\n");

  return `
TELEGRAM BOT CONTEXT:

You are accessed via Telegram. Respond DIRECTLY to what the user is asking.

- Take user messages literally and respond to what they're asking
- If a message seems like a command (e.g., "git status", "run tests"), interpret it as a request to execute that command
- If a message is ambiguous, ask for clarification rather than giving a generic response
- The user expects you to DO what they ask, not explain what you COULD do

CRITICAL SAFETY RULES:

1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.
   - If user asks to delete something, respond: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. You can ONLY access files in these directories:
${pathsList}
   - REFUSE any file operations outside these paths

3. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Any command that affects files outside allowed directories
   - Commands that could damage the system

4. For any destructive or irreversible action, ALWAYS ask for confirmation first.

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!
`;
}

// Get the current safety prompt (dynamically built from allowed paths)
export function getSafetyPrompt(): string {
  return buildSafetyPrompt(_allowedPaths);
}

// Dangerous command patterns to block
export const BLOCKED_PATTERNS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "sudo rm",
  ":(){ :|:& };:", // Fork bomb
  "> /dev/sd",
  "mkfs.",
  "dd if=",
];

// Query timeout (3 minutes)
export const QUERY_TIMEOUT_MS = 180_000;

// ============== Voice Transcription ==============

const BASE_TRANSCRIPTION_PROMPT = `Transcribe this voice message accurately.
The speaker may use multiple languages (English, and possibly others).
Focus on accuracy for proper nouns, technical terms, and commands.`;

const TRANSCRIPTION_CONTEXT = process.env.TRANSCRIPTION_CONTEXT || "";

export const TRANSCRIPTION_PROMPT = TRANSCRIPTION_CONTEXT
  ? `${BASE_TRANSCRIPTION_PROMPT}\n\nAdditional context:\n${TRANSCRIPTION_CONTEXT}`
  : BASE_TRANSCRIPTION_PROMPT;

export const TRANSCRIPTION_AVAILABLE = !!OPENAI_API_KEY;

// ============== Thinking Keywords ==============

const thinkingKeywordsStr =
  process.env.THINKING_KEYWORDS || "think,pensa,ragiona";
const thinkingDeepKeywordsStr =
  process.env.THINKING_DEEP_KEYWORDS || "ultrathink,think hard,pensa bene";

export const THINKING_KEYWORDS = thinkingKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());
export const THINKING_DEEP_KEYWORDS = thinkingDeepKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());

// ============== Media Group Settings ==============

export const MEDIA_GROUP_TIMEOUT = 1000; // ms to wait for more photos in a group

// ============== Telegram Message Limits ==============

export const TELEGRAM_MESSAGE_LIMIT = 4096; // Max characters per message
export const TELEGRAM_SAFE_LIMIT = 4000; // Safe limit with buffer for formatting
export const STREAMING_THROTTLE_MS = 500; // Throttle streaming updates
export const BUTTON_LABEL_MAX_LENGTH = 30; // Max chars for inline button labels

// ============== Audit Logging ==============

export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH || `${CONFIG_DIR}/logs/audit.log`;
export const AUDIT_LOG_JSON =
  (process.env.AUDIT_LOG_JSON || "false").toLowerCase() === "true";
export const AUDIT_LOG_MAX_SIZE_MB = parseInt(
  process.env.AUDIT_LOG_MAX_SIZE_MB || "10",
  10
);
export const AUDIT_LOG_MAX_FILES = parseInt(
  process.env.AUDIT_LOG_MAX_FILES || "5",
  10
);

// ============== Rate Limiting ==============

export const RATE_LIMIT_ENABLED =
  (process.env.RATE_LIMIT_ENABLED || "true").toLowerCase() === "true";
export const RATE_LIMIT_REQUESTS = parseInt(
  process.env.RATE_LIMIT_REQUESTS || "20",
  10
);
export const RATE_LIMIT_WINDOW = parseInt(
  process.env.RATE_LIMIT_WINDOW || "60",
  10
);

// ============== File Paths ==============

// Sessions now stored in ~/.claude/projects/<project-path>/ (Claude Code standard)
export const RESTART_FILE = "/tmp/claude-telegram-restart.json";
export const TEMP_DIR = "/tmp/telegram-bot";

// ============== Plan Mode Configuration ==============

// Re-export from new plan-mode module
import * as PlanMode from "./plan-mode";
export {
  getStateFile as getPlanStateFile,
  isExitPlanModeTool,
  isWriteTool,
  PlanStateManager,
} from "./plan-mode";

// Expose as PLAN_MODE object for backward compatibility
export const PLAN_MODE = {
  PLANS_DIR: PlanMode.PLANS_DIR,
  LOG_FILE: PlanMode.PLAN_MODE_LOG_FILE,
  STATE_FILE_PATTERN: PlanMode.STATE_FILE_PATTERN,
  PENDING_STATE_FILE: PlanMode.PENDING_STATE_FILE,
  RESTRICTED_TOOLS: PlanMode.RESTRICTED_TOOLS,
  EXIT_PLAN_MODE_TOOLS: PlanMode.EXIT_PLAN_MODE_TOOLS,
  WRITE_TOOLS: PlanMode.WRITE_TOOLS,
  SYSTEM_PROMPT: PlanMode.PLAN_MODE_SYSTEM_PROMPT,
} as const;

// Temp paths that are always allowed for bot operations
export const TEMP_PATHS = ["/tmp/", "/private/tmp/", "/var/folders/"];

// Ensure temp directory exists
await Bun.write(`${TEMP_DIR}/.keep`, "");

// ============== Validation ==============

if (!TELEGRAM_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN environment variable is required");
  process.exit(1);
}

if (ALLOWED_USERS.length === 0) {
  console.error(
    "ERROR: TELEGRAM_ALLOWED_USERS environment variable is required"
  );
  process.exit(1);
}

// ============== Permission Mode ==============

export const PERMISSION_MODE_DEFAULT =
  (process.env.PERMISSION_MODE as "bypass" | "interactive") || "bypass";
export const ALLOW_TELEGRAM_PERMISSIONS_MODE =
  (process.env.ALLOW_TELEGRAM_PERMISSIONS_MODE || "true").toLowerCase() ===
  "true";

// Runtime permission mode (can be changed via Telegram command if allowed)
let currentPermissionMode: "bypass" | "interactive" = PERMISSION_MODE_DEFAULT;

export function getPermissionMode(): "bypass" | "interactive" {
  return currentPermissionMode;
}

export function setPermissionMode(mode: "bypass" | "interactive"): boolean {
  if (!ALLOW_TELEGRAM_PERMISSIONS_MODE) {
    return false; // Mode changes not allowed
  }
  currentPermissionMode = mode;
  return true;
}

export function resetPermissionMode(): void {
  currentPermissionMode = PERMISSION_MODE_DEFAULT;
}

// ============== Model Management ==============

export function getModel(): string {
  return MODEL_IDS[currentModel];
}

export function getModelName(): ModelName {
  return currentModel;
}

export function setModel(model: ModelName): boolean {
  if (!ALLOW_TELEGRAM_MODEL_MODE) {
    return false;
  }
  currentModel = model;
  savePersistentConfig();
  return true;
}

export function isValidModelName(name: string): name is ModelName {
  return name in MODEL_IDS;
}

export { MODEL_IDS };

console.log(
  `Config loaded: ${ALLOWED_USERS.length} allowed users, projects root: ${PROJECTS_ROOT}, current dir: ${currentWorkingDir}, permission mode: ${currentPermissionMode}, model: ${currentModel}`
);
