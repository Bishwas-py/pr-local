import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { requiredServices, routeFor, parseTarget, pickBranch, slotFor, withPorts, type Target } from './plan.ts';
import { git, gitOk, openPrs, formatPrList, prBranch, remoteBranches, prepareWorktree, worktreePath, changedFiles, diffText, autosolveChanges, formatAutosolveSummary, type Checkout, type Change } from './git.ts';
import { SecretStore, readEnvFiles, parseEnvFile, isSecretName, promptSecret, unsetVars, type Secrets } from './secrets.ts';
import { start, runOnce, waitReady, stop, tail, logPath, type Running } from './proc.ts';
import { runAgent, autosolvePrompt, checkPrompt, watchPrompt, parseReport, type Failure, type Report, type AgentContext } from './agent.ts';
import { LogWatcher, errorSignature } from './watch.ts';

const USAGE = `usage: deploy-dev [<pr|ticket|branch> ...] [options]

  deploy-dev --pr 12                 run PR 12 instead of the default branch
  deploy-dev --addpr 12 13           run PRs 12 and 13 merged together
  deploy-dev PROJ-601                 a ticket id, when the config says what one looks like
  deploy-dev user/some-branch        a branch name
  deploy-dev --pr-list               open PRs in every repo of the stack

Everything else is automatic: a boot failure is fixed and retried, the data
the change needs is seeded, the screen is checked against the running stack,
and errors logged while you click are looked into. Every change is a commit
on the scratch branch, prefixed fix: (belongs in the PR) or local: (this
machine only), and summarised at the end.

options
  --open <path>       open this path instead of the one inferred from the diff
  --services a,b      boot exactly these instead of inferring from the diff
  --config <file>     deploy-dev.yaml to use (default: nearest one that names this repo)
  --model <name>      agent model (default claude-opus-5)
  --no-agent          no model calls at all: stop at errors, seed nothing, watch nothing
  --no-open           do not open a browser
  --attempts <n>      fix attempts per failing step (default 3)
`;

const t0 = Date.now();
const elapsed = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const say = (line: string) => process.stderr.write(`[${elapsed().padStart(6)}] ${line}\n`);
let cleanup: () => void = () => {};
const die = (msg: string): never => {
  process.stderr.write(`deploy-dev: ${msg}\n`);
  cleanup();
  process.exit(1);
};
process.on('uncaughtException', (e) => die(`unexpected: ${e.message}`));
process.on('unhandledRejection', (e: any) => die(`unexpected: ${e?.message ?? e}`));
const openBrowser = (url: string) => spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();

type Opts = { open?: string; services?: string[]; model?: string; noOpen: boolean; noAgent: boolean; attempts: number };

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pr: { type: 'string' },
      addpr: { type: 'boolean' },
      branch: { type: 'string' },
      open: { type: 'string' },
      services: { type: 'string' },
      config: { type: 'string' },
      model: { type: 'string' },
      'no-open': { type: 'boolean' },
      'no-agent': { type: 'boolean' },
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
    open: values.open,
    services: values.services?.split(',').map((s) => s.trim()).filter(Boolean),
    model: values.model,
    noOpen: !!values['no-open'],
    noAgent: !!values['no-agent'],
    attempts: Number(values.attempts)
  });
}

/** The config repo the current directory is inside, if any. */
function currentRepo(cfg: Config): string | undefined {
  const cwd = process.cwd();
  return Object.entries(cfg.repos).find(([, dir]) => cwd === dir || cwd.startsWith(dir + path.sep))?.[0];
}

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

