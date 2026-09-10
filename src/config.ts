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

export function findConfig(from = process.cwd()): string | undefined {
  let dir = from;
  for (;;) {
    for (const n of CONFIG_NAMES) {
      const f = path.join(dir, n);
      if (fs.existsSync(f)) return f;
    }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function expand(p: string, root: string): string {
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(root, p);
}

export function loadConfig(file?: string): Config {
  const f = file ?? findConfig();
  if (!f) throw new Error(`no ${CONFIG_NAMES[0]} found here or above; pass --config`);
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
