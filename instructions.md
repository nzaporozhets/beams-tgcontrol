# Design: Telegram control for Claude Code in a beam (v0)

**Status:** Draft for implementation
**Audience:** Claude Code, as an implementation brief
**Scope:** One beam, one operator, manual provisioning

---

## 1. Scope

### In

A repository that is cloned into an already-running beam, installed with one script, and
started with one command. After that, the operator drives the agent entirely from a
Telegram chat: send instructions, read output, answer the agent's questions, change model
and effort.

### Explicitly out, this iteration

- Creating, listing, or destroying beams. The operator runs `tsh beams add` by hand.
- Any Teleport API interaction from the running code. The only Teleport-adjacent thing
  in-beam is `beamctl`, which is a local process manager, not a cluster client.
- Multi-beam orchestration, forum-topic routing, session registry, gateway service.
- Approval workflow for permissions. Dangerous permissions are accepted (§3.2).

### Assumption being relied on

The beam's delegated identity carries a minimal privilege set with no access to sensitive
infrastructure. The design leans on this and would need §3.2 revisited if it stops holding.

One caveat worth registering rather than arguing: beta beams have unrestricted public
internet egress, so "no sensitive infrastructure" bounds the Teleport-protected blast
radius, not the total one. Whatever credentials get cloned or installed into the beam — a
GitHub token, an npm token in a `.npmrc` — are reachable by an agent running with
permissions off. Worth a glance at what the install step actually puts on the box.

---

## 2. Topology

Everything runs inside the beam. There is no external service.

```
┌─ beam (warm-orbit) ──────────────────────────┐
│                                              │
│  beam-init (PID 1)                           │
│    └─ service: agent                         │
│         └─ supervisor (Node)                 │
│              ├─ Agent SDK ─► claude session  │
│              └─ Telegram poller ─┐           │
│                                  │           │
└──────────────────────────────────┼───────────┘
                                   │ HTTPS (egress)
                                   ▼
                            api.telegram.org
                                   │
                                   ▼
                          operator's phone
```

Polling, not webhooks. A webhook needs Telegram to reach an inbound URL; the beam's only
published surface goes through the Teleport Proxy with authentication, which Telegram
cannot satisfy. Long-poll `getUpdates` with `timeout=30`.

### 2.1 One bot per beam

**`getUpdates` allows a single consumer per bot token.** Two beams polling the same token
means one silently steals the other's messages and both see intermittent HTTP 409. There is
no in-band fix.

So: one BotFather bot per beam. It takes about thirty seconds to create, the token goes in
the beam's env file, and the operator DMs that bot directly — no group, no topics, no chat
id lookup. If concurrent beams later become routine, that is the point to introduce a
relay outside the beams and revisit forum topics; do not build for it now.

### 2.2 Binding the chat

Avoid making the operator look up a chat id. Require `TELEGRAM_OWNER_ID` (their numeric
Telegram user id) in the env file. On startup the supervisor polls for `/start`, accepts it
only from that id, persists the resulting `chat.id`, and greets with the beam name:

```
Connected — warm-orbit
/home/beams/work · opus · effort high
expires 2027-02-05 22:04 UTC (23h 41m)
```

Numeric id, not username: usernames are reassignable. Reject and log everything else.

---

## 3. Agent driver

### 3.1 Why the SDK is still required

Dangerous permissions remove the confirmation flow, which was most of the earlier
justification. One thing survives it: **`AskUserQuestion`**.

When the agent needs a decision it cannot make alone, it calls `AskUserQuestion`. In a
plain `-p` run with no permission host, requests that need a human are denied — the agent
is told nobody can answer and moves on, usually by guessing. A `PreToolUse` hook does not
rescue this: it can deny with a reason but cannot return a chosen option, so the answer
arrives through an error channel and lands in the transcript as a refusal.

