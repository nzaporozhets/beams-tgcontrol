#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HOME/.claude-telegram.env"

echo "== claude-telegram install =="

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' not found on PATH (expected preinstalled on the beam)" >&2
  exit 1
fi
echo "claude: $(claude --version)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH" >&2
  exit 1
fi
echo "node: $(node --version)"

# beamctl only works when beam-init is PID 1 (some beam images use a plain
# dumb-init instead); fall back to tmux for surviving SSH disconnects there.
if [ -e /run/beam-init ] && command -v beamctl >/dev/null 2>&1; then
  LAUNCHER=beamctl
elif command -v tmux >/dev/null 2>&1; then
  LAUNCHER=tmux
  echo "note: beamctl unavailable on this beam (no /run/beam-init) -- using tmux instead"
else
  echo "error: neither beamctl nor tmux is available to keep the supervisor alive after you disconnect" >&2
  exit 1
fi

cd "$REPO_DIR"
echo "-- npm install"
npm install

echo "-- build"
npm run build

if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO_DIR/.env.example" "$ENV_FILE"
  echo "wrote $ENV_FILE from .env.example -- fill in TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID"
else
  echo "$ENV_FILE already exists, leaving it alone"
fi

mkdir -p "$HOME/.claude-telegram" "$HOME/work"

if [ "$LAUNCHER" = beamctl ]; then
  LAUNCH_CMD="beamctl start --name=agent -- bash -c '
     export HOME=$HOME
     cd $HOME/work
     exec node $REPO_DIR/dist/main.js'"
  LOGS_HINT="beamctl logs agent --follow"
else
  LAUNCH_CMD="tmux new-session -d -s agent -c $HOME/work \\
     \"HOME=$HOME node $REPO_DIR/dist/main.js >> $HOME/.claude-telegram/agent.log 2>&1\""
  LOGS_HINT="tmux attach -t agent   # or: tail -f $HOME/.claude-telegram/agent.log"
fi

cat <<EOF

== next steps ==
1. \$EDITOR $ENV_FILE
2. $LAUNCH_CMD
3. DM your bot on Telegram, send /start
4. debugging: $LOGS_HINT
EOF
