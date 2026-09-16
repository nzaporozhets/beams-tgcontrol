import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

export interface AgentState {
  sessionId: string | null;
  cwd: string;
  model: string;
  effort: EffortLevel;
  status: 'running' | 'stopped' | 'crashed';
}

export interface SupervisorState {
  offset: number;
  chatId: number | null;
  focused: string | null;
  agents: Record<string, AgentState>;
}

const DEFAULT_STATE: SupervisorState = { offset: 0, chatId: null, focused: null, agents: {} };

/** Small JSON-file-backed state store. Survives supervisor restarts within one beam. */
export class StateStore {
  private path: string;
  private state: SupervisorState;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try {
        this.state = migrate(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        this.state = { ...DEFAULT_STATE };
      }
    } else {
      this.state = { ...DEFAULT_STATE };
    }
  }

  get(): SupervisorState {
    return this.state;
  }

  update(patch: Partial<SupervisorState>): void {
    this.state = { ...this.state, ...patch };
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
}

/**
 * v0 persisted a flat `{ offset, chatId, sessionId }` shape (one implicit agent). Wrap that
 * into the multi-agent `agents` map so an in-place upgrade doesn't strand an existing
 * session -- the migrated entry's cwd/model/effort are placeholders, overwritten by
 * main.ts's fresh-install path when it resumes/spawns from env-var defaults.
 */
function migrate(raw: Record<string, unknown>): SupervisorState {
  if (raw.agents !== undefined) {
    return { ...DEFAULT_STATE, ...raw } as SupervisorState;
  }
  if ('sessionId' in raw) {
    const legacySessionId = (raw.sessionId as string | null) ?? null;
    return {
      offset: (raw.offset as number) ?? 0,
      chatId: (raw.chatId as number | null) ?? null,
      focused: 'default',
      agents: {
        default: {
          sessionId: legacySessionId,
          cwd: '',
          model: '',
          effort: 'high',
          status: 'running',
        },
      },
    };
  }
  return { ...DEFAULT_STATE, ...raw } as SupervisorState;
}
