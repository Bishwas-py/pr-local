import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardToolUse, autosolvePrompt, agentEnv } from '../src/agent.ts';

test('the agent may not read env files or the secret store', () => {
  assert.equal(guardToolUse('Read', { file_path: '/x/app/.env' }).allow, false);
  assert.equal(guardToolUse('Read', { file_path: '/x/app/.env.local' }).allow, false);
  assert.equal(guardToolUse('Bash', { command: 'cat ../sibling/.env' }).allow, false);
  assert.equal(guardToolUse('Bash', { command: 'cat ~/.config/deploy-dev/secrets.json' }).allow, false);
  assert.equal(guardToolUse('Bash', { command: 'env | grep KEY' }).allow, false);
  assert.equal(guardToolUse('Glob', { pattern: '**/.env*' }).allow, false);
});

test('ordinary work is allowed', () => {
  assert.equal(guardToolUse('Read', { file_path: '/x/app/main.go' }).allow, true);
  assert.equal(guardToolUse('Bash', { command: 'go build ./... && git commit -m "fix: x"' }).allow, true);
  assert.equal(guardToolUse('Edit', { file_path: '/x/app/environment.ts' }).allow, true);
});

test('the prompt never carries a secret value, only the fact that a name is unset', () => {
  const p = autosolvePrompt(
    {
      service: 'api', step: 'start', command: 'go run .',
      message: 'exit 1', logTail: 'auth failed for key sk-live-999\nFOO_API_KEY=sk-live-999'
    },
    { cwd: '/wt/api', envNames: { set: ['PORT'], unset: ['FOO_API_KEY'] }, secrets: { values: ['sk-live-999'], names: ['FOO_API_KEY'] } }
  );
  assert.ok(!p.includes('sk-live-999'));
  assert.ok(p.includes('FOO_API_KEY is unset'));
  assert.ok(p.includes('fix:') && p.includes('local:'));
});

test('the agent process env has no secret in it', () => {
  const env = agentEnv({ PATH: '/bin', HOME: '/h', FOO_API_KEY: 'x', SESSION_SECRET_KEY: 'y', DATABASE_URL: 'postgres://u:pw@h/db' }, ['DATABASE_URL']);
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});
