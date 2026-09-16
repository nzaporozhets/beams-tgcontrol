# Design note: multiple agents in one beam

**Status:** Draft for review — not implemented.
**Scope:** Running several independent Claude Code agent sessions inside *this* beam,
all reachable through the one Telegram bot §2.1 already requires per beam.
**Explicitly still out of scope** (unchanged from `instructions.md`): multi-beam
orchestration, a cross-beam gateway/relay, approval workflows for permissions.

Routing model chosen after review: **flat DM + a "focused" agent pointer** (not Telegram
forum topics). Rationale below.

---

## 1. Why flat DM, not forum topics

Telegram forum topics would give true visual separation (each agent its own thread), but
that requires converting the chat from a private DM into a supergroup with topics enabled
— a real Telegram-side setup step for the operator, plus topic lifecycle (create on spawn,
archive on kill) becomes the supervisor's job. It also complicates §2.2's whole pitch:
"no group, no topics, no chat id lookup."

The flat-DM approach keeps zero Telegram-side setup. Multiple agents' output interleaves in
one stream, distinguished by an `[agentName]` prefix on every message, plus a "focused"
agent that plain messages route to by default. This is the right v1 given the plan is for
a handful of concurrent agents on one beam (memory/CPU bound anyway, see §7), not dozens
— if that changes, forum topics is the natural v2 and nothing here forecloses it (the
prefix-tag convention maps cleanly onto "topic name" later).

---

## 2. New core abstraction: `AgentRegistry`

Today `main.ts` constructs exactly one `AgentSession`, one `TurnRenderer`, and one
`Checkpoint`, all implicitly "the" agent. That collapses into a registry:

```ts
interface AgentEntry {
  name: string;
  agent: AgentSession;
  renderer: TurnRenderer;
  checkpoint: Checkpoint;
  status: 'running' | 'stopped';
}

class AgentRegistry {
  private agents = new Map<string, AgentEntry>();
  private focused: string | null = null;

  spawn(name: string, opts: AgentOptions): AgentEntry
  stop(name: string): void        // interrupts + closes the SDK session, marks 'stopped'
  get(name: string): AgentEntry | undefined
  list(): AgentEntry[]
  setFocused(name: string): void
  getFocused(): AgentEntry | undefined
}
```

`TelegramClient`, `QuestionManager`, and `CommandRouter` become singletons shared across
all agents (unchanged — one bot, one poller, one command dispatcher); `AgentSession`,
`TurnRenderer`, and `Checkpoint` become one-per-agent, held by the registry.

---

## 3. File-by-file changes

### `src/state.ts`
Schema grows from a flat single-agent shape to a keyed one:

```ts
interface SupervisorState {
  offset: number;
  chatId: number | null;
  focused: string | null;
  agents: Record<string, { sessionId: string | null; cwd: string; model: string; effort: EffortLevel; status: 'running' | 'stopped' }>;
}
```

Needs a one-time migration on load: if the old flat `sessionId` field is present and
`agents` is absent, wrap it into `agents: { default: { sessionId, ... } }` and set
`focused: 'default'`, so an in-place upgrade doesn't strand an existing session.

### `src/agent.ts`
Mostly unchanged — `AgentSession` is already a clean one-session-per-instance class with
its own `cwd`, `canUseTool`, `resume`, etc. The only real change: it needs a `name` field
threaded through so downstream consumers (renderer, question prefixing, checkpoint ref
naming) can tag output without the registry having to do a reverse lookup on every message.

### `src/questions.ts`
`QuestionManager.ask()` already returns per-call batches keyed by a random `batchId`, so
concurrent asks from different agents don't collide today. Two changes:
- `ask(input, agentName)` takes the asking agent's name and prefixes the rendered question
  text with `[agentName]` — without this, a question from a backgrounded agent is
  indistinguishable from one out of the focused agent.
- The 30-minute re-ping (§5.2) should include the agent name for the same reason.

No change to the single-transition state machine, ack timing, or force-reply handling —
those are already per-batch and don't care how many agents exist.

