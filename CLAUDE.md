# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run start      # Run the bot
bun run dev        # Run with auto-reload (--watch)
bun run typecheck  # Run TypeScript type checking
bun install        # Install dependencies
```

## Architecture

This is a Telegram bot (~7,700 lines TypeScript) that lets you control Claude Code from your phone via text, voice, photos, and documents. Built with Bun and grammY.

### Message Flow

```
Telegram message → Handler → Auth check → Rate limit → Claude session → Streaming response → Audit log
```

### Key Modules

**Core**
- **`src/index.ts`** - Entry point, registers handlers, starts polling
- **`src/config.ts`** - Environment parsing, MCP loading, safety prompts
- **`src/session.ts`** - `ClaudeSession` class wrapping Agent SDK V2 with streaming, session persistence, and defense-in-depth safety checks
- **`src/types.ts`** - Shared TypeScript types

**Security & Permissions**
- **`src/security.ts`** - `RateLimiter` (token bucket), path validation, command safety checks
- **`src/permissions.ts`** - Permission request storage and promise-based waiting, persistent project permissions
- **`src/permission-store.ts`** - In-memory permission request storage with event-based waiting

**Storage & Persistence**
- **`src/session-storage.ts`** - Session state persistence to `~/.sickfar/sessions/`
- **`src/ask-user-store.ts`** - Ask-user callback storage and results tracking
- **`src/migrations.ts`** - Storage migration orchestrator (moves data from /tmp to ~/.sickfar/)

**MCP Servers (In-Process)**
- **`src/plan-mode-mcp.ts`** - Plan mode tools (in-memory, replaces external stdio server)
- **`src/telegram-tools-mcp.ts`** - Telegram-specific operations (SendFileToTelegram)
- **`src/plan-mode/constants.ts`** - Plan mode configuration and restricted tools

**Formatting & Utilities**
- **`src/formatting.ts`** - Markdown→HTML conversion for Telegram, tool status emoji formatting
- **`src/utils.ts`** - Audit logging, voice transcription (OpenAI), typing indicators
- **`src/audit-logger.ts`** - Structured audit logging with rotation (10MB max, keeps 5 files)

### Handlers (`src/handlers/`)

Each message type has a dedicated async handler:

**Command & Message Handlers**
- **`commands.ts`** - Commands: `/start`, `/new`, `/plan`, `/code`, `/stop`, `/status`, `/project`, `/resume`, `/restart`, `/retry`, `/permissions`, `/thinking`, `/model`, `/voicelocale`
- **`text.ts`** - Text messages with intent filtering
- **`voice.ts`** - Voice→text via Mac Dictation (or OpenAI), auto-translates non-English to English

**Media Handlers**
- **`photo.ts`** - Image analysis with media group buffering (1s timeout for albums)
- **`media-group.ts`** - Media group assembly and coordination
- **`document.ts`** - PDF extraction (pdftotext CLI) and text file processing

**Interactive & Callback Handlers**
- **`callback.ts`** - Inline keyboard button handling for ask_user MCP and permission dialogs
- **`ask-user-other.ts`** - Additional ask_user callback handling
- **`plan-approval.ts`** - Plan mode approval flow handling

**Streaming & State**
- **`streaming.ts`** - Shared `StreamingState` and status callback factory
- **`index.ts`** - Handler registration and exports

### Security Layers

1. User allowlist (`TELEGRAM_ALLOWED_USERS`)
2. Rate limiting (token bucket, configurable)
3. Path validation (`ALLOWED_PATHS`)
4. Command safety (blocked patterns)
5. System prompt constraints
6. Audit logging

### Configuration

All config via `.env` (copy from `.env.example`). Key variables:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (required)
- `PROJECTS_ROOT` - Parent directory for all projects (default: home directory)
- `ALLOWED_PATHS` - Directories Claude can access
- `OPENAI_API_KEY` - For voice transcription (optional, Mac uses local Dictation by default)
- `MODEL_DEFAULT` - Default Claude model (opus, sonnet, haiku)
- `THINKING_DEFAULT` - Default extended thinking level (0, 10000, 50000)
- `VOICE_TRANSLATION_TARGET` - Translation target language for voice (default: en)

MCP servers defined in `mcp-config.ts`.

### Project Switching

Use `/project <relative/path>` to switch Claude's working directory dynamically:
- Paths are relative to `PROJECTS_ROOT`
- Switching kills the current session and starts fresh
- Security checks prevent path traversal attacks
- Example: `/project myapp` switches to `$PROJECTS_ROOT/myapp`

### Plan Mode

Use `/plan <message>` to send a message to Claude in plan mode:
- If no active session exists, starts a fresh session in read-only planning mode
- If a session already exists, sends the message to the existing session without changing its mode
- In plan mode, Claude can only use Read, Glob, Grep, Bash (read-only), and plan management tools
- Cannot write or edit files - focuses on exploration and planning
- Creates an implementation plan that can be approved via Telegram UI
- Use `/code` to exit plan mode and proceed with implementation
- Plan state is stored in-memory only (no file persistence)

### Telegram Tools MCP

Custom in-process MCP server providing Telegram-specific operations:

**SendFileToTelegram** - Send files from project to Telegram chat
- Accepts absolute or relative paths (relative to current working directory)
- Maximum file size: 50MB (Telegram bot limit)
- Requires user approval in interactive mode (not pre-approved)
- Optional caption parameter (max 1024 characters)
- Validates paths against allowed directories
- Example: Claude can send you a generated report or log file directly to the chat

Usage example:
```
User: "Generate a summary report and send it to me"
Claude: [creates report.md] [uses SendFileToTelegram tool] "I've sent the report to your chat"
```

### Runtime Files

- `~/.sickfar/sessions/` - Session persistence for `/resume`
- `~/.sickfar/logs/audit.log` - Audit log with automatic rotation (10MB max, keeps 5 files)
- `~/.sickfar/plans/` - Plan mode markdown files
- `/tmp/telegram-bot/` - Downloaded photos/documents (temporary)

## Patterns

**Adding a command**: Create handler in `commands.ts`, register in `index.ts` with `bot.command("name", handler)`

**Adding a message handler**: Create in `handlers/`, export from `index.ts`, register in `index.ts` with appropriate filter

**Streaming pattern**: All handlers use `createStatusCallback()` from `streaming.ts` and `session.sendMessageStreaming()` for live updates.

**Type checking**: Run `bun run typecheck` periodically while editing TypeScript files. Fix any type errors before committing.

**After code changes**: Restart the bot so changes can be tested. Use `launchctl kickstart -k gui/$(id -u)/com.claude-telegram-ts` if running as a service, or `bun run start` for manual runs.

## Standalone Build

The bot can be compiled to a standalone binary with `bun build --compile`. This is used by the ClaudeBot macOS app wrapper.

### External Dependencies

PDF extraction uses `pdftotext` CLI instead of an npm package (to avoid bundling issues):

```bash
brew install poppler  # Provides pdftotext
```

### PATH Requirements

When running as a standalone binary (especially from a macOS app), the PATH may not include Homebrew. The launcher must ensure PATH includes:
- `/opt/homebrew/bin` (Apple Silicon Homebrew)
- `/usr/local/bin` (Intel Homebrew)

Without this, `pdftotext` won't be found and PDF parsing will fail silently with an error message.

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.

## Running as Service (macOS)

```bash
cp launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit plist with your paths
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist

# Logs
tail -f /tmp/claude-telegram-bot-ts.log
tail -f /tmp/claude-telegram-bot-ts.err
```
