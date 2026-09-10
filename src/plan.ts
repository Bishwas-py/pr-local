import path from 'node:path';

export type Service = {
  repo?: string;
  paths?: string[];
  needs?: string[];
  env_files?: string[];
  env?: Record<string, string>;
  ask?: string[];
  link?: string[];
  setup?: string;
  start?: string;
  ready?: string;
  url?: string;
  routes?: string;
  seed?: string;
  agent_env?: string[];
  port?: number;
};
export type Services = Record<string, Service>;

function touched(svc: Service, files: string[]): boolean {
  if (!svc.paths) return files.length > 0;
  return files.some((f) => svc.paths!.some((p) => path.matchesGlob(f, p)));
}

function closure(services: Services, roots: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const svc = services[name];
    if (!svc) throw new Error(`service "${name}" is needed but not defined`);
    for (const n of svc.needs ?? []) visit(n);
    out.push(name);
  };
  for (const name of Object.keys(services)) if (roots.has(name)) visit(name);
  return out;
}

function dependsOn(services: Services, name: string, targets: Set<string>): boolean {
  const stack = [...(services[name].needs ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (targets.has(n)) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(services[n]?.needs ?? []));
  }
  return false;
}

/** Which services a diff needs on screen: the changed ones, every openable
 *  service that shows them, and everything those need. Prefers one too many. */
export function requiredServices(services: Services, changed: Record<string, string[]>): string[] {
  const changedSvcs = new Set(
    Object.entries(services)
      .filter(([, s]) => s.repo && changed[s.repo] && touched(s, changed[s.repo]))
      .map(([n]) => n)
  );
  const openable = Object.entries(services).filter(([, s]) => s.url).map(([n]) => n);
  const roots = new Set(changedSvcs);
  for (const n of openable) {
    if (changedSvcs.size === 0 || dependsOn(services, n, changedSvcs)) roots.add(n);
  }
  return closure(services, roots);
}

/** The screen the diff changed, from file-based routes: drop (groups), skip
 *  [params], pick the route the diff touched most. Falls back to the url. */
export function routeFor(svc: Service, files: string[]): string | undefined {
  if (!svc.url || !svc.routes) return svc.url;
  const base = svc.url.replace(/\/$/, '');
  const counts = new Map<string, number>();
  for (const f of files) {
    const rel = path.relative(svc.routes, f);
    if (rel.startsWith('..')) continue;
    const segs = path.dirname(rel).split('/').filter((s) => s && s !== '.' && !s.startsWith('('));
    if (segs.some((s) => s.includes('['))) continue;
    const route = '/' + segs.join('/');
    counts.set(route, (counts.get(route) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
  return best ? base + (best[0] === '/' ? '' : best[0]) : svc.url;
}

export type Target = { pr: number } | { ticket: string } | { branch: string };

/** A bare argument is a PR number, a ticket id (when the config says what one
 *  looks like) or a branch name. */
export function parseTarget(arg: string, ticketPattern: string | undefined): Target {
  if (/^\d+$/.test(arg)) return { pr: Number(arg) };
  if (ticketPattern) {
    const m = /^([A-Za-z]+)-(\d+)$/.exec(arg);
    if (m) return { ticket: ticketPattern.replace('{id}', m[2]).replace(/^[A-Za-z]+/, (p) => p.toLowerCase()) };
  }
  return { branch: arg };
}

/** One branch from what a PR number or ticket resolved to per repo. When the
 *  candidates differ, the repo the user is standing in decides. */
export function pickBranch(found: Map<string, string[]>, currentRepo: string | undefined): { branch: string } | { ambiguous: string[] } | { none: true } {
  if (found.size === 0) return { none: true };
  if (found.size === 1) return { branch: [...found.keys()][0] };
  for (const [branch, repos] of found) if (currentRepo && repos.includes(currentRepo)) return { branch };
  return { ambiguous: [...found].map(([b, r]) => `${b} (${r.join(', ')})`) };
}

/** A stable 1..99 slot for a set of branches, so one PR (or one combination
 *  of PRs) always lands on the same ports and never on another's. */
export function slotFor(branches: string[]): number {
  const key = [...branches].sort().join('+');
  let h = 0x811c9dc5;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return 1 + (h % 99);
}

/** Each service's base port moved up by slot*100, and every ${port} /
 *  ${name.port} in its strings filled in with the moved ports. */
export function withPorts(services: Services, slot: number): Services {
  const ports: Record<string, number> = {};
  for (const [name, s] of Object.entries(services)) if (s.port) ports[name] = s.port + slot * 100;
  const fill = (name: string, v: string) =>
    v.replace(/\$\{(?:(\w+)\.)?port\}/g, (m, ref) => {
      const p = ports[ref ?? name];
      if (p === undefined) throw new Error(`${name}: ${m} refers to a service without a port`);
      return String(p);
    });
  const out: Services = {};
  for (const [name, s] of Object.entries(services)) {
    const svc: Service = { ...s, port: ports[name] };
    for (const k of ['setup', 'start', 'ready', 'url'] as const) if (svc[k]) svc[k] = fill(name, svc[k]!);
    if (svc.env) svc.env = Object.fromEntries(Object.entries(svc.env).map(([k, v]) => [k, fill(name, String(v))]));
    out[name] = svc;
  }
  return out;
}
