import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { isSecretName, redact, defaultStorePath, type Secrets } from './secrets.ts';

export type Failure = {
  service: string;
  step: 'setup' | 'start' | 'merge' | 'ready';
  command?: string;
  message: string;
  logTail: string;
};

export type AgentContext = {
  cwd: string;
  envNames: { set: string[]; unset: string[] };
  secrets: Secrets;
  model?: string;
  maxTurns?: number;
  agentEnvAllow?: string[];
  extraEnv?: Record<string, string>;
};

const FORBIDDEN = [/(^|[\/\s'"`])\.env(\.[\w-]+)?($|[\s'"`*])/, /deploy-dev\/secrets\.json/, /(^|[\s;&|(])env(\s|$)/, /printenv/];

/** The agent never sees a secret: no env files, no store, no dumping the environment. */
export function guardToolUse(toolName: string, input: Record<string, unknown>): { allow: boolean; reason?: string } {
  const text = Object.values(input).filter((v) => typeof v === 'string').join(' ');
  for (const re of FORBIDDEN) {
    if (re.test(text)) return { allow: false, reason: `${toolName} on env files or secrets is not allowed; a var being unset is all you may know` };
  }
  return { allow: true };
}

/** The environment the agent's own shell runs in: nothing secret-looking. */
export function agentEnv(env: Record<string, string | undefined>, allow: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (allow.includes(k)) continue;
    if (isSecretName(k) || /:\/\/[^\/\s]+:[^\/\s]+@/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

const COMMIT_RULES = `Commit every change you make, one commit per fix, in the repository at the working directory.
Prefix the subject with exactly one of:
  fix:    the PR itself is broken and this belongs in the author's next commit
  local:  this machine's problem (a missing local var, a stale artefact, a local db state); it must never leave this machine
Put the error you were solving in the subject, e.g. "fix: migration 20260909 conflicted with the base branch".
Never commit env files. Never write a secret value anywhere. Never read .env files or ~/.config/deploy-dev.
If a variable is unset, the correct fix is usually "local:" and you may only note the NAME.
A fix that changes no file (a database repaired, a container restarted) is still recorded: git commit --allow-empty with the same subject rules.
A machine-local env var VALUE the service needs (not a secret) goes into .deploy-dev.env in the working directory as NAME=value, committed as "local: ..."; deploy-dev reads it last when starting the service.
When you cannot fix it, say exactly what you tried and stop.`;

export function autosolvePrompt(f: Failure, ctx: AgentContext): string {
  const body = [
    `deploy-dev is bringing up a PR locally and the "${f.service}" service failed at the ${f.step} step.`,
    f.command ? `Command: ${f.command}` : '',
    `Failure: ${f.message}`,
    `Working directory (a scratch git worktree on branch deploy-dev/*): ${ctx.cwd}`,
    ``,
    `Environment variable names that are set: ${ctx.envNames.set.join(', ') || '(none)'}`,
    ...ctx.envNames.unset.map((n) => `${n} is unset`),
    ``,
    `Last lines of output:`,
    '```',
    f.logTail,
    '```',
    ``,
    `Fix only what blocks this step so deploy-dev can retry it. Do not improve, tidy or fix anything else you notice, and do not start long-running services yourself.`,
    COMMIT_RULES
  ].join('\n');
  return redact(body, ctx.secrets);
}

export function seedPrompt(diff: string, hints: { service: string; hint: string }[], running: { service: string; url: string }[], ctx: AgentContext): string {
  const body = [
    `deploy-dev has a PR running locally. Decide what data this PR needs in front of a human reviewer, then create exactly that, quickly.`,
    `Read the diff below and answer first: what state must exist for the change to be visible? A page that surfaces failures needs failed records, not healthy ones. A change with no visible surface needs nothing: then do nothing and say "needs no data".`,
    ``,
    `Working directory: ${ctx.cwd}`,
    `How to seed (from the project's config):`,
    ...hints.map((h) => `  ${h.service}: ${h.hint}`),
    `Already running, use these to verify and never build or start a server yourself:`,
    ...running.map((r) => `  ${r.service}: ${r.url}`),
    `Environment variable names available to your shell: ${ctx.envNames.set.join(', ') || '(none)'}`,
    ``,
    `Read only what decides the shape of the data (the queries the changed screen calls and the tables behind them), then write the seed. Do not review or improve the PR.`,
    `Write the seed script into the working directory, run it, and commit it with the subject "local: seed <what state and why>". Keep it idempotent and additive: never wipe rows you did not create.`,
    `Never read .env files or ~/.config/deploy-dev. Never write a secret value anywhere.`,
    ``,
    `Diff:`,
    '```diff',
    diff,
    '```'
  ].join('\n');
  return redact(body, ctx.secrets);
}

export type AgentResult = { ok: boolean; text: string; turns: number; costUsd: number };

export async function runAgent(prompt: string, ctx: AgentContext, log: (line: string) => void): Promise<AgentResult> {
  const guard = (name: string, input: Record<string, unknown>) => guardToolUse(name, input);
  const options: Options = {
    cwd: ctx.cwd,
    model: ctx.model ?? 'claude-opus-5',
    maxTurns: ctx.maxTurns ?? 40,
    disallowedTools: ['Task', 'Agent', 'WebFetch', 'WebSearch', 'NotebookEdit'],
    permissionMode: 'acceptEdits',
    settingSources: [],
    env: { ...agentEnv(process.env, ctx.agentEnvAllow), ...(ctx.extraEnv ?? {}) },
    canUseTool: async (name, input) => {
      const g = guard(name, input);
      return g.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: g.reason! };
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              const i = input as { tool_name: string; tool_input: Record<string, unknown> };
              const g = guard(i.tool_name, i.tool_input ?? {});
              return g.allow
                ? {}
                : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: g.reason } };
            }
          ]
        }
      ]
    }
  };
  let result: AgentResult = { ok: false, text: 'agent produced no result', turns: 0, costUsd: 0 };
  try {
    await consume();
  } catch (e: any) {
    result = { ...result, ok: false, text: `${result.text}\n${redact(String(e?.message ?? e), ctx.secrets)}` };
  }
  return result;

  async function consume() {
  for await (const m of query({ prompt, options })) {
    if (m.type === 'assistant') {
      for (const block of (m as any).message?.content ?? []) {
        if (block.type === 'text' && block.text) log(redact(block.text, ctx.secrets).trim().split('\n')[0]);
        if (block.type === 'tool_use') log(`${block.name} ${redact(summarise(block.input), ctx.secrets)}`);
      }
    } else if (m.type === 'result') {
      const r = m as any;
      result = {
        ok: r.subtype === 'success' && !r.is_error,
        text: redact(String(r.result ?? r.subtype), ctx.secrets),
        turns: r.num_turns ?? 0,
        costUsd: r.total_cost_usd ?? 0
      };
    }
  }
  }
}