The Agent SDK's `canUseTool` callback can return `{ behavior: 'allow', updatedInput:
<selection> }`, making the operator's tap the tool's actual input. That is the only clean
path, and it is why v0 is a supervisor wrapping the SDK rather than a shell script around
`claude -p`.

The CLI fallback, if the SDK cannot be installed, is `claude -p --input-format stream-json
--output-format stream-json`. It gives bidirectional messaging but no good answer for
questions. Treat it as a degraded mode.

### 3.2 Permission mode: prefer `auto` over full bypass

Dangerous permissions are accepted, but `bypassPermissions` is probably not the right
setting even so.

`canUseTool` is invoked when a tool call needs a permission decision. Under
`bypassPermissions` nothing needs one, so there is a real chance the callback is never
invoked — **including for `AskUserQuestion`** — which would silently remove the question
channel that §3.1 exists to build.

I have not been able to confirm the behaviour either way, so treat it as the first thing to
test in M0: run with `bypassPermissions`, have the agent call `AskUserQuestion`, and check
whether `canUseTool` fires.

Default to `auto` until that test comes back. The classifier approves routine work without
prompting, so in practice it behaves close to bypass for a minimal-privilege workload,
while keeping `canUseTool` wired. Route anything it does escalate straight to an auto-allow
in the callback, logged to the chat as a one-liner rather than a prompt:

```
⚡ auto-allowed: Bash npm publish --access public
```

That keeps the operator informed without putting a button in front of them, and it is a
two-line change to turn back into a real confirmation later.

Never pass `--permission-prompts none`: it explicitly removes the tools that need a human
answer, `AskUserQuestion` among them.

---

## 4. Recommended launch parameters

The supervisor maps these to SDK options; names differ slightly from the CLI flags, so
check the SDK reference. Rationale is the point here, not the exact spelling.

| Parameter | Value | Why |
| --- | --- | --- |
| permission mode | `auto` | §3.2 — keeps `canUseTool` live |
| `canUseTool` | supervisor callback | The question channel |
| cwd | `/home/beams/work` | Beam home is `/home/beams` |
| model | `opus` | Unattended work is where capability pays; exposed as `/model` |
| fallback model | `sonnet` | Print-mode only; avoids a 24h run dying on overload |
| effort | `high` | Default; exposed as `/effort` |
| `--bare` | **off** | Bare skips hook, skill, and MCP discovery — you cloned a repo specifically to get those. Also does not read OAuth credentials |
| `--allowedTools` | unset | Redundant under `auto` |
| `--max-turns` | unset | This is a supervised session, not a CI job |
| `--append-system-prompt` | §4.1 | Highest-leverage parameter here |

### 4.1 System prompt addition

This is what actually tunes behaviour for remote supervision, and it is worth more than any
flag:

```
You are running unattended inside a Teleport beam. The operator supervises you over
Telegram and may take many minutes to reply.

- Batch clarifying questions. Use a single AskUserQuestion with concrete options rather
  than asking one thing at a time; each round trip may cost the operator twenty minutes.
- The beam is destroyed 24 hours after creation and its filesystem is not preserved.
  Commit and push to the remote at every meaningful milestone, not at the end.
- End each turn with a two-or-three line status: what changed, what is next, what is
  blocked. It will be read on a phone screen.
- Do not bind anything to port 8080; it is reserved.
```

The batching instruction matters most. Default Claude Code asks questions one at a time
because a human is a keystroke away. Over Telegram that pattern is the difference between a
task finishing overnight and stalling on turn three.

### 4.2 Launch

```bash
tsh beams add                                    # operator, by hand
git clone <repo> /home/beams/claude-telegram
cd /home/beams/claude-telegram && ./install.sh   # writes ~/.claude-telegram.env
$EDITOR ~/.claude-telegram.env                   # bot token + owner id

beamctl start --name=agent -- bash -c '
  export HOME=/home/beams
  cd /home/beams/work
  exec node /home/beams/claude-telegram/dist/main.js'
```

`beamctl start` is what makes the agent survive the operator closing their SSH session —
that is the documented mechanism for long-running agent workloads on a beam, and the whole
point of this project.

`beamctl` notes for the implementation: `stop` retains the service name unless you pass
`--prune`, so a restart with the same name fails after a plain stop. `beamctl logs agent
--follow` is the debugging path when the supervisor won't start, and `beamctl list` shows
service state. Wire `/logs` and `/restart` to these.

---

## 5. Telegram protocol

### 5.1 Plain messages

A plain message is a user turn: push it into the agent's input stream. If the agent is
mid-turn, queue it and inject at the turn boundary rather than interleaving.

### 5.2 Questions

`AskUserQuestion` renders as an inline keyboard. Single-select resolves on press;
multi-select keeps toggle state in memory, re-renders with `editMessageReplyMarkup`, and
resolves on Submit.

```
❓ Which database should the migration target?

