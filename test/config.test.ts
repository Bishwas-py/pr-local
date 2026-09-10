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

import { findConfig } from '../src/config.ts';

/** A fake $HOME: home/Projects/{api,web,other}, config in api naming api and web. */
function stack(extra: Record<string, string> = {}): { home: string; api: string; web: string; other: string } {
  const home = mkdtempSync(join(tmpdir(), 'dd-home-'));
  for (const d of ['api', 'web', 'other', 'node_modules/pkg', '.hidden']) mkdirSync(join(home, 'Projects', d), { recursive: true });
  writeFileSync(join(home, 'Projects/api/deploy-dev.yaml'), 'repos:\n  api: .\n  web: ../web\nservices: {}\n');
  for (const [rel, body] of Object.entries(extra)) {
    mkdirSync(join(home, rel, '..'), { recursive: true });
    writeFileSync(join(home, rel), body);
  }
  return { home, api: join(home, 'Projects/api'), web: join(home, 'Projects/web'), other: join(home, 'Projects/other') };
}

test('from the repo holding the config: found', () => {
  const s = stack();
  assert.equal(findConfig(s.api, s.home), join(s.api, 'deploy-dev.yaml'));
});

test('from a sibling repo the config names: found', () => {
  const s = stack();
  assert.equal(findConfig(s.web, s.home), join(s.api, 'deploy-dev.yaml'));
  mkdirSync(join(s.web, 'src/routes'), { recursive: true });
  assert.equal(findConfig(join(s.web, 'src/routes'), s.home), join(s.api, 'deploy-dev.yaml'), 'from a subdirectory too');
});

test('from a sibling repo the config does not name: still nothing', () => {
  const s = stack();
  assert.equal(findConfig(s.other, s.home), undefined);
});

test('a config in your own repo beats a sibling that also claims you', () => {
  const s = stack({ 'Projects/web/deploy-dev.yaml': 'repos:\n  web: .\nservices: {}\n' });
  assert.equal(findConfig(s.web, s.home), join(s.web, 'deploy-dev.yaml'));
});

test('two configs claiming the same directory: error naming both', () => {
  const s = stack({ 'Projects/other/deploy-dev.yml': 'repos:\n  web: ../web\nservices: {}\n' });
  assert.throws(() => findConfig(s.web, s.home), (e: Error) => e.message.includes('Projects/api/deploy-dev.yaml') && e.message.includes('Projects/other/deploy-dev.yml'));
});

test('the walk stops at $HOME and never scans above it', () => {
  const s = stack();
  // A config above $HOME that claims web must not be found.
  const above = join(s.home, '..', `dd-above-${Date.now()}`);
  mkdirSync(above, { recursive: true });
  writeFileSync(join(above, 'deploy-dev.yaml'), `repos:\n  web: ${s.web}\nservices: {}\n`);
  writeFileSync(join(s.api, 'deploy-dev.yaml'), 'repos:\n  api: .\nservices: {}\n');
  assert.equal(findConfig(s.web, s.home), undefined);
});

import { sampleConfig } from '../src/config.ts';

test('the scaffolded sample is valid, loadable config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-sample-'));
  const f = join(dir, 'deploy-dev.yaml');
  writeFileSync(f, sampleConfig());
  const cfg = loadConfig(f);
  assert.ok(Object.keys(cfg.services).length >= 2, 'has services');
  assert.equal(cfg.default_branch, 'main');
  assert.ok(Object.values(cfg.services).some((s) => s.url), 'has an openable service');
});
