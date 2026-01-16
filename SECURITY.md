# Security Model

This document describes the security architecture of the Claude Telegram Bot.

## Permission Mode: Configurable

The bot supports two permission modes:

### Bypass Mode (Default)

**Recommended for mobile use.** Claude Code runs with all permission prompts disabled.

```bash
PERMISSION_MODE=bypass
```

```typescript
// src/session.ts
permissionMode: "bypassPermissions"
allowDangerouslySkipPermissions: true
```

This means Claude can:
- **Read and write files** without asking for confirmation
- **Execute shell commands** without permission prompts
- **Use all tools** (Bash, Edit, Write, etc.) autonomously

This is intentional. The bot is designed for personal use from mobile, where confirming every file read or command would be impractical. Instead of per-action prompts, we rely on defense-in-depth with multiple security layers described below.

### Interactive Mode (Optional)

**Use when you want fine-grained control.** Claude asks for permission before each action.

```bash
PERMISSION_MODE=interactive
```

In this mode, Claude will send Telegram inline keyboard buttons for each file/command operation. See "Permission Dialogs" section below for details.

### Switching Modes Dynamically

You can change permission mode without restarting:

```bash
# Enable dynamic mode switching (default: true)
ALLOW_TELEGRAM_PERMISSIONS_MODE=true
```

Then use the `/permissions` command in Telegram:

```
/permissions                # Show current mode
/permissions bypass         # Switch to bypass mode
/permissions interactive    # Switch to interactive mode
```

Set `ALLOW_TELEGRAM_PERMISSIONS_MODE=false` to lock the mode to the `PERMISSION_MODE` env var.

## Threat Model

The bot is designed for **personal use by trusted users**. The primary threats we defend against:

1. **Unauthorized access** - Someone discovers or steals your bot token
2. **Prompt injection** - Malicious content in messages tries to manipulate Claude
3. **Accidental damage** - Legitimate users accidentally running destructive commands
4. **Credential exposure** - Attempts to extract API keys, passwords, or secrets

## Defense in Depth

The bot implements multiple layers of security:

### Layer 1: User Allowlist

Only Telegram users whose IDs are in `TELEGRAM_ALLOWED_USERS` can interact with the bot.

```
User sends message → Check user ID in allowlist → Reject if not authorized
```

