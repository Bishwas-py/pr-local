import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { requiredServices, routeFor, parseTarget, pickBranch, slotFor, withPorts, type Service, type Target } from './plan.ts';
import { prBranch, remoteBranches, prepareWorktree, changedFiles, diffText, autosolveChanges, formatAutosolveSummary, type Checkout, type Change } from './git.ts';
import { SecretStore, readEnvFiles, isSecretName, promptSecret, unsetVars, type Secrets } from './secrets.ts';
import { git, openPrs, formatPrList } from './git.ts';
import { start, runOnce, waitReady, stop, tail, type Running } from './proc.ts';
import { runAgent, autosolvePrompt, seedPrompt, type Failure } from './agent.ts';

const USAGE = `usage: deploy-dev [<pr|ticket|branch> ...] [options]

  deploy-dev --pr 12                 run PR 12 instead of the default branch
  deploy-dev --addpr 12 13           run PRs 12 and 13 merged together
  deploy-dev CLA-601                 a ticket id, when the config says what one looks like
  deploy-dev user/some-branch        a branch name
  deploy-dev --pr-list               open PRs in every repo of the stack

options
  --fillindata        seed only the data this diff needs to be seen (uses an agent, minutes and dollars)
  --no-autosolve      when bring-up breaks, stop at the error instead of letting an agent fix it and retry
  --open <path>       open this path instead of the one inferred from the diff
  --services a,b      boot exactly these instead of inferring from the diff
  --config <file>     deploy-dev.yaml to use (default: nearest one upward from cwd)
  --model <name>      agent model (default claude-opus-5)
  --no-open           do not open a browser
  --attempts <n>      autosolve retries per failing step (default 3)
`;

const t0 = Date.now();
const elapsed = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const say = (line: string) => process.stderr.write(`[${elapsed().padStart(6)}] ${line}\n`);
const die = (msg: string): never => {
  process.stderr.write(`deploy-dev: ${msg}\n`);
  process.exit(1);
};

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pr: { type: 'string' },
      addpr: { type: 'boolean' },
      branch: { type: 'string' },
      fillindata: { type: 'boolean' },
      'no-autosolve': { type: 'boolean' },
      open: { type: 'string' },
      services: { type: 'string' },
      config: { type: 'string' },
      model: { type: 'string' },
      'no-open': { type: 'boolean' },
      'pr-list': { type: 'boolean' },
      attempts: { type: 'string', default: '3' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const cfg = loadConfig(values.config);
  if (values['pr-list']) {
    process.stdout.write(formatPrList(Object.fromEntries(Object.entries(cfg.repos).map(([n, d]) => [n, openPrs(d)]))) + '\n');
    return;
  }
  const targets: Target[] = [];
  if (values.pr) targets.push({ pr: Number(values.pr) });
  if (values.branch) targets.push({ branch: values.branch });
  for (const p of positionals) targets.push(parseTarget(p, cfg.ticket));
  return run(cfg, targets, {
    fillindata: !!values.fillindata,
    autosolve: !values['no-autosolve'],
    open: values.open,
    services: values.services?.split(',').map((s) => s.trim()).filter(Boolean),
    model: values.model,
    noOpen: !!values['no-open'],
    attempts: Number(values.attempts)
  });
}

type Opts = { fillindata: boolean; autosolve: boolean; open?: string; services?: string[]; model?: string; noOpen: boolean; attempts: number };

/** One branch name per target. A PR number is looked up in every repo; the
 *  branch it names is what identifies the work everywhere. */
function branchFor(cfg: Config, t: Target): string {
  if ('branch' in t) return t.branch;
  const found = new Map<string, string[]>();
  for (const [name, dir] of Object.entries(cfg.repos)) {
    const hits = 'pr' in t ? [prBranch(dir, t.pr)].filter((b): b is string => !!b) : remoteBranches(dir, `*${t.ticket}*`);
    for (const b of hits) found.set(b, [...(found.get(b) ?? []), name]);
  }
  const label = 'pr' in t ? `PR #${t.pr}` : `ticket ${t.ticket}`;
  const pick = pickBranch(found, currentRepo(cfg));
  if ('branch' in pick) return pick.branch;
  if ('none' in pick) return die(`${label} is not in any repo of ${cfg.file}`);
  return die(`${label} names different branches: ${pick.ambiguous.join('; ')}. Run from inside one of those repos, or pass the branch.`);
}

