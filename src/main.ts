import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { TTLScheduler } from './checkpoint.js';
import { COMMAND_LIST, CommandRouter } from './commands.js';
import { QuestionManager } from './questions.js';
import { AgentRegistry } from './registry.js';
import { StateStore } from './state.js';
import { TelegramClient, type TgMessage } from './telegram.js';

const exec = promisify(execFile);

const SYSTEM_PROMPT_APPEND = `You are running unattended inside a Teleport beam. The operator supervises you over
Telegram and may take many minutes to reply.

- Batch clarifying questions. Use a single AskUserQuestion with concrete options rather
  than asking one thing at a time; each round trip may cost the operator twenty minutes.
- The beam is destroyed 24 hours after creation and its filesystem is not preserved.
  Commit and push to the remote at every meaningful milestone, not at the end.
- End each turn with a two-or-three line status: what changed, what is next, what is
  blocked. It will be read on a phone screen.
- Do not bind anything to port 8080; it is reserved.`;

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function readBeamExpiry(uuid: string | undefined): Promise<Date | null> {
  if (!uuid) return null;
  try {
    const { stdout } = await exec('tsh', ['beams', 'ls', '--format', 'json']);
    const beams = JSON.parse(stdout) as { uuid: string; expires: string }[];
    const mine = beams.find((b) => b.uuid === uuid);
    return mine ? new Date(mine.expires) : null;
  } catch (err) {
    console.error('[main] tsh beams ls failed, TTL warnings disabled:', err);
    return null;
  }
}

async function bindChat(tg: TelegramClient, state: StateStore, ownerId: number): Promise<number> {
  const existing = state.get().chatId;
  if (existing !== null) return existing;
  return new Promise((resolve) => {
    const handler = (msg: TgMessage) => {
      if (msg.text?.trim() !== '/start') return;
      if (msg.from?.id !== ownerId) {
        console.warn(`[main] rejected /start from non-owner id=${msg.from?.id ?? 'unknown'}`);
        return;
      }
      tg.off('message', handler);
      state.update({ chatId: msg.chat.id });
      resolve(msg.chat.id);
    };
    tg.on('message', handler);
  });
}

async function main(): Promise<void> {
  loadEnvFile(join(homedir(), '.claude-telegram.env'));

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ownerIdRaw = process.env.TELEGRAM_OWNER_ID;
  if (!token || !ownerIdRaw) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID must be set in ~/.claude-telegram.env');
    process.exit(1);
  }
  const ownerId = Number.parseInt(ownerIdRaw, 10);
  if (!Number.isFinite(ownerId)) {
    console.error(`TELEGRAM_OWNER_ID must be numeric, got ${ownerIdRaw}`);
    process.exit(1);
  }

  const workDir = process.env.WORK_DIR ?? '/home/beams/work';
  mkdirSync(workDir, { recursive: true });

  const beamAlias = process.env.BEAM_ALIAS ?? 'beam';
  const expiresAt = await readBeamExpiry(process.env.BEAM_ID);

  const stateDir = join(homedir(), '.claude-telegram');
  const state = new StateStore(join(stateDir, 'state.json'));
  const logPath = process.env.SUPERVISOR_LOG_PATH ?? join(stateDir, 'agent.log');
  const tmuxSession = process.env.TMUX_SESSION_NAME ?? 'agent';

  const tg = new TelegramClient(token, state);
  tg.start();
  await tg.setMyCommands(COMMAND_LIST);

  const wasBound = state.get().chatId !== null;
  const chatId = await bindChat(tg, state, ownerId);
  const getChatId = () => state.get().chatId;
  const notify = (text: string) => {
    const id = getChatId();
    if (id !== null) tg.sendMessage(id, text).catch((err) => console.error('[main] notify failed:', err));
  };

  const questions = new QuestionManager(tg, getChatId, notify);

  const defaultModel = process.env.CLAUDE_MODEL ?? 'opus';
  const defaultFallbackModel = process.env.CLAUDE_FALLBACK_MODEL ?? 'sonnet';
  const defaultEffort = (process.env.CLAUDE_EFFORT as EffortLevel) ?? 'high';

  const registry = new AgentRegistry(tg, questions, state, getChatId, notify, {
    model: defaultModel,
    fallbackModel: defaultFallbackModel,
    effort: defaultEffort,
    workDirBase: workDir,
    appendSystemPrompt: SYSTEM_PROMPT_APPEND,
    beamAlias,
  });

  const persistedAgents = Object.entries(state.get().agents);
  if (persistedAgents.length === 0) {
    // Fresh install: zero-config single-agent path, matching v0's behavior exactly.
    registry.spawn('default', { cwd: workDir, model: defaultModel, fallbackModel: defaultFallbackModel, effort: defaultEffort });
  } else {
    for (const [name, agentState] of persistedAgents) {
      if (agentState.status !== 'running') continue; // deliberately stopped -- don't auto-resume
      registry.spawn(name, {
        cwd: agentState.cwd || workDir,
        model: agentState.model || defaultModel,
        fallbackModel: defaultFallbackModel,
        effort: agentState.effort || defaultEffort,
        resume: agentState.sessionId ?? undefined,
      });
    }
    const persistedFocused = state.get().focused;
    if (persistedFocused && registry.get(persistedFocused)) registry.setFocused(persistedFocused);
  }

  const ttlScheduler = new TTLScheduler({
    expiresAt,
    beamAlias,
    notify,
    getCheckpoints: () => registry.list().map((e) => e.checkpoint),
  });
  ttlScheduler.start();

  new CommandRouter(tg, registry, { alias: beamAlias, expiresAt, tmuxSession, logPath }, getChatId);

  tg.on('message', (msg: TgMessage) => {
    if (msg.chat.id !== chatId) return; // only the bound operator chat
    if (msg.from?.id !== ownerId) {
      console.warn(`[main] ignored message from non-owner id=${msg.from?.id ?? 'unknown'}`);
      return;
    }
    if (msg.text?.startsWith('/')) return; // handled by CommandRouter
    if (msg.reply_to_message) return; // handled by QuestionManager (typed answer) or dropped
    if (!msg.text) return;
    const focused = registry.getFocused();
    if (!focused) {
      tg.sendMessage(chatId, 'no focused agent — /switch <name> or /new <name>').catch((err) =>
        console.error('[main] reply failed:', err),
      );
      return;
    }
    focused.agent.send(msg.text);
  });

  const ttl = expiresAt ? expiresAt.toISOString() : 'unknown';
  const agentLines = registry
    .list()
    .map((e) => {
      const o = e.agent.getOptions();
      return `${e.name === registry.getFocusedName() ? '★' : ' '} ${e.name} · ${o.cwd} · ${o.model} · effort ${o.effort}`;
    })
    .join('\n');
  const greeting = `${wasBound ? 'Reconnected' : 'Connected'} — ${beamAlias}\nexpires ${ttl}\n\n${agentLines}`;
  await tg.sendMessage(chatId, greeting);
}

main().catch((err) => {
  console.error('[main] fatal:', err);
  process.exit(1);
});
