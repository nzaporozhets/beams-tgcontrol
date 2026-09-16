import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TelegramClient } from './telegram.js';

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
 * edited at most every 3s and finalized at `result` (§5.3). Every rendered
 * message is prefixed `[name]` so concurrent agents stay distinguishable in
 * one flat chat.
 */
export class TurnRenderer {
  private chatId: number | null = null;
  private messageId: number | null = null;
  private toolLines: string[] = [];
  private text = '';
  private dirty = false;
  private lastEditAt = 0;
  private pendingTimer: NodeJS.Timeout | null = null;

  constructor(private tg: TelegramClient, private getChatId: () => number | null, private name: string) {}

  setName(name: string): void {
    this.name = name;
  }

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
          .sendDocument(
            chatId,
            'tool-output.txt',
            text,
            `[${this.name}] ${preview.slice(0, 200)}${text.length > 200 ? '…' : ''}`,
          )
          .catch((err) => console.error(`[render:${this.name}] sendDocument failed:`, err));
      }
    }
  }

  private render(): string {
    const parts: string[] = [];
    if (this.toolLines.length) parts.push(this.toolLines.join(' · '));
    if (this.text) parts.push(this.text);
    const body = parts.join('\n\n') || '…';
    const withPrefix = `[${this.name}] ${body}`;
    return withPrefix.length > 3800 ? `${withPrefix.slice(0, 3800)}…` : withPrefix;
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
      console.error(`[render:${this.name}] flush failed:`, err);
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