const pick = (env: Record<string, string>, names: string[] = []) => Object.fromEntries(names.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
const emptySecrets = (): Secrets => ({ names: [], values: [] });

/** Machine-local overrides the agents may add, committed on the scratch branch. */
const LOCAL_ENV = '.deploy-dev.env';
function localEnv(dir: string | undefined): Record<string, string> {
  const f = dir && path.join(dir, LOCAL_ENV);
  return f && fs.existsSync(f) ? parseEnvFile(fs.readFileSync(f, 'utf8')) : {};
}

async function run(cfg: Config, targets: Target[], opts: Opts) {
  const stackId = createHash('sha1').update(cfg.file).digest('hex').slice(0, 8);
  for (const [name, dir] of Object.entries(cfg.repos)) {
    if (!fs.existsSync(dir) || !gitOk(dir, 'rev-parse', '--git-dir')) die(`repo "${name}" in ${cfg.file} points at ${dir}, which is not a git repository`);
    if (!gitOk(dir, 'remote', 'get-url', 'origin')) die(`repo "${name}" at ${dir} has no "origin" remote; deploy-dev fetches PR branches from origin`);
  }
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
    const wt = worktreePath(name, dir);
    checkouts[name] = await withFix({ service: name, step: 'merge' }, () => prepareWorktree(name, dir, wanted, links(name)), opts, () => ({ cwd: wt, env: {}, secrets: emptySecrets() }), store);
    changed[name] = present.length ? changedFiles(checkouts[name].dir, cfg.default_branch) : [];
    say(`${name}: ${wanted.join(' + ')}${changed[name].length ? `, ${changed[name].length} files changed` : ' (unchanged)'}`);
  }

  const required = opts.services ?? requiredServices(cfg.services, changed);
  say(`booting: ${required.join(', ')}`);

  // Env per service: the checkout's env files, the config's literals, the
  // scratch branch's local overrides, then the secrets asked for once.
  const envs: Record<string, Record<string, string>> = {};
  const envFor = (name: string) => {
    const svc = cfg.services[name];
    const fileEnv = svc.repo ? readEnvFiles(cfg.repos[svc.repo], svc.env_files) : {};
    const env = { ...(process.env as Record<string, string>), ...fileEnv, ...(svc.env ?? {}), ...localEnv(svc.repo ? checkouts[svc.repo].dir : undefined) };
    for (const k of svc.ask ?? []) env[k] ??= store.get(k)!;
    return env;
  };
  const missing: string[] = [];
  for (const name of required) {
    envs[name] = envFor(name);
    for (const k of cfg.services[name].ask ?? []) if (!envs[name][k] && !missing.includes(k)) missing.push(k);
  }
  if (missing.length) {
    if (!process.stdin.isTTY) die(`these are required and not set: ${missing.join(', ')}. Export them or run in a terminal to be asked once.`);
    say(`${missing.length} required var${missing.length > 1 ? 's' : ''} not set yet, asking once`);
    for (const k of missing) store.set(k, await promptSecret(k));
    for (const name of required) envs[name] = envFor(name);
  }
  const secretsFor = (name: string): Secrets => {
    const shown = cfg.services[name].agent_env ?? [];
    const names = Object.keys(envs[name]).filter((k) => !shown.includes(k) && (isSecretName(k) || (cfg.services[name].ask ?? []).includes(k)));
    return { names, values: [...names.map((k) => envs[name][k]), ...store.values()].filter(Boolean) };
  };

  const running = new Map<string, Running>();
  let watcher: LogWatcher | undefined;
  cleanup = () => {
    watcher?.stop();
    for (const r of running.values()) stop(r);
  };
  const shutdown = () => {
    cleanup();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const status: Record<string, string> = {};
  const url = () => opts.open ?? openUrl(cfg, required, changed);

  /** Boots one service; also how a service is restarted after a fix. */
  const bringUp = async (name: string, restart = false) => {
    const svc = cfg.services[name];
    const co = svc.repo ? checkouts[svc.repo] : undefined;
    const cwd = co?.dir ?? path.dirname(cfg.file);
    if (restart) {
      const old = running.get(name);
      if (old) {
        stop(old);
        await old.exited;
        running.delete(name);
      }
      envs[name] = envFor(name);
    }
    const env = envs[name];
    const ctx = () => ({ cwd, env, secrets: secretsFor(name), extraEnv: pick(env, svc.agent_env) });
    if (!restart && svc.ready && (await waitReady(svc.ready, 2000)) === 'ready') {
      if (svc.repo) {
        const u = url();
        say(`${name} already answers at ${svc.ready}: this PR is already running${u ? `, screen: ${u}` : ''}`);
        if (u && !opts.noOpen) openBrowser(u);
        shutdown();
      }
      status[name] = `already running at ${svc.ready}`;
      say(`${name}: already running at ${svc.ready}`);
      return;
    }
    if (svc.setup) {
      say(`${name}: ${svc.setup}`);
      await withFix({ service: name, step: 'setup', command: svc.setup }, () => runOnce(svc.setup!, cwd, env, logPath(stackId, `${name}.setup`)), opts, ctx, store);
    }
    if (svc.start) {
      await withFix(
        { service: name, step: 'start', command: svc.start },
        async () => {
          say(`${name}: ${svc.start}`);
          const r = start(svc.start!, cwd, env, logPath(stackId, name));
          running.set(name, r);
          const outcome = svc.ready ? await waitReady(svc.ready, cfg.ready_timeout * 1000, r.exited) : 'ready';
          if (outcome !== 'ready') {
            stop(r);
            running.delete(name);
            throw Object.assign(new Error(outcome === 'exited' ? `exited before ${svc.ready} answered` : `${svc.ready} did not answer within ${cfg.ready_timeout}s`), { logTail: tail(r.log) });
          }
          status[name] = `started, log ${r.log}`;
          say(`${name}: ready at ${svc.ready ?? '(no ready check)'}`);
        },
        opts, ctx, store
      );
    } else if (svc.ready && status[name] === undefined) {
      die(`${name} is not reachable at ${svc.ready} and has no start command`);
    }
  };
  for (const name of required) await bringUp(name);

  const screen = url();
  say(`stack up in ${elapsed()}${screen ? `, screen: ${screen}` : ''}`);
  if (screen && !opts.noOpen) openBrowser(screen);

  // The automatic pass and the watcher share one agent context: the first
  // repo service that declares how to seed, else the first repo service.
  const agentHome = required.find((n) => cfg.services[n].seed && cfg.services[n].repo) ?? required.find((n) => cfg.services[n].repo);
  const services = () => required.flatMap((n) => (cfg.services[n].ready ? [{ service: n, url: cfg.services[n].url ?? cfg.services[n].ready!, log: logPath(stackId, n), worktree: cfg.services[n].repo ? checkouts[cfg.services[n].repo!].dir : undefined }] : []));
  const agentCtx = (): AgentContext | undefined => {
    if (!agentHome) return undefined;
    const svc = cfg.services[agentHome];
    return { cwd: checkouts[svc.repo!].dir, envNames: { set: Object.keys(envs[agentHome]), unset: [] }, secrets: secretsFor(agentHome), model: opts.model, extraEnv: pick(envs[agentHome], svc.agent_env), maxTurns: 40 };
  };
  const found: Report['issues'] = [];
  let data = 'none' as Report['data'];
  const applyReport = async (r: Report) => {
    found.push(...r.issues);
    if (r.data === 'filled') data = 'filled';
    for (const i of r.issues) say(`  ${i.fixed ? 'fixed' : 'found'}${i.kind ? ` (${i.kind})` : ''}: ${i.found}`);
    for (const n of r.restart) {
      if (!required.includes(n)) continue;
      say(`${n}: restarting for the change to apply`);
      await bringUp(n, true);
    }
  };


  if (!opts.noAgent && agentHome) {
    const ctx = agentCtx()!;
    const diff = Object.entries(checkouts).filter(([n]) => changed[n]?.length).map(([n, co]) => `# repo ${n}\n${diffText(co.dir, cfg.default_branch)}`).join('\n\n');
    const hints = required.filter((n) => cfg.services[n].seed).map((n) => ({ service: n, hint: cfg.services[n].seed! }));
    const logTails = Object.fromEntries(services().map((s) => [s.service, tail(s.log, 60)]));
    const priorCommits = Object.entries(checkouts).flatMap(([n, co]) => autosolveChanges(co).map((c) => `  ${n}: ${c.kind}: ${c.message} (${c.files.join(', ') || 'no files'})`)).join('\n');
    say(`checking: what data the change needs, and whether the screen works`);
    try {
      const r = await runAgent(checkPrompt({ diff, hints, running: services(), logTails, screen, priorCommits }, ctx), ctx, (l) => say(`  agent: ${l}`));
      say(`check ${r.ok ? 'done' : 'stopped early'}: ${r.turns} turns, $${r.costUsd.toFixed(2)}${r.ok ? '' : `, ${r.text.split('\n').at(-1)}`}`);
      await applyReport(parseReport(r.text));
    } catch (e: any) {
      say(`check failed: ${e.message}`);
    }

  }

  // Errors logged while the reviewer clicks around: always reported, and
  // looked into by an agent when one is allowed. One look per distinct error.
  const seen = new Set<string>();
  let runs = 0;
  let busy = false;
  watcher = new LogWatcher(Object.fromEntries(services().map((s) => [s.service, s.log])), async (b) => {
    const fresh = b.lines.filter((l) => !seen.has(errorSignature(l)));
    fresh.forEach((l) => seen.add(errorSignature(l)));
    if (!fresh.length) return;
    say(`${b.service} logged ${fresh.length} new error${fresh.length > 1 ? 's' : ''} while you were using it`);
    for (const l of fresh.slice(0, 5)) say(`  ${l.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 160)}`);
    if (opts.noAgent || !agentHome || busy || runs >= 5) return;
    busy = true;
    runs++;
    say(`looking into it (${runs}/5)`);
    try {
      const c = agentCtx()!;
      const res = await runAgent(watchPrompt(b.service, fresh.slice(0, 40), services(), c), c, (l) => say(`  agent: ${l}`));
      await applyReport(parseReport(res.text));
      say(`done: ${res.turns} turns, $${res.costUsd.toFixed(2)}`);
    } catch (e: any) {
      say(`look failed: ${e.message}`);
    } finally {
      busy = false;
    }
  });
  if (running.size) watcher.start();

  const changes: Record<string, Change[]> = {};
  for (const [name, co] of Object.entries(checkouts)) {
    const cs = autosolveChanges(co);
    if (cs.length) changes[name] = cs;
  }
  process.stderr.write('\n');
  process.stderr.write(`ready in ${elapsed()}\n`);
  for (const name of required) process.stderr.write(`  ${name.padEnd(10)} ${status[name] ?? 'external'}\n`);
  if (screen) process.stderr.write(`  screen     ${screen}\n`);
  if (!opts.noAgent) {
    process.stderr.write(`  data       ${data === 'filled' ? 'seeded for this change (reload the screen)' : 'nothing needed'}\n`);
    const fixed = found.filter((i) => i.fixed).length;
    process.stderr.write(`  issues     ${found.length ? `${found.length} found, ${fixed} fixed` : 'none found'}\n`);
    for (const i of found.filter((x) => !x.fixed)) process.stderr.write(`             not fixed: ${i.found}\n`);
  }
  process.stderr.write(formatAutosolveSummary(changes) + '\n');
  if (running.size) process.stderr.write(`services keep running and errors you hit are ${opts.noAgent ? 'reported' : 'looked into'}; ctrl-c stops them\n`);
  else process.exit(0);
}

function openUrl(cfg: Config, required: string[], changed: Record<string, string[]>): string | undefined {
  const openable = required.map((n) => [n, cfg.services[n]] as const).filter(([, s]) => s.url);
  const withRoute = openable.find(([, s]) => s.repo && changed[s.repo]?.length && s.routes);
  if (withRoute) return routeFor(withRoute[1], changed[withRoute[1].repo!]);
  const changedFirst = openable.find(([, s]) => s.repo && changed[s.repo]?.length) ?? openable.at(-1);
  return changedFirst?.[1].url;
}

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

/** Runs a step; on failure asks for an unset var, or lets an agent fix it, then retries. Bounded. */
async function withFix<T>(where: Omit<Failure, 'message' | 'logTail'>, fn: () => Promise<T> | T, opts: Opts, ctx: Ctx, store: SecretStore): Promise<T> {
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
      if (opts.noAgent) {
        process.stderr.write(`\n${failure.service} failed at ${failure.step}: ${failure.message}\n${failure.logTail}\n`);
        die(`--no-agent is set; fix it by hand in ${ctx().cwd}`);
      }
      if (attempt > opts.attempts) {
        process.stderr.write(`\n${failure.service} still fails at ${failure.step} after ${opts.attempts} attempts: ${failure.message}\nwhat was tried:\n${tried.map((t) => `  - ${t}`).join('\n')}\n${failure.logTail}\n`);
        die('giving up');
      }
      say(`${failure.service} failed at ${failure.step}: ${failure.message}. fixing, attempt ${attempt}/${opts.attempts}`);
      const c = ctx();
      const envNames = { set: Object.keys(c.env), unset: [] as string[] };
      const actx: AgentContext = { cwd: e.dir ?? c.cwd, envNames, secrets: c.secrets, model: opts.model, extraEnv: c.extraEnv };
      const before = git(actx.cwd, 'rev-parse', 'HEAD');
      const r = await runAgent(autosolvePrompt(failure, actx), actx, (l) => say(`  agent: ${l}`));
      tried.push(r.text.split('\n')[0].slice(0, 200));
      say(`fix attempt: ${r.turns} turns, $${r.costUsd.toFixed(2)}`);
      if (git(actx.cwd, 'rev-parse', 'HEAD') === before) {
        process.stderr.write(`\n${failure.service} still fails at ${failure.step} and the fix attempt changed nothing: ${failure.message}\nwhat it said:\n  ${r.text.split('\n').slice(0, 12).join('\n  ')}\n`);
        die('giving up');
      }
    }
  }
}

try {
  await main();
} catch (e: any) {
  die(e.message);
}
