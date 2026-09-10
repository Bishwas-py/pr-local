import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function gitOk(cwd: string, ...args: string[]): boolean {
  return spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;
}

export const worktreeRoot = () =>
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'pr-local', 'worktrees');

/** A worktree dir unique to this repo: name for humans, a hash of the repo's
 *  absolute path so two stacks with a same-named repo never collide. */
export function worktreePath(name: string, repoDir: string): string {
  const h = createHash('sha1').update(path.resolve(repoDir)).digest('hex').slice(0, 8);
  return path.join(worktreeRoot(), `${name}-${h}`);
}

export function prBranch(repoDir: string, pr: number): string | undefined {
  const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'headRefName', '-q', '.headRefName'], {
    cwd: repoDir, encoding: 'utf8'
  });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

export function remoteBranches(repoDir: string, pattern: string): string[] {
  const out = git(repoDir, 'ls-remote', '--heads', 'origin', pattern);
  return out.split('\n').filter(Boolean).map((l) => l.split('refs/heads/')[1]);
}

export type Checkout = { dir: string; branch: string; prHead: string; merged: string[] };

/** A scratch worktree on branch pr-local/<first>, with the rest merged in.
 *  Second run on the same repo is a fetch and a reset, not a clone. */
export function prepareWorktree(name: string, repoDir: string, branches: string[], links: string[] = []): Checkout {
  const dir = worktreePath(name, repoDir);
  git(repoDir, 'fetch', '--quiet', 'origin', ...branches);
  // Drop any stale worktree registration (e.g. the cache dir was rm'd by hand),
  // then add. --force covers a path git still half-remembers.
  git(repoDir, 'worktree', 'prune');
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    git(repoDir, 'worktree', 'add', '--quiet', '--force', '--detach', dir, `origin/${branches[0]}`);
  }
  const scratch = `pr-local/${branches[0]}`;
  const head = `origin/${branches[0]}`;
  if (gitOk(dir, 'rev-parse', '--verify', '--quiet', scratch) && gitOk(dir, 'merge-base', '--is-ancestor', head, scratch)) {
    git(dir, 'checkout', '--quiet', scratch);
  } else {
    git(dir, 'checkout', '--quiet', '-B', scratch, head);
  }
  const prHead = git(dir, 'rev-parse', head);
  git(dir, 'checkout', '--quiet', '--', '.');
  git(dir, 'clean', '-fdq', ...links.flatMap((l) => ['-e', l]));
  for (const l of links) {
    const src = path.join(repoDir, l);
    const dst = path.join(dir, l);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
  }
  const merged: string[] = [];
  for (const b of branches.slice(1)) {
    const r = spawnSync('git', ['merge', '--no-edit', `origin/${b}`], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) {
      throw Object.assign(new Error(`merging ${b} into ${branches[0]} conflicted`), {
        step: 'merge', dir, logTail: (r.stdout + r.stderr).slice(-3000)
      });
    }
    merged.push(b);
  }
  return { dir, branch: branches[0], prHead, merged };
}

export function changedFiles(dir: string, defaultBranch: string): string[] {
  git(dir, 'fetch', '--quiet', 'origin', defaultBranch);
  const out = git(dir, 'diff', '--name-only', `origin/${defaultBranch}...HEAD`);
  return out ? out.split('\n') : [];
}

export function diffText(dir: string, defaultBranch: string, maxBytes = 60_000): string {
  const out = git(dir, 'diff', `origin/${defaultBranch}...HEAD`);
  return out.length > maxBytes ? out.slice(0, maxBytes) + '\n[diff truncated]' : out;
}

export type Change = { kind: 'fix' | 'local' | 'other'; message: string; files: string[] };

export function parseAutosolveLog(raw: string): Change[] {
  return raw
    .split('\x1e')
    .filter((s) => s.trim())
    .map((entry) => {
      const [subject, ...rest] = entry.split('\n');
      const files = rest.map((l) => l.trim()).filter(Boolean);
      const m = /^(fix|local):\s*(.*)$/.exec(subject.trim());
      return m ? { kind: m[1] as 'fix' | 'local', message: m[2], files } : { kind: 'other', message: subject.trim(), files };
    });
}

export function autosolveChanges(co: Checkout): Change[] {
  return parseAutosolveLog(git(co.dir, 'log', '--format=%x1e%s', '--name-only', `${co.prHead}..HEAD`));
}

export function formatAutosolveSummary(byRepo: Record<string, Change[]>): string {
  const rows = Object.entries(byRepo).flatMap(([repo, cs]) => cs.map((c) => ({ repo, ...c })));
  if (rows.length === 0) return 'autosolve made no changes';
  const fixes = rows.filter((r) => r.kind === 'fix').length;
  const locals = rows.filter((r) => r.kind === 'local').length;
  const lines = rows.map(
    (r) => `  ${r.kind.padEnd(6)} ${r.message.padEnd(52)} ${r.repo}: ${r.files.join(', ')}`
  );
  return [
    `autosolve made ${rows.length} change${rows.length === 1 ? '' : 's'}`,
    ...lines,
    `${fixes} belong${fixes === 1 ? 's' : ''} in the PR. ${locals} never leave${locals === 1 ? 's' : ''} this machine.`,
    `full record: git log <pr-head>..HEAD in each worktree under ${worktreeRoot()}`
  ].join('\n');
}

export type Pr = { number: number; title: string };

export function openPrs(repoDir: string): Pr[] {
  const r = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title'], { cwd: repoDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh pr list failed in ${repoDir}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

export function formatPrList(byRepo: Record<string, Pr[]>): string {
  const width = Math.max(1, ...Object.values(byRepo).flat().map((p) => String(p.number).length));
  return Object.entries(byRepo)
    .flatMap(([repo, prs]) => [repo, ...(prs.length ? prs.map((p) => `${String(p.number).padStart(width)}  ${p.title}`) : ['  (no open PRs)'])])
    .join('\n');
}