function summarise(input: Record<string, unknown>): string {
  const s = String(input.command ?? input.file_path ?? input.pattern ?? '');
  return s.length > 100 ? s.slice(0, 100) + '…' : s;
}

export const secretStoreHint = () => defaultStorePath();

export type Report = { data: 'filled' | 'none'; issues: { found: string; fixed: boolean; kind?: 'fix' | 'local' }[]; restart: string[] };

/** The last ```json block of the agent's answer, or an empty report. */
export function parseReport(text: string): Report {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const empty: Report = { data: 'none', issues: [], restart: [] };
  if (!blocks.length) return empty;
  try {
    const r = JSON.parse(blocks[blocks.length - 1][1]);
    return {
      data: r.data === 'filled' ? 'filled' : 'none',
      issues: Array.isArray(r.issues) ? r.issues.map((i: any) => ({ found: String(i.found ?? ''), fixed: !!i.fixed, kind: i.kind === 'fix' ? 'fix' : i.kind === 'local' ? 'local' : undefined })) : [],
      restart: Array.isArray(r.restart) ? r.restart.map(String) : []
    };
  } catch {
    return empty;
  }
}

const REPORT_RULES = `End your answer with exactly one json block:
\`\`\`json
{"data":"filled"|"none","issues":[{"found":"<what was wrong, one line>","fixed":true|false,"kind":"fix"|"local"}],"restart":["<service>"]}
\`\`\`
"restart" lists services whose process must be restarted for your change to apply (a code change, or a new line in .deploy-dev.env). deploy-dev restarts them; never start or stop a service yourself.
A machine-local setting a service needs (an env var value for this machine only) goes into the file .deploy-dev.env in the working directory as NAME=value, committed as "local: ...". deploy-dev reads that file last when starting the service. Never put a secret value in it; a secret is asked from the user by deploy-dev, so say "<NAME> is unset" in the report instead.`;

