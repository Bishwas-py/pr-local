import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

function write(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dd-cfg-'));
  mkdirSync(join(dir, 'backend'));
  const f = join(dir, 'deploy-dev.yaml');
  writeFileSync(f, yaml);
  return f;
}

test('repo paths resolve relative to the config file, defaults fill in', () => {
  const cfg = loadConfig(write('repos:\n  api: ./backend\nservices:\n  api:\n    repo: api\n    start: go run .\n'));
  assert.equal(cfg.default_branch, 'main');
  assert.ok(cfg.repos.api.endsWith('/backend'));
  assert.equal(cfg.services.api.start, 'go run .');
});

test('a service that needs an undefined service is rejected up front', () => {
  assert.throws(
    () => loadConfig(write('repos:\n  api: ./backend\nservices:\n  api:\n    repo: api\n    needs: [db]\n')),
    /needs "db"/
  );
});

test('a service on an unknown repo is rejected up front', () => {
  assert.throws(() => loadConfig(write('repos: {}\nservices:\n  api:\n    repo: api\n')), /repo "api"/);
});

test('a prompted secret can never be listed for the agent to see', () => {
  assert.throws(
    () => loadConfig(write('repos:\n  api: ./backend\nservices:\n  api:\n    repo: api\n    ask: [TOKEN]\n    agent_env: [TOKEN]\n')),
    /both ask and agent_env/
  );
});
