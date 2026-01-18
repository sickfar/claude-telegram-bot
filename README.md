# Claude Code Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh/)

**Control [Claude Code](https://claude.com/product/claude-code) from your phone via Telegram.**

A Telegram bot that provides a complete interface to Claude Code's powerful AI coding agent. Send text, voice, photos, and documents. See responses and tool usage in real-time. Code from anywhere.

![Demo](assets/demo.gif)

## About This Project

This is my personal fork of [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot), significantly rewritten and extended for my development workflow. While the original focused on general-purpose assistance, this version is laser-focused on software development and coding workflows.

Built with Bun and TypeScript (~9,500 lines), it provides full access to Claude Code's capabilities through Telegram, enabling mobile-first development workflows.

**Status:** Under active development. Expect frequent updates and changes.

## Features

### Message Types
- 💬 **Text**: Send instructions, ask questions, discuss code
- 🎤 **Voice**: Speak naturally - local Mac Dictation (free) or OpenAI Whisper, auto-translates to English
- 📸 **Photos**: Send screenshots, diagrams, or error messages for analysis
- 📄 **Documents**: Upload PDFs, text files, code files - Claude reads and analyzes them
- 🔄 **Session persistence**: Conversations continue across messages, resume after restart
- 📨 **Message queuing**: Send multiple messages while Claude works - they queue automatically

### Developer Workflow
- 🧠 **Extended thinking**: Configure Claude's reasoning depth with `/thinking` (off, normal, deep)
- 📋 **Plan mode**: Explore codebases and design approaches before making changes
- 🔀 **Project switching**: Switch between projects dynamically with `/project`
- 📸 **Screenshots & screen recording**: Capture windows or record screen directly from Telegram
- 🔘 **Interactive buttons**: Claude can present options as tappable Telegram buttons
- 📤 **File delivery**: Claude can send files directly to your Telegram chat via MCP tool
- 🔐 **Permission system**: Fine-grained control with bypass/interactive modes
- 🔧 **MCP integration**: Extend with custom MCP servers for your tools and workflows

### Architecture Highlights
- **Streaming responses**: Real-time updates as Claude works
- **Defense-in-depth security**: Multiple layers protect against misuse
- **Rate limiting**: Token bucket algorithm prevents runaway usage
- **Audit logging**: All interactions logged with automatic rotation
- **Session recovery**: Resume conversations after bot restarts
- **Media group handling**: Upload multiple photos at once

## Quick Start

```bash
git clone https://github.com/sickfar/claude-telegram-bot
cd claude-telegram-bot

cp .env.example .env
# Edit .env with your credentials

bun install
bun run start
```

### Prerequisites

- **Bun 1.0+** - [Install Bun](https://bun.sh/)
- **Claude Agent SDK** - Installed via `bun install`
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)
- **Claude Code auth** or **Anthropic API key**
- **OpenAI API key** (optional, for voice transcription - Mac uses local Dictation by default)
- **ffmpeg** (optional, for screen recording) - `brew install ffmpeg`
- **pdftotext** (optional, for PDF parsing) - `brew install poppler`

### Claude Authentication

The bot uses `@anthropic-ai/claude-agent-sdk` with two authentication methods:

| Method                     | Best For                                | Setup                             |
| -------------------------- | --------------------------------------- | --------------------------------- |
| **CLI Auth** (recommended) | High usage, cost-effective              | Run `claude` once to authenticate |
| **API Key**                | CI/CD, environments without Claude Code | Set `ANTHROPIC_API_KEY` in `.env` |

**CLI Auth** (recommended): The SDK automatically uses your Claude Code login. Just ensure you've run `claude` at least once and authenticated. This uses your Claude Code subscription which is much more cost-effective for heavy usage.

**API Key**: For environments where Claude Code isn't installed. Get a key from [console.anthropic.com](https://console.anthropic.com/) and add to `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Note: API usage is billed per token and can get expensive quickly for heavy use.

## Configuration

### 1. Create Your Bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow prompts
3. Copy the token (looks like `1234567890:ABC-DEF...`)

### 2. Configure Environment

Create `.env` with your settings. See `.env.example` for all available options.

#### Required

```bash
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF...   # From @BotFather
TELEGRAM_ALLOWED_USERS=123456789           # Your Telegram user ID (find via @userinfobot)
```

#### Recommended

```bash
# Projects root directory (parent directory for all your projects)
PROJECTS_ROOT=/path/to/projects            # Default: home directory
```

#### Optional - Security & Permissions

```bash
# Comma-separated paths Claude can access
# Default: PROJECTS_ROOT, ~/Documents, ~/Downloads, ~/Desktop, ~/.claude
# WARNING: Setting this OVERRIDES defaults. Include ~/.claude for plan mode.
ALLOWED_PATHS=/your/project,/other/path,~/.claude

# Permission mode: "bypass" (no prompts) or "interactive" (show dialogs)
PERMISSION_MODE=bypass                           # Default: bypass
ALLOW_TELEGRAM_PERMISSIONS_MODE=true             # Allow /permissions command

# Rate limiting (token bucket algorithm)
RATE_LIMIT_ENABLED=true                          # Default: true
RATE_LIMIT_REQUESTS=20                           # Requests per window (default: 20)
RATE_LIMIT_WINDOW=60                             # Window in seconds (default: 60)
```

**Permission Modes:**
- **Bypass** (default): Claude acts autonomously, no prompts
- **Interactive**: Show approval dialog for each file/command operation (✅ Allow, ❌ Deny, 💬 Deny with reason)

**Dynamic switching:** `/permissions`, `/permissions bypass`, `/permissions interactive`

#### Optional - Model & Thinking

```bash
# Model configuration
MODEL_DEFAULT=sonnet                             # Default: sonnet (options: opus, sonnet, haiku)
ALLOW_TELEGRAM_MODEL_MODE=true                   # Allow /model command (default: true)

# Extended thinking mode
THINKING_DEFAULT=10000                           # Default: 10000 (0=off, 10000=normal, 50000=deep)
```

#### Optional - Claude Authentication

```bash
# API key for environments without Claude Code CLI auth
# Get from: https://console.anthropic.com/
# Note: CLI auth is more cost-effective than API billing
ANTHROPIC_API_KEY=sk-ant-api03-...

# Path to Claude CLI (auto-detected from PATH by default)
CLAUDE_CLI_PATH=/usr/local/bin/claude
```

#### Optional - Voice Transcription 

Voice transcription uses **Apple's on-device Dictation** by default (macOS only). No setup required!

**Prerequisites** (should be pre-installed on macOS):
- `ffmpeg` - Install: `brew install ffmpeg`
- `hear` - Built into macOS (Apple's speech recognition)
- `translate-shell` - Install: `brew install translate-shell`

```bash
# Voice locale - configure via /voicelocale command (default: en-US)
# Run 'hear -s' to see all supported locales
# Non-English voice is auto-translated to English to save Claude tokens

# Translation target language
VOICE_TRANSLATION_TARGET=en                      # Default: en (English)

# Additional context for transcription (names, technical terms)
TRANSCRIPTION_CONTEXT=Common names: John, Alice. Tech: Kubernetes, GraphQL.

# Use OpenAI Whisper instead of Mac Dictation (not recommended, costs money)
OPENAI_API_KEY=sk-...
```

#### Optional - Audit Logging

```bash
# Audit log configuration
AUDIT_LOG_PATH=~/.sickfar/logs/audit.log         # Default path
AUDIT_LOG_JSON=false                             # Output as JSON (default: human-readable)
AUDIT_LOG_MAX_SIZE_MB=10                         # Rotate at this size (default: 10MB)
AUDIT_LOG_MAX_FILES=5                            # Keep this many rotated files (default: 5)
```

### 3. Configure MCP Servers (Optional)

```bash
cp mcp-config.ts mcp-config.local.ts
# Edit mcp-config.local.ts with your MCP servers
```

The bot includes built-in MCP servers:
- **ask_user** - Interactive buttons for user choices
- **plan-mode** - Plan mode tools (in-process)
- **telegram-tools** - SendFileToTelegram tool

Add your own MCP servers to extend Claude's capabilities.

## Commands

| Command            | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `/start`           | Show status and your user ID                                   |
| `/new`             | Start a fresh session                                          |
| `/plan`            | Send a message in plan mode (read-only exploration)            |
| `/code`            | Exit plan mode and proceed with implementation                 |
| `/project`         | Switch to a different project directory                        |
| `/resume`          | Resume last session after restart                              |
| `/stop`            | Interrupt current query                                        |
| `/status`          | Check what Claude is doing                                     |
| `/restart`         | Restart the bot                                                |
| `/retry`           | Retry the last message                                         |
| `/permissions`     | View or change permission mode (interactive vs bypass)         |
| `/thinking`        | Toggle extended thinking mode on/off                           |
| `/model`           | Switch Claude model (opus, sonnet, haiku)                      |
| `/voicelocale`     | Set voice recognition locale (e.g., en-US, ru-RU)              |
| `/screenshot`      | Capture a screenshot of full screen or specific window         |
| `/screencap <dur>` | Record screen or window for duration (e.g., `/screencap 30s`)  |

## Plan Mode

Plan mode enables read-only exploration before implementation:

1. Send `/plan <message>` to enter plan mode
2. Claude can use Read, Glob, Grep, Bash (read-only) to explore
3. Claude cannot write or edit files
4. Claude creates an implementation plan
5. Approve the plan, then use `/code` to switch to implementation mode

**Example:**

```
/plan Add a dark mode toggle to the settings page

[Claude explores codebase, examines styles, creates plan]

/code
[Claude implements the plan with full file access]
```

Plan mode is great for:
- Exploring unfamiliar codebases
- Designing approaches before coding
- Getting a second opinion before refactoring
- Complex features requiring careful planning

## Screen Recording & Screenshots

Capture your screen or specific windows directly from Telegram:

### Screenshots

```
/screenshot
```

Presents a menu of all open windows. Select one to capture an instant screenshot. Useful for:
- Sharing UI states with Claude for debugging
- Documenting visual bugs
- Capturing error dialogs

### Screen Recording

```
/screencap 30s   # Record for 30 seconds
/screencap 5m    # Record for 5 minutes
/screencap 1h    # Error: max duration is 10 minutes
```

**Duration formats:**
- `30s` - seconds (1-600)
- `5m` - minutes (1-10)
- `1h` - hours (max 10m due to Telegram's 50MB file limit)

**Features:**
- Select full screen or specific window
- Window automatically brought to front
- Retina display support (correct scaling)
- Async recording (continue chatting with Claude while recording)
- MP4 output with H.264 codec
- 30fps, optimized for file size

**Requirements:**
- `ffmpeg` - Install: `brew install ffmpeg`
- Screen Recording permission (System Settings > Privacy & Security > Screen Recording)

**Tips:**
- Keep recordings under 5 minutes to avoid large files
- The selected window/app is activated automatically before recording
- Recording continues in the background - you'll be notified when complete

## Project Switching

Switch between projects dynamically:

```
/project myapp              # Switch to $PROJECTS_ROOT/myapp
/project ../other-project   # Relative paths supported
```

- Paths are relative to `PROJECTS_ROOT`
- Kills current session and starts fresh
- Security checks prevent path traversal
- Project state persists across switches

## Running as a Service (macOS)

```bash
cp launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit the plist with your paths and env vars
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

The bot starts automatically on login and restarts if it crashes.

**Prevent sleep:** System Settings → Battery → Options → "Prevent automatic sleeping when the display is off"

**Logs:**

```bash
tail -f /tmp/claude-telegram-bot-ts.log   # stdout
tail -f /tmp/claude-telegram-bot-ts.err   # stderr
```

**Shell aliases** (add to `~/.zshrc`):

```bash
alias cbot='launchctl list | grep com.claude-telegram-ts'
alias cbot-stop='launchctl bootout gui/$(id -u)/com.claude-telegram-ts 2>/dev/null && echo "Stopped"'
alias cbot-start='launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-telegram-ts.plist 2>/dev/null && echo "Started"'
alias cbot-restart='launchctl kickstart -k gui/$(id -u)/com.claude-telegram-ts && echo "Restarted"'
alias cbot-logs='tail -f /tmp/claude-telegram-bot-ts.log'
```

## Development

```bash
# Run with auto-reload
bun run dev

# Type check
bun run typecheck

# Run tests (if any)
bun test
```

### Architecture Overview

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

**Message Flow:**
```
Telegram → Handler → Auth → Rate limit → Claude session → Streaming response → Audit log
```

**Key modules:**
- `src/index.ts` - Entry point, handler registration
- `src/session.ts` - Claude session management with streaming
- `src/handlers/` - Message type handlers (text, voice, photo, etc.)
- `src/security.ts` - Rate limiting, path validation, command safety
- `src/permissions.ts` - Permission system (bypass/interactive modes)
- `src/*-mcp.ts` - Built-in MCP servers (plan mode, Telegram tools)

## Security

> **⚠️ Important:** This bot runs Claude Code with **permission prompts bypassed by default**. Claude can read, write, and execute commands without confirmation within allowed paths. This is intentional for seamless mobile use.

**→ [Read the full Security Model](SECURITY.md)**

Protection layers:

1. **User allowlist** - Only authorized Telegram IDs
2. **Intent classification** - AI filter blocks dangerous requests
3. **Path validation** - File access restricted to `ALLOWED_PATHS`
4. **Command safety** - Destructive patterns blocked (e.g., `rm -rf /`)
5. **Rate limiting** - Token bucket prevents runaway usage
6. **Audit logging** - All interactions logged to `~/.sickfar/logs/audit.log`

## Troubleshooting

**Bot doesn't respond**

- Verify your user ID is in `TELEGRAM_ALLOWED_USERS`
- Check bot token is correct
- Check logs: `tail -f /tmp/claude-telegram-bot-ts.err`
- Ensure bot process is running

**Claude authentication issues**

- CLI auth: Run `claude` in terminal and verify login
- API key: Check `ANTHROPIC_API_KEY` starts with `sk-ant-api03-`
- Verify API key has credits at [console.anthropic.com](https://console.anthropic.com/)

**Voice messages fail**

- **Mac users:** Ensure Dictation is enabled in System Settings → Keyboard → Dictation
- **OpenAI users:** Set `OPENAI_API_KEY` in `.env` and verify API credits
- Check logs: `tail -f /tmp/claude-telegram-bot-ts.err`
- Note: Mac Dictation auto-translates non-English to English to save tokens

**Claude can't access files**

- Check `PROJECTS_ROOT` exists or use `/project` to switch
- Verify `ALLOWED_PATHS` includes target directories
- Ensure bot process has read/write permissions
- Default access: PROJECTS_ROOT, ~/Documents, ~/Downloads, ~/Desktop, ~/.claude

**MCP tools not working**

- Verify `mcp-config.ts` exists and exports properly
- Check MCP server dependencies are installed
- Look for MCP errors in logs

**Screen recording fails**

- Install ffmpeg: `brew install ffmpeg`
- Grant Screen Recording permission: System Settings > Privacy & Security > Screen Recording
- Add Terminal (or your bot runner) to the allowed apps
- Restart the bot after granting permissions
- Check that the selected window hasn't been closed or minimized

**Retina display issues (wrong crop size)**

- The bot automatically detects Retina displays and scales coordinates
- If detection fails, recordings default to 2x scaling (safe for most Macs)
- Check `system_profiler SPDisplaysDataType` shows correct display info

## Runtime Files

- `~/.sickfar/sessions/` - Session persistence for `/resume`
- `~/.sickfar/logs/audit.log` - Audit log (10MB max, rotates, keeps 5 files)
- `~/.sickfar/plans/` - Plan mode markdown files
- `/tmp/telegram-bot/` - Temporary downloads (photos/documents)

## Contributing

This is a personal project, but feel free to fork and adapt for your own use. Pull requests are welcome for bug fixes and improvements.

## Credits

Originally forked from [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot). Significantly rewritten and extended with:
- Plan mode architecture
- Permission system (bypass/interactive)
- Session persistence and recovery
- MCP server integration
- Media group handling
- Streaming improvements
- Enhanced security layers
- Voice recognition with Mac Dictation (+ auto-translation)
- Model switching (opus/sonnet/haiku)
- Extended thinking mode
- Project switching
- Screen recording and screenshots with Retina support

## License

MIT