/** The config repo the current directory is inside, if any. */
function currentRepo(cfg: Config): string | undefined {
  const cwd = process.cwd();
  return Object.entries(cfg.repos).find(([, dir]) => cwd === dir || cwd.startsWith(dir + path.sep))?.[0];
}

async function run(cfg: Config, targets: Target[], opts: Opts) {
  const branches = targets.map((t) => branchFor(cfg, t));
  if (branches.length) say(`branch${branches.length > 1 ? 'es' : ''}: ${branches.join(' + ')}`);
  for (const b of branches) {
    if (!Object.values(cfg.repos).some((dir) => remoteBranches(dir, b).length > 0)) {
      die(`branch ${b} no longer exists on any remote; the PR was probably merged or closed. Try deploy-dev --pr-list for what is open.`);
    }
  }
  const slot = slotFor(branches.length ? branches : [cfg.default_branch]);
  cfg.services = withPorts(cfg.services, slot);
  if (Object.values(cfg.services).some((s) => s.port)) say(`slot ${slot}: ports are base + ${slot * 100}`);

  const store = new SecretStore();
  const checkouts: Record<string, Checkout> = {};
  const changed: Record<string, string[]> = {};
  const links = (repo: string) => [...new Set(Object.values(cfg.services).filter((s) => s.repo === repo).flatMap((s) => s.link ?? []))];
  for (const [name, dir] of Object.entries(cfg.repos)) {
    const present = branches.filter((b) => remoteBranches(dir, b).length > 0);
    const wanted = present.length ? present : [cfg.default_branch];
    checkouts[name] = await withAutosolve(
      { service: name, step: 'merge' },
      () => prepareWorktree(name, dir, wanted, links(name)),
      cfg, opts, () => ({ cwd: path.join(process.env.HOME ?? '', '.cache/deploy-dev/worktrees', name), env: {}, secrets: emptySecrets() }), store
    );
    changed[name] = present.length ? changedFiles(checkouts[name].dir, cfg.default_branch) : [];
    say(`${name}: ${wanted.join(' + ')}${changed[name].length ? `, ${changed[name].length} files changed` : ' (unchanged)'}`);
  }

  const required = opts.services ?? requiredServices(cfg.services, changed);
  say(`booting: ${required.join(', ')}`);

  const envs: Record<string, Record<string, string>> = {};
  const missing: string[] = [];
  for (const name of required) {
    const svc = cfg.services[name];
    const fileEnv = svc.repo ? readEnvFiles(cfg.repos[svc.repo], svc.env_files) : {};
    envs[name] = { ...(process.env as Record<string, string>), ...fileEnv, ...(svc.env ?? {}) };
    for (const k of svc.ask ?? []) {
      const v = envs[name][k] ?? store.get(k);
      if (v) envs[name][k] = v;
      else if (!missing.includes(k)) missing.push(k);
    }
  }
  if (missing.length) {
    if (!process.stdin.isTTY) die(`these are required and not set: ${missing.join(', ')}. Export them or run in a terminal to be asked once.`);
    say(`${missing.length} required var${missing.length > 1 ? 's' : ''} not set yet, asking once`);
    for (const k of missing) store.set(k, await promptSecret(k));
    for (const name of required) for (const k of cfg.services[name].ask ?? []) envs[name][k] ??= store.get(k)!;
  }
  const secretsFor = (name: string): Secrets => {
    const shown = cfg.services[name].agent_env ?? [];
    const names = Object.keys(envs[name]).filter((k) => !shown.includes(k) && (isSecretName(k) || (cfg.services[name].ask ?? []).includes(k)));
    return { names, values: [...names.map((k) => envs[name][k]), ...store.values()].filter(Boolean) };
  };

  const running: Running[] = [];
  const shutdown = () => {
    for (const r of running) stop(r);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const status: Record<string, string> = {};
  for (const name of required) {
    const svc = cfg.services[name];
    const co = svc.repo ? checkouts[svc.repo] : undefined;
    const cwd = co?.dir ?? path.dirname(cfg.file);
    const env = envs[name];
    const ctx = () => ({ cwd, env, secrets: secretsFor(name), extraEnv: pick(env, svc.agent_env) });
    if (svc.ready && (await waitReady(svc.ready, 2000)) === 'ready') {
      if (svc.repo) {
        const url = opts.open ?? openUrl(cfg, required, changed);
        say(`${name} already answers at ${svc.ready}: this PR is already running${url ? `, screen: ${url}` : ''}`);
        if (url && !opts.noOpen) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
        for (const r of running) stop(r);
        process.exit(0);
      }
      status[name] = `already running at ${svc.ready}`;
      say(`${name}: already running at ${svc.ready}`);
      continue;
    }
    if (svc.setup) {
      say(`${name}: ${svc.setup}`);
      await withAutosolve({ service: name, step: 'setup', command: svc.setup }, () => runOnce(`${name}.setup`, svc.setup!, cwd, env), cfg, opts, ctx, store);
    }
    if (svc.start) {
      await withAutosolve(
        { service: name, step: 'start', command: svc.start },
        async () => {
          say(`${name}: ${svc.start}`);
          const r = start(name, svc.start!, cwd, env);
          running.push(r);
          const outcome = svc.ready ? await waitReady(svc.ready, cfg.ready_timeout * 1000, r.exited) : 'ready';
          if (outcome !== 'ready') {
            stop(r);
            running.splice(running.indexOf(r), 1);
            throw Object.assign(new Error(outcome === 'exited' ? `exited before ${svc.ready} answered` : `${svc.ready} did not answer within ${cfg.ready_timeout}s`), { logTail: tail(r.log) });
          }
          status[name] = `started, log ${r.log}`;
          say(`${name}: ready at ${svc.ready ?? '(no ready check)'}`);
        },
        cfg, opts, ctx, store
      );
    } else if (svc.ready && status[name] === undefined) {
      die(`${name} is not reachable at ${svc.ready} and has no start command`);
    }
  }

  const url = opts.open ?? openUrl(cfg, required, changed);
  say(`stack up in ${elapsed()}${url ? `, screen: ${url}` : ''}`);
  if (url && !opts.noOpen) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();

  if (opts.fillindata) await fillInData(cfg, required, checkouts, changed, envs, secretsFor, opts);

  const changes: Record<string, Change[]> = {};
  for (const [name, co] of Object.entries(checkouts)) {
    const cs = autosolveChanges(co);
    if (cs.length) changes[name] = cs;
  }
  process.stderr.write('\n');
  process.stderr.write(`ready in ${elapsed()}${opts.fillindata ? ' (reload the screen to see the seeded data)' : ''}\n`);
  for (const name of required) process.stderr.write(`  ${name.padEnd(10)} ${status[name] ?? 'external'}\n`);
  if (url) process.stderr.write(`  screen     ${url}\n`);
  process.stderr.write(formatAutosolveSummary(changes) + '\n');
  if (running.length) process.stderr.write(`services keep running; ctrl-c stops them\n`);
  else process.exit(0);
}

function openUrl(cfg: Config, required: string[], changed: Record<string, string[]>): string | undefined {
  const openable = required.map((n) => [n, cfg.services[n]] as const).filter(([, s]) => s.url);
  const withRoute = openable.find(([, s]) => s.repo && changed[s.repo]?.length && s.routes);
  if (withRoute) return routeFor(withRoute[1], changed[withRoute[1].repo!]);
  const changedFirst = openable.find(([, s]) => s.repo && changed[s.repo]?.length) ?? openable.at(-1);
  return changedFirst?.[1].url;
}

const emptySecrets = (): Secrets => ({ names: [], values: [] });

type Ctx = () => { cwd: string; env: Record<string, string>; secrets: Secrets; extraEnv?: Record<string, string> };

/** A failure that names an unset variable is answered by asking once, not by an agent. */
async function askForUnset(failure: Failure, env: Record<string, string>, store: SecretStore): Promise<boolean> {
  const names = unsetVars(`${failure.message}\n${failure.logTail}`, env);
  if (!names.length) return false;
  if (!process.stdin.isTTY) die(`${failure.service} needs ${names.join(', ')}. Export it, or run in a terminal to be asked once.`);
  for (const n of names) {
    const v = store.get(n) ?? (await promptSecret(n));
    store.set(n, v);
    env[n] = v;
  }
  say(`${failure.service}: ${names.join(', ')} now set, retrying`);
  return true;
}

const pick = (env: Record<string, string>, names: string[] = []) =>
  Object.fromEntries(names.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));

