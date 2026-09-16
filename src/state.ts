import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SupervisorState {
  offset: number;
  chatId: number | null;
  sessionId: string | null;
}

const DEFAULT_STATE: SupervisorState = { offset: 0, chatId: null, sessionId: null };

/** Small JSON-file-backed state store. Survives supervisor restarts within one beam. */
export class StateStore {
  private path: string;
  private state: SupervisorState;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try {
        this.state = { ...DEFAULT_STATE, ...JSON.parse(readFileSync(path, 'utf8')) };
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
