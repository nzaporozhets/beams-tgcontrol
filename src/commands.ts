import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEntry, AgentRegistry } from './registry.js';
import type { InlineKeyboardButton, TelegramClient, TgCallbackQuery, TgMessage } from './telegram.js';

const exec = promisify(execFile);

export interface BeamInfo {
  alias: string;
  expiresAt: Date | null;
  tmuxSession: string;
  logPath: string;
}

const MODEL_CHOICES = ['opus', 'sonnet', 'haiku'];
const EFFORT_CHOICES: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const RESERVED_NAMES = new Set<string>([...MODEL_CHOICES, ...EFFORT_CHOICES]);
const MAX_AGENTS = Number.parseInt(process.env.MAX_AGENTS ?? '', 10) || 4;

export const COMMAND_LIST = [
  { command: 'status', description: 'Beam + all agents at a glance' },
  { command: 'agents', description: 'List agents: cwd, model, effort, status' },
  { command: 'new', description: '/new <name> [cwd] -- spawn an agent' },
  { command: 'switch', description: '/switch <name> -- focus an agent' },
  { command: 'kill', description: '/kill <name> -- stop an agent' },
  { command: 'rename', description: '/rename <old> <new>' },
  { command: 'model', description: '/model [name] <value>' },
  { command: 'effort', description: '/effort [name] <value>' },
  { command: 'settings', description: '/settings [name] -- buttons for model + effort' },
  { command: 'interrupt', description: '/interrupt [name]' },
  { command: 'checkpoint', description: '/checkpoint [name] -- omit for all agents' },
  { command: 'logs', description: '/logs [name] [n]' },
  { command: 'restart', description: '/restart [name] -- resume from transcript' },
  { command: 'cost', description: '/cost [name]' },
];

interface Target {
  entry: AgentEntry | undefined;
  name: string | null;
  valueTokens: string[];
}

/** §5.4 command dispatch, extended for multiple agents. Registered with setMyCommands by main.ts. */
export class CommandRouter {
  constructor(
    private tg: TelegramClient,
    private registry: AgentRegistry,
    private beam: BeamInfo,
    private getChatId: () => number | null,
  ) {
    this.tg.on('message', (msg: TgMessage) => {
      if (msg.text?.startsWith('/')) {
        this.handleCommand(msg).catch((err) => console.error('[commands] error:', err));
      }
    });
    this.tg.on('callback_query', (cq: TgCallbackQuery) => {
      if (cq.data?.startsWith('s:')) {
        this.handleSettingsCallback(cq).catch((err) => console.error('[commands] settings callback error:', err));
      }
    });
  }

  private reply(text: string): Promise<unknown> {
    const chatId = this.getChatId();
    if (chatId === null) return Promise.resolve();
    return this.tg.sendMessage(chatId, text);
  }

  /** First token is the agent name if it names a live agent; otherwise falls back to focused. */
  private resolveTarget(rest: string[]): Target {
    const first = rest[0];
    if (first) {
      const entry = this.registry.get(first);
      if (entry) return { entry, name: first, valueTokens: rest.slice(1) };
    }
    const focusedName = this.registry.getFocusedName();
    return { entry: focusedName ? this.registry.get(focusedName) : undefined, name: focusedName, valueTokens: rest };
  }

  private async handleCommand(msg: TgMessage): Promise<void> {
    const [cmdRaw, ...rest] = (msg.text ?? '').trim().split(/\s+/);
    const cmd = cmdRaw.split('@')[0];
    switch (cmd) {
      case '/status':
        await this.status();
        break;
      case '/agents':
        await this.reply(this.renderAgentsList());
        break;
      case '/new':
        await this.newAgent(rest);
        break;
      case '/switch':
        await this.switchAgent(rest);
        break;
      case '/kill':
        await this.killAgent(rest);
        break;
      case '/rename':
        await this.renameAgent(rest);
        break;
      case '/model': {
        const { entry, name, valueTokens } = this.resolveTarget(rest);
        await this.setModel(entry, name, valueTokens.join(' '));
        break;
      }
      case '/effort': {
        const { entry, name, valueTokens } = this.resolveTarget(rest);
        await this.setEffort(entry, name, valueTokens.join(' '));
        break;
      }
      case '/settings':
        await this.settingsKeyboard(rest);
        break;
      case '/interrupt': {
        const { entry, name } = this.resolveTarget(rest);
        if (!entry) {
          await this.reply('no focused agent -- /switch <name> or specify one');
          break;
        }
        await entry.agent.interrupt();
        await this.reply(`[${name}] ⏸ interrupted`);
        break;
      }
      case '/checkpoint':
        await this.checkpoint(rest);
        break;
      case '/logs':
        await this.logs(rest);
        break;
      case '/restart': {
        const { entry, name } = this.resolveTarget(rest);
        if (!entry || !name) {
          await this.reply('no focused agent -- /switch <name> or specify one');
          break;
        }
        await this.reply(`[${name}] 🔄 restarting, resuming from transcript...`);
        await this.registry.restart(name);
        break;
      }
      case '/cost': {
        const { entry, name } = this.resolveTarget(rest);
        await this.cost(entry, name);
        break;
      }
      default:
        break; // not one of ours
    }
  }