async function withAutosolve<T>(where: Omit<Failure, 'message' | 'logTail'>, fn: () => Promise<T> | T, cfg: Config, opts: Opts, ctx: Ctx, store: SecretStore): Promise<T> {
  const tried: string[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const failure: Failure = { ...where, message: e.message, logTail: e.logTail ?? '' };
      if (await askForUnset(failure, ctx().env, store)) {
        attempt--;
        continue;
      }
      if (!opts.autosolve) {
        process.stderr.write(`\n${failure.service} failed at ${failure.step}: ${failure.message}\n${failure.logTail}\n`);
        die(`autosolve is off; fix it by hand in ${ctx().cwd} or run again without --no-autosolve`);
      }
      if (attempt > opts.attempts) {
        process.stderr.write(`\n${failure.service} still fails at ${failure.step} after ${opts.attempts} autosolve attempts: ${failure.message}\n`);
        process.stderr.write(`what it tried:\n${tried.map((t) => `  - ${t}`).join('\n')}\n${failure.logTail}\n`);
        die('giving up');
      }
      say(`${failure.service} failed at ${failure.step}: ${failure.message}. autosolve attempt ${attempt}/${opts.attempts}`);
      const c = ctx();
      const envNames = { set: Object.keys(c.env), unset: [] as string[] };
      const actx = { cwd: e.dir ?? c.cwd, envNames, secrets: c.secrets, model: opts.model, extraEnv: c.extraEnv };
      const before = git(actx.cwd, 'rev-parse', 'HEAD');
      const r = await runAgent(autosolvePrompt(failure, actx), actx, (l) => say(`  agent: ${l}`));
      tried.push(r.text.split('\n')[0].slice(0, 200));
      say(`autosolve: ${r.turns} turns, $${r.costUsd.toFixed(2)}`);
      if (git(actx.cwd, 'rev-parse', 'HEAD') === before) {
        process.stderr.write(`\n${failure.service} still fails at ${failure.step} and autosolve changed nothing: ${failure.message}\nwhat it said:\n  ${r.text.split('\n').slice(0, 12).join('\n  ')}\n`);
        die('giving up');
      }
    }
  }
}

