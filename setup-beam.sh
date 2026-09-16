#!/usr/bin/env bash
# Bootstraps a brand-new beam for Telegram-driven agentic use with Claude
# Code: installs the tg-*.sh hooks from this repo, wires them into
# ~/.claude/settings.json, writes ~/.claude/telegram.env, and verifies the
# bot can reach Telegram. Safe to re-run.
#
# Usage:
#   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... ./setup-beam.sh
# or run interactively and it will prompt for whatever isn't set.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_SRC="$SCRIPT_DIR/.claude/hooks"
HOOKS_DST="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"
ENV_FILE="$HOME/.claude/telegram.env"

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing dependency: $bin" >&2; exit 1; }
done

# --- install the hook scripts --------------------------------------------
# If this repo was cloned straight into $HOME (the common case), the
# scripts are already sitting at $HOOKS_DST — skip the self-copy.
mkdir -p "$HOOKS_DST"
for f in tg-notify.sh tg-wait.sh tg-confirm.sh; do
  if [ "$(cd "$(dirname "$HOOKS_SRC/$f")" && pwd)/$f" = "$(cd "$(dirname "$HOOKS_DST/$f")" && pwd)/$f" ]; then
    chmod 0755 "$HOOKS_DST/$f"
  else
    install -m 0755 "$HOOKS_SRC/$f" "$HOOKS_DST/$f"
  fi
done
echo "Hook scripts ready at $HOOKS_DST"

# --- telegram.env ----------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  token="${TELEGRAM_BOT_TOKEN:-}"
  chat="${TELEGRAM_CHAT_ID:-}"
  if [ -z "$token" ] && [ -t 0 ]; then read -rp "Telegram bot token: " token; fi
  if [ -z "$chat" ] && [ -t 0 ]; then read -rp "Telegram chat id: " chat; fi
  if [ -z "$token" ] || [ -z "$chat" ]; then
    echo "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (env, or run interactively) to write $ENV_FILE" >&2
    exit 1
  fi
  umask 077
  cat >"$ENV_FILE" <<EOF
TELEGRAM_BOT_TOKEN=$token
TELEGRAM_CHAT_ID=$chat
EOF
  echo "Wrote $ENV_FILE"
else
  echo "$ENV_FILE already exists, leaving it alone"
fi

# --- wire hooks into settings.json (preserves everything else) -----------
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' >"$SETTINGS"

tmp=$(mktemp)
jq \
  --arg notify "$HOOKS_DST/tg-notify.sh" \
  --arg confirm "$HOOKS_DST/tg-confirm.sh" \
  --arg wait "$HOOKS_DST/tg-wait.sh" \
  '.hooks.Notification = [{
     matcher: "permission_prompt|idle_prompt|agent_needs_input",
     hooks: [{type:"command", command:$notify, timeout:20, statusMessage:"Pinging Telegram"}]
   }]
   | .hooks.PreToolUse = [{
     matcher: "AskUserQuestion|Bash|Edit|Write|NotebookEdit|WebFetch",
     hooks: [{type:"command", command:$confirm, timeout:90, statusMessage:"Asking Telegram"}]
   }]
   | .hooks.Stop = [{
     hooks: [{type:"command", command:$wait, timeout:360, statusMessage:"Waiting for Telegram"}]
   }]' "$SETTINGS" >"$tmp"
mv "$tmp" "$SETTINGS"
echo "Wired hooks into $SETTINGS"

# --- verify ----------------------------------------------------------------
# shellcheck disable=SC1090
. "$ENV_FILE"

if info=$(curl -sS -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null) \
    && [ "$(jq -r '.ok // false' <<<"$info")" = "true" ]; then
  echo "Bot token OK: @$(jq -r '.result.username' <<<"$info")"
else
  echo "Warning: could not verify bot token (getMe failed)" >&2
fi

if curl -sS -m 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=[$(hostname)] Telegram hooks installed and wired up." >/dev/null 2>&1; then
  echo "Sent test message"
else
  echo "Warning: test message failed to send" >&2
fi

echo "Done. Start a new Claude Code session (or restart the current one) to pick up the new hooks."