- User IDs are numeric and cannot be spoofed in Telegram
- Get your ID from [@userinfobot](https://t.me/userinfobot)
- Unauthorized attempts are logged

### Layer 2: Rate Limiting

Token bucket rate limiting prevents abuse even if credentials are compromised.

```
Default: 20 requests per 60 seconds per user
```

Configure via:
- `RATE_LIMIT_ENABLED` - Enable/disable (default: true)
- `RATE_LIMIT_REQUESTS` - Requests per window (default: 20)
- `RATE_LIMIT_WINDOW` - Window in seconds (default: 60)

### Layer 3: Path Validation

File operations are restricted to explicitly allowed directories.

```
Default allowed paths:
- CLAUDE_WORKING_DIR
- ~/Documents
- ~/Downloads
- ~/Desktop
```

Customize via `ALLOWED_PATHS` (comma-separated).

**Validation uses proper path containment checks:**
- Symlinks are resolved before checking
- Path traversal attacks (../) are prevented
- Only exact directory matches are allowed

**Exception for temp files:**
- Reading from /tmp/ and /var/folders/ is allowed
- This enables handling of Telegram-downloaded files

### Layer 4: Command Safety

Dangerous shell commands are blocked as defense-in-depth, **regardless of permission mode**. Even in interactive mode, catastrophic commands are automatically denied without showing a permission dialog.

#### Completely Blocked Patterns

These patterns are **always rejected**, regardless of context:

| Pattern | Reason |
|---------|--------|
| `rm -rf /` | System destruction |
| `rm -rf ~` | Home directory wipe |
| `rm -rf $HOME` | Home directory wipe |
| `sudo rm` | Privileged deletion |
| `:(){ :\|:& };:` | Fork bomb |
| `> /dev/sd` | Disk overwrite |
| `mkfs.` | Filesystem formatting |
| `dd if=` | Raw disk operations |

#### Path-Validated Commands

`rm` commands (that don't match blocked patterns above) are **allowed but path-validated**:

```bash
rm file.txt              # Allowed if in ALLOWED_PATHS
rm /etc/passwd           # Blocked - outside ALLOWED_PATHS
rm -rf ./node_modules    # Allowed if cwd is in ALLOWED_PATHS
rm -r /tmp/mydir         # Allowed - /tmp is always permitted
```

Each path argument is checked against `ALLOWED_PATHS` before execution.

### Layer 4.5: Permission Dialogs (Interactive Mode Only)

When `PERMISSION_MODE=interactive`, Claude requests permission for each action via Telegram inline keyboards.

**Flow:**

1. Claude attempts to use a tool (Read, Write, Bash, etc.)
2. Bot creates permission request file in `/tmp/perm-{uuid}.json`
3. Telegram message sent with inline keyboard: **Allow** / **Deny** / **Deny with reason**
4. User clicks button within 55 seconds (auto-denies on timeout)
5. Result returned to Claude, who continues or adjusts approach

**Three response options:**

- ✅ **Allow**: Execute the action immediately
- ❌ **Deny**: Block the action with generic message
- 💬 **Deny with reason**: Block + provide feedback to Claude about why

**Security notes:**

- Timeout defaults to deny (safe default)
- Permission requests are scoped to the chat ID
- Catastrophic commands (Layer 4) are still blocked automatically
- Old permission files are cleaned up after response

**When to use interactive mode:**

- Sensitive directories or commands
- Learning what Claude is doing step-by-step
- Cases where you want fine-grained control

**When NOT to use interactive mode:**

- Mobile use (too many prompts)
- Trusted automation workflows
- When you want Claude to work autonomously

### Layer 5: System Prompt

Claude receives a safety prompt that instructs it to:

1. **Never delete files without explicit confirmation** - Must ask "Are you sure?"
2. **Only access allowed directories** - Refuse operations outside them
3. **Never run dangerous commands** - Even if asked
4. **Ask for confirmation on destructive actions**

This is the primary protection layer. The other layers are defense-in-depth.

### Layer 6: Audit Logging

All interactions are logged for security review.

```
Log location: /tmp/claude-telegram-audit.log (configurable)
```

Logged events:
- `message` - User messages and Claude responses
- `auth` - Authorization attempts
- `tool_use` - Claude tool usage
- `error` - Errors during processing
- `rate_limit` - Rate limit events

Enable JSON format for easier parsing: `AUDIT_LOG_JSON=true`

## What This Doesn't Protect Against

1. **Malicious authorized users** - If you add someone to the allowlist, they have full access
2. **Zero-day vulnerabilities** - Unknown bugs in Claude, the SDK, or dependencies
3. **Physical access** - Someone with access to the machine running the bot
4. **Network interception** - Though Telegram uses encryption

## Recommendations

1. **Keep the allowlist small** - Only add users you fully trust
2. **Use a dedicated working directory** - Don't point at `/` or `~`
3. **Review audit logs periodically** - Look for suspicious patterns
4. **Keep dependencies updated** - Security patches for the SDK and Telegram library
5. **Use a dedicated API key** - Create a separate Anthropic API key for the bot
6. **Enable email alerts** - Get notified when new sessions start

## Incident Response

If you suspect unauthorized access:

1. **Stop the bot**: `launchctl unload ~/Library/LaunchAgents/com.claude-telegram-ts.plist`
2. **Revoke the Telegram bot token**: Message @BotFather and create a new token
3. **Review audit logs**: Check `/tmp/claude-telegram-audit.log`
4. **Check for file changes**: Review recent activity in allowed directories
5. **Update credentials**: Rotate any API keys that may have been exposed

## Security Updates

If you discover a security issue:

1. **Don't open a public GitHub issue**
2. Contact the maintainer privately
3. Allow time for a fix before disclosure
