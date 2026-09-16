#!/usr/bin/env bash
# Claude Code <-> Telegram, permission-prompt bridge.
# Wire to PreToolUse (matcher: "AskUserQuestion|Bash", or extend as needed).
#
#   AskUserQuestion -> forwards the question(s)/options as a numbered list,
#                       waits for a reply, then blocks the tool call and
#                       feeds the operator's choice back to Claude as the
#                       block "reason" (so no local UI ever pops up).
#   everything else -> forwards a yes/no confirmation, waits for a reply,
#                       and translates it into an allow/deny permission
#                       decision (falls through to the normal prompt on
#                       timeout or an unrecognized reply).
set -uo pipefail

[ -f "$HOME/.claude/telegram.env" ] && . "$HOME/.claude/telegram.env"
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
: "${TELEGRAM_CHAT_ID:?set TELEGRAM_CHAT_ID}"

# Spawned headless sessions (see tg-wait.sh /new, /resume) already run with
# an explicit --permission-mode; never bounce their prompts back to Telegram.
[ -n "${CLAUDE_TG_CHILD:-}" ] && exit 0

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
WAIT_SECONDS=${TELEGRAM_CONFIRM_WAIT_SECONDS:-60}   # keep < the hook's timeout in settings.json
POLL=20
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claude-telegram"
mkdir -p "$STATE_DIR"
offset_file="$STATE_DIR/offset"

input=$(cat)
tool_name=$(jq -r '.tool_name // "unknown"' <<<"$input")
tool_input=$(jq -c '.tool_input // {}' <<<"$input")
project=$(basename "$(jq -r '.cwd // "."' <<<"$input")")

send() {
  curl -sS -m 15 -X POST "$API/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${1:0:4000}" >/dev/null 2>&1
}

# Long-poll for the next reply. Shares tg-wait.sh's offset file so the same
# update is never consumed twice by two hooks running back to back.
wait_for_reply() {
  local offset deadline resp max_id reply
  offset=$(cat "$offset_file" 2>/dev/null || echo 0)
  deadline=$(( $(date +%s) + WAIT_SECONDS ))

  while [ "$(date +%s)" -lt "$deadline" ]; do
    resp=$(curl -sS -m $((POLL + 10)) -G "$API/getUpdates" \
      --data-urlencode "timeout=${POLL}" \
      --data-urlencode "offset=${offset}" \
      --data-urlencode 'allowed_updates=["message","channel_post"]' 2>/dev/null)

    [ -z "$resp" ] && continue
    [ "$(jq -r '.ok // false' <<<"$resp")" = "true" ] || continue

    max_id=$(jq -r '[.result[].update_id] | max // empty' <<<"$resp")
    if [ -n "$max_id" ]; then
      offset=$((max_id + 1))
      printf '%s' "$offset" >"$offset_file"
    fi

    reply=$(jq -r --arg cid "$TELEGRAM_CHAT_ID" '
      [ .result[]
        | (.message // .channel_post)
        | select(. != null)
        | select((.chat.id | tostring) == $cid)
        | .text // empty
      ] | join("\n")' <<<"$resp")

    if [ -n "$reply" ]; then
      printf '%s' "$reply"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# AskUserQuestion: forward every question's options as a numbered list.
# ---------------------------------------------------------------------------
if [ "$tool_name" = "AskUserQuestion" ]; then
  qcount=$(jq -r '.questions | length' <<<"$tool_input")

  msg="[$project] question(s) via Claude:"
  for i in $(seq 0 $((qcount - 1))); do
    q=$(jq -r ".questions[$i].question" <<<"$tool_input")
    msg+=$'\n'"$((i+1)). $q"
    opts=$(jq -r ".questions[$i].options | length" <<<"$tool_input")
    for j in $(seq 0 $((opts - 1))); do
      label=$(jq -r ".questions[$i].options[$j].label" <<<"$tool_input")
      msg+=$'\n'"   $((j+1))) $label"
    done
  done
  if [ "$qcount" -gt 1 ]; then
    msg+=$'\n\n'"Reply with one number per question, separated by ';' (e.g. 2;1). Waiting ${WAIT_SECONDS}s."
  else
    msg+=$'\n\n'"Reply with a number, or free text. Waiting ${WAIT_SECONDS}s."
  fi
  send "$msg"

  reply=$(wait_for_reply) || { send "No reply in ${WAIT_SECONDS}s — falling back to the normal prompt."; exit 0; }

  answer_text=""
  IFS=';' read -ra parts <<<"$reply"
  for i in $(seq 0 $((qcount - 1))); do
    part=$(echo "${parts[i]:-${parts[0]:-}}" | xargs)
    q=$(jq -r ".questions[$i].question" <<<"$tool_input")
    if [[ "$part" =~ ^[0-9]+$ ]]; then
      label=$(jq -r ".questions[$i].options[$((part-1))].label // empty" <<<"$tool_input")
      [ -n "$label" ] && part="$label"
    fi
    answer_text+="Q: $q -> $part"$'\n'
  done

  jq -nc --arg reason "Operator answered via Telegram:
$answer_text" '{
    decision: "block",
    reason: $reason
  }'
  exit 0
fi

# ---------------------------------------------------------------------------
# Everything else matched by the hook's matcher: a plain permission prompt.
# ---------------------------------------------------------------------------
case "$tool_name" in
  Bash) detail=$(jq -r '.command // empty' <<<"$tool_input") ;;
  Edit|Write) detail=$(jq -r '.file_path // empty' <<<"$tool_input") ;;
  *) detail="$tool_input" ;;
esac

send "[$project] wants to run $tool_name: ${detail:0:1500}

Reply yes/no. Waiting ${WAIT_SECONDS}s."

reply=$(wait_for_reply) || exit 0   # no reply -> fall through to the normal interactive prompt

case "$(echo "$reply" | tr '[:upper:]' '[:lower:]' | xargs)" in
  yes|y|allow|approve)
    jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:"Approved via Telegram"}}'
    ;;
  no|n|deny|block)
    jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Denied via Telegram"}}'
    ;;
  *)
    exit 0   # unrecognized -> fall through to the normal interactive prompt
    ;;
esac
