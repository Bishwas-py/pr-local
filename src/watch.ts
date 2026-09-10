import fs from 'node:fs';

const ERROR = [/\|\s*(4\d\d|5\d\d)\s*\|/, /\[(4\d\d|5\d\d)\]/, /"level":"(error|fatal)"/, /\blevel=(error|fatal)\b/, /^\s*\w*Error\b:/, /\b(panic|FATAL|Unhandled|unhandled)\b/];
const NOISE = [/"level":"warning"/, /\blevel=warn/];

export function isErrorLine(line: string): boolean {
  const l = line.replace(/\x1b\[[0-9;]*m/g, '');
  if (NOISE.some((r) => r.test(l))) return false;
  return ERROR.some((r) => r.test(l));
}

/** The line with everything volatile removed, so one cause has one signature. */
export function errorSignature(line: string): string {
  return line
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\d{4}[-/]\d{2}[-/]\d{2}[ T-]*\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '')
    .replace(/\b\d+(\.\d+)?\s*(µs|ms|ns|s)\b/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export type Burst = { service: string; lines: string[] };

/** Polls service logs; hands each burst of new error lines to onBurst once. */
export class LogWatcher {
  private offsets = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private pending = new Map<string, string[]>();
  private flush?: NodeJS.Timeout;
  private files: Record<string, string>;
  private onBurst: (b: Burst) => void;
  private settleMs: number;
  constructor(files: Record<string, string>, onBurst: (b: Burst) => void, settleMs = 4000) {
    this.files = files;
    this.onBurst = onBurst;
    this.settleMs = settleMs;
    for (const [s, f] of Object.entries(files)) this.offsets.set(s, fs.existsSync(f) ? fs.statSync(f).size : 0);
  }
  start(): void {
    this.timer = setInterval(() => this.poll(), 1000);
    this.timer.unref();
  }
  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.flush);
  }
  private poll(): void {
    for (const [service, file] of Object.entries(this.files)) {
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      const from = this.offsets.get(service) ?? 0;
      if (size <= from) continue;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      this.offsets.set(service, size);
      const errs = buf.toString('utf8').split('\n').filter(isErrorLine);
      if (errs.length) this.pending.set(service, [...(this.pending.get(service) ?? []), ...errs]);
    }
    if (this.pending.size && !this.flush) {
      this.flush = setTimeout(() => {
        this.flush = undefined;
        const bursts = [...this.pending].map(([service, lines]) => ({ service, lines }));
        this.pending.clear();
        for (const b of bursts) this.onBurst(b);
      }, this.settleMs);
    }
  }
}
