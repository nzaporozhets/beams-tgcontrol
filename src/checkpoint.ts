import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const INTERVAL_MS = 15 * 60 * 1000;
const WARN_AT_MS = [60 * 60 * 1000, 15 * 60 * 1000];

export interface CheckpointOptions {
  workDir: string;
  beamAlias: string;
  expiresAt: Date | null;
  notify: (text: string) => void;
}

/**
 * §6 survival net: push everything dirty in `workDir` every 15 minutes, and
 * push-then-warn at T-60m and T-15m before the beam is purged.
 */
export class Checkpoint {
  private interval?: NodeJS.Timeout;
  private warnTimers: NodeJS.Timeout[] = [];

  constructor(private opts: CheckpointOptions) {}

  start(): void {
    this.interval = setInterval(() => {
      this.pushIfDirty('periodic checkpoint').catch((err) => console.error('[checkpoint] periodic push failed:', err));
    }, INTERVAL_MS);

    if (!this.opts.expiresAt) return;
    const expiresAt = this.opts.expiresAt;
    for (const warnBefore of WARN_AT_MS) {
      const delay = expiresAt.getTime() - warnBefore - Date.now();
      if (delay <= 0) continue;
      const timer = setTimeout(() => {
        const minsLeft = Math.round(warnBefore / 60000);
        this.pushIfDirty(`T-${minsLeft}m checkpoint`)
          .catch((err) => console.error('[checkpoint] TTL push failed:', err))
          .finally(() => {
            this.opts.notify(
              `⏰ ${this.opts.beamAlias} expires in ${minsLeft} minutes. Work is pushed to ` +
                `refs/agents/${this.opts.beamAlias}. Run \`tsh beams add\` and clone from there.`,
            );
          });
      }, delay);
      this.warnTimers.push(timer);
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    for (const t of this.warnTimers) clearTimeout(t);
    this.warnTimers = [];
  }

  force(reason = 'manual checkpoint'): Promise<boolean> {
    return this.pushIfDirty(reason);
  }

  private async pushIfDirty(reason: string): Promise<boolean> {
    const { workDir, beamAlias } = this.opts;
    let status;
    try {
      status = await exec('git', ['status', '--porcelain'], { cwd: workDir });
    } catch {
      return false; // not a git repo (yet) -- nothing to protect
    }
    if (status.stdout.trim() === '') return false;

    await exec('git', ['add', '-A'], { cwd: workDir });
    await exec('git', ['commit', '-m', `${reason} ${new Date().toISOString()}`], { cwd: workDir });
    await exec('git', ['push', 'origin', `HEAD:refs/agents/${beamAlias}`], { cwd: workDir });
    return true;
  }
}
