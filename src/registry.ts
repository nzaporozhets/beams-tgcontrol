import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession } from './agent.js';
import { Checkpoint } from './checkpoint.js';
import { TurnRenderer } from './renderer.js';
import type { QuestionManager } from './questions.js';
import type { AgentState, StateStore } from './state.js';
import type { TelegramClient } from './telegram.js';

export interface AgentEntry {
  name: string;
  agent: AgentSession;
  renderer: TurnRenderer;
  checkpoint: Checkpoint;
  status: 'running' | 'stopped' | 'crashed';
}

export interface SpawnOptions {
  cwd: string;
  model: string;
  fallbackModel: string;
  effort: EffortLevel;
  resume?: string;
}

export interface RegistryDefaults {
  model: string;
  fallbackModel: string;
  effort: EffortLevel;
  workDirBase: string;
  appendSystemPrompt: string;
  beamAlias: string;
}

/**
 * Owns every agent running in this beam. `TelegramClient` and `QuestionManager`
 * are shared singletons passed in; `AgentSession`/`TurnRenderer`/`Checkpoint`
 * are one-per-agent, created here on spawn.
 */
export class AgentRegistry {
  private agents = new Map<string, AgentEntry>();
  private focused: string | null = null;

  constructor(
    private tg: TelegramClient,
    private questions: QuestionManager,
    private state: StateStore,
    private getChatId: () => number | null,
    private notify: (text: string) => void,
    private defaults: RegistryDefaults,
  ) {}

  spawn(name: string, opts: SpawnOptions): AgentEntry {
    const renderer = new TurnRenderer(this.tg, this.getChatId, name);
    const checkpoint = new Checkpoint({ workDir: opts.cwd, refName: this.refName(name) });
    const agent = new AgentSession(
      {
        name,
        cwd: opts.cwd,
        model: opts.model,
        fallbackModel: opts.fallbackModel,
        effort: opts.effort,
        appendSystemPrompt: this.defaults.appendSystemPrompt,
        resume: opts.resume,
      },
      this.questions,
      (msg) => renderer.handle(msg),
      (text) => this.notify(`[${name}] ${text}`),
      () => this.persist(),
      (err) => {
        const entry = this.agents.get(name);
        if (entry) entry.status = 'crashed';
        this.persist();
        this.notify(`[${name}] 💥 agent crashed: ${err}. /restart ${name} to resume.`);
      },
    );
    checkpoint.start();

    const entry: AgentEntry = { name, agent, renderer, checkpoint, status: 'running' };
    this.agents.set(name, entry);
    if (this.focused === null) this.focused = name;
    this.persist();
    return entry;
  }

  /** Convenience wrapper for /new: fills in beam-wide defaults, no resume. */
  spawnNamed(name: string, cwdOverride?: string): AgentEntry {
    const cwd = cwdOverride ?? join(this.defaults.workDirBase, name);
    mkdirSync(cwd, { recursive: true });
    return this.spawn(name, {
      cwd,
      model: this.defaults.model,
      fallbackModel: this.defaults.fallbackModel,
      effort: this.defaults.effort,
    });
  }

  stop(name: string): boolean {
    const entry = this.agents.get(name);
    if (!entry) return false;
    entry.agent.close();
    entry.checkpoint.stop();
    entry.status = 'stopped';
    if (this.focused === name) this.focused = null;
    this.persist();
    return true;
  }

  async restart(name: string): Promise<boolean> {
    const entry = this.agents.get(name);
    if (!entry) return false;
    await entry.agent.restart();
    entry.status = 'running';
    this.persist();
    return true;
  }

  rename(oldName: string, newName: string): boolean {
    const entry = this.agents.get(oldName);
    if (!entry || this.agents.has(newName)) return false;
    this.agents.delete(oldName);
    entry.name = newName;
    entry.agent.setName(newName);
    entry.renderer.setName(newName);
    entry.checkpoint.setRefName(this.refName(newName));
    this.agents.set(newName, entry);
    if (this.focused === oldName) this.focused = newName;
    this.persist();
    return true;
  }

  get(name: string): AgentEntry | undefined {
    return this.agents.get(name);
  }

  list(): AgentEntry[] {
    return [...this.agents.values()];
  }

  count(): number {
    return this.agents.size;
  }

  getFocusedName(): string | null {
    return this.focused;
  }

  getFocused(): AgentEntry | undefined {
    return this.focused ? this.agents.get(this.focused) : undefined;
  }

  setFocused(name: string): boolean {
    if (!this.agents.has(name)) return false;
    this.focused = name;
    this.persist();
    return true;
  }

  private refName(name: string): string {
    return `refs/agents/${this.defaults.beamAlias}/${name}`;
  }

  private persist(): void {
    const agentsState: Record<string, AgentState> = {};
    for (const [name, entry] of this.agents) {
      const opts = entry.agent.getOptions();
      agentsState[name] = {
        sessionId: entry.agent.getSessionId(),
        cwd: opts.cwd,
        model: opts.model,
        effort: opts.effort,
        status: entry.status,
      };
    }
    this.state.update({ agents: agentsState, focused: this.focused });
  }
}
