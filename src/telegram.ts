import { EventEmitter } from 'node:events';
import type { StateStore } from './state.js';

export interface TgUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  reply_to_message?: TgMessage;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
}

export type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };
export type ForceReplyMarkup = { force_reply: true; selective?: boolean };
export type ReplyMarkup = InlineKeyboardMarkup | ForceReplyMarkup;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin fetch-based wrapper around the Telegram Bot API. No bot framework:
 * the protocol requirements here (ack timing, force_reply parking, 64-byte
 * callback_data) are specific enough that a raw wrapper is less fighting
 * than adapting a generic library.
 */
export class TelegramClient extends EventEmitter {
  private base: string;
  private stopped = false;

  constructor(token: string, private state: StateStore) {
    super();
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) {
      throw new Error(`Telegram ${method} failed: ${body.description ?? res.status}`);
    }
    return body.result as T;
  }

  setMyCommands(commands: { command: string; description: string }[]): Promise<unknown> {
    return this.call('setMyCommands', { commands });
  }

  sendMessage(
    chatId: number,
    text: string,
    opts: { reply_markup?: ReplyMarkup } = {},
  ): Promise<TgMessage> {
    return this.call<TgMessage>('sendMessage', { chat_id: chatId, text, ...opts });
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { reply_markup?: ReplyMarkup } = {},
  ): Promise<void> {
    try {
      await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...opts });
    } catch (err) {
      // Telegram errors if the text is byte-identical to what's already there. Harmless.
      if (!String(err).includes('message is not modified')) throw err;
    }
  }

  editMessageReplyMarkup(chatId: number, messageId: number, reply_markup: ReplyMarkup): Promise<unknown> {
    return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup });
  }

  answerCallbackQuery(id: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  async sendDocument(chatId: number, filename: string, content: string, caption?: string): Promise<TgMessage> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([content], { type: 'text/plain' }), filename);
    const res = await fetch(`${this.base}/sendDocument`, { method: 'POST', body: form });
    const body = (await res.json()) as { ok: boolean; result?: TgMessage; description?: string };
    if (!body.ok) throw new Error(`Telegram sendDocument failed: ${body.description}`);
    return body.result as TgMessage;
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const offset = this.state.get().offset;
      let updates: TgUpdate[];
      try {
        // allowed_updates must be passed explicitly on every call: Telegram treats it as
        // sticky server-side state, and a call that omits it inherits whatever was last
        // set (by anything, including a prior bot session) rather than defaulting to "all".
        // Omitting it here silently drops callback_query forever if that ever narrows.
        updates = await this.call<TgUpdate[]>('getUpdates', {
          offset,
          timeout: 30,
          allowed_updates: ['message', 'callback_query'],
        });
      } catch (err) {
        console.error('[telegram] getUpdates failed:', err);
        await sleep(2000);
        continue;
      }
      for (const update of updates) {
        try {
          if (update.message) this.emit('message', update.message);
          if (update.callback_query) this.emit('callback_query', update.callback_query);
        } catch (err) {
          console.error('[telegram] update handler error:', err);
        }
        this.state.update({ offset: update.update_id + 1 });
      }
    }
  }
}