  private renderAgentsList(): string {
    const entries = this.registry.list();
    if (entries.length === 0) return '(no agents)';
    const focused = this.registry.getFocusedName();
    return entries
      .map((e) => {
        const opts = e.agent.getOptions();
        const marker = e.name === focused ? '★' : ' ';
        return `${marker} ${e.name} · ${opts.cwd} · ${opts.model} · effort ${opts.effort} · ${e.status}`;
      })
      .join('\n');
  }

  private async status(): Promise<void> {
    const ttl = this.beam.expiresAt ? formatTtl(this.beam.expiresAt) : 'unknown';
    const tmuxStatus = await this.tmuxStatus();
    await this.reply(
      [`Connected — ${this.beam.alias}`, `expires ${ttl}`, tmuxStatus, '', this.renderAgentsList()].join('\n'),
    );
  }

  private async tmuxStatus(): Promise<string> {
    try {
      const { stdout } = await exec('tmux', [
        'list-sessions',
        '-F',
        '#{session_name}: created #{session_created_string}, #{session_attached} client(s) attached',
      ]);
      const line = stdout.split('\n').find((l) => l.startsWith(`${this.beam.tmuxSession}:`));
      return line ?? `tmux session '${this.beam.tmuxSession}' not found (running outside tmux?)`;
    } catch (err) {
      return `tmux list-sessions failed: ${err}`;
    }
  }

  private async newAgent(rest: string[]): Promise<void> {
    const [name, cwd] = rest;
    if (!name) {
      await this.reply('usage: /new <name> [cwd]');
      return;
    }
    if (RESERVED_NAMES.has(name) || /^\d+$/.test(name)) {
      await this.reply(`❌ '${name}' is reserved (a model/effort name or purely numeric) -- pick another`);
      return;
    }
    const existing = this.registry.get(name);
    if (existing && existing.status === 'running') {
      await this.reply(`❌ agent '${name}' already exists and is running`);
      return;
    }
    if (this.registry.count() >= MAX_AGENTS) {
      await this.reply(`❌ MAX_AGENTS (${MAX_AGENTS}) reached -- /kill one first`);
      return;
    }
    try {
      const entry = this.registry.spawnNamed(name, cwd);
      await this.reply(`✅ spawned '${name}' at ${entry.agent.getOptions().cwd}${this.registry.getFocusedName() === name ? ' (focused)' : ''}`);
    } catch (err) {
      await this.reply(`❌ /new ${name} failed: ${err}`);
    }
  }

  private async switchAgent(rest: string[]): Promise<void> {
    const [name] = rest;
    if (!name) {
      await this.reply('usage: /switch <name>');
      return;
    }
    if (!this.registry.setFocused(name)) {
      await this.reply(`❌ no such agent '${name}'`);
      return;
    }
    await this.reply(`focused on '${name}'`);
  }

  private async killAgent(rest: string[]): Promise<void> {
    const [name] = rest;
    if (!name) {
      await this.reply('usage: /kill <name>');
      return;
    }
    if (!this.registry.stop(name)) {
      await this.reply(`❌ no such agent '${name}'`);
      return;
    }
    await this.reply(`🛑 stopped '${name}'`);
  }

  private async renameAgent(rest: string[]): Promise<void> {
    const [oldName, newName] = rest;
    if (!oldName || !newName) {
      await this.reply('usage: /rename <old> <new>');
      return;
    }
    if (RESERVED_NAMES.has(newName) || /^\d+$/.test(newName)) {
      await this.reply(`❌ '${newName}' is reserved -- pick another`);
      return;
    }
    if (!this.registry.get(oldName)) {
      await this.reply(`❌ no such agent '${oldName}'`);
      return;
    }
    if (this.registry.get(newName)) {
      await this.reply(`❌ '${newName}' already exists`);
      return;
    }
    this.registry.rename(oldName, newName);
    await this.reply(`✏️ '${oldName}' renamed to '${newName}' (future checkpoints and messages use the new name; anything already sent keeps the old one)`);
  }

  private async setModel(entry: AgentEntry | undefined, name: string | null, value: string): Promise<void> {
    if (!entry || !name) {
      await this.reply('no focused agent -- /switch <name> or specify one');
      return;
    }
    if (!value) {
      await this.reply(`usage: /model [name] <value> (e.g. ${MODEL_CHOICES.join(', ')})`);
      return;
    }
    try {
      await entry.agent.setModel(value);
      await this.reply(`[${name}] model set to ${value}`);
    } catch (err) {
      await this.reply(`❌ [${name}] /model ${value} failed: ${err}`);
    }
  }

