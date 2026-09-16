#!/usr/bin/env bash
# Claude Code -> Telegram, one-way.
# Wire to the Notification hook so you get pinged when Claude wants permission
# or has gone idle waiting on you.
set -uo pipefail

[ -f "$HOME/.claude/telegram.env" ] && . "$HOME/.claude/telegram.env"
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
: "${TELEGRAM_CHAT_ID:?set TELEGRAM_CHAT_ID}"

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
input=$(cat)

event=$(jq -r '.hook_event_name // "unknown"' <<<"$input")
project=$(basename "$(jq -r '.cwd // "."' <<<"$input")")

case "$event" in
  Notification)
    body=$(jq -r '.message // "Claude Code needs your attention."' <<<"$input") ;;
  Stop|SubagentStop)
    body=$(jq -r '.last_assistant_message // "Turn finished."' <<<"$input") ;;
  *)
    body="$event" ;;
esac

text="[$project] $body"
# Telegram caps a message at 4096 characters.
text=${text:0:4000}

curl -sS -m 15 -X POST "$API/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${text}" >/dev/null 2>&1

# Never block the session just because Telegram was unreachable.
exit 0
