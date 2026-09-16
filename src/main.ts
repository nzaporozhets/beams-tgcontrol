import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EffortLevel, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession } from './agent.js';
import { Checkpoint } from './checkpoint.js';
import { COMMAND_LIST, CommandRouter } from './commands.js';
import { QuestionManager } from './questions.js';
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

function toolLabel(name: string, input: Record<string, unknown>): string {
  const short = (s: unknown, n = 50) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
  switch (name) {
    case 'Bash':
      return `Bash ${short(input.command)}`;
    case 'Edit':
    case 'Write':
    case 'Read':
      return `${name} ${String(input.file_path ?? '').split('/').pop() ?? ''}`;
    default:
      return name;
  }
}

/**
 * Coalesces one agent turn's worth of SDKMessages into a single Telegram
 * message: a collapsed tool-call line, then the running assistant text,
 * edited at most every 3s and finalized at `result` (§5.3).
 */
class TurnRenderer {
  private chatId: number | null = null;
  private messageId: number | null = null;
  private toolLines: string[] = [];
  private text = '';
  private dirty = false;
  private lastEditAt = 0;
  private pendingTimer: NodeJS.Timeout | null = null;

  constructor(private tg: TelegramClient, private getChatId: () => number | null) {}

  handle(msg: SDKMessage): void {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          this.toolLines.push(`🔧 ${toolLabel(block.name, block.input as Record<string, unknown>)}`);
          this.dirty = true;
        } else if (block.type === 'text') {
          this.text += (this.text ? '\n' : '') + block.text;
          this.dirty = true;
        }
      }
      this.scheduleEdit();
    } else if (msg.type === 'user') {
      this.handleToolResult(msg);
    } else if (msg.type === 'result') {
      void this.finish(msg.is_error ? `⚠️ turn ended with an error (${msg.subtype})` : undefined);
    }
  }

  private handleToolResult(msg: Extract<SDKMessage, { type: 'user' }>): void {
    const content = msg.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      if (text.length > 800) {
        const chatId = this.getChatId();
        if (chatId === null) continue;
        const preview = text.slice(0, 500);
        void this.tg
          .sendDocument(chatId, 'tool-output.txt', text, `${preview.slice(0, 200)}${text.length > 200 ? '…' : ''}`)
          .catch((err) => console.error('[render] sendDocument failed:', err));
      }
    }
  }

  private render(): string {
    const parts: string[] = [];
    if (this.toolLines.length) parts.push(this.toolLines.join(' · '));
    if (this.text) parts.push(this.text);
    const joined = parts.join('\n\n') || '…';
    return joined.length > 3800 ? `${joined.slice(0, 3800)}…` : joined;
  }

  private scheduleEdit(): void {
    if (!this.dirty) return;
    const now = Date.now();
    if (now - this.lastEditAt >= 3000) {
      void this.flush();
      return;
    }
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.flush();
    }, 3000 - (now - this.lastEditAt));
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    const chatId = this.getChatId();
    if (chatId === null) return;
    this.dirty = false;
    this.lastEditAt = Date.now();
    const text = this.render();
    try {
      if (this.messageId === null || this.chatId !== chatId) {
        const sent = await this.tg.sendMessage(chatId, text);
        this.chatId = chatId;
        this.messageId = sent.message_id;
      } else {
        await this.tg.editMessageText(chatId, this.messageId, text);
      }
    } catch (err) {
      console.error('[render] flush failed:', err);
    }
  }

  private async finish(errorNote?: string): Promise<void> {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (errorNote) {
      this.text += (this.text ? '\n\n' : '') + errorNote;
      this.dirty = true;
    }
    await this.flush();
    this.chatId = null;
    this.messageId = null;
    this.toolLines = [];
    this.text = '';
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
  const renderer = new TurnRenderer(tg, getChatId);

  const agent = new AgentSession(
    {
      cwd: workDir,
      model: process.env.CLAUDE_MODEL ?? 'opus',
      fallbackModel: process.env.CLAUDE_FALLBACK_MODEL ?? 'sonnet',
      effort: (process.env.CLAUDE_EFFORT as EffortLevel) ?? 'high',
      appendSystemPrompt: SYSTEM_PROMPT_APPEND,
    },
    questions,
    state,
    (msg) => renderer.handle(msg),
    (text) => notify(text),
  );

  const checkpoint = new Checkpoint({ workDir, beamAlias, expiresAt, notify });
  checkpoint.start();

  new CommandRouter(tg, agent, checkpoint, { alias: beamAlias, expiresAt, tmuxSession, logPath }, getChatId);

  tg.on('message', (msg: TgMessage) => {
    if (msg.chat.id !== chatId) return; // only the bound operator chat
    if (msg.from?.id !== ownerId) {
      console.warn(`[main] ignored message from non-owner id=${msg.from?.id ?? 'unknown'}`);
      return;
    }
    if (msg.text?.startsWith('/')) return; // handled by CommandRouter
    if (msg.reply_to_message) return; // handled by QuestionManager (typed answer) or dropped
    if (msg.text) agent.send(msg.text);
  });

  const opts = agent.getOptions();
  const ttl = expiresAt ? expiresAt.toISOString() : 'unknown';
  const greeting = wasBound
    ? `Reconnected — ${beamAlias}\n${opts.cwd} · ${opts.model} · effort ${opts.effort}\nexpires ${ttl}`
    : `Connected — ${beamAlias}\n${opts.cwd} · ${opts.model} · effort ${opts.effort}\nexpires ${ttl}`;
  await tg.sendMessage(chatId, greeting);
}

main().catch((err) => {
  console.error('[main] fatal:', err);
  process.exit(1);
});