  private async setEffort(entry: AgentEntry | undefined, name: string | null, value: string): Promise<void> {
    if (!entry || !name) {
      await this.reply('no focused agent -- /switch <name> or specify one');
      return;
    }
    if (!EFFORT_CHOICES.includes(value as EffortLevel)) {
      await this.reply(`usage: /effort [name] <${EFFORT_CHOICES.join('|')}>`);
      return;
    }
    try {
      await entry.agent.setEffort(value as EffortLevel);
      await this.reply(`[${name}] effort set to ${value}`);
    } catch (err) {
      await this.reply(`❌ [${name}] /effort ${value} failed: ${err}`);
    }
  }

  private async settingsKeyboard(rest: string[]): Promise<void> {
    const { entry, name } = this.resolveTarget(rest);
    const chatId = this.getChatId();
    if (chatId === null) return;
    if (!entry || !name) {
      await this.reply('no focused agent -- /switch <name> or specify one');
      return;
    }
    const opts = entry.agent.getOptions();
    const modelRow: InlineKeyboardButton[] = MODEL_CHOICES.map((m) => ({
      text: m === opts.model ? `• ${m}` : m,
      callback_data: `s:${name}:model:${m}`,
    }));
    const effortRow: InlineKeyboardButton[] = EFFORT_CHOICES.map((e) => ({
      text: e === opts.effort ? `• ${e}` : e,
      callback_data: `s:${name}:effort:${e}`,
    }));
    await this.tg.sendMessage(chatId, `[${name}]\nModel: ${opts.model}\nEffort: ${opts.effort}`, {
      reply_markup: { inline_keyboard: [modelRow, effortRow] },
    });
  }

  private async handleSettingsCallback(cq: TgCallbackQuery): Promise<void> {
    await this.tg.answerCallbackQuery(cq.id);
    const [, name, kind, value] = (cq.data ?? '').split(':');
    const entry = this.registry.get(name);
    if (kind === 'model') await this.setModel(entry, name, value);
    else if (kind === 'effort') await this.setEffort(entry, name, value);
  }

  private async checkpoint(rest: string[]): Promise<void> {
    const [maybeName] = rest;
    if (maybeName && this.registry.get(maybeName)) {
      const entry = this.registry.get(maybeName)!;
      const pushed = await entry.checkpoint.force('manual checkpoint');
      await this.reply(`[${maybeName}] ${pushed ? '✅ checkpoint pushed' : 'nothing to push — working tree clean'}`);
      return;
    }
    const entries = this.registry.list();
    if (entries.length === 0) {
      await this.reply('(no agents)');
      return;
    }
    const results = await Promise.all(
      entries.map(async (e) => ({ name: e.name, pushed: await e.checkpoint.force('manual checkpoint').catch(() => false) })),
    );
    await this.reply(results.map((r) => `${r.name}: ${r.pushed ? '✅ pushed' : 'clean'}`).join('\n'));
  }

  private async logs(rest: string[]): Promise<void> {
    let name: string | undefined;
    let nStr: string | undefined;
    if (rest[0] && this.registry.get(rest[0])) {
      [name, nStr] = rest;
    } else {
      [nStr] = rest;
    }
    const n = Number.parseInt(nStr ?? '', 10);
    const lines = Number.isFinite(n) && n > 0 ? n : 200;
    try {
      const full = readFileSync(this.beam.logPath, 'utf8').split('\n');
      const filtered = name ? full.filter((l) => l.includes(`[${name}]`)) : full;
      const text = filtered.slice(-lines).join('\n');
      const chatId = this.getChatId();
      if (chatId === null) return;
      if (text.length > 3000) {
        await this.tg.sendDocument(chatId, 'agent.log', text, `last ${lines} lines${name ? ` for ${name}` : ''}`);
      } else {
        await this.reply(text || '(no logs)');
      }
    } catch (err) {
      await this.reply(`❌ /logs failed: ${err} (expected log file at ${this.beam.logPath})`);
    }
  }

  private async cost(entry: AgentEntry | undefined, name: string | null): Promise<void> {
    if (!entry || !name) {
      const entries = this.registry.list();
      const total = entries.reduce((sum, e) => sum + e.agent.getUsage().costUsd, 0);
      await this.reply(`~$${total.toFixed(4)} across ${entries.length} agent(s) (client-side estimate)`);
      return;
    }
    const usage = entry.agent.getUsage();
    await this.reply(`[${name}] ~$${usage.costUsd.toFixed(4)} across ${usage.turns} turns (client-side estimate)`);
  }
}

function formatTtl(expiresAt: Date): string {
  const msLeft = expiresAt.getTime() - Date.now();
  const totalMin = Math.max(0, Math.round(msLeft / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${expiresAt.toISOString().replace('T', ' ').slice(0, 16)} UTC (${h}h ${m}m)`;
}