async function fillInData(cfg: Config, required: string[], checkouts: Record<string, Checkout>, changed: Record<string, string[]>, envs: Record<string, Record<string, string>>, secretsFor: (n: string) => Secrets, opts: Opts) {
  const seeders = required.filter((n) => cfg.services[n].seed);
  if (!seeders.length) return say('fillindata: no service declares how to seed, skipping');
  const diff = Object.entries(checkouts).filter(([n]) => changed[n]?.length).map(([n, co]) => `# repo ${n}\n${diffText(co.dir, cfg.default_branch)}`).join('\n\n');
  if (!diff.trim()) return say('fillindata: nothing changed, no data needed');
  const first = seeders[0];
  const svc = cfg.services[first];
  const cwd = svc.repo ? checkouts[svc.repo].dir : path.dirname(cfg.file);
  const hints = seeders.map((n) => ({ service: n, hint: cfg.services[n].seed! }));
  const secrets = secretsFor(first);
  const envNames = { set: Object.keys(envs[first]), unset: [] };
  const extra = pick(envs[first], svc.agent_env);
  const running = required.flatMap((n) => (cfg.services[n].ready ? [{ service: n, url: cfg.services[n].url ?? cfg.services[n].ready! }] : []));
  say(`fillindata: reading the diff to decide what data the change needs`);
  const actx = { cwd, envNames, secrets, model: opts.model, extraEnv: extra, maxTurns: 30 };
  const r = await runAgent(seedPrompt(diff, hints, running, actx), actx, (l) => say(`  agent: ${l}`));
  say(`fillindata: ${r.text.split('\n')[0].slice(0, 200)} (${r.turns} turns, $${r.costUsd.toFixed(2)})`);
}

try {
  await main();
} catch (e: any) {
  die(e.message);
}
