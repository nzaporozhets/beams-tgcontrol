import { randomBytes } from 'node:crypto';
import type { AskUserQuestionInput, AskUserQuestionOutput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import type { InlineKeyboardButton, InlineKeyboardMarkup, TelegramClient, TgCallbackQuery, TgMessage } from './telegram.js';

interface QuestionSlot {
  index: number;
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
  chatId: number;
  messageId: number;
  selected: Set<number>;
  answered: boolean;
  answerText?: string;
}

interface PendingBatch {
  id: string;
  input: AskUserQuestionInput;
  slots: QuestionSlot[];
  resolve: (output: AskUserQuestionOutput) => void;
  pingTimer: NodeJS.Timeout;
}

const PING_MS = 30 * 60 * 1000;

function randomId(): string {
  return randomBytes(4).toString('hex');
}

function questionText(q: { question: string; options: { label: string; description: string }[] }): string {
  const lines = [`❓ ${q.question}`, ''];
  for (const opt of q.options) lines.push(`• ${opt.label} — ${opt.description}`);
  return lines.join('\n');
}

function buildMarkup(slot: QuestionSlot, batchId: string): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = slot.options.map((opt, i) => [
    {
      text: slot.multiSelect ? `${slot.selected.has(i) ? '☑' : '⬜'} ${opt.label}` : opt.label,
      callback_data: `q:${batchId}:${slot.index}:${i}`,
    },
  ]);
  const lastRow: InlineKeyboardButton[] = [
    { text: '✍️ Type an answer', callback_data: `q:${batchId}:${slot.index}:type` },
  ];
  if (slot.multiSelect) {
    lastRow.push({ text: 'Submit', callback_data: `q:${batchId}:${slot.index}:submit` });
  }
  rows.push(lastRow);
  return { inline_keyboard: rows };
}

/**
 * Renders AskUserQuestion calls as Telegram inline keyboards and resolves
 * them back into the AskUserQuestionOutput shape the SDK expects as
 * `updatedInput` on the allow decision. One in-memory pending batch at a
 * time is the norm (the agent blocks on canUseTool), but nothing here
 * assumes only one question is outstanding.
 */
export class QuestionManager {
  private pending = new Map<string, PendingBatch>();
  private typedPrompts = new Map<number, { batchId: string; slotIndex: number }>();

  constructor(
    private tg: TelegramClient,
    private getChatId: () => number | null,
    private notify: (text: string) => void,
  ) {
    this.tg.on('callback_query', (cq: TgCallbackQuery) => {
      this.handleCallback(cq).catch((err) => console.error('[questions] callback error:', err));
    });
    this.tg.on('message', (msg: TgMessage) => {
      this.handleMessage(msg).catch((err) => console.error('[questions] message error:', err));
    });
  }

  async ask(input: AskUserQuestionInput): Promise<AskUserQuestionOutput> {
    const chatId = this.getChatId();
    if (chatId === null) {
      throw new Error('cannot ask a question before the operator chat is bound');
    }
    const batchId = randomId();
    const slots: QuestionSlot[] = [];
    for (let i = 0; i < input.questions.length; i++) {
      const q = input.questions[i];
      const slot: QuestionSlot = {
        index: i,
        question: q.question,
        header: q.header,
        options: q.options as { label: string; description: string }[],
        multiSelect: q.multiSelect,
        chatId,
        messageId: 0,
        selected: new Set(),
        answered: false,
      };
      const markup = buildMarkup(slot, batchId);
      const msg = await this.tg.sendMessage(chatId, questionText(q), { reply_markup: markup });
      slot.messageId = msg.message_id;
      slots.push(slot);
    }

    return new Promise<AskUserQuestionOutput>((resolve) => {
      const pingTimer = setTimeout(() => {
        const batch = this.pending.get(batchId);
        if (!batch) return;
        const headers = batch.slots.filter((s) => !s.answered).map((s) => s.header).join(', ');
        this.notify(`⏳ Still waiting on your answer: ${headers}`);
      }, PING_MS);
      this.pending.set(batchId, { id: batchId, input, slots, resolve, pingTimer });
    });
  }

  private finishIfComplete(batch: PendingBatch): void {
    if (!batch.slots.every((s) => s.answered)) return;
    clearTimeout(batch.pingTimer);
    this.pending.delete(batch.id);
    const answers: Record<string, string> = {};
    for (const s of batch.slots) answers[s.question] = s.answerText ?? '';
    batch.resolve({ questions: batch.input.questions, answers } as AskUserQuestionOutput);
  }

  private async finalizeSlot(slot: QuestionSlot, answerText: string): Promise<void> {
    slot.answered = true;
    slot.answerText = answerText;
    await this.tg.editMessageText(slot.chatId, slot.messageId, `✅ ${slot.question}\n${answerText}`, {
      reply_markup: { inline_keyboard: [] },
    });
  }

  private async handleCallback(cq: TgCallbackQuery): Promise<void> {
    const data = cq.data ?? '';
    if (!data.startsWith('q:')) return;
    await this.tg.answerCallbackQuery(cq.id);

    const [, batchId, idxStr, action] = data.split(':');
    const batch = this.pending.get(batchId);
    if (!batch) return; // stale button from a resolved/expired batch
    const slot = batch.slots[Number(idxStr)];
    if (!slot || slot.answered) return; // single-transition guard: no-op on a resolved question

    if (action === 'type') {
      const prompt = await this.tg.sendMessage(slot.chatId, `Type your answer for: ${slot.question}`, {
        reply_markup: { force_reply: true, selective: true },
      });
      this.typedPrompts.set(prompt.message_id, { batchId, slotIndex: slot.index });
      return;
    }

    if (slot.multiSelect) {
      if (action === 'submit') {
        const answer = [...slot.selected].sort((a, b) => a - b).map((i) => slot.options[i].label).join(', ');
        await this.finalizeSlot(slot, answer || '(none selected)');
        this.finishIfComplete(batch);
        return;
      }
      const optIdx = Number(action);
      if (Number.isNaN(optIdx) || !slot.options[optIdx]) return;
      if (slot.selected.has(optIdx)) slot.selected.delete(optIdx);
      else slot.selected.add(optIdx);
      await this.tg.editMessageReplyMarkup(slot.chatId, slot.messageId, buildMarkup(slot, batchId));
      return;
    }

    const optIdx = Number(action);
    if (Number.isNaN(optIdx) || !slot.options[optIdx]) return;
    await this.finalizeSlot(slot, slot.options[optIdx].label);
    this.finishIfComplete(batch);
  }

  private async handleMessage(msg: TgMessage): Promise<void> {
    const replyTo = msg.reply_to_message?.message_id;
    if (!replyTo) return;
    const target = this.typedPrompts.get(replyTo);
    if (!target) return;
    this.typedPrompts.delete(replyTo);

    const batch = this.pending.get(target.batchId);
    if (!batch) return;
    const slot = batch.slots[target.slotIndex];
    if (!slot || slot.answered) return;

    await this.finalizeSlot(slot, msg.text ?? '');
    this.finishIfComplete(batch);
  }
}