### `src/checkpoint.ts`
Splits one responsibility into two:
- **Per-agent periodic push** stays as-is structurally, one `Checkpoint` instance per agent,
  pushing to `refs/agents/<beam>/<agentName>` instead of `refs/agents/<beam>` (namespaced,
  so two agents' work doesn't collide on one ref). A `/rename` doesn't rewrite history on
  the old ref — it just points future pushes at the new ref name; the old one is simply
  abandoned (harmless, matches how `/rename` treats everything else: relabel going forward,
  don't try to migrate the past).
- **TTL warning (T-60m/T-15m)** stops being a `Checkpoint`-owned timer and becomes a
  beam-level `TTLScheduler` that, at each threshold, iterates the registry and forces a push
  on every agent's `Checkpoint`, then sends one warning message (not one per agent).

### `src/commands.ts`
Every command that currently assumes "the" agent takes an optional `<name>` argument,
defaulting to the focused agent:

| Command | Change |
| --- | --- |
| `/agents` | **New.** List all agents: name, cwd, model, effort, status, focused marker. |
| `/new <name> [cwd]` | **New.** Spawn an agent (registry.spawn), cwd defaults to `WORK_DIR/<name>`. |
| `/switch <name>` | **New.** Sets the focused agent; plain messages route to it. |
| `/kill <name>` | **New.** `registry.stop(name)` — interrupts, closes the session, marks stopped so a supervisor restart doesn't resume it. |
| `/rename <old> <new>` | **New.** Relabels a live agent: `registry.rename(old, new)` moves its `AgentEntry` to the new map key, rewrites `state.agents[new]` (deleting the `old` entry), and updates `focused` if `old` was focused. The running `AgentSession`/SDK session is untouched — this only changes the name it's addressed by. Rejects if `new` already exists or collides with a reserved word (model/effort value, `default`). |
| `/model [name] <value>` | Name optional, defaults to focused. |
| `/effort [name] <value>` | Same. |
| `/settings [name]` | Same; keyboard callback_data gains the agent name (`s:<name>:model:opus`). |
| `/interrupt [name]` | Same. |
| `/checkpoint [name]` | Same; omitting name checkpoints *all* agents. |
| `/logs [name] [n]` | Name optional — log file becomes per-agent (`agent-<name>.log`) or a shared file grepped by prefix; per-agent files are simpler and match the tmux-per-agent-window idea in §6. |
| `/restart [name]` | Same. |
| `/status` | Becomes an alias for `/agents` plus beam-level info (TTL, tmux/beamctl state). |
| `/cost [name]` | Name optional, defaults to focused; omitting could also mean "sum across all." |

Argument parsing needs a small update: today `/model sonnet` has one arg (the value); now
`/model sonnet` (implicit focused) and `/model backend sonnet` (explicit) must both parse.
Simplest rule: if the first token matches a known agent name, treat it as the name;
otherwise treat the whole remainder as the value for the focused agent. Ambiguous only if
an agent is literally named `sonnet` — worth rejecting agent names that collide with known
model/effort values at `/new` time.

### `src/main.ts`
Startup no longer builds one `AgentSession` from env vars directly. Instead:
- Build the shared singletons (`tg`, `questions`, `checkpoint` factory, `commandRouter`).
- On boot, read `state.agents`, and for every entry with `status: 'running'`, call
  `registry.spawn(name, {...persisted opts, resume: sessionId})` — this is what makes a
  supervisor restart resume *all* previously-running agents, not just one.
- If `state.agents` is empty (fresh install), spawn a single agent named `default` from the
  existing env vars (`CLAUDE_MODEL`, `CLAUDE_EFFORT`, `WORK_DIR`), so the zero-config
  single-agent case — which is most of the actual usage today — needs no new commands.
- The plain-message listener's routing rule changes from "always `agent.send(text)`" to
  "route to `registry.getFocused()`," and should reply with an error (not silently drop) if
  no agent is focused (e.g., all killed).

### `src/telegram.ts`
No changes. It's already agent-agnostic transport; multiplexing is entirely an
above-the-transport concern, which is the right layering — §2.1's "one bot, one poller"
constraint is unaffected by how many agents sit behind it.

---

## 4. Resource and safety considerations

Each `AgentSession` wraps one `query()` call, which the SDK backs with its own `claude`
CLI subprocess — N agents means N subprocesses, each with its own memory footprint and
model-call concurrency. On a beam with finite CPU/RAM this needs a cap:
- `MAX_AGENTS` env var (default something small, e.g. 4), enforced in `/new` — reject with
  a clear error rather than degrading every agent's performance silently.
- `/agents` should show enough (a rough token-usage or turn count per agent) that the
  operator can judge when to `/kill` something rather than spawn more.
- Port 8080 stays reserved beam-wide (§4.1's existing system-prompt rule) — no per-agent
  change, since it's a beam-level constraint, not a per-session one.

## 5. Failure modes worth deciding on explicitly (not implementing yet)

- **Duplicate `/new` name**: reject, don't silently reuse or suffix.
- **`/kill` on the focused agent**: falls back to `focused: null`; plain messages should
  error with "no focused agent — /switch <name>" rather than silently going nowhere.
- **Agent process crash** (not an explicit `/kill`): current single-agent code has no
  watchdog (open question #3 in `instructions.md` is still open). For multi-agent this gets
  more visible — one crashed agent among several shouldn't take down the supervisor process;
  each `AgentSession`'s `consume()` loop already isolates errors per-instance (`try/catch`
  around the `for await`), so this mostly already holds, but needs an explicit
  `status: 'crashed'` distinct from `'stopped'` so `/restart` behaves predictably (retry)
  vs. a deliberate `/kill` (don't auto-resume).
- **AskUserQuestion from a backgrounded (non-focused) agent**: still renders and blocks that
  agent's turn regardless of focus — focus only affects where *plain messages* go, not where
  questions get asked. Worth confirming that's the intended semantics (it matches "the agent
  is genuinely blocked, no safe default" from §5.2).
- **`/rename` mid-flight**: any question already sent for the agent being renamed keeps the
  *old* name baked into its already-rendered `[oldName]` prefix (Telegram messages already
  sent aren't retroactively edited) — only messages sent after the rename use the new name.
  Same for an in-progress `TurnRenderer` message. Cosmetic only, not a correctness issue, but
  worth documenting so it isn't mistaken for a bug during testing.

## 6. Suggested rollout (mirrors `instructions.md`'s milestone style)

- **MA0** — `state.ts` schema migration + `AgentRegistry` skeleton (spawn/stop/list, no
  Telegram wiring yet). Verify the single-`default`-agent zero-config path still works
  unchanged.
- **MA1** — `/agents`, `/new`, `/switch`, `/kill`, `/rename`, focused-agent message routing.
- **MA2** — Per-agent `[name]`-prefixed rendering and question text; per-agent log files.
- **MA3** — Per-agent checkpoint ref namespacing + beam-level `TTLScheduler` split; `MAX_AGENTS`
  cap.

Each milestone is independently shippable and testable the same way M0–M4 were validated for
v0: live, against a real bot, not unit tests.
