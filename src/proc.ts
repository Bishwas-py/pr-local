import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const logRoot = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'pr-local', 'logs');

/** One log file per service, under a per-stack subdir so two stacks that both
 *  have a service called "db" never write to the same file. */
export function logPath(stackId: string, name: string): string {
  return path.join(logRoot(), stackId, `${name}.log`);
}

export function tail(file: string, lines = 40): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
}

export type Running = { child: ChildProcess; exited: Promise<number | null>; log: string };

/** sh -c <cmd> in its own process group, stdout and stderr appended to a log file. */
export function start(cmd: string, cwd: string, env: Record<string, string>, log: string): Running {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a');
  fs.writeSync(out, `\n==== ${new Date().toISOString()} ${cmd}\n`);
  const child = spawn('sh', ['-c', cmd], { cwd, env, stdio: ['ignore', out, out], detached: true });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  exited.finally(() => fs.closeSync(out));
  return { child, exited, log };
}

export async function runOnce(cmd: string, cwd: string, env: Record<string, string>, log: string): Promise<string> {
  const r = start(cmd, cwd, env, log);
  const code = await r.exited;
  if (code !== 0) throw Object.assign(new Error(`${cmd} exited with ${code}`), { logTail: tail(r.log) });
  return r.log;
}

export function stop(r: Running): void {
  if (r.child.pid && r.child.exitCode === null) {
    try {
      process.kill(-r.child.pid, 'SIGTERM');
    } catch {}
  }
}

async function probe(ready: string): Promise<boolean> {
  if (ready.startsWith('tcp://')) {
    const u = new URL(ready);
    return new Promise((resolve) => {
      const s = net.connect({ host: u.hostname, port: Number(u.port) });
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
      s.setTimeout(1000, () => (s.destroy(), resolve(false)));
    });
  }
  try {
    const res = await fetch(ready, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Polls until the service answers, the process dies, or time runs out. */
export async function waitReady(ready: string, timeoutMs: number, exited?: Promise<number | null>): Promise<'ready' | 'exited' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  let dead = false;
  exited?.then(() => (dead = true));
  while (Date.now() < deadline) {
    if (await probe(ready)) return 'ready';
    if (dead) return 'exited';
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'timeout';
}
