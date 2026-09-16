import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const INTERVAL_MS = 15 * 60 * 1000;
const WARN_AT_MS = [60 * 60 * 1000, 15 * 60 * 1000];

export interface CheckpointOptions {
  workDir: string;
  refName: string;
}

/**
 * §6 survival net, per agent: push everything dirty in `workDir` to `refName`
 * every 15 minutes. TTL warnings (T-60m/T-15m) are handled beam-wide by
 * `TTLScheduler`, not here -- one warning message per beam, not one per agent.
 */
export class Checkpoint {
  private interval?: NodeJS.Timeout;

  constructor(private opts: CheckpointOptions) {}

  start(): void {
    this.interval = setInterval(() => {
      this.pushIfDirty('periodic checkpoint').catch((err) =>
        console.error(`[checkpoint:${this.opts.refName}] periodic push failed:`, err),
      );
    }, INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  /** Repoint future pushes at a new ref (e.g. after /rename). History on the old ref is left as-is. */
  setRefName(refName: string): void {
    this.opts.refName = refName;
  }

  force(reason = 'manual checkpoint'): Promise<boolean> {
    return this.pushIfDirty(reason);
  }

  private async pushIfDirty(reason: string): Promise<boolean> {
    const { workDir, refName } = this.opts;
    let status;
    try {
      status = await exec('git', ['status', '--porcelain'], { cwd: workDir });
    } catch {
      return false; // not a git repo (yet) -- nothing to protect
    }
    if (status.stdout.trim() === '') return false;

    await exec('git', ['add', '-A'], { cwd: workDir });
    await exec('git', ['commit', '-m', `${reason} ${new Date().toISOString()}`], { cwd: workDir });
    await exec('git', ['push', 'origin', `HEAD:${refName}`], { cwd: workDir });
    return true;
  }
}

export interface TTLSchedulerOptions {
  expiresAt: Date | null;
  beamAlias: string;
  notify: (text: string) => void;
  /** Called at each warning threshold to get the current set of agents to force-push. */
  getCheckpoints: () => Checkpoint[];
}

/** Beam-wide TTL warnings, decoupled from any one agent's periodic Checkpoint. */
export class TTLScheduler {
  private timers: NodeJS.Timeout[] = [];

  constructor(private opts: TTLSchedulerOptions) {}

  start(): void {
    if (!this.opts.expiresAt) return;
    const expiresAt = this.opts.expiresAt;
    for (const warnBefore of WARN_AT_MS) {
      const delay = expiresAt.getTime() - warnBefore - Date.now();
      if (delay <= 0) continue;
      const timer = setTimeout(() => {
        const minsLeft = Math.round(warnBefore / 60000);
        const checkpoints = this.opts.getCheckpoints();
        Promise.all(checkpoints.map((cp) => cp.force(`T-${minsLeft}m checkpoint`).catch((err) => console.error('[ttl] push failed:', err))))
          .finally(() => {
            this.opts.notify(
              `⏰ ${this.opts.beamAlias} expires in ${minsLeft} minutes. Work is pushed to ` +
                `refs/agents/${this.opts.beamAlias}/*. Run \`tsh beams add\` and clone from there.`,
            );
          });
      }, delay);
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
