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
  name: string;
  cwd: string;
  model: string;
  fallbackModel: string;
  effort: EffortLevel;
  appendSystemPrompt: string;
  /** Initial SDK session id to resume, e.g. restoring a persisted agent on supervisor boot. */
  resume?: string;
}

export interface UsageTotals {
  costUsd: number;
  turns: number;
}

/**
 * Owns one long-lived streaming-input session against the Agent SDK, for one
 * named agent. Plain messages are pushed at any time; the SDK holds them
 * until the current turn's result lands (streaming-input mode's own
 * turn-boundary behavior -- no extra coordination needed here).
 *
 * Deliberately has no knowledge of Telegram or the state file: callbacks
 * (`onMessage`, `onAutoAllow`, `onSessionId`, `onCrash`) are how the
 * AgentRegistry wires it up, so this class stays reusable for any number of
 * concurrent agents.
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
    private onMessage: (msg: SDKMessage) => void,
    private onAutoAllow: (text: string) => void,
    private onSessionId: (sessionId: string) => void,
    private onCrash: (err: unknown) => void,
  ) {
    this.sessionId = opts.resume ?? null;
    this.q = this.startQuery(this.sessionId ?? undefined);
    void this.consume(this.q);
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
      const output = await this.questions.ask(input as unknown as AskUserQuestionInput, this.opts.name);
      return { behavior: 'allow', updatedInput: output as unknown as Record<string, unknown> };
    }
    // Anything else reaching the callback under permissionMode 'auto' was
    // escalated by the classifier past routine work. Allow it, but tell
    // the operator -- this is the "keep them informed" half of §3.2.
    const label = opts.displayName ?? toolName;
    this.onAutoAllow(`⚡ auto-allowed: ${label}`);
    return { behavior: 'allow', updatedInput: input };
  }

  // Takes the Query explicitly (rather than reading `this.q`) so a stale loop left running
  // by `restart()`'s replacement of `this.q` can tell it's stale -- even if the old query's
  // teardown throws asynchronously well after `restart()` returns -- and not misreport a
  // deliberate restart as a crash.
  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.onSessionId(msg.session_id);
        }
        if (msg.type === 'result') {
          this.usage.costUsd = msg.total_cost_usd;
          this.usage.turns += 1;
        }
        this.onMessage(msg);
      }
    } catch (err) {
      if (!this.closed && q === this.q) {
        console.error(`[agent:${this.opts.name}] query loop error:`, err);
        this.onCrash(err);
      }
    }
  }

  send(text: string): void {
    this.inputQueue.push(text);
  }

  interrupt(): Promise<unknown> {
    return this.q.interrupt();
  }

  setModel(model: string): Promise<void> {
    this.opts.model = model;
    return this.q.setModel(model);
  }

  setEffort(effort: EffortLevel): Promise<void> {
    this.opts.effort = effort;
    return this.q.applyFlagSettings({ effortLevel: effort });
  }

  setName(name: string): void {
    this.opts.name = name;
  }

  async restart(): Promise<void> {
    this.inputQueue.close();
    this.q.close();
    this.inputQueue = new UserMessageQueue();
    this.q = this.startQuery(this.sessionId ?? undefined);
    void this.consume(this.q);
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

  getName(): string {
    return this.opts.name;
  }

  getOptions(): AgentOptions {
    return this.opts;
  }
}
