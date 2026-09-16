#!/usr/bin/env bash
# Claude Code <-> Telegram, two-way.
#
# Two roles in one file:
#   1. Stop hook (no args)  - posts the turn summary, long-polls for your reply,
#                             feeds the reply back to Claude as its next instruction.
#   2. Runner (--run)       - self-invocation that starts a fresh headless session
#                             and reports the result back to Telegram.
#
# Telegram commands:
#   /done                       let the current turn end
#   /new <prompt>               new session in $TELEGRAM_PROJECT_DIR
#   /new /path/to/repo <prompt> new session in that directory
#   /resume <prompt>            continue the last session started this way
#   /resume <session-id> <prompt>
set -uo pipefail

[ -f "$HOME/.claude/telegram.env" ] && . "$HOME/.claude/telegram.env"
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
: "${TELEGRAM_CHAT_ID:?set TELEGRAM_CHAT_ID}"

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
WAIT_SECONDS=${TELEGRAM_WAIT_SECONDS:-300}   # keep < the hook's timeout in settings.json
POLL=30                                       # Telegram long-poll window
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claude-telegram"
LOG_DIR="$STATE_DIR/sessions"
mkdir -p "$STATE_DIR" "$LOG_DIR"

CLAUDE_BIN=${CLAUDE_BIN:-claude}
PROJECT_DIR=${TELEGRAM_PROJECT_DIR:-$HOME}
PERMISSION_MODE=${TELEGRAM_PERMISSION_MODE:-acceptEdits}
MAX_TURNS=${TELEGRAM_MAX_TURNS:-40}

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

send() {
  curl -sS -m 15 -X POST "$API/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${1:0:4000}" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Runner: blocks for the whole headless run, so it is always spawned detached.
# ---------------------------------------------------------------------------
run_session() {
  local dir="$1" prompt="$2" resume="${3:-}"
  local stamp log err
  stamp=$(date +%Y%m%d-%H%M%S)
  log="$LOG_DIR/$stamp.json"
  err="$LOG_DIR/$stamp.err"

  cd "$dir" 2>/dev/null || { send "Could not enter $dir"; return 1; }

  local args=(-p "$prompt"
              --output-format json
              --permission-mode "$PERMISSION_MODE"
              --max-turns "$MAX_TURNS")
  [ -n "$resume" ] && args+=(--resume "$resume")

  # CLAUDE_TG_CHILD stops the spawned session's own Stop hook from starting
  # yet another session. A -p run loads the hooks in ~/.claude like any other.
  CLAUDE_TG_CHILD=1 "$CLAUDE_BIN" "${args[@]}" >"$log" 2>"$err"
  local rc=$?

  local result sid
  if [ $rc -eq 0 ] && jq -e . "$log" >/dev/null 2>&1; then
    result=$(jq -r '.result // "(no result field)"' "$log")
    sid=$(jq -r '.session_id // empty' "$log")
    [ -n "$sid" ] && printf '%s' "$sid" >"$STATE_DIR/last-session"
    send "[$(basename "$dir")] done.

${result}

/resume <message> to continue (${sid:-no id})"
  else
    send "[$(basename "$dir")] run failed, exit $rc

$(tail -c 700 "$err" 2>/dev/null || tail -c 700 "$log" 2>/dev/null)"
  fi
  return $rc
}

# Fire-and-forget wrapper. Returns immediately so the Stop hook never sits
# inside a session that could outlive the hook's timeout.
start_session() {
  local dir="$1" prompt="$2" resume="${3:-}"

  if [ ! -d "$dir" ]; then
    send "No such directory: $dir"
    return 1
  fi
  if [ -z "${prompt// /}" ]; then
    send "Give me a prompt, e.g. /new fix the failing auth tests"
    return 1
  fi
  if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
    send "claude binary not found on PATH (set CLAUDE_BIN)"
    return 1
  fi

  if command -v setsid >/dev/null 2>&1; then
    setsid "$SELF" --run "$dir" "$prompt" "$resume" </dev/null >/dev/null 2>&1 &
  else
    # macOS has no setsid
    nohup "$SELF" --run "$dir" "$prompt" "$resume" </dev/null >/dev/null 2>&1 &
  fi
  disown 2>/dev/null

  send "Starting${resume:+ (resuming)} in $(basename "$dir"): $prompt"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--run" ]; then
  run_session "${2:-}" "${3:-}" "${4:-}"
  exit $?
fi

# Never let a session we spawned spawn another one.
if [ -n "${CLAUDE_TG_CHILD:-}" ]; then
  exit 0
fi

input=$(cat)
session=$(jq -r '.session_id // "unknown"' <<<"$input")
offset_file="$STATE_DIR/offset"

# 1. Report the turn.
project=$(basename "$(jq -r '.cwd // "."' <<<"$input")")
summary=$(jq -r '.last_assistant_message // "Turn finished."' <<<"$input")
send "[$project] $summary

Reply with your next instruction, /new <prompt> to start a separate session, or /done to stop. Waiting ${WAIT_SECONDS}s."

# 2. Wait for a reply.
offset=$(cat "$offset_file" 2>/dev/null || echo 0)
deadline=$(( $(date +%s) + WAIT_SECONDS ))

while [ "$(date +%s)" -lt "$deadline" ]; do
  resp=$(curl -sS -m $((POLL + 10)) -G "$API/getUpdates" \
    --data-urlencode "timeout=${POLL}" \
    --data-urlencode "offset=${offset}" \
    --data-urlencode 'allowed_updates=["message","channel_post"]' 2>/dev/null)

  if [ -z "$resp" ] || [ "$(jq -r '.ok // false' <<<"$resp")" != "true" ]; then
    sleep 3
    continue
  fi

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

  if [ -z "$reply" ]; then
    continue
  fi

  case "$reply" in
    /done|/stop|/quit)
      send "Ending the turn."
      exit 0
      ;;

    "/new "*)
      rest=${reply#/new }
      dir=$PROJECT_DIR
      first=${rest%% *}
      case "$first" in
        /*|'~'/*)
          cand=${first/#\~/$HOME}
          if [ -d "$cand" ]; then
            dir=$cand; rest=${rest#* }
          else
            send "No such directory: $cand"
            exit 0
          fi
          ;;
      esac
      start_session "$dir" "$rest"
      exit 0
      ;;

    "/resume "*)
      rest=${reply#/resume }
      first=${rest%% *}
      # A session id is a UUID; anything else is the start of the prompt.
      if [[ $first =~ ^[0-9a-fA-F-]{32,}$ ]]; then
        sid=$first
        rest=${rest#* }
      else
        sid=$(cat "$STATE_DIR/last-session" 2>/dev/null)
      fi
      if [ -z "$sid" ]; then
        send "No session to resume yet — use /new first."
        exit 0
      fi
      start_session "$PROJECT_DIR" "$rest" "$sid"
      exit 0
      ;;
  esac

  # Plain text: hand it to the session that is already running.
  jq -nc --arg r "$reply" --arg s "$session" '{
    decision: "block",
    reason: ("The operator replied over Telegram (session " + $s + "): " + $r)
  }'
  exit 0
done

send "No reply in ${WAIT_SECONDS}s — stopping."
exit 0
