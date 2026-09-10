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
  agent?: boolean;
  repos: Record<string, string>;
  services: Services;
};

export const CONFIG_NAMES = ['pr-local.yaml', 'pr-local.yml'];

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
  if (!f) throw new Error(`no ${CONFIG_NAMES[0]} found from ${process.cwd()} upward, nor in a sibling directory below ${os.homedir()} that names this repo. Run "pr-local init" to scaffold one, or pass --config.`);
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
    agent: raw.agent === false ? false : undefined,
    repos,
    services
  };
}


/** A commented starter config, written by `pr-local init`. Every value is an
 *  example to replace; nothing here is required verbatim. */
export function sampleConfig(): string {
  return `# pr-local config. Data, not code: this describes YOUR stack so the tool
# can run any PR locally. Paths are relative to this file. Delete what you
# do not have; add services the same way.
#
# Run:  pr-local --pr 12        (or a branch name, or a ticket id)

default_branch: main
# A bare ticket id like ABC-123 becomes a branch search. Drop this line if you
# do not name branches after tickets.
ticket: abc-{id}

# name: path-to-that-repo-checkout on this machine
repos:
  api: .
  web: ../web-frontend

services:
  # Something already running (a database). No repo, no start: just a probe.
  db:
    ready: tcp://localhost:5432

  api:
    repo: api
    needs: [db]
    # dotenv files read from your normal checkout and injected into the process
    env_files: [.env]
    # base port; each PR gets its own stable offset, and \${port} fills in below
    port: 8080
    env:
      PORT: "\${port}"
    # a required var with no default is asked once and remembered, never logged
    # ask: [SOME_API_KEY]
    # one-shot before start (migrations), then the long-running command
    # setup: ./migrate.sh
    start: <how this service starts, e.g. go run . or npm start>
    ready: http://localhost:\${port}/health
    # free-text hint used when seeding data the PR needs to be seen
    # seed: "Postgres at $DATABASE_URL; ./seed.sql refills the tables the UI reads."

  web:
    repo: web
    needs: [api]
    env_files: [.env, .env.local]
    port: 5173
    env:
      API_URL: "http://localhost:\${api.port}"
    # symlinked from your checkout into the scratch worktree so install is skipped
    link: [node_modules]
    start: <how this frontend starts, e.g. npm run dev -- --port \${port}>
    ready: http://localhost:\${port}/
    # where a human opens it; makes this service the screen pr-local opens
    url: http://localhost:\${port}
    # directory of file-based routes, so the screen matches the diff
    routes: src/routes
`;
}
