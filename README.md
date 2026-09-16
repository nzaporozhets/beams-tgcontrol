# Telegram hooks for Claude Code

Bridges a Claude Code session running on this beam to Telegram, so you can
monitor and drive it from your phone.

## Setup

`.claude/telegram.env` (untracked — holds secrets) must define:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Wired into `.claude/settings.json`:

| Hook event | Script | Purpose |
|---|---|---|
| `Notification` | `tg-notify.sh` | One-way ping when Claude wants permission or has gone idle. |
| `PreToolUse` (`AskUserQuestion\|Bash`) | `tg-confirm.sh` | Forwards a permission prompt or multi-choice question to Telegram and turns your reply into the decision — no local UI needed. |
| `Stop` | `tg-wait.sh` | Posts the turn's summary, long-polls for your reply, and feeds free text back into the running session as its next instruction. |

## Scripts

### `tg-notify.sh`
One-way. Reads the hook's JSON off stdin, posts a short message to
Telegram, and exits 0 regardless of Telegram's reachability — never blocks
the session.

### `tg-confirm.sh`
Two-way, scoped to a single tool call.

- **`AskUserQuestion`** — sends every question and its numbered options,
  waits for a reply (`;`-separated per question if there's more than one),
  then blocks the tool call and hands your answer back to Claude as the
  block reason. The interactive question UI never appears locally.
- **Everything else matched by the hook's matcher** (`Bash` by default) —
  sends a yes/no confirmation and maps the reply to an `allow`/`deny`
  permission decision. An unrecognized reply or a timeout falls through to
  the normal local prompt.

Shares `tg-wait.sh`'s update offset file so the two scripts never process
the same Telegram message twice. Skips itself entirely when
`CLAUDE_TG_CHILD` is set, so headless sessions spawned via `/new`/`/resume`
don't bounce their own prompts back to you.

### `tg-wait.sh`
Two-way, turn-level. Two roles in one file:

1. **Stop hook** (no args) — posts the last assistant message, long-polls
   for a reply, and feeds plain text back into the session as its next
   instruction.
2. **Runner** (`--run`) — self-invoked in the background to start a fresh
   headless session and report the result back to Telegram.

Telegram commands recognized by the Stop hook:

```
/done                       let the current turn end
/new <prompt>               new session in $TELEGRAM_PROJECT_DIR
/new /path/to/repo <prompt> new session in that directory
/resume <prompt>            continue the last session started this way
/resume <session-id> <prompt>
```

## Notes

- This repo is rooted at `$HOME` so the tracked scripts can live at their
  real path (`.claude/hooks/`) required by Claude Code. `.gitignore` keeps
  `telegram.env`, session transcripts, and other local state out of any
  future `git add -A`.
- Hook timeouts in `settings.json` must stay comfortably longer than each
  script's own `WAIT_SECONDS`/poll window, or Claude Code will kill the
  hook before a reply can arrive.