[ Postgres 16 ]
[ Postgres 15 (current prod) ]
[ ✍️ Type an answer ]
```

Implementation requirements:

- `callback_data` caps at **64 bytes**. Carry an opaque id (`q:<short>`); state lives in
  memory.
- **`answerCallbackQuery` within ~2s** of any press or the client shows a stuck spinner.
  Acknowledge first, act second.
- Single-transition state machine per question. A press on a resolved question answers
  "already answered" and changes nothing — stale buttons in scrollback are a real hazard.
- `editMessageText` after resolution to show the choice and drop the keyboard.
- No timeout. The agent is genuinely blocked and there is no safe default answer; let it
  wait. Re-ping the chat once at 30 minutes.
- "Type an answer" sets `force_reply`, parks the question, resolves on
  `reply_to_message.message_id`.

### 5.3 Output

Telegram tolerates roughly one message per second per chat. Do not forward raw SDK
messages.

- One message per turn for assistant text, updated via `editMessageText` at most every 3s.
- Tool calls as a collapsed line: `🔧 Edit src/auth.ts · 🔧 Bash npm test`.
- Separate messages only for: turn end, questions, errors, TTL warnings.
- Tool output over ~800 chars → preview plus the full text as a document attachment.
- Never interpolate agent output into Markdown without escaping; leave `parse_mode` unset
  unless there is a reason not to.

### 5.4 Commands

Register these with `setMyCommands` at startup so Telegram shows autocomplete — cheap, and
it removes most of the friction of typing commands on a phone.

| Command | Effect |
| --- | --- |
| `/status` | Beam name, cwd, model, effort, time to expiry, `beamctl list` |
| `/model <name>` | Inject `/model <name>` as a user turn |
| `/effort <level>` | Inject `/effort <level>` as a user turn |
| `/settings` | Inline keyboard over model and effort — worth more than the two above |
| `/interrupt` | Interrupt the current turn, keep the session |
| `/checkpoint` | Force a commit and push now |
| `/logs [n]` | `beamctl logs agent` tail as an attachment |
| `/restart` | Restart the agent, resuming from the transcript |
| `/cost` | Client-side estimate from result messages |

### 5.5 Configuration mechanics

Effort levels are `low`, `medium`, `high`, `xhigh`, `max`, `auto`.

Mid-session changes to both model and effort go in as injected user turns — `/model
sonnet`, `/effort xhigh`. In print mode these commands take their value as an argument
(v2.1.205+). There is no in-process API for either, and `CLAUDE_CODE_EFFORT_LEVEL` is read
at process start rather than per turn, so the env var is useless for live changes. `max` is
session-only unless set through that env var.

Inference in a beam is proxied by Teleport with credentials injected at the VNet layer.
Whether that proxy allowlists specific models is not documented. If `/model` fails, report
the error to the chat rather than falling back silently — a silent switch to a different
model is worse than an error.

---

## 6. The 24-hour expiry

Beams are purged 24 hours after creation, and with provisioning out of scope the supervisor
cannot migrate to a fresh one. What it can do is make sure nothing is lost.

```
every 15 min   if the working tree is dirty: commit to refs/agents/<beam>, push
T-60m          push, then: "warm-orbit expires in 60 minutes. Work is pushed to
               refs/agents/warm-orbit. Run `tsh beams add` and clone from there."
T-15m          push again, repeat the warning
```

Read the expiry from `tsh beams ls` once at startup and hold it in memory rather than
polling — `tsh` is available in the beam and authenticated with the delegated identity, and
one read at boot does not count as orchestration.

Periodic push is the whole safety net in v0. The 22 GiB ephemeral disk and the transcript
both vanish with the VM, so anything not on a remote is gone. Make the interval short and
the commit messages boring.

---

## 7. Repository layout

```
claude-telegram/
├── install.sh              # deps, build, write env template, print next steps
├── .env.example            # TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID, CLAUDE_MODEL...
├── src/
│   ├── main.ts             # wiring, startup, /start binding
│   ├── agent.ts            # SDK query loop, input stream, canUseTool
│   ├── telegram.ts         # long-poll, offset persistence, send/edit helpers
│   ├── questions.ts        # AskUserQuestion → keyboard → selection
│   ├── commands.ts         # §5.4
│   └── checkpoint.ts       # §6
├── .claude/
│   ├── settings.json       # hooks the agent should load (not the Telegram ones)
│   └── skills/             # anything task-specific
└── README.md
```

`install.sh` should be idempotent, check for `claude` on PATH (preinstalled on beams),
install Node deps, build, write `~/.claude-telegram.env` from the template if absent, and
finish by printing the exact `beamctl start` line with paths filled in. The operator has
just SSHed into a fresh VM; the script should leave them one copy-paste from running.

---

## 8. Milestones

**M0 — Answer the `bypassPermissions` question (§3.2).** Half a day. It decides the
permission mode and whether §3.1 holds at all. Do it before writing the supervisor.

**M1 — One-way.** Supervisor starts under `beamctl`, runs an agent turn, streams coalesced
output to Telegram, `/start` binding, `/status`.

**M2 — Two-way.** Plain messages as user turns, input queueing at turn boundaries,
`/interrupt`.

**M3 — Questions.** `canUseTool` → inline keyboards, single and multi-select, typed
answers, idempotency. *This is the milestone that makes the thing usable unattended.*

**M4 — Survival and config.** Periodic push, TTL warnings, `/settings`, `/model`,
`/effort`, `/logs`, `/restart`.

---

## 9. Open questions

1. **Does `canUseTool` fire under `bypassPermissions`, specifically for
   `AskUserQuestion`?** Gates §3.2 and M0.
2. Does the Teleport LLM proxy allowlist models, and what does a disallowed `/model`
   return (§5.5)?
3. Does `beam-init` restart a crashed service automatically, or does the supervisor need a
   watchdog? `beamctl restart` exists; whether anything calls it on its own is unclear.
4. Can the SDK interrupt a turn cleanly mid-tool-call, and what does the transcript look
   like afterward (`/interrupt`, §5.4)?
5. Does `--fallback-model` apply in SDK streaming mode, or only to one-shot print runs?
