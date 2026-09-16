import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession } from './agent.js';
import type { Checkpoint } from './checkpoint.js';
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

export const COMMAND_LIST = [
  { command: 'status', description: 'Beam, cwd, model, effort, expiry' },
  { command: 'model', description: 'Change model, e.g. /model sonnet' },
  { command: 'effort', description: 'Change effort, e.g. /effort high' },
  { command: 'settings', description: 'Model + effort as buttons' },
  { command: 'interrupt', description: 'Interrupt the current turn' },
  { command: 'checkpoint', description: 'Commit and push now' },
  { command: 'logs', description: 'Tail supervisor log file' },
  { command: 'restart', description: 'Restart the agent, resuming session' },
  { command: 'cost', description: 'Session cost estimate' },
];

/** §5.4 command dispatch. Registered with setMyCommands by main.ts at startup. */
export class CommandRouter {
  constructor(
    private tg: TelegramClient,
    private agent: AgentSession,
    private checkpoint: Checkpoint,
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

  private async handleCommand(msg: TgMessage): Promise<void> {
    const [cmdRaw, ...rest] = (msg.text ?? '').trim().split(/\s+/);
    const cmd = cmdRaw.split('@')[0];
    const arg = rest.join(' ');
    switch (cmd) {
      case '/status':
        await this.status();
        break;
      case '/model':
        await this.setModel(arg);
        break;
      case '/effort':
        await this.setEffort(arg);
        break;
      case '/settings':
        await this.settingsKeyboard();
        break;
      case '/interrupt':
        await this.agent.interrupt();
        await this.reply('⏸ interrupted');
        break;
      case '/checkpoint': {
        const pushed = await this.checkpoint.force('manual checkpoint');
        await this.reply(pushed ? '✅ checkpoint pushed' : 'nothing to push — working tree clean');
        break;
      }
      case '/logs':
        await this.logs(arg);
        break;
      case '/restart':
        await this.reply('🔄 restarting, resuming from transcript...');
        await this.agent.restart();
        break;
      case '/cost':
        await this.cost();
        break;
      default:
        break; // not one of ours
    }
  }

  private async status(): Promise<void> {
    const opts = this.agent.getOptions();
    const ttl = this.beam.expiresAt ? formatTtl(this.beam.expiresAt) : 'unknown';
    const tmuxStatus = await this.tmuxStatus();
    await this.reply(
      [`Connected — ${this.beam.alias}`, `${opts.cwd} · ${opts.model} · effort ${opts.effort}`, `expires ${ttl}`, '', tmuxStatus].join(
        '\n',
      ),
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

  private async setModel(name: string): Promise<void> {
    if (!name) {
      await this.reply(`usage: /model <name> (e.g. ${MODEL_CHOICES.join(', ')})`);
      return;
    }
    try {
      await this.agent.setModel(name);
      await this.reply(`model set to ${name}`);
    } catch (err) {
      await this.reply(`❌ /model ${name} failed: ${err}`);
    }
  }

  private async setEffort(level: string): Promise<void> {
    if (!EFFORT_CHOICES.includes(level as EffortLevel)) {
      await this.reply(`usage: /effort <${EFFORT_CHOICES.join('|')}>`);
      return;
    }
    try {
      await this.agent.setEffort(level as EffortLevel);
      await this.reply(`effort set to ${level}`);
    } catch (err) {
      await this.reply(`❌ /effort ${level} failed: ${err}`);
    }
  }

  private async settingsKeyboard(): Promise<void> {
    const chatId = this.getChatId();
    if (chatId === null) return;
    const opts = this.agent.getOptions();
    const modelRow: InlineKeyboardButton[] = MODEL_CHOICES.map((m) => ({
      text: m === opts.model ? `• ${m}` : m,
      callback_data: `s:model:${m}`,
    }));
    const effortRow: InlineKeyboardButton[] = EFFORT_CHOICES.map((e) => ({
      text: e === opts.effort ? `• ${e}` : e,
      callback_data: `s:effort:${e}`,
    }));
    await this.tg.sendMessage(chatId, `Model: ${opts.model}\nEffort: ${opts.effort}`, {
      reply_markup: { inline_keyboard: [modelRow, effortRow] },
    });
  }

  private async handleSettingsCallback(cq: TgCallbackQuery): Promise<void> {
    await this.tg.answerCallbackQuery(cq.id);
    const [, kind, value] = (cq.data ?? '').split(':');
    if (kind === 'model') await this.setModel(value);
    else if (kind === 'effort') await this.setEffort(value);
  }

  private async logs(argRaw: string): Promise<void> {
    const n = Number.parseInt(argRaw, 10);
    const lines = Number.isFinite(n) && n > 0 ? n : 200;
    try {
      const full = readFileSync(this.beam.logPath, 'utf8');
      const text = full.split('\n').slice(-lines).join('\n');
      const chatId = this.getChatId();
      if (chatId === null) return;
      if (text.length > 3000) {
        await this.tg.sendDocument(chatId, 'agent.log', text, `last ${lines} lines`);
      } else {
        await this.reply(text || '(no logs)');
      }
    } catch (err) {
      await this.reply(`❌ /logs failed: ${err} (expected log file at ${this.beam.logPath})`);
    }
  }

  private async cost(): Promise<void> {
    const usage = this.agent.getUsage();
    await this.reply(`~$${usage.costUsd.toFixed(4)} across ${usage.turns} turns (client-side estimate)`);
  }
}

function formatTtl(expiresAt: Date): string {
  const msLeft = expiresAt.getTime() - Date.now();
  const totalMin = Math.max(0, Math.round(msLeft / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${expiresAt.toISOString().replace('T', ' ').slice(0, 16)} UTC (${h}h ${m}m)`;
}
