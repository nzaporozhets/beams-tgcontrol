# claude-telegram

Drive a headless Claude Code agent, running unattended in this beam, entirely from a
Telegram chat: send instructions, read output, answer the agent's questions, change model
and effort. See `instructions.md` for the full design.

## Quickstart

```bash
git clone <repo> /home/beams/claude-telegram
cd /home/beams/claude-telegram && ./install.sh   # writes ~/.claude-telegram.env
$EDITOR ~/.claude-telegram.env                   # bot token + your numeric Telegram id
```

`install.sh` prints the exact launch command for this beam. It uses `beamctl start` where
available (some beam images only). Many beams instead have a plain `dumb-init` as PID 1
with no `beamctl` at all -- there, `install.sh` falls back to `tmux`, which is the standard
substitute for "keep running after I disconnect" when no service manager is exposed to the
user:

```bash
tmux new-session -d -s agent -c /home/beams/work \
  "HOME=/home/beams node /home/beams/claude-telegram/dist/main.js >> /home/beams/.claude-telegram/agent.log 2>&1"
```

`tmux attach -t agent` to watch it live (detach with `Ctrl-b d`, it keeps running),
`tmux kill-session -t agent` to stop it.

Then DM your bot on Telegram and send `/start`. Only the `TELEGRAM_OWNER_ID` you configured
will be accepted; everything else is rejected and logged.

### Getting a bot token and your user id

- Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token into
  `TELEGRAM_BOT_TOKEN`. One bot per beam -- see §2.1 of `instructions.md` for why.
- Message [@userinfobot](https://t.me/userinfobot) to get your numeric id for
  `TELEGRAM_OWNER_ID`. Not your `@username` -- usernames are reassignable.

## Commands

| Command | Effect |
| --- | --- |
| `/status` | Beam name, cwd, model, effort, time to expiry, tmux/beamctl session state |
| `/model <name>` | Change model for subsequent turns |
| `/effort <level>` | Change effort for subsequent turns |
| `/settings` | Inline keyboard over model and effort |
| `/interrupt` | Interrupt the current turn, keep the session |
| `/checkpoint` | Force a commit and push now |
| `/logs [n]` | Tail of `~/.claude-telegram/agent.log`, as an attachment if long |
| `/restart` | Restart the agent, resuming from the transcript |
| `/cost` | Client-side cost estimate |

## Operational notes

- Under tmux, `tmux attach -t agent` or `tail -f ~/.claude-telegram/agent.log` is the
  debugging path if the supervisor won't start. Under beamctl, `beamctl logs agent --follow`
  and `beamctl list`.
- Everything not pushed to a remote is gone when the beam is purged. The supervisor pushes
  dirty work in `WORK_DIR` (default `/home/beams/work`) to `refs/agents/<beam alias>` every
  15 minutes, plus at T-60m and T-15m before expiry.
- Operator state (Telegram update offset, bound chat id, last session id) lives in
  `~/.claude-telegram/state.json`, separate from `WORK_DIR` so it never gets swept into a
  commit.

## Development

```bash
npm install
npm run build   # tsc -> dist/
node dist/main.js
```

No automated test suite -- this is thin glue between two live services (Telegram, the
Agent SDK) with nothing meaningful to unit-test without both running. Verify by running it
against a real bot.