export type CheckInput = {
  diff: string;
  hints: { service: string; hint: string }[];
  running: { service: string; url: string; log: string; worktree?: string }[];
  logTails: Record<string, string>;
  screen?: string;
  priorCommits: string;
};

/** One pass after boot: is data needed, and does the screen actually work. */
export function checkPrompt(input: CheckInput, ctx: AgentContext): string {
  const body = [
    `deploy-dev has a PR running locally so a human can review it. Two questions, answer both by acting, quickly:`,
    `1. DATA: what state must exist for this change to be visible? A page that surfaces failures needs failed rows, not healthy ones. If the change has no visible surface, nothing: report data "none". Otherwise write an idempotent, additive seed script into the working directory, run it, commit it as "local: seed <what and why>".`,
    `2. RUNTIME: does the screen work against this local stack? Fetch the screen and the API calls it makes, read the service logs below for 4xx/5xx/errors, and exercise the endpoints the diff touches. A boot that answers its health check can still fail every real request (a 401 on an endpoint that needs a token subject, a missing local setting, a stale generated client).`,
    `For every issue: fix it if it is this machine's problem (kind "local") or the PR's (kind "fix"), one commit each, prefixed "fix:" or "local:", the error in the subject. Do not improve anything else.`,
    ``,
    `Budget: about 30 tool calls in total. Seed first and commit it as soon as it runs; then the runtime check. Do not mint or forge tokens and do not read authentication code: if an endpoint needs a token you do not have, curl it once, record the status in the report, and move on. Stay inside the working directories listed below; read nothing else on this machine.`,
    `Already on the scratch branch from earlier runs (reuse, never redo):`,
    input.priorCommits || '  (nothing yet)',
    ``,
    `Working directory: ${ctx.cwd}`,
    `Screen under review: ${input.screen ?? '(none inferred)'}`,
    `Running services (use them, never start your own):`,
    ...input.running.map((r) => `  ${r.service}: ${r.url}  log: ${r.log}${r.worktree ? `  code: ${r.worktree}` : ''}`),
    `How to seed:`,
    ...input.hints.map((h) => `  ${h.service}: ${h.hint}`),
    `Environment variable names available to your shell: ${ctx.envNames.set.join(', ') || '(none)'}`,
    `Never read .env files or ~/.config/deploy-dev. Never write a secret value anywhere.`,
    ``,
    ...Object.entries(input.logTails).flatMap(([s, t]) => [`Recent log of ${s}:`, '```', t, '```']),
    ``,
    `Diff:`,
    '```diff',
    input.diff,
    '```',
    REPORT_RULES
  ].join('\n');
  return redact(body, ctx.secrets);
}

export function watchPrompt(service: string, lines: string[], running: CheckInput['running'], ctx: AgentContext): string {
  const body = [
    `deploy-dev is running a PR locally and a reviewer is clicking through it. The "${service}" service just logged errors while they did:`,
    '```',
    lines.join('\n'),
    '```',
    `Find the cause in the running stack and fix it if it is this machine's problem (kind "local") or the PR's (kind "fix"); one commit each, prefixed "fix:" or "local:", the error in the subject. If it is neither (an external service down, a deliberate refusal), say so and fix nothing.`,
    `Working directory: ${ctx.cwd}`,
    `Running services (use them, never start your own):`,
    ...running.map((r) => `  ${r.service}: ${r.url}  log: ${r.log}${r.worktree ? `  code: ${r.worktree}` : ''}`),
    `Environment variable names available to your shell: ${ctx.envNames.set.join(', ') || '(none)'}`,
    `Never read .env files or ~/.config/deploy-dev. Never write a secret value anywhere.`,
    REPORT_RULES
  ].join('\n');
  return redact(body, ctx.secrets);
}
