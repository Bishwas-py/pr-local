import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Service, Services } from './plan.ts';
import type { Config } from './config.ts';

const has = (dir: string, f: string) => fs.existsSync(path.join(dir, f));

function nodeManager(dir: string): string {
  if (has(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(dir, 'yarn.lock')) return 'yarn';
  if (has(dir, 'bun.lockb')) return 'bun';
  return 'npm';
}

function firstDir(dir: string, candidates: string[]): string | undefined {
  return candidates.find((c) => fs.existsSync(path.join(dir, c)));
}

/** How the app in `dir` runs, inferred from its files. `start` is undefined
 *  when nothing recognisable is found, so the caller can say so. */
export function detectService(dir: string): Service {
  const svc: Service = {};
  const envs = ['.env', '.env.local'].filter((f) => has(dir, f));
  if (envs.length) svc.env_files = envs;

  if (has(dir, 'package.json')) {
    let pkg: any = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {}
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const script = pkg.scripts?.dev ? 'dev' : pkg.scripts?.start ? 'start' : undefined;
    const mgr = nodeManager(dir);
    if (has(dir, 'node_modules')) svc.link = ['node_modules'];

    const next = '@next' in deps || 'next' in deps;
    if (next) {
      svc.port = 3000;
      svc.start = script ? `${mgr} run ${script} -- -p \${port}` : undefined;
      svc.routes = firstDir(dir, ['app', 'src/app', 'pages', 'src/pages']);
    } else {
      // Vite / SvelteKit and friends
      svc.port = 5173;
      svc.start = script ? `${mgr} run ${script} -- --port \${port}` : undefined;
      svc.routes = firstDir(dir, ['src/routes', 'src/pages']);
    }
    const health = firstDir(dir, ['src/routes/api/health', 'app/api/health', 'src/app/api/health']);
    svc.ready = health ? 'http://localhost:${port}/api/health' : 'http://localhost:${port}/';
    svc.url = 'http://localhost:${port}';
    return svc;
  }

  if (has(dir, 'go.mod')) {
    svc.port = 8080;
    svc.start = 'go run .';
    svc.env = { PORT: '${port}' };
    const health = healthInSource(dir, ['.go']);
    svc.ready = health ? 'http://localhost:${port}/health' : 'http://localhost:${port}/';
    svc.url = 'http://localhost:${port}';
    return svc;
  }

  if (has(dir, 'manage.py')) {
    svc.port = 8000;
    svc.start = 'python manage.py runserver 0.0.0.0:${port}';
    svc.ready = 'http://localhost:${port}/';
    svc.url = 'http://localhost:${port}';
    return svc;
  }

  return svc; // start undefined: undetectable
}

function healthInSource(dir: string, exts: string[]): boolean {
  try {
    const out = execFileSync('git', ['grep', '-l', '-i', '/health'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return exts.some((e) => out.includes(e));
  } catch {
    return false;
  }
}

function defaultBranch(dir: string): string {
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (ref.includes('/')) return ref.split('/').slice(1).join('/');
  } catch {}
  for (const b of ['main', 'master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], { cwd: dir, stdio: 'ignore' });
      return b;
    } catch {}
  }
  return 'main';
}

/** The stack, detected from the repo at `dir`, as a virtual Config with no file. */
export function detectStack(dir: string): Config & { detected: true } {
  const name = path.basename(path.resolve(dir)) || 'app';
  const svc = detectService(dir);
  svc.repo = name;
  const services: Services = { [name]: svc };
  return {
    file: '<auto-detected>',
    default_branch: defaultBranch(dir),
    ticket: undefined,
    ready_timeout: 180,
    agent: undefined,
    repos: { [name]: path.resolve(dir) },
    services,
    detected: true
  };
}
