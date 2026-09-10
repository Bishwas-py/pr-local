import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { Services } from './plan.ts';

export type Config = {
  file: string;
  default_branch: string;
  ticket?: string;
  ready_timeout: number;
  repos: Record<string, string>;
  services: Services;
};

export const CONFIG_NAMES = ['deploy-dev.yaml', 'deploy-dev.yml'];

function configIn(dir: string): string | undefined {
  return CONFIG_NAMES.map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
}

/** Does this config name cwd (or an ancestor of it) as one of its repos? */
function claims(file: string, cwd: string): boolean {
  let raw: any;
  try {
    raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  const root = path.dirname(file);
  return Object.values(raw?.repos ?? {}).some((p) => {
    const repo = expand(String(p), root);
    return cwd === repo || cwd.startsWith(repo + path.sep);
  });
}

/** Up from cwd first (a config in your own repo wins), then up again looking
 *  one level sideways at each step for a config that names cwd as a repo.
 *  The sideways walk stops at $HOME. */
export function findConfig(from = process.cwd(), home = os.homedir()): string | undefined {
  const cwd = path.resolve(from);
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const f = configIn(dir);
    if (f) return f;
    if (path.dirname(dir) === dir) break;
  }
  home = path.resolve(home);
  for (let dir = cwd; dir === home || dir.startsWith(home + path.sep); dir = path.dirname(dir)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {}
    const claimers = entries
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => configIn(path.join(dir, d.name)))
      .filter((f): f is string => !!f && claims(f, cwd));
    if (claimers.length > 1) throw new Error(`both ${claimers.join(' and ')} name ${cwd} as a repo; pass --config to say which`);
    if (claimers.length === 1) return claimers[0];
    if (dir === home) break;
  }
  return undefined;
}

function expand(p: string, root: string): string {
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(root, p);
}

export function loadConfig(file?: string): Config {
  const f = file ?? findConfig();
  if (!f) throw new Error(`no ${CONFIG_NAMES[0]} found from ${process.cwd()} upward, nor in a sibling directory below ${os.homedir()} that names this repo; pass --config`);
  const raw = YAML.parse(fs.readFileSync(f, 'utf8')) ?? {};
  const root = path.dirname(path.resolve(f));
  const repos: Record<string, string> = {};
  for (const [name, p] of Object.entries(raw.repos ?? {})) repos[name] = expand(String(p), root);
  const services: Services = raw.services ?? {};
  for (const [name, svc] of Object.entries(services)) {
    if (svc.repo && !repos[svc.repo]) throw new Error(`service "${name}" uses repo "${svc.repo}" which is not in repos`);
    for (const n of svc.needs ?? []) if (!services[n]) throw new Error(`service "${name}" needs "${n}" which is not defined`);
    for (const n of svc.agent_env ?? []) if ((svc.ask ?? []).includes(n)) throw new Error(`service "${name}" lists "${n}" in both ask and agent_env; a prompted secret never reaches the agent`);
  }
  return {
    file: path.resolve(f),
    default_branch: raw.default_branch ?? 'main',
    ticket: raw.ticket,
    ready_timeout: Number(raw.ready_timeout ?? 180),
    repos,
    services
  };
}
