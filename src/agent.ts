import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  EffortLevel,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AskUserQuestionInput, AskUserQuestionOutput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import type { QuestionManager } from './questions.js';
import type { StateStore } from './state.js';

/** Async iterable queue feeding the SDK's streaming-input prompt. Never closes on its own. */
class UserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private buffered: SDKUserMessage[] = [];
  private waiters: ((msg: SDKUserMessage | null) => void)[] = [];
  private closed = false;

  push(text: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    const waiter = this.waiters.shift();
    if (waiter) waiter(msg);
    else this.buffered.push(msg);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (this.buffered.length > 0) {
        yield this.buffered.shift() as SDKUserMessage;
        continue;
      }
      const msg = await new Promise<SDKUserMessage | null>((resolve) => this.waiters.push(resolve));
      if (msg === null) return;
      yield msg;
    }
  }
}

export interface AgentOptions {
  cwd: string;
  model: string;
  fallbackModel: string;
  effort: EffortLevel;
  appendSystemPrompt: string;
}

export interface UsageTotals {
  costUsd: number;
  turns: number;
}

/**
 * Owns one long-lived streaming-input session against the Agent SDK.
 * Plain messages are pushed at any time; the SDK holds them until the
 * current turn's result lands (streaming-input mode's own turn-boundary
 * behavior -- no extra coordination needed here).
 */
export class AgentSession {
  private inputQueue = new UserMessageQueue();
  private q: Query;
  private sessionId: string | null;
  private usage: UsageTotals = { costUsd: 0, turns: 0 };
  private closed = false;

  constructor(
    private opts: AgentOptions,
    private questions: QuestionManager,
    private state: StateStore,
    private onMessage: (msg: SDKMessage) => void,
    private onAutoAllow: (text: string) => void,
  ) {
    this.sessionId = state.get().sessionId;
    this.q = this.startQuery(this.sessionId ?? undefined);
    void this.consume();
  }

  private startQuery(resume?: string): Query {
    return query({
      prompt: this.inputQueue,
      options: {
        permissionMode: 'auto',
        cwd: this.opts.cwd,
        model: this.opts.model,
        fallbackModel: this.opts.fallbackModel,
        effort: this.opts.effort,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.opts.appendSystemPrompt },
        resume,
        canUseTool: this.canUseTool.bind(this),
      },
    });
  }

  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: { displayName?: string; title?: string },
  ): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') {
      const output = await this.questions.ask(input as unknown as AskUserQuestionInput);
      return { behavior: 'allow', updatedInput: output as unknown as Record<string, unknown> };
    }
    // Anything else reaching the callback under permissionMode 'auto' was
    // escalated by the classifier past routine work. Allow it, but tell
    // the operator -- this is the "keep them informed" half of §3.2.
    const label = opts.displayName ?? toolName;
    this.onAutoAllow(`⚡ auto-allowed: ${label}`);
    return { behavior: 'allow', updatedInput: input };
  }

  private async consume(): Promise<void> {
    try {
      for await (const msg of this.q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.state.update({ sessionId: msg.session_id });
        }
        if (msg.type === 'result') {
          this.usage.costUsd = msg.total_cost_usd;
          this.usage.turns += 1;
        }
        this.onMessage(msg);
      }
    } catch (err) {
      console.error('[agent] query loop error:', err);
    }
  }

  send(text: string): void {
    this.inputQueue.push(text);
  }

  interrupt(): Promise<unknown> {
    return this.q.interrupt();
  }

  setModel(model: string): Promise<void> {
    return this.q.setModel(model);
  }

  setEffort(effort: EffortLevel): Promise<void> {
    this.opts.effort = effort;
    return this.q.applyFlagSettings({ effortLevel: effort });
  }

  async restart(): Promise<void> {
    this.inputQueue.close();
    this.q.close();
    this.inputQueue = new UserMessageQueue();
    this.q = this.startQuery(this.sessionId ?? undefined);
    void this.consume();
  }

  close(): void {
    this.closed = true;
    this.inputQueue.close();
    this.q.close();
  }

  isClosed(): boolean {
    return this.closed;
  }

  getUsage(): UsageTotals {
    return this.usage;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getOptions(): AgentOptions {
    return this.opts;
  }
}
